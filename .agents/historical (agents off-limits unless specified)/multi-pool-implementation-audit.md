# Multi-pool implementation audit

## 1. Scope and architecture analysis

**Objective:** Implement multi-pool storage management in Tsubasa~ Cloud so the user can create multiple isolated storage pools, switch between them in the left sidebar, rename pool display names in the UI, and assign or move empty Google Drive accounts between pools. Each pool maps to an immutable physical root folder named `_Tsubasa~ Pool <N>` in Google Drive, preserving zero-database cold-start recovery from `.oauths/` credentials alone.

**How cold-start recovery works now and with multiple pools:**
- Tsubasa does not store a binary `.db` file inside Google Drive accounts because syncing a binary SQLite file across multiple accounts introduces split-brain write conflicts. Instead, Tsubasa embeds self-describing metadata directly into Google Drive via `appProperties` (`tsubasa_managed: 'true'`, `tsubasa_virtual_path`, `tsubasa_virtual_id`, `tsubasa_checksum`) and mirrors the virtual directory hierarchy inside the account's root folder (`tsubasa_folder_path`).
- On a cold start with only `.oauths/` credentials and no local SQLite file, `hydrateAccount` and `runColdReconciliation` scan each account's root folder tree and `appProperties` in Google Drive, reconstructing `accounts`, `folders`, and `files` in local SQLite and acquiring a `changes.getStartPageToken` cursor.
- Naming the Google Drive root folder `_Tsubasa~ Pool 1`, `_Tsubasa~ Pool 2`, and so on makes pool membership self-describing on Google Drive. During cold-start hydration, Tsubasa scans `'root' in parents` for folders matching `/^_Tsubasa~ Pool ([1-9]\d*)$/`, extracts the pool integer `<N>`, ensures Pool `<N>` exists in the local `pools` table, and binds the account and all its discovered files and folders to Pool `<N>`.

**Affected subsystems:**
- **Database layer** (`src/server/db/schema.ts`, `src/server/db/init.ts`, `src/server/db/index.ts`): Add the `pools` table and scope `accounts`, `folders`, and `files` by `pool_id`.
- **Google Drive client and sync layer** (`src/server/drive/client.ts`, `src/server/drive/auth.ts`, `src/server/drive/sync.ts`, `src/server/drive/delta.ts`, `src/server/drive/detector.ts`, `src/server/drive/operations.ts`, `src/server/drive/rebalance.ts`, `src/server/drive/transfer.ts`, `src/server/drive/index.ts`): Replace `_Tsubasa~ Cloud` with `_Tsubasa~ Pool <N>`, auto-discover pool membership during hydration, enforce strict empty-account checks before switching an account's pool, and scope all tree operations, delta syncs, and rebalances by `poolId`.
- **Storage placement and quota engine** (`src/server/storage/quota.ts`, `src/server/storage/placement.ts`): Scope headroom overviews, system storage metrics, folder-affinity queries, and Best-Fit candidate selection to the target `poolId`. Expose `canSwitchPool` per account.
- **Backend RPC routes and server bootstrap** (`src/server/app.ts`, `src/server/index.ts`): Add `/api/pools` CRUD and account pool switching endpoints, accept `poolId` across file, folder, trash, placement, and storage routes, and trigger cold reconciliation on startup when `lastSyncToken` is missing.
- **Frontend UI and StyleX components** (`src/client/App.tsx`, `src/client/components/Sidebar.tsx`, `src/client/components/RenameModal.tsx`, `src/client/components/UploadDrawer.tsx`): Add the left-sidebar Pool Switcher (select pool, create pool, rename pool UI display name), per-account pool reassignment control for empty accounts, and pool-scoped state management.

**Database and contract impact:**

1. **`pools` table (`src/server/db/schema.ts`, `src/server/db/init.ts`):**
   ```sql
   CREATE TABLE IF NOT EXISTS pools (
     id INTEGER PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     drive_folder_name TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL DEFAULT (unixepoch()),
     updated_at INTEGER NOT NULL DEFAULT (unixepoch())
   );
   ```
   - Seeded on init with Pool 1: `id = 1`, `name = 'Pool 1'`, `drive_folder_name = '_Tsubasa~ Pool 1'`.
   - `name` is the frontend-only display label and can be renamed at any time.
   - `drive_folder_name` is strictly `_Tsubasa~ Pool <id>` and is never renamed after creation.

