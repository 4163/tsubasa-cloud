import {
  DEMO_SEED_VERSION,
  type DemoAccountRecord,
  type DemoDiscrepancyRecord,
  type DemoFileRecord,
  type DemoFolderRecord,
  type DemoPoolRecord,
  type DemoSeedDataset,
  type DemoTransferLogRecord,
} from './db.js';
import { HOCCHAN_SNAPSHOT_FILES } from './hocchanSnapshot.js';
import { DEMO_ACCOUNT_ROSTER, type DemoPersona } from './roster.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

const DEFAULT_QUOTA_LIMIT_BYTES = 15 * GB; // 16,106,127,360 B
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const WELCOME_FILE_CONTENT = [
  'Tsubasa~ Cloud live demo',
  '',
  'Everything here runs in your browser using IndexedDB metadata.',
  'No real file bytes are uploaded or stored, and no external network requests leave this tab.',
  '',
  'Things to try:',
  '- Drag files or folders from your computer to preview Folder-Cohesion placement and run simulated uploads.',
  '- Open Trash to restore items or purge them permanently and watch account quota drop.',
  '- Open External Changes on Suruga Kanbaru or Nadeko Sengoku to test Auto-rebalance, Move to root, and sync actions.',
  '- Switch to Hocchan Union and share a folder or file to run the first-time Share Pool setup with Yotsugi Ononoki.',
  '- Import any .json file in the sidebar and click Authorize to cycle through the remaining accounts.',
  '- Click Reset demo in the header at any time to restore this starting state.',
  '',
].join('\n');

interface SeedFileSpec {
  readonly id?: string;
  readonly driveFileId?: string;
  readonly accountIndex: number;
  readonly virtualPath: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly daysAgo: number;
  readonly isTrashed?: boolean;
  readonly trashedDaysAgo?: number;
  readonly contentText?: string;
}

