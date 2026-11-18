import { Suspense, lazy } from 'react';
import type {
  AccountItem,
  ClientFileRecord,
  PoolSummary,
  RenameTarget,
  SelectedAccountGroup,
  ShareExecuteResult,
  ShareTargetItem,
  StagedItem,
} from '../types.js';
import type { DriveActionModalState } from '../hooks/useAccountLifecycle.js';
import type { ExternalChangesAccountOption } from '../hooks/useExternalChanges.js';
import type { PendingMoveConflict } from '../hooks/useItemCrudAndTransfer.js';
import type { MoveConflictResolutionMode } from '../types.js';

const UploadDrawer = lazy(() =>
  import('./UploadDrawer.js').then((m) => ({ default: m.UploadDrawer }))
);
const ExternalChangesDrawer = lazy(() =>
  import('./ExternalChangesDrawer.js').then((m) => ({ default: m.ExternalChangesDrawer }))
);
const NewFolderModal = lazy(() =>
  import('./NewFolderModal.js').then((m) => ({ default: m.NewFolderModal }))
);
const ConfirmPurgeModal = lazy(() =>
  import('./ConfirmPurgeModal.js').then((m) => ({ default: m.ConfirmPurgeModal }))
);
const ConfirmDriveActionModal = lazy(() =>
  import('./ConfirmDriveActionModal.js').then((m) => ({
    default: m.ConfirmDriveActionModal,
  }))
);
const RenameModal = lazy(() =>
  import('./RenameModal.js').then((m) => ({ default: m.RenameModal }))
);
const MovePoolModal = lazy(() =>
  import('./MovePoolModal.js').then((m) => ({ default: m.MovePoolModal }))
);
const MoveFilesModal = lazy(() =>
  import('./MoveFilesModal.js').then((m) => ({ default: m.MoveFilesModal }))
);
const MoveConflictModal = lazy(() =>
  import('./MoveConflictModal.js').then((m) => ({ default: m.MoveConflictModal }))
);
const ShareModal = lazy(() =>
  import('./ShareModal.js').then((m) => ({ default: m.ShareModal }))
);

export interface WorkspaceOverlaysProps {
  currentPath: string;
  currentNav: 'files' | 'trash';
  activePoolId: number;
  pools: PoolSummary[];
  accountItems: AccountItem[];

  isUploadDrawerOpen: boolean;
  onCloseUploadDrawer: () => void;
  stagedFiles: Array<File | StagedItem>;
  stagedEmptyFolders: string[];
  uploadTargetPath: string | undefined;
  onUploadComplete: () => Promise<void>;
  onClearUploadFiles: () => void;

  isExternalChangesOpen: boolean;
  onCloseExternalChanges: () => void;
  externalChangesAccounts: ExternalChangesAccountOption[];
  externalChangesAccountId: string | undefined;
  isMobileSidebarOpen: boolean;
  onExternalChangesResolved: (summary?: {
    accountId: string;
    remainingCount: number;
    refreshFiles?: boolean;
  }) => Promise<void>;

  isNewFolderOpen: boolean;
  onCloseNewFolder: () => void;
  onCreateFolder: (folderName: string) => Promise<void>;

  renameModalItem: RenameTarget | null;
  onCloseRenameModal: () => void;
  onRename: (kind: 'file' | 'folder' | 'pool', id: string, newName: string) => Promise<void>;

  movePoolTargetAccount: AccountItem | null;
  onCloseMovePool: () => void;
  onConfirmMovePool: (accountId: string, targetPoolId: number) => Promise<void>;

  moveFilesModalGroup: SelectedAccountGroup | null;
  onCloseMoveFilesModal: () => void;
  modalFiles: ClientFileRecord[];
  onConfirmMoveFiles: (fileIds: string[], targetAccountId: string) => Promise<void>;

  pendingMoveConflict: PendingMoveConflict | null;
  isResolvingMoveConflict: boolean;
  onCloseMoveConflict: () => void;
  onResolveMoveConflict: (mode: MoveConflictResolutionMode) => Promise<void>;

  confirmEmptyTrash: boolean;
  onCloseEmptyTrash: () => void;
  onConfirmEmptyTrash: () => Promise<void>;
  trashedFilesCount: number;
  trashedTotalBytes: number;

  pendingPurgeFiles: ClientFileRecord[] | null;
  onClosePurgeFiles: () => void;
  onConfirmPurgeFiles: () => Promise<void>;
  pendingPurgeTotalBytes: number;

  shareModalState: { items: ShareTargetItem[]; sourcePoolId: number } | null;
  onCloseShareModal: () => void;
  onShareComplete: (result: ShareExecuteResult) => Promise<void>;

  isClearSharePoolOpen: boolean;
  onCloseClearSharePool: () => void;
  onConfirmClearSharePool: () => Promise<void>;
  sharePoolTotalItemCount: number;
  sharePoolTotalBytes: number;

  driveActionModal: DriveActionModalState;
  onCloseDriveAction: () => void;
  onConfirmDriveAction: () => Promise<void>;
  driveFilesCount: number;
  driveTotalBytes: number;
}

