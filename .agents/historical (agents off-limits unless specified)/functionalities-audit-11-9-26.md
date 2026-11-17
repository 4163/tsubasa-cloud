# Validation report and remediation plan

## 1. Validation report

**Target:** Working branch (`main..HEAD` on `functionalities`)
**Summary:** Implements the React + StyleX desktop and mobile application shell, virtualized file explorer (`FileTable`), upload and external-change drawers, OAuth credential import and email canonicalization, 24-hour transfer quota tracking, drive lifecycle controls (disable/enable/remove with evacuation), and item management operations (move, copy, rename, and folder trash).

### AGENTS.md violations

- [x] [`src/server/drive/operations.ts:275-318`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L275-L318), [`src/server/drive/operations.ts:401-445`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L401-L445), [`src/server/drive/operations.ts:770-796`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L770-L796), [`src/server/drive/operations.ts:846-890`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L846-L890) `[Blocking]` **Synchronous remote Google Drive mutations block virtual operations.** `AGENTS.md` Performance Directive #3 ("Instant virtual operations with lazy sync") mandates that folder renames, virtual file moves, and path updates apply instantly to SQLite and return immediately, while background tasks update Google Drive `appProperties` and remote folder hierarchy asynchronously.
  - **Resolution:** Moved all file and folder updates in `moveItems` and `renameItem` into synchronous SQLite transactions and dispatched `drive.files.update`, `syncRemoteFolderMove`, and `syncRemoteFolderRename` asynchronously in the background.
