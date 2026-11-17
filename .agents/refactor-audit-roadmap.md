# Refactor branch audit and execution roadmap

**Branch:** `refactor/pipeline-perf-ux` (`306af05`) vs `main` (`2d9cb92`)  
**Baseline check:** `npm run typecheck` (`tsc --noEmit`) passed with exit code 0 on a clean working tree.  
**Purpose:** Combine a `validate-changes` compliance pass with a full-surface UX/UI fragility and silent-error audit, consolidated into a cold-agent execution checklist.

## Hard rules for cold agents

1. **Preserve every visual and functional UI/UX behavior.** Every UI layout, token value, interaction pattern, and user flow on this branch is intentional. Never change button labels, colors, spacing, modal flows, or visual design.
2. **Surface errors in place only.** Fix silent failures using existing inline slots (`workspaceError`, `role="status"` modal error banners, `statusNoticeBanner`, `UploadFileCard` error slot, or inline button state swaps). Never add toast notifications, right-click menus, or undo queues.
3. **One writer per file at a time.** Slices A through E and G are file-disjoint. Slices F and H both edit `src/client/App.tsx` (run F before H, or assign one agent to `App.tsx` edits).
4. **Verify after each slice.** Run `npm run typecheck` and `npx tsc -p tsconfig.server.json --noEmit` after edits, plus targeted runtime or `curl` checks for changed backend routes. Do not add new test harnesses during implementation and do not run `git commit`.
5. **Track progress here.** Mark completed checklist items with `[x]` and add a short handoff note at the bottom of the slice if stopping mid-slice.

---

## Part 1: `validate-changes` report (`main..HEAD`)

**Target:** `git diff main..HEAD` across 63 changed files and full read of all `src/client/` and `src/server/` modules.  
**Summary:** The refactor branch introduces strong latency and durability foundations (local SQLite read projections, pool revision ETags, `drive_outbox`, `withDriveRetry`, `inFlightFolderPromises`, StyleX token consolidation, and shared drawer/dialog primitives), but leaves boundary gaps in upload streaming bounds, cache/ETag invalidation, outbox retry ordering, `ExternalChangesDrawer` virtualization, and silent frontend error paths.

### `AGENTS.md` violations

#### Blocking
- `src/server/drive/transfer.ts:420-465`, `src/server/app.ts:1461` `[Blocking]` Multipart upload path (`sizeBytes <= 5 MB`) buffers `countingStream` via `readStreamToBuffer` while checking only `actualBytes > MAX_SINGLE_FILE_BYTES` (14.25 GB), allowing understated `sizeBytes` to buffer up to 14.25 GB in RAM and bypass headroom/24h quota checks (Roadmap `D-1`).
- `src/server/app.ts:288`, `src/server/app.ts:1555` `[Blocking]` Global `compress()` middleware compresses `200` `/api/files/:id/download` responses for compressible MIME types (`text/*`, `application/json`, `image/svg+xml`) and strips `Content-Length` because `Cache-Control` omits `no-transform` (Roadmap `D-5`).
- `src/server/app.ts:1439`, `src/server/drive/transfer.ts:243-282` `[Blocking]` `POST /api/files/upload/session` checks Share Pool read-only status before `prepareUploadTarget` resolves `poolId` from `targetAccountId`, bypassing the Share Pool guard (Roadmap `D-3`).
- `src/server/storage/placement.ts:82-117, 333-352, 684-736`, `src/server/drive/transfer.ts:278-306` `[Blocking]` Concurrent uploads lack per-account in-flight byte reservations, allowing parallel uploads to breach the 750 MB safety reserve (14.25 GB ceiling) and 750 GB/24h limit (Roadmap `A-6`).
- `src/server/drive/sync.ts:376-387`, `src/server/drive/delta.ts:217-228`, `src/server/drive/detector.ts:476-1399` `[Blocking]` Cold sync, delta sync, external accept, and conflict resolvers bypass the 14.25 GB `MAX_SINGLE_FILE_BYTES` ceiling enforced by `scanAccountDiscrepancies` (Roadmap `B-7`, `C-2`).
- `src/client/components/ExternalChangesDrawer.tsx:1312, 1392, 1601, 1653, 1704` `[Blocking]` Discrepancy card lists render directly into the DOM without TanStack Virtual, violating the constant-time DOM rendering rule on large change sets (Roadmap `G-7`).

#### Warning
- `src/server/drive/transfer.ts:588-590`, `src/server/drive/share.ts:1094-1102` `[Warning]` `recordTransfer` runs after `sqlite.transaction(...).immediate()` commits instead of atomically inside the transaction (Roadmap `A-5`, `D-4`).
- `src/server/app.ts:785, 809`, `src/server/drive/rebalance.ts:207-211, 594-619` `[Warning]` `evacuateAccountFiles` / `removeDriveAccount` updates `files.account_id` without calling `bumpPoolRevision(poolId)`, leaving `/api/files` ETags stale (Roadmap `C-6`).
- `src/server/drive/operations.ts:1571-1587` `[Warning]` `copyItems` double-wraps `copyDriveFileCrossAccount` in `withDriveRetry` (up to 36 attempts per file) (Roadmap `C-11`).
- `src/server/drive/rebalance.ts:256` `[Warning]` Hardcodes `750 * 1024 * 1024` instead of reusing `calculateUsableLimit` from `src/server/storage/` (Roadmap `C-6`).
- `src/client/utils/useTabLock.ts:185-202` `[Warning]` `sendServerRelease` uses raw `fetch('/api/instance/release', { keepalive: true })` and `sendBeacon` rather than typed Hono RPC URL derivation or an intentional-exception comment (Roadmap `E-1`).
- `src/client/tokens.stylex.ts:8, 32, 50-51, 60-61, 79, 109` `[Warning]` Header and inline comments still claim 7:1 AAA across all pairings while intentional hover, `surfaceElevated`, and `surfaceAlt` badge states sit between 5.56:1 and 6.89:1 (Roadmap `E-6`).
- `src/client/components/Sidebar.tsx:1118, 1726, 1819`, `src/client/components/AccountAvatar.tsx:145`, `src/client/global.css:83-110` `[Warning]` Inline `style={{ ... }}` props for progress scale and dynamic avatar hues, plus repeated raw hex colors in `global.css` scrollbars (Roadmap `E-7`, `F-12`).
- `src/client/components/FileTable.tsx:381, 661`, `src/client/components/UploadDrawer.tsx:102, 270, 487`, `src/client/components/ExternalChangesDrawer.tsx:109`, and modals (`ConfirmDriveActionModal`, `ConfirmPurgeModal`, `MoveConflictModal`, `MoveFilesModal`, `MovePoolModal`, `NewFolderModal`, `RenameModal`, `ShareModal`, `TabBlockedModal`) `[Warning]` Hardcoded `rgba(...)`, transition durations, `'460px'` drawer widths, `'48px'` modal headers, `'4px'`/`'2px'` gaps, `'600'` weights, and `'1.4'` line heights instead of `tokens.stylex.ts` tokens (Roadmap `E-6`, `G-10`, `H-8`).
- `src/client/components/UploadDrawer.tsx:979-1221` `[Warning]` `UploadFolderCard` re-scans `group.items` and allocates `new Set()` on every 120 ms progress flush (Roadmap `G-9`).

#### Nit
- `src/client/components/FileTable.tsx:117, 277`, `docs/styling-guide.md:187-191` `[Nit]` Table column widths and drawer button heights differ intentionally from `docs/styling-guide.md`; preserve values and document the intentional drift (Roadmap `G-9`).
- `index.html:13-51` `[Nit]` Anti-FOUC inline `<script>` / `<style>` lacks a CSP note and best-effort `localStorage` comment (Roadmap `A-12`).
- `src/client/components/Header.tsx:282-288` `[Nit]` Search `<input>` relies on `placeholder` without `aria-label` (Roadmap `F-13`).

### Redundant code and shared helpers
- `src/server/drive/index.ts:101-121` vs `src/server/drive/client.ts:118-138` `[Warning]` `runBoundedWorkers` duplicates `runBoundedConcurrency` (Roadmap `B-3`).
- `src/server/drive/sync.ts:397-411`, `delta.ts:251-265`, `detector.ts:865-1465` `[Warning]` Seven inline `appProperties` clearing literals and duplicated orphan-unmarking loops omit `tsubasa_checksum` (Roadmap `B-10`).
- `src/server/drive/detector.ts:497-1337`, `operations.ts:1114-1150` `[Warning]` Six repeated SQLite commit blocks in `detector.ts` and duplicated `(copy)` suffix naming between `reserveAvailableCopyPath` and `getAvailableCopyPath` (Roadmap `C-3`, `C-12`).
- `src/server/drive/auth.ts:96-129, 340-415, 659-739` `[Warning]` Duplicated `.tokens.json` reading, `.json`/`.env` validation, and sync/async signature refreshers (Roadmap `B-9`).
- `src/server/db/index.ts:113-140` `[Warning]` `renameAccountInDb` repeats row-reassignment across 3 branches and omits conflict cleanup in branch 3 (Roadmap `A-2`).
- `src/server/storage/placement.ts:278-327, 495-524`, `operations.ts:1503-1515` `[Warning]` Duplicated best-fit selection and candidate decision commit logic (Roadmap `A-9`).
- `src/server/db/init.ts:11-139` vs `src/server/db/schema.ts:4-129`, `drizzle.config.ts` `[Warning]` DDL duplicated in raw SQL while `drizzle.config.ts` migrations folder is unused (Roadmap `A-11`).
- `src/server/drive/transfer.ts:163-183` vs `src/server/drive/outbox.ts:277-281, 450-466` `[Warning]` Conflicting `deleteDriveFileIgnoreNotFound` and duplicate `isDriveNotFoundError` implementations (Roadmap `C-7`).
- `src/server/drive/operations.ts:1004-1917`, `outbox.ts:602-708` `[Warning]` Repeated outbox fanout loops in `operations.ts` and identical descendant path sync in `folder_rename_account` / `folder_move_account` (Roadmap `C-4`, `C-12`).
- `src/server/app.ts:493-2210` `[Warning]` Repeated `parseStrictPoolId` bypasses, inline `conflictMode` checks, ETag checks, and 12 inline domain error-mapping `catch` blocks (Roadmap `D-7`, `D-8`).
- `src/client/main.tsx:15-38` vs `src/client/App.tsx:368-430` `[Warning]` Duplicated `readInitialTheme` and `applyDocumentTheme` (Roadmap `E-5`).
- `src/client/App.tsx:209-215, 1662-2449`, `Sidebar.tsx:1061-1098` `[Warning]` Duplicated parent-dir / path normalization and `DAILY_LIMIT` / `formatGbCompact` helpers (Roadmap `F-11`, `F-12`).
- `src/client/components/DrawerPrimitives.tsx`, `ExternalChangesDrawer.tsx`, `UploadDrawer.tsx` `[Warning]` Duplicated `<dialog>` shell, lifecycle, select styles, and danger button styling (Roadmap `G-10`).
- `src/client/components/FileTable.tsx:1792-1863` `[Warning]` `handleDrop` and `handleRowDrop` duplicate internal/external drop dispatch (Roadmap `G-9`).
- `src/client/components/{ConfirmDriveActionModal,ConfirmPurgeModal,MoveConflictModal,MoveFilesModal,MovePoolModal,NewFolderModal,RenameModal,ShareModal,TabBlockedModal}.tsx` `[Warning]` ~700 lines of duplicated modal chrome styles, `<h3>` vs `<h2>` heading drift, and duplicate input Enter/submit boilerplate (Roadmap `H-8`).

