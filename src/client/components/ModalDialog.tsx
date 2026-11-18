import React from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius } from '../tokens.stylex.js';
import { useDialogLifecycle } from '../hooks/useDialogLifecycle.js';
import { useBeforeUnload } from '../utils/useBeforeUnload.js';

export interface ModalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isBusy?: boolean;
  preventUnloadWhileBusy?: boolean;
  ariaLabelledBy?: string;
  ariaLabel?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  surfaceStyle?: stylex.StyleXStyles;
  children: React.ReactNode;
}

const styles = stylex.create({
  dialog: {
    margin: 'auto',
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100dvh - 32px)',
    overflow: 'visible',
    boxSizing: 'border-box',
    outline: 'none',
    '::backdrop': {
      backgroundColor: colors.modalBackdrop,
    },
  },
  surface: {
    width: '100%',
    maxWidth: '100%',
    maxHeight: 'calc(100dvh - 32px)',
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
  },
});

/**
 * Shared Top Layer native `<dialog>` shell.
 * Handles `showModal()`, `closedby` + pointer-bounds light dismiss fallback,
 * `cancel` blocking while busy, and `returnValue` cleanup.
 */
export function ModalDialog({
  isOpen,
  onClose,
  isBusy = false,
  preventUnloadWhileBusy = true,
  ariaLabelledBy,
  ariaLabel,
  initialFocusRef,
  surfaceStyle,
  children,
}: ModalDialogProps) {
  useBeforeUnload(isOpen && isBusy && preventUnloadWhileBusy);

  const {
    dialogRef,
    handleCancel,
    handleClose,
    handlePointerDown,
    handlePointerUp,
  } = useDialogLifecycle({
    isOpen,
    isLocked: isBusy,
    onClose,
    initialFocusRef,
    restoreFocusOnUnmount: true,
    respectDiscreteTransitions: true,
    closingAttributeValue: 'true',
    interceptCancel: false,
  });

  return (
    <dialog
      ref={dialogRef}
      data-tsubasa-dialog="modal"
      aria-labelledby={ariaLabelledBy}
      aria-label={ariaLabel}
      onCancel={handleCancel}
      onClose={handleClose}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      {...stylex.props(styles.dialog)}
    >
      <div {...stylex.props(styles.surface, surfaceStyle)}>{children}</div>
    </dialog>
  );
}
