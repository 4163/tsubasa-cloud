import type { drive_v3 } from 'googleapis';
import { runBoundedConcurrency, withDriveRetry } from './errors.js';

export const CLEARED_TSUBASA_APP_PROPERTIES = {
  tsubasa_managed: null,
  tsubasa_virtual_path: null,
  tsubasa_virtual_id: null,
  tsubasa_checksum: null,
} as const;

export interface TsubasaAppPropertiesOptions {
  virtualPath: string;
  virtualId: string;
  checksum?: string | null;
  includeChecksum?: boolean;
}

export function buildTsubasaAppProperties(options: TsubasaAppPropertiesOptions): Record<string, string> {
  const props: Record<string, string> = {
    tsubasa_managed: 'true',
    tsubasa_virtual_path: options.virtualPath,
    tsubasa_virtual_id: options.virtualId,
  };
  if (options.includeChecksum || 'checksum' in options) {
    props.tsubasa_checksum = options.checksum || '';
  }
  return props;
}

export async function clearOrphanAppProperties(
  drive: drive_v3.Drive,
  orphanDriveIds: string[]
): Promise<void> {
  await runBoundedConcurrency(orphanDriveIds, 5, async (orphanId) => {
    try {
      await withDriveRetry(() =>
        drive.files.update({
          fileId: orphanId,
          requestBody: {
            appProperties: CLEARED_TSUBASA_APP_PROPERTIES as any,
          },
          supportsAllDrives: false,
        })
      );
    } catch (err) {
      console.warn(`Failed to clear orphan appProperties for ${orphanId}:`, err);
    }
  });
}
