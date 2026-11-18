import { getDriveClient } from './client.js';
import { withDriveRetry } from './errors.js';

export interface CopyCrossAccountOptions {
  sourceAccountId: string;
  sourceDriveFileId: string;
  targetAccountId: string;
  targetAccountEmail?: string;
  targetRemoteFolderId: string;
  destFileName: string;
  appProperties: Record<string, string>;
  fields?: string;
}

export async function copyDriveFileCrossAccount(
  options: CopyCrossAccountOptions
): Promise<string> {
  const {
    sourceAccountId,
    sourceDriveFileId,
    targetAccountId,
    targetAccountEmail,
    targetRemoteFolderId,
    destFileName,
    appProperties,
    fields = 'id, name, size',
  } = options;

  const driveTarget = getDriveClient(targetAccountId);

  if (sourceAccountId === targetAccountId) {
    const copyRes = await withDriveRetry(() =>
      driveTarget.files.copy({
        fileId: sourceDriveFileId,
        requestBody: {
          name: destFileName,
          parents: [targetRemoteFolderId],
          appProperties,
        },
        fields,
        supportsAllDrives: false,
      })
    );

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive server-side copy returned empty file ID');
    }
    return newDriveFileId;
  }

  if (!targetAccountEmail) {
    throw new Error('targetAccountEmail is required for cross-account Drive copy');
  }

  const driveSource = getDriveClient(sourceAccountId);

  const shareRes = await withDriveRetry(() =>
    driveSource.permissions.create({
      fileId: sourceDriveFileId,
      sendNotificationEmail: false,
      requestBody: {
        role: 'reader',
        type: 'user',
        emailAddress: targetAccountEmail,
      },
      supportsAllDrives: false,
    })
  );

  const permissionId = shareRes.data.id;
  try {
    const copyRes = await withDriveRetry(() =>
      driveTarget.files.copy({
        fileId: sourceDriveFileId,
        requestBody: {
          name: destFileName,
          parents: [targetRemoteFolderId],
          appProperties,
        },
        fields,
        supportsAllDrives: false,
      })
    );

    const newDriveFileId = copyRes.data.id;
    if (!newDriveFileId) {
      throw new Error('Google Drive cross-account copy returned empty file ID');
    }
    return newDriveFileId;
  } finally {
    if (permissionId) {
      try {
        await withDriveRetry(() =>
          driveSource.permissions.delete({
            fileId: sourceDriveFileId,
            permissionId,
            supportsAllDrives: false,
          })
        );
      } catch (cleanupErr) {
        console.warn(`Failed to cleanup temp reader permission on ${sourceDriveFileId}:`, cleanupErr);
      }
    }
  }
}