2. **`accounts` table updates:**
   - Add `pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id)`.
   - Add index `CREATE INDEX IF NOT EXISTS accounts_pool_idx ON accounts(pool_id)`.

3. **`folders` table updates:**
   - Add `pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id) ON DELETE CASCADE`.
   - Primary key `id` stores `${poolId}:${virtualPath}` (via `formatFolderId(poolId, virtualPath)`) so identical virtual paths in different pools never collide.
   - Replace global unique constraint on `virtual_path` with composite unique index `CREATE UNIQUE INDEX IF NOT EXISTS folders_pool_path_idx ON folders(pool_id, virtual_path)`.
   - Add index `CREATE INDEX IF NOT EXISTS folders_pool_parent_idx ON folders(pool_id, parent_folder_id)`.

4. **`files` table updates:**
   - Add `pool_id INTEGER NOT NULL DEFAULT 1 REFERENCES pools(id) ON DELETE CASCADE`.
   - `folder_id` references `folders(id) ON DELETE SET NULL` using `${poolId}:${parentDir}` (or `null` at `/`).
   - Replace global unique constraint on `virtual_path` with composite unique index `CREATE UNIQUE INDEX IF NOT EXISTS files_pool_path_idx ON files(pool_id, virtual_path)`.
   - Add index `CREATE INDEX IF NOT EXISTS files_pool_trashed_idx ON files(pool_id, is_trashed)`.

5. **RPC route contracts (`src/server/app.ts`):**
   - `GET /api/pools`: Returns `{ pools: Array<{ id: number; name: string; driveFolderName: string; accountCount: number; fileCount: number; totalBytes: number }> }`.
   - `POST /api/pools`: Optional JSON `{ name?: string }`. Computes `nextId = max(id) + 1`, inserts `{ id: nextId, name: trimmedName || 'Pool ' + nextId, driveFolderName: '_Tsubasa~ Pool ' + nextId }`, returns `201` with the created pool.
   - `PATCH /api/pools/:id`: JSON `{ name: string }`. Updates only `pools.name` in SQLite; never modifies `drive_folder_name` or Google Drive.
   - `POST /api/accounts/:id/pool`: JSON `{ poolId: number }`. Switches an account to `poolId` only if the account has zero files in SQLite (`SELECT count(*) FROM files WHERE account_id = ?`). Empty folders in the pool or on Drive do not block switching. Renames the remote Drive root folder to `_Tsubasa~ Pool <poolId>` in place (and removes any empty subfolders inside that Drive root folder so old pool folder skeletons do not carry over) and updates `accounts.pool_id`. Returns `409 Conflict` with `{ error, code: 'ACCOUNT_POOL_LOCKED' }` if the account has any files.
   - `GET /api/storage` and `GET /api/storage/overview`: Accept query `?poolId=<number>` (default `1`). Return pool-scoped storage overview and `canSwitchPool: boolean` on each `AccountStorageSummary`.
   - `GET /api/accounts` and `GET /api/accounts/pool`: Accept query `?poolId=<number>`. Return accounts belonging to `poolId` with `poolId: number` and `canSwitchPool: boolean`.
   - `POST /api/accounts/oauth/import`: Accept `{ filename: string; content: string; poolId?: number }`. Associates imported credentials with `poolId` (default `1`).
   - `GET /api/files`, `GET /api/folders`, `POST /api/folders`, `DELETE /api/folders`, `POST /api/items/move`, `POST /api/items/copy`, `POST /api/items/rename`, `POST /api/storage/placement/file`, `POST /api/storage/placement/batch`, `POST /api/files/upload/session`, `POST /api/files/upload`, `GET /api/trash`, `DELETE /api/trash/empty`: Accept `poolId` (via query or JSON body, defaulting to `1`) and scope all operations to that pool.

