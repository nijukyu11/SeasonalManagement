'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { RouteCacheProvider } from './RouteCacheContext';

export default function AppRouteCache({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const cacheKey = search ? `${pathname}?${search}` : pathname;

  return (
    <RouteCacheProvider active cacheKey={cacheKey} search={search}>
      {children}
    </RouteCacheProvider>
  );
}
