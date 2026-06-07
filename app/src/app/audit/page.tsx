'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAuditDeltaChunks, getAuditLogEntries, getAuditSessions } from '@/lib/remoteStore';
import { getOrCreateAuditSessionId, type AuditDeltaItem, type AuditLogEntry, type AuditSession } from '@/lib/auditLog';
import { buildLoadProgress } from '@/lib/importProgress';
import LoadingStatusPanel from '../components/LoadingStatusPanel';

type AuditFilters = {
  season: string;
  module: string;
  category: string;
  search: string;
};

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function matchesFilter(entry: AuditLogEntry, filters: AuditFilters): boolean {
  if (filters.season && entry.seasonCode !== filters.season && entry.seasonId !== filters.season) return false;
  if (filters.module && entry.module !== filters.module) return false;
  if (filters.category && entry.category !== filters.category) return false;
  const query = filters.search.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    entry.operation,
    entry.module,
    entry.category,
    entry.seasonCode,
    entry.seasonId,
    ...entry.targetFlightLabels,
    ...entry.targetFlightIds,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export default function AuditLogPage() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AuditSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const [expandedDeltas, setExpandedDeltas] = useState<Record<string, AuditDeltaItem[]>>({});
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [filters, setFilters] = useState<AuditFilters>({
    season: '',
    module: '',
    category: '',
    search: '',
  });

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    async function loadSessions(sessionId: string): Promise<void> {
      setLoadingSessions(true);
      try {
        const nextSessions = await getAuditSessions();
        if (cancelled) return;
        setSessions(nextSessions);
        setSelectedSessionId((current) => {
          if (current) return current;
          if (nextSessions.some((session) => session.id === sessionId)) return sessionId;
          return nextSessions[0]?.id ?? sessionId;
        });
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    }

    timeoutId = window.setTimeout(() => {
      const sessionId = getOrCreateAuditSessionId();
      setCurrentSessionId(sessionId);
      void loadSessions(sessionId);
    }, 0);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (!selectedSessionId) return undefined;
    let cancelled = false;
    const sessionId = selectedSessionId;

    async function loadEntries(): Promise<void> {
      setLoadingEntries(true);
      try {
        const nextEntries = await getAuditLogEntries(sessionId);
        if (!cancelled) setEntries(nextEntries);
      } finally {
        if (!cancelled) setLoadingEntries(false);
      }
    }

    void loadEntries();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  const filteredEntries = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filters)),
    [entries, filters]
  );

  const seasonOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.seasonCode ?? entry.seasonId).filter(Boolean) as string[])).sort(),
    [entries]
  );

  const moduleOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.module))).sort(),
    [entries]
  );

  const categoryOptions = useMemo(
    () => Array.from(new Set(entries.map((entry) => entry.category))).sort(),
    [entries]
  );

  async function toggleEntry(entry: AuditLogEntry): Promise<void> {
    if (expandedEntryId === entry.id) {
      setExpandedEntryId(null);
      return;
    }

    setExpandedEntryId(entry.id);
    if (expandedDeltas[entry.id] || !selectedSessionId) return;
    const chunks = await getAuditDeltaChunks(selectedSessionId, entry.id);
    setExpandedDeltas((current) => ({
      ...current,
      [entry.id]: chunks.flatMap((chunk) => chunk.items).concat(entry.deltas ?? []),
    }));
  }

  const selectedSession = sessions.find((session) => session.id === selectedSessionId);

  return (
    <main className="flex h-screen min-w-0 overflow-hidden bg-slate-100 p-3 text-slate-900 dark:bg-slate-950 dark:text-slate-100 sm:p-4 lg:p-6">
      <div className="mx-auto flex h-full w-full max-w-[1800px] min-w-0 flex-col gap-4 lg:gap-5">
        <header className="flex flex-none flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Session-scoped trace of data-changing actions and synchronization deltas.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (selectedSessionId) void getAuditLogEntries(selectedSessionId).then(setEntries);
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Refresh
          </button>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)] lg:gap-5">
          <section
            className="min-w-0 overflow-auto rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            aria-label="Audit sessions"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Sessions</h2>
              {loadingSessions && <span className="text-xs text-slate-400">Loading audit sessions</span>}
            </div>
            <div className="space-y-2">
              {sessions.length === 0 && loadingSessions && (
                <LoadingStatusPanel
                  progress={buildLoadProgress('Loading audit sessions', 40, 'Fetching saved sessions', { indeterminate: true })}
                  className="min-h-[180px] rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                  icon="history"
                />
              )}
              {sessions.length === 0 && !loadingSessions && (
                <div className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  No persisted audit sessions yet.
                </div>
              )}
              {sessions.map((session) => {
                const isCurrent = session.id === currentSessionId;
                const isSelected = session.id === selectedSessionId;
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    className={`w-full rounded-md border p-3 text-left text-sm transition-colors ${
                      isSelected
                        ? 'border-primary bg-blue-50 text-blue-950 dark:bg-blue-950/40 dark:text-blue-100'
                        : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-950 dark:hover:bg-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{isCurrent ? 'Current session' : session.id}</span>
                      {isCurrent && <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-on-primary">LIVE</span>}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{formatTimestamp(session.lastSeenAt)}</div>
                    <div className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">
                      {session.actor.email ?? session.actor.displayName ?? 'Anonymous'}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="border-b border-slate-200 p-4 dark:border-slate-800">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">Entries</h2>
                  <p className="max-w-full truncate text-sm text-slate-500 dark:text-slate-400">
                    {selectedSession ? selectedSession.id : selectedSessionId ?? 'No session selected'}
                  </p>
                </div>
                <div className="text-sm text-slate-500 dark:text-slate-400">
                  {filteredEntries.length} / {entries.length} entries
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <input
                  value={filters.search}
                  onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                  placeholder="Search operation or flight"
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
                <select
                  value={filters.season}
                  onChange={(event) => setFilters((current) => ({ ...current, season: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">All seasons</option>
                  {seasonOptions.map((season) => <option key={season} value={season}>{season}</option>)}
                </select>
                <select
                  value={filters.module}
                  onChange={(event) => setFilters((current) => ({ ...current, module: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">All modules</option>
                  {moduleOptions.map((module) => <option key={module} value={module}>{module}</option>)}
                </select>
                <select
                  value={filters.category}
                  onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
                  className="w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">All categories</option>
                  {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              <table className="min-w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                  <tr>
                    <th className="w-12 border-b border-slate-200 px-3 py-2 dark:border-slate-800" />
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Time</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Module</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Category</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Operation</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Flights</th>
                    <th className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {loadingEntries && (
                    <tr>
                      <td colSpan={7} className="px-3 py-4">
                        <LoadingStatusPanel
                          progress={buildLoadProgress('Loading audit entries', 55, 'Fetching change records', { indeterminate: true })}
                          className="min-h-[180px]"
                          icon="history"
                        />
                      </td>
                    </tr>
                  )}
                  {!loadingEntries && filteredEntries.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">No audit entries match the current filters.</td>
                    </tr>
                  )}
                  {filteredEntries.map((entry) => {
                    const isExpanded = expandedEntryId === entry.id;
                    const deltas = expandedDeltas[entry.id] ?? [];
                    return (
                      <tr key={entry.id} className="align-top odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-950">
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <button
                            type="button"
                            onClick={() => void toggleEntry(entry)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                            aria-label={isExpanded ? 'Collapse audit delta' : 'Expand audit delta'}
                          >
                            <span className="material-symbols-outlined text-[18px]">{isExpanded ? 'expand_less' : 'expand_more'}</span>
                          </button>
                        </td>
                        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3 dark:border-slate-800">{formatTimestamp(entry.timestamp)}</td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">{entry.module}</td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">{entry.category}</td>
                        <td className="max-w-xl border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <div className="font-medium">{entry.operation}</div>
                          {entry.syncDelta && (
                            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                              Added {entry.syncDelta.flightsAdded}, removed {entry.syncDelta.flightsRemoved}, modified {entry.syncDelta.flightsModified}; period {entry.syncDelta.affectedPeriod.from ?? '-'} to {entry.syncDelta.affectedPeriod.to ?? '-'}
                            </div>
                          )}
                          {isExpanded && (
                            <div className="mt-3 max-h-72 overflow-auto rounded-md border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
                              <table className="min-w-full text-xs">
                                <thead className="bg-slate-100 text-left text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                                  <tr>
                                    <th className="px-2 py-1">Target</th>
                                    <th className="px-2 py-1">Field</th>
                                    <th className="px-2 py-1">Before</th>
                                    <th className="px-2 py-1">After</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {deltas.length === 0 && (
                                    <tr>
                                      <td colSpan={4} className="px-2 py-3 text-center text-slate-500">No delta details stored.</td>
                                    </tr>
                                  )}
                                  {deltas.map((delta, index) => (
                                    <tr key={`${entry.id}-${delta.targetId}-${delta.field}-${index}`} className="border-t border-slate-200 dark:border-slate-800">
                                      <td className="max-w-[180px] truncate px-2 py-1">{delta.targetLabel}</td>
                                      <td className="px-2 py-1">{delta.field}</td>
                                      <td className="max-w-[260px] truncate px-2 py-1">{formatValue(delta.before)}</td>
                                      <td className="max-w-[260px] truncate px-2 py-1">{formatValue(delta.after)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                        <td className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          <div className="flex max-w-[240px] flex-wrap gap-1">
                            {entry.targetFlightLabels.length === 0 && <span className="text-slate-400">-</span>}
                            {entry.targetFlightLabels.slice(0, 6).map((label) => (
                              <span key={label} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium dark:bg-slate-800">{label}</span>
                            ))}
                            {entry.targetFlightLabels.length > 6 && <span className="text-xs text-slate-500">+{entry.targetFlightLabels.length - 6}</span>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3 dark:border-slate-800">
                          {(entry.deltaChunkCount ?? 0) > 0 ? `${entry.deltaChunkCount} chunks` : `${entry.deltas.length} items`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