**Architectural constraints:**
- Local-first read path: Pool switching, folder navigation, and file listing query indexed SQLite tables (`pool_id`, `virtual_path`) in under 2ms.
- No legacy compatibility bloat: Do not retain `_Tsubasa~ Cloud` or `Tsubasa Storage` fallback constants in source files. Existing Google Drive folders and `data/tsubasa.db` rows will be migrated directly to `_Tsubasa~ Pool 1`.
- Strict account lock invariant: An account with any file in SQLite cannot switch pools. Empty folders in a pool never block an account from switching pools.
- UI-only pool renaming: Renaming a pool updates `pools.name` in SQLite and never renames the `_Tsubasa~ Pool <N>` folder in Google Drive.
- Compile-time StyleX and WCAG AAA contrast (7:1+ minimum) across light and dark themes.

---

## 2. Logical implementation slices

### Slice 1: Database schema and storage placement engine
- **File ownership:**
  - `src/server/db/schema.ts`
  - `src/server/db/init.ts`
  - `src/server/db/index.ts`
  - `src/server/storage/quota.ts`
  - `src/server/storage/placement.ts`
  - `src/server/storage/index.ts`
- **Detailed implementation plan:**
  1. In `src/server/db/schema.ts`, define the `pools` table (`id`, `name`, `driveFolderName`, `createdAt`, `updatedAt`). Add `poolId` to `accounts`, `folders`, and `files`. Update indexes on `folders` (`folders_pool_path_idx` unique on `(poolId, virtualPath)`, `folders_pool_parent_idx` on `(poolId, parentFolderId)`) and `files` (`files_pool_path_idx` unique on `(poolId, virtualPath)`, `files_pool_trashed_idx` on `(poolId, isTrashed)`). Export `Pool` and `NewPool` types.
  2. In `src/server/db/init.ts`, create the `pools` table and seed Pool 1 (`INSERT OR IGNORE INTO pools (id, name, drive_folder_name) VALUES (1, 'Pool 1', '_Tsubasa~ Pool 1')`). Define `accounts`, `folders`, and `files` with their `pool_id` columns and composite unique indexes without legacy `ALTER TABLE` shims.
  3. In `src/server/storage/quota.ts`:
     - Update `AccountStorageSummary` to include `poolId: number` and `canSwitchPool: boolean`.
     - Update `PooledStorageOverview` to include `poolId: number`.
     - Parameterize `getSystemStorageBreakdown(poolId = 1)` and `getPooledStorageOverview(poolId = 1, nowMs = Date.now())` to filter `accounts` and `files` by `poolId`.
     - Compute `canSwitchPool` for each account by checking total file count (both active and trashed) in `files` for that `accountId`: `canSwitchPool = (totalFileCountForAccount === 0)`.
  4. In `src/server/storage/placement.ts`:
     - Parameterize `getEligibleAccounts(poolId = 1, nowMs = Date.now())` to filter `eq(accounts.poolId, poolId)`.
     - Parameterize `findFolderAffinityAccounts(normalizedPath: string, poolId = 1)` to filter `eq(files.poolId, poolId)`.
     - Parameterize `selectPlacementForFile` and `planBatchPlacement` with `poolId = 1` and pass `poolId` down to `getEligibleAccounts` and `findFolderAffinityAccounts`.
     - In `validateTargetPlacement(accountId, sizeBytes, nowMs = Date.now(), expectedPoolId?: number)`, verify `account.poolId === expectedPoolId` when `expectedPoolId` is provided.
- **Tasks:**
  - [x] Add `pools` table and `poolId` columns/indexes to `src/server/db/schema.ts` and `src/server/db/init.ts`
  - [x] Scope `getSystemStorageBreakdown` and `getPooledStorageOverview` by `poolId` and compute `canSwitchPool` in `src/server/storage/quota.ts`
  - [x] Scope `getEligibleAccounts`, `findFolderAffinityAccounts`, `selectPlacementForFile`, `planBatchPlacement`, and `validateTargetPlacement` by `poolId` in `src/server/storage/placement.ts`
- **Verification:** `npx tsc --noEmit` (run after Slice 2 completes shared server types)

### Slice 2: Google Drive pool discovery, sync, account pool switching, and RPC routes
- **File ownership:**
  - `src/server/drive/auth.ts`
  - `src/server/drive/client.ts`
  - `src/server/drive/sync.ts`
  - `src/server/drive/delta.ts`
  - `src/server/drive/detector.ts`
  - `src/server/drive/operations.ts`
  - `src/server/drive/rebalance.ts`
  - `src/server/drive/transfer.ts`
  - `src/server/drive/index.ts`
  - `src/server/app.ts`
  - `src/server/index.ts`
