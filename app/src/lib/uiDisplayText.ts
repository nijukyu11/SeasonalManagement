import {
  FIELD_LABELS,
  formatSingleValue,
  formatDateDisplay,
} from './seasonalDiffFormatters';

/**
 * Extended UI field labels dictionary covering entities, diagnostic codes,
 * database fields, audit log keys, and action terms.
 */
const EXTENDED_FIELD_LABELS: Record<string, string> = {
  // Entities & types
  flight: 'Chuyến bay',
  flights: 'Chuyến bay',
  season: 'Lịch mùa',
  seasons: 'Lịch mùa',
  draft: 'Bản nháp',
  drafts: 'Bản nháp',
  version: 'Phiên bản',
  versions: 'Phiên bản',
  snapshot: 'Bản lưu',
  allocation: 'Phân bổ',
  allocations: 'Phân bổ',
  leg: 'Chặng bay',
  legs: 'Chặng bay',
  turnaround: 'Cặp chuyến',
  turnarounds: 'Cặp chuyến',
  window: 'Cửa sổ quầy',
  counter: 'Quầy',
  counters: 'Quầy',
  gate: 'Cửa',
  gates: 'Cửa',
  stand: 'Bãi đỗ',
  stands: 'Bãi đỗ',
  carousel: 'Băng chuyền',
  carousels: 'Băng chuyền',
  pairing: 'Cặp chuyến',
  pairings: 'Cặp chuyến',
  aircraft: 'Tàu bay',
  airline: 'Hãng hàng không',
  operator: 'Điều hành viên',
  user: 'Người dùng',
  role: 'Vai trò',
  permission: 'Quyền hạn',

  // Audit log fields
  module: 'Phân hệ',
  operation: 'Thao tác',
  target_label: 'Đối tượng',
  targetLabel: 'Đối tượng',
  session_id: 'Mã phiên',
  sessionId: 'Mã phiên',
  client_version: 'Phiên bản máy khách',
  clientVersion: 'Phiên bản máy khách',
  client_platform: 'Nền tảng',
  clientPlatform: 'Nền tảng',
  operator_id: 'Mã điều hành viên',
  operatorId: 'Mã điều hành viên',
  operator_email: 'Email điều hành viên',
  operatorEmail: 'Email điều hành viên',
  field: 'Trường dữ liệu',
  before: 'Trước thay đổi',
  after: 'Sau thay đổi',
  diff: 'Khác biệt',

  // Identifiers & technical keys
  flight_key: 'Khóa chuyến bay',
  flightKey: 'Khóa chuyến bay',
  target_id: 'Mã đối tượng',
  targetId: 'Mã đối tượng',
  target_type: 'Loại đối tượng',
  targetType: 'Loại đối tượng',
  source_type: 'Nguồn dữ liệu',
  sourceType: 'Nguồn dữ liệu',
  publish_kind: 'Loại công bố',
  publishKind: 'Loại công bố',
  proposed_tag: 'Phiên bản đề xuất',
  proposedTag: 'Phiên bản đề xuất',
  version_tag: 'Phiên bản',
  versionTag: 'Phiên bản',
  season_id: 'Lịch mùa',
  seasonId: 'Lịch mùa',
  draft_id: 'Mã bản nháp',
  draftId: 'Mã bản nháp',
  version_id: 'Mã phiên bản',
  versionId: 'Mã phiên bản',

  // Status & counters
  status: 'Trạng thái',
  state: 'Trạng thái',
  code: 'Mã',
  reason: 'Lý do',
  message: 'Thông báo',
  details: 'Chi tiết',
  summary: 'Tóm tắt',
  created_at: 'Thời điểm tạo',
  createdAt: 'Thời điểm tạo',
  updated_at: 'Thời điểm cập nhật',
  updatedAt: 'Thời điểm cập nhật',
  published_at: 'Thời điểm công bố',
  publishedAt: 'Thời điểm công bố',
  created_by: 'Người tạo',
  createdBy: 'Người tạo',
  updated_by: 'Người cập nhật',
  updatedBy: 'Người cập nhật',
  applied_count: 'Số lượng áp dụng',
  appliedCount: 'Số lượng áp dụng',
  failed_count: 'Số lượng lỗi',
  failedCount: 'Số lượng lỗi',
  skipped_count: 'Số lượng bỏ qua',
  skippedCount: 'Số lượng bỏ qua',
  total_count: 'Tổng số',
  totalCount: 'Tổng số',
  operational_counts: 'Số lượng vận hành',
  operationalCounts: 'Số lượng vận hành',
  operational_impact_counts: 'Số lượng tác động vận hành',
  operationalImpactCounts: 'Số lượng tác động vận hành',
  skipped_days: 'Ngày bỏ qua',
  skippedDays: 'Ngày bỏ qua',
  overwrites: 'Ghi đè',
  retire: 'Thu hồi',
  write: 'Ghi mới',

  // Diagnostic codes & validations
  UNKNOWN_ERROR: 'Lỗi không xác định',
  NETWORK_ERROR: 'Lỗi kết nối mạng',
  TIMEOUT: 'Hết thời gian chờ',
  VALIDATION_FAILED: 'Dữ liệu không hợp lệ',
  PERMISSION_DENIED: 'Không có quyền truy cập',
  UNAUTHORIZED: 'Chưa xác thực',
  CONFLICT: 'Xung đột dữ liệu',
  STALE_DATA: 'Dữ liệu đã cũ',
  NOT_FOUND: 'Không tìm thấy',
  MISSING_AIRLINE: 'Thiếu thông tin hãng',
  MISSING_FLIGHT_NUMBER: 'Thiếu số hiệu chuyến bay',
  INVALID_SCHEDULE_TIME: 'Giờ bay không hợp lệ',
  OVERLAPPING_FLIGHT: 'Trùng lặp chuyến bay',
  DUPLICATE_FLIGHT: 'Chuyến bay bị trùng',
  OVERLAPPING_STAND: 'Trùng vị trí đỗ',
  OVERLAPPING_GATE: 'Trùng cửa khởi hành',
  OVERLAPPING_COUNTER: 'Trùng quầy làm thủ tục',
  PARSER_ERROR: 'Lỗi định dạng tệp',
  IMPORT_FAILED: 'Nhập dữ liệu không thành công',
  DATABASE_ERROR: 'Lỗi cơ sở dữ liệu',
  UNSAVED_CHANGES: 'Thay đổi chưa được lưu',
  EMPTY_SCHEDULE: 'Lịch bay trống',

  // Export / Import / Pairing validation issue codes
  'manual-occurrence-collision': 'Xung đột với chuyến thêm thủ công',
  'daily-occurrence-collision': 'Xung đột với lịch ngày',
  'duplicate-occurrence-key': 'Lượt bay bị trùng',
  'duplicate-occurrence-resolved': 'Lượt bay trùng đã được xử lý',
  'zero-generated-records': 'Không tạo được lượt bay',
  'missing-linked-row': 'Thiếu dòng liên kết',
  'incompatible-pair-type': 'Chặng liên kết không phù hợp',
  'incompatible-link-type': 'Không khớp kiểu liên kết',
  'incompatible-pair-date': 'Không khớp ngày của cặp chuyến',
  'season-mismatch': 'Không khớp lịch mùa',
  season_mismatch: 'Không khớp lịch mùa',
  seasonMismatch: 'Không khớp lịch mùa',
  'version-mismatch': 'Không khớp phiên bản',
  version_mismatch: 'Không khớp phiên bản',
  versionMismatch: 'Không khớp phiên bản',
  'zero-selection': 'Chưa chọn dữ liệu',
  zero_selection: 'Chưa chọn dữ liệu',
  zeroSelection: 'Chưa chọn dữ liệu',
  'unknown-record-id': 'Mã chuyến bay không tồn tại',
  unknown_record_id: 'Mã chuyến bay không tồn tại',
  unknownRecordId: 'Mã chuyến bay không tồn tại',
  'date-metadata-mismatch': 'Không khớp ngày bay',
  date_metadata_mismatch: 'Không khớp ngày bay',
  dateMetadataMismatch: 'Không khớp ngày bay',
  'invalid-linked-pair': 'Cặp chuyến liên kết không hợp lệ',
  invalid_linked_pair: 'Cặp chuyến liên kết không hợp lệ',
  invalidLinkedPair: 'Cặp chuyến liên kết không hợp lệ',
  'missing-occurrence': 'Thiếu lượt bay',
  missing_occurrence: 'Thiếu lượt bay',
  missingOccurrence: 'Thiếu lượt bay',
  'extra-occurrence': 'Dư lượt bay',
  extra_occurrence: 'Dư lượt bay',
  extraOccurrence: 'Dư lượt bay',
  'operation-replaced': 'Thao tác đã bị thay thế',
  operation_replaced: 'Thao tác đã bị thay thế',
  operationReplaced: 'Thao tác đã bị thay thế',
  'season-changed': 'Lịch mùa đã thay đổi',
  season_changed: 'Lịch mùa đã thay đổi',
  seasonChanged: 'Lịch mùa đã thay đổi',
  'draft-changed': 'Bản nháp đã thay đổi',
  draft_changed: 'Bản nháp đã thay đổi',
  draftChanged: 'Bản nháp đã thay đổi',
  'missing-counterpart': 'Thiếu chặng đối ứng',
  missing_counterpart: 'Thiếu chặng đối ứng',
  missingCounterpart: 'Thiếu chặng đối ứng',
  'non-reciprocal-link': 'Liên kết không đối xứng',
  non_reciprocal_link: 'Liên kết không đối xứng',
  nonReciprocalLink: 'Liên kết không đối xứng',
  'ambiguous-pair': 'Cặp chuyến không rõ ràng',
  ambiguous_pair: 'Cặp chuyến không rõ ràng',
  ambiguousPair: 'Cặp chuyến không rõ ràng',
  'invalid-effective-date': 'Ngày bắt đầu không hợp lệ',
  invalid_effective_date: 'Ngày bắt đầu không hợp lệ',
  'invalid-discontinue-date': 'Ngày kết thúc không hợp lệ',
  invalid_discontinue_date: 'Ngày kết thúc không hợp lệ',
  'reversed-date-range': 'Khoảng ngày bị ngược',
  reversed_date_range: 'Khoảng ngày bị ngược',
  'invalid-time': 'Giờ không hợp lệ',
  invalid_time: 'Giờ không hợp lệ',
  'invalid-day-value': 'Giá trị ngày không hợp lệ',
  invalid_day_value: 'Giá trị ngày không hợp lệ',
  'no-operating-days': 'Không có ngày hoạt động',
  no_operating_days: 'Không có ngày hoạt động',
  'missing-airline': 'Thiếu hãng hàng không',
  missing_airline: 'Thiếu hãng hàng không',
  'missing-aircraft': 'Thiếu loại tàu bay',
  missing_aircraft: 'Thiếu loại tàu bay',
  'incomplete-flight-side': 'Chưa hoàn chỉnh chặng bay',
  incomplete_flight_side: 'Chưa hoàn chỉnh chặng bay',
  'no-flight-side': 'Thiếu chặng bay',
  no_flight_side: 'Thiếu chặng bay',
  'stale-selection': 'Lựa chọn đã cũ',
  stale_selection: 'Lựa chọn đã cũ',
  'no-selection': 'Chưa chọn dữ liệu',
  no_selection: 'Chưa chọn dữ liệu',
};

