import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateSourceRowsFromRelationalPages,
  type SourceRowDayRelationalRow,
  type SourceRowRelationalRow,
} from './supabaseRelationalMappers.ts';

function row(rowIndex: number, arrFlightType: string | null, depFlightType: string | null): SourceRowRelationalRow {
  return {
    season_id: 'season-w26',
    row_index: rowIndex,
    effective: '2026-10-25',
    discontinue: '2027-03-27',
    airline: 'VN',
    aircraft: '321',
    sta: rowIndex === 2 ? '10:00' : null,
    arr_flight: rowIndex === 2 ? 'VN336' : null,
    arr_flight_type: arrFlightType,
    arr_route: rowIndex === 2 ? 'KIX' : null,
    arr_category: rowIndex === 2 ? 'J' : null,
    arr_code_shares: null,
    arr_int_dom_ind: rowIndex === 2 ? 'I' : null,
    std: rowIndex === 1 ? '12:00' : null,
    dep_flight: rowIndex === 1 ? 'VN337' : null,
    dep_flight_type: depFlightType,
    dep_route: rowIndex === 1 ? 'KIX' : null,
    dep_category: rowIndex === 1 ? 'J' : null,
    dep_code_shares: null,
    dep_int_dom_ind: rowIndex === 1 ? 'I' : null,
    overnight_link_row_index: null,
    link_type: null,
  };
}

test('source provenance preserves flight types and stable ordering across relational pages', () => {
  const dayPages: SourceRowDayRelationalRow[][] = [
    [{ season_id: 'season-w26', row_index: 2, iso_dow: 7 }],
    [
      { season_id: 'season-w26', row_index: 1, iso_dow: 3 },
      { season_id: 'season-w26', row_index: 2, iso_dow: 1 },
    ],
  ];
  const rows = hydrateSourceRowsFromRelationalPages(
    [[row(2, 'PAX', null)], [row(1, null, 'CARGO')]],
    dayPages,
  );

  assert.deepEqual(rows.map((value) => value.rowIndex), [1, 2]);
  assert.equal(rows[0].arrFlightType, null);
  assert.equal(rows[0].depFlightType, 'CARGO');
  assert.equal(rows[1].arrFlightType, 'PAX');
  assert.equal(rows[1].depFlightType, null);
  assert.deepEqual(rows[0].daysOfWeek, [false, false, true, false, false, false, false]);
  assert.deepEqual(rows[1].daysOfWeek, [true, false, false, false, false, false, true]);
});
