import { useCallback, useEffect, useRef } from 'react';

export interface MarqueeSelectableRow {
  kind: string;
  data?: { id: string };
}

export interface UseMarqueeSelectionOptions {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  getTotalSize: () => number;
  rowHeight: number;
  itemsRef: React.RefObject<MarqueeSelectableRow[]>;
  selectedIds: Set<string>;
  onSelectMultiple?: (ids: string[], mode?: 'set' | 'add' | 'toggle') => void;
}

export function useMarqueeSelection({
  viewportRef,
  getTotalSize,
  rowHeight,
  itemsRef,
  selectedIds,
  onSelectMultiple,
}: UseMarqueeSelectionOptions) {
  const marqueeBoxRef = useRef<HTMLDivElement | null>(null);
  const marqueeRafRef = useRef<number | null>(null);
  const marqueeCleanupRef = useRef<(() => void) | null>(null);
  const justFinishedMarquee = useRef(false);

  const hideMarqueeBox = useCallback(() => {
    if (marqueeRafRef.current !== null) {
      cancelAnimationFrame(marqueeRafRef.current);
      marqueeRafRef.current = null;
    }
    if (marqueeBoxRef.current) {
      marqueeBoxRef.current.style.display = 'none';
    }
  }, []);

  const cancelMarquee = useCallback(() => {
    marqueeCleanupRef.current?.();
  }, []);

  useEffect(() => {
    return () => {
      if (marqueeRafRef.current !== null) cancelAnimationFrame(marqueeRafRef.current);
      marqueeCleanupRef.current?.();
      marqueeCleanupRef.current = null;
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      const isMarqueeGutter = Boolean(target?.closest('[data-marquee-gutter="true"]'));
      if (!isMarqueeGutter) {
        if (
          target?.closest('button') ||
          target?.closest('input') ||
          target?.closest('select') ||
          target?.closest('a') ||
          target?.closest('[data-row="true"]') ||
          target?.closest('[draggable="true"]')
        ) {
          return;
        }
      }

      const viewport = viewportRef.current;
      if (!viewport) return;

      marqueeCleanupRef.current?.();

      let cachedViewportRect = viewport.getBoundingClientRect();
      let maxContentX = viewport.scrollWidth;
      let maxContentY = Math.max(getTotalSize(), viewport.clientHeight);
      let rectDirty = false;

      const startClientX = e.clientX;
      const startClientY = e.clientY;
      const startScrollTop = viewport.scrollTop;
      const startScrollLeft = viewport.scrollLeft;
      const startContentX = startClientX - cachedViewportRect.left + startScrollLeft;
      const startContentY = startClientY - cachedViewportRect.top + startScrollTop;

      const isModifier = e.shiftKey || e.ctrlKey || e.metaKey;
      const initialSelected = new Set(selectedIds);
      initialSelected.delete('__parent__');
      let isDragging = false;
      let latestClientX = startClientX;
      let latestClientY = startClientY;
      let prevRangeStart = -1;
      let prevRangeEnd = -2;
      let hasAppliedSelection = false;

      const onViewportChange = () => {
        rectDirty = true;
      };

      const updateMarqueeFrame = () => {
        marqueeRafRef.current = null;
        if (!isDragging) return;

        if (rectDirty) {
          cachedViewportRect = viewport.getBoundingClientRect();
          maxContentX = viewport.scrollWidth;
          maxContentY = Math.max(getTotalSize(), viewport.clientHeight);
          rectDirty = false;
        }

        const curScrollTop = viewport.scrollTop;
        const curScrollLeft = viewport.scrollLeft;
        const clientHeight = viewport.clientHeight;
        const scrollHeight = viewport.scrollHeight;

        // Compute nextScrollTop before updating viewport.scrollTop so the marquee math stays in sync.
        const topDist = latestClientY - cachedViewportRect.top;
        const bottomDist = cachedViewportRect.bottom - latestClientY;
        let nextScrollTop = curScrollTop;
        if (topDist < 30) {
          nextScrollTop = Math.max(0, curScrollTop - 10);
        } else if (bottomDist < 30) {
          nextScrollTop = Math.min(Math.max(0, scrollHeight - clientHeight), curScrollTop + 10);
        }
        if (nextScrollTop !== curScrollTop) {
          viewport.scrollTop = nextScrollTop;
        }

        const clampedClientX = Math.max(
          cachedViewportRect.left,
          Math.min(cachedViewportRect.right, latestClientX)
        );
        const clampedClientY = Math.max(
          cachedViewportRect.top,
          Math.min(cachedViewportRect.bottom, latestClientY)
        );

        const currentContentX = clampedClientX - cachedViewportRect.left + curScrollLeft;
        const currentContentY = clampedClientY - cachedViewportRect.top + nextScrollTop;

        const boundedCurrentX = Math.max(0, Math.min(maxContentX, currentContentX));
        const boundedCurrentY = Math.max(0, Math.min(maxContentY, currentContentY));
        const boundedStartX = Math.max(0, Math.min(maxContentX, startContentX));
        const boundedStartY = Math.max(0, Math.min(maxContentY, startContentY));

        const left = Math.min(boundedStartX, boundedCurrentX);
        const top = Math.min(boundedStartY, boundedCurrentY);
        const width = Math.abs(boundedCurrentX - boundedStartX);
        const height = Math.abs(boundedCurrentY - boundedStartY);

        const box = marqueeBoxRef.current;
        if (box) {
          box.style.display = 'block';
          box.style.transform = `translate(${left}px, ${top}px)`;
          box.style.width = `${width}px`;
          box.style.height = `${height}px`;
        }

        const curItems = itemsRef.current;
        let startIdx = -1;
        let endIdx = -2;
        if (curItems.length > 0) {
          const rawStart = Math.floor(top / rowHeight);
          const rawEnd = height > 0 ? Math.floor((top + height - 1) / rowHeight) : rawStart;
          if (rawEnd >= 0 && rawStart < curItems.length) {
            startIdx = Math.max(0, rawStart);
            endIdx = Math.min(curItems.length - 1, rawEnd);
          }
        }

        if (!hasAppliedSelection || startIdx !== prevRangeStart || endIdx !== prevRangeEnd) {
          hasAppliedSelection = true;
          prevRangeStart = startIdx;
          prevRangeEnd = endIdx;

          if (onSelectMultiple) {
            const newSelected = isModifier ? new Set(initialSelected) : new Set<string>();
            for (let i = startIdx; i <= endIdx; i++) {
              const item = curItems[i];
              if (item && item.kind !== 'parent' && item.data) {
                newSelected.add(item.data.id);
              }
            }
            onSelectMultiple(Array.from(newSelected), 'set');
          }
        }

        if (nextScrollTop !== curScrollTop && marqueeRafRef.current === null) {
          marqueeRafRef.current = requestAnimationFrame(updateMarqueeFrame);
        }
      };

      const onMouseMove = (moveEvent: MouseEvent) => {
        latestClientX = moveEvent.clientX;
        latestClientY = moveEvent.clientY;

        if (!isDragging) {
          const dx = latestClientX - startClientX;
          const dy = latestClientY - startClientY;
          if (Math.hypot(dx, dy) > 5) {
            isDragging = true;
          } else {
            return;
          }
        }

        if (marqueeRafRef.current === null) {
          marqueeRafRef.current = requestAnimationFrame(updateMarqueeFrame);
        }
      };

      const cleanupMarquee = () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('blur', onMouseUp);
        window.removeEventListener('resize', onViewportChange);
        if (marqueeCleanupRef.current === cleanupMarquee) {
          marqueeCleanupRef.current = null;
        }
        isDragging = false;
        hideMarqueeBox();
      };

      const onMouseUp = () => {
        if (isDragging) {
          justFinishedMarquee.current = true;
          setTimeout(() => {
            justFinishedMarquee.current = false;
          }, 80);
        }
        cleanupMarquee();
      };

      marqueeCleanupRef.current = cleanupMarquee;
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('blur', onMouseUp);
      window.addEventListener('resize', onViewportChange, { passive: true });
    },
    [viewportRef, getTotalSize, rowHeight, itemsRef, selectedIds, onSelectMultiple, hideMarqueeBox]
  );

  return {
    marqueeBoxRef,
    justFinishedMarquee,
    hideMarqueeBox,
    cancelMarquee,
    handleMouseDown,
  };
}