/**
 * Value translation dictionary for common status, enum, audit module, and category strings.
 */
const ENUM_VALUE_LABELS: Record<string, string> = {
  // Source types
  excel: 'Tệp Excel',
  manual: 'Nhập thủ công',
  sync: 'Đồng bộ',
  api: 'Cổng kết nối',
  database: 'Cơ sở dữ liệu',
  file: 'Tệp tin',
  system: 'Hệ thống',
  published_seasonal: 'Lịch mùa đã công bố',
  daily_import: 'Nhập lịch ngày',
  operational_manual: 'Điều chỉnh vận hành',

  // Publish kinds
  full: 'Toàn phần',
  incremental: 'Gia tăng',
  standard: 'Tiêu chuẩn',
  overwrite: 'Ghi đè',
  merge: 'Hợp nhất',
  official: 'Chính thức',
  release: 'Công bố phiên bản mới',
  reapply: 'Áp dụng lại phiên bản',
  noop: 'Không thay đổi',

  // Flight side / type
  a: 'Đến',
  arr: 'Đến',
  arrival: 'Đến',
  d: 'Đi',
  dep: 'Đi',
  departure: 'Đi',

  // Categories
  pax: 'Hành khách',
  cargo: 'Hàng hóa',
  ferry: 'Chuyển sân (Ferry)',
  tech: 'Kỹ thuật',
  vip: 'Chuyên cơ/VIP',

  // Statuses & lifecycle states
  draft: 'Bản nháp',
  published: 'Đã công bố',
  archived: 'Lưu trữ',
  active: 'Đang hoạt động',
  inactive: 'Ngừng hoạt động',
  success: 'Thành công',
  failed: 'Thất bại',
  error: 'Lỗi',
  warning: 'Cảnh báo',
  info: 'Thông tin',
  pending: 'Chờ xử lý',
  committed: 'Đã hoàn tất',
  preview: 'Xem trước',
  committing: 'Đang ghi nhận',
  valid: 'Hợp lệ',
  invalid: 'Không hợp lệ',
  matched: 'Khớp',
  unmatched: 'Chưa khớp',
  stale: 'Đã cũ',
  expired: 'Đã hết hạn',
  cancelled: 'Đã hủy',
  canceled: 'Đã hủy',
  synced: 'Đã đồng bộ',
  terminal: 'Đã kết thúc',
  aborted: 'Đã hủy',
  staging: 'Đang chuẩn bị',
  refreshing: 'Đang làm mới',
  validated: 'Đã xác thực',
  conflict: 'Xung đột',

  // Audit modules & categories
  seasonal: 'Lịch mùa',
  detailed: 'Lịch chi tiết',
  daily: 'Lịch ngày',
  checkin: 'Phân bổ quầy',
  gate: 'Phân bổ cửa',
  settings: 'Cài đặt',
  import: 'Nhập dữ liệu',
  export: 'Xuất dữ liệu',
  'user-action': 'Thao tác người dùng',
  user_action: 'Thao tác người dùng',

  // Daily workbook profiles
  'legacy-operationalturns': 'Mẫu lịch vận hành cũ',
  'compact-lb': 'Mẫu lịch bay rút gọn',
  'summary-19': 'Mẫu tổng hợp khai thác 19 cột',
  'position-compatible-unknown': 'Mẫu cột tương thích chưa xác định',

  // Link types
  sameday: 'Cùng ngày',
  same_day: 'Cùng ngày',
  overnight: 'Qua đêm',
  over_night: 'Qua đêm',
  nextday: 'Hôm sau',
  next_day: 'Hôm sau',

  // Int/Dom
  i: 'Quốc tế',
  int: 'Quốc tế',
  international: 'Quốc tế',
  dom: 'Quốc nội',
  domestic: 'Quốc nội',
};

