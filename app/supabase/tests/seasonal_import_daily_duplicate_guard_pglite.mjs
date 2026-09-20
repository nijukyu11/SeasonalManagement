import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const chain = [
  '../schema.sql',
  '../migrations/20260828083000_allow_alphanumeric_stand_values.sql',
  '../migrations/20260828090000_daily_schedule_import_v1.sql',
  '../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql',
  '../migrations/20260829150000_canonical_flight_leg_store.sql',
  '../migrations/20260829153000_daily_schedule_canonical_commit.sql',
  '../migrations/20260829160000_canonical_manual_modifications.sql',
  '../migrations/20260829163000_canonical_effective_read.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
  '../migrations/20260831103000_daily_overlay_lineage_match.sql',
  '../migrations/20260831124500_daily_overlay_authority_scope_match.sql',
  '../migrations/20260902140000_daily_import_conflict_http_status.sql',
  '../migrations/20260904183000_daily_import_stage_indexed_ops_date.sql',
  '../migrations/20260906010000_import_terminal_coverage_and_identity.sql',
  '../migrations/20260906011000_active_seasonal_export_snapshot.sql',
  '../migrations/20260914090000_daily_loose_identity_live_row_precedence.sql',
  '../migrations/20260915100000_canonical_overlay_deletion_authority.sql',
];
const guardMigrationUrl = new URL(
  '../migrations/20260920170000_seasonal_import_daily_duplicate_guard.sql',
  import.meta.url,
);
const resolutionMigrationUrl = new URL(
  '../migrations/20260920220000_seasonal_import_duplicate_resolution.sql',
  import.meta.url,
);

const seasonId = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
const writerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const fixtureSql = `
insert into auth.users (id, email) values
  ('${writerId}', 'writer@example.test');

insert into public.app_operators (user_id, email, username, display_name) values
  ('${writerId}', 'writer@example.test', 'writer', 'Writer');

insert into public.app_operator_permission_overrides (user_id, permission_key, effect) values
  ('${writerId}', 'seasonal.read', 'allow'),
  ('${writerId}', 'seasonal.write', 'allow'),
  ('${writerId}', 'season.repair', 'allow');

insert into public.seasons (id, season_code, name, uploaded_at, data_version) values
  ('${seasonId}', 'S26', 'S26', 0, 7);
`;

const daysOfWeek = (isoDow) => Array.from({ length: 7 }, (_, index) => index + 1 === isoDow);

const sourceRow = ({ rowIndex, airline, flight, sta, date, isoDow }) => ({
  rowIndex,
  effective: date,
  discontinue: date,
  airline,
  aircraft: '738',
  daysOfWeek: daysOfWeek(isoDow),
  sta,
  arrFlight: flight,
  arrFlightType: 'PAX',
  arrRoute: 'MFM',
  arrFlightCategory: 'J',
  arrCodeShares: null,
  arrIntDomInd: 'I',
  std: null,
  depFlight: null,
  depFlightType: null,
  depRoute: null,
  depFlightCategory: null,
  depCodeShares: null,
  depIntDomInd: null,
  overnightLinkRowIndex: null,
  linkType: null,
});

const recordInsert = `
insert into public.season_flight_records(
  season_id, record_id, link_id, type, airline, flight_number, raw_flight_number, route,
  schedule, aircraft, category, date, scheduled_date, scheduled_time, operational_date,
  iata_season_code, flight_series_id, day_of_week, source_kind, source_side, status, action
) values ($1,$2,'',$3,$4,$5,$6,'MFM',$7,'738','J',$8,$8,$7,$8,'S26',0,$9,$10,$11,$12,$13)`;

const db = await createSupabasePGlite();
const startedAt = Date.now();