- **Detailed implementation plan:**
  1. In `src/server/drive/auth.ts`:
     - Add `preferredPoolId?: number` to `AccountCredentials`.
     - Track pending pool assignments for unauthorized accounts in `AuthPool` (`setPreferredPool(accountId: string, poolId: number)` and `getPreferredPool(accountId: string): number`).
     - Update `importCredentials(rawFilename: string, rawContent: string, poolId = 1)` to store `preferredPoolId: poolId`.
     - Encode state in `generateAuthUrl` or look up `getPreferredPool(accountId)` during OAuth callback.
  2. In `src/server/drive/client.ts`:
     - Replace `ROOT_FOLDER_NAME` and `LEGACY_ROOT_FOLDER_NAME` with:
       - `export const POOL_FOLDER_PREFIX = '_Tsubasa~ Pool ';`
       - `export function getPoolDriveFolderName(poolId: number): string { return \`_Tsubasa~ Pool \${poolId}\`; }`
       - `export function parsePoolIdFromFolderName(name: string): number | null` matching `/^_Tsubasa~ Pool ([1-9]\d*)$/`.
     - Implement `ensurePoolExistsInDb(poolId: number): void` which inserts `{ id: poolId, name: \`Pool \${poolId}\`, driveFolderName: getPoolDriveFolderName(poolId) }` with `ON CONFLICT(id) DO NOTHING`.
     - Update `ensureRootFolder(drive: drive_v3.Drive, preferredPoolId = 1): Promise<{ rootFolderId: string; poolId: number }>`:
       - Search Google Drive for `mimeType = 'application/vnd.google-apps.folder' and name contains '_Tsubasa~ Pool ' and 'root' in parents and trashed = false`.
       - If a folder matching `parsePoolIdFromFolderName` exists (preferring `preferredPoolId` if multiple exist, otherwise the first valid match), extract `discoveredPoolId`, call `ensurePoolExistsInDb(discoveredPoolId)`, and return `{ rootFolderId: folder.id, poolId: discoveredPoolId }`.
       - Otherwise, call `ensurePoolExistsInDb(preferredPoolId)`, create `_Tsubasa~ Pool ${preferredPoolId}` in `'root'` with `appProperties: { tsubasa_root: 'true', tsubasa_pool_id: String(preferredPoolId) }`, and return `{ rootFolderId: createRes.data.id, poolId: preferredPoolId }`.
     - Update `hydrateAccount(accountId: string, preferredPoolId?: number)` to determine the effective preferred pool (`existingAccount?.poolId ?? preferredPoolId ?? authPool.getPreferredPool(accountId) ?? 1`), call `ensureRootFolder(drive, targetPoolId)`, and upsert `accounts` with `poolId` and `rootFolderId`.
     - Implement `switchAccountPool(accountId: string, targetPoolId: number): Promise<{ accountId: string; poolId: number; rootFolderId: string | null }>`:
       - Verify `targetPoolId` exists in `pools`.
       - Check local SQLite `SELECT count(*) as c FROM files WHERE account_id = ?`. If `c > 0`, throw `AccountPoolLockedError`. Empty folders do not block switching.
       - If the account is in `accounts` DB and has `rootFolderId`:
         - Check Google Drive for any non-folder managed files (`appProperties has { key='tsubasa_managed' and value='true' } and mimeType != 'application/vnd.google-apps.folder' and trashed = false`, `pageSize: 1`). If any file is found, throw `AccountPoolLockedError`.
         - If any empty child folders exist directly under `rootFolderId` on Drive, delete them so old pool folder skeletons do not leak into the new pool.
         - Rename the remote folder `rootFolderId` to `getPoolDriveFolderName(targetPoolId)` and update `appProperties: { tsubasa_root: 'true', tsubasa_pool_id: String(targetPoolId) }`.
         - Update `accounts.poolId = targetPoolId` in SQLite.
       - Update `authPool.setPreferredPool(accountId, targetPoolId)` so unauthorized accounts also switch cleanly.
  3. In `src/server/drive/sync.ts`, `delta.ts`, `detector.ts`:
     - Add `export function formatFolderId(poolId: number, virtualPath: string): string { return \`\${poolId}:\${virtualPath}\`; }`.
     - Update `insertFolderStmt` and `upsertFileStmt` to include `pool_id` and conflict on `(pool_id, virtual_path)`.
     - Update `insertFolderRecord(folderPath: string, poolId = 1)`, `ensureLocalFolderHierarchy(virtualPathOrFolderPath: string, poolId = 1)`, and `upsertFileRecord(f: DiscoveredFile & { poolId: number })`.
     - In `runColdReconciliation(accountId)`, `runIncrementalSync(accountId)`, `scanAccountDiscrepancies(accountId)`, and `acceptExternalFile(accountId, driveFileId, targetVirtualPath)`, read `accountRecord.poolId` and pass it to all folder and file upserts/queries.
  4. In `src/server/drive/operations.ts`, `rebalance.ts`, `transfer.ts`:
     - Scope `moveItems`, `copyItems`, `renameItem`, and `trashFolder` by `poolId = 1`. Use `formatFolderId(poolId, folderPath)` for `folders.id` and `files.folderId`.
     - In `rebalance.ts`, restrict `rebalanceFile`, `executeAutoRebalance`, and `evacuateAccountFiles` to candidate accounts within the same `sourceAccount.poolId`.
     - In `transfer.ts`, add `poolId?: number` to `UploadOptions`. Resolve `poolId` from `targetAccount.poolId` or `options.poolId ?? 1`, pass `poolId` to `selectPlacementForFile`, `ensureLocalFolderHierarchy`, and `files` insertion, and scope `emptyTrash(poolId?: number)` by `poolId`.
  5. In `src/server/app.ts` and `src/server/index.ts`:
     - Add pool management endpoints: `GET /api/pools`, `POST /api/pools`, `PATCH /api/pools/:id`, and `POST /api/accounts/:id/pool`.
     - Pass `poolId` through `/api/storage`, `/api/storage/overview`, `/api/accounts`, `/api/accounts/pool`, `/api/accounts/oauth/import`, `/api/files`, `/api/folders`, `/api/items/*`, `/api/storage/placement/*`, `/api/files/upload*`, `/api/trash`, and `/api/trash/empty`.
     - In `src/server/index.ts`, after `hydrateAccount` succeeds on startup, trigger `runIncrementalSync(res.accountId)` if the account has no `lastSyncToken` so cold starts index automatically.
