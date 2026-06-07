'use client';

import { useEffect, type RefObject } from 'react';

type ScrollPosition = {
  left: number;
  top: number;
};

function readScrollPosition(key: string): ScrollPosition | null {
  if (typeof window === 'undefined') return null;
  const stored = sessionStorage.getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as ScrollPosition;
  } catch {
    return null;
  }
}

export function useSessionScrollRestoration<T extends HTMLElement>(
  key: string,
  ref: RefObject<T | null>
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof window === 'undefined') return undefined;

    const restoreFrame = window.requestAnimationFrame(() => {
      const position = readScrollPosition(key);
      if (!position) return;
      node.scrollLeft = position.left;
      node.scrollTop = position.top;
    });

    let persistFrame: number | null = null;
    const persist = () => {
      if (persistFrame !== null) window.cancelAnimationFrame(persistFrame);
      persistFrame = window.requestAnimationFrame(() => {
        try {
          sessionStorage.setItem(key, JSON.stringify({ left: node.scrollLeft, top: node.scrollTop }));
        } catch {
          // Scroll state is best-effort and must not interrupt interaction.
        }
      });
    };

    node.addEventListener('scroll', persist, { passive: true });

    return () => {
      window.cancelAnimationFrame(restoreFrame);
      if (persistFrame !== null) window.cancelAnimationFrame(persistFrame);
      node.removeEventListener('scroll', persist);
      try {
        sessionStorage.setItem(key, JSON.stringify({ left: node.scrollLeft, top: node.scrollTop }));
      } catch {
        // Ignore storage failures during teardown.
      }
    };
  }, [key, ref]);
}