const MAIN_POOL_FILES: readonly SeedFileSpec[] = [
  // Account #1: Hitagi Senjougahara (~180 MB active, clean)
  {
    accountIndex: 1,
    virtualPath: '/Welcome to Tsubasa~.txt',
    sizeBytes: WELCOME_FILE_CONTENT.length,
    mimeType: 'text/plain',
    daysAgo: 1,
    contentText: WELCOME_FILE_CONTENT,
  },
  {
    accountIndex: 1,
    virtualPath: '/Documents/Q1-Expenses.xlsx',
    sizeBytes: 1_843_200,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    daysAgo: 4,
  },
  {
    accountIndex: 1,
    virtualPath: '/Documents/Apartment-Lease-2026.pdf',
    sizeBytes: 6_422_528,
    mimeType: 'application/pdf',
    daysAgo: 18,
  },
  {
    accountIndex: 1,
    virtualPath: '/Documents/Meeting-Notes.md',
    sizeBytes: 42_180,
    mimeType: 'text/markdown',
    daysAgo: 2,
  },
  {
    accountIndex: 1,
    virtualPath: '/Projects/tsubasa-notes-export.zip',
    sizeBytes: Math.round(96.4 * MB),
    mimeType: 'application/zip',
    daysAgo: 6,
  },
  {
    accountIndex: 1,
    virtualPath: '/Projects/wireframes-v3.fig',
    sizeBytes: Math.round(48.2 * MB),
    mimeType: 'application/octet-stream',
    daysAgo: 9,
  },
  {
    accountIndex: 1,
    virtualPath: '/Projects/release-demo-clip.mp4',
    sizeBytes: Math.round(27.6 * MB),
    mimeType: 'video/mp4',
    daysAgo: 11,
  },

  // Account #2: Mayoi Hachikuji (~2.60 GB active + 2 Trash items = 634.5 MB reclaimable)
  {
    accountIndex: 2,
    virtualPath: '/Photos/Kyoto Trip 2025/IMG_4102.jpg',
    sizeBytes: Math.round(8.4 * MB),
    mimeType: 'image/jpeg',
    daysAgo: 32,
  },
  {
    accountIndex: 2,
    virtualPath: '/Photos/Kyoto Trip 2025/IMG_4118.jpg',
    sizeBytes: Math.round(9.1 * MB),
    mimeType: 'image/jpeg',
    daysAgo: 32,
  },
  {
    accountIndex: 2,
    virtualPath: '/Photos/Kyoto Trip 2025/IMG_4145.dng',
    sizeBytes: Math.round(42.8 * MB),
    mimeType: 'image/x-adobe-dng',
    daysAgo: 31,
  },
  {
    accountIndex: 2,
    virtualPath: '/Photos/Kyoto Trip 2025/arashiyama-walk.mov',
    sizeBytes: Math.round(92.5 * MB),
    mimeType: 'video/quicktime',
    daysAgo: 31,
  },
  {
    accountIndex: 2,
    virtualPath: '/Photos/Wallpapers/night-train-4k.png',
    sizeBytes: Math.round(14.2 * MB),
    mimeType: 'image/png',
    daysAgo: 24,
  },
  {
    accountIndex: 2,
    virtualPath: '/Photos/Wallpapers/shrine-lanterns-4k.png',
    sizeBytes: Math.round(11.6 * MB),
    mimeType: 'image/png',
    daysAgo: 24,
  },
  {
    accountIndex: 2,
    virtualPath: '/Backups/dotfiles-2026-03.tar.gz',
    sizeBytes: Math.round(1.85 * GB),
    mimeType: 'application/gzip',
    daysAgo: 7,
  },
  {
    accountIndex: 2,
    virtualPath: '/Backups/obsidian-vault-backup.zip',
    sizeBytes: Math.round(640 * MB),
    mimeType: 'application/zip',
    daysAgo: 3,
  },
  {
    id: 'demo-file-trash-1',
    accountIndex: 2,
    virtualPath: '/Documents/old-draft-v1.docx',
    sizeBytes: Math.round(14.5 * MB),
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    daysAgo: 20,
    isTrashed: true,
    trashedDaysAgo: 2,
  },
  {
    id: 'demo-file-trash-2',
    accountIndex: 2,
    virtualPath: '/Backups/screen-recording-2026-02.mkv',
    sizeBytes: Math.round(620 * MB),
    mimeType: 'video/x-matroska',
    daysAgo: 28,
    isTrashed: true,
    trashedDaysAgo: 1,
  },

  // Account #3: Suruga Kanbaru (~3.40 GB active Tsubasa + 11.30 GB external = 14.70 GB <= 15 GB)
  {
    accountIndex: 3,
    virtualPath: '/Archives/track-season-2025.tar.zst',
    sizeBytes: Math.round(1.42 * GB),
    mimeType: 'application/zstd',
    daysAgo: 15,
  },
  {
    accountIndex: 3,
    virtualPath: '/Archives/old-laptop-docs.7z',
    sizeBytes: Math.round(680 * MB),
    mimeType: 'application/x-7z-compressed',
    daysAgo: 29,
  },
  {
    accountIndex: 3,
    virtualPath: '/Media/relay-finals-1080p.mkv',
    sizeBytes: Math.round(920 * MB),
    mimeType: 'video/x-matroska',
    daysAgo: 10,
  },
  {
    accountIndex: 3,
    virtualPath: '/Media/sprint-form-review.mp4',
    sizeBytes: Math.round(420 * MB),
    mimeType: 'video/mp4',
    daysAgo: 8,
  },

  // Account #4: Nadeko Sengoku (~1.20 GB active, plus modified + missingRemote active rows)
  {
    id: 'demo-file-4-modified',
    driveFileId: 'demo-drive-4-modified',
    accountIndex: 4,
    virtualPath: '/Documents/budget-2026.xlsx',
    sizeBytes: 245 * KB,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    daysAgo: 5,
  },
  {
    id: 'demo-file-4-missing',
    driveFileId: 'demo-drive-4-missing',
    accountIndex: 4,
    virtualPath: '/Documents/draft-presentation.pdf',
    sizeBytes: Math.round(4.8 * MB),
    mimeType: 'application/pdf',
    daysAgo: 12,
  },
  {
    accountIndex: 4,
    virtualPath: '/Media/watercolor-timelapse.mp4',
    sizeBytes: Math.round(740 * MB),
    mimeType: 'video/mp4',
    daysAgo: 14,
  },
  {
    accountIndex: 4,
    virtualPath: '/Media/character-sheets-raw.zip',
    sizeBytes: Math.round(482 * MB),
    mimeType: 'application/zip',
    daysAgo: 19,
  },

  // Account #5: Tsubasa Hanekawa (~45 MB active, ~14.20 GB free headroom for Auto-rebalance)
  {
    accountIndex: 5,
    virtualPath: '/Reading/distributed-storage-notes.pdf',
    sizeBytes: Math.round(18.5 * MB),
    mimeType: 'application/pdf',
    daysAgo: 9,
  },
  {
    accountIndex: 5,
    virtualPath: '/Reading/sqlite-wal-internals.pdf',
    sizeBytes: Math.round(14.2 * MB),
    mimeType: 'application/pdf',
    daysAgo: 16,
  },
  {
    accountIndex: 5,
    virtualPath: '/Reading/reading-list-2026.epub',
    sizeBytes: Math.round(12.3 * MB),
    mimeType: 'application/epub+zip',
    daysAgo: 3,
  },
];

