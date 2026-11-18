import type { DiscrepancyReport } from './detectorScan.js';

export const DISCREPANCY_CACHE_TTL_MS = 30_000;

export const discrepancyCache = new Map<string, { report: DiscrepancyReport; expiresAt: number }>();
export const inFlightScans = new Map<string, Promise<DiscrepancyReport>>();
export const scanGenerationByAccount = new Map<string, number>();
export const driveFileParentsCache = new Map<string, string[]>();

export function bumpScanGeneration(accountId?: string): void {
  if (accountId) {
    scanGenerationByAccount.set(accountId, (scanGenerationByAccount.get(accountId) ?? 0) + 1);
    return;
  }
  const allAccountIds = new Set([
    ...scanGenerationByAccount.keys(),
    ...discrepancyCache.keys(),
    ...inFlightScans.keys(),
  ]);
  for (const id of allAccountIds) {
    scanGenerationByAccount.set(id, (scanGenerationByAccount.get(id) ?? 0) + 1);
  }
}

export function invalidateDiscrepancyCache(accountId?: string): void {
  if (accountId) {
    discrepancyCache.delete(accountId);
    const prefix = `${accountId}:`;
    for (const key of driveFileParentsCache.keys()) {
      if (key.startsWith(prefix)) {
        driveFileParentsCache.delete(key);
      }
    }
  } else {
    discrepancyCache.clear();
    driveFileParentsCache.clear();
  }
  bumpScanGeneration(accountId);
}

export function getCachedDiscrepancyReport(accountId: string): DiscrepancyReport | null {
  const entry = discrepancyCache.get(accountId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    discrepancyCache.delete(accountId);
    return null;
  }
  return entry.report;
}

export function removeDriveIdFromCachedReport(accountId: string, driveFileId: string): void {
  const report = getCachedDiscrepancyReport(accountId);
  if (!report) return;
  report.unindexed = report.unindexed.filter((item) => item.driveFileId !== driveFileId);
  report.modified = report.modified.filter((item) => item.driveFileId !== driveFileId);
  report.conflicts = report.conflicts.filter((item) => item.driveFileId !== driveFileId);
  report.overCeiling = report.overCeiling.filter((item) => item.driveFileId !== driveFileId);
  report.missingRemote = report.missingRemote.filter((item) => item.driveFileId !== driveFileId);
}

export function findCachedDiscrepancyItem(
  accountId: string,
  driveFileId: string
): { virtualPath: string; sizeBytes: number; mimeType: string; hash: string | null } | null {
  const report = getCachedDiscrepancyReport(accountId);
  if (!report) return null;
  const match =
    report.unindexed.find((i) => i.driveFileId === driveFileId) ||
    report.modified.find((i) => i.driveFileId === driveFileId) ||
    report.overCeiling.find((i) => i.driveFileId === driveFileId) ||
    report.conflicts.find((i) => i.driveFileId === driveFileId);
  if (!match) return null;
  return {
    virtualPath: match.virtualPath,
    sizeBytes: match.sizeBytes,
    mimeType: match.mimeType,
    hash: match.hash,
  };
}