const VIETNAMESE_ACCENT_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const SENSITIVE_TECHNICAL_PATTERNS = [
  /syntax error/i,
  /relation ".*" does not exist/i,
  /column ".*" does not exist/i,
  /null value in column/i,
  /violates not-null constraint/i,
  /violates foreign key/i,
  /violates check constraint/i,
  /duplicate key value violates unique constraint/i,
  /PGRST\d+/i,
  /PostgREST/i,
  /supabase/i,
  /select\s+.*\s+from/i,
  /insert\s+into/i,
  /update\s+.*\s+set/i,
  /delete\s+from/i,
  /TypeError:/i,
  /ReferenceError:/i,
  /at\s+.*\s+\(.*\)/i,
];

/**
 * Returns a human-friendly Vietnamese label for a given data/entity/error field name.
 */
export function formatUiFieldLabel(field: string): string {
  if (!field || typeof field !== 'string') {
    return 'Thông tin';
  }

  const trimmed = field.trim();
  if (!trimmed) {
    return 'Thông tin';
  }

  // 1. Direct match in FIELD_LABELS or EXTENDED_FIELD_LABELS
  if (FIELD_LABELS[trimmed]) {
    return FIELD_LABELS[trimmed];
  }
  if (EXTENDED_FIELD_LABELS[trimmed]) {
    return EXTENDED_FIELD_LABELS[trimmed];
  }

  // 2. Case-insensitive and normalized lookup (handles kebab-case, snake_case, camelCase)
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(FIELD_LABELS)) {
    if (k.toLowerCase() === lower) return v;
  }
  for (const [k, v] of Object.entries(EXTENDED_FIELD_LABELS)) {
    if (k.toLowerCase() === lower) return v;
  }

  const normalized = lower.replace(/[-_]/g, '');
  for (const [k, v] of Object.entries(EXTENDED_FIELD_LABELS)) {
    if (k.toLowerCase().replace(/[-_]/g, '') === normalized) return v;
  }

  // 3. Fallback for unmapped technical fields: do not leak raw keys with underscores/camelCase
  if (/_id$|Id$/.test(trimmed)) {
    const base = trimmed.replace(/_id$|Id$/, '');
    const baseLabel = formatUiFieldLabel(base);
    return baseLabel !== 'Thông tin khác' ? `Mã ${baseLabel.toLowerCase()}` : 'Mã định danh';
  }

  // If already Vietnamese
  if (VIETNAMESE_ACCENT_REGEX.test(trimmed)) {
    return trimmed;
  }

  // Diagnostic uppercase code fallback: e.g. ERR_SOMETHING -> clean readable or 'Cảnh báo'
  if (/^[A-Z0-9_]+$/.test(trimmed)) {
    return EXTENDED_FIELD_LABELS[trimmed] || 'Cảnh báo';
  }

  return 'Thông tin khác';
}

