import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { sqlite } from '../db/index.js';

const INSTANCE_LEASE_TTL_MS = 15_000;

type InstanceOwnerKind = 'browser' | 'electron';

interface ActiveInstanceLease {
  instanceId: string;
  ownerKind: InstanceOwnerKind;
  expiresAt: number;
}

let activeInstanceLease: ActiveInstanceLease | null = null;

function getLiveInstanceLease(now = Date.now()): ActiveInstanceLease | null {
  if (!activeInstanceLease) return null;
  if (activeInstanceLease.expiresAt <= now) {
    activeInstanceLease = null;
    return null;
  }
  return activeInstanceLease;
}

function parseInstanceOwnerKind(raw: unknown): InstanceOwnerKind {
  return raw === 'electron' ? 'electron' : 'browser';
}

function parseNonEmptyInstanceId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

const router = new Hono()
  .get('/api/health', (c) => {
    const pragmaRes = sqlite.pragma('journal_mode', { simple: true });
    return c.json({
      status: 'ok',
      service: 'tsubasa-backend',
      timestamp: Date.now(),
      sqlite: {
        journalMode: String(pragmaRes ?? 'wal'),
      },
    });
  })
  .post(
    '/api/instance/claim',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            instanceId: string;
            ownerKind: InstanceOwnerKind;
            replaceInstanceId?: string;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const instanceId = parseNonEmptyInstanceId(body?.instanceId);
        if (!instanceId) {
          return c.json({ error: 'instanceId (non-empty string) is required' }, 400);
        }
        return {
          instanceId,
          ownerKind: parseInstanceOwnerKind(body?.ownerKind),
          replaceInstanceId: parseNonEmptyInstanceId(body?.replaceInstanceId),
        };
      }
    ),
    (c) => {
      const payload = c.req.valid('json');
      const now = Date.now();
      const live = getLiveInstanceLease(now);

      const canReplace =
        live !== null &&
        (live.instanceId === payload.instanceId ||
          (payload.replaceInstanceId !== undefined && live.instanceId === payload.replaceInstanceId) ||
          (payload.ownerKind === 'electron' && live.ownerKind !== 'electron'));

      if (live && !canReplace) {
        return c.json(
          {
            acquired: false,
            ownerKind: live.ownerKind,
            leaseTtlMs: INSTANCE_LEASE_TTL_MS,
          },
          409
        );
      }

      activeInstanceLease = {
        instanceId: payload.instanceId,
        ownerKind: payload.ownerKind,
        expiresAt: now + INSTANCE_LEASE_TTL_MS,
      };

      return c.json(
        {
          acquired: true,
          ownerKind: activeInstanceLease.ownerKind,
          leaseTtlMs: INSTANCE_LEASE_TTL_MS,
        },
        200
      );
    }
  )
  .post(
    '/api/instance/heartbeat',
    validator(
      'json',
      (
        value,
        c
      ):
        | {
            instanceId: string;
            ownerKind: InstanceOwnerKind;
          }
        | Response => {
        const body = value as Record<string, unknown>;
        const instanceId = parseNonEmptyInstanceId(body?.instanceId);
        if (!instanceId) {
          return c.json({ error: 'instanceId (non-empty string) is required' }, 400);
        }
        return {
          instanceId,
          ownerKind: parseInstanceOwnerKind(body?.ownerKind),
        };
      }
    ),
    (c) => {
      const payload = c.req.valid('json');
      const now = Date.now();
      const live = getLiveInstanceLease(now);

      if (live && live.instanceId !== payload.instanceId) {
        return c.json(
          {
            active: false,
            ownerKind: live.ownerKind,
            leaseTtlMs: INSTANCE_LEASE_TTL_MS,
          },
          409
        );
      }

      activeInstanceLease = {
        instanceId: payload.instanceId,
        ownerKind: payload.ownerKind,
        expiresAt: now + INSTANCE_LEASE_TTL_MS,
      };

      return c.json(
        {
          active: true,
          ownerKind: activeInstanceLease.ownerKind,
          leaseTtlMs: INSTANCE_LEASE_TTL_MS,
        },
        200
      );
    }
  )
  .post('/api/instance/release', async (c) => {
    let instanceId: string | undefined;
    try {
      const raw = await c.req.text();
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        instanceId = parseNonEmptyInstanceId(parsed?.instanceId);
      }
    } catch {
      return c.json({ released: false }, 400);
    }

    if (!instanceId) {
      return c.json({ released: false }, 400);
    }

    if (activeInstanceLease && activeInstanceLease.instanceId === instanceId) {
      activeInstanceLease = null;
      return c.json({ released: true });
    }

    return c.json({ released: false });
  });

export default router;
