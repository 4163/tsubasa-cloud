# Decoupling parity audit and runtime report

Audit date: 2026-11-18
Branch: `refactor/decouple-monoliths` (0 commits ahead of `main` at `fdcfcb3`, 31 modified tracked files and 66 untracked files in the working tree)
Scope: Read-only parity audit, isolated `:memory:` runtime verification, and post-fix resolution review. No source files were edited by the audit swarm.

## Verdict

**Pass (agreed with all resolutions).** Both parity findings and all six hygiene items from the initial pass have been resolved and verified in source, TypeScript checks, production build, and `:memory:` SQLite execution.

## Resolved findings

### Parity items

1. **Browser history popstate guard lag (`src/client/App.tsx:322,352,633`, `src/client/hooks/useWorkspaceNavigation.ts:32,45,210-217,228`).**
   Resolved. `App.tsx` now passes `isPopStateBlockedRef` (`React.RefObject<boolean>`) instead of `isPopStateBlockedRef.current`, and `handlePopState` reads `popStateGuardRef.current.isPopStateBlockedRef.current`. Because `App.tsx:633` updates `isPopStateBlockedRef.current` synchronously on every render, `handlePopState` always reads the current render's guard value.
2. **`displaceTrashedFileAtPath` suffix and `updated_at` parity (`src/server/drive/operationsDb.ts:88-99,298-316`, `src/server/drive/transfer.ts:446`, `src/server/drive/trash.ts:118-121`).**
   Resolved. All four prepared statements in `operationsDb.ts` now set `updated_at = unixepoch()`. Adding `appendShortId?: boolean` routes `transfer.ts:446` and `trash.ts:118-121` to the `WithId` statements (`'-' || substr(id, 1, 6)`), matching `main` while leaving copy, move, rename, and detector callers unchanged.

### Hygiene items

- **`src/client/utils/queryCache.ts:1-20`.** Removed the unused type barrel re-export shim.
- **`src/client/components/RenameModal.tsx:7`.** Replaced the duplicate `RenameTarget` interface with `import type { RenameTarget } from '../types.js'`.
- **`src/client/components/MoveConflictModal.tsx:8-11`.** Removed the duplicate `MoveConflictContentMatch`, `MoveConflictItem`, and `MoveConflictResolutionMode` definitions and imported `MoveConflictItem` and `MoveConflictResolutionMode` from `../types.js`.
- **`src/client/components/MoveFilesModal.tsx:11`.** Removed the duplicate `MoveFileItem` interface and imported `MoveFileItem` from `../types.js`.
- **`src/client/components/Header.tsx:5` and `src/client/hooks/useResolvedTheme.ts:14`.** Replaced the duplicate `ThemeChoice` type in `Header.tsx` with `import type { ThemeChoice } from '../utils/theme.js'` and removed the unused `EffectiveTheme`/`ThemeChoice` re-export from `useResolvedTheme.ts`.
- **`src/server/drive/backgroundJobs.ts:17`.** Removed the unused `BackgroundJob` type alias.

## Verified parity areas

- **Branch naming and docs.** `refactor/decouple-monoliths` follows the `refactor/<topic>` pattern from PR #2 (`refactor/pipeline-perf-ux`), and `docs/` has no non-parity divergence doc.
- **Zero dropped functions or broken references.** Moved symbols such as `displaceTrashedFileAtPath` (`src/server/drive/operationsDb.ts:298`) and `ShareInspectResponse`/`ShareExecuteResult` (`src/client/types.ts:269,188`) are wired to their new owners, and zero references remain to deleted interim hooks (`useItemMutations`, `usePoolAccountActions`) or the old `isPopStateBlocked` prop name.
- **Hono routes and `AppType` RPC.** All 59 routes from `main:src/server/app.ts` exist across the 12 `src/server/routes/*.ts` routers with matching paths, HTTP methods, status codes, static-before-param ordering (`accounts.ts:31-277`, `sync.ts:17-77`), middleware (`compress`, conditional `httpLogger`, `cors` in `src/server/app.ts:18-45`), and chained `AppType` inference consumed by `src/client/api.ts:1-8`.
- **Shared server helpers and transactions.** `allocateUniqueVirtualPath` (`src/server/drive/operationsDb.ts:263-288`), `operationsMovePlan.ts` and `operationsMove.ts` (`MoveConflictError`, `evaluateFileContentMatch`, SQLite `.immediate()` transactions with `defer_foreign_keys = ON`, `outboxQueue` payloads), and `accountLifecycle.ts:9-157` match `main`.
- **Client hooks, StyleX, and TanStack Virtual.** `App.tsx` `uiCallbacksRef` and ref proxies, `Sidebar.tsx` `auth-url` delegation and `SidebarAccountCard.tsx`, `useDialogLifecycle.ts` options across `ModalDialog.tsx`, `DrawerPrimitives.tsx`, and `Sidebar.tsx`, `FileTable.tsx` (`FileTableRows.tsx`, `useMarqueeSelection.ts`, `useTableKeyboardNav.ts`, `useHorizontalWheelScroll.ts`, `fileTableSort.ts`), `ActionPortal.tsx`, `useUploadRunner.ts` `409 FOLDER_EXISTS`, StyleX tokens, and `useVirtualizer` lists preserve parity.

