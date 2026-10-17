import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatFlightNumber,
  formatFlightDescriptor,
  formatFlightState,
  formatDiffSummary,
  formatDayRanges,
  formatSingleValue,
  getBusinessChanges,
  areValuesEquivalent,
} from './seasonalDiffFormatters.ts';

test('formatFlightNumber combines airline and flight number without duplicating prefix', () => {
  assert.equal(formatFlightNumber('VN', '123'), 'VN123');
  assert.equal(formatFlightNumber('VN', 'VN123'), 'VN123');
  assert.equal(formatFlightNumber('vn', 'VN123'), 'VN123');
  assert.equal(formatFlightNumber(null, 'VJ456'), 'VJ456');
  assert.equal(formatFlightNumber('QH', null), 'QH');
  assert.equal(formatFlightNumber(null, null), '—');
});
test('formatSingleValue maps ARR and DEP to Vietnamese labels Đến and Đi', () => {
  assert.equal(formatSingleValue('ARR'), 'Đến');
  assert.equal(formatSingleValue('DEP'), 'Đi');
});


test('formatFlightDescriptor presents concise route, time, and aircraft', () => {
  const desc = formatFlightDescriptor({
    route: 'HAN-SGN',
    schedule: '08:30',
    aircraft: 'A321',
  });
  assert.equal(desc, 'Tuyến HAN-SGN · Giờ 08:30 · Tàu A321');

  // Alias support in descriptor
  const descAlias = formatFlightDescriptor({
    route: 'DAD-HAN',
    scheduledTime: '14:15',
    aircraftType: 'B787',
  });
  assert.equal(descAlias, 'Tuyến DAD-HAN · Giờ 14:15 · Tàu B787');
});

test('formatFlightState handles flight status cleanly avoiding raw null or []', () => {
  const state = formatFlightState({
    schedule: '10:00',
    route: 'SGN-CXR',
    aircraft: 'A320',
    pax: 180,
    gate: '12',
    stand: null, // should be omitted, not 'Cửa null' or 'Bãi null'
  });
  assert.equal(state, 'Giờ 10:00 · Tuyến SGN-CXR · Tàu A320 · Pax 180 · Cửa 12');

  const emptyState = formatFlightState({});
  assert.equal(emptyState, '—');
});

test('realistic aliases normalize to identical canonical fields without spurious diffs', () => {
  // schedule aliases: scheduled_time vs schedule
  const beforeTime = { scheduled_time: '08:30', route: 'HAN-SGN' };
  const afterTime = { schedule: '08:30', route: 'HAN-SGN' };
  assert.equal(formatDiffSummary(beforeTime, afterTime), '—');

  // aircraft aliases: aircraftType vs aircraft_type
  const beforeAc = { aircraftType: 'A321', route: 'HAN-SGN' };
  const afterAc = { aircraft_type: 'A321', route: 'HAN-SGN' };
  assert.equal(formatDiffSummary(beforeAc, afterAc), '—');

  // Real change across aliases
  const beforeShift = { scheduled_time: '08:30', aircraftType: 'A320' };
  const afterShift = { schedule: '09:00', aircraft: 'A321' };
  const summary = formatDiffSummary(beforeShift, afterShift);
  assert.equal(summary, 'Giờ: 08:30 → 09:00 · Tàu bay: A320 → A321');
});

test('preserves 0 and distinguishes it from null, undefined, and empty string', () => {
  // 0 is a valid business value (e.g. 0 pax, stand 0)
  assert.equal(formatSingleValue(0), '0');
  assert.equal(formatSingleValue('0'), '0');
  assert.equal(formatSingleValue(null), 'Chưa khai báo');
  assert.equal(formatSingleValue(''), 'Chưa khai báo');
  assert.equal(formatSingleValue([]), 'Chưa khai báo');

  // 0 vs null is a REAL diff
  const diffPax = formatDiffSummary({ pax: null }, { pax: 0 });
  assert.equal(diffPax, 'Khách: Chưa khai báo → 0');

  const diffPaxReverse = formatDiffSummary({ pax: 0 }, { pax: null });
  assert.equal(diffPaxReverse, 'Khách: 0 → Chưa khai báo');

  // null vs "" vs [] are equivalent empty states (no false diff)
  assert.equal(areValuesEquivalent(null, ''), true);
  assert.equal(areValuesEquivalent(undefined, null), true);
  assert.equal(areValuesEquivalent([], null), true);
  assert.equal(areValuesEquivalent(0, null), false);
  assert.equal(areValuesEquivalent(0, '0'), true);
  assert.equal(formatDiffSummary({ gate: null }, { gate: '' }), '—');
});

test('scheduled_date is omitted when unchanged and included when changed (date shift)', () => {
  // Invariant date is not repeated
  const invariant = { scheduled_date: '2026-10-15', schedule: '08:00' };
  const invariantAfter = { scheduled_date: '2026-10-15', schedule: '09:00' };
  assert.equal(formatDiffSummary(invariant, invariantAfter), 'Giờ: 08:00 → 09:00');

  // Changed date is formatted as date shift
  const shifted = { scheduled_date: '2026-10-15', schedule: '08:00' };
  const shiftedAfter = { scheduled_date: '2026-10-16', schedule: '08:00' };
  assert.equal(formatDiffSummary(shifted, shiftedAfter), 'Ngày bay: 15/10/2026 → 16/10/2026');

  // Date shift with alias (date vs scheduledDate)
  const aliasShift = { date: '2026-10-15' };
  const aliasShiftAfter = { scheduledDate: '2026-10-18' };
  assert.equal(formatDiffSummary(aliasShift, aliasShiftAfter), 'Ngày bay: 15/10/2026 → 18/10/2026');
});

