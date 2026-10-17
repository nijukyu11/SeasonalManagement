'use client';

import { useState, useCallback, useMemo } from 'react';
import SeasonalVersionChangesView from '@/app/(desktop)/components/SeasonalVersionChangesView';
import type {
  SeasonalPublishVersionSummary,
  SeasonalDraftRecord,
  SeasonalVersionChangesInput,
  SeasonalVersionChangesResult,
} from '@/lib/seasonalPlanningContract';
import { getSeasonalDraftChangesPageV1 } from '@/lib/remoteStore';

export interface PlanningChangesPanelProps {
  seasonId: string;
  sourceKind: 'draft' | 'published';
  selectedVersionId?: string | null;
  draftFlights?: readonly SeasonalDraftRecord[];
  versions: SeasonalPublishVersionSummary[];
  selectedBaseVersionId?: string;
  onSelectBaseVersionId?: (baseVersionId: string) => void;
  draftEpoch?: string | null;
  draftRevision?: string | number | null;
  disabled?: boolean;
}

export function PlanningChangesPanel({
  seasonId,
  sourceKind,
  selectedVersionId,
  versions,
  selectedBaseVersionId: controlledBaseVersionId,
  onSelectBaseVersionId,
  draftEpoch,
  draftRevision,
  disabled = false,
}: PlanningChangesPanelProps) {
  // Local base version fallback if not controlled from parent
  const [localBaseVersionId, setLocalBaseVersionId] = useState<string>('');

  const requestedBaseVersionId = controlledBaseVersionId ?? localBaseVersionId;
  const effectiveBaseVersionId = versions.some((v) => v.version_id === requestedBaseVersionId)
    ? requestedBaseVersionId
    : versions[0]?.version_id ?? '';
  const setBaseVersionId = useCallback((id: string) => {
    if (onSelectBaseVersionId) {
      onSelectBaseVersionId(id);
    } else {
      setLocalBaseVersionId(id);
    }
  }, [onSelectBaseVersionId]);

  const baseVersionMeta = useMemo(() => {
    const found = versions.find((v) => v.version_id === effectiveBaseVersionId);
    if (!found) return null;
    return {
      versionId: found.version_id,
      versionTag: found.version_tag,
      publishedAt: found.published_at,
      notes: found.publish_notes || '',
    };
  }, [versions, effectiveBaseVersionId]);

  // Draft diff loader adapter for SeasonalVersionChangesView using authoritative RPC
  const draftDiffLoader = useCallback(
    async (input: SeasonalVersionChangesInput): Promise<SeasonalVersionChangesResult> => {
      const resolvedBaseId = input.baseVersionId ?? (effectiveBaseVersionId || undefined);
      const res = await getSeasonalDraftChangesPageV1({
        seasonId,
        baseVersionId: resolvedBaseId || null,
        view: input.view,
        afterCursor: input.afterCursor,
        pageSize: input.pageSize ?? 50,
        changeType: input.changeType,
        search: input.search,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        field: input.field,
        groupKey: input.groupKey,
        expectedEpoch: draftEpoch ?? null,
        expectedRevision: draftRevision ?? null,
      });

      return res;
    },
    [seasonId, effectiveBaseVersionId, draftEpoch, draftRevision]
  );

  if (sourceKind === 'draft') {
    if (versions.length === 0) {
      return (
        <div className="space-y-4">
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-xs text-blue-900 shadow-sm dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
            <div className="flex items-center gap-2 font-bold">
              <span className="material-symbols-outlined text-[18px]">info</span>
              <span>Kế hoạch ban đầu (chưa có bản công bố)</span>
            </div>
            <p className="mt-1">
              Mùa này chưa từng được công bố phiên bản nào. Toàn bộ các chuyến bay trong bản nháp hiện hành được coi là chuyến thêm mới ban đầu.
            </p>
          </div>

          <SeasonalVersionChangesView
            versionId="draft"
            disabled={disabled}
            versions={versions}
            loadPageOverride={draftDiffLoader}
          />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {/* Base Version Selector for Draft */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
              Đối chiếu bản nháp hiện hành với:
            </span>
            <select
              value={effectiveBaseVersionId}
              onChange={(e) => setBaseVersionId(e.target.value)}
              disabled={disabled}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-900 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white"
            >
              {versions.map((v) => (
                <option key={v.version_id} value={v.version_id}>
                  {v.version_tag} ({v.published_at.slice(0, 10)})
                </option>
              ))}
            </select>
          </div>
          {baseVersionMeta && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {baseVersionMeta.notes ? `Ghi chú: ${baseVersionMeta.notes}` : ''}
            </span>
          )}
        </div>

        <SeasonalVersionChangesView
          versionId="draft"
          disabled={disabled}
          versions={versions}
          loadPageOverride={draftDiffLoader}
        />
      </div>
    );
  }

  // Published source comparison: use existing SeasonalVersionChangesView with versionId
  if (!selectedVersionId) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-slate-200 bg-white text-xs text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        Vui lòng chọn một phiên bản công bố từ thanh tiêu đề để xem thay đổi.
      </div>
    );
  }

  return (
    <SeasonalVersionChangesView
      versionId={selectedVersionId}
      disabled={disabled}
      versions={versions}
    />
  );
}