### Stale code and references
- `src/server/drive/index.ts:6` `[Nit]` Unused import `runColdReconciliation` (Roadmap `B-11`).
- `src/server/drive/sync.ts:230-240` `[Nit]` Dead exported helper `ensureLocalFolderHierarchy` with zero callers (Roadmap `B-11`).
- `src/server/drive/detector.ts:491` `[Nit]` Redundant identical-branch ternary on `fileName` (Roadmap `C-13`).
- `src/server/drive/rebalance.ts:215-217` `[Nit]` Unreachable `.catch(...)` on non-throwing `deleteDriveFileIgnoreNotFound` (Roadmap `C-7`).
- `tsubasa.db` (repo root, 0 bytes) `[Nit]` Orphaned DB file outside `data/tsubasa.db` (Roadmap `A-13`).
- `src/server/storage/placement.ts:689, 715` `[Nit]` Unused `freedBytesOnAccount` parameter in `validateTargetPlacement` (Roadmap `A-13`).
- `src/server/db/init.ts:117`, `src/server/db/schema.ts:61` `[Nit]` Redundant `files_pool_trashed_idx` covered by wider composite indexes (Roadmap `A-13`).
- `src/server/db/schema.ts:131-150` `[Nit]` Missing `ShareLink` / `NewShareLink` inferred type exports (Roadmap `A-13`).
- `package.json:7, 9, 31` `[Nit]` Unused `@stylexjs/rollup-plugin` devDependency and duplicate `dev`/`dev:server` scripts (Roadmap `A-13`).
- `tsconfig.server.json:16-19` `[Warning]` `@/*` path alias compiles with `tsc` but fails at Node runtime because `tsc` does not rewrite paths (Roadmap `A-11`).
- `src/server/app.ts:7-8, 761-763, 879-880, 937, 1324-1326, 1387-1458`, `operations.ts:4, 1320`, `outbox.ts:1031` `[Nit]` Unused imports (`pools`, `asc`, `sql`, `accounts`), unreachable `InsufficientStorageError` catch branches, redundant DB query in `copyItems`, unused `getBackgroundJob`, hardcoded `0` OAuth counters lacking comments, and unfinalized `/api/files/upload/session` (Roadmap `D-9`).
- `src/client/utils/useBeforeUnload.ts:19-39` `[Nit]` Dead `useDialogLock` export (Roadmap `E-4`).
- `src/client/utils/useTabLock.ts:47, 475-487` `[Nit]` Unused `singleton.teardown` property (Roadmap `E-1`).
- `src/client/api.ts:6, 9, 11, 13-14` `[Nit]` Unused exported types (`FilesResponse`, `FoldersResponse`, `Folder`, `PoolsResponse`, `PoolRecord`) (Roadmap `E-8`).
- `src/client/tokens.stylex.ts:156` `[Nit]` Unused `layout.sidebarCollapsedWidth` token (Roadmap `E-6`).
- `src/client/components/Icons.tsx:118-124` `[Nit]` Unused `IconChevronLeft` export (Roadmap `F-13`).
- `src/client/components/Sidebar.tsx:72, 1129`, `src/client/App.tsx:3515` `[Nit]` Unused `totalLimitBytes` prop (Roadmap `F-12`).
- `src/client/components/UploadDrawer.tsx:36, 1558-1569`, `FileTable.tsx:35-36` `[Nit]` Dead `reason` / `reasonLabel` field on `PlacementItemPreview` and mid-file `import type` statements (Roadmap `G-9`).
- `src/client/components/ConfirmDriveActionModal.tsx:13, 263`, `NewFolderModal.tsx:4`, `MoveConflictModal.tsx:435-447` `[Nit]` Unused `_action` prop, missing `.js` extension on `./Icons`, and per-render `getConflictMatchMeta` closure (Roadmap `H-9`).

### Verdict
**Fail** (Blocking streaming memory ceiling, Share Pool upload bypass, download compression, concurrent quota race, non-retryable `pending_drive_sync`, error-swallowing `resolveRemoteParentPath`, out-of-order outbox retries, unvirtualized `ExternalChangesDrawer`, and silent frontend failures).

---

## Part 2: Execution roadmap and cold-agent checklists

### Slice A: Database, revision epoch, storage quota, and config
**Files owned:** `package.json`, `tsconfig.server.json`, `drizzle.config.ts`, `index.html`, `src/server/index.ts`, `src/server/db/index.ts`, `src/server/db/init.ts`, `src/server/db/schema.ts`, `src/server/storage/placement.ts`, `src/server/storage/quota.ts` (coordinate signature check with `src/server/drive/transfer.ts` / `share.ts` callers in Slice D).

- [x] **A-1 `[Blocking]` Seed monotonic boot epoch for `globalPoolRevisionEpoch` and bump on account rename**
  - **Locations.** `src/server/db/index.ts:30-45`, `97-142` (consumers: `src/server/app.ts:1039, 1105, 1631`).
  - **Failure mode.** `globalPoolRevisionEpoch` resets to `0` on server restart, causing post-restart ETags (`W/"files-...-r0"`) to collide with pre-restart client `If-None-Match` headers and serve `304 Not Modified` with stale rows. `renameAccountInDb` also omits `bumpPoolRevision()`.
  - **Preserved UX.** ETag caching behavior and `getPoolRevision` / `bumpPoolRevision` return types stay identical.
  - **Steps.** Seed `globalPoolRevisionEpoch = Date.now() * 1000 + crypto.randomInt(1000)` at startup and call `bumpPoolRevision()` inside `renameAccountInDb` when `files` rows are updated.

- [x] **A-2 `[Warning]` Fix SQLite `busy_timeout` order and deduplicate `renameAccountInDb`**
  - **Locations.** `src/server/db/index.ts:17-23`, `113-140`.
  - **Failure mode.** `journal_mode = WAL` runs before `busy_timeout = 5000`, so concurrent open locks fail immediately with `SQLITE_BUSY`. `renameAccountInDb` repeats row updates across 3 branches and omits `deleteConflictingShareLinks` in branch 3 (`!existingWithOld`), risking `UNIQUE constraint failed` on `share_links_pool_batch_account_idx`.
  - **Preserved UX.** Identical WAL mode and account ID migration results.
  - **Steps.** Move `sqlite.pragma('busy_timeout = 5000');` above `journal_mode = WAL`. Extract `reassignAccountRows(stmts, oldId, targetId)` in `src/server/db/index.ts` running `deleteConflictingShareLinks`, `deleteConflictingPendingDriveSync`, and all five `update*Account` updates across all 3 branches.

- [x] **A-3 `[Warning]` Fix legacy Share Pool migration (`drive_outbox.pool_id`) and ID conflict warning**
  - **Locations.** `src/server/db/init.ts:154-231`.
  - **Failure mode.** Migration updates `folders`, `files`, `accounts`, `share_links`, and `pools` to `1_000_000`, omitting `drive_outbox.pool_id` (`init.ts:101`). If `1_000_000` already exists, migration is silently skipped while `user_version` advances to `4`.
  - **Preserved UX.** Cold starts and standard single-share-pool upgrades remain unchanged.
  - **Steps.** Add `UPDATE drive_outbox SET pool_id = ? WHERE pool_id = ?` inside the migration transaction and log a clear `console.warn` when `legacySharePool` collides with an existing `1_000_000` pool.

- [x] **A-4 `[Blocking]` Prevent torn-read snapshots in `getPooledStorageOverview` and fix cache time checks**
  - **Locations.** `src/server/storage/quota.ts:339-396`, `463-467`.
  - **Failure mode.** `getPooledStorageOverview` reads `getDbTotalChanges()`, yields across 4 `await` DB queries, then writes `overviewCache` using a second `getDbTotalChanges()` read, caching mixed pre/post-mutation snapshots for 30s. Passing an earlier `nowMs` also hits a future cache entry.
  - **Preserved UX.** Cached overview payload shape and 30-second TTL stay identical.
  - **Steps.** Run all 4 SQLite reads synchronously inside `sqlite.transaction(() => ...)` (or without `await` between them), capture `startDbVersion` before reading, store `cachedAtMs`, and write `overviewCache` only if `getDbTotalChanges() === startDbVersion`, requiring `nowMs >= cached.cachedAtMs && nowMs < cached.earliestExpiryMs` on lookup.

- [x] **A-5 `[Warning]` Chunk `getTransferStatsByAccountMap` queries, add `recordTransferSync`, and guard 0-byte writes**
  - **Locations.** `src/server/storage/quota.ts:148, 189, 205, 286-312` (cross-ref `src/server/storage/placement.ts:586`).
  - **Failure mode.** Unchunked `inArray` and `or(...expiringPairs)` fail with `SQLITE_ERROR: too many SQL variables` around ~499+ accounts. `recordTransfer` writes `0`-byte rows (creating phantom 24h reset countdowns), prunes using event `timestamp` instead of `nowMs`, and invalidates all pools instead of `poolId`.
  - **Preserved UX.** Identical `AccountTransferStats` outputs and non-zero transfer tracking.
  - **Steps.** Extract a shared `chunkArray(items, 400)` helper in `src/server/db/index.ts` and batch `accountIds` / `expiringPairs` in `quota.ts`. Return early in `recordTransfer` when `!Number.isFinite(byteCount) || byteCount <= 0`, pass `nowMs` to `pruneOldTransferLogs`, accept optional `poolId`, and export `recordTransferSync` for transactional callers (`transfer.ts`, `share.ts`).

- [x] **A-6 `[Blocking]` Add in-memory per-account capacity reservations for concurrent uploads**
  - **Locations.** `src/server/storage/placement.ts:82-117, 333-352, 684-736` (paired with `D-2` in `src/server/drive/transfer.ts:278-306, 570-590`).
  - **Failure mode.** `getEligibleAccounts`, `selectPlacementForFile`, and `validateTargetPlacement` read committed SQLite quota/transfer state while `UploadDrawer` runs up to 3 parallel uploads, letting concurrent uploads breach the 750 MB safety reserve (14.25 GB ceiling) or 750 GB daily cap.
  - **Preserved UX.** Parallel upload UI and inline `INSUFFICIENT_STORAGE` / `EXCEEDS_CEILING` error codes stay unchanged.
  - **Steps.** Add `inFlightAccountReservations` (`Map<string, number>`) and export `reserveAccountCapacity(accountId, bytes): () => void` in `src/server/storage/placement.ts`; subtract reserved bytes from `headroomBytes` and `remainingUploadBytes24h` in `getEligibleAccounts` and `validateTargetPlacement`.

- [x] **A-7 `[Blocking]` Stop stripping branch directory in `simulateBatchPlacement` affinity lookup**
  - **Locations.** `src/server/storage/placement.ts:158-214`, `478-480`.
  - **Failure mode.** `simulateBatchPlacement` passes folder `node.fullPath` (e.g. `/Photos/2026`) to `getAffinityAccounts` / `findFolderAffinityAccounts`, both of which immediately call `path.posix.dirname(normalizedPath)`, evaluating `/Photos` instead of `/Photos/2026`.
  - **Preserved UX.** File-path callers still use `dirname(filePath)`; batch folder affinity honors files inside the target branch folder.
  - **Steps.** Extract `getAffinityAccountsForDirectory(dirCounts, startDir)` and `findFolderAffinityAccountsForDirectory(startDir, poolId)`, delegate file-path helpers via `path.posix.dirname`, and call the directory helpers directly at lines 478-480.

