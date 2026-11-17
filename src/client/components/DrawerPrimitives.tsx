import React, { useCallback, useEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, spacing, radius, layout, typography, motion } from '../tokens.stylex.js';
import { IconClose } from './Icons.js';
import { useBeforeUnload } from '../utils/useBeforeUnload.js';

const styles = stylex.create({
  dialog: {
    position: 'fixed',
    inset: {
      default: '0 0 0 auto',
      '@media (max-width: 768px)': '0 0 auto 0',
    },
    margin: 0,
    padding: 0,
    borderWidth: '0px',
    backgroundColor: 'transparent',
    color: 'inherit',
    outline: 'none',
    overflow: 'hidden',
    width: {
      default: layout.drawerWidth,
      '@media (max-width: 768px)': '100vw',
    },
    maxWidth: '100vw',
    height: {
      default: '100dvh',
      '@media (max-width: 768px)': 'auto',
    },
    maxHeight: {
      default: '100dvh',
      '@media (max-width: 768px)': '92dvh',
    },
    '::backdrop': {
      backgroundColor: colors.modalBackdrop,
    },
  },
  dialogHideMobileBackdrop: {
    '::backdrop': {
      backgroundColor: {
        default: colors.modalBackdrop,
        '@media (max-width: 768px)': 'transparent',
      },
    },
  },
  drawerSurface: {
    width: '100%',
    height: '100%',
    maxHeight: 'inherit',
    backgroundColor: colors.surface,
    borderLeftWidth: {
      default: '1px',
      '@media (max-width: 768px)': '0px',
    },
    borderLeftStyle: 'solid',
    borderLeftColor: colors.borderSubtle,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    overflow: 'hidden',
    '@media (max-width: 768px)': {
      borderBottomWidth: '1px',
      borderBottomStyle: 'solid',
      borderBottomColor: colors.border,
    },
  },
  drawerHeader: {
    height: layout.drawerHeaderHeight,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    backgroundColor: colors.surface,
  },
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space3,
    minWidth: 0,
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
    padding: spacing.space2,
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
      outlineOffset: '-1px',
    },
    ':disabled': {
      opacity: 0.35,
      cursor: 'not-allowed',
      backgroundColor: 'transparent',
      color: colors.secondaryText,
    },
    '@media (pointer: coarse)': {
      minWidth: '44px',
      minHeight: '44px',
    },
  },
  sectionHeaderBand: {
    minHeight: '32px',
    paddingTop: spacing.space1,
    paddingBottom: spacing.space1,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space6,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.borderSubtle,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.space2,
    boxSizing: 'border-box',
  },
  sectionTitle: {
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeTableHeader,
    fontWeight: typography.fontWeightSection,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: colors.secondaryText,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
  },
  sectionCountBadge: {
    height: '18px',
    paddingLeft: spacing.space2,
    paddingRight: spacing.space2,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.borderSubtle,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBadge,
    fontWeight: typography.fontWeightBadge,
    fontVariantNumeric: 'tabular-nums',
    color: colors.secondaryText,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  btnPrimary: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderWidth: '0px',
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
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
      opacity: 0.45,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
  },
  btnSecondary: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.surface,
    color: colors.primaryText,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.rowHover,
      borderColor: colors.primaryText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.45,
      backgroundColor: colors.surfaceAlt,
      color: colors.secondaryText,
      borderColor: colors.borderSubtle,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
  },
  btnDanger: {
    height: '26px',
    paddingLeft: spacing.space3,
    paddingRight: spacing.space3,
    borderRadius: radius.compact,
    backgroundColor: colors.dangerSurface,
    color: colors.dangerTextOnSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.dangerBorder,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightTitle,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    outline: 'none',
    transition: motion.transitionFast,
    ':hover': {
      backgroundColor: colors.danger,
      borderColor: colors.danger,
      color: colors.dangerText,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: colors.focusRing,
      outlineOffset: '1px',
    },
    ':disabled': {
      opacity: 0.45,
      cursor: 'not-allowed',
    },
    '@media (pointer: coarse)': {
      minHeight: '44px',
      paddingLeft: spacing.space4,
      paddingRight: spacing.space4,
    },
  },
});

const BUTTON_VARIANT_STYLES = {
  primary: styles.btnPrimary,
  secondary: styles.btnSecondary,
  danger: styles.btnDanger,
} as const;

export interface DrawerSectionHeaderProps {
  icon?: React.ReactNode;
  title: string;
  count: number | string;
}

export function DrawerSectionHeader({ icon, title, count }: DrawerSectionHeaderProps) {
  return (
    <div {...stylex.props(styles.sectionHeaderBand)}>
      <h3 {...stylex.props(styles.sectionTitle)}>
        {icon}
        <span>{title}</span>
      </h3>
      <span {...stylex.props(styles.sectionCountBadge)}>{count}</span>
    </div>
  );
}

export interface DrawerButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant: 'primary' | 'secondary' | 'danger';
  style?: stylex.StyleXStyles;
}

