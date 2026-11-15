import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, motion, radius, spacing, typography } from '../tokens.stylex.js';
import { IconClose } from './Icons.js';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastInput {
  id?: string;
  message: string;
  variant?: ToastVariant;
  durationMs?: number;
  action?: ToastAction;
}

interface ToastRecord {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs: number;
  action?: ToastAction;
}

interface TimerState {
  remainingMs: number;
  startedAt: number;
  timerId: ReturnType<typeof setTimeout> | null;
  pauseReasons: Set<'hover' | 'focus'>;
}

const MAX_VISIBLE_TOASTS = 5;
const DEFAULT_INFO_DURATION_MS = 4000;
const DEFAULT_ERROR_DURATION_MS = 6000;

let nextToastSeq = 0;
let toastsSnapshot: ToastRecord[] = [];
const timers = new Map<string, TimerState>();
const listeners = new Set<() => void>();
const announcementListeners = new Set<(text: string) => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ToastRecord[] {
  return toastsSnapshot;
}

function clearTimer(id: string): void {
  const state = timers.get(id);
  if (!state) return;
  if (state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
  }
  timers.delete(id);
}

function scheduleTimer(id: string, durationMs: number): void {
  clearTimer(id);
  if (durationMs <= 0 || !Number.isFinite(durationMs)) return;

  const state: TimerState = {
    remainingMs: durationMs,
    startedAt: Date.now(),
    timerId: null,
    pauseReasons: new Set(),
  };

  state.timerId = setTimeout(() => {
    dismissToast(id);
  }, durationMs);

  timers.set(id, state);
}

function pauseToastTimer(id: string, reason: 'hover' | 'focus'): void {
  const state = timers.get(id);
  if (!state) return;

  const wasPaused = state.pauseReasons.size > 0;
  state.pauseReasons.add(reason);

  if (!wasPaused && state.timerId !== null) {
    clearTimeout(state.timerId);
    state.timerId = null;
    state.remainingMs = Math.max(0, state.remainingMs - (Date.now() - state.startedAt));
  }
}

function resumeToastTimer(id: string, reason: 'hover' | 'focus'): void {
  const state = timers.get(id);
  if (!state) return;

  state.pauseReasons.delete(reason);
  if (state.pauseReasons.size > 0 || state.timerId !== null) return;

  if (state.remainingMs <= 0) {
    dismissToast(id);
    return;
  }

  state.startedAt = Date.now();
  state.timerId = setTimeout(() => {
    dismissToast(id);
  }, state.remainingMs);
}

function announceToast(toast: ToastRecord): void {
  const announcement = toast.action ? `${toast.message}. Actions available` : toast.message;
  const doc = typeof document !== 'undefined' ? (document as { ariaNotify?: (msg: string) => void }) : null;

  if (doc && typeof doc.ariaNotify === 'function') {
    doc.ariaNotify(announcement);
    return;
  }

  for (const listener of announcementListeners) {
    listener(announcement);
  }
}

export function pushToast(input: ToastInput | string): string {
  const normalized: ToastInput = typeof input === 'string' ? { message: input } : input;
  const id = normalized.id ?? `toast-${++nextToastSeq}`;
  const variant: ToastVariant = normalized.variant ?? 'info';
  const durationMs =
    normalized.durationMs !== undefined
      ? normalized.durationMs
      : variant === 'error'
        ? DEFAULT_ERROR_DURATION_MS
        : DEFAULT_INFO_DURATION_MS;

  const record: ToastRecord = {
    id,
    message: normalized.message,
    variant,
    durationMs,
    action: normalized.action,
  };

  const existingIndex = toastsSnapshot.findIndex((t) => t.id === id);
  let next: ToastRecord[];
  if (existingIndex >= 0) {
    next = [...toastsSnapshot];
    next[existingIndex] = record;
  } else {
    next = [...toastsSnapshot, record];
    while (next.length > MAX_VISIBLE_TOASTS) {
      const evicted = next.shift();
      if (evicted) clearTimer(evicted.id);
    }
  }

  toastsSnapshot = next;
  scheduleTimer(id, durationMs);
  emitChange();
  announceToast(record);

  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const next = toastsSnapshot.filter((t) => t.id !== id);
  if (next.length === toastsSnapshot.length) return;
  toastsSnapshot = next;
  emitChange();
}

export function clearAllToasts(): void {
  for (const id of timers.keys()) {
    clearTimer(id);
  }
  if (toastsSnapshot.length === 0) return;
  toastsSnapshot = [];
  emitChange();
}