export function WorkspaceOverlays({
  currentPath,
  currentNav,
  activePoolId,
  pools,
  accountItems,
  isUploadDrawerOpen,
  onCloseUploadDrawer,
  stagedFiles,
  stagedEmptyFolders,
  uploadTargetPath,
  onUploadComplete,
  onClearUploadFiles,
  isExternalChangesOpen,
  onCloseExternalChanges,
  externalChangesAccounts,
  externalChangesAccountId,
  isMobileSidebarOpen,
  onExternalChangesResolved,
  isNewFolderOpen,
  onCloseNewFolder,
  onCreateFolder,
  renameModalItem,
  onCloseRenameModal,
  onRename,
  movePoolTargetAccount,
  onCloseMovePool,
  onConfirmMovePool,
  moveFilesModalGroup,
  onCloseMoveFilesModal,
  modalFiles,
  onConfirmMoveFiles,
  pendingMoveConflict,
  isResolvingMoveConflict,
  onCloseMoveConflict,
  onResolveMoveConflict,
  confirmEmptyTrash,
  onCloseEmptyTrash,
  onConfirmEmptyTrash,
  trashedFilesCount,
  trashedTotalBytes,
  pendingPurgeFiles,
  onClosePurgeFiles,
  onConfirmPurgeFiles,
  pendingPurgeTotalBytes,
  shareModalState,
  onCloseShareModal,
  onShareComplete,
  isClearSharePoolOpen,
  onCloseClearSharePool,
  onConfirmClearSharePool,
  sharePoolTotalItemCount,
  sharePoolTotalBytes,
  driveActionModal,
  onCloseDriveAction,
  onConfirmDriveAction,
  driveFilesCount,
  driveTotalBytes,
}: WorkspaceOverlaysProps) {
  return (
    <Suspense fallback={null}>
      {isUploadDrawerOpen && (
        <UploadDrawer
          isOpen={isUploadDrawerOpen}
          onClose={onCloseUploadDrawer}
          stagedFiles={stagedFiles}
          stagedEmptyFolders={stagedEmptyFolders}
          currentPath={uploadTargetPath ?? currentPath}
          accounts={accountItems}
          poolId={activePoolId}
          onUploadComplete={onUploadComplete}
          onClearFiles={onClearUploadFiles}
        />
      )}

      {isExternalChangesOpen && (
        <ExternalChangesDrawer
          isOpen={isExternalChangesOpen}
          onClose={onCloseExternalChanges}
          accounts={externalChangesAccounts}
          initialAccountId={externalChangesAccountId}
          isMobileSidebarOpen={isMobileSidebarOpen}
          onResolved={onExternalChangesResolved}
        />
      )}

      {isNewFolderOpen && (
        <NewFolderModal
          isOpen={isNewFolderOpen}
          onClose={onCloseNewFolder}
          currentPath={currentPath}
          onCreateFolder={onCreateFolder}
        />
      )}

      {renameModalItem !== null && (
        <RenameModal
          isOpen={renameModalItem !== null}
          onClose={onCloseRenameModal}
          item={renameModalItem}
          onRename={onRename}
        />
      )}

      {movePoolTargetAccount !== null && (
        <MovePoolModal
          isOpen={movePoolTargetAccount !== null}
          onClose={onCloseMovePool}
          account={movePoolTargetAccount}
          pools={pools}
          activePoolId={activePoolId}
          onConfirm={onConfirmMovePool}
        />
      )}

      {moveFilesModalGroup !== null && (
        <MoveFilesModal
          isOpen={moveFilesModalGroup !== null}
          onClose={onCloseMoveFilesModal}
          sourceAccount={accountItems.find((a) => a.id === moveFilesModalGroup?.accountId) ?? null}
          files={modalFiles}
          accounts={accountItems}
          onConfirm={onConfirmMoveFiles}
        />
      )}

      {pendingMoveConflict !== null && (
        <MoveConflictModal
          isOpen={pendingMoveConflict !== null}
          onClose={onCloseMoveConflict}
          targetFolderPath={pendingMoveConflict.targetFolderPath}
          conflicts={pendingMoveConflict.conflicts}
          cleanCount={pendingMoveConflict.cleanCount}
          onResolve={onResolveMoveConflict}
          isSubmitting={isResolvingMoveConflict}
          errorMessage={pendingMoveConflict.errorMessage}
        />
      )}

      {confirmEmptyTrash && currentNav === 'trash' && (
        <ConfirmPurgeModal
          isOpen={confirmEmptyTrash && currentNav === 'trash'}
          onClose={onCloseEmptyTrash}
          onConfirm={onConfirmEmptyTrash}
          itemCount={trashedFilesCount}
          totalBytes={trashedTotalBytes}
        />
      )}

      {pendingPurgeFiles !== null && pendingPurgeFiles.length > 0 && currentNav === 'trash' && (
        <ConfirmPurgeModal
          isOpen={pendingPurgeFiles !== null && pendingPurgeFiles.length > 0 && currentNav === 'trash'}
          onClose={onClosePurgeFiles}
          onConfirm={onConfirmPurgeFiles}
          itemCount={pendingPurgeFiles.length}
          totalBytes={pendingPurgeTotalBytes}
        />
      )}

      {Boolean(shareModalState && shareModalState.items.length > 0) && (
        <ShareModal
          isOpen={shareModalState !== null && shareModalState.items.length > 0}
          onClose={onCloseShareModal}
          items={shareModalState?.items ?? []}
          sourcePoolId={shareModalState?.sourcePoolId ?? activePoolId}
          onComplete={onShareComplete}
        />
      )}

      {isClearSharePoolOpen && (
        <ConfirmPurgeModal
          isOpen={isClearSharePoolOpen}
          onClose={onCloseClearSharePool}
          onConfirm={onConfirmClearSharePool}
          itemCount={sharePoolTotalItemCount}
          totalBytes={sharePoolTotalBytes}
          mode="share_pool"
        />
      )}

      {driveActionModal.isOpen && (
        <ConfirmDriveActionModal
          isOpen={driveActionModal.isOpen}
          onClose={onCloseDriveAction}
          onConfirm={onConfirmDriveAction}
          account={driveActionModal.account}
          filesCount={driveFilesCount}
          totalBytes={driveTotalBytes}
          isLoading={driveActionModal.isLoading}
          errorMessage={driveActionModal.errorMessage}
        />
      )}
    </Suspense>
  );
}
