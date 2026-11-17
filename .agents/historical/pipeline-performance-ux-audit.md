# Tsubasa~ Cloud pipeline performance and UI/UX audit

Audit date: 2026-11-15
Scope: Read-only architectural and performance audit across the full database, storage, Google Drive, Hono API, client state, and frontend rendering pipeline.
Auditors: Five high-reasoning audit slices consolidated against `.agents/AGENTS.md`, `.agents/skills/unslop/SKILL.md`, and modern web platform standards.

---

## Executive summary

Tsubasa already keeps file browsing local-first in SQLite and streams transfers through Hono without disk buffering, but user interactions still stall across five structural bottlenecks:

1. **Fragile async Drive writes without a durable outbox.** Recent optimizations commit renames, moves, trash, restore, and accepted external changes to SQLite immediately and stamp Google Drive in the background (`operations.ts`, `detector.ts`). Those background calls run as unawaited floating promises with zero retry/backoff on Drive `429`/`5xx` and no SQLite outbox. A failed background stamp drops from `pendingAppPropertyDriveIds`, causing the next `runColdReconciliation` to delete the accepted file from SQLite.
2. **Synchronous Drive round-trips still block high-friction user actions.** `inspectSharePlan` fires unbounded live `drive.about.get` calls across all empty and Share Pool accounts on every Share modal open. `executeShare`, `purgeFile`, `emptyTrash`, `copyItems`, `switchAccountPool`, `removeDriveAccount`, OAuth import/callback, and `clearSharePool` still block HTTP responses on serial or unthrottled Drive network calls.
3. **Hidden SQLite and Drive O(N) scans.** `files.virtual_path` and `folders.virtual_path` use `BINARY` collation without `case_sensitive_like`, forcing `LIKE 'prefix%'` queries across `placement.ts`, `quota.ts`, `operations.ts`, and `share.ts` to scan entire pools. `resolveRemoteFolderTree` crawls every non-trashed folder across the user's entire Google Drive instead of BFS from `rootFolderId`. `GET /api/files` ignores `?path=` and returns every active file and folder in the pool uncompressed with no projections or ETags. `GET /api/accounts` runs synchronous `fs` syscalls (`authPool.scan`) on every poll.
4. **Frontend network waterfalls, serial batch loops, and missing optimistic UI.** `TabLockGate` blocks `<App />` mount behind a serial `POST /api/instance/claim`. Batch delete, trash, and restore execute 1-by-1 sequential HTTP `for` loops. Every modal mutation locks until full-pool refetches complete (`loadFiles` + `loadClusterData` + `loadTrashFiles` even outside Trash). Opening `ExternalChangesDrawer` discards prefetched discrepancy reports and locks the entire drawer during reloads. Unthrottled `xhr.upload.onprogress` re-renders every card in `UploadDrawer` with O(N^2) lookups.
5. **Layout thrashing, custom modal overlays, and main-thread INP spikes.** `ActionPortal.tsx` runs forced read-write-read-write layout measurement loops inside `useLayoutEffect` and `ResizeObserver` on every row selection and resize. `FileTable.tsx` runs unthrottled marquee `mousemove` layout reads/scroll writes and unmemoized virtual rows with inline `<select>` subtrees. All eight modals use custom `<div>` overlays without Focus Trap or Focus Restoration instead of native Top Layer `<dialog>` (`showModal()` + `closedby`), and `index.html` loads 1.47 MB of uncompressed TTF variable fonts with no WOFF2 conversion or preload.

---

## Consolidated priority matrix