/**
 * Returns a human-friendly Vietnamese string representation of any primitive or domain value.
 */
export function formatUiValue(value: unknown, field?: string): string {
  if (value === null || value === undefined) {
    return 'Chưa có dữ liệu';
  }

  if (typeof value === 'boolean') {
    return value ? 'Có' : 'Không';
  }

  if (value === 0 || value === '0') {
    return '0';
  }

  const fieldKey = field?.trim();

  // Known string enumerations
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return 'Chưa có dữ liệu';

    const lower = trimmed.toLowerCase();
    const normalizedField = fieldKey?.replace(/_/g, '').toLowerCase();
    if (normalizedField === 'code') return formatUiFieldLabel(trimmed);
    const isEnumField = !!normalizedField && [
      'type', 'side', 'intdomind', 'linktype', 'status', 'state', 'action',
      'sourcetype', 'sourcekind', 'publishkind', 'category', 'flighttype',
      'targettype', 'module', 'workbookprofile',
    ].includes(normalizedField);

    if (isEnumField) {
      const diffFormatted = formatSingleValue(trimmed, fieldKey);
      if (diffFormatted !== trimmed && diffFormatted !== 'Chưa khai báo') {
        return diffFormatted;
      }
      if (ENUM_VALUE_LABELS[lower]) return ENUM_VALUE_LABELS[lower];
    }

    // Standard ISO date detection
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return formatDateDisplay(trimmed);
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
      try {
        const d = new Date(trimmed);
        if (!isNaN(d.getTime())) {
          const dd = String(d.getDate()).padStart(2, '0');
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const yyyy = d.getFullYear();
          const hh = String(d.getHours()).padStart(2, '0');
          const min = String(d.getMinutes()).padStart(2, '0');
          return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
        }
      } catch {
        // Ignore date parse fallback
      }
    }

    return trimmed;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return 'Chưa có dữ liệu';
    return value.map((item) => formatUiValue(item, field)).join(', ');
  }

  if (typeof value === 'object') {
    return formatUiRecord(value);
  }

  return String(value);
}

/**
 * Formats a record/object into a readable translated summary without mutating the source.
 */
export function formatUiRecord(value: unknown): string {
  if (value === null || value === undefined) {
    return 'Chưa có dữ liệu';
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return formatUiValue(value);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return 'Chưa có dữ liệu';
  }

  // Filter out internal hidden technical fields
  const filtered = entries.filter(([k]) => {
    const lower = k.toLowerCase();
    return !['__typename', 'hash', 'created_by', 'updated_by', 'group_key'].includes(lower);
  });

  if (filtered.length === 0) {
    return 'Chưa có dữ liệu';
  }

  return filtered
    .map(([k, v]) => {
      const label = formatUiFieldLabel(k);
      const valStr = formatUiValue(v, k);
      return `${label}: ${valStr}`;
    })
    .join(' · ');
}

/**
 * Maps recognizable business validation and domain error patterns preserving
 * interpolated variables (Row numbers, flight dates, flight numbers, airline codes).
 */
