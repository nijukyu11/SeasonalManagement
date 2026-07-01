'use client';

import type { Dispatch, SetStateAction } from 'react';
import type {
  DashboardAiNotebook,
  DashboardAiToolName,
} from '@/lib/dashboardAiAnalysis';
import type { DashboardAiQueryScope } from '@/lib/dashboardAiShared';
import type { DashboardReportTemplateId } from '@/lib/dashboardReportExport';
import { AiNotebookCanvas, type AiNotebookActionHandlers, type AiNotebookLoadingStep } from './AiNotebookCanvas';
import type { AiNotebookRendererData, AiWorkspaceTableRow } from './AiNotebookBlockRenderers';

export interface AiWorkspacePreset {
  label: string;
  prompt: string;
  mode: 'board' | 'chat';
  preferredTool?: DashboardAiToolName;
}

export interface AiWorkspaceModelOption {
  id: string;
  label: string;
}

export const AI_PRESET_GROUPS = [
  { id: 'board', label: 'Tạo báo cáo', mode: 'board' as const },
  { id: 'chat', label: 'Hỏi AI', mode: 'chat' as const },
];

export interface AiWorkspacePanelProps {
  notebook: DashboardAiNotebook | null;
  aiPrompt: string;
  setAiPrompt: Dispatch<SetStateAction<string>>;
  aiLoading: boolean;
  aiLoadingMessage: string;
  aiLoadingStep: AiNotebookLoadingStep;
  aiLoadingStartedAt: number | null;
  aiError: string | null;
  lastAiPrompt: string;
  aiConfigured: boolean;
  selectedModelId: string;
  models: AiWorkspaceModelOption[];
  onModelChange: (modelId: string) => void;
  canTryDifferentModel: boolean;
  activeSeasonLabel: string;
  activeSeasonDateRangeLabel: string;
  hasActiveSeason: boolean;
  queryScope: DashboardAiQueryScope;
  queryScopeLabel: string;
  onQueryScopeDateFromChange: (value: string) => void;
  onQueryScopeDateToChange: (value: string) => void;
  onResetQueryScopeToSeason: () => void;
  seasonSummaryRows: AiWorkspaceTableRow[];
  dataError: string | null;
  presets: AiWorkspacePreset[];
  rendererData: AiNotebookRendererData;
  actions: AiNotebookActionHandlers;
  onCancel: () => void;
  onClearNotebook: () => void;
  onDownloadReport: (templateId: DashboardReportTemplateId) => void;
  summaryExportDisabled: boolean;
}

