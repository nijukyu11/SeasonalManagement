export type ImportDirtyScope = 'active' | 'target';

export interface DirtyImportGuardInput {
  targetSeasonId: string | null;
  targetSeasonCode: string;
  activeSeasonId?: string | null;
  pendingCount: number;
  conflictCount?: number | null;
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
      'Mã lịch mùa trong tên trang tính (sheet) đầu tiên không hợp lệ. Vui lòng đổi tên trang tính đầu tiên thành mã chuẩn như S26, W26, hoặc S27.'
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
  const pendingCount = Math.max(0, input.pendingCount);
  const conflictCount = Math.max(0, input.conflictCount ?? 0);

  if (!input.targetSeasonId || (pendingCount <= 0 && conflictCount <= 0)) {
    return { shouldBlock: false, scope: null, message: '' };
  }

  const scope: ImportDirtyScope = input.targetSeasonId === input.activeSeasonId ? 'active' : 'target';
  const seasonLabel = scope === 'active' ? 'Lịch mùa hiện tại' : `Lịch mùa ${input.targetSeasonCode}`;
  const issues = [
    pendingCount > 0 ? `${pendingCount} thay đổi cục bộ chưa đồng bộ` : null,
    conflictCount > 0 ? `${conflictCount} mục xung đột cần xử lý` : null,
  ].filter(Boolean).join(' và ');

  return {
    shouldBlock: true,
    scope,
    message:
      `${seasonLabel} đang có ${issues}. ` +
      'Việc nhập lại sẽ thay thế dữ liệu gốc của lịch mùa và không thể tự động hợp nhất các chỉnh sửa hoặc mục xung đột này.',
  };
}