function translateBusinessDiagnostic(rawMessage: string): string | null {
  const resolvedDuplicate = /^Rows (.+?) generate duplicate occurrence (.+?); kept (row .+|no row)\.$/i.exec(rawMessage);
  if (resolvedDuplicate) {
    const kept = /^row (.+)$/i.exec(resolvedDuplicate[3]);
    const occurrence = resolvedDuplicate[2].replace(/ on (\d{4}-\d{2}-\d{2})$/i, ' ngày $1');
    return `Các dòng ${resolvedDuplicate[1]} tạo lượt bay trùng ${occurrence}; ${kept ? `giữ lại dòng ${kept[1]}` : 'không giữ lại dòng nào'}.`;
  }
  const groupedDuplicate = /^Rows (.+?) generate duplicate (\d+) occurrence\(s\) for (.+)\.$/i.exec(rawMessage);
  if (groupedDuplicate) {
    return `Các dòng ${groupedDuplicate[1]} tạo ${groupedDuplicate[2]} lượt bay trùng cho chuyến ${groupedDuplicate[3]}.`;
  }
  const duplicate = /^Rows (.+?) generate duplicate occurrence (.+)\.$/i.exec(rawMessage);
  if (duplicate) {
    const occurrence = duplicate[2].replace(/ on (\d{4}-\d{2}-\d{2})$/i, ' ngày $1');
    return `Các dòng ${duplicate[1]} tạo lượt bay trùng ${occurrence}.`;
  }
  const groupedManualCollision = /^Incoming (\d+) occurrence\(s\) for (.+) collide with manual added flights\.$/i.exec(rawMessage);
  if (groupedManualCollision) {
    return `${groupedManualCollision[1]} lượt bay của chuyến ${groupedManualCollision[2]} trong tệp trùng với chuyến thêm thủ công.`;
  }
  if (/^Incoming occurrence collides with a manual added flight\.$/i.test(rawMessage)) {
    return 'Lượt bay trong tệp trùng với chuyến thêm thủ công.';
  }
  const dailyCollision = /^Incoming occurrence collides with an active Daily leg \((.+)\): each flight number may appear only once within a calendar day\.$/i.exec(rawMessage);
  if (dailyCollision) {
    return `Lượt bay trong tệp trùng với chặng đang có hiệu lực trong lịch ngày (${dailyCollision[1]}): mỗi số hiệu chuyến bay chỉ được xuất hiện một lần trong một ngày.`;
  }
  const emptyRows = /^None of the (\d+) source rows generate flight occurrences\.$/i.exec(rawMessage);
  if (emptyRows) {
    return `Không có dòng nào trong ${emptyRows[1]} dòng nguồn tạo được lượt bay.`;
  }
  if (/^The canonical source rows do not generate any flight occurrences\.$/i.test(rawMessage)) {
    return 'Các dòng dữ liệu gốc không tạo được lượt bay nào.';
  }
  // 1. Source row validation issues: Row (\d+): ...
  const rowMatch = /^Row\s+(\d+):\s*(.+)$/i.exec(rawMessage);
  if (rowMatch) {
    const rowNum = rowMatch[1];
    const detail = rowMatch[2].trim();
    if (/^no selected operating day occurs within Effective through Discontinue\.$/i.test(detail)) {
      return `Dòng ${rowNum}: Không có ngày bay đã chọn nào trong khoảng ngày bắt đầu đến ngày kết thúc.`;
    }
    const missingLinkedRow = /^linked source row (\d+) does not exist\.$/i.exec(detail);
    if (missingLinkedRow) {
      return `Dòng ${rowNum}: Dòng nguồn liên kết ${missingLinkedRow[1]} không tồn tại.`;
    }
    const ambiguousLinkedRow = /^linked source row (\d+) is not a unique reciprocal pair\.$/i.exec(detail);
    if (ambiguousLinkedRow) {
      return `Dòng ${rowNum}: Dòng nguồn liên kết ${ambiguousLinkedRow[1]} không tạo thành cặp liên kết đối ứng duy nhất.`;
    }
    if (/^linked rows must be opposite ARR-only and DEP-only sides for one airline\.$/i.test(detail)) {
      return `Dòng ${rowNum}: Hai dòng liên kết phải gồm một chặng đến và một chặng đi của cùng hãng.`;
    }
    if (/^linked rows must use the same linkType\.$/i.test(detail)) {
      return `Dòng ${rowNum}: Hai dòng liên kết phải dùng cùng kiểu liên kết.`;
    }
    const pairDate = /^linked row (\d+) has no (sameday|same-day|overnight|nextday|next-day) counterpart for pair anchor (\S+)\.$/i.exec(detail);
    if (pairDate) {
      const linkLabel = /^(sameday|same-day)$/i.test(pairDate[2]) ? 'cùng ngày' : /^(overnight)$/i.test(pairDate[2]) ? 'qua đêm' : 'ngày hôm sau';
      return `Dòng ${rowNum}: Dòng liên kết ${pairDate[1]} không có chặng đối ứng ${linkLabel} cho ngày gốc của cặp chuyến ${pairDate[3]}.`;
    }

    if (/Effective is not a valid seasonal date/i.test(detail)) {
      return `Dòng ${rowNum}: Ngày bắt đầu (Effective) không phải ngày lịch mùa hợp lệ.`;
    }
    if (/Discontinue is not a valid seasonal date/i.test(detail)) {
      return `Dòng ${rowNum}: Ngày kết thúc (Discontinue) không phải ngày lịch mùa hợp lệ.`;
    }
    if (/Effective must be on or before Discontinue/i.test(detail)) {
      return `Dòng ${rowNum}: Ngày bắt đầu phải trước hoặc cùng ngày kết thúc.`;
    }
    if (/STA must be a valid time/i.test(detail)) {
      return `Dòng ${rowNum}: Giờ đến (STA) phải trong khoảng từ 00:00 đến 23:59.`;
    }
    if (/STD must be a valid time/i.test(detail)) {
      return `Dòng ${rowNum}: Giờ đi (STD) phải trong khoảng từ 00:00 đến 23:59.`;
    }
    const dayColMatch = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+must be TRUE,\s*FALSE,\s*1,\s*0,\s*or blank/i.exec(detail);
    if (dayColMatch) {
      return `Dòng ${rowNum}: Cột ${dayColMatch[1]} phải là TRUE, FALSE, 1, 0 hoặc để trống.`;
    }
    if (/At least one operating day from Mon through Sun is required/i.test(detail)) {
      return `Dòng ${rowNum}: Phải có ít nhất một ngày bay hoạt động trong tuần.`;
    }
    if (/Airline is required/i.test(detail)) {
      return `Dòng ${rowNum}: Bắt buộc phải có thông tin hãng (Airline).`;
    }
    if (/Aircraft is required/i.test(detail)) {
      return `Dòng ${rowNum}: Bắt buộc phải có loại tàu bay (Aircraft).`;
    }
    if (/ARR must include STA, ARRFlight, and ARRRoute together/i.test(detail)) {
      return `Dòng ${rowNum}: Chặng đến (ARR) phải có đầy đủ đồng thời STA, ARRFlight và ARRRoute.`;
    }
    if (/DEP must include STD, DEPFlight, and DEPRoute together/i.test(detail)) {
      return `Dòng ${rowNum}: Chặng đi (DEP) phải có đầy đủ đồng thời STD, DEPFlight và DEPRoute.`;
    }
    if (/At least one complete ARR or DEP flight side is required/i.test(detail)) {
      return `Dòng ${rowNum}: Cần ít nhất một chặng đến (ARR) hoặc chặng đi (DEP) hoàn chỉnh.`;
    }
    if (VIETNAMESE_ACCENT_REGEX.test(detail)) {
      return `Dòng ${rowNum}: ${detail}`;
    }
    return `Dòng ${rowNum}: Dữ liệu không hợp lệ (${detail})`;
  }

  // 2. Occurrence signature validations
  const missingOccMatch = /^Missing\s+(\d+)\s+occurrence(?:\(s\)|s)?:\s*(.+)$/i.exec(rawMessage);
  if (missingOccMatch) {
    return `Thiếu ${missingOccMatch[1]} lượt bay: ${missingOccMatch[2]}`;
  }
  const extraOccMatch = /^Extra\s+(\d+)\s+occurrence(?:\(s\)|s)?:\s*(.+)$/i.exec(rawMessage);
  if (extraOccMatch) {
    return `Dư ${extraOccMatch[1]} lượt bay: ${extraOccMatch[2]}`;
  }

  // 3. Pairing and Turnaround issues
  const pairNoCounterpart = /^(.+?)\s+on\s+(\S+)\s+has no unique active counterpart\.?$/i.exec(rawMessage);
  if (pairNoCounterpart) {
    return `Chuyến ${pairNoCounterpart[1]} ngày ${pairNoCounterpart[2]} không có chặng đối ứng duy nhất đang hoạt động.`;
  }
  const pairSelf = /^(.+?)\s+on\s+(\S+)\s+links to itself\.?$/i.exec(rawMessage);
  if (pairSelf) {
    return `Chuyến ${pairSelf[1]} ngày ${pairSelf[2]} tự liên kết với chính nó.`;
  }
  const pairMissing = /^(.+?)\s+on\s+(\S+)\s+links to a missing counterpart\.?$/i.exec(rawMessage);
  if (pairMissing) {
    return `Chuyến ${pairMissing[1]} ngày ${pairMissing[2]} liên kết với chặng đối ứng không tồn tại.`;
  }
  const pairInvalid = /^(.+?)\s+on\s+(\S+)\s+links to an invalid or duplicate counterpart\.?$/i.exec(rawMessage);
  if (pairInvalid) {
    return `Chuyến ${pairInvalid[1]} ngày ${pairInvalid[2]} liên kết với chặng đối ứng không hợp lệ hoặc bị trùng.`;
  }
  const pairConsumed = /^(.+?)\s+on\s+(\S+)\s+links to a counterpart that is already consumed or invalid\.?$/i.exec(rawMessage);
  if (pairConsumed) {
    return `Chuyến ${pairConsumed[1]} ngày ${pairConsumed[2]} liên kết với chặng đối ứng đã được ghép cặp hoặc không hợp lệ.`;
  }
  const pairNonReciprocal = /^(.+?)\s+on\s+(\S+)\s+has a non-reciprocal linked record ID\.?$/i.exec(rawMessage);
  if (pairNonReciprocal) {
    return `Chuyến ${pairNonReciprocal[1]} ngày ${pairNonReciprocal[2]} có mã liên kết chặng đối ứng không đối xứng hai chiều.`;
  }
  const pairIncompatible = /^(.+?)\s+on\s+(\S+)\s+has incompatible reciprocal pair metadata\.?$/i.exec(rawMessage);
  if (pairIncompatible) {
    return `Chuyến ${pairIncompatible[1]} ngày ${pairIncompatible[2]} có thông tin cặp chuyến không tương thích.`;
  }
  const pairTurnaroundGroup = /^(.+?)\s+on\s+(\S+)\s+belongs to ambiguous turnaround\s+(\S+)\s+with\s+(\d+)\s+legs\.?$/i.exec(rawMessage);
  if (pairTurnaroundGroup) {
    return `Chuyến ${pairTurnaroundGroup[1]} ngày ${pairTurnaroundGroup[2]} thuộc cặp chuyến không rõ ràng ${pairTurnaroundGroup[3]} có ${pairTurnaroundGroup[4]} chặng.`;
  }
  const pairTurnaroundAD = /^(.+?)\s+on\s+(\S+)\s+belongs to turnaround\s+(\S+)\s+without one compatible A\/D pair\.?$/i.exec(rawMessage);
  if (pairTurnaroundAD) {
    return `Chuyến ${pairTurnaroundAD[1]} ngày ${pairTurnaroundAD[2]} thuộc cặp chuyến ${pairTurnaroundAD[3]} nhưng không có cặp đến/đi (A/D) tương thích.`;
  }

  // 4. Duplicate flight & cell validation
  const dupFlightMatch = /^Duplicate flight number\s+(\S+)\s+on\s+(\S+)/i.exec(rawMessage);
  if (dupFlightMatch) {
    return `Trùng số hiệu chuyến bay ${dupFlightMatch[1]} vào ngày ${dupFlightMatch[2]}`;
  }
  if (/Time must use HH:mm format/i.test(rawMessage)) {
    return 'Giờ phải theo định dạng HH:mm';
  }
  if (/Value must be numeric/i.test(rawMessage)) {
    return 'Giá trị phải là số';
  }
  if (/Value must be a positive integer/i.test(rawMessage)) {
    return 'Giá trị phải là số nguyên dương';
  }

  // 5. Guards and actions
  const saveDraftBeforeMatch = /Save or discard the Seasonal draft before\s+(\w+)\.?/i.exec(rawMessage);
  if (saveDraftBeforeMatch) {
    const act = saveDraftBeforeMatch[1].toLowerCase() === 'import' ? 'nhập dữ liệu' : 'xuất tệp';
    return `Vui lòng lưu hoặc hủy bản nháp Lịch mùa trước khi ${act}.`;
  }
  if (/Another Seasonal operation is still running/i.test(rawMessage)) {
    return 'Một thao tác Lịch mùa khác đang được thực hiện.';
  }
  if (/Selected flights are no longer available/i.test(rawMessage)) {
    return 'Các chuyến bay đã chọn không còn khả dụng. Vui lòng xem lại danh sách trước khi xuất tệp.';
  }
  if (/Select at least one flight before export/i.test(rawMessage)) {
    return 'Vui lòng chọn ít nhất một chuyến bay trước khi xuất tệp.';
  }
  if (/Choose both From and To before exporting/i.test(rawMessage)) {
    return 'Vui lòng chọn cả thời điểm Từ và Đến trước khi xuất tệp.';
  }
  if (/Export To must be later than From/i.test(rawMessage)) {
    return 'Thời điểm Đến phải sau thời điểm Từ khi xuất tệp.';
  }
  if (/No check-in counter groups are available to export/i.test(rawMessage)) {
    return 'Không có nhóm quầy làm thủ tục nào khả dụng để xuất tệp.';
  }
  if (/No gate groups are available to export/i.test(rawMessage)) {
    return 'Không có nhóm cửa nào khả dụng để xuất tệp.';
  }

  // 6. Dirty import guard
  const dirtyGuardMatch = /(current season|season \S+) has (\d+) unsynced local change(?:s)?(?: and (\d+) conflict review item(?:s)?)?\.?/i.exec(rawMessage);
  if (dirtyGuardMatch) {
    const season = dirtyGuardMatch[1].toLowerCase() === 'current season' ? 'Lịch mùa hiện tại' : dirtyGuardMatch[1];
    const pending = dirtyGuardMatch[2];
    const conflicts = dirtyGuardMatch[3] ? ` và ${dirtyGuardMatch[3]} mục xung đột cần xử lý` : '';
    return `${season} đang có ${pending} thay đổi cục bộ chưa đồng bộ${conflicts}. Việc nhập lại sẽ thay thế dữ liệu gốc của lịch mùa.`;
  }

  // 7. Allocation validations
  if (/Check-in start must be before check-in end/i.test(rawMessage)) {
    return 'Giờ mở quầy phải trước giờ đóng quầy.';
  }
  if (/Timeline start must be before end/i.test(rawMessage)) {
    return 'Thời điểm bắt đầu phải trước thời điểm kết thúc.';
  }
  const counterNotInRoster = /Counter\s+(.+?)\s+is not in the counter roster/i.exec(rawMessage);
  if (counterNotInRoster) {
    return `Quầy ${counterNotInRoster[1]} không nằm trong danh sách quầy khả dụng.`;
  }
  if (/Current counter is not in the counter roster/i.test(rawMessage)) {
    return 'Quầy hiện tại không nằm trong danh sách quầy khả dụng.';
  }
  if (/Check-in allocation cannot move outside the counter roster/i.test(rawMessage)) {
    return 'Phân bổ quầy không thể di chuyển ra ngoài danh sách quầy.';
  }
  if (/Selected counter is not assigned to this check-in allocation/i.test(rawMessage)) {
    return 'Quầy đã chọn chưa được gán cho lượt phân bổ này.';
  }
  const counterAssigned = /Counter\s+(.+?)\s+is already assigned to this check-in allocation/i.exec(rawMessage);
  if (counterAssigned) {
    return `Quầy ${counterAssigned[1]} đã được phân bổ cho chuyến bay này.`;
  }
  if (/Not enough contiguous counters are available for check-in allocation/i.test(rawMessage)) {
    return 'Không đủ quầy liền kề để phân bổ cho chuyến bay.';
  }
  if (/Cannot break an unallocated check-in record/i.test(rawMessage)) {
    return 'Không thể tách quầy cho chuyến bay chưa phân bổ.';
  }
  if (/Cannot add a counter to an unallocated check-in record/i.test(rawMessage)) {
    return 'Không thể thêm quầy cho chuyến bay chưa phân bổ.';
  }

  // 8. Authentication & account errors
  if (/^Username không hợp lệ\.?$/i.test(rawMessage)) {
    return 'Tên đăng nhập không hợp lệ.';
  }
  if (/invalid (?:login )?credentials/i.test(rawMessage)) {
    return 'Thông tin đăng nhập không chính xác.';
  }
  if (/email not confirmed/i.test(rawMessage)) {
    return 'Email chưa được xác nhận. Vui lòng kiểm tra hộp thư của bạn.';
  }
  if (/user not found/i.test(rawMessage)) {
    return 'Không tìm thấy tài khoản người dùng.';
  }
  if (/signup is disabled/i.test(rawMessage)) {
    return 'Chức năng đăng ký tài khoản hiện đang tạm khóa.';
  }
  const pwdLenMatch = /password should be at least (\d+) characters/i.exec(rawMessage);
  if (pwdLenMatch) {
    return `Mật khẩu phải có ít nhất ${pwdLenMatch[1]} ký tự.`;
  }
  if (/user already registered/i.test(rawMessage)) {
    return 'Tài khoản với email này đã tồn tại trong hệ thống.';
  }
  if (/anonymous provider is disabled/i.test(rawMessage)) {
    return 'Chế độ đăng nhập ẩn danh không được hỗ trợ.';
  }

  return null;
}

