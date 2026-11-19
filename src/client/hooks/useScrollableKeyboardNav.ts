import { useEffect, useRef } from 'react';

export interface UseScrollableKeyboardNavOptions {
  scrollRef: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
  scope?: 'dialog' | 'container';
  onScrollToEnd?: () => void;
}

function isTextOrWidgetControl(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    node.isContentEditable
  ) {
    return true;
  }
  return Boolean(
    node.closest(
      'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="tablist"]'
    )
  );
}

/**
 * Enables Home, End, PageUp, and PageDown scrolling for overflowing list containers.
 * In 'dialog' scope (default), binds to the enclosing <dialog> so paging keys work
 * even while focus rests on a modal/drawer button rather than inside the scroll box.
 */
export function useScrollableKeyboardNav({
  scrollRef,
  enabled = true,
  scope = 'dialog',
  onScrollToEnd,
}: UseScrollableKeyboardNavOptions): void {
  const onScrollToEndRef = useRef(onScrollToEnd);
  onScrollToEndRef.current = onScrollToEnd;

  useEffect(() => {
    if (!enabled) return;

    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const host: HTMLElement =
      scope === 'dialog' ? (scrollEl.closest('dialog') ?? scrollEl) : scrollEl;

    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.key !== 'Home' &&
        e.key !== 'End' &&
        e.key !== 'PageUp' &&
        e.key !== 'PageDown'
      ) {
        return;
      }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      if (isTextOrWidgetControl(e.target) || isTextOrWidgetControl(document.activeElement)) {
        return;
      }

      const el = scrollRef.current;
      if (!el) return;

      const maxScrollTop = el.scrollHeight - el.clientHeight;
      if (maxScrollTop <= 0) return;

      e.preventDefault();

      if (e.key === 'Home') {
        el.scrollTop = 0;
        return;
      }

      if (e.key === 'End') {
        if (onScrollToEndRef.current) {
          onScrollToEndRef.current();
        } else {
          el.scrollTop = maxScrollTop;
        }
        return;
      }

      const pageStep = Math.max(1, Math.round(el.clientHeight * 0.875));
      if (e.key === 'PageDown') {
        el.scrollTop = Math.min(maxScrollTop, el.scrollTop + pageStep);
      } else {
        el.scrollTop = Math.max(0, el.scrollTop - pageStep);
      }
    }

    host.addEventListener('keydown', handleKeyDown);
    return () => host.removeEventListener('keydown', handleKeyDown);
  }, [scrollRef, enabled, scope]);
}
