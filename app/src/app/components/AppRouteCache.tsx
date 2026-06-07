'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import AuditLogPage from '../audit/page';
import CheckInAllocationPage from '../checkin/page';
import DailyPage from '../daily/page';
import DashboardPage from '../dashboard/page';
import DetailedPage from '../detailed/page';
import GateAllocationPage from '../gate/page';
import HomePage from '../page';
import SeasonalSchedulePage from '../seasonal/page';
import SettingsPage from '../settings/page';
import { RouteCacheProvider } from './RouteCacheContext';

type CachedRouteEntry = {
  key: string;
  pathname: string;
  search: string;
};

const MAX_CACHED_ROUTE_ENTRIES = 5;

const CACHEABLE_MODULE_PATHS = new Set([
  '/',
  '/seasonal',
  '/dashboard',
  '/detailed',
  '/daily',
  '/checkin',
  '/gate',
  '/audit',
  '/settings',
]);

const ALLOCATION_CACHE_PATHS = new Set(['/checkin', '/gate']);

function getRouteCacheKey(pathname: string, search: string): string {
  if (ALLOCATION_CACHE_PATHS.has(pathname)) {
    const params = new URLSearchParams(search);
    const seasonId = params.get('season');
    return seasonId ? `${pathname}?season=${seasonId}` : pathname;
  }
  return search ? `${pathname}?${search}` : pathname;
}

function isCacheableModulePath(pathname: string): boolean {
  return CACHEABLE_MODULE_PATHS.has(pathname);
}

function trimCachedRouteEntries(entries: CachedRouteEntry[], activeKey: string): CachedRouteEntry[] {
  if (entries.length <= MAX_CACHED_ROUTE_ENTRIES) return entries;
  const activeEntry = entries.find((entry) => entry.key === activeKey) ?? null;
  const inactiveEntries = entries.filter((entry) => entry.key !== activeKey);
  const inactiveLimit = MAX_CACHED_ROUTE_ENTRIES - (activeEntry ? 1 : 0);
  const recentInactiveEntries = inactiveEntries.slice(Math.max(0, inactiveEntries.length - inactiveLimit));
  return activeEntry ? [...recentInactiveEntries, activeEntry] : inactiveEntries.slice(-MAX_CACHED_ROUTE_ENTRIES);
}

function renderCachedRouteModule(pathname: string): ReactNode {
  switch (pathname) {
    case '/':
      return <HomePage />;
    case '/seasonal':
      return <SeasonalSchedulePage />;
    case '/dashboard':
      return <DashboardPage />;
    case '/detailed':
      return <DetailedPage />;
    case '/daily':
      return <DailyPage />;
    case '/checkin':
      return <CheckInAllocationPage />;
    case '/gate':
      return <GateAllocationPage />;
    case '/audit':
      return <AuditLogPage />;
    case '/settings':
      return <SettingsPage />;
    default:
      return null;
  }
}

const CachedRoutePanel = memo(function CachedRoutePanel({
  active,
  entry,
}: {
  active: boolean;
  entry: CachedRouteEntry;
}) {
  return (
    <section
      className="app-route-cache-panel"
      data-route-cache-key={entry.key}
      data-route-cache-active={active ? 'true' : 'false'}
      aria-hidden={!active}
      inert={!active ? true : undefined}
    >
      <RouteCacheProvider active={active} cacheKey={entry.key} search={entry.search}>
        {renderCachedRouteModule(entry.pathname)}
      </RouteCacheProvider>
    </section>
  );
}, (previous, next) => (
  previous.active === next.active &&
  previous.entry.key === next.entry.key &&
  previous.entry.pathname === next.entry.pathname &&
  previous.entry.search === next.entry.search
));

export default function AppRouteCache({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const activeCacheKey = useMemo(() => getRouteCacheKey(pathname, search), [pathname, search]);
  const isCacheable = isCacheableModulePath(pathname);
  const [cachedEntries, setCachedEntries] = useState<CachedRouteEntry[]>(() =>
    isCacheable
      ? [
          {
            key: activeCacheKey,
            pathname,
            search,
          },
        ]
      : [],
  );

  useEffect(() => {
    if (!isCacheable) return undefined;

    const timeoutId = window.setTimeout(() => {
      setCachedEntries((entries) => {
        const nextEntry = {
          key: activeCacheKey,
          pathname,
          search,
        };
        const entriesWithoutActive = entries.filter((entry) => entry.key !== activeCacheKey);
        return trimCachedRouteEntries([...entriesWithoutActive, nextEntry], activeCacheKey);
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [activeCacheKey, isCacheable, pathname, search]);

  const visibleEntries = useMemo(() => {
    if (!isCacheable) return [];
    const activeEntry = {
      key: activeCacheKey,
      pathname,
      search,
    };
    const entries = cachedEntries.some((entry) => entry.key === activeCacheKey)
      ? cachedEntries.map((entry) => entry.key === activeCacheKey ? activeEntry : entry)
      : [...cachedEntries, activeEntry];
    return trimCachedRouteEntries(entries, activeCacheKey);
  }, [activeCacheKey, cachedEntries, isCacheable, pathname, search]);

  if (!isCacheable) {
    return (
      <RouteCacheProvider active cacheKey={activeCacheKey} search={search}>
        {children}
      </RouteCacheProvider>
    );
  }

  return (
    <div className="app-route-cache-root">
      {visibleEntries.map((entry) => {
        const isActive = entry.key === activeCacheKey;
        return <CachedRoutePanel key={entry.key} active={isActive} entry={entry} />;
      })}
    </div>
  );
}