const styles = stylex.create({
  region: {
    position: 'fixed',
    inset: 'auto',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    overflow: 'visible',
    zIndex: 10000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.space3,
    maxWidth: 'calc(100vw - 32px)',
    pointerEvents: 'none',
  },
  regionHidden: {
    display: 'none',
  },
  toast: {
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space4,
    minWidth: '240px',
    maxWidth: '520px',
    paddingTop: spacing.space4,
    paddingBottom: spacing.space4,
    paddingLeft: spacing.space6,
    paddingRight: spacing.space4,
    backgroundColor: colors.surfaceElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.card,
    color: colors.primaryText,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightBody,
    lineHeight: typography.lineHeightBody,
  },
  toastSuccess: {
    backgroundColor: colors.successSurface,
    borderColor: colors.success,
    color: colors.success,
  },
  toastError: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.danger,
    color: colors.danger,
  },
  message: {
    flex: 1,
    minWidth: 0,
    wordBreak: 'break-word',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: spacing.space2,
    flexShrink: 0,
  },
  actionButton: {
    appearance: 'none',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.brandAccent,
    backgroundColor: colors.brandAccent,
    color: colors.brandAccentText,
    borderRadius: radius.button,
    paddingTop: spacing.space2,
    paddingBottom: spacing.space2,
    paddingLeft: spacing.space4,
    paddingRight: spacing.space4,
    fontFamily: typography.fontFamilyBody,
    fontSize: typography.fontSizeMeta,
    fontWeight: typography.fontWeightSection,
    lineHeight: 1.2,
    cursor: 'pointer',
    transition: `background-color ${motion.transitionFast}, border-color ${motion.transitionFast}`,
    ':hover': {
      backgroundColor: colors.brandAccentHover,
      borderColor: colors.brandAccentHover,
    },
    ':focus-visible': {
      outline: `2px solid ${colors.focusRing}`,
      outlineOffset: '2px',
    },
  },
  actionButtonError: {
    borderColor: colors.danger,
    backgroundColor: colors.danger,
    color: colors.dangerText,
    ':hover': {
      backgroundColor: colors.dangerHover,
      borderColor: colors.dangerHover,
    },
  },
  closeButton: {
    appearance: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.compact,
    backgroundColor: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    flexShrink: 0,
    transition: `background-color ${motion.transitionFast}`,
    ':hover': {
      backgroundColor: colors.rowHover,
    },
    ':focus-visible': {
      outline: `2px solid ${colors.focusRing}`,
      outlineOffset: '2px',
    },
  },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});

const supportsPopover =
  typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;

export function ToastRegion() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const toastRefs = useRef(new Map<string, HTMLDivElement>());
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  useEffect(() => {
    const listener = (text: string) => {
      setLiveAnnouncement(text);
    };
    announcementListeners.add(listener);
    return () => {
      announcementListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const el = regionRef.current as (HTMLDivElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    }) | null;
    if (!el || !supportsPopover) return;

    if (toasts.length > 0) {
      if (typeof el.showPopover === 'function') {
        try {
          if (!el.matches(':popover-open')) {
            el.showPopover();
          }
        } catch {
          // Ignore if element is disconnected or already open.
        }
      }
    } else if (typeof el.hidePopover === 'function') {
      try {
        if (el.matches(':popover-open')) {
          el.hidePopover();
        }
      } catch {
        // Ignore if element is disconnected or already closed.
      }
    }
  }, [toasts.length]);

  const handleToastFocus = (id: string, e: React.FocusEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related instanceof HTMLElement && !regionRef.current?.contains(related)) {
      previousFocusRef.current = related;
    }
    pauseToastTimer(id, 'focus');
  };

  const handleToastBlur = (id: string, e: React.FocusEvent<HTMLDivElement>) => {
    const nextFocus = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(nextFocus)) {
      resumeToastTimer(id, 'focus');
    }
  };

  const handleManualDismiss = (id: string) => {
    const toastEl = toastRefs.current.get(id);
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const wasFocused = Boolean(toastEl && active && toastEl.contains(active));

    const currentIndex = toasts.findIndex((t) => t.id === id);
    const remaining = toasts.filter((t) => t.id !== id);
    const nextTargetToast =
      remaining.length > 0
        ? remaining[Math.min(currentIndex, remaining.length - 1)]
        : null;

    dismissToast(id);

    if (!wasFocused) return;

    queueMicrotask(() => {
      if (nextTargetToast) {
        const nextEl = toastRefs.current.get(nextTargetToast.id);
        const focusTarget = nextEl?.querySelector<HTMLElement>(
          '[data-toast-action], [data-toast-close]'
        );
        if (focusTarget) {
          focusTarget.focus();
          return;
        }
      }

      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && prev.isConnected) {
        prev.focus();
      }
    });
  };

  const handleActionClick = (toast: ToastRecord) => {
    if (!toast.action) return;
    try {
      const result = toast.action.onClick();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {
          // Caller handles action errors; prevent unhandled rejection here.
        });
      }
    } finally {
      handleManualDismiss(toast.id);
    }
  };

  return (
    <>
      <div
        ref={regionRef}
        role="region"
        aria-label="Notifications"
        popover={supportsPopover ? 'manual' : undefined}
        {...stylex.props(styles.region, toasts.length === 0 && styles.regionHidden)}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            ref={(node) => {
              if (node) {
                toastRefs.current.set(toast.id, node);
              } else {
                toastRefs.current.delete(toast.id);
              }
            }}
            onPointerEnter={() => pauseToastTimer(toast.id, 'hover')}
            onPointerLeave={() => resumeToastTimer(toast.id, 'hover')}
            onFocus={(e) => handleToastFocus(toast.id, e)}
            onBlur={(e) => handleToastBlur(toast.id, e)}
            {...stylex.props(
              styles.toast,
              toast.variant === 'success' && styles.toastSuccess,
              toast.variant === 'error' && styles.toastError
            )}
          >
            <span {...stylex.props(styles.message)}>{toast.message}</span>
            <div {...stylex.props(styles.actions)}>
              {toast.action && (
                <button
                  type="button"
                  data-toast-action=""
                  onClick={() => handleActionClick(toast)}
                  {...stylex.props(
                    styles.actionButton,
                    toast.variant === 'error' && styles.actionButtonError
                  )}
                >
                  {toast.action.label}
                </button>
              )}
              <button
                type="button"
                data-toast-close=""
                aria-label="Dismiss notification"
                onClick={() => handleManualDismiss(toast.id)}
                {...stylex.props(styles.closeButton)}
              >
                <IconClose size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div aria-live="polite" aria-atomic="true" {...stylex.props(styles.srOnly)}>
        {liveAnnouncement}
      </div>
    </>
  );
}
