import { useEffect, useState } from 'react';
import { client } from '../api.js';

export type TabLockStatus = 'checking' | 'active' | 'blocked';
export type TabOwnerKind = 'browser' | 'electron';

export interface TabLockState {
  status: TabLockStatus;
  ownerKind: TabOwnerKind;
}

export interface AuthCompletedPayload {
  account?: string;
  poolId?: number;
  conflicts?: number;
}

const LOCK_NAME = 'tsubasa-active-tab-lock';
const CHANNEL_NAME = 'tsubasa-instance-channel';
const STORAGE_LEASE_KEY = 'tsubasa-active-instance-lock';
const SESSION_INSTANCE_KEY = 'tsubasa-tab-instance-id';
const LEASE_TTL_MS = 15_000;
const LEASE_HEARTBEAT_MS = 5_000;
const PROBE_TIMEOUT_MS = 150;
const SINGLETON_KEY = Symbol.for('tsubasa.tabLockSingleton');

interface InstanceMessage {
  type: 'PING' | 'PONG' | 'AUTH_COMPLETED';
  instanceId?: string;
  ownerKind?: TabOwnerKind;
  account?: string;
  poolId?: number;
  conflicts?: number;
}

interface StoredLease {
  instanceId: string;
  ownerKind: TabOwnerKind;
  updatedAt: number;
}

interface TabLockSingleton {
  state: TabLockState;
  started: boolean;
  listeners: Set<(next: TabLockState) => void>;
  authListeners: Set<(payload: AuthCompletedPayload) => void>;
}

function createInstanceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readStoredLease(): StoredLease | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_LEASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredLease>;
    if (
      typeof parsed.instanceId === 'string' &&
      (parsed.ownerKind === 'browser' || parsed.ownerKind === 'electron') &&
      typeof parsed.updatedAt === 'number'
    ) {
      return {
        instanceId: parsed.instanceId,
        ownerKind: parsed.ownerKind,
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Ignore malformed or inaccessible storage entries.
  }
  return null;
}

