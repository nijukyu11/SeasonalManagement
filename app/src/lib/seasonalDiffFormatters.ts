export interface CanonicalFieldDef {
  key: string;
  aliases: readonly string[];
  label: string;
}

export const CANONICAL_FIELD_DEFS: readonly CanonicalFieldDef[] = [
  { key: 'schedule', aliases: ['schedule', 'scheduledTime', 'scheduled_time'], label: 'Giờ' },
  { key: 'route', aliases: ['route'], label: 'Tuyến' },
  { key: 'aircraft', aliases: ['aircraft', 'aircraftType', 'aircraft_type'], label: 'Tàu bay' },
  { key: 'scheduled_date', aliases: ['scheduledDate', 'scheduled_date', 'date', 'operational_date'], label: 'Ngày bay' },
  { key: 'airline', aliases: ['airline'], label: 'Hãng' },
  { key: 'flight_number', aliases: ['flightNumber', 'flight_number'], label: 'Số hiệu' },
  { key: 'type', aliases: ['type', 'side'], label: 'Loại chặng' },
  { key: 'category', aliases: ['category'], label: 'Nhóm' },
  { key: 'flight_type', aliases: ['flightType', 'flight_type'], label: 'Hình thức' },
  { key: 'int_dom_ind', aliases: ['intDomInd', 'int_dom_ind'], label: 'Quốc nội/Quốc tế' },
  { key: 'code_shares', aliases: ['codeShares', 'code_shares'], label: 'Liên danh' },
  { key: 'pax', aliases: ['pax'], label: 'Khách' },
  { key: 'gate', aliases: ['gate'], label: 'Cửa' },
  { key: 'stand', aliases: ['stand'], label: 'Bãi' },
  { key: 'counters', aliases: ['counters', 'counter'], label: 'Quầy' },
  { key: 'checkin_windows', aliases: ['checkinWindows', 'checkin_windows'], label: 'Cửa sổ quầy' },
  { key: 'carousel', aliases: ['carousel'], label: 'Băng chuyền' },
  { key: 'link_type', aliases: ['linkType', 'link_type'], label: 'Loại cặp nối' },
] as const;

export const FIELD_LABELS: Record<string, string> = {
  schedule: 'Giờ',
  scheduled_time: 'Giờ',
  scheduledTime: 'Giờ',
  route: 'Tuyến',
  aircraft: 'Tàu bay',
  aircraft_type: 'Tàu bay',
  aircraftType: 'Tàu bay',
  scheduled_date: 'Ngày bay',
  scheduledDate: 'Ngày bay',
  date: 'Ngày bay',
  operational_date: 'Ngày bay',
  airline: 'Hãng',
  flight_number: 'Số hiệu',
  flightNumber: 'Số hiệu',
  type: 'Loại chặng',
  side: 'Loại chặng',
  category: 'Nhóm',
  flight_type: 'Hình thức',
  flightType: 'Hình thức',
  int_dom_ind: 'Quốc nội/Quốc tế',
  intDomInd: 'Quốc nội/Quốc tế',
  code_shares: 'Liên danh',
  codeShares: 'Liên danh',
  pax: 'Khách',
  gate: 'Cửa',
  stand: 'Bãi',
  counter: 'Quầy',
  counters: 'Quầy',
  checkin_windows: 'Cửa sổ quầy',
  checkinWindows: 'Cửa sổ quầy',
  carousel: 'Băng chuyền',
  link_type: 'Loại cặp nối',
  linkType: 'Loại cặp nối',
  action: 'Hành động',
  turnaround_id: 'Cặp chuyến',
  linked_leg_id: 'Cặp nối',
};

export const IGNORED_DIFF_FIELDS: Record<string, true> = {
  source_row_index: true,
  status: true,
  created_at: true,
  updated_at: true,
  id: true,
  draft_id: true,
  version_id: true,
  season_id: true,
  hash: true,
  group_key: true,
  publish_sequence: true,
  created_by: true,
  updated_by: true,
};

export function formatFlightNumber(airline?: unknown, flightNumber?: unknown): string {
  const fn = flightNumber !== undefined && flightNumber !== null ? String(flightNumber).trim() : '';
  const al = airline !== undefined && airline !== null ? String(airline).trim() : '';
  if (!fn) return al || '—';
  if (!al) return fn;
  if (fn.toUpperCase().startsWith(al.toUpperCase())) return fn;
  return `${al}${fn}`;
}

