'use client';

import type { SeasonalImportPreviewState } from '@/lib/seasonalImportPreview';
import { canCommitSeasonalImportPreview } from '@/lib/seasonalImportPreview';
import type { SeasonalImportV3Strategy } from '@/lib/seasonalImportV3Contract';

type PreviewDialogState = Extract<
  SeasonalImportPreviewState,
  { kind: 'preview' | 'committing' }
>;

interface SeasonalImportPreviewDialogProps {
  state: PreviewDialogState | null;
  hasDraftChanges: boolean;
  busy: boolean;
  strategyLocked?: boolean;
  onStrategyChange: (strategy: SeasonalImportV3Strategy) => void;
  onConfirmationChange: (confirmation: string) => void;
  onCancel: () => void;
  onCommit: () => void;
}

function countRows(strategy: SeasonalImportV3Strategy) {
  return [
    ['Insert', 'insertCount'],
    ['Baseline update', 'baselineUpdateCount'],
    ['Unchanged', 'unchangedCount'],
    ['Preserved outside file', 'preservedOutsideScopeCount'],
    [strategy === 'replace' ? 'Prior season flights removed' : 'Removed', 'removeImportedCount'],
    ['Preserved overlays', 'preservedOverlayCount'],
  ] as const;
}

export default function SeasonalImportPreviewDialog({
  state,
  hasDraftChanges,
  busy,
  strategyLocked = false,
  onStrategyChange,
  onConfirmationChange,
  onCancel,
  onCommit,
}: SeasonalImportPreviewDialogProps) {
  if (!state) return null;
  const { result } = state;
  const confirmation = state.kind === 'preview' ? state.confirmation : '';
  const commitEnabled = canCommitSeasonalImportPreview({
    state,
    hasDraftChanges,
    busy,
  });
  const diagnosticsByCode = result.diagnostics.reduce<Map<string, typeof result.diagnostics>>(
    (groups, diagnostic) => {
      const current = groups.get(diagnostic.code) ?? [];
      current.push(diagnostic);
      groups.set(diagnostic.code, current);
      return groups;
    },
    new Map(),
  );
  const clearedOverlays = result.counts.clearStructuralOverlayCount
    + result.counts.clearDeletedOverlayCount;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-scrim/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="seasonal-import-preview-title"
    >
      <div className="my-auto w-full max-w-3xl overflow-hidden rounded-lg border border-outline-variant bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-outline-variant px-5 py-4">
          <div className="min-w-0">
            <h2 id="seasonal-import-preview-title" className="text-lg font-semibold text-on-surface">
              Seasonal import preview
            </h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {result.seasonCode} · {result.counts.sourceRowCount} source rows · {result.counts.generatedOccurrenceCount} occurrences
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={state.kind === 'committing'}
            className="grid size-9 shrink-0 place-items-center rounded-md text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
            aria-label="Cancel import preview"
            title="Cancel"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </header>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase text-on-surface-variant">Strategy</div>
            <div className="inline-flex rounded-md border border-outline p-1" role="group" aria-label="Import strategy">
              <button
                type="button"
                onClick={() => onStrategyChange('merge')}
                disabled={strategyLocked || state.kind === 'committing'}
                aria-pressed={result.strategy === 'merge'}
                className={`min-w-24 rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
                  result.strategy === 'merge'
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:bg-surface-container'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                Merge
              </button>
              <button
                type="button"
                onClick={() => onStrategyChange('replace')}
                disabled={strategyLocked || state.kind === 'committing'}
                aria-pressed={result.strategy === 'replace'}
                className={`min-w-24 rounded px-3 py-1.5 text-sm font-semibold transition-colors ${
                  result.strategy === 'replace'
                    ? 'bg-primary text-on-primary'
                    : 'text-on-surface-variant hover:bg-surface-container'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                Replace
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-outline-variant bg-outline-variant sm:grid-cols-2">
            {countRows(result.strategy).map(([label, field]) => (
              <div key={field} className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
                <span className="text-sm text-on-surface-variant">{label}</span>
                <span className="tabular-nums text-sm font-semibold text-on-surface">{result.counts[field]}</span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 bg-surface px-4 py-3">
              <span className="text-sm text-on-surface-variant">Cleared overlays</span>
              <span className="tabular-nums text-sm font-semibold text-on-surface">{clearedOverlays}</span>
            </div>
          </div>

          {diagnosticsByCode.size > 0 && (
            <section aria-labelledby="seasonal-import-diagnostics">
              <h3 id="seasonal-import-diagnostics" className="text-sm font-semibold text-error">
                Blocking diagnostics ({result.diagnosticCount})
              </h3>
              <div className="mt-2 space-y-3">
                {Array.from(diagnosticsByCode.entries()).map(([code, diagnostics]) => (
                  <div key={code} className="rounded-lg border border-error/30 bg-error-container/30 p-3">
                    <div className="text-xs font-semibold uppercase text-error">{code}</div>
                    <div className="mt-2 space-y-2">
                      {diagnostics.map((diagnostic, index) => (
                        <div key={`${code}-${index}`} className="text-sm text-on-surface">
                          <div>{diagnostic.message}</div>
                          {diagnostic.occurrenceKey && (
                            <div className="mt-1 break-all font-mono text-xs text-on-surface-variant">
                              {diagnostic.occurrenceKey}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {result.strategy === 'replace' && (
            <div className="space-y-3">
              <p className="rounded-md border border-error/40 bg-error-container/30 px-3 py-2 text-sm text-on-error-container">
                Replace removes every existing flight, manual addition, modification, and modification history in this season before importing the workbook.
              </p>
              <label className="block">
                <span className="text-sm font-semibold text-on-surface">
                  Confirm season code
                </span>
                <input
                  type="text"
                  value={confirmation}
                  onChange={(event) => onConfirmationChange(event.target.value)}
                  disabled={state.kind === 'committing'}
                  placeholder={result.seasonCode}
                  autoComplete="off"
                  className="mt-2 w-full rounded-md border border-outline bg-surface px-3 py-2 text-sm text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                />
              </label>
            </div>
          )}

          {hasDraftChanges && (
            <p className="text-sm font-medium text-error">
              Save pending draft changes before committing this import.
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-outline-variant px-5 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={state.kind === 'committing'}
            className="rounded-md border border-outline px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCommit}
            disabled={!commitEnabled}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.kind === 'committing' && (
              <span className="material-symbols-outlined animate-spin text-[18px]">progress_activity</span>
            )}
            Commit
          </button>
        </footer>
      </div>
    </div>
  );
}
