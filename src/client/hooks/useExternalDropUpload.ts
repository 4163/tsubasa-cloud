import { useCallback, useEffect } from 'react';
import type { StagedItem } from '../types.js';
import { extractDataTransferEntries } from '../utils/dataTransfer.js';
import { isDropHandled } from '../utils/virtualPath.js';
import { isModalActive } from '../utils/workspaceHelpers.js';

export interface UseExternalDropUploadOptions {
  isSharePoolActive: boolean;
  currentNav: 'files' | 'trash';
  currentPath: string;
  setStagedFiles: React.Dispatch<React.SetStateAction<Array<File | StagedItem>>>;
  setStagedEmptyFolders: React.Dispatch<React.SetStateAction<string[]>>;
  setUploadTargetPath: React.Dispatch<React.SetStateAction<string | undefined>>;
  setIsUploadDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  surfaceWorkspaceError: (context: string, err: unknown, fallback: string) => void;
}

export function useExternalDropUpload({
  isSharePoolActive,
  currentNav,
  currentPath,
  setStagedFiles,
  setStagedEmptyFolders,
  setUploadTargetPath,
  setIsUploadDrawerOpen,
  surfaceWorkspaceError,
}: UseExternalDropUploadOptions) {
  const stageExtractedDrop = useCallback(
    (extracted: {
      files: Array<{ file: File; virtualPath: string }>;
      emptyFolders: string[];
      basePath?: string;
    }) => {
      if (extracted.files.length > 0 || extracted.emptyFolders.length > 0) {
        setStagedFiles(extracted.files);
        setStagedEmptyFolders(extracted.emptyFolders);
        setUploadTargetPath(extracted.basePath);
        setIsUploadDrawerOpen(true);
      }
    },
    [setStagedFiles, setStagedEmptyFolders, setUploadTargetPath, setIsUploadDrawerOpen]
  );

  const handleDropExternalToPath = useCallback(
    async (targetPath: string, dataTransfer: DataTransfer) => {
      if (isSharePoolActive || isModalActive()) return;
      try {
        const extracted = await extractDataTransferEntries(dataTransfer, targetPath);
        stageExtractedDrop(extracted);
      } catch (err) {
        surfaceWorkspaceError('handleDropExternalToPath', err, 'Failed to read dropped files');
      }
    },
    [isSharePoolActive, stageExtractedDrop, surfaceWorkspaceError]
  );

  const handleDropExternalToRoot = useCallback(
    (dt: DataTransfer) => {
      void handleDropExternalToPath('/', dt);
    },
    [handleDropExternalToPath]
  );

  useEffect(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive || isModalActive()) return;
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (currentNav === 'trash' || isSharePoolActive) return;
      if (isModalActive()) {
        e.preventDefault();
        return;
      }
      if (e.dataTransfer?.types?.includes('application/x-tsubasa-items')) return;
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        if (isDropHandled(e)) return;
        try {
          const extracted = await extractDataTransferEntries(e.dataTransfer, currentPath);
          stageExtractedDrop(extracted);
        } catch (err) {
          surfaceWorkspaceError('handleWindowDrop', err, 'Failed to read dropped files');
        }
      }
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [currentNav, currentPath, isSharePoolActive, stageExtractedDrop, surfaceWorkspaceError]);

  return {
    handleDropExternalToPath,
    handleDropExternalToRoot,
  };
}