test('internal-only changes are labeled "Thông tin kỹ thuật" without inventing business changes', () => {
  const beforeInternal = { id: 'uuid-1', source_row_index: 4, schedule: '08:00' };
  const afterInternal = { id: 'uuid-2', source_row_index: 10, schedule: '08:00' };
  const summary = formatDiffSummary(beforeInternal, afterInternal, ['source_row_index']);
  assert.equal(summary, 'Thông tin kỹ thuật');

  const changes = getBusinessChanges(beforeInternal, afterInternal, ['source_row_index']);
  assert.equal(changes.length, 0);
});
test('formatDayRanges groups consecutive days without implying gaps are operating days', () => {
  // Consecutive days
  const consecutive = ['2026-10-01', '2026-10-02', '2026-10-03'];
  assert.deepEqual(formatDayRanges(consecutive), ['01/10/2026 → 03/10/2026']);

  // Single day
  assert.deepEqual(formatDayRanges(['2026-10-01']), ['01/10/2026']);

  // Days with gaps
  const withGaps = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-07', '2026-10-08'];
  assert.deepEqual(formatDayRanges(withGaps), [
    '01/10/2026 → 02/10/2026',
    '05/10/2026',
    '07/10/2026 → 08/10/2026',
  ]);

  // Unordered inputs are sorted and deduped
  const unsorted = ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-02'];
  assert.deepEqual(formatDayRanges(unsorted), ['01/10/2026 → 03/10/2026']);
  // Empty input
  assert.deepEqual(formatDayRanges([]), []);
});

test('regression: realistic schedule+route+aircraft+flightSeriesId+turnaroundId yields EXACTLY 3 business changes without raw IDs', () => {
  const before = {
    schedule: '08:00',
    route: 'HAN-SGN',
    aircraft: 'A320',
    flightSeriesId: 'SER_A1B2C3D4_001',
    turnaroundId: 'TURN_998877_ABC',
    status: 'ACTIVE',
  };
  const after = {
    schedule: '09:30',
    route: 'HAN-DAD',
    aircraft: 'A321',
    flightSeriesId: 'SER_X9Y8Z7W6_002',
    turnaroundId: 'TURN_112233_DEF',
    status: 'MODIFIED',
  };
  const changedFields = ['schedule', 'route', 'aircraft', 'flightSeriesId', 'turnaroundId'];

  const changes = getBusinessChanges(before, after, changedFields);
  assert.equal(changes.length, 3);
  assert.deepEqual(
    changes.map((c) => c.key),
    ['schedule', 'route', 'aircraft'],
  );

  const summary = formatDiffSummary(before, after, changedFields);
  assert.equal(summary, 'Giờ: 08:00 → 09:30 · Tuyến: HAN-SGN → HAN-DAD · Tàu bay: A320 → A321');
  assert.equal(summary.includes('SER_'), false);
  assert.equal(summary.includes('TURN_'), false);
  assert.equal(summary.includes('flightSeriesId'), false);
  assert.equal(summary.includes('turnaroundId'), false);
});

test('canonical value equality treats A vs ARR, codeShares order, and counter objects as equivalent', () => {
  // type A vs ARR
  assert.equal(areValuesEquivalent('A', 'ARR', 'type'), true);
  assert.equal(areValuesEquivalent('DEP', 'D', 'side'), true);

  // code_shares scalar vs array and ordering
  assert.equal(areValuesEquivalent('VN123, AF456', ['AF456', 'VN123'], 'code_shares'), true);

  // counters object wrappers with internal IDs
  const countersA = [{ id: 'cnt-1', counter_value: '01' }, { id: 'cnt-2', counter_value: '02' }];
  const countersB = [{ id: 'cnt-9', counter_value: '01' }, { id: 'cnt-8', counter_value: '02' }];
  assert.equal(areValuesEquivalent(countersA, countersB, 'counters'), true);

  // checkin windows with internal IDs
  const windowsA = [{ id: 'win-1', key: '01', start: '06:00', end: '08:00' }];
  const windowsB = [{ id: 'win-9', key: '01', start: '06:00', end: '08:00' }];
  assert.equal(areValuesEquivalent(windowsA, windowsB, 'checkin_windows'), true);
});

test('field-aware formatting disambiguates D between side (Đi) and int_dom_ind (Quốc nội) and formats link_type in Vietnamese', () => {
  // Disambiguation of 'D'
  assert.equal(formatSingleValue('D', 'side'), 'Đi');
  assert.equal(formatSingleValue('D', 'int_dom_ind'), 'Quốc nội');
  assert.equal(formatSingleValue('I', 'int_dom_ind'), 'Quốc tế');

  // link_type Vietnamese formatting
  assert.equal(formatSingleValue('sameday', 'link_type'), 'Cùng ngày');
  assert.equal(formatSingleValue('overnight', 'link_type'), 'Qua đêm');

});