- [x] [`src/server/drive/delta.ts:24-115`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/delta.ts#L24-L115), [`src/server/drive/delta.ts:158-312`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/delta.ts#L158-L312) `[Blocking]` **Full remote tree crawl inside incremental delta sync.** `AGENTS.md` Performance Directive #4 ("Incremental delta synchronization") states that after initial account initialization, synchronization uses `changes.list` with stored page tokens to fetch only modified records without repeated tree crawls.
  - **Resolution:** Removed the unconditional `resolveRemoteFolderTree` call and full `drive.files.list` sweep from `runIncrementalSync`. Added `resolveRemoteParentPath`, which checks local SQLite `folders` first and queries Google Drive only when a parent folder ID is unknown locally.
- [x] [`src/client/App.tsx:385-470`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L385-L470) `[Blocking]` **Unthrottled Google Drive tree scans on page load and window focus.** `loadClusterData()` ran on mount, on every `window` `focus` event, and after every file/folder mutation, calling `checkAccountDiscrepancies()` (`GET /api/sync/external-changes/:accountId`) for every authorized account.
  - **Resolution:** Removed `checkAccountDiscrepancies` from `loadClusterData` so `loadClusterData` only queries local SQLite endpoints. Added a 60-second cooldown and restricted discrepancy scans to initial load, explicit sync actions (`handleSyncAll`), and drawer refresh.
- [x] [`src/server/app.ts:99-715`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L99-L715), [`src/client/App.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx), [`src/client/components/Sidebar.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx), [`src/client/components/ExternalChangesDrawer.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx), [`src/client/components/UploadDrawer.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/UploadDrawer.tsx) `[Warning]` **Bypassing typed Hono RPC client (`src/client/api.ts`) with raw `fetch()`.**
  - **Resolution:** Chained all API routes onto `export type AppType = typeof routes` in `src/server/app.ts` and replaced all raw `fetch('/api/...')` calls across `App.tsx`, `Sidebar.tsx`, `ExternalChangesDrawer.tsx`, and `UploadDrawer.tsx` with typed `client.api.*` RPC calls.
- [x] [`src/client/api.ts:6-11`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/api.ts#L6-L11), [`src/client/components/FileTable.tsx:19`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/FileTable.tsx#L19) `[Warning]` **Direct client reach-in to server database schema.**
  - **Resolution:** Exported `FileRecord`, `FolderRecord`, and `Folder` via `InferResponseType` in `src/client/api.ts` and updated `FileTable.tsx` to import from `../api.js`. Zero `../../server/` imports remain in `src/client/`.
- [x] [`src/client/components/ConfirmDriveActionModal.tsx:204`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ConfirmDriveActionModal.tsx#L204) `[Blocking]` **WCAG AAA contrast violation in light mode on primary action button.**
  - **Resolution:** Updated `styles.confirmBtn` text color from hardcoded `'#111d18'` to `colors.brandAccentText` (`#ffffff` in light mode, `#111d18` in dark mode).
- [x] [`src/client/tokens.stylex.ts:53-58`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts#L53-L58), [`src/client/tokens.stylex.ts:102-107`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts#L102-L107), [`src/client/components/ConfirmDriveActionModal.tsx:223`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ConfirmDriveActionModal.tsx#L223), [`src/client/components/ExternalChangesDrawer.tsx:303`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx#L303) `[Blocking]` **Danger token contrast violation against surface and global user rule mismatch.**
  - **Resolution:** Updated `colors.danger` to `#82071e` in light mode and `#ff9492` in dark mode, added `colors.dangerText` (`#ffffff` light, `#1c080a` dark), and updated solid danger buttons in `ConfirmDriveActionModal.tsx` and `ExternalChangesDrawer.tsx` to use `colors.dangerText`.
- [x] [`src/client/tokens.stylex.ts:25`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts#L25), [`src/client/tokens.stylex.ts:77`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts#L77) `[Warning]` **WCAG AAA contrast violation on `colors.dimText`.**
  - **Resolution:** Updated `colors.dimText` to `#3b5249` in light mode and `#9db8ac` in dark mode (≥7:1 contrast on both `canvas` and `surface`).
- [x] [`src/client/components/ActionPortal.tsx:106-110`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ActionPortal.tsx#L106-L110), [`src/client/components/Sidebar.tsx:743-753`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx#L743-L753), [`src/client/components/ExternalChangesDrawer.tsx:311-345`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx#L311-L345), [`src/client/components/UploadDrawer.tsx:450-467`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/UploadDrawer.tsx#L450-L467) `[Warning]` **Static inline `style={{ ... }}` objects instead of compile-time StyleX.**
  - **Resolution:** Migrated all static inline style objects across `ActionPortal.tsx`, `Sidebar.tsx`, `ExternalChangesDrawer.tsx`, and `UploadDrawer.tsx` into `stylex.create` rules consuming tokens from `tokens.stylex.ts`.
- [x] [`src/server/drive/operations.ts:275-282`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L275-L282), [`src/server/drive/operations.ts:401-439`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L401-L439), [`src/server/drive/operations.ts:770-777`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L770-L777), [`src/server/drive/operations.ts:846-884`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L846-L884) `[Warning]` **Mutating global `sqlite.pragma('foreign_keys = OFF')` across async boundaries.**
  - **Resolution:** Replaced connection-wide `foreign_keys = OFF` toggles with synchronous `sqlite.transaction(() => { sqlite.pragma('defer_foreign_keys = ON'); ... })` blocks.
- [x] [`src/server/app.ts:352-360`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L352-L360), [`src/client/components/FileTable.tsx:822-846`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/FileTable.tsx#L822-L846) `[Warning]` **Unfiltered full-table read and $O(N \times M)$ client-side folder size calculation.**
  - **Resolution:** Verified `GET /api/files` filters `eq(files.isTrashed, false)` and replaced the $O(N \times M)$ nested `startsWith` loop in `FileTable.tsx` (`folderSizeMap`) with a single $O(M)$ pass over `files` walking ancestor `/` prefixes.

### Redundant code and shared helpers

- [x] [`src/client/utils/format.ts:1-8`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/utils/format.ts#L1-L8), [`src/server/drive/rebalance.ts:255-262`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/rebalance.ts#L255-L262) `[Warning]` **`formatBytes` duplicated 8 times across client and server.**
  - **Resolution:** Created `src/client/utils/format.ts` and replaced all duplicate client `formatBytes` definitions in `ActionPortal.tsx`, `ConfirmDriveActionModal.tsx`, `ConfirmPurgeModal.tsx`, `ExternalChangesDrawer.tsx`, `FileTable.tsx`, and `UploadDrawer.tsx`.
- [x] [`src/server/drive/client.ts:261-279`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/client.ts#L261-L279) `[Warning]` **`getAccountRootFolderId` duplicated verbatim in `operations.ts` and `transfer.ts`.**
  - **Resolution:** Exported `getAccountRootFolderId` from `src/server/drive/client.ts` and imported it in `operations.ts` and `transfer.ts`.
- [x] [`src/server/drive/operations.ts:27-84`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L27-L84) `[Warning]` **Duplicated descendant folder and file `appProperties` batch-update worker pool in `syncRemoteFolderRename` and `syncRemoteFolderMove`.**
  - **Resolution:** Extracted `syncDescendantFolderPropertiesOnDrive` and `syncDescendantFilePathsOnDrive` in `src/server/drive/operations.ts` and reused both in `syncRemoteFolderRename` and `syncRemoteFolderMove`.
- [x] [`src/server/drive/transfer.ts:59-117`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/transfer.ts#L59-L117) `[Warning]` **Duplicated cross-account permission grant + server-side `drive.files.copy` + permission cleanup.**
  - **Resolution:** Extracted `copyDriveFileCrossAccount` in `src/server/drive/transfer.ts` and reused it in `copyItems` (`operations.ts`) and `rebalanceFile` (`rebalance.ts`).
- [x] [`src/server/drive/transfer.ts:119-135`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/transfer.ts#L119-L135) `[Nit]` **Duplicated 404 detection and Drive file deletion logic in `purgeFile` and `emptyTrash`.**
  - **Resolution:** Extracted `deleteDriveFileIgnoreNotFound` in `src/server/drive/transfer.ts` and reused it in `purgeFile`, `emptyTrash`, and `rebalanceFile`.
- [x] [`src/client/App.tsx:6`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L6), [`src/client/components/Sidebar.tsx:8-22`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx#L8-L22) `[Nit]` **`AccountTransferStats` interface defined twice in `App.tsx` and `Sidebar.tsx`.**
  - **Resolution:** Imported `AccountTransferStats` from `./components/Sidebar.js` in `src/client/App.tsx` and removed the duplicate interface.

### Stale code and references

- [x] `src/client/components/TrashModal.tsx` `[Warning]` **Orphaned component `TrashModal.tsx`.**
  - **Resolution:** Deleted `src/client/components/TrashModal.tsx`.
- [x] `src/client/assets/grain.css` `[Nit]` **Orphaned stylesheet `src/client/assets/grain.css` with invalid CSS (`z-index: X;`).**
  - **Resolution:** Deleted `src/client/assets/grain.css`.
- [x] [`src/client/App.tsx:266-277`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L266-L277), [`src/client/components/ConfirmDriveActionModal.tsx:9`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ConfirmDriveActionModal.tsx#L9) `[Nit]` **Dead `'disable'` branch in `ConfirmDriveActionModal` and `handleExecuteDriveAction`.**
  - **Resolution:** Narrowed `ConfirmDriveActionModal` `action` prop and `driveActionModal` state to `'remove'`.
- [x] [`src/server/app.ts:7`](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L7), [`src/client/App.tsx:1-4`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L1-L4), [`src/client/components/FileTable.tsx:4-13`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/FileTable.tsx#L4-L13), [`src/client/components/ExternalChangesDrawer.tsx:5`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx#L5), [`src/client/components/Sidebar.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx), [`src/client/components/Icons.tsx`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Icons.tsx), [`src/client/tokens.stylex.ts`](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts) `[Nit]` **Unused imports, state variables, and style rules.**
  - **Resolution:** Removed unused `like, or` in `src/server/app.ts`, unused `useRef`, `layout`, and `health` state in `src/client/App.tsx`, unused `IconChevronLeft` in `FileTable.tsx`, added `.js` extension to `./Icons.js` import in `ExternalChangesDrawer.tsx`, removed unused `quotaMeterText`, `progressBarWarning`, and `transferProgressBarWarning` in `Sidebar.tsx`, removed unused `IconArrowRight` in `Icons.tsx`, and removed unused `elevation` tokens in `tokens.stylex.ts`.
- [x] [`docs/styling-guide.md:33-38`](file:///D:/Projects/Tsubasa~%20Cloud/docs/styling-guide.md#L33-L38) `[Nit]` **Duplicated section in `docs/styling-guide.md`.**
  - **Resolution:** Removed the duplicate `### Viewport size breakpoints vs pointer capabilities` section.

### Verdict

**Pass** — All 4 blocking violations, all 11 warnings, and all 6 nits have been resolved and verified against `npx tsc --noEmit`, `npm run build`, and runtime API/SQLite checks.

---

## 2. Remediation implementation plan

### Slice 1: Decouple virtual move/rename operations from remote Drive sync (`[Blocking]`)
- **Files:** `src/server/drive/operations.ts`
- **Tasks:**
  - [x] 1. Replace `sqlite.pragma('foreign_keys = OFF')` around async Drizzle updates in `moveItems` and `renameItem` with synchronous `sqlite.transaction(() => { sqlite.pragma('defer_foreign_keys = ON'); ... })` blocks.
  - [x] 2. In `moveItems` (both file and folder branches) and `renameItem` (both file and folder branches), execute the local SQLite updates synchronously and return the result immediately.
  - [x] 3. Dispatch the Google Drive `files.update`, `syncRemoteFolderMove`, and `syncRemoteFolderRename` calls asynchronously in the background (with `.catch(...)` logging) so local operations complete immediately.
  - [x] 4. Extract the shared descendant folder/file `appProperties` update loop from `syncRemoteFolderRename` and `syncRemoteFolderMove` into `syncDescendantFolderPropertiesOnDrive` and `syncDescendantFilePathsOnDrive`.

### Slice 2: Keep incremental delta sync O(changes) and stop auto-crawling on focus (`[Blocking]`)
- **Files:** `src/server/drive/delta.ts`, `src/client/App.tsx`, `src/client/components/FileTable.tsx`
- **Tasks:**
  - [x] 1. In `src/server/drive/delta.ts` (`runIncrementalSync`), remove unconditional `resolveRemoteFolderTree` and full `drive.files.list` crawls, and resolve parent paths via local SQLite `folders` first before querying Drive for unknown parent IDs.
  - [x] 2. In `src/client/App.tsx`, remove the automatic `checkAccountDiscrepancies(poolData.accounts)` call from `loadClusterData()` so focus and mutation reloads only hit local SQLite endpoints.
  - [x] 3. In `src/client/components/FileTable.tsx`, replace the $O(N \times M)$ `folderSizeMap` nested loop with a single $O(M)$ pass over `files`.

### Slice 3: Fix WCAG AAA contrast tokens and button text pairings (`[Blocking]` & `[Warning]`)
- **Files:** `src/client/tokens.stylex.ts`, `src/client/components/ConfirmDriveActionModal.tsx`, `src/client/components/ExternalChangesDrawer.tsx`
- **Tasks:**
  - [x] 1. In `src/client/tokens.stylex.ts`:
     - [x] Update light mode `danger` to `#82071e` (9.4:1 contrast on `#f7faf5`) and dark mode `danger` to `#ff9492` (8.6:1 contrast on `#12211d`), matching global user rules and `docs/styling-guide.md`.
     - [x] Update `dimText` to meet 7:1 AAA contrast (`#3b5249` in light mode, `#9db8ac` in dark mode).
  - [x] 2. In `src/client/components/ConfirmDriveActionModal.tsx`:
     - [x] Change `confirmBtn` text color from hardcoded `'#111d18'` to `colors.brandAccentText`.
     - [x] Change `confirmBtnDanger` text color from hardcoded `'#ffffff'` to `colors.dangerText`.
  - [x] 3. In `src/client/components/ExternalChangesDrawer.tsx`:
     - [x] Change `btnDanger` text color from hardcoded `'#ffffff'` to `colors.dangerText`.

### Slice 4: Unify client API calls on typed Hono RPC (`[Warning]`)
- **Files:** `src/server/app.ts`, `src/client/api.ts`, `src/client/App.tsx`, `src/client/components/Sidebar.tsx`, `src/client/components/ExternalChangesDrawer.tsx`, `src/client/components/UploadDrawer.tsx`, `src/client/components/FileTable.tsx`
- **Tasks:**
  - [x] 1. Chain routes in `src/server/app.ts` onto `AppType` and replace raw `fetch('/api/...')` calls in `App.tsx`, `Sidebar.tsx`, `ExternalChangesDrawer.tsx`, and `UploadDrawer.tsx` with typed calls via `client.api.*` from `src/client/api.ts` (keeping `XMLHttpRequest` for streaming upload progress in `UploadDrawer.tsx`).
  - [x] 2. Export shared RPC-derived model types (`FileRecord`, `FolderRecord`, `Folder`) from `src/client/api.ts` so `FileTable.tsx` does not reach into `../../server/db/schema.js`.

### Slice 5: Deduplicate shared helpers, convert inline styles to StyleX, and clean up stale code (`[Warning]` & `[Nit]`)
- **Files:** `src/client/utils/format.ts`, `src/server/drive/client.ts`, `src/server/drive/operations.ts`, `src/server/drive/transfer.ts`, `src/server/drive/rebalance.ts`, `src/client/components/*.tsx`, `docs/styling-guide.md`
- **Tasks:**
  - [x] 1. Extract shared `formatBytes` helper in `src/client/utils/format.ts` and replace duplicate client definitions.
  - [x] 2. Export `getAccountRootFolderId` from `src/server/drive/client.ts` and remove duplicates in `operations.ts` and `transfer.ts`.
  - [x] 3. Extract `deleteDriveFileIgnoreNotFound` and `copyDriveFileCrossAccount` in `src/server/drive/transfer.ts` and reuse across `transfer.ts`, `operations.ts`, and `rebalance.ts`.
  - [x] 4. Convert static inline `style={{ ... }}` attributes in `ActionPortal.tsx`, `Sidebar.tsx`, `ExternalChangesDrawer.tsx`, and `UploadDrawer.tsx` into `stylex.create` rules.
  - [x] 5. Remove unused imports and dead code (`TrashModal.tsx`, `src/client/assets/grain.css`, unused `health` state, unused `elevation` tokens, duplicate heading in `docs/styling-guide.md`).