function writeStoredLease(instanceId: string): void {
  try {
    const lease: StoredLease = {
      instanceId,
      ownerKind: 'browser',
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(STORAGE_LEASE_KEY, JSON.stringify(lease));
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

function releaseStoredLease(instanceId: string): void {
  try {
    const current = readStoredLease();
    if (current && current.instanceId === instanceId) {
      window.localStorage.removeItem(STORAGE_LEASE_KEY);
    }
  } catch {
    // Ignore storage errors during teardown.
  }
}

function notifyAuthCompletedIfNeeded(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') !== 'success') return;

  const account = params.get('account') || undefined;
  const rawPoolId = Number(params.get('poolId'));
  const poolId = Number.isFinite(rawPoolId) && rawPoolId > 0 ? rawPoolId : undefined;
  const rawConflicts = Number(params.get('conflicts') || '0');
  const conflicts = Number.isFinite(rawConflicts) && rawConflicts > 0 ? rawConflicts : 0;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      const payload: InstanceMessage = {
        type: 'AUTH_COMPLETED',
        account,
        poolId,
        conflicts,
      };
      channel.postMessage(payload);
      channel.close();
    } catch {
      // Ignore BroadcastChannel errors in restricted contexts.
    }
  }

  window.history.replaceState({}, '', window.location.pathname);
}

function getSingleton(): TabLockSingleton {
  const host = globalThis as Record<symbol, TabLockSingleton | undefined>;
  let singleton = host[SINGLETON_KEY];
  if (!singleton) {
    singleton = {
      state: { status: 'checking', ownerKind: 'browser' },
      started: false,
      listeners: new Set(),
      authListeners: new Set(),
    };
    host[SINGLETON_KEY] = singleton;
  }
  return singleton;
}

function publishState(singleton: TabLockSingleton, next: TabLockState): void {
  if (singleton.state.status === next.status && singleton.state.ownerKind === next.ownerKind) {
    return;
  }
  singleton.state = next;
  for (const listener of singleton.listeners) {
    listener(next);
  }
}

function readSessionInstanceId(): string | undefined {
  try {
    const value = window.sessionStorage.getItem(SESSION_INSTANCE_KEY);
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function writeSessionInstanceId(instanceId: string): void {
  try {
    window.sessionStorage.setItem(SESSION_INSTANCE_KEY, instanceId);
  } catch {
    // Ignore storage quota or privacy-mode errors.
  }
}

function clearSessionInstanceId(instanceId: string): void {
  try {
    if (window.sessionStorage.getItem(SESSION_INSTANCE_KEY) === instanceId) {
      window.sessionStorage.removeItem(SESSION_INSTANCE_KEY);
    }
  } catch {
    // Ignore storage errors during teardown.
  }
}

function sendServerRelease(instanceId: string): void {
  // Use sendBeacon or keepalive fetch because standard RPC requests can be cancelled during pagehide teardown.
  const releaseUrl = String(client.api.instance.release.$url());
  const payload = JSON.stringify({ instanceId });
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const sent = navigator.sendBeacon(
      releaseUrl,
      new Blob([payload], { type: 'application/json' })
    );
    if (sent) return;
  }
  void fetch(releaseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Ignore teardown network errors.
  });
}

function parseOwnerKind(raw: unknown): TabOwnerKind {
  return raw === 'electron' ? 'electron' : 'browser';
}

function startTabLockOnce(singleton: TabLockSingleton): void {
  if (singleton.started || typeof window === 'undefined') return;
  singleton.started = true;

  const instanceId = createInstanceId();
  let releaseLock: (() => void) | null = null;
  let activeChannel: BroadcastChannel | null = null;
  let heartbeatTimer: number | null = null;
  let serverHeartbeatTimer: number | null = null;
  let probeTimer: number | null = null;
  let serverClaimAttempted = false;
  let heartbeatInFlight = false;
  let isUnloading = false;

  const closeChannel = () => {
    if (activeChannel) {
      activeChannel.close();
      activeChannel = null;
    }
  };

  const releaseSameBrowserLock = () => {
    closeChannel();
    if (releaseLock) {
      const release = releaseLock;
      releaseLock = null;
      release();
    }
    releaseStoredLease(instanceId);
  };

  const clearTimers = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (serverHeartbeatTimer !== null) {
      window.clearInterval(serverHeartbeatTimer);
      serverHeartbeatTimer = null;
    }
    if (probeTimer !== null) {
      window.clearTimeout(probeTimer);
      probeTimer = null;
    }
  };

  const transitionToBlocked = (ownerKind: TabOwnerKind = 'browser') => {
    clearTimers();
    releaseSameBrowserLock();
    notifyAuthCompletedIfNeeded();
    publishState(singleton, { status: 'blocked', ownerKind });
  };

  const openActiveChannel = () => {
    if (typeof BroadcastChannel === 'undefined' || activeChannel) return;
    try {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event: MessageEvent<InstanceMessage>) => {
        const msg = event.data;
        if (!msg) return;
        if (msg.type === 'PING') {
          channel.postMessage({
            type: 'PONG',
            instanceId,
            ownerKind: 'browser',
          } satisfies InstanceMessage);
          return;
        }
        if (msg.type === 'AUTH_COMPLETED') {
          const payload: AuthCompletedPayload = {
            account: msg.account,
            poolId: msg.poolId,
            conflicts: msg.conflicts,
          };
          for (const listener of singleton.authListeners) {
            listener(payload);
          }
        }
      };
      activeChannel = channel;
    } catch {
      // BroadcastChannel unavailable; lock still holds.
    }
  };

  const sendServerHeartbeat = async () => {
    if (isUnloading || heartbeatInFlight || singleton.state.status !== 'active') return;
    heartbeatInFlight = true;
    try {
      const res = await client.api.instance.heartbeat.$post({
        json: {
          instanceId,
          ownerKind: 'browser',
        },
      });
      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as { ownerKind?: unknown } | null;
        clearSessionInstanceId(instanceId);
        transitionToBlocked(parseOwnerKind(data?.ownerKind));
      }
    } catch {
      // Keep the active UI mounted on transient server restarts; next heartbeat retries.
    } finally {
      heartbeatInFlight = false;
    }
  };

  const startServerHeartbeat = () => {
    if (serverHeartbeatTimer !== null) return;
    serverHeartbeatTimer = window.setInterval(() => {
      void sendServerHeartbeat();
    }, LEASE_HEARTBEAT_MS);
  };

  const activateWithServerLease = async () => {
    if (isUnloading) return;
    const replaceInstanceId = readSessionInstanceId();
    writeSessionInstanceId(instanceId);
    serverClaimAttempted = true;

    try {
      const res = await client.api.instance.claim.$post({
        json: {
          instanceId,
          ownerKind: 'browser',
          replaceInstanceId,
        },
      });

      if (isUnloading) {
        sendServerRelease(instanceId);
        releaseSameBrowserLock();
        return;
      }

      if (res.status === 409) {
        const data = (await res.json().catch(() => null)) as { ownerKind?: unknown } | null;
        clearSessionInstanceId(instanceId);
        serverClaimAttempted = false;
        transitionToBlocked(parseOwnerKind(data?.ownerKind));
        return;
      }

      if (!res.ok) {
        const status = (res as Response).status;
        console.warn(`Instance claim returned HTTP ${status}; falling back to local lock.`);
        serverClaimAttempted = false;
      }
    } catch {
      // Server temporarily unreachable; fall back to local lock and let heartbeat sync when back.
    }

    if (isUnloading) {
      sendServerRelease(instanceId);
      releaseSameBrowserLock();
      return;
    }

    openActiveChannel();
    startServerHeartbeat();
    publishState(singleton, { status: 'active', ownerKind: 'browser' });
  };

  const acquireLockAndLease = () => {
    const hasWebLocks =
      typeof navigator !== 'undefined' &&
      typeof navigator.locks?.request === 'function';

    if (hasWebLocks) {
      void navigator.locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            transitionToBlocked('browser');
            return;
          }
          if (isUnloading) {
            return;
          }
          const lockPromise = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          openActiveChannel();
          void activateWithServerLease();
          return lockPromise;
        })
        .catch(() => {
          transitionToBlocked('browser');
        });
      return;
    }

    const existingLease = readStoredLease();
    const hasFreshLease =
      existingLease !== null &&
      existingLease.instanceId !== instanceId &&
      Date.now() - existingLease.updatedAt < LEASE_TTL_MS;

    const activateFallback = () => {
      if (isUnloading) return;
      writeStoredLease(instanceId);
      heartbeatTimer = window.setInterval(() => {
        writeStoredLease(instanceId);
      }, LEASE_HEARTBEAT_MS);
      openActiveChannel();
      void activateWithServerLease();
    };

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const probeChannel = new BroadcastChannel(CHANNEL_NAME);
        activeChannel = probeChannel;

        probeChannel.onmessage = (event: MessageEvent<InstanceMessage>) => {
          const msg = event.data;
          if (!msg || msg.type !== 'PONG') return;
          transitionToBlocked(parseOwnerKind(msg.ownerKind));
        };

        probeChannel.postMessage({ type: 'PING', instanceId } satisfies InstanceMessage);

        probeTimer = window.setTimeout(() => {
          probeTimer = null;
          if (hasFreshLease) {
            transitionToBlocked(existingLease.ownerKind);
            return;
          }
          closeChannel();
          activateFallback();
        }, PROBE_TIMEOUT_MS);
      } catch {
        if (hasFreshLease) {
          transitionToBlocked(existingLease.ownerKind);
        } else {
          activateFallback();
        }
      }
    } else if (hasFreshLease) {
      transitionToBlocked(existingLease.ownerKind);
    } else {
      activateFallback();
    }
  };

  // Release the tab and server leases only when the page actually unloads, never on StrictMode cleanup.
  const handlePageHide = () => {
    isUnloading = true;
    clearTimers();
    releaseSameBrowserLock();
    if (serverClaimAttempted) {
      serverClaimAttempted = false;
      sendServerRelease(instanceId);
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !isUnloading && singleton.state.status === 'active') {
      void sendServerHeartbeat();
    }
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    isUnloading = false;
    heartbeatInFlight = false;
    if (singleton.state.status !== 'blocked' && (releaseLock !== null || serverHeartbeatTimer !== null)) {
      void sendServerHeartbeat();
      return;
    }
    acquireLockAndLease();
  };

  window.addEventListener('pagehide', handlePageHide);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handlePageShow);

  acquireLockAndLease();
}

export function subscribeAuthCompleted(
  listener: (payload: AuthCompletedPayload) => void
): () => void {
  const singleton = getSingleton();
  singleton.authListeners.add(listener);
  return () => {
    singleton.authListeners.delete(listener);
  };
}

/**
 * Enforces a single active Tsubasa~ Cloud instance across tabs and browsers sharing the server.
 * Lock acquisition runs once per page lifetime so React StrictMode and HMR do not self-block.
 */
export function useTabLock(): TabLockState {
  const singleton = getSingleton();
  const [state, setState] = useState<TabLockState>(singleton.state);

  useEffect(() => {
    singleton.listeners.add(setState);
    startTabLockOnce(singleton);
    setState(singleton.state);

    return () => {
      singleton.listeners.delete(setState);
    };
  }, [singleton]);

  return state;
}
