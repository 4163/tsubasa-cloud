import React, { useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius } from '../tokens.stylex.js';
import { useBeforeUnload } from '../utils/useBeforeUnload.js';

export interface ModalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isBusy?: boolean;
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

function isOutsideDialogBounds(
  e: React.PointerEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement
): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

/**
 * Shared Top Layer native `<dialog>` shell.
 * Handles `showModal()`, `closedby` + pointer-bounds light dismiss fallback,
 * `cancel` blocking while busy, and `returnValue` cleanup.
 */
export function ModalDialog({
  isOpen,
  onClose,
  isBusy = false,
  ariaLabelledBy,
  ariaLabel,
  initialFocusRef,
  surfaceStyle,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  useBeforeUnload(isOpen && isBusy);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    let cancelled = false;

    if (isOpen) {
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
      initialFocusRef?.current?.focus();
    } else if (dialog.open) {
      const supportsDiscrete =
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        CSS.supports('transition-behavior', 'allow-discrete') &&
        CSS.supports('overlay', 'auto');
      const prefersReducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (supportsDiscrete || prefersReducedMotion) {
        dialog.close();
      } else {
        dialog.setAttribute('data-closing', 'true');
        const animations = typeof dialog.getAnimations === 'function' ? dialog.getAnimations() : [];
        if (animations.length === 0) {
          dialog.removeAttribute('data-closing');
          dialog.close();
        } else {
          void Promise.allSettled(animations.map((a) => a.finished)).then(() => {
            if (cancelled || isOpenRef.current) return;
            dialog.removeAttribute('data-closing');
            if (dialog.open) {
              dialog.close();
            }
          });
        }
      }
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, initialFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', isBusy ? 'none' : 'any');
  }, [isBusy]);

  const handleCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    if (isBusy) {
      e.preventDefault();
    }
  };

  const handleClose = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.currentTarget.removeAttribute('data-closing');
    e.currentTarget.returnValue = '';
    onClose();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    pointerDownOutsideRef.current =
      e.target === e.currentTarget && isOutsideDialogBounds(e, e.currentTarget);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if ('closedBy' in HTMLDialogElement.prototype) return;
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    if (!startedOutside || isBusy) return;
    if (e.target === e.currentTarget && isOutsideDialogBounds(e, e.currentTarget)) {
      e.currentTarget.close();
    }
  };

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