- [x] **A-8 `[Warning]` Reject negative/`NaN` `sizeBytes` and 0-byte placements on over-limit accounts**
  - **Locations.** `src/server/storage/placement.ts:226, 248-250, 340, 422-426, 684-728`.
  - **Failure mode.** Negative `sizeBytes` passes `effectiveHeadroom >= sizeBytes` and adds simulated headroom; `NaN` evaluates `NaN > MAX_SINGLE_FILE_BYTES` as `false`; `0`-byte files pass `0 >= 0` even when an account is locked at/over its physical quota ceiling.
  - **Preserved UX.** Valid `0 <= sizeBytes <= MAX_SINGLE_FILE_BYTES` placements on accounts within limits stay identical.
  - **Steps.** Add `assertValidFileSize(sizeBytes)` rejecting `!Number.isFinite(sizeBytes) || sizeBytes < 0` and `sizeBytes > MAX_SINGLE_FILE_BYTES`, call it across placement entrypoints, and reject 0-byte writes when `account.quotaUsedBytes >= account.quotaLimitBytes` (or over usable buffer if locked).

- [x] **A-9 `[Warning]` Extract shared best-fit and candidate-commit helpers in `placement.ts`**
  - **Locations.** `src/server/storage/placement.ts:278-327`, `495-524`.
  - **Failure mode.** Duplicated headroom/budget subtraction and minimum-difference selection loops across `selectPlacementFromCandidates` and `simulateBatchPlacement`.
  - **Preserved UX.** Identical placement decisions and reasons.
  - **Steps.** Extract `pickBestFitCandidate` and `commitCandidateDecision` helpers inside `src/server/storage/placement.ts`.

- [x] **A-10 `[Warning]` Load `dotenv/config`, create `TSUBASA_DB_PATH` parent dir, and add graceful shutdown**
  - **Locations.** `src/server/index.ts:1-22`, `src/server/db/index.ts:7-14`.
  - **Failure mode.** `dotenv` is in `package.json` but never imported in `src/server/index.ts`; custom `TSUBASA_DB_PATH` directories are not created before `new Database(dbPath)`; no `SIGINT`/`SIGTERM` handler closes `server`, watchers, timers, or `sqlite.close()`.
  - **Preserved UX.** Default port `3000` and `./data/tsubasa.db` startup behavior remain unchanged.
  - **Steps.** Add `import 'dotenv/config';` as line 1 of `src/server/index.ts`; create `path.dirname(dbPath)` when `dbPath !== ':memory:'` in `src/server/db/index.ts`; add `SIGINT`/`SIGTERM` shutdown calling `authPool.stopWatching()`, outbox stop, `server.close()`, and `sqlite.close()`. *(Note: `stopOutboxWorker` wiring in `src/server/index.ts` awaits `outbox.ts` export in Slice C.)*

- [x] **A-11 `[Warning]` Align `tsconfig.server.json` paths and `schema.ts`/`init.ts` DDL contract**
  - **Locations.** `tsconfig.server.json:16-19`, `src/server/db/init.ts:11-139`, `src/server/db/schema.ts:4-129`, `drizzle.config.ts`.
  - **Failure mode.** `tsconfig.server.json` allows `@/*` aliases that `tsc` leaves un-rewritten in `dist/server/`. `init.ts` duplicates `schema.ts` DDL while `drizzle.config.ts` / `db:generate` / `db:migrate` are unused.
  - **Preserved UX.** Zero runtime behavior change.
  - **Steps.** Remove `@/*` `paths` from `tsconfig.server.json`. Add an explicit synchronization invariant comment linking `schema.ts` and `init.ts` (or migrate `init.ts` to generated Drizzle SQL if desired; do not alter table columns).

- [x] **A-12 `[Nit]` Document `index.html` anti-FOUC inline boot block**
  - **Locations.** `index.html:13-51`.
  - **Preserved UX.** Visual anti-FOUC boot styling stays untouched.
  - **Steps.** Add a brief comment explaining best-effort `localStorage` access on restricted origins and noting CSP hash/nonce requirements for inline boot code.

- [x] **A-13 `[Nit]` Hygiene cleanup in DB, storage, and `package.json`**
  - **Locations.** `tsubasa.db` (root 0-byte file), `src/server/storage/placement.ts:689, 715` (`freedBytesOnAccount`), `src/server/db/init.ts:117` & `schema.ts:61` (`files_pool_trashed_idx`), `src/server/db/schema.ts:131-150` (`ShareLink`/`NewShareLink`), `package.json:7, 9, 31` (`@stylexjs/rollup-plugin`, duplicate `dev`).
  - **Steps.** Remove unused `freedBytesOnAccount` param, drop redundant `files_pool_trashed_idx` with `CURRENT_SCHEMA_VERSION` bump, export `ShareLink`/`NewShareLink`, delete empty root `tsubasa.db`, and remove unused `@stylexjs/rollup-plugin` if `vite.config.ts` only uses `unplugin-stylex`.

---

### Slice B: Drive auth, client resilience, mirror, sync, and delta
**Files owned:** `src/server/drive/index.ts`, `src/server/drive/auth.ts`, `src/server/drive/client.ts`, `src/server/drive/mirror.ts`, `src/server/drive/sync.ts`, `src/server/drive/delta.ts`.

- [x] **B-1 `[Blocking]` Stop `resolveRemoteParentPath` and `inspectRemoteRootFolder` from swallowing non-404 errors**
  - **Locations.** `src/server/drive/client.ts:765-768`, `805-827`; `src/server/drive/delta.ts:173-201, 251-265`.
  - **Failure mode.** `resolveRemoteParentPath` catches all non-2xx errors and caches `{ isInsidePool: false }`, causing `delta.ts` to delete SQLite rows and clear `tsubasa_managed` on Drive during transient 5xx/429/401 errors. `inspectRemoteRootFolder` similarly masks transient errors in `switchAccountPool`.
  - **Preserved UX.** True `404` / `410` / `trashed` / out-of-root items still resolve identically.
  - **Steps.** Use `getDriveErrorStatus(err)` in both functions; return `isInsidePool: false` / `exists: false` only on `404` (or `410`), and rethrow all other errors so delta sync aborts cleanly and marks `syncState = 'error'`.

- [x] **B-2 `[Blocking]` Fix `mirror.ts` cache generation race and external folder deletion staleness**
  - **Locations.** `src/server/drive/mirror.ts:93-158`, `src/server/drive/delta.ts:126-160`.
  - **Failure mode.** `delta.ts` never evicts `remoteFolderCache` / `driveIdToPathCache` when a folder is removed or trashed, and `clearRemoteFolderCache` races with `inFlightFolderPromises` so settling promises re-insert stale folder IDs.
  - **Preserved UX.** Single-flight folder lookup and fast cache hits stay unchanged.
  - **Steps.** Add a per-`rootFolderId` generation counter in `mirror.ts` checked before caching `inFlightFolderPromises` results; export `evictRemoteFolderByDriveId` and call it from `delta.ts` on folder removal/trash; evict and retry from `rootFolderId` if `ensureRemoteFolderHierarchy` hits 404 on a cached parent.

- [x] **B-3 `[Blocking]` Settle all lanes in `runBoundedConcurrency` before throwing and deduplicate `runBoundedWorkers`**
  - **Locations.** `src/server/drive/client.ts:118-138`, `src/server/drive/index.ts:101-121, 133, 174`.
  - **Failure mode.** `Promise.all` rejects on the first lane failure while sibling workers continue mutating SQLite and Drive unawaited. `index.ts` also duplicates `runBoundedConcurrency` as `runBoundedWorkers`.
  - **Preserved UX.** Same concurrency limits and first-error rejection behavior.
  - **Steps.** In `runBoundedConcurrency`, record `firstError`, stop pulling new items once `firstError !== null`, `await Promise.allSettled(runners)`, then rethrow `firstError`. Delete `runBoundedWorkers` in `index.ts` and call `runBoundedConcurrency`.

- [x] **B-4 `[Blocking]` Fix `auth.ts` token write-queue leak, `handleCallback` race, `.tokens.json` removal, and `invalid_grant` tracking**
  - **Locations.** `src/server/drive/auth.ts:131-165, 192-200, 259-311, 435-513, 608-626`; `src/server/drive/index.ts:150-155, 196-201`.
  - **Failure mode.** `tokenWriteQueues` keys by `accountId` and leaks when `renameAccount` changes the key; `handleCallback` emits `'tokens'` before `renameAccount` completes, racing with `safeRenameFile`; `scan()` unlinks colliding `resolvedDest`, leaves stale in-memory tokens when `.tokens.json` is deleted, and throws uncaught in `startWatching()` timer; `invalid_grant` never sets `accounts.syncState = 'error'`.
  - **Preserved UX.** Email-based canonical account IDs and atomic `.tmp` writes stay unchanged.
  - **Steps.** Key `tokenWriteQueues` by `AccountAuthRecord` (`WeakMap` or `Map<AccountAuthRecord, Promise<void>>`), suppress `on('tokens')` during `handleCallback` until post-rename persist, clear tokens / `authorized = false` in `scan()` when `.tokens.json` vanishes, guard `startWatching()` timer with `try/catch`, prevent `safeRenameFile` from overwriting distinct non-empty credential files, and mark `syncState = 'error'` on `invalid_grant` / `401`.

- [x] **B-5 `[Warning]` Fix `ensureRootFolder` concurrency race, pagination, and `retargetRemoteRootFolder` trashed deletion**
  - **Locations.** `src/server/drive/client.ts:344-501, 785-803`.
  - **Failure mode.** Concurrent calls can create duplicate `_Tsubasa~ Pool <N>` folders; `ensureRootFolder` stops at `pageSize: 20`; `retargetRemoteRootFolder` permanently deletes subfolders that only hold trashed files (`trashed = false` check) and skips `clearRemoteFolderCache`.
  - **Preserved UX.** Empty pool folder retargeting and `tsubasa_root` metadata stay identical.
  - **Steps.** Add a single-flight map around `getAccountRootFolderId` / `ensureRootFolder`, paginate `ensureRootFolder` / `retargetRemoteRootFolder`, check all children (including trashed) in `checkRemoteRootFolderEmpty` or trash subfolders rather than hard-deleting, and clear `remoteFolderCache`.

- [x] **B-6 `[Warning]` Unify cold/delta sync single-flight locks and bound `Retry-After` in `withDriveRetry`**
  - **Locations.** `src/server/drive/client.ts:57-116, 892-901`, `src/server/drive/sync.ts:299-312`, `src/server/drive/delta.ts:30-64`, `src/server/drive/index.ts:34-72`.
  - **Failure mode.** Cold sync and delta sync can run concurrently on the same account; `syncAccountSingleFlight` does not re-check `expectedPoolId` after awaiting; uncapped `Retry-After` headers can hang requests for an hour (`3600s`); `switchAccountPool` ignores `dead` outbox entries.
  - **Preserved UX.** Same single-flight behavior for identical syncs and normal 1-30s retry delays.
  - **Steps.** Share a per-account sync lock between `runColdReconciliation` and `runIncrementalSync` (allowing internal `fallbackToColdSync`), re-verify `expectedPoolId` in `syncAccountSingleFlight`, clamp `retryAfterMs` (e.g. `<= 60_000` ms or fail fast above cap) with jitter on `0`, and reject `switchAccountPool` if `dead` outbox rows remain for that account.

- [x] **B-7 `[Blocking]` Enforce `MAX_SINGLE_FILE_BYTES`, path normalization, startToken check, and cache invalidation in `sync.ts` and `delta.ts`**
  - **Locations.** `src/server/drive/sync.ts:67-82, 329-387, 475-486`, `src/server/drive/delta.ts:137-168, 217-241`.
  - **Failure mode.** `sync.ts` and `delta.ts` index files `> 14.25 GB`, `sync.ts` skips `normalizeVirtualPath`, ignores empty `startToken`, and leaves `discrepancyCache` stale; `delta.ts` checks only `file.parents[0]` for folders, inflates `updatedCount` on unmanaged trashed files, and leaves `trashed_at` set when untrashed in Drive.
  - **Preserved UX.** Normal cold and delta sync results stay identical.
  - **Steps.** Skip indexing files `> MAX_SINGLE_FILE_BYTES` in `sync.ts` and `delta.ts` (leaving them for `detector.ts` over-ceiling inspection), call `normalizeVirtualPath` and `invalidateDiscrepancyCache(accountId)` in `sync.ts`, throw if `!startToken`, iterate `file.parents` for folders in `delta.ts`, increment `updatedCount` only when `trashFileStmt.run(...).changes > 0`, and clear `trashed_at` on untrash in `upsertFileStmt`.

