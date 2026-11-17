# Drag and drop for Trash and All files implementation audit

## 1. Scope and architecture analysis

**Objective:** Enable dragging and dropping files and folders into `Trash` and `All files`, including dragging items from `Trash` to `All files` (restoring and placing at root `/`), dragging items within `All files` to `All files` (moving to root `/`), and dragging items from `All files` to `Trash` (soft-trashing files and folders). Fix the bug where the "Drop files to upload" overlay appears when dragging internal app items (`application/x-tsubasa-items`) instead of external OS files.

**Affected subsystems:**
- Backend item operations and transfer lifecycle (`src/server/drive/operations.ts`, `src/server/drive/transfer.ts`).
- Frontend virtualized file table (`src/client/components/FileTable.tsx`).
- Frontend sidebar navigation (`src/client/components/Sidebar.tsx`) and breadcrumb action portal (`src/client/components/ActionPortal.tsx`).
- Frontend application controller (`src/client/App.tsx`).

**Database and contract impact:**
- **Table `files` (`src/server/db/schema.ts`):**
  - `id` (`text`, primary key)
  - `virtual_path` (`text`, not null, unique, indexed via `files_path_idx`)
  - `folder_id` (`text`, nullable foreign key referencing `folders.id` with `onDelete: 'set null'`, indexed via `files_folder_idx`)
  - `is_trashed` (`integer` boolean mode, not null, default `0`, indexed via `files_trashed_idx`)
  - `trashed_at` (`integer` timestamp mode, nullable)
- **Table `folders` (`src/server/db/schema.ts`):**
  - `id` (`text`, primary key, stores normalized `virtual_path`)
  - `virtual_path` (`text`, not null, unique, indexed via `folders_path_idx`)
  - `parent_folder_id` (`text`, nullable, indexed via `folders_parent_idx`)
- **RPC routes (`src/server/app.ts`):**
  - `POST /api/items/move`: Accepts `{ items: Array<{ kind: 'file' | 'folder'; id: string }>, targetFolderPath: string }`. Returns `{ results: MoveResult[] }`. When `moveItems` processes a trashed file (`isTrashed === true`), it must clear `is_trashed = 0` and `trashed_at = NULL` while updating `virtual_path` and `folder_id` (setting `folder_id = NULL` when `targetFolderPath === '/'`), and pass `trashed: false` in the background Google Drive `files.update` call.
  - `POST /api/files/:id/trash`: Soft-trashes a single file (`is_trashed = 1`).
  - `DELETE /api/folders`: Soft-trashes a folder and its descendant files (`?virtualPath=...`).

**Architectural constraints:**
- Local-first SQLite mutations must complete inside synchronous `better-sqlite3` transactions while Google Drive metadata updates run without blocking the UI.
- All styling must use compile-time StyleX (`@stylexjs/stylex`) consuming tokens from `src/client/tokens.stylex.ts` with WCAG AAA contrast in light and dark modes.
- TanStack Virtual row virtualization in `FileTable.tsx` must remain constant-time with zero extra DOM wrappers.

## 2. Logical implementation slices

### Slice 1: Backend move-from-trash and resilient soft-trash operations
- **File ownership:**
  - `src/server/drive/operations.ts`
  - `src/server/drive/transfer.ts`
- **Detailed implementation plan:**
  1. In `src/server/drive/operations.ts` (`moveItems`):
     - When `resolvedKind === 'file'`, check `const wasTrashed = Boolean(file.isTrashed)`.
     - Only short-circuit on `newVirtualPath === file.virtualPath` when `!wasTrashed`. If `wasTrashed` is true and `newVirtualPath === file.virtualPath` (for example, a file originally at `/report.pdf` was trashed and is now dragged to `All files` `/`), proceed with the update so the file is un-trashed at `/report.pdf`.
     - Inside the SQLite transaction before updating `files.virtual_path = newVirtualPath`, check if another trashed file (`is_trashed = 1 AND id != file.id`) currently holds `virtual_path = newVirtualPath`. If so, update that colliding trashed row's `virtual_path` to `${newVirtualPath}.trashed-${ Date.now() }` so the `UNIQUE` constraint on `files.virtual_path` is never violated.
     - Update the moved file row with `UPDATE files SET virtual_path = ?, folder_id = ?, is_trashed = 0, trashed_at = NULL, updated_at = unixepoch() WHERE id = ?`.
     - In the asynchronous Google Drive update block, include `...(wasTrashed ? { trashed: false } : {})` in `requestBody` alongside `appProperties`.
  2. In `src/server/drive/transfer.ts` (`trashFile` and `restoreFile`):
     - Wrap the `getDriveClient(file.accountId)` and `drive.files.update(...)` calls in `try { ... } catch (err) { console.warn(...); }` (matching `trashFolder` in `src/server/drive/operations.ts`) so local SQLite soft-trash and restore operations succeed even when an account is offline or uses local test credentials.