| ID | Severity | Layer | Location | Bottleneck | Primary Expected Win |
| :--- | :--- | :--- | :--- | :--- | :--- |
| DB-1 | Critical | SQLite / Storage | `db/init.ts`, `placement.ts:117`, `quota.ts:285`, `operations.ts` | `LIKE 'prefix%'` on `BINARY` `virtual_path` bypasses B-tree indexes and lacks `ESCAPE` | Sub-millisecond subtree lookups; fixes `%`/`_` wildcard bugs |
| DB-2 | Critical | SQLite Schema | `db/index.ts:28-61`, `db/init.ts:67-77` | `renameAccountInDb` omits `share_links`, uses `DEFERRED` lock upgrades, recompiles prepares | Prevents FK failures and silent `ON DELETE CASCADE` link loss |
| GD-1 | Critical | Drive Client | `drive/client.ts:85-95`, `detector.ts`, `sync.ts`, `delta.ts` | Zero retry or jittered exponential backoff on Drive `429` / `403` rate limits / `5xx` | Eliminates batch failures and silent partial sync corruption |
| GD-2 | Critical | Drive Detector | `drive/detector.ts:125-608`, `sync.ts:317-321` | `pendingAppPropertyDriveIds` / `discrepancyCache` race with concurrent scans; stamp failures drop DB rows | Prevents data un-indexing and stale External Changes state |
| GD-3 | Critical | Drive Folders | `drive/client.ts:466-553`, `operations.ts:102,147`, `detector.ts:196,495,798` | `resolveRemoteFolderTree` lists every non-trashed folder in the entire Drive account | Cuts global Drive crawls to bounded parent-scoped BFS |
| API-1 | Critical | Hono Read API | `server/app.ts:816-847, 1165-1173` | `GET /api/files` ignores `?path=`, dumps full pool rows without projections, compression, or ETags | Cuts large-pool navigation payloads by 90% to 99% |
| API-2 | Critical | Sync Reliability | `drive/operations.ts:308,392,430,820,1038`, `app.ts` | Background Drive writes are floating promises with no SQLite outbox, retry, or error visibility; 7 mutations still block HTTP on Drive | Sub-10ms local-first mutations with crash-safe Drive sync |
| API-3 | Critical | Share Pipeline | `drive/share.ts:527-1019` | `inspectSharePlan` runs unbounded live `about.get` calls; `executeShare` duplicates validation and copies serially | 1s to 4s faster modal open; 5x to 8x faster multi-file sharing |
| FE-1 | Critical | Boot Waterfall | `client/main.tsx:28-40`, `client/utils/useTabLock.ts:292-369` | `TabLockGate` blocks `<App />` mount behind serial `POST /api/instance/claim` | Saves 1 full RTT on initial workspace boot |
| FE-2 | Critical | Batch UX | `client/App.tsx:1296-1415, 1617-1621` | `handleDeleteSelected`, `handleTrashItems`, `handleBatchRestore` loop HTTP requests 1-by-1 without optimistic UI | Drops multi-second batch waits to under 50ms UI feedback |
| FE-3 | Critical | Upload INP | `client/components/UploadDrawer.tsx:767-774, 915-1054` | Unthrottled `xhr.upload.onprogress` triggers full drawer renders and O(N^2) `previews.find` lookups | Eliminates frame drops during multi-GB and large folder uploads |
| UX-1 | Critical | Layout Thrash | `client/components/ActionPortal.tsx:436-673` | Forced read-write-read-write layout measurements inside `useLayoutEffect` and `ResizeObserver` | Eliminates main-thread reflow on every row click and resize |
| DB-3 | High | SQLite Indexes | `db/init.ts:79-94`, `db/schema.ts`, `transfer.ts:336` | Missing composite/covering indexes for `(account_id, drive_file_id)`, `transfer_logs`, pool/trash aggregation, and `share_links(account_id)` | Index-only scans for detector, quota, and download lookups |
| DB-4 | High | Placement / Quota | `storage/placement.ts:101-456`, `storage/quota.ts:83-492`, `rebalance.ts:287-481` | O(N * D) per-file DB affinity scans; JS materialization of all 24h `transfer_logs`; unthrottled pruning; 6-query overview | 10x+ faster batch planning and quota checks |
| DB-5 | High | Server Startup | `server/index.ts:7-49`, `db/init.ts:3-185` | Unbounded startup hydration/sync burst across all Pool 1 accounts before/during early HTTP traffic | Eliminates boot-time Drive 429 storms and SQLite lock contention |
| GD-4 | High | Drive Mirroring | `drive/mirror.ts:5-98` | `ensureRemoteFolderHierarchy` has no in-flight lock, creating duplicate folders on concurrent uploads; global cache wipe | Prevents duplicate remote folders and cache thrashing |
| GD-5 | High | Cold / Delta Sync | `drive/sync.ts:230-353`, `drive/delta.ts:24-169, 313-342` | `getStartPageToken` fetched after listing; `resolveRemoteParentPath` queries wrong ID column; `changes.list` omits `pageSize: 1000` and 410 fallback | Fixes missed mid-sync edits, extra parent `files.get`, and wedged tokens |
| GD-6 | High | Auth Pool I/O | `drive/auth.ts:81-211, 312-323`, `app.ts:139-190` | Sync `fs.readdirSync`/`statSync` in `GET /api/accounts` and `GET /api/pools`; sync token writes; rename race | Removes blocking `fs` syscalls from Node event loop |
| GD-7 | High | Rebalance / Conflicts | `drive/rebalance.ts:60-587`, `drive/detector.ts:740-1061` | Serial file transfers and `keep_both` conflict loops; deletes Drive source before DB commit; defers quota updates | 5x faster batch rebalance/conflicts; prevents orphaned Drive files |
| API-4 | High | Operations / Security | `app.ts:875, 1128-1164`, `drive/operations.ts`, `drive/share.ts:1021-1122`, `drive/sync.ts:137-147` | Dot-named folders dropped; missing Share Pool guards on folder delete/trash; serial `copyItems` and `clearSharePool` | Fixes broken dot folders, Share Pool safety, and 100s+ copies |
| API-5 | High | Streaming Transfers | `app.ts:1060-1127`, `drive/transfer.ts:60-371` | No `AbortSignal` cleanup; premature full-size download logging; no HTTP `Range` (`206`); 2-RTT small uploads; `permissions.create` sends emails | Stops leaked sockets, fixes seek/resume, saves Drive notifications |
| FE-4 | High | Refetch Cascades | `client/App.tsx`, `client/components/ExternalChangesDrawer.tsx` | Full-pool reloads on every mutation; modal locks held across reloads; discarded `DiscrepancyReport`; duplicate OAuth/pool reloads | Instant action turnaround and 50% to 66% fewer sync requests |
| FE-5 | High | React Renders / INP | `client/App.tsx`, `client/api.ts`, `UploadDrawer.tsx` | Monolithic `App` state re-renders tree on search/toast; no `useDeferredValue`/`startTransition`; no `AbortController`; sequential uploads | Sub-50ms typing/filtering and responsive pool switching |
| UX-2 | High | Table & Marquee | `client/components/FileTable.tsx:1292-1460, 1928-2519` | Unthrottled marquee mousemove reflows; unmemoized virtual rows; O(N) lookups; inline per-row `<select>` option subtrees | 60fps scrolling and drag selection in 10k+ item folders |
| UX-3 | High | Native Overlays & A11y | `Modals`, `FileTable.tsx`, `Header.tsx`, `App.tsx:1630-1732`, `useBeforeUnload.ts` | Custom `<div>` overlays lack Focus Trap/Restore; incomplete ARIA grid/roving tabindex; global shortcut leakage; layout-shifting errors | Full WCAG AAA/keyboard accessibility via Top Layer `<dialog>` |
| UX-4 | High | Fonts, Paint & Cascade | `index.html`, `global.css`, `vite.config.ts`, `Sidebar.tsx`, `TabBlockedModal.tsx` | 1.47 MB TTF fonts without WOFF2/preload; full-viewport SVG `feTurbulence`; unlayered `button:hover` beats StyleX `@layer`; width animations | Faster first paint, fixed touch active buttons, smoother scrolling |
| DB-6 | Medium | WAL Pragmas | `db/index.ts:14-24`, `db/init.ts:119-182` | Default 4 MB autocheckpoint, unlimited journal size, `DEFERRED` lock upgrades | Stable bulk write latency and zero unexpected `SQLITE_BUSY` |
| FE-6 | Medium | SWR Cache / Heartbeat | `App.tsx:705-737`, `useTabLock.ts:270-418` | Pool switch wipes all cached state; unguarded 5s heartbeat interval; no BFCache `pageshow` recovery; Undo/queue UI missing | 0ms back-switching across pools; safe background tabs |
| UX-5 | Medium | Containment & Code Split | `vite.config.ts`, `ShareModal.tsx`, `Sidebar.tsx`, `DitherDivider.tsx`, `RedactedEmail.tsx` | Missing `contain` / `content-visibility`; unsplit JS bundle; closed modals run virtualizers; JS pixel-loop canvas; noisy `selectionchange` | Smaller initial bundle, instant Drive/Trash view swaps, cleaner renders |