export function AiWorkspacePanel({
  notebook,
  aiPrompt,
  setAiPrompt,
  aiLoading,
  aiLoadingMessage,
  aiLoadingStep,
  aiLoadingStartedAt,
  aiError,
  lastAiPrompt,
  aiConfigured,
  selectedModelId,
  models,
  onModelChange,
  canTryDifferentModel,
  activeSeasonLabel,
  activeSeasonDateRangeLabel,
  hasActiveSeason,
  queryScope,
  queryScopeLabel,
  onQueryScopeDateFromChange,
  onQueryScopeDateToChange,
  onResetQueryScopeToSeason,
  seasonSummaryRows,
  dataError,
  presets,
  rendererData,
  actions,
  onCancel,
  onClearNotebook,
  onDownloadReport,
  summaryExportDisabled,
}: AiWorkspacePanelProps) {
  return (
    <>
      <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-on-surface">AI Workspace</h2>
            <p className="mt-1 text-sm text-on-surface-variant">Rich Chat AI read-only để tạo bảng, biểu đồ và báo cáo trực quan.</p>
          </div>
          <label className="w-full min-w-[180px] text-xs font-bold uppercase text-on-surface-variant sm:w-auto">
            Model
            <select
              value={selectedModelId}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={models.length === 0 || aiLoading}
              className="mt-1 min-h-10 w-full rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm font-semibold normal-case text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
            >
              {models.length === 0 ? (
                <option value="">Chưa có model</option>
              ) : models.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
          <div>
            <div className="mb-2 text-xs font-bold uppercase text-on-surface-variant">Mùa chung toàn app</div>
            <div className="rounded-lg border border-outline-variant bg-surface px-3 py-2">
              <div className="inline-flex min-h-8 items-center gap-2 text-sm font-semibold text-on-surface">
                <span className="material-symbols-outlined text-[16px] text-primary">event_available</span>
                {activeSeasonLabel}
              </div>
              <div className="mt-1 text-xs text-on-surface-variant">{activeSeasonDateRangeLabel}</div>
            </div>
            {dataError && (
              <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">{dataError}</div>
            )}
            <div className="mt-3 rounded-lg border border-outline-variant bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">Phạm vi</div>
                  <div className="mt-1 text-sm font-semibold text-on-surface">{queryScopeLabel}</div>
                </div>
                <button
                  type="button"
                  onClick={onResetQueryScopeToSeason}
                  disabled={aiLoading || !hasActiveSeason}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md border border-outline-variant bg-surface-container px-3 py-1.5 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[15px]">restart_alt</span>
                  Đặt theo mùa đang chọn
                </button>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">
                  Từ ngày
                  <input
                    type="date"
                    value={queryScope.dateFrom ?? ''}
                    onChange={(event) => onQueryScopeDateFromChange(event.target.value)}
                    disabled={aiLoading}
                    className="mt-1 min-h-10 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm font-semibold normal-case text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                </label>
                <label className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">
                  Đến ngày
                  <input
                    type="date"
                    value={queryScope.dateTo ?? ''}
                    onChange={(event) => onQueryScopeDateToChange(event.target.value)}
                    disabled={aiLoading}
                    className="mt-1 min-h-10 w-full rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm font-semibold normal-case text-on-surface focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                  />
                </label>
              </div>
            </div>
          </div>
          <div className="grid gap-2 text-xs text-on-surface-variant">
            {seasonSummaryRows.map((row) => (
              <div key={String(row.Season)} className="grid grid-cols-[72px_1fr_72px] gap-2 rounded-md bg-surface px-3 py-2">
                <span className="font-bold text-on-surface">{row.Season}</span>
                <span className="truncate">{row.Name}</span>
                <span className="text-right font-semibold">{Number(row.Flights || 0).toLocaleString('en-US')}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-3">
            {AI_PRESET_GROUPS.map((group) => {
              const groupPresets = presets.filter((preset) => preset.mode === group.mode);
              if (groupPresets.length === 0) return null;
              return (
                <div key={group.id}>
                  <div className="mb-2 text-xs font-bold uppercase tracking-wide text-on-surface-variant">{group.label}</div>
                  <div className="flex flex-wrap gap-2">
                    {groupPresets.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => { void actions.submitPrompt(preset.prompt, { preferredTool: preset.preferredTool }); }}
                        disabled={aiLoading || !aiConfigured}
                        className={`min-h-10 rounded-full border px-3 py-2 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50 ${
                          preset.mode === 'board'
                            ? 'border-primary/40 bg-primary-container/30 text-on-surface'
                            : 'border-outline-variant bg-surface text-on-surface'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-on-surface-variant">Xuất Excel</div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onDownloadReport('sanluong-summary')}
                disabled={summaryExportDisabled}
                className="inline-flex min-h-10 items-center gap-1 rounded-full border border-outline-variant bg-surface px-3 py-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[15px]">download</span>
                Xuất tổng hợp sản lượng
              </button>
              <button
                type="button"
                onClick={onClearNotebook}
                disabled={aiLoading}
                className="inline-flex min-h-10 items-center gap-1 rounded-full border border-outline-variant bg-surface px-3 py-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[15px]">backspace</span>
                Xóa chat
              </button>
            </div>
          </div>
        </div>
      </section>

      <AiNotebookCanvas
        notebook={notebook}
        aiPrompt={aiPrompt}
        setAiPrompt={setAiPrompt}
        aiLoading={aiLoading}
        aiLoadingMessage={aiLoadingMessage}
        aiLoadingStep={aiLoadingStep}
        aiLoadingStartedAt={aiLoadingStartedAt}
        aiError={aiError}
        lastAiPrompt={lastAiPrompt}
        aiConfigured={aiConfigured}
        canTryDifferentModel={canTryDifferentModel}
        selectedSeasonCount={hasActiveSeason ? 1 : 0}
        rendererData={rendererData}
        actions={actions}
        onCancel={onCancel}
      />
    </>
  );
}