- **Tasks:**
  - [x] Update `auth.ts` and `client.ts` with `_Tsubasa~ Pool <N>` naming, cold-start pool discovery, and `switchAccountPool`
  - [x] Scope `sync.ts`, `delta.ts`, `detector.ts`, `operations.ts`, `rebalance.ts`, and `transfer.ts` by `poolId`
  - [x] Wire `/api/pools` routes, `/api/accounts/:id/pool`, and `poolId` query/body parameters in `src/server/app.ts` and `src/server/index.ts`
  - [x] Run `npx tsc --noEmit` to verify server types

### Slice 3: Frontend Left Sidebar Pool Switcher, Pool Rename, and Account Pool Reassignment
- **File ownership:**
  - `src/client/api.ts`
  - `src/client/App.tsx`
  - `src/client/components/Sidebar.tsx`
  - `src/client/components/RenameModal.tsx`
  - `src/client/components/UploadDrawer.tsx`
- **Detailed implementation plan:**
  1. **Styling plan (`src/client/components/Sidebar.tsx`):**
     - Place a dedicated **Pool Switcher section** (`poolSection`) directly below `brandHeader` and above `navSection`, separated by a `1px solid colors.borderSubtle` bottom border.
     - Top header row (`poolHeaderRow`):
       - Label: `Storage pool` in uppercase `10px` (`typography.fontSizeBadge`, `typography.fontWeightSection`, `colors.dimText`, `letterSpacing: '0.06em'`).
       - Action buttons cluster on the right:
         - `Rename` compact icon+text button (`IconEdit`, `11px`) that opens `RenameModal` for the active pool's UI name.
         - `+ New pool` compact button (`IconPlus`, `11px`) that creates a new pool and switches to it.
     - Selector control (`poolSelectorWrap`):
       - Full-width custom-styled `<select>` (`height: '32px'`, `backgroundColor: colors.surfaceAlt`, `borderWidth: '1px'`, `borderColor: colors.borderSubtle`, `borderLeftWidth: '3px'`, `borderLeftColor: colors.accentGold`, `borderRadius: radius.compact`, `fontWeight: typography.fontWeightTitle`, `color: colors.primaryText`) with `IconChevronDown` overlay.
       - Each `<option>` displays `${pool.name} (${pool.accountCount} ${pool.accountCount === 1 ? 'drive' : 'drives'})`.
     - Per-account pool reassignment in `Sidebar.tsx`:
       - When `pools.length > 1`, each account card displays a compact pool assignment control in `accountActionsLeft`:
         - If `acc.canSwitchPool` is `true` (account has 0 files and 0 Tsubasa bytes), render a compact `<select>` (`miniPoolSelect`, `height: '22px'`, `fontSize: typography.fontSizeBadge`) allowing the user to move the empty account to another pool.
         - If `acc.canSwitchPool` is `false`, render a muted static badge or disabled indicator (`Locked to pool` on hover tooltip: `"Account contains pool files and cannot be switched to another pool"`).
  2. **Modal and state integration (`src/client/components/RenameModal.tsx`, `src/client/App.tsx`, `src/client/components/UploadDrawer.tsx`):**
     - Extend `RenameTarget.kind` in `RenameModal.tsx` to `'file' | 'folder' | 'pool'` so renaming a pool uses the exact same accessible modal dialog (`Rename Pool`).
     - In `App.tsx`:
       - Maintain `pools: PoolSummary[]` and `activePoolId: number` (initialized from `localStorage.getItem('tsubasa-active-pool-id')` or `1`).
       - Pass `poolId: String(activePoolId)` to `loadClusterData`, `loadFiles`, `loadTrashFiles`, `handleCreateFolder`, `handleDeleteFolder`, `handleMoveItems`, `handleCopyItems`, `handleRename`, `handleEmptyTrashExecute`, and `handleImportOAuth`.
       - When switching `activePoolId`, reset `currentPath` to `'/'`, clear `selectedIds` and `clipboard`, and reload pool data and files.
       - Implement `handleCreatePool`, `handleRenamePool`, and `handleSwitchAccountPool(accountId, targetPoolId)`.
     - In `UploadDrawer.tsx`:
       - Accept `poolId: number` prop and pass `poolId` to `client.api.storage.placement.batch.$post`, `client.api.folders.$post`, and `/api/files/upload?...&poolId=${poolId}`.
