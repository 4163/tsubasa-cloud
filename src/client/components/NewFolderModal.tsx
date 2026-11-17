import React, { useState, useEffect, useRef, useId } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, typography, motion } from '../tokens.stylex.js';
import { IconFolderPlus, IconClose } from './Icons';
import { ModalDialog } from './ModalDialog.js';
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
  header: {
    height: '48px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    flexShrink: 0,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
  },
  title: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeSection,
    fontWeight: typography.fontWeightTitle,
    color: colors.primaryText,
    margin: 0,
  },
  closeBtn: {
    backgroundColor: 'transparent',
    borderWidth: '0px',
    cursor: 'pointer',
    color: colors.secondaryText,
    padding: spacing.space1,
    borderRadius: radius.compact,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.35,
      color: colors.secondaryText,
      backgroundColor: 'transparent',
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
    },
  },
  body: {
    padding: spacing.space5,
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space3,
    backgroundColor: colors.surface,
  },
  pathHint: {
    fontSize: typography.fontSizeMeta,
    color: colors.dimText,
    fontFamily: typography.fontFamilyMono,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: spacing.space2,
  },
  label: {
    fontSize: typography.fontSizeMeta,
    fontWeight: '600',
    color: colors.secondaryText,
  },
  input: {
    height: '34px',
    backgroundColor: colors.surfaceAlt,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.compact,
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    color: colors.primaryText,
    outline: 'none',
    boxSizing: 'border-box',
    transition: motion.transitionFast,
    ':focus': {
      borderColor: colors.accentGold,
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '-1px',
    },
    '::placeholder': {
      color: colors.dimText,
    },
    ':disabled': {
      opacity: 0.6,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
  errorMessage: {
    fontSize: typography.fontSizeMeta,
    color: colors.dangerTextOnSurface,
    fontFamily: typography.fontFamilyMono,
  },
  footer: {
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    paddingTop: spacing.space3,
    paddingBottom: spacing.space3,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.space2,
    flexShrink: 0,
  },
  cancelBtn: {
    height: '32px',
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    borderRadius: radius.compact,
    backgroundColor: 'transparent',
    color: colors.secondaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: '500',
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      color: colors.primaryText,
      borderColor: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      backgroundColor: 'transparent',
      color: colors.secondaryText,
      borderColor: colors.border,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
  },
  createBtn: {
    height: '32px',
    paddingLeft: spacing.space5,
    paddingRight: spacing.space5,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightTitle,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: spacing.space2,
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.5,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
    },
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    if (isOpen) {
      setFolderName('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSubmitting) return;

    const finalName = folderName.trim() || 'New folder';
    const validationError = getItemNameError(finalName, 'Folder name');
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreateFolder(finalName);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsSubmitting(false);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
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
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <IconFolderPlus size={16} />
          <h3 id={titleId} {...stylex.props(styles.title)}>New folder</h3>
        </div>
        <button
          type="button"
          {...stylex.props(styles.closeBtn)}
          onClick={onClose}
          disabled={isSubmitting}
          aria-label="Close dialog"
        >
          <IconClose size={14} />
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.pathHint)}>
            Location: {currentPath === '/' ? '/ (Root)' : currentPath}
          </div>

          <div {...stylex.props(styles.fieldGroup)}>
            <label htmlFor={inputId} {...stylex.props(styles.label)}>
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
              {...stylex.props(styles.input)}
              maxLength={255}
              autoComplete="off"
              disabled={isSubmitting}
            />
            <div role="status" aria-live="polite">
              {error && <span {...stylex.props(styles.errorMessage)}>{error}</span>}
            </div>
          </div>
        </div>

        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            {...stylex.props(styles.cancelBtn)}
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            {...stylex.props(styles.createBtn)}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