- **Tasks:**
  - [x] Update `moveItems` in `src/server/drive/operations.ts` to un-trash files moved from Trash and handle `virtual_path` uniqueness against older trashed records.
  - [x] Wrap remote Drive calls in `trashFile` and `restoreFile` in `src/server/drive/transfer.ts` with `try / catch` warnings.
- **Verification:** `npx tsc --noEmit`

### Slice 2: FileTable internal drag fix and draggable Trash rows
- **File ownership:**
  - `src/client/components/FileTable.tsx`
- **Detailed implementation plan:**
  1. Add helper predicates in `src/client/components/FileTable.tsx`:
     - `isInternalItemDrag(e)`: returns `Boolean(e.dataTransfer?.types?.includes('application/x-tsubasa-items'))`.
     - `isExternalFileDrag(e)`: returns `Boolean(e.dataTransfer?.types?.includes('Files') && !e.dataTransfer?.types?.includes('application/x-tsubasa-items'))`.
  2. Fix the "Drop files to upload" bug on `emptyState` and `emptyDropZone`:
     - In `onDragEnter` and `onDragOver` for both `emptyState` and `emptyDropZone`, check `if (isTrashView || !isExternalFileDrag(e))`. If `!isExternalFileDrag(e)`, ensure `isDropZoneActive` is `false` and do not show the upload drop box.
     - In `handleDrop`, only run the external file upload extraction branch when `isExternalFileDrag(e)` is true.
     - On `__parent__` and `folder` row `onDragOver` handlers, set `e.dataTransfer.dropEffect = isInternalItemDrag(e) ? 'move' : 'copy'`.
  3. Enable dragging items from Trash view (`isTrashView === true`):
     - In `handleRowDragStart`, remove the `if (isTrashView) return;` guard.
     - Accept `item: { kind: 'file' | 'folder'; id: string; name: string; virtualPath: string; isTrashed?: boolean }`.
     - When building `dragPayload` for multi-selection (`isItemSelected && selectedIds.size > 1`), map `kind: it.kind === 'folder' ? 'folder' : 'file'` and `...(it.kind === 'trash' ? { isTrashed: true } : {})`.
     - On `item.kind === 'trash'` rows, add `draggable={true}` and `onDragStart={(e) => handleRowDragStart(e, { kind: 'file', id: file.id, name: file.name, virtualPath: file.virtualPath, isTrashed: true })}`.
- **Tasks:**
  - [x] Gate `isDropZoneActive` ("Drop files to upload") strictly on `isExternalFileDrag(e)` in `emptyState` and `emptyDropZone`.
  - [x] Enable row dragging for `item.kind === 'trash'` and multi-select in `handleRowDragStart`.
- **Verification:** `npx tsc --noEmit`

### Slice 3: Sidebar, ActionPortal, and App drop targets for Trash and All files
- **File ownership:**
  - `src/client/components/Sidebar.tsx`
  - `src/client/components/ActionPortal.tsx`
  - `src/client/App.tsx`