export function DrawerButton({
  variant,
  style,
  type = 'button',
  children,
  ...rest
}: DrawerButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      {...stylex.props(BUTTON_VARIANT_STYLES[variant], style)}
    >
      {children}
    </button>
  );
}

export interface DrawerSheetProps {
  isOpen: boolean;
  isLocked?: boolean;
  onClose: () => void;
  ariaLabel: string;
  title: string;
  icon: React.ReactNode;
  closeAriaLabel?: string;
  hideMobileBackdrop?: boolean;
  requestCloseRef?: React.MutableRefObject<((afterClose?: () => void) => void) | null>;
  children: React.ReactNode;
}

function isOutsideDialogBounds(e: React.PointerEvent<HTMLDialogElement>, dialog: HTMLDialogElement) {
  const rect = dialog.getBoundingClientRect();
  return (
    e.clientX < rect.left ||
    e.clientX > rect.right ||
    e.clientY < rect.top ||
    e.clientY > rect.bottom
  );
}

export function DrawerSheet({
  isOpen,
  isLocked = false,
  onClose,
  ariaLabel,
  title,
  icon,
  closeAriaLabel = 'Close drawer',
  hideMobileBackdrop = false,
  requestCloseRef,
  children,
}: DrawerSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = useRef(false);
  const isClosingRef = useRef(false);
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const afterCloseRef = useRef<(() => void) | null>(null);

  useBeforeUnload(isLocked);

  const requestClose = useCallback((afterClose?: () => void) => {
    if (isLockedRef.current || isClosingRef.current) return;
    afterCloseRef.current = afterClose ?? null;
    const dialog = dialogRef.current;
    if (!dialog || !dialog.open) {
      const cb = afterCloseRef.current;
      afterCloseRef.current = null;
      cb?.();
      onClose();
      return;
    }

    const skipExitAnimation =
      document.body.classList.contains('resize-animation-stopper') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (skipExitAnimation) {
      dialog.removeAttribute('data-closing');
      dialog.close();
      return;
    }

    isClosingRef.current = true;
    dialog.setAttribute('data-closing', '');
    const animations = typeof dialog.getAnimations === 'function' ? dialog.getAnimations() : [];
    Promise.all(animations.map((anim) => anim.finished.catch(() => {}))).then(() => {
      if (!isClosingRef.current) return;
      isClosingRef.current = false;
      dialog.removeAttribute('data-closing');
      if (dialog.open) {
        dialog.close();
      }
    });
  }, [onClose]);

  useEffect(() => {
    if (!requestCloseRef) return;
    requestCloseRef.current = requestClose;
    return () => {
      requestCloseRef.current = null;
    };
  }, [requestCloseRef, requestClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      isClosingRef.current = false;
      afterCloseRef.current = null;
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.removeAttribute('data-closing');
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', isLocked ? 'none' : 'any');
  }, [isLocked, isOpen]);

  if (!isOpen) return null;

  const handleDialogCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    e.preventDefault();
    if (!isLockedRef.current) requestClose();
  };

  const handleDialogClose = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    const dialog = e.currentTarget;
    dialog.returnValue = '';
    if (isLockedRef.current && isOpenRef.current) {
      queueMicrotask(() => {
        if (dialog.isConnected && isOpenRef.current && !dialog.open) {
          dialog.showModal();
        }
      });
      return;
    }
    dialog.removeAttribute('data-closing');
    isClosingRef.current = false;
    const afterClose = afterCloseRef.current;
    afterCloseRef.current = null;
    afterClose?.();
    onClose();
  };

  const handleDialogPointerDown = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (isLocked || 'closedBy' in HTMLDialogElement.prototype) {
      pointerDownOutsideRef.current = false;
      return;
    }
    pointerDownOutsideRef.current =
      e.button === 0 &&
      e.target === e.currentTarget &&
      isOutsideDialogBounds(e, e.currentTarget);
  };

  const handleDialogPointerUp = (e: React.PointerEvent<HTMLDialogElement>) => {
    if (isLocked || 'closedBy' in HTMLDialogElement.prototype) {
      pointerDownOutsideRef.current = false;
      return;
    }
    const startedOutside = pointerDownOutsideRef.current;
    pointerDownOutsideRef.current = false;
    if (!startedOutside) return;
    if (e.target === e.currentTarget && isOutsideDialogBounds(e, e.currentTarget)) {
      requestClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      data-tsubasa-dialog="drawer-sheet"
      aria-label={ariaLabel}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      onPointerDown={handleDialogPointerDown}
      onPointerUp={handleDialogPointerUp}
      {...stylex.props(styles.dialog, hideMobileBackdrop && styles.dialogHideMobileBackdrop)}
    >
      <div {...stylex.props(styles.drawerSurface)}>
        <div {...stylex.props(styles.drawerHeader)}>
          <div {...stylex.props(styles.titleGroup)}>
            {icon}
            <h2 {...stylex.props(styles.title)}>{title}</h2>
          </div>
          <button
            type="button"
            {...stylex.props(styles.closeBtn)}
            onClick={() => requestClose()}
            disabled={isLocked}
            aria-label={closeAriaLabel}
          >
            <IconClose size={16} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