- [x] **B-8 `[Warning]` Surface corrupt `.tokens.json`, invalid `.env` URLs, and watcher errors in `auth.ts`**
  - **Locations.** `src/server/drive/auth.ts:200, 376, 412, 727`.
  - **Failure mode.** Corrupt `.tokens.json` drops the credential from `authPool` instead of marking it unauthorized; `importCredentials` accepts malformed redirect URIs; watcher init failure is silent.
  - **Preserved UX.** Valid `.json` and `.env` imports work identically.
  - **Steps.** Isolate `.tokens.json` `JSON.parse` so corrupt tokens yield `authorized: false` with a warning; return `{ success: false, error }` on invalid `envRedirect`; log watcher errors via `console.warn`.

- [x] **B-9 `[Warning]` Deduplicate credential parsing and signature logic in `auth.ts`**
  - **Locations.** `src/server/drive/auth.ts:96-129`, `340-415`, `659-739`.
  - **Steps.** Extract `readTokenFile(baseName)`, `extractBaseName(filePath)`, and `buildSignature(...)` shared across sync/async signature refreshers and `.json`/`.env` parsers.

- [x] **B-10 `[Warning]` Share `CLEARED_TSUBASA_APP_PROPERTIES` and `clearOrphanAppProperties`**
  - **Locations.** `src/server/drive/client.ts`, `sync.ts:397-411`, `delta.ts:251-265`.
  - **Failure mode.** Inline literals omit `tsubasa_checksum` and duplicate concurrency loops.
  - **Steps.** Export `CLEARED_TSUBASA_APP_PROPERTIES` (clearing `tsubasa_managed`, `tsubasa_virtual_path`, `tsubasa_virtual_id`, `tsubasa_checksum`) and `clearOrphanAppProperties` from `client.ts` and reuse in `sync.ts`, `delta.ts`, and `detector.ts`. *(Note: `client.ts`, `sync.ts`, and `delta.ts` updated in Slice B; `detector.ts` reuse belongs to Slice C.)*

- [x] **B-11 `[Nit]` Remove dead `runColdReconciliation` import in `index.ts` and `ensureLocalFolderHierarchy` in `sync.ts`**
  - **Locations.** `src/server/drive/index.ts:6`, `src/server/drive/sync.ts:230-240`.
  - **Steps.** Delete both unused symbols after confirming zero callers via `rg`.

---

### Slice C: External detector, rebalance, outbox, and operations
**Files owned:** `src/server/drive/detector.ts`, `src/server/drive/rebalance.ts`, `src/server/drive/outbox.ts`, `src/server/drive/operations.ts`.

- [x] **C-1 `[Blocking]` Retry `pending_drive_sync` entries so failed `appProperties` stamps heal automatically**
  - **Locations.** `src/server/drive/detector.ts:131-168, 538-544, 635-700, 814-830`, `src/server/drive/sync.ts:435-447`, `src/server/drive/outbox.ts`.
  - **Failure mode.** Failed background `stampAcceptedAppProperties` calls set `next_retry_at` in `pending_drive_sync`, but no startup or periodic worker ever drains `pending_drive_sync`, permanently blocking cold-sync pruning and diverging Drive metadata.
  - **Preserved UX.** Immediate SQLite commit on external accept remains instant.
  - **Steps.** Drain `pending_drive_sync WHERE next_retry_at <= now` inside `startOutboxWorker()` (or migrate stamps into `drive_outbox`) and delete the `pending_drive_sync` row on Drive `404`.

- [x] **C-2 `[Blocking]` Block active-path overwrites and `> 14.25 GB` acceptance in `detector.ts`**
  - **Locations.** `src/server/drive/detector.ts:476-648, 730-833, 930-1399`.
  - **Failure mode.** `acceptExternalFile` / `acceptAllExternalFiles` silently overwrite active colliding files via `ON CONFLICT(pool_id, virtual_path) DO UPDATE`, stranding the old Drive file. They and conflict resolvers also lack the `MAX_SINGLE_FILE_BYTES` check.
  - **Preserved UX.** Updating an existing active file with matching `(account_id, drive_file_id)` works unchanged; over-ceiling files remain isolated in `overCeiling`.
  - **Steps.** Check for active path collisions with differing `(account_id, drive_file_id)` inside the commit transaction and abort with conflict error (HTTP 409); reject `sizeBytes > MAX_SINGLE_FILE_BYTES` with `FileExceedsCeilingError` (or per-item failure in batch mode).

- [x] **C-3 `[Warning]` Evict `driveFileParentsCache`, fix partial `cachedReport` clear, detect same-size hash edits, and guard `replace_existing` Drive trash**
  - **Locations.** `src/server/drive/detector.ts:105, 331, 409-423, 822-826, 995-1019, 1412-1446`.
  - **Failure mode.** `driveFileParentsCache` leaks memory; `acceptAllExternalFiles` wipes `cachedReport` even on subset `preScannedItems`; `scanAccountDiscrepancies` misses same-size hash modifications; `replace_existing` deletes the old SQLite row even if trashing the old Drive file fails, causing re-conflict on next cold sync.
  - **Preserved UX.** Conflict resolution flows and 30s cache TTL stay identical.
  - **Steps.** Clear `driveFileParentsCache` per `accountId` in `invalidateDiscrepancyCache`; filter only accepted `driveFileId`s in `acceptAllExternalFiles`; flag `'different'` checksums in `scanAccountDiscrepancies`; enqueue `file_trash` / unmark fallback in `drive_outbox` if `replace_existing` fails to update the old Drive file. Extract shared `commitIndexedFileTx` across the 6 duplicated commit blocks in `detector.ts`.

- [x] **C-4 `[Blocking]` Enforce per-target FIFO ordering and 404 no-op handling in `drive_outbox`**
  - **Locations.** `src/server/drive/outbox.ts:202-206, 410-437, 492-571, 602-708, 905-909`.
  - **Failure mode.** When an earlier op enters `failed` backoff (`next_retry_at > now`), `selectNextReadyForAccount` lets newer `pending` ops jump ahead (e.g. `file_delete` before `file_move`, `file_restore` before `file_trash`). `file_move` / `file_rename` / `file_restore` spin 8 times into `dead` on 404. `getPendingOutboxDriveIds` omits `folder_merge_account`, allowing sync to revert merged files.
  - **Preserved UX.** Instant SQLite mutations and background Drive sync behavior remain identical.
  - **Steps.** Block later ops targeting the same `drive_file_id` or overlapping folder paths while an earlier `failed` op is in backoff; treat `isDriveNotFoundError` (404) as completed in `file_move`, `file_rename`, and `file_restore`; fail-fast permanent 400/401/missing-auth errors; include `folder_merge_account` in `getPendingOutboxDriveIds`; extract shared `syncDescendantFolderAndFilePaths` between `folder_rename_account` and `folder_move_account`.

- [x] **C-5 `[Warning]` Restore remote parent folder on `file_restore` and report `dead` outbox / failed background jobs**
  - **Locations.** `src/server/drive/outbox.ts:283-295, 421-436, 549-571, 841-880, 998-1029`, `src/server/drive/transfer.ts:782-847`.
  - **Failure mode.** Restoring a file after `trashFolder` untracks `trashed: true` on the file only, leaving its Drive parent folder trashed so the next sync orphans it. `markDead` and failed `startBackgroundJob` jobs log nothing via `console.error`, and `drainOutboxForAccount` resolves silently when items become `dead`.
  - **Preserved UX.** Local Trash restore and background job polling interfaces stay identical.
  - **Steps.** Include `restoredPath` in `FileRestoreOutboxPayload`, call `ensureRemoteFolderHierarchy` and re-parent if needed in `file_restore`; log `console.error` on `dead` transitions and failed background jobs; make `drainOutboxForAccount` reject if any item for that account hit `dead`. *(Note: `outbox.ts` falls back to `files.virtual_path` when `restoredPath`/`newVirtualPath` is omitted; `transfer.ts` explicit `restoredPath` payload remains in Slice D.)*

- [x] **C-6 `[Blocking]` Disable account before `removeDriveAccount` evacuation and fix rebalance quota/error handling**
  - **Locations.** `src/server/drive/rebalance.ts:192-217, 256, 340-347, 594-619`, `src/server/db/schema.ts:52`.
  - **Failure mode.** `removeDriveAccount` evacuates before setting `isDisabled = true`, allowing concurrent uploads to land on the evacuating account and get cascade-deleted when `db.delete(accounts)` runs. `planAccountRebalance` hardcodes 750 MB instead of `calculateUsableLimit`; `rebalanceFilesBatch` fails to bump pool revision and swallows `isTrashed` preservation errors; `executeAutoRebalance` catches batch exceptions and returns empty/partial results without erroring.
  - **Preserved UX.** Evacuation flow and rebalance results shape stay unchanged.
  - **Steps.** Set `isDisabled = true` before `evacuateAccountFiles`, re-verify `COUNT(*) FROM files WHERE account_id = ?` in a transaction before `db.delete(accounts)`, call `bumpPoolRevision`, `invalidateDiscrepancyCache`, and `clearRemoteFolderCache` after delete, use `calculateUsableLimit`, enqueue `file_trash` if preserving `trashed: true` fails, and surface batch failures from `executeAutoRebalance`.

- [x] **C-7 `[Warning]` Consolidate `deleteDriveFileIgnoreNotFound` and enqueue delete fallback on rebalance cleanup failure**
  - **Locations.** `src/server/drive/transfer.ts:163-183`, `src/server/drive/outbox.ts:277-281, 450-466`, `src/server/drive/rebalance.ts:215-217`, `src/server/drive/client.ts`.
  - **Failure mode.** Two conflicting `deleteDriveFileIgnoreNotFound` helpers exist; `rebalance.ts:215` has a dead `.catch` and leaves `tsubasa_managed = 'true'` on source Drive files when delete fails.
  - **Steps.** Export `isDriveNotFoundError` from `client.ts`, consolidate `deleteDriveFileIgnoreNotFound` with `withDriveRetry` (rethrowing non-404), and enqueue a `file_delete` outbox item in `rebalanceFilesBatch` if immediate source deletion fails. *(Note: `outbox.ts` exports `deleteRemoteFileIgnoreNotFound` and `rebalance.ts` uses it; duplicate `deleteDriveFileIgnoreNotFound` cleanup in `transfer.ts` belongs to Slice D.)*

- [x] **C-8 `[Blocking]` Preserve trashed children during `folder_merge_account` and prevent remote folder deletion data loss**
  - **Locations.** `src/server/drive/operations.ts:832-833, 1053-1070`, `src/server/drive/outbox.ts:750-771`.
  - **Failure mode.** `folder_merge_account` ignores trashed files, deletes the SQLite source folder (setting `folder_id = NULL`), and checks `trashed = false` in `outbox.ts:759` before calling `drive.files.delete` on the source folder, permanently destroying trashed Drive items inside it.
  - **Preserved UX.** Active folder merge and empty folder pruning remain identical.
  - **Steps.** Move trashed descendant files under the merged destination folder (matching non-merge folder moves) and drop `and trashed = false` in `outbox.ts:759` (or trash rather than permanently delete non-empty source folders).

