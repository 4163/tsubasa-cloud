import { db, sqlite } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { authPool } from './auth.js';

export async function disableDriveAccount(accountId: string): Promise<{ success: boolean; accountId: string }> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  await db
    .update(accounts)
    .set({
      isDisabled: true,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return { success: true, accountId };
}

export async function enableDriveAccount(accountId: string): Promise<{ success: boolean; accountId: string }> {
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });

  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  await db
    .update(accounts)
    .set({
      isDisabled: false,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  return { success: true, accountId };
}

export async function getAccountsList(poolId?: number) {
  authPool.ensureScanned();
  const records = authPool.getAll();
  const dbAccounts = await db.select().from(accounts);
  const dbMap = new Map(dbAccounts.map((a) => [a.id, a]));

  const accountsWithFiles = new Set(
    (
      sqlite
        .prepare('SELECT DISTINCT account_id FROM files')
        .all() as Array<{ account_id: string }>
    ).map((row) => row.account_id)
  );

  const list = records.map((r) => {
    const dbAcc = dbMap.get(r.config.accountId);
    const accountPoolId = dbAcc?.poolId ?? authPool.getPreferredPool(r.config.accountId) ?? 1;
    const canSwitchPool = !accountsWithFiles.has(r.config.accountId);

    return {
      accountId: r.config.accountId,
      clientId: r.config.clientId,
      authorized: r.authorized,
      sourceFile: r.config.sourceFile,
      isDisabled: dbAcc?.isDisabled ?? false,
      mtimeMs: r.config.mtimeMs ?? 0,
      poolId: accountPoolId,
      canSwitchPool,
    };
  });

  list.sort((a, b) => {
    if (!a.authorized && b.authorized) return -1;
    if (a.authorized && !b.authorized) return 1;

    if (!a.authorized && !b.authorized) {
      if (a.mtimeMs !== b.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return a.accountId.localeCompare(b.accountId);
    }

    const dbA = dbMap.get(a.accountId);
    const dbB = dbMap.get(b.accountId);
    const emailA = (dbA?.email || a.accountId).toLowerCase();
    const emailB = (dbB?.email || b.accountId).toLowerCase();
    return emailA.localeCompare(emailB, undefined, { numeric: true, sensitivity: 'base' });
  });

  if (poolId !== undefined) {
    return list.filter((item) => item.poolId === poolId);
  }

  return list;
}
