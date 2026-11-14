import { useEffect, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, motion, typography } from '../tokens.stylex.js';
import { maskEmail } from '../utils/format.js';

function isNodeSelected(el: HTMLElement | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;

  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if ((anchor && el.contains(anchor)) || (focus && el.contains(focus))) {
    return true;
  }
  if (typeof selection.containsNode === 'function') {
    return selection.containsNode(el, true);
  }
  return false;
}

const selectionSubscribers = new Set<() => void>();

function notifySelectionSubscribers() {
  for (const listener of selectionSubscribers) {
    listener();
  }
}

function subscribeSelectionChange(listener: () => void): () => void {
  if (selectionSubscribers.size === 0 && typeof document !== 'undefined') {
    document.addEventListener('selectionchange', notifySelectionSubscribers);
  }
  selectionSubscribers.add(listener);
  return () => {
    selectionSubscribers.delete(listener);
    if (selectionSubscribers.size === 0 && typeof document !== 'undefined') {
      document.removeEventListener('selectionchange', notifySelectionSubscribers);
    }
  };
}

const styles = stylex.create({
  redactedEmail: {
    fontSize: typography.fontSizeBadge,
    fontFamily: typography.fontFamilyMono,
    color: colors.secondaryText,
    userSelect: 'text',
    cursor: 'default',
    transition: motion.transitionFast,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    letterSpacing: '0.02em',
    ':hover': {
      color: colors.primaryText,
    },
  },
  redactedEmailRevealed: {
    color: colors.primaryText,
  },
});

export interface RedactedEmailProps {
  email: string;
  prefix?: string;
  tooltip?: string;
  style?: stylex.StyleXStyles;
  stopClickPropagation?: boolean;
}

export function RedactedEmail({
  email,
  prefix,
  tooltip,
  style,
  stopClickPropagation = false,
}: RedactedEmailProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isSelected, setIsSelected] = useState(false);
  const masked = useMemo(() => maskEmail(email), [email]);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selected = isNodeSelected(spanRef.current);
      setIsSelected((prev) => (prev !== selected ? selected : prev));
    };

    return subscribeSelectionChange(handleSelectionChange);
  }, []);

  const isRevealed = isHovered || isSelected;
  const resolvedTooltip = tooltip ?? (prefix ? `${prefix}${email}` : email);

  return (
    <span
      ref={spanRef}
      title={resolvedTooltip}
      {...stylex.props(styles.redactedEmail, style, isRevealed && styles.redactedEmailRevealed)}
      onMouseEnter={() => {
        setIsHovered(true);
        if (spanRef.current) {
          setIsSelected(isNodeSelected(spanRef.current));
        }
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        if (spanRef.current) {
          setIsSelected(isNodeSelected(spanRef.current));
        }
      }}
      onClick={
        stopClickPropagation
          ? (e) => {
              e.stopPropagation();
            }
          : undefined
      }
    >
      {prefix}
      {isRevealed ? email : masked}
    </span>
  );
}