- [x] **C-9 `[Blocking]` Fix `moveItems` same-named folder collisions and trashed-file `UNIQUE` crashes on folder move/rename**
  - **Locations.** `src/server/drive/operations.ts:752-783, 982-989, 1828-1834`.
  - **Failure mode.** Moving two same-named folders registers only the first folder's root path, causing unhandled `SQLITE_CONSTRAINT_UNIQUE` (HTTP 500) on colliding descendants instead of `MoveConflictError` (409). Folder move and folder rename also update descendant file paths without calling `displaceTrashedFileAtPath` first.
  - **Preserved UX.** Conflict modal flow and folder move/rename UX stay identical.
  - **Steps.** Register mapped descendant folder and file paths in `claimedFolderPaths` / `claimedFilePaths` / `claimedSourceByPath` during non-merge folder planning, and call `stmts.displaceTrashedFileAtPath` before `updateDescendantFilePath` at lines 988 and 1834.

- [x] **C-10 `[Warning]` Guard `ensureLocalFolderPath` against active file collisions in `moveItems` and `copyItems`**
  - **Locations.** `src/server/drive/operations.ts:351, 914, 1200-1203`.
  - **Failure mode.** Moving or copying into a `destFolder` whose path (or ancestor) is occupied by an active file creates a `folders` row colliding with a `files` row.
  - **Steps.** Check for active files at `destFolder` and its ancestors before `ensureLocalFolderPath` and throw `ItemConflictError` (`409`) if present.

- [x] **C-11 `[Warning]` Remove outer `withDriveRetry` around `copyDriveFileCrossAccount` in `copyItems`**
  - **Locations.** `src/server/drive/operations.ts:1571-1587`.
  - **Steps.** Call `copyDriveFileCrossAccount` directly (it already wraps internal Drive calls with `withDriveRetry`).

- [x] **C-12 `[Warning]` Extract shared helpers in `operations.ts` and `mirror.ts`**
  - **Locations.** `src/server/drive/operations.ts:1004-1085, 1114-1150, 1848-1917`, `src/server/drive/detector.ts:1079-1095`.
  - **Steps.** Extract `enqueuePoolAccountOutbox` in `operations.ts` (replacing 4 repeated fanout loops) and share `formatCopyCandidateName(baseName, counter)` between `getAvailableCopyPath` and `reserveAvailableCopyPath`.

- [x] **C-13 `[Nit]` Dead code cleanup in `detector.ts` and `operations.ts`**
  - **Locations.** `src/server/drive/detector.ts:491`, `src/server/drive/operations.ts:4, 1320`, `src/server/drive/outbox.ts:1031`.
  - **Steps.** Simplify identical ternary in `detector.ts:491`, remove unused `accounts` import in `operations.ts:4`, reuse cached file lookups in `copyItems` lines 1319/1365, and remove or wire `getBackgroundJob` (`outbox.ts:1031`).

---

### Slice D: Streaming transfers, sharing, and Hono API routes
**Files owned:** `src/server/drive/transfer.ts`, `src/server/drive/share.ts`, `src/server/app.ts` (plus `src/server/drive/outbox.ts` `ClearShareAccountOutboxPayload` scoping for `D-6`).

- [x] **D-1 `[Blocking]` Enforce `actualBytes <= target.sizeBytes` inside upload stream to uphold `< 50 MB` RAM ceiling**
  - **Locations.** `src/server/drive/transfer.ts:420-465`, `src/server/app.ts:1461`.
  - **Failure mode.** Understating `?sizeBytes` (`<= 5 MB`) enters the buffered multipart branch (`readStreamToBuffer`) where `countingStream` allows up to 14.25 GB in heap RAM and bypasses placement/24h quota checks.
  - **Preserved UX.** Accurate uploads behave identically; mismatched streams fail fast with a 400 error.
  - **Steps.** Abort `countingStream` immediately when `actualBytes > target.sizeBytes`, reject non-empty bodies when `target.sizeBytes === 0`, and verify `actualBytes === target.sizeBytes` before SQLite commit.

- [x] **D-2 `[Blocking]` Wire `reserveAccountCapacity` and lock concurrent `conflictMode='reject'` uploads in `transfer.ts`**
  - **Locations.** `src/server/drive/transfer.ts:187, 251-306, 538-555, 602` (depends on `A-6`).
  - **Failure mode.** Parallel uploads race on headroom/24h quota (`A-6`) and on `inFlightUploadPaths` (`Set` allows two simultaneous `reject` uploads to the same path, overwriting and deleting the first). `conflictMode='replace'` also leaves `oldActiveRow.id` mismatched with Drive `tsubasa_virtual_id`.
  - **Preserved UX.** Concurrent uploads to distinct paths continue running in parallel; conflicts still return `409 ITEM_EXISTS`.
  - **Steps.** Reserve account capacity in `prepareUploadTarget` and release in `executeStreamingUpload`'s `finally` after SQLite commit; change `inFlightUploadPaths` to a token `Map<string, string>` and throw `UploadConflictError` when `conflictMode === 'reject'` collides with an active key; align `tsubasa_virtual_id` on `replace`.

- [x] **D-3 `[Blocking]` Enforce Share Pool read-only check after resolving `poolId` from `targetAccountId`**
  - **Locations.** `src/server/app.ts:1439`, `src/server/drive/transfer.ts:243-282`.
  - **Failure mode.** `/api/files/upload/session` checks `payload.poolId ?? 1` before `prepareUploadTarget` overrides `poolId` from `accRow.poolId`, allowing uploads into Share Pool `1_000_000`.
  - **Preserved UX.** Standard-pool uploads with or without `targetAccountId` behave identically.
  - **Steps.** Check `if (isSharePoolId(poolId))` right after resolving `accRow.poolId` in `prepareUploadTarget`, throw a 403-mapped `SharePoolReadOnlyError`, and pass resolved `poolId` to `validateTargetPlacement`.

- [x] **D-4 `[Warning]` Transactional `transfer_logs`, download error mapping, Trash TOCTOU, and `permissions.delete` await**
  - **Locations.** `src/server/drive/transfer.ts:149-160, 237, 314, 466-590, 630-658, 720-941`; `src/server/drive/share.ts:1094-1102`; `src/server/app.ts:1460, 1488-1491, 1564-1569`.
  - **Failure mode.** `transfer_logs` writes outside tx in `transfer.ts` and `share.ts`; `GET /api/files/:id/download` turns 401/403/500 into `404`; `emptyTrash`/trash/restore/purge read rows before `sqlite.transaction(...).immediate()`; `copyDriveFileCrossAccount` leaves `permissions.delete` unawaited in `finally`; aborted resumable uploads omit transferred bytes from `transfer_logs`; upload path lacks `/` and segment `validateItemName` guards.
  - **Preserved UX.** Same status codes (`404` missing file, `416` bad range) and streaming behavior.
  - **Steps.** Use `recordTransferSync` (`A-5`) inside SQLite transactions; throw `ItemNotFoundError` on missing download file (`404`) and map upstream errors to `502`/`500` (preserving `401`/`403`); re-read/verify row state inside `sqlite.transaction` in Trash ops; `await` `permissions.delete` (with non-masking `.catch`) in `finally`; best-effort log aborted resumable bytes; require `Number.isSafeInteger(sizeBytes) && sizeBytes >= 0`, reject `virtualPath === '/'`, and validate segments in `prepareUploadTarget`.

- [x] **D-5 `[Blocking]` Add `Cache-Control: no-transform` to `GET /api/files/:id/download`**
  - **Locations.** `src/server/app.ts:288`, `src/server/app.ts:1550-1563`.
  - **Failure mode.** Global `compress()` compresses `200` `.txt`/`.json`/`.csv`/`.svg` downloads and strips `Content-Length`.
  - **Preserved UX.** JSON API compression and download headers (`Accept-Ranges`, `Content-Disposition`, `200`/`206`) remain intact.
  - **Steps.** Set `'Cache-Control': 'no-cache, no-transform'` at `src/server/app.ts:1555`.

- [x] **D-6 `[Blocking]` Fix `clear_share_account` vs `executeShare` race and `share.ts` silent/orphan failures**
  - **Locations.** `src/server/drive/share.ts:266-282, 850-1094, 1117-1202`; `src/server/drive/outbox.ts:799-838`.
  - **Failure mode.** `clear_share_account` deletes every child of `rootFolderId`, wiping a subsequent `executeShare` batch created before the outbox drains. `clearSharePool` drops unauthorized accounts silently with `warnings: []`. `executeShare` can collide on concurrent `batchFolderName`, leave orphaned Drive files on mid-share failure, and skip `share_links` when `webViewLink` is absent.
  - **Preserved UX.** `ClearSharePoolResult` already includes `warnings: string[]`; `ExecuteShareResult` shape stays identical.
  - **Steps.** Scope `ClearShareAccountOutboxPayload` to specific `batchFolderIds`/`batchFolderNames` (or drain pending `clear_share_account` before `executeShare`); push warnings for skipped unauthorized Share Pool accounts; reserve `batchFolderName` in-memory; clean up created Drive batch folders on mid-share error; fall back to `https://drive.google.com/drive/folders/${batchFolderId}` if `webViewLink` is missing.

- [x] **D-7 `[Blocking]` Reject root `/` on `DELETE /api/folders` and tighten `app.ts` input/concurrency guards**
  - **Locations.** `src/server/app.ts:493-505, 789-807, 881-892, 1116-1314, 2014-2031`.
  - **Failure mode.** `DELETE /api/folders?virtualPath=/` wipes the entire pool; `?id=...` builds `/1:/Docs` without looking up folder path; `POST /api/pools` races `MAX(id) + 1`; `DELETE /api/accounts/:id` skips pool capacity/quota pre-check and allows duplicate concurrent `account_evacuate` jobs; `POST /api/accounts/oauth/import` returns `201` even if `hydrateAccount` fails; `POST /api/folders` ignores `name` vs `basename(path)` mismatch; `/api/items/move`, `/api/items/copy`, and `/api/sync/rebalance/batch` lack item-element validation and SQL `IN` chunking.
  - **Preserved UX.** Valid inputs keep identical payloads and HTTP responses.
  - **Steps.** Normalize path (resolving `?id` from `folders`) and return `400` on `'/'` in `DELETE /api/folders`; wrap `POST /api/pools` ID allocation in `sqlite.transaction(...).immediate()`; verify remaining pool headroom + 24h budget and deduplicate active evacuation jobs in `DELETE /api/accounts/:id`; propagate `hydrateAccount` failure in `oauth/import`; validate array elements and chunk `rebalance/batch` SQL queries.

- [x] **D-8 `[Warning]` Deduplicate `parseStrictPoolId`, `conflictMode`, ETag checks, and error mapping in `app.ts`**
  - **Locations.** `src/server/app.ts:85, 664-2210`.
  - **Steps.** Use `parseStrictPoolId` at lines `834` and `2194`, and extract `parseConflictMode`, `checkPoolEtag`, and `mapDomainErrorToResponse` while preserving exact JSON `{ error, code }` payloads.

- [x] **D-9 `[Nit]` Clean up dead code and document intentional async OAuth counters in `app.ts`**
  - **Locations.** `src/server/app.ts:7-8, 761-763, 879-880, 937, 1324-1326, 1387-1458`.
  - **Steps.** Remove unused `pools`, `asc`, `sql` imports and unreachable `InsufficientStorageError` checks (`761`, `1324`); add brief comments at `879` and `937` explaining why `filesIndexed` / `conflictsCount` return `0` (async cold sync); verify whether `/api/files/upload/session` (`1387-1458`) should be removed or explicitly documented as unmounted/internal.

---

