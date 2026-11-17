import React, { useState, useEffect, useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, typography } from '../tokens.stylex.js';
import { IconFolderPlus } from './Icons.js';
import { ModalDialog } from './ModalDialog.js';
import { ModalHeader, modalChromeStyles } from './ModalChrome.js';
import { getItemNameError } from '../utils/virtualPath.js';

interface NewFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPath: string;
  onCreateFolder: (name: string) => Promise<void> | void;
}

const styles = stylex.create({
  surface: {
    width: '400px',
  },
  pathHint: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontFamily: typography.fontFamilyMono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export function NewFolderModal({
  isOpen,
  onClose,
  currentPath,
  onCreateFolder,
}: NewFolderModalProps) {
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    if (isOpen) {
      setFolderName('');
      setError(null);
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }, [isOpen]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current || isSubmitting) return;

    const finalName = folderName.trim() || 'New folder';
    const validationError = getItemNameError(finalName, 'Folder name');
    if (validationError) {
      setError(validationError);
      return;
    }

    submittingRef.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      await onCreateFolder(finalName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      isBusy={isSubmitting}
      ariaLabelledBy={titleId}
      initialFocusRef={inputRef}
      surfaceStyle={styles.surface}
    >
      <ModalHeader
        titleId={titleId}
        title="New folder"
        icon={<IconFolderPlus size={16} />}
        onClose={onClose}
        isBusy={isSubmitting}
        closeAriaLabel="Close dialog"
        closeIconSize={14}
      />

      <form onSubmit={handleSubmit}>
        <div {...stylex.props(modalChromeStyles.body)}>
          <div {...stylex.props(styles.pathHint)}>
            Location: {currentPath === '/' ? '/ (Root)' : currentPath}
          </div>

          <div {...stylex.props(modalChromeStyles.fieldGroup)}>
            <label htmlFor={inputId} {...stylex.props(modalChromeStyles.label)}>
              Folder name
            </label>
            <input
              id={inputId}
              ref={inputRef}
              type="text"
              autoFocus
              placeholder="New folder"
              value={folderName}
              onChange={(e) => {
                setFolderName(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={handleInputKeyDown}
              {...stylex.props(modalChromeStyles.input)}
              maxLength={255}
              autoComplete="off"
              disabled={isSubmitting}
            />
            <div role="status" aria-live="polite">
              {error && <span {...stylex.props(modalChromeStyles.errorMessage)}>{error}</span>}
            </div>
          </div>
        </div>

        <div {...stylex.props(modalChromeStyles.footer)}>
          <button
            type="button"
            {...stylex.props(modalChromeStyles.cancelBtn)}
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            {...stylex.props(modalChromeStyles.primaryBtn)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

