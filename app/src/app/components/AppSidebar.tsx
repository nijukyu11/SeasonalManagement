'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOperatorAuth } from './OperatorAuthGate';
import PbbIcon from './PbbIcon';

const SIDEBAR_COLLAPSED_KEY = 'appSidebarCollapsed';
const APP_SIDEBAR_LAST_MODULE_ROUTE_PREFIX = 'appSidebarLastModuleRoute:';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: 'dashboard' },
  { href: '/seasonal', label: 'Seasonal Schedule', icon: 'table_chart' },
  { href: '/detailed', label: 'Detailed Schedule', icon: 'calendar_month' },
  { href: '/daily', label: 'Daily Schedule', icon: 'view_list' },
  { href: '/checkin', label: 'Check-in Allocation', icon: 'countertops' },
  { href: '/gate', label: 'Gate Allocation', icon: 'pbb' },
  { href: '/audit', label: 'Audit Log', icon: 'manage_search' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

type LastModuleRoutes = Record<string, string>;

const MODULE_PATHS = new Set(NAV_ITEMS.map((item) => item.href));

function resolveActiveSeasonId(querySeasonId: string | null, includeStoredSeason: boolean): string | null {
  if (querySeasonId) return querySeasonId;
  if (!includeStoredSeason) return null;
  if (typeof window === 'undefined') return null;
  const storedSeasonId = sessionStorage.getItem('activeSeasonId') || sessionStorage.getItem('detailed_season');
  return storedSeasonId;
}

function buildSeasonRouteHref(pathname: string, seasonId: string | null): string {
  if (!seasonId) return pathname;
  return `${pathname}?season=${encodeURIComponent(seasonId)}`;
}

function readStoredModuleRoutes(): LastModuleRoutes {
  if (typeof window === 'undefined') return {};

  const routes: LastModuleRoutes = {};
  for (const pathname of MODULE_PATHS) {
    const stored = sessionStorage.getItem(`${APP_SIDEBAR_LAST_MODULE_ROUTE_PREFIX}${pathname}`);
    if (!stored) continue;
    const [storedPathname] = stored.split('?');
    if (storedPathname === pathname) routes[pathname] = stored;
  }
  return routes;
}

function getPreservedModuleHref(
  pathname: string,
  seasonId: string | null,
  lastModuleRoutes: LastModuleRoutes
): string {
  const fallbackHref = buildSeasonRouteHref(pathname, seasonId);
  const preservedHref = lastModuleRoutes[pathname];
  if (!preservedHref || pathname === '/') return fallbackHref;

  const [preservedPathname, preservedSearch = ''] = preservedHref.split('?');
  if (preservedPathname !== pathname) return fallbackHref;

  const preservedSeasonId = new URLSearchParams(preservedSearch).get('season');
  if (seasonId && preservedSeasonId === seasonId) return preservedHref;
  return fallbackHref;
}

function scheduleAfterHydration(callback: () => void): () => void {
  if (typeof window.requestAnimationFrame !== 'function') {
    const timeoutId = window.setTimeout(callback, 32);
    return () => window.clearTimeout(timeoutId);
  }

  let secondFrameId: number | null = null;
  const firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(callback);
  });

  return () => {
    window.cancelAnimationFrame(firstFrameId);
    if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
  };
}