### Slice E: Client boot, tab lock, query cache, hashing, and StyleX tokens
**Files owned:** `src/client/main.tsx`, `src/client/api.ts`, `src/client/global.css`, `src/client/tokens.stylex.ts`, `src/client/vite-env.d.ts`, `src/client/utils/fileHash.ts`, `src/client/utils/format.ts`, `src/client/utils/queryCache.ts`, `src/client/utils/useBeforeUnload.ts`, `src/client/utils/useTabLock.ts`, `src/client/utils/virtualPath.ts` (plus creating `src/client/utils/theme.ts`; coordinate theme/helper adoption in `App.tsx` with Slice F).

- [ ] **E-1 `[Blocking]` Defer `useTabLock` `'active'` state until `/api/instance/claim` settles**
  - **Locations.** `src/client/utils/useTabLock.ts:185-202, 322-405, 475-487`.
  - **Failure mode.** Both Web Locks and fallback paths publish `status: 'active'` synchronously before `/api/instance/claim` finishes, mounting `<App />` and firing API requests even when Electron or another tab owns the lease; non-409 HTTP errors from `claim.$post` are ignored.
  - **Preserved UX.** `<CheckingShell />` stays up during lease check; `<TabBlockedModal>` shows on 409; offline fallback keeps working on network failure.
  - **Steps.** Remove premature `publishState(..., { status: 'active', ... })` at lines 381 and 403, guard `isUnloading`, and handle non-409 `!res.ok` errors in `activateWithServerLease`. Document intentional `sendBeacon` / `keepalive` usage at line 185 (or use `client.api.instance.release.$url()`). Remove unused `singleton.teardown`.

- [ ] **E-2 `[Warning]` Decouple `AbortSignal` per subscriber in `queryCache.ts` `dedupeInFlight`**
  - **Locations.** `src/client/utils/queryCache.ts:237-278`.
  - **Failure mode.** Joining callers share the initiator's `AbortSignal`-bound fetch; aborting caller 1 aborts caller 2 and leaves `loadFiles` stuck if caller 2 handles `isAbortError`.
  - **Preserved UX.** Identical single-request deduplication and caller-specific cancellation.
  - **Steps.** Use an internal `AbortController` inside `dedupeInFlight` keyed by `key`, track active subscriber count/listeners, reject only the aborted caller immediately, and abort the underlying `fetch` only when all subscribers abort.

- [ ] **E-3 `[Warning]` Prevent main-thread freeze and check post-digest abort in `fileHash.ts`**
  - **Locations.** `src/client/utils/fileHash.ts:294-321`.
  - **Failure mode.** Files `> 32 MB` run pure-JS MD5/SHA-256 chunks synchronously without yielding when frames exceed 50 ms; `<= 32 MB` `crypto.subtle.digest` misses a post-`await` `signal?.aborted` check.
  - **Preserved UX.** Identical digest outputs, `AbortError` contract, and conflict match semantics.
  - **Steps.** Check `if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');` after `crypto.subtle.digest`; yield via `yieldToMain()` whenever chunk loop elapsed time exceeds 50 ms.

- [ ] **E-4 `[Nit]` Guard `formatBytes` non-finite inputs and remove dead `useDialogLock`**
  - **Locations.** `src/client/utils/format.ts:1-7`, `src/client/utils/useBeforeUnload.ts:19-39`.
  - **Steps.** Return `'0 B'` for `!Number.isFinite(bytes) || bytes === 0` and clamp `sizes` index; remove dead `useDialogLock` export.

- [ ] **E-5 `[Warning]` Extract shared `src/client/utils/theme.ts` from `main.tsx` (and `App.tsx`)**
  - **Locations.** `src/client/main.tsx:15-38`, `src/client/App.tsx:368-430`.
  - **Steps.** Move `readInitialTheme`, `readThemeChoice`, and `applyDocumentTheme` into `src/client/utils/theme.ts` and call from `main.tsx` (and `App.tsx` in Slice F).

- [ ] **E-6 `[Warning]` Align `tokens.stylex.ts` contrast comments, add missing tokens, and clean unused token**
  - **Locations.** `src/client/tokens.stylex.ts:8, 32, 50-51, 60-61, 79, 109, 156`.
  - **Preserved UX.** Do not alter any color values or rendered pixels.
  - **Steps.** Update comments in `tokens.stylex.ts` to accurately describe 7:1 AAA primary text vs intentional >= 5.5:1 hover/`surfaceElevated`/`surfaceAlt` badge pairings; add tokens needed by Slice G/H (`drawerWidth`, `accentGoldMarqueeBg`, `accentGoldDropBg`, `drawerHeaderHeight` / `lineHeightBody` / `fontWeightTitle` mappings) without changing resolved CSS values; remove unused `layout.sidebarCollapsedWidth`.

- [ ] **E-7 `[Warning]` Replace repeated scrollbar hex literals in `global.css`**
  - **Locations.** `src/client/global.css:83-110`.
  - **Steps.** Define `--scrollbar-thumb` and `--scrollbar-thumb-hover` CSS variables in `global.css` with exact current light/dark hex values.

- [ ] **E-8 `[Nit]` Clean unused types in `api.ts` and type `webkitdirectory` + drop markers cleanly**
  - **Locations.** `src/client/api.ts:6, 9, 11, 13-14`, `src/client/vite-env.d.ts`, `src/client/utils/virtualPath.ts`.
  - **Steps.** Remove unused `FilesResponse`, `FoldersResponse`, `Folder`, `PoolsResponse`, `PoolRecord` from `api.ts`; augment `React.InputHTMLAttributes<HTMLInputElement>` for `webkitdirectory`/`directory` in `vite-env.d.ts`; export `markDropHandled` / `isDropHandled` (`WeakSet<Event>`) in `virtualPath.ts`.

---

### Slice F: `App.tsx` orchestration, cross-pool safety, and shell components
**Files owned:** `src/client/App.tsx`, `src/client/components/Header.tsx`, `src/client/components/Sidebar.tsx`, `src/client/components/ActionPortal.tsx`, `src/client/components/AccountAvatar.tsx`, `src/client/components/Icons.tsx` (run before Slice H if parallelizing, since Slice H also updates modal wiring in `App.tsx`).

- [ ] **F-1 `[Blocking]` Guard all async reads and optimistic rollbacks in `App.tsx` with `activePoolIdRef.current === poolId`**
  - **Locations.** `src/client/App.tsx:914-1149, 1542-1570, 1779-2251, 2498-2533, 2738-2767, 2876-2908, 3085-3135, 3186-3231`.
  - **Failure mode.** Switching pools mid-request allows settling reads or rollbacks from the old pool to abort the active pool's fetches and overwrite `files`, `folders`, `trashedFiles`, `storage`, `discovered`, `selectedIds`, or navigation with the old pool's data.
  - **Preserved UX.** Instant pool switching and SWR cache hydration stay identical.
  - **Steps.** In `loadClusterData`, `loadFiles`, and `loadTrashFiles`, only abort controllers and update React state when `activePoolIdRef.current === reqPoolId` (still update `setPoolCache(reqPoolId, ...)` for background pools). In every mutation handler, guard state rollbacks and navigation with `activePoolIdRef.current === poolId` and update `setPoolCache(poolId, ...)` when off-pool.

- [ ] **F-2 `[Blocking]` Prevent `filteredAccountIds` pruning from wiping `sessionStorage` before `loadFiles` finishes**
  - **Locations.** `src/client/App.tsx:527-559, 639-651`.
  - **Failure mode.** On initial mount `files` is `[]`, so the pruning effect removes all `filteredAccountIds` and deletes `tsubasa-filtered-account-ids` from `sessionStorage` before `/api/files` returns.
  - **Preserved UX.** Filters still clear automatically when the loaded pool genuinely has zero active files for a filtered account.
  - **Steps.** Guard `if (loadedFilesPoolId !== activePoolId) return;` at line 639 and add `loadedFilesPoolId` and `activePoolId` to the effect deps.

- [ ] **F-3 `[Blocking]` Surface silent `reportDevError` / `!res.ok` failures across account, pool, OAuth, and sync actions**
  - **Locations.** `src/client/App.tsx:1481-1570, 2910-2952, 3015-3135, 3186-3231`.
  - **Failure mode.** `handleImportOAuth`, `handleSyncAll`, `handleDisableAccount`, `handleEnableAccount`, `handleCreatePool`, `handleDeletePool`, `handleSwitchAccountPool`, and `handleClearSharePoolConfirm` swallow failures via `reportDevError` (no-op in production) or omit the `!res.ok` branch (`handleSyncAll`).
  - **Preserved UX.** Errors appear exclusively in the existing inline `workspaceError` banner (or modal banner for modal actions in Slice H).
  - **Steps.** Clear `setWorkspaceError(null)` at entry, parse server `{ error }` JSON on `!res.ok`, and replace `reportDevError` with `surfaceWorkspaceError` (rethrow in modal-backed handlers per Slice H).

- [ ] **F-4 `[Blocking]` Reset `storage`/`discovered` and abort in-flight requests in `clearWorkspaceState`**
  - **Locations.** `src/client/App.tsx:1182-1201, 1249-1251, 3171-3184`.
  - **Failure mode.** Switching to an uncached pool or completing a Share batch leaves the prior pool's Sidebar accounts/meters rendered and allows in-flight `loadTrashFiles` / `loadFiles` / `loadClusterData` requests to settle onto stale state.
  - **Preserved UX.** Cached pools still hydrate immediately from `getPoolCache`.
  - **Steps.** In `clearWorkspaceState`, abort `clusterAbortRef`, `discrepancyAbortRef`, `filesAbortRef`, and `trashAbortRef`, increment `filesRequestSeqRef` and `trashRequestSeqRef`, and call `setStorage(null)` and `setDiscovered([])`.

- [ ] **F-5 `[Warning]` Surface read failures in `loadClusterData`, `loadFiles`, `loadTrashFiles`, and `share.links`**
  - **Locations.** `src/client/App.tsx:945-950, 1022-1029, 1079-1081, 1119, 1137`.
  - **Failure mode.** Non-OK 5xx/4xx responses silently render empty tables/trash or drop share copy actions.
  - **Preserved UX.** Aborted fetches stay silent; genuine empty folders render unchanged.
  - **Steps.** On non-aborted `!res.ok` responses, extract error text and call `surfaceWorkspaceError`.

- [ ] **F-6 `[Warning]` Protect single-item mutations (`runPendingOp`, ID-scoped rollback), `handleTrashItems`, `handleMoveItems`, `handleRename`, and `transferringFileIds`**
  - **Locations.** `src/client/App.tsx:1657-1713, 1779-1898, 2005-2096, 2140-2251, 2339-2496, 2851-2874`.
  - **Failure mode.** Single-item mutations skip `runPendingOp` (missing `beforeunload` protection and racing focus-refresh) and roll back stale `prevFiles`/`prevTrashed` snapshots across rapid clicks; `handleTrashItems` discards server error JSON; `handleMoveItems` rolls back `clipboard` on partial batch success; `handleRename` ignores Trash view refresh and navigates/selects even if path changed; single `transferringFileId` clears early on concurrent file transfers.
  - **Preserved UX.** Instant optimistic updates and existing inline banners stay identical.
  - **Steps.** Wrap single-item mutations and `handleTransferFile` in `runPendingOp`; restore only the failed item by ID via functional state updaters; surface `handleTrashItems` server error messages; apply `applyMoveResultsToClipboard` when any item in a batch succeeded; refresh `loadTrashFiles` when renaming in Trash and guard `setSelectedIds`/`setScrollRequest` on current path/pool; replace single `transferringFileId` state with a `Set<string>` passed to `FileTable` (`G-5`).