- **Detailed implementation plan:**
  1. In `src/client/components/Sidebar.tsx`:
     - Extend `SidebarProps` with optional callbacks:
       - `onDropItemsToRoot?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;`
       - `onDropItemsToTrash?: (items: Array<{ kind: 'file' | 'folder'; id: string; name?: string; virtualPath?: string; isTrashed?: boolean }>) => void;`
       - `onDropExternalToRoot?: (dataTransfer: DataTransfer) => void;`
     - Track `dragOverNav: 'files' | 'trash' | null` state and reset it on `window` `dragend` and `dragleave`.
     - Add StyleX rules `navItemDragOver` (`backgroundColor: colors.brandAccentSurface`, `color: colors.brandAccent`, `borderLeftColor: colors.accentGold`) and `navItemDragOverTrash` (`backgroundColor: colors.dangerSurface`, `color: colors.danger`, `borderLeftColor: colors.danger`).
     - Wire `onDragOver`, `onDragLeave`, and `onDrop` on the `All files` button:
       - Accepts `application/x-tsubasa-items` (`dropEffect = 'move'`) in any view (`files` or `trash`) and calls `onDropItemsToRoot(parsed)`.
       - Accepts external `Files` (`dropEffect = 'copy'`) and calls `onDropExternalToRoot(e.dataTransfer)`.
     - Wire `onDragOver`, `onDragLeave`, and `onDrop` on the `Trash` button:
       - Accepts `application/x-tsubasa-items` when `currentNav !== 'trash'` (`dropEffect = 'move'`) and calls `onDropItemsToTrash(parsed)`.
  2. In `src/client/components/ActionPortal.tsx`:
     - Remove `if (isTrashView) return;` from `handleBreadcrumbDragOver` and `handleBreadcrumbDrop` so the `All files` breadcrumb button (`index === -1`) accepts drops even when viewing `Trash`.
     - Guard `handleBreadcrumbDragOver` so it only activates when `e.dataTransfer.types.includes('application/x-tsubasa-items')` or `e.dataTransfer.types.includes('Files')`. Set `dropEffect` to `'move'` for internal items and `'copy'` for external files.
     - Mark `(e.nativeEvent as any).__tsubasaHandled = true` inside `handleBreadcrumbDrop` and reset `dragOverIndex` on `window` `dragend`.
  3. In `src/client/App.tsx`:
     - In `handleWindowDragOver` and `handleWindowDrop`, ignore internal drags (`if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;`).
     - Update `handleMoveItems` to also refresh `loadTrashFiles()` and `loadClusterData()` (`await Promise.all([loadFiles(currentPath), loadTrashFiles(), loadClusterData()])`) so moving/restoring a file from Trash to `All files` (`/`) updates both views and storage counters immediately.
     - Implement `handleTrashItems` to soft-trash dropped files (`POST /api/files/:id/trash`) and folders (`DELETE /api/folders`), clear trashed IDs from `selectedIds` and `clipboard`, navigate to a surviving parent folder if `currentPath` was inside a trashed folder, refresh `loadFiles`, `loadTrashFiles`, and `loadClusterData`, and show a toast message.
     - Pass `onDropItemsToRoot={(items) => handleMoveItems(items, '/')}`, `onDropItemsToTrash={handleTrashItems}`, and `onDropExternalToRoot={(dt) => handleDropExternalToPath('/', dt)}` to `Sidebar`.
- **Tasks:**
  - [x] Add `All files` and `Trash` drop target handlers and StyleX highlight states in `src/client/components/Sidebar.tsx`.
  - [x] Allow dropping onto the `All files` breadcrumb in `src/client/components/ActionPortal.tsx` from both `All files` and `Trash` views.
  - [x] Wire `handleTrashItems` and root drop handlers in `src/client/App.tsx` and refresh trash state in `handleMoveItems`.
- **Verification:** `npx tsc --noEmit`

## 3. Runtime verification plan

1. Run `npm run build` to verify TypeScript compilation (`tsc --noEmit`), Vite client bundle + StyleX compilation (`vite build`), and server compilation (`tsc -p tsconfig.server.json`).
2. Execute a runtime verification script (`npx tsx -e "..."`) against the Hono app (`src/server/app.ts`) and SQLite database to verify:
   - Moving a file and a folder from a subfolder (`/projects/demo`) to root (`/`) via `POST /api/items/move` (`All files` to `All files` root placement).
   - Soft-trashing a file (`POST /api/files/:id/trash`) and a folder (`DELETE /api/folders?virtualPath=...`) (`All files` to `Trash`).
   - Moving/restoring a trashed file (originally in `/projects/demo/spec.md` and another originally at `/rootfile.txt`) to root (`/`) via `POST /api/items/move` with `targetFolderPath: '/'` (`Trash` to `All files`), confirming `isTrashed === false`, `virtualPath === '/spec.md'`, `folderId === null`, and zero SQLite constraint errors.

## 4. Final audit and verdict

**Verdict: Pass**
- `npm run build` (`tsc --noEmit`, `vite build`, and `tsc -p tsconfig.server.json`) passed with zero errors.
- Runtime verification script against Hono and SQLite passed all assertions (`ALL_DND_RUNTIME_CHECKS_PASSED`) with sub-15ms latency.
- Working tree diff audited across all 6 touched source files with zero architectural drift or stray files.
