import { useCallback, useEffect, useRef } from 'react';

export interface UseDialogLifecycleOptions {
  isOpen: boolean;
  isLocked?: boolean;
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  restoreFocusOnUnmount?: boolean;
  respectDiscreteTransitions?: boolean;
  closingAttributeValue?: string;
  skipExitAnimation?: boolean;
  requireTargetSelfForBackdrop?: boolean;
  interceptCancel?: boolean;
}

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

function shouldSkipExitAnimation(respectDiscreteTransitions: boolean, skipExitAnimation: boolean): boolean {
  if (skipExitAnimation) return true;
  if (
    typeof document !== 'undefined' &&
    document.body.classList.contains('resize-animation-stopper')
  ) {
    return true;
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return true;
  }
  if (
    respectDiscreteTransitions &&
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('transition-behavior', 'allow-discrete') &&
    CSS.supports('overlay', 'auto')
  ) {
    return true;
  }
  return false;
}

export function useDialogLifecycle({
  isOpen,
  isLocked = false,
  onClose,
  initialFocusRef,
  restoreFocusOnUnmount = false,
  respectDiscreteTransitions = false,
  closingAttributeValue = '',
  skipExitAnimation = false,
  requireTargetSelfForBackdrop = true,
  interceptCancel = true,
}: UseDialogLifecycleOptions) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pointerDownOutsideRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isClosingRef = useRef(false);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;
  const afterCloseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!restoreFocusOnUnmount) return;
    return () => {
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (isOpenRef.current && prev && prev.isConnected) {
        prev.focus();
      }
    };
  }, [restoreFocusOnUnmount]);

  const requestClose = useCallback(
    (afterClose?: () => void) => {
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

      if (shouldSkipExitAnimation(respectDiscreteTransitions, skipExitAnimation)) {
        dialog.removeAttribute('data-closing');
        previousFocusRef.current = null;
        dialog.close();
        return;
      }

      isClosingRef.current = true;
      dialog.setAttribute('data-closing', closingAttributeValue);
      const animations = typeof dialog.getAnimations === 'function' ? dialog.getAnimations() : [];
      if (animations.length === 0) {
        isClosingRef.current = false;
        dialog.removeAttribute('data-closing');
        previousFocusRef.current = null;
        dialog.close();
        return;
      }

      void Promise.allSettled(animations.map((anim) => anim.finished)).then(() => {
        if (!isClosingRef.current) return;
        isClosingRef.current = false;
        dialog.removeAttribute('data-closing');
        if (dialog.open) {
          previousFocusRef.current = null;
          dialog.close();
        }
      });
    },
    [onClose, respectDiscreteTransitions, skipExitAnimation, closingAttributeValue]
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    let cancelled = false;

    if (isOpen) {
      isClosingRef.current = false;
      afterCloseRef.current = null;
      dialog.removeAttribute('data-closing');
      if (!dialog.open) {
        if (restoreFocusOnUnmount) {
          previousFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }
        dialog.showModal();
      }
      initialFocusRef?.current?.focus();
    } else if (dialog.open) {
      if (shouldSkipExitAnimation(respectDiscreteTransitions, skipExitAnimation)) {
        dialog.removeAttribute('data-closing');
        previousFocusRef.current = null;
        dialog.close();
      } else {
        dialog.setAttribute('data-closing', closingAttributeValue);
        const animations = typeof dialog.getAnimations === 'function' ? dialog.getAnimations() : [];
        if (animations.length === 0) {
          dialog.removeAttribute('data-closing');
          previousFocusRef.current = null;
          dialog.close();
        } else {
          void Promise.allSettled(animations.map((a) => a.finished)).then(() => {
            if (cancelled || isOpenRef.current) return;
            dialog.removeAttribute('data-closing');
            if (dialog.open) {
              previousFocusRef.current = null;
              dialog.close();
            }
          });
        }
      }
    }

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    initialFocusRef,
    restoreFocusOnUnmount,
    respectDiscreteTransitions,
    skipExitAnimation,
    closingAttributeValue,
  ]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute('closedby', isLocked ? 'none' : 'any');
  }, [isLocked, isOpen]);

  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      if (interceptCancel) {
        e.preventDefault();
        if (!isLockedRef.current) {
          requestClose();
        }
        return;
      }
      if (isLockedRef.current) {
        e.preventDefault();
      }
    },
    [interceptCancel, requestClose]
  );

  const handleClose = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
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
    },
    [onClose]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDialogElement>) => {
      if (isLockedRef.current || 'closedBy' in HTMLDialogElement.prototype) {
        pointerDownOutsideRef.current = false;
        return;
      }
      pointerDownOutsideRef.current =
        e.button === 0 &&
        (!requireTargetSelfForBackdrop || e.target === e.currentTarget) &&
        isOutsideDialogBounds(e, e.currentTarget);
    },
    [requireTargetSelfForBackdrop]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDialogElement>) => {
      if (isLockedRef.current || 'closedBy' in HTMLDialogElement.prototype) {
        pointerDownOutsideRef.current = false;
        return;
      }
      const startedOutside = pointerDownOutsideRef.current;
      pointerDownOutsideRef.current = false;
      if (!startedOutside || e.button !== 0) return;
      if (
        (!requireTargetSelfForBackdrop || e.target === e.currentTarget) &&
        isOutsideDialogBounds(e, e.currentTarget)
      ) {
        if (interceptCancel) {
          requestClose();
        } else {
          e.currentTarget.close();
        }
      }
    },
    [requireTargetSelfForBackdrop, interceptCancel, requestClose]
  );

  return {
    dialogRef,
    requestClose,
    handleCancel,
    handleClose,
    handlePointerDown,
    handlePointerUp,
  };
}