export default function AppSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const operatorAuth = useOperatorAuth();
  const currentSearch = searchParams.toString();
  const querySeasonId = searchParams.get('season');
  const ignoreNextClickRef = useRef(false);
  const [canReadStoredSeason, setCanReadStoredSeason] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedRestored, setCollapsedRestored] = useState(false);
  const [lastModuleRoutes, setLastModuleRoutes] = useState<LastModuleRoutes>({});
  const activeSeasonId = useMemo(
    () => resolveActiveSeasonId(querySeasonId, canReadStoredSeason),
    [canReadStoredSeason, querySeasonId],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => !current);
  }, []);

  const handleTogglePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    ignoreNextClickRef.current = true;
    toggleCollapsed();
  }, [toggleCollapsed]);

  const handleToggleClick = useCallback(() => {
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      return;
    }
    toggleCollapsed();
  }, [toggleCollapsed]);

  const navigateTo = useCallback((href: string) => {
    router.push(href);
  }, [router]);

  useEffect(() => {
    return scheduleAfterHydration(() => {
      setCanReadStoredSeason(true);
    });
  }, []);

  useEffect(() => {
    return scheduleAfterHydration(() => {
      setCollapsed(sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
      setCollapsedRestored(true);
      setLastModuleRoutes(readStoredModuleRoutes());
    });
  }, []);

  useEffect(() => {
    if (!collapsedRestored) return;
    sessionStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }, [collapsed, collapsedRestored]);

  useEffect(() => {
    if (activeSeasonId) sessionStorage.setItem('activeSeasonId', activeSeasonId);
  }, [activeSeasonId]);

  useEffect(() => {
    if (!pathname || !MODULE_PATHS.has(pathname)) return undefined;

    const currentHref = currentSearch ? `${pathname}?${currentSearch}` : pathname;
    sessionStorage.setItem(`${APP_SIDEBAR_LAST_MODULE_ROUTE_PREFIX}${pathname}`, currentHref);

    return scheduleAfterHydration(() => {
      setLastModuleRoutes((current) => (
        current[pathname] === currentHref
          ? current
          : { ...current, [pathname]: currentHref }
      ));
    });
  }, [currentSearch, pathname]);

  const navItems = useMemo(() => (
    NAV_ITEMS.map((item) => {
      const href = getPreservedModuleHref(item.href, activeSeasonId, lastModuleRoutes);
      return { ...item, href };
    })
  ), [activeSeasonId, lastModuleRoutes]);

  return (
    <aside
      className={`app-sidebar relative z-40 flex h-screen flex-none flex-col border-r border-slate-200 bg-slate-50 text-slate-700 shadow-sm transition-[width] duration-200 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300 ${collapsed ? 'w-16' : 'w-64'}`}
      aria-label="Main navigation"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="flex h-16 items-center justify-between border-b border-slate-200 px-3 dark:border-slate-800">
        <button
          type="button"
          onClick={() => navigateTo('/')}
          className={`flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 text-slate-900 transition-colors hover:bg-slate-100 dark:text-white dark:hover:bg-slate-900 ${collapsed ? 'justify-center' : ''}`}
          title="Seasonal Management"
        >
          <span className="material-symbols-outlined text-[24px] text-primary">flight_takeoff</span>
          {!collapsed && (
            <span className="min-w-0 truncate text-sm font-semibold tracking-tight">Seasonal Management</span>
          )}
        </button>
        <button
          type="button"
          onPointerDown={handleTogglePointerDown}
          onClick={handleToggleClick}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-transparent text-slate-500 transition-colors hover:border-slate-200 hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:border-slate-800 dark:hover:bg-slate-900 dark:hover:text-white"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="material-symbols-outlined text-[20px]">{collapsed ? 'chevron_right' : 'chevron_left'}</span>
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navItems.map((item) => {
          const isActive = item.href === '/'
            ? pathname === '/'
            : pathname === item.href.split('?')[0];
          return (
            <button
              key={item.label}
              type="button"
              onClick={() => navigateTo(item.href)}
              title={collapsed ? item.label : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium tracking-tight transition-colors ${collapsed ? 'justify-center px-2' : ''} ${
                isActive
                  ? 'bg-primary text-on-primary shadow-sm'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-white'
              }`}
            >
              {item.icon === 'pbb' ? (
                <PbbIcon className="h-5 w-5" />
              ) : (
                <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
              )}
              {!collapsed && <span className="min-w-0 truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {operatorAuth.enabled && (
        <div className="border-t border-slate-200 p-3 dark:border-slate-800">
          {collapsed ? (
            <button
              type="button"
              onClick={() => void operatorAuth.signOut()}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-white"
              title={operatorAuth.email ? `Sign out ${operatorAuth.email}` : 'Sign out'}
              aria-label="Sign out"
              disabled={operatorAuth.signingOut}
            >
              <span className="material-symbols-outlined text-[20px]">logout</span>
            </button>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <span className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-300">verified_user</span>
                <span className="min-w-0 truncate text-xs font-medium text-slate-700 dark:text-slate-300">
                  {operatorAuth.email ?? 'Operator'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void operatorAuth.signOut()}
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-slate-200 px-3 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
                disabled={operatorAuth.signingOut}
              >
                <span className="material-symbols-outlined text-[17px]">logout</span>
                {operatorAuth.signingOut ? 'Signing out...' : 'Sign out'}
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