try {
  for (const file of chain) {
    await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
  }
  await db.exec(fixtureSql);

  const insertRecord = async (row) => {
    await db.query(recordInsert, [
      seasonId,
      row.recordId,
      row.type,
      row.airline,
      row.flightNumber,
      row.rawFlightNumber,
      row.schedule,
      row.date,
      row.isoDow,
      row.sourceKind,
      row.side,
      row.status ?? 'active',
      row.action ?? null,
    ]);
  };

  await insertRecord({
    recordId: 'DAILY_GUARD_NX_ACTIVE',
    type: 'D',
    airline: 'NX',
    flightNumber: 'NX985',
    rawFlightNumber: '985',
    schedule: '23:35',
    date: '2026-07-16',
    isoDow: 4,
    sourceKind: 'daily',
    side: 'DEP',
  });
  await insertRecord({
    recordId: 'DAILY_GUARD_ZE_OVERLAY_DELETED',
    type: 'A',
    airline: 'ZE',
    flightNumber: 'ZE593A',
    rawFlightNumber: '593A',
    schedule: '00:40',
    date: '2026-07-17',
    isoDow: 5,
    sourceKind: 'daily',
    side: 'ARR',
  });
  await db.query(
    `insert into public.season_modifications(season_id, leg_id, action, changed_fields)
     values ($1, 'DAILY_GUARD_ZE_OVERLAY_DELETED', 'deleted', '{}')`,
    [seasonId],
  );
  await insertRecord({
    recordId: 'LEG_GUARD_NX_SEASONAL',
    type: 'A',
    airline: 'NX',
    flightNumber: 'NX985',
    rawFlightNumber: '985',
    schedule: '04:00',
    date: '2026-07-18',
    isoDow: 6,
    sourceKind: 'seasonal',
    side: 'ARR',
  });
  await insertRecord({
    recordId: 'MANUAL_GUARD_NX_ACTIVE',
    type: 'A',
    airline: 'NX',
    flightNumber: 'NX988',
    rawFlightNumber: '988',
    schedule: '06:00',
    date: '2026-07-20',
    isoDow: 1,
    sourceKind: 'manual',
    side: 'ARR',
    action: 'added',
  });

  const guardMigrationSql = await readFile(guardMigrationUrl, 'utf8');
  await db.exec(guardMigrationSql);
  await db.exec(await readFile(resolutionMigrationUrl, 'utf8'));
  await db.exec(`set role authenticated`);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [writerId]);

  let requestSeq = 0;
  const stage = async ({ rows, strategy = 'merge' }) => {
    requestSeq += 1;
    const payload = {
      contractVersion: 3,
      requestId: `70000000-0000-4000-8000-0000000000${String(requestSeq).padStart(2, '0')}`,
      checksum: `guard-probe-${requestSeq}`,
      strategy,
      seasonId,
      seasonCode: 'S26',
      expectedDataVersion: 7,
      fileName: 'S26.xlsx',
      uploadedAt: 1,
      sourceRows: rows,
    };
    const response = await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [
      JSON.stringify(payload),
    ]);
    return response.rows[0].result;
  };

  const codes = (result) => result.diagnostics.map((diagnostic) => diagnostic.code);
  const colliding = sourceRow({
    rowIndex: 1,
    airline: 'NX',
    flight: '985',
    sta: '03:00',
    date: '2026-07-16',
    isoDow: 4,
  });

  const collision = await stage({ rows: [colliding] });
  assert.deepEqual(codes(collision), ['daily-occurrence-collision'], 'daily collision must be the only diagnostic');
  assert.equal(collision.valid, false, 'daily collision must block the stage');
  assert.deepEqual(collision.diagnostics[0].sourceRowIndexes, [1]);
  assert.deepEqual(collision.diagnostics[0].sampleDates, ['2026-07-16']);
  assert.match(collision.diagnostics[0].message, /DAILY_GUARD_NX_ACTIVE/);
  assert.equal(collision.counts.insertCount, 1, 'the colliding occurrence is still counted as an insert');
  assert.equal(collision.status, 'failed');

  const overlayOnly = await stage({
    rows: [
      sourceRow({ rowIndex: 1, airline: 'ZE', flight: '593A', sta: '00:40', date: '2026-07-17', isoDow: 5 }),
    ],
  });
  assert.deepEqual(codes(overlayOnly), [], 'overlay-deleted daily rows are not active and must not collide');
  assert.equal(overlayOnly.valid, true);

  const seasonalMatch = await stage({
    rows: [
      sourceRow({ rowIndex: 1, airline: 'NX', flight: '985', sta: '04:00', date: '2026-07-18', isoDow: 6 }),
    ],
  });
  assert.deepEqual(codes(seasonalMatch), [], 'a seasonal row with the same occurrence key is an update, not a collision');
  assert.equal(seasonalMatch.counts.insertCount, 0);
  assert.equal(seasonalMatch.counts.baselineUpdateCount + seasonalMatch.counts.unchangedCount, 1);
  assert.equal(seasonalMatch.valid, true);

  const manualCollision = await stage({
    rows: [
      sourceRow({ rowIndex: 1, airline: 'NX', flight: '988', sta: '06:00', date: '2026-07-20', isoDow: 1 }),
    ],
  });
  assert.deepEqual(codes(manualCollision), ['manual-occurrence-collision'], 'manual collisions keep their own code');
  assert.equal(manualCollision.valid, false);

  const internalDuplicate = await stage({
    rows: [
      sourceRow({ rowIndex: 1, airline: 'NX', flight: '987', sta: '07:00', date: '2026-07-19', isoDow: 7 }),
      sourceRow({ rowIndex: 2, airline: 'NX', flight: '987', sta: '08:00', date: '2026-07-19', isoDow: 7 }),
    ],
  });
  assert.deepEqual(codes(internalDuplicate), [], 'in-file duplicates are resolved instead of blocking');
  assert.equal(internalDuplicate.valid, true);
  assert.deepEqual(
    internalDuplicate.warnings.map((warning) => warning.code),
    ['duplicate-occurrence-resolved'],
  );
  assert.deepEqual(internalDuplicate.warnings[0].sourceRowIndexes, [1, 2]);
  assert.match(internalDuplicate.warnings[0].message, /kept row 1/);
  assert.equal(internalDuplicate.counts.insertCount, 1, 'only the winning row is inserted');

  const control = await stage({
    rows: [
      sourceRow({ rowIndex: 1, airline: 'NX', flight: '986', sta: '05:00', date: '2026-07-16', isoDow: 4 }),
    ],
  });
  assert.deepEqual(codes(control), [], 'a distinct flight number on a daily day must not collide');
  assert.equal(control.valid, true);

  const replaceCollision = await stage({ rows: [colliding], strategy: 'replace' });
  assert.deepEqual(codes(replaceCollision), ['daily-occurrence-collision'], 'replace imports collide too');
  assert.equal(replaceCollision.valid, false);

  await db.exec(`reset role`);
  await db.exec(guardMigrationSql);
  await db.exec(await readFile(resolutionMigrationUrl, 'utf8'));
  await db.exec(`set role authenticated`);
  const afterSecondRun = await stage({
    rows: [sourceRow({ rowIndex: 1, airline: 'NX', flight: '985', sta: '03:00', date: '2026-07-16', isoDow: 4 })],
  });
  assert.deepEqual(codes(afterSecondRun), ['daily-occurrence-collision'], 're-running the migration keeps the guard');

  console.log(
    JSON.stringify({
      suite: 'seasonal_import_daily_duplicate_guard_pglite.mjs',
      engine: 'PGlite',
      cases: 8,
      elapsedMs: Date.now() - startedAt,
      status: 'passed',
    }),
  );
} finally {
  await db.close();
}