// External non-Tsubasa Drive usage on Account #3 so total quota reaches ~14.70 GB (> 14.25 GB usable, <= 15 GB limit).
const ACCOUNT_3_EXTERNAL_BYTES = Math.round(11.3 * GB);

function getParentDir(virtualPath: string): string {
  const slashIndex = virtualPath.lastIndexOf('/');
  if (slashIndex <= 0) return '/';
  return virtualPath.slice(0, slashIndex);
}

function getBaseName(virtualPath: string): string {
  const slashIndex = virtualPath.lastIndexOf('/');
  return slashIndex >= 0 ? virtualPath.slice(slashIndex + 1) : virtualPath;
}

function makeFolderId(poolId: number, virtualPath: string): string {
  return `${poolId}:${virtualPath}`;
}

function makeAccountId(persona: DemoPersona): string {
  return `demo-acc-${persona.index}`;
}

function makeDemoHash(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ (ch + i), 0x85ebca6b);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${part1}${part2}${part1}${part2}`;
}

function ensureFolderChain(
  folderMap: Map<string, DemoFolderRecord>,
  poolId: number,
  dirPath: string,
  timestampIso: string
): string | null {
  if (dirPath === '/' || dirPath === '') {
    return null;
  }

  const folderId = makeFolderId(poolId, dirPath);
  if (folderMap.has(folderId)) {
    return folderId;
  }

  const parentDir = getParentDir(dirPath);
  const parentFolderId = ensureFolderChain(folderMap, poolId, parentDir, timestampIso);

  folderMap.set(folderId, {
    id: folderId,
    poolId,
    virtualPath: dirPath,
    name: getBaseName(dirPath),
    parentFolderId,
    createdAt: timestampIso,
    updatedAt: timestampIso,
  });

  return folderId;
}

export function buildInitialDemoDataset(nowMs = Date.now()): DemoSeedDataset {
  const nowIso = new Date(nowMs).toISOString();
  const seededPersonas = DEMO_ACCOUNT_ROSTER.slice(0, 9);

  const pools: DemoPoolRecord[] = [
    {
      id: 1,
      name: 'Main Pool',
      slug: 'main-pool',
      sortOrder: 0,
      driveFolderName: '_Tsubasa~ Pool 1',
      isSharePool: false,
      createdAt: new Date(nowMs - 45 * DAY_MS).toISOString(),
      updatedAt: nowIso,
    },
    {
      id: 2,
      name: 'Hocchan Union',
      slug: 'hocchan-union',
      sortOrder: 1,
      driveFolderName: '_Tsubasa~ Pool 2',
      isSharePool: false,
      createdAt: new Date(nowMs - 30 * DAY_MS).toISOString(),
      updatedAt: nowIso,
    },
  ];

  const folderMap = new Map<string, DemoFolderRecord>();
  const files: DemoFileRecord[] = [];
  const usedBytesByAccount = new Map<string, number>();

  const addUsedBytes = (accountId: string, bytes: number) => {
    usedBytesByAccount.set(accountId, (usedBytesByAccount.get(accountId) ?? 0) + bytes);
  };

  // Seed Main Pool (id: 1) files and folders
  MAIN_POOL_FILES.forEach((spec, idx) => {
    const persona = DEMO_ACCOUNT_ROSTER[spec.accountIndex - 1];
    const accountId = makeAccountId(persona);
    const createdIso = new Date(nowMs - spec.daysAgo * DAY_MS).toISOString();
    const parentDir = getParentDir(spec.virtualPath);
    const folderId = spec.isTrashed
      ? parentDir === '/'
        ? null
        : makeFolderId(1, parentDir)
      : ensureFolderChain(folderMap, 1, parentDir, createdIso);

    const id = spec.id ?? `demo-file-p1-${idx + 1}`;
    const driveFileId = spec.driveFileId ?? `demo-drive-p1-${idx + 1}`;

    files.push({
      id,
      poolId: 1,
      virtualPath: spec.virtualPath,
      name: getBaseName(spec.virtualPath),
      sizeBytes: spec.sizeBytes,
      mimeType: spec.mimeType,
      hash: makeDemoHash(`1:${spec.virtualPath}:${spec.sizeBytes}`),
      accountId,
      driveFileId,
      folderId,
      isTrashed: Boolean(spec.isTrashed),
      trashedAt:
        spec.isTrashed && spec.trashedDaysAgo !== undefined
          ? new Date(nowMs - spec.trashedDaysAgo * DAY_MS).toISOString()
          : null,
      createdAt: createdIso,
      updatedAt: createdIso,
      ...(spec.contentText !== undefined ? { contentText: spec.contentText } : {}),
    });

    // Both active and trashed files count toward Drive quotaUsedBytes; purge reclaims quota.
    addUsedBytes(accountId, spec.sizeBytes);
  });

  // Seed Hocchan Union (id: 2) files and folders from static snapshot (Accounts #6-#8; #9 stays empty)
  HOCCHAN_SNAPSHOT_FILES.forEach((item, idx) => {
    const persona = DEMO_ACCOUNT_ROSTER[item.accountIndex - 1];
    const accountId = makeAccountId(persona);
    const timestampIso = new Date(item.updatedAt).toISOString();
    const parentDir = getParentDir(item.virtualPath);
    const folderId = ensureFolderChain(folderMap, 2, parentDir, timestampIso);

    files.push({
      id: `demo-file-p2-${idx + 1}`,
      poolId: 2,
      virtualPath: item.virtualPath,
      name: item.name,
      sizeBytes: item.sizeBytes,
      mimeType: item.mimeType,
      hash: makeDemoHash(`2:${item.virtualPath}:${item.sizeBytes}`),
      accountId,
      driveFileId: `demo-drive-p2-${idx + 1}`,
      folderId,
      isTrashed: false,
      trashedAt: null,
      createdAt: timestampIso,
      updatedAt: timestampIso,
    });

    addUsedBytes(accountId, item.sizeBytes);
  });

  // Account #3 external Drive usage triggers buffer breach (~14.70 GB <= 15 GB, > 14.25 GB usable)
  const account3Id = makeAccountId(DEMO_ACCOUNT_ROSTER[2]);
  const account3Tsubasa = usedBytesByAccount.get(account3Id) ?? 0;
  const account3QuotaUsed = Math.min(DEFAULT_QUOTA_LIMIT_BYTES, account3Tsubasa + ACCOUNT_3_EXTERNAL_BYTES);
  usedBytesByAccount.set(account3Id, account3QuotaUsed);

  const accounts: DemoAccountRecord[] = seededPersonas.map((persona) => {
    const accountId = makeAccountId(persona);
    const poolId = persona.index <= 5 ? 1 : 2;
    const quotaUsedBytes = persona.index === 9 ? 0 : (usedBytesByAccount.get(accountId) ?? 0);

    return {
      id: accountId,
      email: persona.email,
      displayName: persona.displayName,
      avatarUrl: null,
      poolId,
      quotaLimitBytes: DEFAULT_QUOTA_LIMIT_BYTES,
      quotaUsedBytes,
      syncState: 'idle',
      isDisabled: false,
      authorized: true,
      sourceFile: `client_secret_${persona.index}.json`,
      clientId: `demo-client-${persona.index}.apps.googleusercontent.com`,
      mtimeMs: nowMs - (50 - persona.index) * DAY_MS,
      rootFolderId: `demo-root-p${poolId}-${persona.index}`,
    };
  });

  // Light 24h rolling upload activity on #1 (4.20 GB) and #2 (1.85 GB)
  const account1Id = makeAccountId(DEMO_ACCOUNT_ROSTER[0]);
  const account2Id = makeAccountId(DEMO_ACCOUNT_ROSTER[1]);
  const transferLogs: DemoTransferLogRecord[] = [
    {
      id: 'demo-xfer-1a',
      accountId: account1Id,
      transferType: 'upload',
      byteCount: Math.round(2.4 * GB),
      timestamp: nowMs - 9 * HOUR_MS,
    },
    {
      id: 'demo-xfer-1b',
      accountId: account1Id,
      transferType: 'upload',
      byteCount: Math.round(1.8 * GB),
      timestamp: nowMs - 3 * HOUR_MS,
    },
    {
      id: 'demo-xfer-2a',
      accountId: account2Id,
      transferType: 'upload',
      byteCount: Math.round(1.85 * GB),
      timestamp: nowMs - 6 * HOUR_MS,
    },
  ];

  // Uncluttered external changes on Account #3 (1 overCeiling) and Account #4 (1 unindexed, 1 modified, 1 missingRemote)
  const account4Id = makeAccountId(DEMO_ACCOUNT_ROSTER[3]);
  const discrepancies: DemoDiscrepancyRecord[] = [
    {
      accountId: account3Id,
      poolFolderName: '_Tsubasa~ Pool 1',
      scannedFiles: 5,
      conflicts: [],
      unindexed: [],
      modified: [],
      overCeiling: [
        {
          driveFileId: 'demo-drive-3-over-ceiling',
          name: 'raw-camera-dump-4k.mov',
          virtualPath: '/Media/raw-camera-dump-4k.mov',
          sizeBytes: Math.round(14.52 * GB), // 15,590,731,940 B (> 14.25 GB ceiling; not double-counted in quotaUsedBytes)
          mimeType: 'video/quicktime',
          hash: makeDemoHash('3:/Media/raw-camera-dump-4k.mov:over'),
          accountId: account3Id,
          discrepancyType: 'over_ceiling',
        },
      ],
      missingRemote: [],
    },
    {
      accountId: account4Id,
      poolFolderName: '_Tsubasa~ Pool 1',
      scannedFiles: 5,
      conflicts: [],
      unindexed: [
        {
          driveFileId: 'demo-drive-4-unindexed',
          name: 'sketchbook-scan-04.png',
          virtualPath: '/Media/sketchbook-scan-04.png',
          sizeBytes: Math.round(18.4 * MB),
          mimeType: 'image/png',
          hash: makeDemoHash('4:/Media/sketchbook-scan-04.png:unindexed'),
          accountId: account4Id,
          discrepancyType: 'unindexed',
        },
      ],
      modified: [
        {
          driveFileId: 'demo-drive-4-modified',
          name: 'budget-2026.xlsx',
          virtualPath: '/Documents/budget-2026.xlsx',
          sizeBytes: 312 * KB, // Remote size differs from local 245 KB
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          hash: makeDemoHash('4:/Documents/budget-2026.xlsx:remote'),
          accountId: account4Id,
          discrepancyType: 'modified',
        },
      ],
      overCeiling: [],
      missingRemote: [
        {
          fileId: 'demo-file-4-missing',
          driveFileId: 'demo-drive-4-missing',
          virtualPath: '/Documents/draft-presentation.pdf',
          accountId: account4Id,
        },
      ],
    },
  ];

  const folders = Array.from(folderMap.values()).sort((a, b) =>
    a.poolId !== b.poolId ? a.poolId - b.poolId : a.virtualPath.localeCompare(b.virtualPath)
  );

  return {
    meta: {
      key: 'state',
      seedVersion: DEMO_SEED_VERSION,
      nextPoolId: 3,
      usedPersonaEmails: seededPersonas.map((persona) => persona.email),
    },
    pools,
    accounts,
    files,
    folders,
    transferLogs,
    discrepancies,
    shareLinks: [],
  };
}