/**
 * Returns a user-friendly Vietnamese error message without leaking SDK/SQL/schema/code details.
 * Recognizes network, timeout, authentication, duplicate constraints, and domain diagnostic messages;
 * preserves meaningful Vietnamese diagnostics and interpolated business data.
 */
export function formatUiError(error: unknown, fallback?: string): string {
  const defaultFallback = fallback || 'Đã xảy ra lỗi trong quá trình xử lý. Vui lòng thử lại sau.';

  if (!error) {
    return defaultFallback;
  }

  let rawMessage = '';
  if (typeof error === 'string') {
    rawMessage = error.trim();
  } else if (error instanceof Error) {
    rawMessage = error.message.trim();
  } else if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    if (typeof errObj.message === 'string') {
      rawMessage = errObj.message.trim();
    } else if (typeof errObj.error === 'string') {
      rawMessage = errObj.error.trim();
    } else if (typeof errObj.details === 'string') {
      rawMessage = errObj.details.trim();
    }
  }

  if (!rawMessage) {
    return defaultFallback;
  }

  // 1. Check for sensitive technical database / code leakage
  const isTechnicalLeak = SENSITIVE_TECHNICAL_PATTERNS.some((pattern) => pattern.test(rawMessage));
  if (isTechnicalLeak) {
    if (/duplicate key|unique constraint|23505/i.test(rawMessage)) {
      return 'Dữ liệu đã tồn tại trong hệ thống (trùng khóa). Vui lòng kiểm tra lại.';
    }
    if (/foreign key|23503/i.test(rawMessage)) {
      return 'Dữ liệu đang được liên kết ở nơi khác, không thể xóa hoặc thay đổi.';
    }
    if (/permission denied|violates row-level security|row-level security|42501/i.test(rawMessage)) {
      return 'Bạn không có quyền thực hiện thao tác này trên hệ thống.';
    }
    return defaultFallback;
  }
  // Recognized business diagnostics take precedence over generic transport codes.
  const domainDiagnostic = translateBusinessDiagnostic(rawMessage);
  if (domainDiagnostic) {
    return domainDiagnostic;
  }

  // 2. Network and connection errors
  if (/failed to fetch|network\s*error|network request failed|net::err|load failed/i.test(rawMessage)) {
    return 'Không thể kết nối đến máy chủ. Vui lòng kiểm tra lại đường truyền mạng.';
  }

  // 3. Timeout errors
  if (/timeout|abort|econnaborted|canceling statement due to statement timeout/i.test(rawMessage)) {
    return 'Hết thời gian chờ phản hồi từ máy chủ. Vui lòng thử lại.';
  }

  // 4. Authentication & authorization
  if (/jwt expired|token is expired|invalid token|unauthorized|401/i.test(rawMessage)) {
    return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
  }
  if (/permission denied|forbidden|access denied|403/i.test(rawMessage)) {
    return 'Bạn không có quyền thực hiện thao tác này.';
  }

  // 5. Not found
  if (/not found|404|record not found/i.test(rawMessage)) {
    return 'Không tìm thấy dữ liệu yêu cầu.';
  }

  // 6. Conflict & duplicate
  if (/conflict|409|already exists/i.test(rawMessage)) {
    return 'Dữ liệu bị trùng lặp hoặc xung đột với bản ghi khác.';
  }

  // 8. If the message is already Vietnamese and clean of technical stacks, preserve it!
  if (VIETNAMESE_ACCENT_REGEX.test(rawMessage)) {
    return rawMessage;
  }

  // 9. If unrecognized English message, avoid leaking raw English technical words
  return defaultFallback;
}
