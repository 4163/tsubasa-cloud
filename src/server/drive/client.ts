import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { authPool } from './auth.js';
import { db } from '../db/index.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export interface AccountHydrationResult {
  accountId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  quotaLimitBytes: number;
  quotaUsedBytes: number;
  rootFolderId: string;
}

export function getDriveClient(clientOrId: string | OAuth2Client): drive_v3.Drive {
  if (typeof clientOrId === 'string') {
    const authClient = authPool.getClient(clientOrId);
    if (!authClient) {
      throw new Error(`Account ${clientOrId} not found in auth pool`);
    }
    return google.drive({ version: 'v3', auth: authClient });
  }

  return google.drive({ version: 'v3', auth: clientOrId });
}

export async function hydrateAccount(accountId: string): Promise<AccountHydrationResult> {
  const drive = getDriveClient(accountId);

  const aboutRes = await drive.about.get({
    fields: 'user,storageQuota',
  });

  const user = aboutRes.data.user;
  const storage = aboutRes.data.storageQuota;

  if (!user?.emailAddress) {
    throw new Error(`Failed to retrieve user profile for account ${accountId}`);
  }

  const rootFolderId = await ensureRootFolder(drive);

  const quotaLimit = storage?.limit ? Number(storage.limit) : 16106127360; // 15 GB fallback
  const quotaUsed = storage?.usage ? Number(storage.usage) : 0;

  await db
    .insert(accounts)
    .values({
      id: accountId,
      email: user.emailAddress,
      displayName: user.displayName || user.emailAddress.split('@')[0],
      avatarUrl: user.photoLink || null,
      quotaLimitBytes: quotaLimit,
      quotaUsedBytes: quotaUsed,
      syncState: 'idle',
      rootFolderId,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        email: user.emailAddress,
        displayName: user.displayName || user.emailAddress.split('@')[0],
        avatarUrl: user.photoLink || null,
        quotaLimitBytes: quotaLimit,
        quotaUsedBytes: quotaUsed,
        rootFolderId,
        updatedAt: new Date(),
      },
    });

  return {
    accountId,
    email: user.emailAddress,
    displayName: user.displayName || user.emailAddress.split('@')[0],
    avatarUrl: user.photoLink || null,
    quotaLimitBytes: quotaLimit,
    quotaUsedBytes: quotaUsed,
    rootFolderId,
  };
}

export const ROOT_FOLDER_NAME = '_Tsubasa~ Cloud';
export const LEGACY_ROOT_FOLDER_NAME = 'Tsubasa Storage';

export async function ensureRootFolder(drive: drive_v3.Drive): Promise<string> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and (name = '${ROOT_FOLDER_NAME}' or name = '${LEGACY_ROOT_FOLDER_NAME}') and 'root' in parents and trashed = false`;
  const searchRes = await drive.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name)',
    pageSize: 2,
  });

  if (searchRes.data.files && searchRes.data.files.length > 0) {
    const existing =
      searchRes.data.files.find((f) => f.name === ROOT_FOLDER_NAME) || searchRes.data.files[0];
    if (existing.id) {
      if (existing.name === LEGACY_ROOT_FOLDER_NAME) {
        try {
          await drive.files.update({
            fileId: existing.id,
            requestBody: { name: ROOT_FOLDER_NAME },
          });
        } catch {
          // Non-fatal if rename cannot be applied immediately
        }
      }
      return existing.id;
    }
  }

  const createRes = await drive.files.create({
    requestBody: {
      name: ROOT_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['root'],
      appProperties: {
        tsubasa_root: 'true',
      },
    },
    fields: 'id, name',
  });

  if (!createRes.data.id) {
    throw new Error(`Failed to create ${ROOT_FOLDER_NAME} root folder in Google Drive`);
  }

  return createRes.data.id;
}