- **Tasks:**
  - [x] Add `PoolSummary` types and pass `poolId` in `UploadDrawer.tsx` and `RenameModal.tsx`
  - [x] Build the Pool Switcher section and empty-account pool reassignment control in `src/client/components/Sidebar.tsx`
  - [x] Wire `pools`, `activePoolId`, pool creation, UI-only pool rename, and account pool switching in `src/client/App.tsx`
  - [x] Run `npx tsc --noEmit` to verify full client and server compilation

---

## 3. Runtime verification plan

1. **Direct Google Drive & SQLite migration to Pool 1:**
   - Execute a one-shot script via `npx tsx` that:
     - Renames the remote Google Drive root folder (`root_folder_id`) on all 7 existing authorized accounts from `_Tsubasa~ Cloud` to `_Tsubasa~ Pool 1` and sets `appProperties: { tsubasa_root: 'true', tsubasa_pool_id: '1' }`.
     - Migrates `data/tsubasa.db` in place: creates `pools` with Pool 1 (`id: 1, name: 'Pool 1', drive_folder_name: '_Tsubasa~ Pool 1'`), rebuilds `accounts`, `folders`, and `files` with `pool_id = 1` and composite `(pool_id, virtual_path)` unique indexes, and prefixes existing `folders.id` and `files.folder_id` with `1:`.
2. **Compiler and production bundle verification:**
   - Run `npx tsc --noEmit` and `npm run build` to verify TypeScript types and StyleX CSS bundle compilation.