export function formatCounters(counters: unknown): string | null {
  if (counters === undefined || counters === null) return null;
  if (Array.isArray(counters)) {
    if (counters.length === 0) return null;
    const items = counters
      .map((c: unknown) => {
        if (typeof c === 'object' && c !== null && 'counter_value' in c) {
          return String((c as Record<string, unknown>).counter_value);
        }
        return String(c);
      })
      .filter((s) => s.trim() !== '');
    return items.length > 0 ? items.join(',') : null;
  }
  const str = String(counters).trim();
  return str || null;
}

export function formatWindows(windows: unknown): string | null {
  if (windows === undefined || windows === null) return null;
  if (Array.isArray(windows)) {
    if (windows.length === 0) return null;
    const parts = windows
      .map((w: unknown) => {
        if (typeof w === 'object' && w !== null) {
          const obj = w as Record<string, unknown>;
          const k = 'key' in obj ? String(obj.key) : 'counter_key' in obj ? String(obj.counter_key) : '';
          const start = 'start' in obj ? String(obj.start) : 'window_start' in obj ? String(obj.window_start) : '';
          const end = 'end' in obj ? String(obj.end) : 'window_end' in obj ? String(obj.window_end) : '';
          return k ? `${k}: ${start}-${end}` : `${start}-${end}`;
        }
        return String(w);
      })
      .filter((s) => s.trim() !== '' && s !== '-');
    return parts.length > 0 ? parts.join(', ') : null;
  }
  if (typeof windows === 'object') {
    const entries = Object.entries(windows as Record<string, unknown>);
    if (entries.length === 0) return null;
    const parts = entries.map(([k, v]) => {
      if (typeof v === 'object' && v !== null) {
        const obj = v as Record<string, unknown>;
        const start = 'start' in obj ? String(obj.start) : 'window_start' in obj ? String(obj.window_start) : '';
        const end = 'end' in obj ? String(obj.end) : 'window_end' in obj ? String(obj.window_end) : '';
        return `${k}: ${start}-${end}`;
      }
      return `${k}: ${String(v)}`;
    });
    return parts.join(', ');
  }
  const str = String(windows).trim();
  return str || null;
}

export function isNullOrEmpty(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  if (typeof val === 'object' && val !== null && Object.keys(val).length === 0) return true;
  return false;
}

export function formatDateDisplay(day?: unknown): string {
  if (!day) return '';
  const str = String(day).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    return `${m[3]}/${m[2]}/${m[1]}`;
  }
  return str;
}