---

## Part 1: Local SQLite database, storage placement, and startup

Files audited: [index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/index.ts), [db/index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/index.ts), [db/init.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/init.ts), [db/schema.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/schema.ts), [placement.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/placement.ts), [quota.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/quota.ts).

### 1.1 Unindexed `LIKE` prefix scans on `BINARY` columns (Critical)

- **Mechanism.** `files.virtual_path` and `folders.virtual_path` use SQLite default `BINARY` collation ([init.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/init.ts#L35-L45), [schema.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/schema.ts#L34-L49)), while [db/index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/index.ts#L17-L23) leaves `case_sensitive_like` at its default `OFF`. In SQLite, case-insensitive `LIKE 'prefix%'` cannot use a `BINARY` B-tree index. Every subtree query scans all active rows in the pool:
  - `findFolderAffinityAccounts` ([placement.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/placement.ts#L101-L132)) runs `virtual_path LIKE '/dir/%'` inside an ancestor-walking `while` loop.
  - `getSystemStorageBreakdown` ([quota.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/quota.ts#L273-L294)) runs `virtual_path LIKE '/.tsubasa/%'` on every overview fetch.
  - `moveItems`, `copyItems`, `renameItem`, `trashFolder` ([operations.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L418-L1030)), and `share.ts` run subtree `LIKE` queries, and `operations.ts` + `placement.ts` omit `ESCAPE '\'`, letting `%` or `_` folder names match sibling trees.
- **Fix.** Build a small shared path-bound helper returning `[prefix, nextAsciiPrefix]` (`virtual_path >= prefix AND virtual_path < upperBound`) backed by `CREATE INDEX IF NOT EXISTS files_pool_trashed_path_idx ON files(pool_id, is_trashed, virtual_path, account_id, size_bytes)`. Range bounds use the `BINARY` B-tree directly (`O(log N + K)`), preserve case sensitivity, and eliminate wildcard bugs.

### 1.2 `renameAccountInDb` omits `share_links` and upgrades locks unsafely (Critical)

- **Mechanism.** `share_links.account_id` declares `REFERENCES accounts(id) ON DELETE CASCADE` without `ON UPDATE CASCADE` ([init.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/init.ts#L71), [schema.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/schema.ts#L85)). Inside [renameAccountInDb](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/index.ts#L28-L61), `accounts`, `files`, and `transfer_logs` update while `share_links` is untouched:
  - Merging into an existing target account deletes the old `accounts` row and silently cascades-deletes all `share_links` for that account.
  - Renaming to a new ID updates `accounts` first and hits `FOREIGN KEY constraint failed` at commit ([auth.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/auth.ts#L163-L389) catches it only as a warning after disk `.oauths/` files already moved).
  - Line 29 skips case-changing renames (`oldId.toLowerCase() === newId.toLowerCase()`), lines 36-58 recompile up to 6 `sqlite.prepare` calls each run, and the transaction uses `DEFERRED` instead of `.immediate()`, allowing `SQLITE_BUSY` on read-to-write lock upgrade.
- **Fix.** Remove the case-insensitive early return, update `share_links` alongside `files` and `transfer_logs` in every branch inside `sqlite.transaction(...).immediate()`, and hoist prepared statements to module scope.

### 1.3 Missing composite and covering indexes (High)

- **Observed gaps** ([init.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/init.ts#L79-L94), [schema.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/schema.ts#L27-L94)):
  - Add `files_account_drive_file_idx` on `files(account_id, drive_file_id)` for `detector.ts` (`671`, `777`, `829`, `911`, `1096`, `1101`) and `getStreamingDownload` ([transfer.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/transfer.ts#L336)).
  - Add `files_pool_trashed_account_size_idx` on `files(pool_id, is_trashed, account_id, size_bytes)` for `quota.ts` pool aggregations.
  - Add `files_account_pool_trashed_idx` on `files(account_id, pool_id, is_trashed)` for `sync.ts:301`.
  - Add `transfer_account_type_ts_bytes_idx` on `transfer_logs(account_id, transfer_type, timestamp, byte_count)` so 24-hour transfer stats execute as index-only scans.
  - Add `share_links_account_idx` on `share_links(account_id)` for account-pool switches (`client.ts:701`).
  - Prune redundant single-column indexes (`files_trashed_idx`, `folders_parent_idx`, `folders_path_idx`, and superseded `transfer_account_ts_idx`) to cut sync write amplification.

### 1.4 Batch placement O(N * D) scans, JS transfer materialization, and overview polling (High)

- **Mechanism.**
  - `simulateBatchPlacement` ([placement.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/placement.ts#L327-L456)) and `evacuateAccountFiles` ([rebalance.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/rebalance.ts#L451-L502)) call `await findFolderAffinityAccounts(...)` per folder and per file instead of preloading one directory-account map per pool and updating it in memory as simulated files are assigned. Even `eligible.length === 1` ([placement.ts:183-185](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/placement.ts#L183-L185)) triggers an affinity query that cannot change the winner.
  - `getTransferStatsByAccountMap` and `getAccountTransferStats` ([quota.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/quota.ts#L83-L246)) fetch every 24h `upload` and `download` row into JS to sum bytes, even when placement callers only need `remainingUploadBytes24h`. `rebalance.ts:289, 410` call `getAccountTransferStats` inside account loops.
  - `recordTransfer` ([quota.ts:253-271](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/quota.ts#L253-L271)) runs `DELETE FROM transfer_logs WHERE timestamp < ?` unconditionally on every single upload or download.
  - `getPooledStorageOverview` ([quota.ts:296-403](file:///D:/Projects/Tsubasa~%20Cloud/src/server/storage/quota.ts#L296-L403)) executes 6 uncached sequential queries, including an unscoped `SELECT account_id, count(*) FROM files GROUP BY account_id` across all pools (`app.ts:145` repeats this). Note also lines 348-385 count disabled/errored accounts in `clusterDailyCapacity` while excluding them from `totalHeadroom`.
- **Fix.** Preload pool affinity once per batch, aggregate `SUM`/`COUNT`/`MIN`/`MAX` in SQL over the covering index, throttle `pruneOldTransferLogs` to a 10-minute / 500-insert cooldown, replace cross-pool `GROUP BY` with `WHERE account_id IN (...)` or `EXISTS`, and cache `getPooledStorageOverview(poolId)` with explicit mutation invalidation.

### 1.5 Unbounded startup burst and WAL tuning (High / Medium)

- **Mechanism.** [server/index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/index.ts#L7-L49) runs 15 DDL checks + `PRAGMA table_info` in `initializeDatabase()` and synchronous `authPool.scan()` before binding HTTP, then launches unbounded concurrent `hydrateAccount` + `runIncrementalSync` chains for every Pool 1 account without sharing single-flight tracking with `syncAllAccounts`. Meanwhile, [db/index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/db/index.ts#L17-L23) leaves default `wal_autocheckpoint = 1000` (4 MB) and `journal_size_limit = -1`.
- **Fix.** Gate schema DDL behind `PRAGMA user_version`, bind `serve()` immediately, run startup hydration through a shared bounded pool (concurrency 3 to 5) deduplicated with `syncAllAccounts`, configure `wal_autocheckpoint = 2000` + `journal_size_limit = 67108864`, and use `.immediate()` transactions for read-then-write paths.

---

## Part 2: Google Drive client, sync, detector, and rebalance engine

Files audited: [drive/index.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/index.ts), [auth.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/auth.ts), [client.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/client.ts), [sync.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/sync.ts), [delta.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/delta.ts), [mirror.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/mirror.ts), [detector.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts), [rebalance.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/rebalance.ts).

### 2.1 Zero Drive API retry/backoff and burst concurrency (Critical)

- **Mechanism.** [getDriveClient](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/client.ts#L85-L95) constructs a new `google.drive` client per call with no retry middleware for `429`, `403 rateLimitExceeded` / `userRateLimitExceeded`, or `5xx`. Yet `syncAllAccounts` runs 5 accounts concurrently, `scanAccountDiscrepancies` runs 5 folder-chunk queries per account, `detector.ts` runs `DRIVE_BATCH_CONCURRENCY = 10` per account, and `sync.ts:256-268` + `delta.ts:257-269` fire unthrottled orphan `drive.files.update` loops.
- **Fix.** Wrap all Google Drive RPCs in a shared jittered exponential backoff executor honoring `Retry-After`, cache `drive_v3.Drive` instances in a `WeakMap<OAuth2Client, drive_v3.Drive>`, and cap orphan cleanup concurrency.

### 2.2 `detector.ts` cache/pending races and silent data loss on background stamp failure (Critical)

- **Mechanism.**
  - [acceptExternalFile](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L404-L556) and [acceptAllExternalFiles](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L636-L738) track pending stamps only in an in-memory `Set` (`pendingAppPropertyDriveIds`). If [stampAcceptedAppProperties](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L558-L612) fails (rate limit, `5xx`, or server restart), `finally` removes the ID. On the next `runColdReconciliation` ([sync.ts:243, 318](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/sync.ts#L243-L321)), the file is absent from `tsubasa_managed = 'true'` results and deleted from local SQLite.
  - `scanAccountDiscrepancies` never ignores `pendingAppPropertyDriveIds`, `forceRefresh = true` bypasses `inFlightScans` ([detector.ts:391-393](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L391-L393)) allowing older scans to overwrite `discrepancyCache`, multi-parent files duplicate across chunks (`foundRemoteIds` never checked before push), every scan re-runs a `folders` write transaction even with zero folder diffs, and external modules never invalidate `discrepancyCache`.
- **Fix.** Persist a `pending_drive_sync` state/outbox row in SQLite checked by `runColdReconciliation`, track monotonic per-account scan generations so stale scans cannot overwrite cache, deduplicate `remote.id` before classification, skip `folders` writes when unchanged, and export `invalidateDiscrepancyCache(accountId?)`.

### 2.3 Global Drive folder crawl in `resolveRemoteFolderTree` (Critical)

- **Mechanism.** [resolveRemoteFolderTree](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/client.ts#L466-L553) queries `mimeType = 'application/vnd.google-apps.folder' and trashed = false` across the **entire** Google Drive account instead of scoping under `rootFolderId`. It is also called in single-file fallback paths in [detector.ts:495, 798](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L495-L798) and for every account in pool folder moves/renames/trashes ([operations.ts:102, 147, 965](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L102-L147)).
- **Fix.** Switch `resolveRemoteFolderTree` to top-down parent-batched BFS starting from `[rootFolderId]` (20 parent IDs per `in parents` `OR` clause, concurrency 5), and use targeted `resolveRemoteParentPath` for single-file detector fallbacks.

### 2.4 Folder mirroring races, sync token ordering, delta misses, and auth `scan()` I/O (High)

- **Mirroring ([mirror.ts:5-98](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/mirror.ts#L5-L98)).** `ensureRemoteFolderHierarchy` has no in-flight promise deduplication map (`inFlightFolderPromises`), causing concurrent uploads into a new directory to create duplicate Google Drive folders. `clearRemoteFolderCache()` wipes caches across all accounts globally.
- **Cold & Delta sync ([sync.ts:230-353](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/sync.ts#L230-L353), [delta.ts:24-342](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/delta.ts#L24-L342)).**
  - `runColdReconciliation` fetches `getStartPageToken` *after* `files.list`, dropping edits made mid-sync, ignores `isTrashed = true` rows when pruning externally emptied Drive Trash (`sync.ts:301`), recompiles 5 `sqlite.prepare` statements per file inside `upsertFileRecord` (`sync.ts:154-193`), and skips quota refresh.
  - `resolveRemoteParentPath` (`delta.ts:50-67`) matches Google Drive folder IDs against `folders.id` (`${poolId}:${virtualPath}`), which always misses and forces sequential `drive.files.get` ancestor walks.
  - `drive.changes.list` (`delta.ts:163-169`) omits `pageSize: 1000` (defaulting to 100 per page), fails without cold-sync recovery on `410` expired tokens, marks `syncState = 'error'` if trailing `about.get` fails after delta commit, and omits a per-account single-flight sync lock (`inFlightSyncs`).
- **Auth Pool ([auth.ts:81-211, 312-323](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/auth.ts#L81-L323)).** Synchronous `authPool.scan()` runs on every `GET /api/accounts` and `GET /api/pools`, and token refreshes call synchronous `fs.writeFileSync` while invalidating `fileCache`. Move scanning to boot + `fs.watch` + explicit import, and persist tokens via atomic async writes.

### 2.5 Rebalance, conflict resolution, and eject bottlenecks (High / Medium)

- **Rebalance ([rebalance.ts:60-587](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/rebalance.ts#L60-L587)).** `rebalanceFilesBatch` runs serially, deletes the source file in Drive (`line 178`) before updating SQLite (`line 180`), and defers `quotaUsedBytes` updates until `finally` (`lines 201-219`), exposing target accounts to concurrent upload over-allocation past the 750 MB ceiling. Both `executeAutoRebalance` and `evacuateAccountFiles` call single-file `rebalanceFile` instead of grouped batches.
- **Conflicts & Eject ([detector.ts:614-1124](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/detector.ts#L614-L1124)).** `resolvePathConflict` deletes DB rows before Drive updates succeed; `resolvePathConflictsBatch` runs `keep_both` serially (200+ round-trips + `while(true)` collision probes per file) and fires N `about.get` calls in `deduplicate`; `ejectAllExternalFiles` re-fetches `parents` per file via `ejectFileToDriveRoot`; `acceptAllExternalFiles` leaves `quotaUsedBytes` stale.

---

## Part 3: Hono API routes, operations, streaming transfers, and sharing

Files audited: [app.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts), [operations.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts), [transfer.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/transfer.ts), [share.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/share.ts).

### 3.1 Unfiltered pool dumps and missing HTTP caching/compression (Critical)

- **Mechanism.** [GET /api/files](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L816-L840) parses `?path=` and then ignores it, serializing every active file and folder in the entire pool with all columns (`select()`). `GET /api/folders` (`842-847`) and `GET /api/trash` (`1165-1173`) behave identically. [app.ts:192-196](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L192-L196) has no `compress()` middleware and no ETag/`304 Not Modified` support, while `app.use('*', logger())` logs every heartbeat/health check.
- **Fix.** Scope `GET /api/files` by `folder_id` (or explicit `?mode=tree` when preloading smaller pools) with projected UI columns, mount `hono/compress`, and serve weak ETags keyed to a per-pool monotonic revision counter for `304` hits.

### 3.2 Remaining synchronous Drive blockers and missing SQLite outbox (Critical)

- **Mechanism.**
  - Seven mutation endpoints still block HTTP requests on synchronous Google Drive calls: `DELETE /api/files/:id/permanent` (`purgeFile`), `DELETE /api/trash/empty` (`emptyTrash`), `POST /api/items/copy` (`copyItems`), `POST /api/accounts/:id/pool` (`switchAccountPool`), `DELETE /api/accounts/:id` (`removeDriveAccount`), OAuth import/callback (`runColdReconciliation`), and `POST /api/pools/:id/clear-share` (`clearSharePool`).
  - Meanwhile, optimized local-first operations (`moveItems`, `renameItem`, `trashFile`, `restoreFile`, `trashFolder`) fire unawaited promises with `.catch(console.error)`.
- **Fix.** Introduce a durable SQLite `drive_outbox` table (`id`, `account_id`, `op_type`, `payload_json`, `attempts`, `next_retry_at`, `status`, `last_error`) written inside the same transaction as `files`/`folders`/`accounts` changes. Commit `purgeFile`, `emptyTrash`, and `clearSharePool` to SQLite first, move `removeDriveAccount` evacuation and OAuth cold sync to tracked background jobs (`202 Accepted`), and expose queue health/retry controls via `/api/sync/status`.

### 3.3 `operations.ts` and route safety defects (High / Medium)

- **Dot-named folders dropped ([sync.ts:137-147](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/sync.ts#L137-L147)).** `ensureLocalFolderHierarchy` guesses whether a path is a file or folder via `!path.includes('.')`, silently dropping leaf folders like `/v2.0` created via `POST /api/folders`, `moveItems`, or `copyItems` while creating phantom folder rows for extensionless files like `/README`. Split into explicit `ensureLocalParentFolders` and `ensureLocalFolderPath`.
- **Missing Share Pool guards ([app.ts:875, 1128-1164](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L875-L1164)).** `DELETE /api/folders` and trash/restore/purge routes lack `isSharePoolId` `403 SHARE_POOL_READ_ONLY` guards. (`parsePoolId` at `68-71` also silently coerces malformed strings to `1` instead of `400`.)
- **Sequential `copyItems` & `moveItems` statement churn ([operations.ts:217-761](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/operations.ts#L217-L761)).** `moveItems` runs a separate transaction per item and recompiles `sqlite.prepare` per descendant row; `copyItems` runs `getAvailableCopyPath` `while(true)` probes, placement queries, Drive copies, and `pruneOldTransferLogs()` sequentially one file at a time. `restoreFile` (`406-442`) fails to strip `.trashed-<ts>` suffixes or resolve collisions.

### 3.4 Share Pool modal and execution pipeline (Critical / High)

- **Mechanism ([share.ts:239-1122](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/share.ts#L239-L1122)).**
  - `inspectSharePlan` (`527-608`) calls unthrottled `Promise.all(refreshAccountLiveQuota)` (`drive.about.get`) across every empty and Share Pool account on every Share modal open (1s to 4s delay).
  - `executeShare` (`812-1019`) runs `validateShareSelection`, then re-runs `resolveShareTargets` and `planBatchPlacement` a second time, scans all `files`/`folders` rows in JS via `loadOccupiedTopSegments`, awaits `switchAccountPool` serially, copies files serially, creates permissions serially, and leaves partial `files` committed without `share_links` if file N fails.
  - `clearSharePool` (`1021-1122`) lists and deletes Share Pool Drive entries page-by-page serially before clearing SQLite.
- **Fix.** Read cached SQLite quota in `inspectSharePlan` (or cap concurrency + 60s TTL), reuse validation/plan objects inside `executeShare`, pre-create batch folders + `anyone` permissions in parallel across accounts, parallelize `copyDriveFileCrossAccount` with concurrency 5 to 10, and commit `clearSharePool` in SQLite before background Drive deletion.

### 3.5 Streaming transfer gaps (High)

- **Mechanism ([transfer.ts:60-371](file:///D:/Projects/Tsubasa~%20Cloud/src/server/drive/transfer.ts#L60-L371), [app.ts:1060-1127](file:///D:/Projects/Tsubasa~%20Cloud/src/server/app.ts#L1060-L1127)).**
  - Neither `executeStreamingUpload` nor `getStreamingDownload` attaches `c.req.raw.signal`, leaking sockets on client abort. (`!driveRes.ok` also omits `driveRes.body?.cancel()`.)
  - `getStreamingDownload` (`365`) records full `file.sizeBytes` in `transfer_logs` before streaming starts, ignores HTTP `Range` (`206 Partial Content`), and omits RFC 5987 `filename*=UTF-8''...` in `Content-Disposition`.
  - Resumable upload rejects 0-byte `null` bodies (`app.ts:1082`), lacks hard byte-limit enforcement (`MAX_SINGLE_FILE_BYTES`), leaves displaced Drive files and double-counts quota on `.onConflictDoUpdate` overwrites (`transfer.ts:284-324`), lacks `308` resume recovery, and pays 2 RTTs even for sub-5 MB files.
  - `copyDriveFileCrossAccount` (`transfer.ts:101-140`) omits `sendNotificationEmail: false` on `permissions.create` and waits serially on `permissions.delete`.

---

## Part 4: Frontend state orchestration, API waterfalls, and upload/sync flows

Files audited: [App.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx), [api.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/client/api.ts), [main.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/main.tsx), [useTabLock.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/client/utils/useTabLock.ts), [useBeforeUnload.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/client/utils/useBeforeUnload.ts), [format.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/client/utils/format.ts), [ExternalChangesDrawer.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx), [UploadDrawer.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/UploadDrawer.tsx).

### 4.1 Tab-lock gate delays workspace mount (Critical)

- **Mechanism.** [TabLockGate](file:///D:/Projects/Tsubasa~%20Cloud/src/client/main.tsx#L28-L40) renders a blank `CheckingShell` until [useTabLock](file:///D:/Projects/Tsubasa~%20Cloud/src/client/utils/useTabLock.ts#L292-L369) completes `POST /api/instance/claim`, and statically imports `App` even for blocked tabs.
- **Fix.** Lazy-load `App` and `TabBlockedModal`, mount `App` (or start read prefetches) immediately once `navigator.locks` succeeds, and drop to `'blocked'` only if `/api/instance/claim` returns `409`. Also guard `startServerHeartbeat` against overlapping ticks, re-check on `visibilitychange`, restore on `pageshow` BFCache (`event.persisted`), and share one `BroadcastChannel` instead of opening a duplicate listener in `App.tsx:810`.

### 4.2 Serial batch HTTP loops and zero optimistic UI + Undo (Critical / High)

- **Mechanism.** [handleDeleteSelected](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L1296-L1322), [handleTrashItems](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L1394-L1415), and [handleBatchRestore](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L1617-L1621) issue sequential 1-by-1 HTTP calls inside `for...of` loops while `pendingOpsCount > 0` blocks `popstate` back/forward navigation. Create folder, rename, move, copy, empty trash, switch pool, and external changes all freeze their modals until HTTP + full-pool reload cascades (`loadFiles` + `loadClusterData` + unconditional `loadTrashFiles`) complete.
- **Fix.** Add batch server endpoints (or bounded concurrency 6 chunks with `scheduler.yield()`), mutate React `files`/`folders`/`trashedFiles`/`pools` optimistically on submit with snapshot rollback on failure, close input/confirm modals immediately, and replace the single `toastMessage`/`errorNotice` slot (`App.tsx:382`) with a non-blocking stacked toast/activity queue supporting **Undo** on trash/move and **Retry** on failed jobs. Mark trash stale with a ref instead of calling `loadTrashFiles()` outside the Trash view.

### 4.3 `UploadDrawer.tsx` unthrottled progress ticks and sequential transfers (Critical / High)

- **Mechanism.** Every `xhr.upload.onprogress` event in [UploadDrawer.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/UploadDrawer.tsx#L767-L774) calls `setFileProgress` synchronously, re-rendering the entire drawer and executing O(N) `previews.find(...)` inside `normalizedItems.map(...)` (`line 916`, O(N^2) per tick) plus per-card `<select>` option lists (`lines 992-1020`). Uploads run 1 file at a time with `useDialogLock` trapping the user inside the drawer, duplicate path keys collide (`lines 597, 606`), and no XHR cancellation or "Retry failed" mode exists.
- **Fix.** Track progress in a mutable ref flushed at most every `requestAnimationFrame` or 120ms, precompute `previewByPath` and `accountById` `Map`s, extract `React.memo` row cards (virtualized for large folder drops), assign unique item keys, parallelize uploads by target `accountId` (concurrency 3), store XHR refs for abort/retry, and allow minimizing uploads to a persistent non-blocking progress pill.

### 4.4 Redundant waterfalls, monolithic `App` state, and missing `AbortController` (High / Medium)

- **Waterfalls & discarded payloads.**
  - `checkAccountDiscrepancies` (`App.tsx:512-564`) fetches full `DiscrepancyReport` payloads per account, throws away all item arrays to keep a boolean flag, and forces [ExternalChangesDrawer](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ExternalChangesDrawer.tsx#L698-L746) to re-fetch and lock its `<select>` while reloading.
  - `presentAuthorizedAccount`, `handleCreatePool`, `handleDeletePool`, and `handleShareComplete` mutate `activePoolId` (triggering `useEffect`) *and* call `loadClusterData` / `loadFiles` imperatively, firing duplicate requests.
  - `handleSelectPool` (`App.tsx:705-737`) wipes all pool state instead of keeping an SWR / LRU cache per pool.
  - `window` focus polling (`App.tsx:842-853`) reloads cluster quota blindly every 10s without refreshing files or checking visibility.
- **Main-thread INP & cancellation.**
  - Over 35 `useState` hooks in [App.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/App.tsx#L136-L2652), un-deferred `searchQuery`, unmemoized props/handlers (`lines 2382-2510`), and `useEffect` listener churn on `handleKeyDown` (`lines 1630-1747`, which also omits `activePoolId`) re-render the full tree on every click, search keystroke, and toast.
  - Sequence counters (`filesRequestSeqRef`, etc.) never pass `AbortSignal` to `client.api...` calls, letting cancelled requests exhaust browser HTTP/1.1 connection slots.
- **Fix.** Build a shared SWR query cache (or TanStack Query) caching pools and `DiscrepancyReport`s per ID with `AbortController` cancellation, pass `useDeferredValue(searchQuery)` to `FileTable`, wrap view/pool/filter transitions in `startTransition`, split modal/toast state out of `App`, and stabilize callbacks with `useCallback` / handler refs.

---

## Part 5: Frontend UI/UX rendering, INP, and modern web platform standards

Files audited: [index.html](file:///D:/Projects/Tsubasa~%20Cloud/index.html), [vite.config.ts](file:///D:/Projects/Tsubasa~%20Cloud/vite.config.ts), [global.css](file:///D:/Projects/Tsubasa~%20Cloud/src/client/global.css), [tokens.stylex.ts](file:///D:/Projects/Tsubasa~%20Cloud/src/client/tokens.stylex.ts), [ActionPortal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ActionPortal.tsx), [FileTable.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/FileTable.tsx), [Sidebar.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx), [Header.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Header.tsx), [DitherDivider.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/DitherDivider.tsx), [RedactedEmail.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/RedactedEmail.tsx), and all 8 modals under `src/client/components/`.

### 5.1 Synchronous layout thrashing in `ActionPortal.tsx` (Critical)

- **Mechanism.** [ActionPortal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ActionPortal.tsx#L436-L673) (`syncBadgeFloorWidths`, `measureExpandedScrollWidth`, `reconcileOverflow`) clears inline `minWidth`, queries `getComputedStyle` and `getBoundingClientRect` per badge button, writes `minWidth`, immediately reads `scrollWidth`/`clientWidth`, and in compact mode temporarily mutates inline width/padding/display styles to read `getBoundingClientRect().width` off-screen. Because `layoutSignature` tracks `selectedCount`, `selectedTotalBytes`, `clipboard`, and sync state inside `useLayoutEffect` and unthrottled `ResizeObserver`, every file selection click triggers a forced read-write-read-write reflow.
- **Fix (Modern Web Standards).** Replace JS overflow measurement with CSS Container Queries (`container-type: inline-size` on the portal/action bar and `@container (max-width: ...)` rules toggling compact icon-only presentation without touching layout from JS), plus a native `popover="auto"` overflow menu when narrow viewports clip actions (replacing the current horizontal scroll + wheel hijack at `lines 649-666`).

### 5.2 Virtualized table INP: marquee drag and row rendering (High)

- **Mechanism ([FileTable.tsx:1292-1460, 1928-2519](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/FileTable.tsx#L1292-L1460)).**
  - Marquee `onMouseMove` runs unthrottled on every pointer tick, calls `getBoundingClientRect()`, interleaves `viewport.scrollTop` writes with `scrollLeft`/`scrollWidth`/`clientHeight` reads, calls `setMarqueeRect`, scans the full `items` array, and calls `onSelectMultiple` every frame (cascading into `App` and `ActionPortal` reflows).
  - Virtualized rows are rendered inline without `React.memo`, run O(N) `accounts.find(...)` and `clipboard.items.some(...)` per row (`lines 2015, 2200, 2320`), mount inline `<select>` option subtrees for every row (`lines 2416-2448`), compute `selectedInViewCount` outside `useMemo`, and render `overscan: 10` rows offscreen.
- **Fix.** Throttle marquee updates via `requestAnimationFrame`, cache `viewportRect` on `mousedown`, position the marquee rectangle via DOM ref `transform`/`width`/`height`, compute hit row indices in O(1) math (`top / rowHeight`), and dispatch `onSelectMultiple` only when `[startIdx, endIdx]` changes. Extract `React.memo` row components fed by `Map`/`Set` lookups, lower `overscan` to `4` or `5`, and replace per-row `<select>` trees with one shared `popover` account-transfer menu anchored on click.

### 5.3 Top Layer overlays (`<dialog>` / `popover`), focus management, and keyboard navigation (High / Medium)

- **Native `<dialog>` vs custom overlays.** All 8 modals ([ShareModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ShareModal.tsx), [MoveFilesModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/MoveFilesModal.tsx), [MovePoolModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/MovePoolModal.tsx), [NewFolderModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/NewFolderModal.tsx), [RenameModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/RenameModal.tsx), [ConfirmDriveActionModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ConfirmDriveActionModal.tsx), [ConfirmPurgeModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/ConfirmPurgeModal.tsx), [TabBlockedModal.tsx](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/TabBlockedModal.tsx)) use fixed `<div>` wrappers + `useDialogLock` Esc listeners + `setTimeout(..., 50)` focus hacks, with zero Tab focus trapping and zero focus restoration. Migrating to a shared `<dialog>` wrapper using `showModal()`, `closedby={isBusy ? 'none' : 'any'}` (with pointer-bounds fallback for Safari), `autofocus`, `dialog:modal { overscroll-behavior: contain }`, and `dialog::backdrop { overflow: hidden; overscroll-behavior: contain }` delegates inertness, focus trapping, `Esc`, and focus return to the browser Top Layer.
- **Popovers & mobile drawer.** Move toasts (`zIndex: 10000` in `App.tsx`) to `popover="manual"` so they remain visible above Top Layer `<dialog>` modals. Migrate mobile `Sidebar` (`<= 768px`) to `<dialog>` or `popover="manual"` drawer semantics with focus/Esc handling.
- **ARIA grid, shortcuts, and layout-stable banners.** Complete `role="grid"` / `role="row"` / `role="gridcell"` + `aria-rowcount` / `aria-rowindex` in `FileTable.tsx`, add roving `tabIndex` (or `aria-activedescendant`, also needed in `ShareModal` virtualized drive list), skip `select` in `FileTable` arrow-key handler (`line 1485`), guard `App.tsx:1630` shortcuts against focused `button`/`select`/`a`/`dialog[open]`, associate modal `<label htmlFor>` attributes, add `aria-pressed` on `Header` theme buttons, add `:focus-visible` and >= 36px coarse-pointer targets to row/mini action buttons, and reserve fixed-height modal status/error regions so errors never jump buttons under the pointer.

### 5.4 CSS containment, view state caching, fonts, paint, and bundle splitting (High / Medium)

- **Critical font path ([index.html](file:///D:/Projects/Tsubasa~%20Cloud/index.html), [global.css](file:///D:/Projects/Tsubasa~%20Cloud/src/client/global.css#L1-L23)).** Serves 1.47 MB of uncompressed `.ttf` variable fonts including a 701 KB italic font used in one CSS rule ([Sidebar.tsx:474](file:///D:/Projects/Tsubasa~%20Cloud/src/client/components/Sidebar.tsx#L474)), with zero `<link rel="preload" crossorigin>`. Subset/convert to `.woff2`, drop the unused italic font file, and preload the primary Latin `.woff2`.
- **Paint, StyleX `@layer` cascade, and motion.** Replace `.grain-overlay` inline SVG `feTurbulence` (`zIndex: 9999`) with a static pre-rendered tile or panel background; replace `DitherDivider.tsx`'s JS `ImageData` pixel loop with CSS `background-repeat` tiling; fix `Sidebar` quota bar transitions to animate compositor-only `transform: scaleX(...)` instead of `width`; move unlayered `button:hover { background-color: unset; }` out of `global.css` (`lines 128-134`, which overrides `@layer` StyleX active button backgrounds on touch devices) into `@media (hover: hover) and (pointer: fine)` StyleX rules; and add global `@media (prefers-reduced-motion: reduce)` handling plus `@starting-style` / optional `document.startViewTransition` (`prefers-reduced-motion: no-preference`).
- **Containment & View caching.** Add `contain: layout style paint` on `Header`, `ActionPortal`, and `Sidebar` shells, `content-visibility: auto; contain-intrinsic-size: auto 140px` on sidebar `accountCard` nodes, and consider keeping Drive vs Trash views mounted with `content-visibility: hidden` + `inert` for instant back-and-forth switches that preserve scroll position and virtualizer state.
- **Bundle & modal hygiene.** Add `manualChunks` (`react-vendor`, `virtualizer`, `hono`) in [vite.config.ts](file:///D:/Projects/Tsubasa~%20Cloud/vite.config.ts), `React.lazy` modals/drawers in `App.tsx` (mounting only when opened so closed 1,451-line `ShareModal` hooks do not run on every table render), debounce `share.validate` + cache `inspectData` by item signature in `ShareModal.tsx`, fix `authUrls` dependency feedback loop in `Sidebar.tsx:1088-1102`, early-exit `RedactedEmail.tsx` `selectionchange` on collapsed selections, and archive the 5 unused `tokens.*.stylex.ts` reference files outside `src/client/`.

---

## Part 6: Recommended execution roadmap

Following `.agents/AGENTS.md` (small logical slices, one owner per concern, downstream typecheck/runtime safety after schema or route updates), execute improvements in three ordered waves:

1. **Wave 1: Data Integrity, Durable Sync Queue, and Critical Backend Speedups**
   - *DB & Indexes (`src/server/db/*`, `src/server/storage/*`):* Fix `renameAccountInDb` (`share_links` + `.immediate()` + hoisted prepares), add composite/covering indexes, switch `LIKE` prefix queries to `BINARY` `[prefix, upperBound)` range helpers, pre-compute pool folder affinity once per batch, aggregate 24h `transfer_logs` in SQL, throttle `pruneOldTransferLogs`, and guard `init.ts` DDL with `user_version`.
   - *Durable Outbox & Rate-Limit Backoff (`src/server/drive/client.ts`, `mirror.ts`, `detector.ts`, `operations.ts`):* Add jittered exponential backoff for `429`/`5xx`, replace `resolveRemoteFolderTree` global Drive crawls with parent-scoped BFS, add single-flight `inFlightFolderPromises` in `mirror.ts`, fix `getStartPageToken` ordering + `pageSize: 1000` + `410` fallback + `drive_folder_id` mapping in `sync.ts`/`delta.ts`, move startup hydration to bounded background workers, and back local-first writes + `purgeFile`/`emptyTrash`/`clearSharePool` with a SQLite `drive_outbox` table and scan-generation invalidation.
2. **Wave 2: API Payloads, Share/Upload Concurrency, and Instant Optimistic UI**
   - *Hono API & Transfers (`src/server/app.ts`, `transfer.ts`, `share.ts`, `auth.ts`):* Remove `authPool.scan()` from `GET /api/accounts` and `GET /api/pools`, project columns and honor `?path=` / ETag / `hono/compress` on `/api/files`, eliminate `about.get` bursts in `inspectSharePlan`, parallelize `executeShare` and `rebalanceFilesBatch` safely (DB before source delete, `sendNotificationEmail: false`), and add `AbortSignal` + `Range` (`206`) + post-stream byte logging to transfers.
   - *Client State & Uploads (`src/client/main.tsx`, `useTabLock.ts`, `App.tsx`, `ExternalChangesDrawer.tsx`, `UploadDrawer.tsx`):* Remove `TabLockGate` startup RTT block, adopt SWR caching + `AbortController` cancellation across pool/account switches and discrepancy reports, replace serial batch loops with batch/concurrent requests + optimistic UI + Undo/Retry toast queue, pass `useDeferredValue(searchQuery)` + `startTransition`, throttle `UploadDrawer` progress via rAF + O(1) maps + per-account upload concurrency.
3. **Wave 3: 60fps UI Rendering and Modern Web Platform Standards**
   - *Layout & Virtual Grid (`ActionPortal.tsx`, `FileTable.tsx`, `Sidebar.tsx`, `DitherDivider.tsx`, `RedactedEmail.tsx`):* Eliminate `ActionPortal` JS layout thrashing via CSS Container Queries + `popover="auto"` overflow menu, throttle `FileTable` marquee via rAF + O(1) row math, extract `React.memo` virtual rows with single transfer `popover`, add CSS containment + `content-visibility`, replace canvas `DitherDivider` and SVG `feTurbulence` grain.
   - *Overlays, Fonts, A11y & Bundling (`index.html`, `vite.config.ts`, `global.css`, `Header.tsx`, Modals):* Convert 8 modals to shared native `<dialog>` (`showModal()` + `closedby` + `@starting-style`), move toasts to `popover="manual"`, complete ARIA grid + roving tabindex + shortcut scoping, convert/subset fonts to preloaded WOFF2, fix StyleX `@layer` touch hover overrides, and split Vite vendor + lazy modal chunks.
