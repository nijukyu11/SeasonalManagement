export type ImportDirtyScope = 'active' | 'target';

export interface DirtyImportGuardInput {
  targetSeasonId: string | null;
  targetSeasonCode: string;
  activeSeasonId?: string | null;
  pendingCount: number;
}

export interface DirtyImportGuard {
  shouldBlock: boolean;
  scope: ImportDirtyScope | null;
  message: string;
}

const SEASON_CODE_PATTERN = /^[SW]\d{2}$/;
const SEASON_FILE_EXTENSION_PATTERN = /\.(xlsx?|xls)$/i;

export function normalizeSeasonSheetName(sheetName: string | undefined): string {
  const seasonCode = (sheetName ?? '').trim();
  if (!SEASON_CODE_PATTERN.test(seasonCode)) {
    throw new Error(
      'Invalid season code in first worksheet name. Rename the first worksheet to a code such as S26, W26, or S27.'
    );
  }
  return seasonCode;
}

function normalizeSeasonNameText(value: string): string {
  return value
    .replace(SEASON_FILE_EXTENSION_PATTERN, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripSeasonCodeFromName(name: string | null | undefined, seasonCode: string | null | undefined): string {
  const normalizedName = normalizeSeasonNameText(String(name ?? ''));
  const normalizedCode = String(seasonCode ?? '').trim().toUpperCase();
  if (!normalizedName || !SEASON_CODE_PATTERN.test(normalizedCode)) return normalizedName;
  return normalizeSeasonNameText(
    normalizedName.replace(new RegExp(`(?:\\s+|[_-]*)${normalizedCode}$`, 'i'), '')
  );
}

export function buildSeasonNameFromFileName(fileName: string, seasonCode: string): string {
  void fileName;
  return normalizeSeasonSheetName(seasonCode);
}

export function buildSeasonDisplayLabel(season: { seasonCode: string; name?: string | null }): string {
  void season.name;
  return String(season.seasonCode ?? '').trim();
}

export function getDirtyImportGuard(input: DirtyImportGuardInput): DirtyImportGuard {
  if (!input.targetSeasonId || input.pendingCount <= 0) {
    return { shouldBlock: false, scope: null, message: '' };
  }

  const scope: ImportDirtyScope = input.targetSeasonId === input.activeSeasonId ? 'active' : 'target';
  const seasonLabel = scope === 'active' ? 'current season' : `season ${input.targetSeasonCode}`;
  return {
    shouldBlock: true,
    scope,
    message:
      `${seasonLabel} has ${input.pendingCount} unsynced local change${input.pendingCount === 1 ? '' : 's'}. ` +
      'Re-import replaces the season baseline and cannot safely merge those edits.',
  };
}
