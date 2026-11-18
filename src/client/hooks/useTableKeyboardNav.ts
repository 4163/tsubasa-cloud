import { useCallback, useEffect, useRef } from 'react';

export type KeyboardNavRow =
  | { kind: 'parent' }
  | { kind: 'folder' | 'file' | 'trash'; data: { id: string; name: string } };

export interface UseTableKeyboardNavOptions {
  parentRef: React.RefObject<HTMLDivElement | null>;
  items: KeyboardNavRow[];
  selectableIds: string[];
  selectedIds: Set<string>;
  rowHeight: number;
  scrollToIndex: (index: number) => void;
  onSelect: (id: string, isMulti: boolean) => void;
  onSelectMultiple?: (ids: string[], mode?: 'set' | 'add' | 'toggle') => void;
  anchorIndexRef: React.MutableRefObject<number>;
  focusIndexRef: React.MutableRefObject<number>;
  lastSelectedIdRef: React.MutableRefObject<string | null>;
}

export function useTableKeyboardNav({
  parentRef,
  items,
  selectableIds,
  selectedIds,
  rowHeight,
  scrollToIndex,
  onSelect,
  onSelectMultiple,
  anchorIndexRef,
  focusIndexRef,
  lastSelectedIdRef,
}: UseTableKeyboardNavOptions) {
  const typeAheadBufferRef = useRef<string>('');
  const typeAheadTimerRef = useRef<number | null>(null);

  const resetTypeAhead = useCallback(() => {
    typeAheadBufferRef.current = '';
    if (typeAheadTimerRef.current !== null) {
      window.clearTimeout(typeAheadTimerRef.current);
      typeAheadTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (typeAheadTimerRef.current !== null) {
        window.clearTimeout(typeAheadTimerRef.current);
      }
    };
  }, []);

  const getActiveIndex = useCallback((): number => {
    if (focusIndexRef.current >= 0 && focusIndexRef.current < items.length) {
      const focusedItem = items[focusIndexRef.current];
      const focusedId = focusedItem.kind === 'parent' ? '__parent__' : focusedItem.data.id;
      if (selectedIds.has(focusedId)) {
        return focusIndexRef.current;
      }
    }
    return items.findIndex((it) => {
      const itId = it.kind === 'parent' ? '__parent__' : it.data.id;
      return selectedIds.has(itId);
    });
  }, [items, selectedIds, focusIndexRef]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (parentRef.current?.closest('[inert]')) {
        return;
      }
      if (document.querySelector('dialog[open], [role="dialog"]')) {
        return;
      }

      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            Boolean(target.closest('select, input, textarea, [contenteditable="true"]'))))
      ) {
        return;
      }

      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable)
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (selectableIds.length > 0) {
          if (onSelectMultiple) {
            onSelectMultiple(selectableIds, 'set');
          } else {
            for (const id of selectableIds) {
              onSelect(id, true);
            }
          }
        }
        return;
      }

      if (
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Home' ||
        e.key === 'End' ||
        e.key === 'PageDown' ||
        e.key === 'PageUp'
      ) {
        if (e.altKey || (e.ctrlKey && !e.shiftKey)) return;
        if (items.length === 0) return;

        e.preventDefault();

        if (
          parentRef.current &&
          document.activeElement instanceof HTMLElement &&
          parentRef.current.contains(document.activeElement)
        ) {
          document.activeElement.blur();
        }

        const pageStep = Math.max(
          1,
          Math.floor((parentRef.current?.clientHeight ?? 0) / rowHeight) || 10
        );

        if (!e.shiftKey) {
          const currentIndex = getActiveIndex();
          let nextIndex: number;

          if (e.key === 'Home') {
            nextIndex = 0;
          } else if (e.key === 'End') {
            nextIndex = items.length - 1;
          } else if (e.key === 'PageDown') {
            nextIndex =
              currentIndex === -1
                ? Math.min(items.length - 1, pageStep - 1)
                : Math.min(items.length - 1, currentIndex + pageStep);
          } else if (e.key === 'PageUp') {
            nextIndex = currentIndex === -1 ? 0 : Math.max(0, currentIndex - pageStep);
          } else if (e.key === 'ArrowDown') {
            nextIndex = currentIndex === -1 ? 0 : Math.min(items.length - 1, currentIndex + 1);
          } else {
            nextIndex = currentIndex === -1 ? items.length - 1 : Math.max(0, currentIndex - 1);
          }

          const nextItem = items[nextIndex];
          if (!nextItem) return;

          const nextId = nextItem.kind === 'parent' ? '__parent__' : nextItem.data.id;

          anchorIndexRef.current = nextIndex;
          focusIndexRef.current = nextIndex;
          lastSelectedIdRef.current = nextItem.kind === 'parent' ? null : nextId;

          onSelect(nextId, false);
          scrollToIndex(nextIndex);
          return;
        }

        let anchor = anchorIndexRef.current;
        if (anchor === -1 || (items[anchor] && items[anchor].kind === 'parent')) {
          const active = getActiveIndex();
          if (active !== -1 && items[active] && items[active].kind !== 'parent') {
            anchor = active;
          } else {
            anchor = items[0]?.kind === 'parent' ? 1 : 0;
          }
          anchorIndexRef.current = anchor;
          focusIndexRef.current = anchor;
        }

        if (anchor >= items.length || !items[anchor]) return;

        const currentFocus = focusIndexRef.current >= 0 ? focusIndexRef.current : anchor;
        const minAllowed = items[0]?.kind === 'parent' ? 1 : 0;
        let newFocus: number;

        if (e.key === 'Home') {
          newFocus = minAllowed;
        } else if (e.key === 'End') {
          newFocus = items.length - 1;
        } else if (e.key === 'PageDown') {
          newFocus = Math.min(items.length - 1, currentFocus + pageStep);
        } else if (e.key === 'PageUp') {
          newFocus = Math.max(minAllowed, currentFocus - pageStep);
        } else if (e.key === 'ArrowDown') {
          newFocus = Math.min(items.length - 1, currentFocus + 1);
        } else {
          newFocus = Math.max(minAllowed, currentFocus - 1);
        }

        focusIndexRef.current = newFocus;
        const focusItem = items[newFocus];
        lastSelectedIdRef.current =
          focusItem && focusItem.kind !== 'parent' ? focusItem.data.id : null;

        const start = Math.min(anchor, newFocus);
        const end = Math.max(anchor, newFocus);
        const rangeIds: string[] = [];

        for (let i = start; i <= end; i++) {
          const it = items[i];
          if (it && it.kind !== 'parent') {
            rangeIds.push(it.data.id);
          }
        }

        if (onSelectMultiple) {
          onSelectMultiple(rangeIds, 'set');
        } else {
          for (const id of rangeIds) {
            onSelect(id, true);
          }
        }

        scrollToIndex(newFocus);
        return;
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && items.length > 0) {
        if (typeAheadBufferRef.current.length === 0 && e.key.trim().length === 0) {
          return;
        }
        const nowChar = e.key.toLowerCase();
        const nextBuf = typeAheadBufferRef.current + nowChar;
        typeAheadBufferRef.current = nextBuf;
        if (typeAheadTimerRef.current !== null) {
          window.clearTimeout(typeAheadTimerRef.current);
        }
        typeAheadTimerRef.current = window.setTimeout(() => {
          typeAheadBufferRef.current = '';
          typeAheadTimerRef.current = null;
        }, 700);

        const activeIdx = getActiveIndex();
        const isRepeatedChar =
          nextBuf.length > 1 && nextBuf.split('').every((ch) => ch === nowChar);

        const findMatchIndex = (prefix: string, startIndex: number): number => {
          for (let offset = 0; offset < items.length; offset++) {
            const idx = (startIndex + offset) % items.length;
            const it = items[idx];
            if (!it || it.kind === 'parent') continue;
            if (it.data.name.toLowerCase().startsWith(prefix)) {
              return idx;
            }
          }
          return -1;
        };

        let matchIndex = -1;
        if (isRepeatedChar) {
          matchIndex = findMatchIndex(nextBuf, activeIdx >= 0 ? activeIdx : 0);
          if (matchIndex === -1) {
            matchIndex = findMatchIndex(
              nowChar,
              activeIdx >= 0 ? (activeIdx + 1) % items.length : 0
            );
          }
        } else {
          matchIndex = findMatchIndex(nextBuf, activeIdx >= 0 ? activeIdx : 0);
        }

        if (matchIndex !== -1) {
          e.preventDefault();
          const matchItem = items[matchIndex];
          if (matchItem && matchItem.kind !== 'parent') {
            const matchId = matchItem.data.id;
            anchorIndexRef.current = matchIndex;
            focusIndexRef.current = matchIndex;
            lastSelectedIdRef.current = matchId;
            onSelect(matchId, false);
            scrollToIndex(matchIndex);
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    parentRef,
    items,
    selectableIds,
    rowHeight,
    scrollToIndex,
    onSelect,
    onSelectMultiple,
    getActiveIndex,
    anchorIndexRef,
    focusIndexRef,
    lastSelectedIdRef,
  ]);

  return { resetTypeAhead };
}
