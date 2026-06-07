'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

function resolveInitialValue<T>(initialValue: T | (() => T)): T {
  return typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
}

export function useSessionState<T>(
  key: string,
  initialValue: T | (() => T)
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const fallback = resolveInitialValue(initialValue);
    if (typeof window === 'undefined') return fallback;

    const stored = sessionStorage.getItem(key);
    if (!stored) return fallback;

    try {
      return JSON.parse(stored) as T;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Session preservation is best-effort and should not block UI work.
    }
  }, [key, value]);

  return [value, setValue];
}
