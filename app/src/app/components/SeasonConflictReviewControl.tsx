'use client';

import { useEffect, useState } from 'react';
import { queryNativeConflictSummary, resolveNativeSeasonConflict } from '@/lib/nativeSeasonRepository';
import type { SeasonConflictItem, SeasonConflictResolution } from '@/lib/seasonChangeEvents';
import { publishSeasonWorkspaceChanged, subscribeSeasonWorkspaceChanges } from '@/lib/seasonDataCache';
import { LEGACY_NATIVE_SYNC_ENABLED } from '@/lib/legacyNativeSyncAdapter';
import { useAppDialog } from './AppDialog';

interface SeasonConflictReviewControlProps {
  seasonId: string | null | undefined;
}

function formatConflictValue(value: unknown): string {
  if (value == null || value === '') return 'empty';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return 'value';
  }
}

export default function SeasonConflictReviewControl({ seasonId }: SeasonConflictReviewControlProps) {
  const { showAlert } = useAppDialog();
  const [conflicts, setConflicts] = useState<SeasonConflictItem[]>([]);
  const [busyConflictId, setBusyConflictId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadConflicts = async () => {
      const summary = seasonId ? await queryNativeConflictSummary(seasonId) : null;
      if (!cancelled) setConflicts((summary?.conflicts ?? []) as SeasonConflictItem[]);
    };
    void loadConflicts();
    if (!seasonId) return () => {
      cancelled = true;
    };
    const unsubscribe = subscribeSeasonWorkspaceChanges((event) => {
      if (event.seasonId === seasonId) void loadConflicts();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [seasonId]);

  const handleResolution = async (conflict: SeasonConflictItem, resolution: SeasonConflictResolution) => {
    if (!seasonId) return;
    if (resolution === 'editManually') {
      void showAlert({
        title: 'Manual Edit Needed',
        message: `Edit ${conflict.targetType} ${conflict.targetId}, then sync again. The review item will stay visible until you keep your edit or accept the remote value.`,
        tone: 'info',
      });
      return;
    }
    setBusyConflictId(conflict.id);
    try {
      const resolved = await resolveNativeSeasonConflict(seasonId, conflict.id, resolution);
      if (!resolved) throw new Error('Native conflict resolution is not available in this runtime.');
      setConflicts((current) => current.filter((entry) => entry.id !== conflict.id));
      publishSeasonWorkspaceChanged({
        seasonId,
        localRevision: resolved.syncMeta.localRevision ?? null,
        source: resolution === 'acceptRemote' ? 'native-conflict-accept-remote' : 'native-conflict-keep-mine',
        syncMeta: resolved.syncMeta,
      });
    } catch (error) {
      void showAlert({
        title: 'Conflict Review Failed',
        message: error instanceof Error ? error.message : 'Unable to resolve this sync conflict.',
        tone: 'error',
      });
    } finally {
      setBusyConflictId(null);
    }
  };

  if (!LEGACY_NATIVE_SYNC_ENABLED || !seasonId || conflicts.length === 0) return null;

  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100">
        <span className="material-symbols-outlined text-[16px]">rule</span>
        Review {conflicts.length}
      </summary>
      <div className="absolute right-0 z-50 mt-2 max-h-[70vh] w-[min(92vw,34rem)] overflow-auto rounded-lg border border-amber-200 bg-white p-4 text-sm shadow-xl">
        <div className="mb-3">
          <h3 className="font-semibold text-slate-900">Sync conflicts</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">Choose which version should remain in this local workspace.</p>
        </div>
        <div className="grid gap-3">
          {conflicts.map((conflict) => (
            <section key={conflict.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-semibold text-slate-900">{conflict.targetType} {conflict.targetId}</div>
                  <div className="text-xs text-slate-600">{conflict.overlappingFields.join(', ')}</div>
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {conflict.overlappingFields.map((field) => (
                  <div key={field} className="grid grid-cols-[5.5rem,1fr,1fr] gap-2 rounded-md bg-white p-2 text-xs">
                    <div className="font-semibold text-slate-700">{field}</div>
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">Mine</div>
                      <div className="break-words text-slate-900">{formatConflictValue(conflict.localFields[field])}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase text-slate-500">Remote</div>
                      <div className="break-words text-slate-900">{formatConflictValue(conflict.remoteFields[field])}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyConflictId === conflict.id}
                  onClick={() => void handleResolution(conflict, 'keepMine')}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-white disabled:opacity-50"
                >
                  Keep mine
                </button>
                <button
                  type="button"
                  disabled={busyConflictId === conflict.id}
                  onClick={() => void handleResolution(conflict, 'acceptRemote')}
                  className="rounded-md border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 disabled:opacity-50"
                >
                  Accept remote
                </button>
                <button
                  type="button"
                  disabled={busyConflictId === conflict.id}
                  onClick={() => void handleResolution(conflict, 'editManually')}
                  className="rounded-md border border-amber-200 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                >
                  Edit manually
                </button>
              </div>
            </section>
          ))}
        </div>
      </div>
    </details>
  );
}
