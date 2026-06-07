export interface LoadProgress {
  label: string;
  percent: number;
  detail?: string;
  indeterminate?: boolean;
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function buildLoadProgress(
  label: string,
  percent: number,
  detail?: string,
  options: { indeterminate?: boolean } = {}
): LoadProgress {
  return {
    label,
    percent: clampPercent(percent),
    ...(detail ? { detail } : {}),
    ...(options.indeterminate ? { indeterminate: true } : {}),
  };
}

export function buildLoadBatchProgress(
  label: string,
  written: number,
  total: number,
  startPercent: number,
  endPercent: number
): LoadProgress {
  const safeTotal = Math.max(0, total);
  const safeWritten = Math.max(0, Math.min(written, safeTotal));
  const ratio = safeTotal === 0 ? 1 : safeWritten / safeTotal;
  const percent = startPercent + ((endPercent - startPercent) * ratio);
  return buildLoadProgress(label, percent, `${safeWritten} / ${safeTotal}`);
}

export type ImportProgress = LoadProgress;

export function buildImportProgress(label: string, percent: number, detail?: string): ImportProgress {
  return buildLoadProgress(label, percent, detail);
}

export function buildImportBatchProgress(
  label: string,
  written: number,
  total: number,
  startPercent: number,
  endPercent: number
): ImportProgress {
  return buildLoadBatchProgress(label, written, total, startPercent, endPercent);
}