3. **Runtime API and invariant verification:**
   - Verify `GET /api/pools` returns Pool 1 with 7 accounts and 4 files.
   - Verify `POST /api/pools` creates Pool 2 (`_Tsubasa~ Pool 2`) and `PATCH /api/pools/2` renames its UI display name without changing `driveFolderName`.
   - Verify `POST /api/accounts/:id/pool` with a non-empty account (`argo.shallistera@gmail.com`) is strictly rejected with `409 ACCOUNT_POOL_LOCKED`.
   - Verify `POST /api/accounts/:id/pool` with an empty account (`elsie.elucia.de.lute.ima@gmail.com`) succeeds, renames its Google Drive folder to `_Tsubasa~ Pool 2`, and moves it back to Pool 1 (`_Tsubasa~ Pool 1`) cleanly.

---

## 4. Final audit and verdict

- **Slice 1 (`0ca13ce5-5ed7-4ee4-a0aa-14e5ab921f11`):** Added `pools` table and `poolId` foreign keys/composite unique indexes across `accounts`, `folders`, and `files` in `src/server/db/schema.ts` and `src/server/db/init.ts`. Scoped quota overviews (`canSwitchPool`) and Best-Fit placement engine by `poolId` in `src/server/storage/quota.ts` and `src/server/storage/placement.ts`.
- **Slice 2 (`d59a0e9b-3d31-47fa-b1cb-57bbe8f2b728`):** Implemented `_Tsubasa~ Pool <N>` physical root folder naming, cold-start pool discovery (`parsePoolIdFromFolderName`, `ensurePoolExistsInDb`), strict file-only lock enforcement (`switchAccountPool`, `AccountPoolLockedError`), pool-scoped folder IDs (`formatFolderId`), and `/api/pools` + `/api/accounts/:id/pool` Hono RPC routes across `src/server/drive/*`, `src/server/app.ts`, and `src/server/index.ts`.
- **Slice 3 (`daf58a30-1437-4122-8123-dbc3e23eeb9e`):** Built the left-sidebar Pool Switcher, UI-only pool rename flow, and per-account pool reassignment control across `src/client/api.ts`, `src/client/App.tsx`, `src/client/components/Sidebar.tsx`, `src/client/components/RenameModal.tsx`, `src/client/components/UploadDrawer.tsx`, and `src/client/components/MovePoolModal.tsx`.
  - Removed the gold accent on the left of the pool dropdown in `Sidebar.tsx`.
  - Replaced inline pool dropdowns on account cards with a matching `"Move pool"` action button placed to the left of the `Disable` / `Enable` button (and left of `Remove` on unauthorized accounts).
  - Restricted `"Move pool"` button visibility strictly to accounts that are valid to move (`canSwitchPool !== false`).
  - Added `MovePoolModal` providing candidate pool selection with capitalized `"Drives"` nomenclature (`Pool X (X Drives)` / `1 Drive`) and `(Current)` indicators.
  - Added friction-free `"Delete"` button for empty storage pools (`accountCount === 0`) in `Sidebar.tsx` backed by `DELETE /api/pools/:id` in `app.ts`, with zero-flicker synchronous state transitions and sequential empty pool navigation.
- **Direct Migration & Runtime Verification:**
  - Migrated `data/tsubasa.db` to Pool 1 (`_Tsubasa~ Pool 1`) and renamed the remote Google Drive root folders across all 7 connected accounts (`argo.shallistera@gmail.com`, `stout.reisalin.ryza@gmail.com`, `lynn.greyrat.lilia@gmail.com`, `lynn.lilia.greyrat@gmail.com`, `elsie.elucia.de.lute.ima@gmail.com`, `hac.haqua.du.lot.herminium@gmail.com`, `nora.floriann.leoria@gmail.com`) to `_Tsubasa~ Pool 1` with `appProperties: { tsubasa_root: 'true', tsubasa_pool_id: '1' }`.
  - Verified `GET /api/pools`, `POST /api/pools`, `PATCH /api/pools/:id` (UI-only rename preserving `driveFolderName`), `POST /api/accounts/:id/pool` rejection (`409 ACCOUNT_POOL_LOCKED` on accounts holding files), and `POST /api/accounts/:id/pool` success on empty accounts (`200` with remote Drive folder rename).
  - Verified `npx tsc --noEmit` and `npm run build` pass with zero errors.
