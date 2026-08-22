'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

type RouteCacheContextValue = {
  active: boolean;
  cacheKey: string;
  search: string;
};

const RouteCacheContext = createContext<RouteCacheContextValue>({
  active: true,
  cacheKey: '',
  search: '',
});

export function RouteCacheProvider({
  active,
  cacheKey,
  search,
  children,
}: RouteCacheContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({
      active,
      cacheKey,
      search,
    }),
    [active, cacheKey, search],
  );

  return <RouteCacheContext.Provider value={value}>{children}</RouteCacheContext.Provider>;
}

export function useCachedRouteSearchParams(): URLSearchParams {
  const { search } = useContext(RouteCacheContext);

  return useMemo(() => new URLSearchParams(search), [search]);
}

export function useCachedRouteActivity(): boolean {
  const { active } = useContext(RouteCacheContext);

  return active;
}
