import { useEffect } from 'react';

export interface UseHorizontalWheelScrollOptions {
  viewportRef: React.RefObject<HTMLElement | null>;
  headerRef?: React.RefObject<HTMLElement | null>;
  allowVerticalScrollFirst?: boolean;
}

function canScrollY(el: HTMLElement, deltaY: number): boolean {
  if (el.scrollHeight <= el.clientHeight) return false;
  if (deltaY > 0) {
    return el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  return el.scrollTop > 0;
}

export function useHorizontalWheelScroll({
  viewportRef,
  headerRef,
  allowVerticalScrollFirst = false,
}: UseHorizontalWheelScrollOptions): void {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const header = headerRef?.current ?? null;

    const handleWheel = (e: WheelEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.deltaX !== 0 || e.deltaY === 0) return;
      if (viewport.scrollWidth <= viewport.clientWidth) return;

      const delta =
        e.deltaMode === 1
          ? e.deltaY * 40
          : e.deltaMode === 2
            ? e.deltaY * viewport.clientWidth
            : e.deltaY;

      let isOverHorizontalScrollbar = false;
      if (allowVerticalScrollFirst) {
        const rect = viewport.getBoundingClientRect();
        isOverHorizontalScrollbar =
          e.clientY >= rect.top + viewport.clientTop + viewport.clientHeight &&
          e.clientY <= rect.bottom &&
          e.clientX >= rect.left &&
          e.clientX <= rect.right;
        const isOverHeader =
          header !== null &&
          e.target instanceof Node &&
          (e.currentTarget === header || header.contains(e.target));

        if (!isOverHeader && !isOverHorizontalScrollbar && canScrollY(viewport, delta)) {
          return;
        }
      }

      const prevScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft !== prevScrollLeft) {
        if (header) {
          header.scrollLeft = viewport.scrollLeft;
        }
        e.preventDefault();
      } else if (isOverHorizontalScrollbar) {
        e.preventDefault();
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    header?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      header?.removeEventListener('wheel', handleWheel);
    };
  }, [viewportRef, headerRef, allowVerticalScrollFirst]);
}