- [ ] **F-7 `[Warning]` Unify `handlePopState` / `handleMouseUp` modal locks and wrap storage/drop errors**
  - **Locations.** `src/client/App.tsx:370-618, 750-786, 1425-1449, 1599-1641`.
  - **Failure mode.** Unhandled `localStorage` / `sessionStorage` calls can throw in restricted origins; `handlePopState` and `handleMouseUp` omit `moveFilesModalGroup`, `pendingMoveConflict`, and `isResolvingMoveConflict`; `extractDataTransferEntries` rejections are unhandled.
  - **Preserved UX.** Identical persistence keys and navigation behavior.
  - **Steps.** Wrap storage calls in `try/catch` (`safeStorageGet`/`safeStorageSet`), use `isModalActive()` in `handleMouseUp`, include `isResolvingMoveConflict` and reset all open non-busy modals in `handlePopState`, and wrap `extractDataTransferEntries` in `try/catch` calling `surfaceWorkspaceError`.

- [ ] **F-8 `[Warning]` Fix `Sidebar.tsx` clipboard false-positive, timeout leak, and stuck `"Generating authorize link..."`**
  - **Locations.** `src/client/components/Sidebar.tsx:1234-1283, 1662`.
  - **Failure mode.** `handleCopyAuthUrl` sets `"Copied"` even when `copyTextToClipboard` returns `false`, leaks overlapping `setTimeout`s, and leaves the button stuck on `"Generating authorize link..."` if the auth-url request fails.
  - **Preserved UX.** Uses existing inline button label swap (no toast/popup).
  - **Steps.** Check `if (!copied) return;` before setting `copiedId`, clear timer ref on re-click/unmount, and render an inline retry label (e.g. `"Authorize link unavailable (click to retry)"`) on fetch failure.

- [ ] **F-9 `[Warning]` Reset `AccountAvatar` `imgError` on `avatarUrl` change and catch `ActionPortal` copy errors**
  - **Locations.** `src/client/components/AccountAvatar.tsx:115-140`, `src/client/components/ActionPortal.tsx:806-811`.
  - **Steps.** Add `useEffect(() => setImgError(false), [avatarUrl])` (or `key={avatarUrl}`) in `AccountAvatar`; wrap `await onCopy()` in `try/catch` in `ActionPortal`.

- [ ] **F-10 `[Warning]` Check `window.open` popup block on download in `App.tsx`**
  - **Locations.** `src/client/App.tsx:1715-1717`.
  - **Failure mode.** Blocked `_blank` popups return `null` silently with zero user feedback.
  - **Preserved UX.** Normal direct streaming downloads remain zero-copy without extra preflight requests.
  - **Steps.** Check `const win = window.open(url, '_blank')`; if `!win`, fall back to a programmatic `<a href={url} download>` click or call `surfaceWorkspaceError` if blocked.

- [ ] **F-11 `[Warning]` Adopt `theme.ts`, `virtualPath.ts`, and `dropHandled` helpers in `App.tsx`**
  - **Locations.** `src/client/App.tsx:209-215, 368-430, 1632, 1662-2449`, `ActionPortal.tsx:921, 1309`, `Sidebar.tsx:1457, 1498`.
  - **Steps.** Replace duplicated theme/path helpers and `as any` casts with `theme.ts`, `getParentDir`/`normalizeVirtualPath`, and `markDropHandled`/`isDropHandled` (`E-5`, `E-8`).

- [ ] **F-12 `[Warning]` Clean up `Sidebar.tsx` / `AccountAvatar.tsx` helpers, inline styles, and unused `totalLimitBytes`**
  - **Locations.** `src/client/components/Sidebar.tsx:72, 1061-1129, 1726, 1819`, `AccountAvatar.tsx:145`, `App.tsx:3515`.
  - **Steps.** Import `DAILY_UPLOAD_LIMIT_BYTES` and `formatGbCompact` from `accountTransfer.ts`; convert progress scale and avatar hue inline `style` props to StyleX dynamic style rules (or add an intentional dynamic-value comment); remove unused `totalLimitBytes` prop.

- [ ] **F-13 `[Nit]` Accessibility and dead-icon hygiene in `Header.tsx` and `Icons.tsx`**
  - **Locations.** `src/client/components/Header.tsx:282-288`, `src/client/components/Icons.tsx:118-124`.
  - **Steps.** Add `aria-label="Search pooled files and directories"` on Header search input and remove unused `IconChevronLeft`.

---

### Slice G: Virtualized file table and drawers
**Files owned:** `src/client/components/FileTable.tsx`, `src/client/components/UploadDrawer.tsx`, `src/client/components/ExternalChangesDrawer.tsx`, `src/client/components/DrawerPrimitives.tsx`.

- [ ] **G-1 `[Blocking]` Allow external OS file drops over `MemoFileRow` in `FileTable.tsx`**
  - **Locations.** `src/client/components/FileTable.tsx:1396-1412`.
  - **Failure mode.** `MemoFileRow.onDragOver` / `onDrop` sets `dropEffect = 'none'` and marks drops handled without checking `isInternalItemDrag(e)`. Whenever files fill the viewport above `emptyDropZone`, external OS drops over rows silently fail.
  - **Preserved UX.** Internal item drags over file rows keep `dropEffect = 'none'`; folder rows, Trash, and Share Pool behavior stay identical.
  - **Steps.** Add `if (!isInternalItemDrag(e)) return;` in `MemoFileRow.onDragOver` and `MemoFileRow.onDrop` (after the `isTrashView || isSharePoolActive` check) so external drags bubble to `scrollViewport` and `App.tsx`.

- [ ] **G-2 `[Blocking]` Enable empty-folder-only uploads and surface folder creation errors in `UploadDrawer.tsx`**
  - **Locations.** `src/client/components/UploadDrawer.tsx:1610, 1617-1631, 1837, 2255-2260`.
  - **Failure mode.** Dropping empty folders with `stagedFiles = []` leaves "Start upload" permanently disabled; `runUploadQueue` also ignores `!res.ok` / thrown errors from `client.api.folders.$post` while incrementing `succeededCount`.
  - **Preserved UX.** Empty folder cards and upload controls stay visually unchanged; "Start upload" enables when actionable files or pending empty folders exist.
  - **Steps.** Include `hasPendingEmptyFolders` in `startUploadDisabled`, `handleStartUpload`, and `runUploadQueue`; check `res.ok || res.status === 409` on folder creation and surface failures inline via `setPlanError`.

- [ ] **G-3 `[Blocking]` Render backend upload errors inline in `UploadFileCard` instead of hover-only `title`**
  - **Locations.** `src/client/components/UploadDrawer.tsx:835-853`.
  - **Failure mode.** Failed uploads store `progress.error` only in `title={progress.error}`, invisible on touchscreens and keyboard focus.
  - **Preserved UX.** Failed badge stays unchanged; error text renders inline only on non-cancelled errors using existing `styles.fileCeilingWarning` styling.
  - **Steps.** Render `progress.error` inside `styles.fileCeilingWarning` below the card header when `!isRejected && progress?.status === 'error' && progress.error && progress.error !== 'Cancelled'`.

- [ ] **G-4 `[Blocking]` Wrap `runUploadQueue` / `xhr.send` in `try/finally` and handle abort during `createEmptyFolders`**
  - **Locations.** `src/client/components/UploadDrawer.tsx:1608-1821, 1846-1863`.
  - **Failure mode.** Synchronous `xhr.send` errors or rejected `onUploadComplete()` leave `isUploading = true`, permanently locking the drawer (`closedby="none"`). Aborting while `createEmptyFolders` awaits leaves queued items stuck in `'pending'`.
  - **Preserved UX.** Normal upload, cancel, and retry behavior stay identical.
  - **Steps.** Wrap `runUploadQueue` in `try { ... } finally { xhrMapRef.current.clear(); setIsUploading(false); }`; wrap `xhr.open`/`setRequestHeader`/`send` in `try/catch`; mark `itemsToUpload` `'Cancelled'` if `abortedRef.current` is set after `createEmptyFolders`.

- [ ] **G-5 `[Warning]` Fix `FileTable.tsx` missing account `<option>`, `transferringFileIds`, `readEntries` error swallowing, and marquee listener leaks**
  - **Locations.** `src/client/components/FileTable.tsx:80, 777-820, 1452-1486, 1657-1663, 2097-2276, 3012`.
  - **Failure mode.** Missing `file.accountId` in `accounts` misattributes the row to `accounts[0]`; single `transferringFileId` re-enables concurrent transfers prematurely; `dirReader.readEntries` errors silently register empty folders; `rawFiles.find` matches nested files by bare name; marquee drag leaks `window` listeners on unmount/blur and has a `rawEnd` boundary off-by-one.
  - **Preserved UX.** Table rows, marquee box, and inline transfer selects look and behave identically.
  - **Steps.** Render fallback `<option value={file.accountId}>` when missing from `accounts`; support `transferringFileIds?: ReadonlySet<string>`; skip `resultEmptyFolders.push` on `readEntries` error and restrict `rawFiles.find` to root entries; clean up marquee listeners on blur/unmount and fix `rawEnd = height > 0 ? Math.floor((top + height - 1) / rowHeight) : rawStart`.

- [ ] **G-6 `[Warning]` Cache verified hashes, honor Replace `freedBytes`, and add placement retry in `UploadDrawer.tsx`**
  - **Locations.** `src/client/components/UploadDrawer.tsx:877, 912-919, 1410, 1430-1585, 2335, 2456-2460`.
  - **Failure mode.** Clicking any conflict button replaces `conflictsByPath` and restarts SHA-256/MD5 hashing from byte 0 for all conflicting files; Replace buttons and drive `<select>` ignore `freedBytes` of the file being replaced; failed `placement.batch` requests disable "Start upload" with no retry button.
  - **Preserved UX.** Keep existing `planErrorBanner` and conflict cards; add `"Retry allocation"` inside `planErrorBanner` only when `planError && !isPlanning`.
  - **Steps.** Memoize verified hashes in a `Map<string, UploadContentMatchStatus>` ref keyed by `${item.key}::${existing.id}::${existing.hash ?? ''}`; pass `freedBytes` for Replace options in `canHoldFile` and `UploadFileCard`; add a `planAttempt` retry trigger inside `planErrorBanner`.

- [ ] **G-7 `[Warning]` Virtualize `ExternalChangesDrawer` discrepancy lists (TanStack Virtual)**
  - **Locations.** `src/client/components/ExternalChangesDrawer.tsx:1312, 1392, 1601, 1653, 1704`.
  - **Failure mode.** Unbounded discrepancy cards render directly into the DOM, violating `AGENTS.md` constant-time DOM rendering.
  - **Preserved UX.** Card layout, badges, and actions stay identical; virtualize past `VIRTUALIZE_THRESHOLD = 30` (matching `UploadDrawer.tsx`).
  - **Steps.** Flatten discrepancy sections into a discriminated row list and wrap `contentScroll` with `useVirtualizer` when `rows.length > 30`.

- [ ] **G-8 `[Blocking]` Fix silent partial-failure and notice-wipe bugs in `ExternalChangesDrawer.tsx`**
  - **Locations.** `src/client/components/ExternalChangesDrawer.tsx:712-718, 852-905, 980-1008, 1051-1093, 1258-1296`.
  - **Failure mode.** `eject-all` clears `unindexed`/`modified` even when `failedCount > 0`; `conflicts-batch` ignores `res.json()` (`failedCount`/`results`) and removes failed conflicts; `handleAutoRebalance` counts failed results as migrated, wipes its own `statusNotice` inside `scanAccount`, and clears sidebar pending count on scan failure; `selectedAccount` stays stale when `accounts` empties, leaving "Rescan" enabled; `statusNoticeBanner` scrolls offscreen inside `contentScroll`.
  - **Preserved UX.** Successful items still clear immediately; failed items stay visible with inline `statusNoticeBanner` pinned above `contentScroll`.
  - **Steps.** Parse `results` / `failedCount` in `conflicts-batch` and `eject-all` (rescanning on `eject-all` partial failures); filter `data.results` by `r.success` in `handleAutoRebalance`, scan first then set `statusNotice`, and preserve `countDiscrepancies(report)` if re-scan fails; clear `selectedAccount` and disable Rescan when `accounts.length === 0`; move `statusNoticeBanner` above `contentScroll`.