## Build and runtime verification

### Post-fix verification

- **Typecheck and production build.** `npm run build` (`tsc --noEmit`, `vite build`, `tsc -p tsconfig.server.json`) exited 0 after all fixes. `npx tsc -p tsconfig.server.json --noEmit --noUnusedLocals` exited 0, and `npx tsc --noEmit --noUnusedLocals` reported only the 5 pre-existing allowlisted `TS6133` unused default `React` imports (`AccountAvatar.tsx`, `ConfirmDriveActionModal.tsx`, `ConfirmPurgeModal.tsx`, `Header.tsx`, `MoveConflictModal.tsx`).
- **Isolated `:memory:` SQLite check for `displaceTrashedFileAtPath`.** Executed all four `displaceTrashedFileAtPath` branches against `dist/server/drive/operationsDb.js` (`appendShortId: true` and omitted, `excludeFileId` set and omitted); all four rows updated `virtual_path` (with `-<6-char id>` only when `appendShortId: true`) and bumped `updated_at`.

### Initial audit runtime suite (isolated `:memory:`, pre-fix)

Run with `TSUBASA_DB_PATH=:memory:` and an isolated working directory importing `dist/server/app.js` + `initializeDatabase()` with `stopOutboxWorker()`, without running `dist/server/index.js` or `hydratePool1Startup()`:

- **HTTP API checks (14/14 passed).** Covered all 12 split routers, static-before-param routing (`/api/accounts/pool`, `/api/accounts/auth-url/:id`, `/api/sync/status`, `/api/sync/outbox/retry`, `/api/sync/all`), ETag/304 responses (`folders`, `files`, `trash`), Share Pool read-only guards (`403 SHARE_POOL_READ_ONLY`, `403 SHARE_POOL_PROTECTED`), error codes (`400`, `403`, `404`, `409 MOVE_CONFLICT`, `409 FOLDER_EXISTS`, `409 ACCOUNT_POOL_LOCKED`, `507 INSUFFICIENT_STORAGE`), and `hc<AppType>` client calls.
- **Headless Chrome UI checks (14/14 passed).** Tested built `dist/` served on `127.0.0.1:0` (with `GET /api/sync/external-changes/*` route-mocked to a `DiscrepancyReport` fixture), with 0 `pageErrors` and 0 unexpected `consoleErrors` (only the expected HTTP 409 console log when triggering `MoveConflictModal`). Verified `FileTable` keyboard navigation (`Home`, `Shift+ArrowDown`, `End`, `Control+a`, type-ahead), marquee drag selection, lazy overlays (`NewFolderModal`, `RenameModal`, `MoveFilesModal`, `ShareModal`, `UploadDrawer`, `MoveConflictModal`, `ExternalChangesDrawer`, `MovePoolModal`, `ConfirmDriveActionModal`, `ConfirmPurgeModal`, `TabBlockedModal` via second tab), and `<768px` (`390x844`) mobile drawer open, nav switch, and `Escape` close.
- **Not exercised without live Google OAuth.** Live Drive upload/download byte streaming, `/api/auth/callback` token exchange, live `changes.list` incremental or cold sync, live discrepancy scanning, live cross-account rebalance/evacuation/share-execute Drive mutations, and outbox worker Drive drain.
