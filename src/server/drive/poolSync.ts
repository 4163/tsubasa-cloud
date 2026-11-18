import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { authPool } from './auth.js';
import { isSharePoolId } from './poolRegistry.js';
import { hydrateAccount } from './accountHydration.js';
import { isAuthInvalidError, runBoundedConcurrency } from './errors.js';
import { runIncrementalSync } from './delta.js';
import { startOutboxWorker } from './outbox.js';

const SYNC_ACCOUNT_CONCURRENCY = 5;
const STARTUP_HYDRATION_CONCURRENCY = 4;

export interface AccountSyncStepResult {
  accountId: string;
  email: string;
  poolId: number;
  hydrated: boolean;
  synced: boolean;
}

const inFlightAccountSyncs = new Map<string, Promise<AccountSyncStepResult>>();

async function syncAccountSingleFlight(
  accountId: string,
  expectedPoolId: number,
  preferredPoolId?: number
): Promise<AccountSyncStepResult> {
  const existing = inFlightAccountSyncs.get(accountId);
  if (existing) {
    const res = await existing;
    if (isSharePoolId(res.poolId) || res.poolId !== expectedPoolId) {
      return {
        accountId: res.accountId,
        email: res.email,
        poolId: res.poolId,
        hydrated: false,
        synced: false,
      };
    }
    return res;
  }

  const promise = (async (): Promise<AccountSyncStepResult> => {
    const hydRes = await hydrateAccount(accountId, preferredPoolId);
    if (isSharePoolId(hydRes.poolId) || hydRes.poolId !== expectedPoolId) {
      return {
        accountId: hydRes.accountId,
        email: hydRes.email,
        poolId: hydRes.poolId,
        hydrated: false,
        synced: false,
      };
    }

    await runIncrementalSync(hydRes.accountId);
    return {
      accountId: hydRes.accountId,
      email: hydRes.email,
      poolId: hydRes.poolId,
      hydrated: true,
      synced: true,
    };
  })().finally(() => {
    if (inFlightAccountSyncs.get(accountId) === promise) {
      inFlightAccountSyncs.delete(accountId);
    }
  });

  inFlightAccountSyncs.set(accountId, promise);
  return promise;
}

async function resolveAccountTargetPool(
  accountId: string,
  configPreferredPoolId: number | undefined,
  targetPoolId: number
): Promise<{ eligible: boolean; preferredPoolId: number | undefined }> {
  const existingAccount = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (existingAccount) {
    if (isSharePoolId(existingAccount.poolId) || existingAccount.poolId !== targetPoolId) {
      return { eligible: false, preferredPoolId: undefined };
    }
    return { eligible: true, preferredPoolId: undefined };
  }

  const preferredPool = authPool.hasPreferredPool(accountId)
    ? authPool.getPreferredPool(accountId)
    : configPreferredPoolId;

  if (preferredPool !== undefined && (isSharePoolId(preferredPool) || preferredPool !== targetPoolId)) {
    return { eligible: false, preferredPoolId: undefined };
  }

  return { eligible: true, preferredPoolId: targetPoolId };
}

export async function hydratePool1Startup(
  concurrency = STARTUP_HYDRATION_CONCURRENCY
): Promise<void> {
  startOutboxWorker();
  authPool.scan();
  authPool.startWatching();
  const allRecords = authPool.getAll();
  console.log(`Discovered ${allRecords.length} account credential files in .oauths/`);
  const records = allRecords.filter((r) => r.authorized);

  await runBoundedConcurrency(records, concurrency, async (record) => {
    const accountId = record.config.accountId;
    const { eligible, preferredPoolId } = await resolveAccountTargetPool(
      accountId,
      record.config.preferredPoolId,
      1
    );

    if (!eligible) {
      return;
    }

    try {
      const res = await syncAccountSingleFlight(accountId, 1, preferredPoolId);
      if (res.hydrated) {
        console.log(`Hydrated account ${res.email} (${res.accountId}) in Pool ${res.poolId}`);
      }
    } catch (err) {
      if (isAuthInvalidError(err)) {
        try {
          await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
        } catch {}
      }
      console.warn(
        `Hydration deferred for ${accountId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  });
}

export async function syncAllAccounts(poolId = 1): Promise<{
  hydrated: string[];
  synced: string[];
  errors: Array<{ accountId: string; error: string }>;
}> {
  if (isSharePoolId(poolId)) {
    return { hydrated: [], synced: [], errors: [] };
  }

  authPool.ensureScanned();
  const records = authPool.getAll().filter((r) => r.authorized);
  const hydrated: string[] = [];
  const synced: string[] = [];
  const errors: Array<{ accountId: string; error: string }> = [];

  await runBoundedConcurrency(records, SYNC_ACCOUNT_CONCURRENCY, async (record) => {
    const accountId = record.config.accountId;
    const { eligible, preferredPoolId } = await resolveAccountTargetPool(
      accountId,
      record.config.preferredPoolId,
      poolId
    );

    if (!eligible) {
      return;
    }

    try {
      const res = await syncAccountSingleFlight(accountId, poolId, preferredPoolId);
      if (!res.hydrated || isSharePoolId(res.poolId) || res.poolId !== poolId) {
        return;
      }

      hydrated.push(res.accountId);
      if (res.synced) {
        synced.push(res.accountId);
      }
    } catch (err) {
      if (isAuthInvalidError(err)) {
        try {
          await db.update(accounts).set({ syncState: 'error' }).where(eq(accounts.id, accountId));
        } catch {}
      }
      errors.push({
        accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return { hydrated, synced, errors };
}