export function formatSingleValue(val: unknown, fieldKey?: string): string {
  if (isNullOrEmpty(val)) return 'Chưa khai báo';
  if (val === 0 || val === '0') return '0';
  if (typeof val === 'boolean') return val ? 'Có' : 'Không';
  if (typeof val === 'string') {
    const trimmed = val.trim();

    if (fieldKey === 'type' || fieldKey === 'side') {
      const upper = trimmed.toUpperCase();
      if (upper === 'A' || upper === 'ARR') return 'Đến';
      if (upper === 'D' || upper === 'DEP') return 'Đi';
    }

    if (fieldKey === 'int_dom_ind' || fieldKey === 'intDomInd') {
      const upper = trimmed.toUpperCase();
      if (upper === 'I' || upper === 'INT') return 'Quốc tế';
      if (upper === 'D' || upper === 'DOM') return 'Quốc nội';
    }

    if (fieldKey === 'link_type' || fieldKey === 'linkType') {
      const lower = trimmed.toLowerCase();
      if (lower === 'sameday' || lower === 'same_day') return 'Cùng ngày';
      if (lower === 'overnight' || lower === 'over_night') return 'Qua đêm';
      if (lower === 'nextday' || lower === 'next_day') return 'Hôm sau';
    }

    if (trimmed === 'ARR') return 'Đến';
    if (trimmed === 'DEP') return 'Đi';
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return formatDateDisplay(trimmed);
    }
  }

  if (Array.isArray(val)) {
    if (val.some((item) => typeof item === 'object' && item !== null && 'counter_value' in item)) {
      const formatted = formatCounters(val);
      return formatted || 'Chưa khai báo';
    }
    if (val.some((item) => typeof item === 'object' && item !== null && ('window_start' in item || 'start' in item))) {
      const formatted = formatWindows(val);
      return formatted || 'Chưa khai báo';
    }
    const items = val
      .map((item) => {
        if (typeof item === 'object' && item !== null) {
          const inner = Object.entries(item)
            .filter(([k]) => !IGNORED_DIFF_FIELDS[k])
            .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${formatSingleValue(v)}`)
            .join(' ');
          return inner || null;
        }
        return String(item);
      })
      .filter((s): s is string => Boolean(s && s.trim() !== ''));
    return items.length > 0 ? items.join(', ') : 'Chưa khai báo';
  }

  if (typeof val === 'object' && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>).filter(([k]) => !IGNORED_DIFF_FIELDS[k]);
    if (entries.length === 0) return 'Chưa khai báo';
    if (entries.some(([, v]) => typeof v === 'object' && v !== null && ('start' in v || 'end' in v))) {
      const formatted = formatWindows(val);
      return formatted || 'Chưa khai báo';
    }
    return entries
      .map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${formatSingleValue(v)}`)
      .join(', ');
  }

  return String(val);
}

export function formatFlightState(state: Record<string, unknown> | null | undefined): string {
  if (!state) return '—';
  const parts: string[] = [];

  const time = state.schedule ?? state.scheduledTime ?? state.scheduled_time;
  if (time !== undefined && time !== null && String(time).trim() !== '') {
    parts.push(`Giờ ${String(time).trim()}`);
  }

  const route = state.route;
  if (route !== undefined && route !== null && String(route).trim() !== '') {
    parts.push(`Tuyến ${String(route).trim()}`);
  }

  const ac = state.aircraft ?? state.aircraftType ?? state.aircraft_type;
  if (ac !== undefined && ac !== null && String(ac).trim() !== '') {
    parts.push(`Tàu ${String(ac).trim()}`);
  }

  if (state.pax !== undefined && state.pax !== null && String(state.pax).trim() !== '') {
    parts.push(`Khách ${String(state.pax)}`);
  }

  if (state.gate !== undefined && state.gate !== null && String(state.gate).trim() !== '') {
    parts.push(`Cửa ${String(state.gate)}`);
  }

  if (state.stand !== undefined && state.stand !== null && String(state.stand).trim() !== '') {
    parts.push(`Bãi ${String(state.stand)}`);
  }

  const counters = state.counters ?? state.counter;
  if (counters !== undefined && counters !== null) {
    const formatted = formatCounters(counters);
    if (formatted) parts.push(`Quầy ${formatted}`);
  }

  const windows = state.checkin_windows ?? state.checkinWindows;
  if (windows !== undefined && windows !== null) {
    const formatted = formatWindows(windows);
    if (formatted) parts.push(`Cửa sổ ${formatted}`);
  }

  if (state.carousel !== undefined && state.carousel !== null && String(state.carousel).trim() !== '') {
    parts.push(`Băng chuyền ${String(state.carousel)}`);
  }

  return parts.length > 0 ? parts.join(' · ') : '—';
}

export function formatFlightDescriptor(state: Record<string, unknown> | null | undefined): string {
  if (!state) return '—';
  const parts: string[] = [];

  const route = state.route;
  if (route !== undefined && route !== null && String(route).trim() !== '') {
    parts.push(`Tuyến ${String(route).trim()}`);
  }

  const time = state.schedule ?? state.scheduledTime ?? state.scheduled_time;
  if (time !== undefined && time !== null && String(time).trim() !== '') {
    parts.push(`Giờ ${String(time).trim()}`);
  }

  const ac = state.aircraft ?? state.aircraftType ?? state.aircraft_type;
  if (ac !== undefined && ac !== null && String(ac).trim() !== '') {
    parts.push(`Tàu ${String(ac).trim()}`);
  }

  return parts.length > 0 ? parts.join(' · ') : formatFlightState(state);
}

export function areValuesEquivalent(a: unknown, b: unknown, fieldKey?: string): boolean {
  if (isNullOrEmpty(a) && isNullOrEmpty(b)) return true;
  if (a === b) return true;
  if ((a === 0 || a === '0') && (b === 0 || b === '0')) return true;

  // Type / side: 'A' vs 'ARR', 'D' vs 'DEP'
  if (fieldKey === 'type' || fieldKey === 'side') {
    const normA = String(a).trim().toUpperCase();
    const normB = String(b).trim().toUpperCase();
    const sideA = normA === 'A' || normA === 'ARR' ? 'ARR' : normA === 'D' || normA === 'DEP' ? 'DEP' : normA;
    const sideB = normB === 'A' || normB === 'ARR' ? 'ARR' : normB === 'D' || normB === 'DEP' ? 'DEP' : normB;
    if (sideA === sideB) return true;
  }

  // int_dom_ind: 'I' vs 'INT', 'D' vs 'DOM'
  if (fieldKey === 'int_dom_ind' || fieldKey === 'intDomInd') {
    const normA = String(a).trim().toUpperCase();
    const normB = String(b).trim().toUpperCase();
    const indA = normA === 'I' || normA === 'INT' ? 'INT' : normA === 'D' || normA === 'DOM' ? 'DOM' : normA;
    const indB = normB === 'I' || normB === 'INT' ? 'INT' : normB === 'D' || normB === 'DOM' ? 'DOM' : normB;
    if (indA === indB) return true;
  }

  // link_type: 'sameday' vs 'same_day', etc.
  if (fieldKey === 'link_type' || fieldKey === 'linkType') {
    const norm = (s: unknown) => String(s).trim().toLowerCase().replace(/[_\s-]+/g, '');
    if (norm(a) === norm(b)) return true;
  }
  // Counters: compare via formatCounters (which extracts counter_value and ignores internal IDs)
  if (fieldKey === 'counters' || fieldKey === 'counter') {
    const cA = formatCounters(a);
    const cB = formatCounters(b);
    if ((cA === null || cA === '') && (cB === null || cB === '')) return true;
    if (cA === cB) return true;
  }

  // Checkin windows: compare via formatWindows (which ignores internal IDs)
  if (fieldKey === 'checkin_windows' || fieldKey === 'checkinWindows') {
    const wA = formatWindows(a);
    const wB = formatWindows(b);
    if ((wA === null || wA === '') && (wB === null || wB === '')) return true;
    if (wA === wB) return true;
  }

  // Code shares: scalar or array, order-independent
  if (fieldKey === 'code_shares' || fieldKey === 'codeShares') {
    const toSortedShares = (val: unknown): string => {
      if (isNullOrEmpty(val)) return '';
      if (Array.isArray(val)) {
        return val.map((s) => String(s).trim()).filter(Boolean).sort().join(',');
      }
      return String(val)
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(',');
    };
    if (toSortedShares(a) === toSortedShares(b)) return true;
  }

  if (typeof a === 'number' && typeof b === 'string') return String(a) === b.trim();
  if (typeof a === 'string' && typeof b === 'number') return a.trim() === String(b);
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function getCanonicalValue(
  state: Record<string, unknown> | null | undefined,
  def: CanonicalFieldDef,
): unknown {
  if (!state) return undefined;
  for (const alias of def.aliases) {
    if (alias in state && state[alias] !== undefined) {
      return state[alias];
    }
  }
  return undefined;
}

export interface BusinessFieldChange {
  key: string;
  label: string;
  beforeRaw: unknown;
  afterRaw: unknown;
  beforeFormatted: string;
  afterFormatted: string;
}

export function getBusinessChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  changedFields?: string[] | null,
): BusinessFieldChange[] {
  const changes: BusinessFieldChange[] = [];

  for (const def of CANONICAL_FIELD_DEFS) {
    if (changedFields && changedFields.length > 0) {
      const aliasChanged = def.aliases.some((al) => changedFields.includes(al));
      if (!aliasChanged) continue;
    }

    const bVal = getCanonicalValue(before, def);
    const aVal = getCanonicalValue(after, def);

    if (areValuesEquivalent(bVal, aVal, def.key)) {
      continue;
    }

    changes.push({
      key: def.key,
      label: def.label,
      beforeRaw: bVal,
      afterRaw: aVal,
      beforeFormatted: formatSingleValue(bVal, def.key),
      afterFormatted: formatSingleValue(aVal, def.key),
    });
  }

  return changes;
}

export function formatDiffSummary(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  changedFields?: string[] | null,
): string {
  const changes = getBusinessChanges(before, after, changedFields);
  if (changes.length === 0) {
    if (changedFields && changedFields.length > 0) {
      return 'Thông tin kỹ thuật';
    }
    return '—';
  }
  return changes.map((c) => `${c.label}: ${c.beforeFormatted} → ${c.afterFormatted}`).join(' · ');
}

export function formatDayRanges(days: string[]): string[] {
  if (!days || days.length === 0) return [];
  const sorted = Array.from(new Set(days)).sort();
  const ranges: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  const nextDay = (day: string) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  for (const day of sorted) {
    if (start && prev && nextDay(prev) === day) {
      prev = day;
      continue;
    }
    if (start && prev) {
      const sFmt = formatDateDisplay(start);
      const pFmt = formatDateDisplay(prev);
      ranges.push(start === prev ? sFmt : `${sFmt} → ${pFmt}`);
    }
    start = day;
    prev = day;
  }
  if (start && prev) {
    const sFmt = formatDateDisplay(start);
    const pFmt = formatDateDisplay(prev);
    ranges.push(start === prev ? sFmt : `${sFmt} → ${pFmt}`);
  }
  return ranges;
}
export function formatDayRangesSummary(days: string[]): string {
  const ranges = formatDayRanges(days);
  return ranges.length > 0 ? ranges.join(', ') : '—';
}