- [ ] **G-9 `[Warning]` Eliminate `UploadFolderCard` 120 ms hot-path scans and clean `UploadDrawer`/`FileTable` code quality**
  - **Locations.** `src/client/components/UploadDrawer.tsx:36, 979-1221, 1558-1569, 1954-1975`; `src/client/components/FileTable.tsx:35-36, 117, 277, 1792-1865`; `src/client/components/ExternalChangesDrawer.tsx:1253-1256`.
  - **Steps.** Precompute static folder summaries outside `UploadFolderCard` and compute folder progress totals in one pass alongside `overallProgress`; remove dead `reason`/`reasonLabel` and deduplicate `stagedEmptyFolders` keys; unify `handleDrop`/`handleRowDrop`, normalize `cleanPath`, move `import type` to top, and add a brief comment on intentional `FileTable` column widths vs `docs/styling-guide.md`; use `currentAccount` directly in `ExternalChangesDrawer` `<select title>`.

- [ ] **G-10 `[Warning]` Extract `DrawerSheet`, add `'danger'` `DrawerButton`, fix drawer pointer guards, and adopt tokens**
  - **Locations.** `src/client/components/DrawerPrimitives.tsx`, `UploadDrawer.tsx:102, 270, 487, 2097-2250`, `ExternalChangesDrawer.tsx:109, 525-560, 1096-1195`, `FileTable.tsx:381, 661`.
  - **Failure mode.** Both drawers duplicate `<dialog>` shell/lifecycle/styles, omit `e.target === e.currentTarget` and `typeof dialog.getAnimations === 'function'` guards, inline `btnDanger` (missing coarse-pointer 44px hit target), and hardcode `rgba(...)`, transitions, and `'460px'` width.
  - **Preserved UX.** Drawer widths, colors, transitions, and backdrop behavior remain identical.
  - **Steps.** Move shared `<dialog>` shell/lifecycle/guards into `DrawerSheet` in `DrawerPrimitives.tsx`; add `'danger'` variant to `DrawerButton`; replace hardcoded StyleX literals with `tokens.stylex.ts` tokens (`E-6`).

---

### Slice H: Modals and dialog primitives
**Files owned:** `src/client/components/ModalDialog.tsx`, `src/client/components/SelectField.tsx`, `src/client/components/MoveConflictModal.tsx`, `src/client/components/MoveFilesModal.tsx`, `src/client/components/MovePoolModal.tsx`, `src/client/components/NewFolderModal.tsx`, `src/client/components/RenameModal.tsx`, `src/client/components/ShareModal.tsx`, `src/client/components/ConfirmDriveActionModal.tsx`, `src/client/components/ConfirmPurgeModal.tsx`, `src/client/components/TabBlockedModal.tsx`, and modal handlers in `src/client/App.tsx` (coordinate `App.tsx` after Slice F).

- [ ] **H-1 `[Blocking]` Prevent busy-modal and `TabBlockedModal` dismiss bypass, fix pointer button check, and restore focus on unmount**
  - **Locations.** `src/client/components/ModalDialog.tsx:97-165`, `src/client/components/TabBlockedModal.tsx:1238-1244`.
  - **Failure mode.** Browsers lacking `closedby="none"` (or Chromium double-Escape bypass) fire native `close` -> `handleClose` -> `onClose()`, unmounting busy modals mid-mutation and permanently dismissing `TabBlockedModal` onto a blank blurred shell. `handlePointerDown` also triggers on right/middle clicks (`e.button !== 0`). Conditional `{isOpen && <Modal />}` unmounting skips `dialog.close()` native focus restoration.
  - **Preserved UX.** Non-busy modals close on Escape/left-click backdrop; busy modals and `TabBlockedModal` stay locked; focus returns to the trigger element on close.
  - **Steps.** Track `isBusyRef` / `isOpenRef` in `ModalDialog.tsx` and re-call `dialog.showModal()` in `handleClose` via microtask when `isBusyRef.current && isOpenRef.current` instead of calling `onClose()`; require `e.button === 0` in `handlePointerDown`/`handlePointerUp`; save `previousFocusRef` before `showModal()` and restore focus on unmount if still connected.

- [ ] **H-2 `[Blocking]` Fix premature close and silent errors in `ConfirmPurgeModal` and `MovePoolModal`**
  - **Locations.** `src/client/components/ConfirmPurgeModal.tsx:227-236`, `src/client/components/MovePoolModal.tsx:250-263, 326-328`, `src/client/App.tsx:2738-2767, 3085-3135, 3186-3231`.
  - **Failure mode.** `ConfirmPurgeModal` catches and swallows `onConfirm()` errors with no inline error banner, and `App.tsx` closes `ConfirmPurgeModal` (`handleEmptyTrashExecute`, `handleClearSharePoolConfirm`) and `MovePoolModal` (`handleSwitchAccountPool`) on line 1 before the request starts, making Share Pool clear and Move Pool errors 100% silent.
  - **Preserved UX.** Visual modal design stays untouched; errors render inside the modal's inline `role="status"` slot on failure.
  - **Steps.** Add `error` state + inline `<div role="status" aria-live="polite">` in `ConfirmPurgeModal.tsx`; stop closing `ConfirmPurgeModal` and `MovePoolModal` at the top of `App.tsx` handlers (let modals call `onClose()` after `await onConfirm(...)` resolves) and rethrow parsed server error messages on `!res.ok` / `catch`.

- [ ] **H-3 `[Blocking]` Fix premature close, background refresh reset, and partial batch filtering in `MoveFilesModal`**
  - **Locations.** `src/client/components/MoveFilesModal.tsx:344-350, 357-370, 482-484`, `src/client/App.tsx:2876-2908, 3400-3404`.
  - **Failure mode.** `App.tsx:2880` closes `MoveFilesModal` immediately before `POST /api/sync/rebalance/batch`, bypassing `isLoading`, `isBusy`, and inline error rendering. `useEffect(..., [isOpen, firstEligibleId])` resets live `targetAccountId`, `error`, and `isLoading` whenever background focus refresh updates `accounts`. On partial batch failure, `modalFiles` keeps already-moved files in the list.
  - **Preserved UX.** Modal layout, virtualized list, and `SelectField` controls stay unchanged.
  - **Steps.** Narrow `MoveFilesModal`'s reset `useEffect` to `isOpen` false->true transitions (or `sourceAccount?.id` changes); remove premature `setMoveFilesModalGroup(null)` from `App.tsx:2880`, throw errors to `MoveFilesModal`, and filter `modalFiles` (`App.tsx:3400-3404`) by `f.accountId === moveFilesModalGroup.accountId`.

- [ ] **H-4 `[Blocking]` Keep `MoveConflictModal` open and render inline errors on failure**
  - **Locations.** `src/client/components/MoveConflictModal.tsx:404-430, 616-649`, `src/client/App.tsx:167-173, 2098-2138`.
  - **Failure mode.** `MoveConflictModal` has no inline error banner and `App.tsx` dismisses `pendingMoveConflict` on `!res.ok` or network error.
  - **Preserved UX.** Existing 3 action buttons and warning/info styling stay unchanged; inline warning box renders only on failure.
  - **Steps.** Add `errorMessage?: string | null` to `MoveConflictModalProps` and `PendingMoveConflict`; render `errorMessage` inline in `role="status"` and keep the modal open for retry on failure in `handleResolveMoveConflict`.

- [ ] **H-5 `[Warning]` Fix `ShareModal` hidden validation reason, empty-`items` crash, missing `webViewLink`, clipboard error, `onComplete`, and stale `inspectCache`**
  - **Locations.** `src/client/components/ShareModal.tsx:69-78, 816-833, 916-930, 1020-1081, 1234-1253, 1286`.
  - **Failure mode.** `validationData.reason` is never rendered in JSX; indexing `items[0].name` crashes if rendered closed with `items=[]`; missing `webViewLink` renders silently; failed clipboard copy fails silently; `onComplete` rejection is unawaited; 15s `inspectCache` goes stale across workspace mutations.
  - **Preserved UX.** Existing two-step share UI stays identical; notices render via existing `dangerBanner` / inline row note.
  - **Steps.** Guard `items.length > 0` before accessing `items[0]`; render `validationData.reason` when `valid === false`; render inline `"Share link unavailable for this drive"` when `!link.webViewLink`; set inline error on clipboard failure and `onComplete` rejection; export and invoke `invalidateShareInspectCache()` on account/pool/file mutations.

- [ ] **H-6 `[Warning]` Add synchronous `useRef` submit locks across all modals and `App.tsx` action handlers**
  - **Locations.** `NewFolderModal.tsx:250-261`, `RenameModal.tsx:265-280`, `MoveFilesModal.tsx:357-361`, `MovePoolModal.tsx:250-254`, `ConfirmPurgeModal.tsx:227-230`, `ShareModal.tsx:1059-1065`, `MoveConflictModal.tsx:426-430`, `App.tsx:2099, 2964-2968`.
  - **Failure mode.** Async React state alone allows rapid double-clicks / double-Enter before re-render to fire duplicate mutations (`handleExecuteDriveAction` lacks any guard at all).
  - **Steps.** Add synchronous `submittingRef = useRef(false)` guards in every modal submit handler and in `handleExecuteDriveAction` / `handleResolveMoveConflict`.

- [ ] **H-7 `[Warning]` Include trashed files in `ConfirmDriveActionModal` counts (`App.tsx`)**
  - **Locations.** `src/client/App.tsx:2994-2996` (vs `src/server/app.ts:780`).
  - **Failure mode.** `driveFilesCount` counts only active `files`, showing `0 files (0 B)` while `DELETE /api/accounts/:id` counts and evacuates trashed files too.
  - **Steps.** Include `trashedFiles` matching `driveActionModal.account?.id` when computing `driveFilesCount` and `driveTotalBytes`.

- [ ] **H-8 `[Warning]` Deduplicate modal chrome styles, standardize `<h2>` headings, and use `tokens.stylex.ts` tokens**
  - **Locations.** `ConfirmDriveActionModal.tsx`, `ConfirmPurgeModal.tsx`, `MoveConflictModal.tsx`, `MoveFilesModal.tsx`, `MovePoolModal.tsx`, `NewFolderModal.tsx`, `RenameModal.tsx`, `ShareModal.tsx`, `TabBlockedModal.tsx`.
  - **Preserved UX.** Exact same modal dimensions, spacing, colors, and borders per modal.
  - **Steps.** Extract shared modal header/footer/field StyleX rules into `ModalChrome.tsx` (or `ModalDialog.tsx`) with explicit variant props; change `<h3>` in `NewFolderModal.tsx:291` and `ConfirmPurgeModal.tsx:250` to `<h2>`; replace hardcoded `'48px'`, `'4px'`, `'2px'`, `'8px'`, `'10px'`, `'600'`, `'1.4'` literals with `tokens.stylex.ts` tokens; add a comment at `TabBlockedModal.tsx:65-66` documenting intentional pre-hydration theme sync.

- [ ] **H-9 `[Nit]` Modal hygiene cleanup**
  - **Locations.** `ConfirmDriveActionModal.tsx:13, 263` (`_action` prop + `App.tsx:3844`), `NewFolderModal.tsx:4` (`./Icons.js`), `MoveConflictModal.tsx:435-447` (`getConflictMatchMeta` hoist).
  - **Steps.** Remove unused `action` prop (or document if reserved), add `.js` extension to `Icons` import, and hoist `getConflictMatchMeta` to module scope.
