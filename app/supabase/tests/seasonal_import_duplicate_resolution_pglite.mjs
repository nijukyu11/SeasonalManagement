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
  '../migrations/20260920170000_seasonal_import_daily_duplicate_guard.sql',
];
const resolutionMigrationUrl = new URL(
  '../migrations/20260920220000_seasonal_import_duplicate_resolution.sql',
  import.meta.url,
);

const seasonId = 'season-29cbca13-e11d-4b75-bcaa-00a6c5ca68c6';
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
  ('${seasonId}', 'W26', 'W26', 0, 7);
`;

const daysOfWeek = (isoDows) => Array.from({ length: 7 }, (_, index) => isoDows.includes(index + 1));

const sourceRow = ({
  rowIndex,
  airline,
  arrFlight = null,
  depFlight = null,
  sta = null,
  std = null,
  effective,
  discontinue,
  isoDows,
  route = 'MFM',
  overnightLinkRowIndex = null,
}) => ({
  rowIndex,
  effective,
  discontinue,
  airline,
  aircraft: '738',
  daysOfWeek: daysOfWeek(isoDows),
  sta,
  arrFlight,
  arrFlightType: arrFlight ? 'PAX' : null,
  arrRoute: arrFlight ? route : null,
  arrFlightCategory: arrFlight ? 'J' : null,
  arrCodeShares: null,
  arrIntDomInd: arrFlight ? 'I' : null,
  std,
  depFlight,
  depFlightType: depFlight ? 'PAX' : null,
  depRoute: depFlight ? route : null,
  depFlightCategory: depFlight ? 'J' : null,
  depCodeShares: null,
  depIntDomInd: depFlight ? 'I' : null,
  overnightLinkRowIndex,
  linkType: null,
});

const db = await createSupabasePGlite();
const startedAt = Date.now();

try {
  for (const file of chain) {
    await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
  }
  await db.exec(fixtureSql);
  const resolutionMigrationSql = await readFile(resolutionMigrationUrl, 'utf8');
  await db.exec(resolutionMigrationSql);

  await db.exec(`set role authenticated`);
  await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [writerId]);

  let requestSeq = 0;
  const stage = async ({ rows, strategy = 'merge', expectedDataVersion = 7 }) => {
    requestSeq += 1;
    const payload = {
      contractVersion: 3,
      requestId: `71000000-0000-4000-8000-0000000000${String(requestSeq).padStart(2, '0')}`,
      checksum: `resolution-probe-${requestSeq}`,
      strategy,
      seasonId,
      seasonCode: 'W26',
      expectedDataVersion,
      fileName: 'W26.xlsx',
      uploadedAt: 1,
      sourceRows: rows,
    };
    const response = await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [
      JSON.stringify(payload),
    ]);
    return response.rows[0].result;
  };

  const codes = (result) => result.diagnostics.map((diagnostic) => diagnostic.code);
  const warningCodes = (result) => result.warnings.map((warning) => warning.code);

  // W26 shape 1: one flight number repeated on the same date by two rows with the
  // same Effective through Discontinue window. The lowest source row index wins.
  const equalCoverage = await stage({
    rows: [
      sourceRow({
        rowIndex: 1, airline: 'VJ', arrFlight: '5987', sta: '17:45',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
      sourceRow({
        rowIndex: 2, airline: 'VJ', arrFlight: '5987', sta: '00:05',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
    ],
  });
  assert.deepEqual(codes(equalCoverage), [], 'equal coverage duplicates must not block the stage');
  assert.equal(equalCoverage.valid, true, 'equal coverage duplicates must keep the batch valid');
  assert.deepEqual(warningCodes(equalCoverage), ['duplicate-occurrence-resolved']);
  assert.deepEqual(equalCoverage.warnings[0].sourceRowIndexes, [1, 2]);
  assert.match(equalCoverage.warnings[0].message, /kept row 1/);
  assert.equal(equalCoverage.counts.generatedOccurrenceCount, 1, 'exactly one occurrence is generated');
  assert.equal(equalCoverage.counts.insertCount, 1);
  assert.equal(equalCoverage.warningCount, 1);

  // W26 shape 2: a narrow exception row collides with a wide base row on the only
  // day both cover. The wide row wins, and the narrow row keeps nothing.
  const wideVersusNarrow = await stage({
    rows: [
      sourceRow({
        rowIndex: 3, airline: '5J', arrFlight: '5758', depFlight: '5759', sta: '07:15', std: '08:30',
        effective: '2026-10-26', discontinue: '2027-03-26', isoDows: [1, 3, 5],
      }),
      sourceRow({
        rowIndex: 4, airline: '5J', arrFlight: '5758', depFlight: '5759', sta: '07:30', std: '08:30',
        effective: '2026-10-25', discontinue: '2026-10-26', isoDows: [1, 2, 3, 4, 5, 6],
      }),
    ],
  });
  assert.deepEqual(codes(wideVersusNarrow), [], 'a narrow exception row must not block the stage');
  assert.equal(wideVersusNarrow.valid, true);
  assert.deepEqual(
    warningCodes(wideVersusNarrow),
    ['duplicate-occurrence-resolved', 'duplicate-occurrence-resolved'],
    'the arrival and the departure leg each report their resolved occurrence',
  );
  assert.deepEqual(
    wideVersusNarrow.warnings.map((warning) => warning.sourceRowIndexes),
    [[3, 4], [3, 4]],
  );
  assert.deepEqual(
    wideVersusNarrow.warnings.map((warning) => warning.occurrenceKey.endsWith('|2026-10-26|5J|5J5758')
      || warning.occurrenceKey.endsWith('|2026-10-26|5J|5J5759')),
    [true, true],
  );
  for (const warning of wideVersusNarrow.warnings) {
    assert.match(warning.message, /kept row 3/);
  }
  assert.deepEqual(
    wideVersusNarrow.warnings.map((warning) => warning.sampleDates),
    [['2026-10-26'], ['2026-10-26']],
  );

  // W26 shape 3: rows whose selected operating days never fall inside their own
  // Effective through Discontinue window are skipped, not blocked.
  const zeroRows = await stage({
    rows: [
      sourceRow({
        rowIndex: 5, airline: '5J', arrFlight: '5758', depFlight: '5759', sta: '07:30', std: '08:30',
        effective: '2026-11-30', discontinue: '2026-12-05', isoDows: [7],
      }),
      sourceRow({
        rowIndex: 6, airline: 'MH', arrFlight: '8780', depFlight: '8781', sta: '16:55', std: '17:55',
        effective: '2026-12-31', discontinue: '2026-12-31', isoDows: [5],
      }),
      sourceRow({
        rowIndex: 7, airline: 'VN', arrFlight: '200', sta: '23:30',
        effective: '2026-06-01', discontinue: '2026-06-01', isoDows: [1],
      }),
    ],
  });
  assert.deepEqual(codes(zeroRows), [], 'rows without an operating day must not block the stage');
  assert.equal(zeroRows.valid, true);
  assert.deepEqual(warningCodes(zeroRows), ['zero-generated-records', 'zero-generated-records']);
  assert.deepEqual(
    zeroRows.warnings.map((warning) => warning.sourceRowIndexes),
    [[5], [6]],
  );
  assert.deepEqual(zeroRows.warnings.map((warning) => warning.sampleDates), [[], []]);
  assert.equal(zeroRows.counts.generatedOccurrenceCount, 1, 'the remaining row still generates its flight');

  // A file that generates nothing at all never matches the season and is blocked.
  const allZero = await stage({
    rows: [
      sourceRow({
        rowIndex: 20, airline: 'MH', arrFlight: '8780', depFlight: '8781', sta: '16:55', std: '17:55',
        effective: '2026-12-31', discontinue: '2026-12-31', isoDows: [5],
      }),
      sourceRow({
        rowIndex: 21, airline: 'MH', arrFlight: '8782', depFlight: '8783', sta: '18:55', std: '19:55',
        effective: '2026-12-31', discontinue: '2026-12-31', isoDows: [5],
      }),
    ],
  });
  assert.deepEqual(codes(allZero), ['no-generated-records'], 'a file that generates nothing is blocked');
  assert.equal(allZero.valid, false);
  assert.equal(allZero.counts.generatedOccurrenceCount, 0);
  assert.equal(allZero.status, 'failed');

  // Structural diagnostics keep blocking the commit.
  const structural = await stage({
    rows: [
      sourceRow({
        rowIndex: 7, airline: 'VN', arrFlight: '200', sta: '23:30',
        effective: '2026-06-01', discontinue: '2026-06-01', isoDows: [1],
      }),
      sourceRow({
        rowIndex: 8, airline: 'VN', depFlight: '201', std: '01:05',
        effective: '2026-06-02', discontinue: '2026-06-02', isoDows: [2],
        overnightLinkRowIndex: 99,
      }),
    ],
  });
  assert.deepEqual(codes(structural), ['missing-linked-row'], 'broken pair links stay blocking');
  assert.equal(structural.valid, false);
  assert.equal(structural.status, 'failed');

  // A partial file whose minority of rows generate stays committable.
  const minority = await stage({
    rows: [
      sourceRow({
        rowIndex: 9, airline: 'VJ', arrFlight: '100', sta: '08:00',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
      sourceRow({
        rowIndex: 10, airline: 'VJ', arrFlight: '101', sta: '09:00',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [5],
      }),
      sourceRow({
        rowIndex: 11, airline: 'VJ', arrFlight: '102', sta: '10:00',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [5],
      }),
    ],
  });
  assert.deepEqual(codes(minority), [], 'a file with skipped rows is not blocked by the skip itself');
  assert.equal(minority.valid, true);
  assert.deepEqual(warningCodes(minority), ['zero-generated-records', 'zero-generated-records']);
  assert.equal(minority.counts.generatedOccurrenceCount, 1);

  // Warnings must not block the commit itself.
  const commitPayload = await stage({
    rows: [
      sourceRow({
        rowIndex: 1, airline: 'VJ', arrFlight: '5987', sta: '17:45',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
      sourceRow({
        rowIndex: 2, airline: 'VJ', arrFlight: '5987', sta: '00:05',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
      sourceRow({
        rowIndex: 3, airline: '5J', arrFlight: '5758', depFlight: '5759', sta: '07:15', std: '08:30',
        effective: '2026-10-26', discontinue: '2027-03-26', isoDows: [1, 3, 5],
      }),
      sourceRow({
        rowIndex: 4, airline: '5J', arrFlight: '5758', depFlight: '5759', sta: '07:30', std: '08:30',
        effective: '2026-10-25', discontinue: '2026-10-26', isoDows: [1, 2, 3, 4, 5, 6],
      }),
      sourceRow({
        rowIndex: 5, airline: 'MH', arrFlight: '8780', depFlight: '8781', sta: '16:55', std: '17:55',
        effective: '2026-12-31', discontinue: '2026-12-31', isoDows: [5],
      }),
    ],
  });
  assert.equal(commitPayload.valid, true, 'a file with resolved duplicates and skipped rows is committable');
  assert.deepEqual(codes(commitPayload), []);
  assert.equal(commitPayload.warningCount, 4, 'every warning code reaches the preview');
  await db.exec(`reset role`);
  const stagedDiagnostics = await db.query(
    `select batches.diagnostics, batches.preview->'warnings' as warnings, batches.preview->>'warningCount' as warning_count
     from public.season_import_batches batches
     where batches.batch_id = $1`,
    [commitPayload.batchId],
  );
  assert.deepEqual(stagedDiagnostics.rows[0].diagnostics, [], 'blocking diagnostics stay empty');
  assert.equal(stagedDiagnostics.rows[0].warnings.length, 4);
  assert.equal(stagedDiagnostics.rows[0].warning_count, '4');
  await db.exec(`set role authenticated`);

  const committed = await db.query(
    `select public.commit_seasonal_import_v3($1, $2, $3) as result`,
    [commitPayload.batchId, 7, commitPayload.previewHash],
  );
  assert.equal(committed.rows[0].result.status, 'committed', 'warnings must not block the commit');
  const losers = await db.query(
    `select pg_catalog.count(*)::integer as loser_count
     from public.season_flight_records records
     where records.season_id = $1
       and records.schedule in ('07:30', '00:05')`,
    [seasonId],
  );
  assert.equal(losers.rows[0].loser_count, 0, 'a losing row leaves no record behind');
  const persisted = await db.query(
    `select
       records.flight_number,
       records.schedule,
       pg_catalog.count(*)::integer as record_count,
       pg_catalog.min(records.date::text) as first_date,
       pg_catalog.max(records.date::text) as last_date
     from public.season_flight_records records
     where records.season_id = $1
       and records.status = 'active'
       and records.action is distinct from 'deleted'
     group by records.flight_number, records.schedule
     order by records.flight_number`,
    [seasonId],
  );
  assert.deepEqual(
    persisted.rows.map((row) => [
      row.flight_number,
      row.schedule,
      row.first_date,
      row.last_date,
    ]),
    [
      ['5J5758', '07:15', '2026-10-26', '2027-03-26'],
      ['5J5759', '08:30', '2026-10-26', '2027-03-26'],
      ['VJ5987', '17:45', '2027-02-11', '2027-02-11'],
    ],
    'the committed season carries the winning occurrences only',
  );

  await db.exec(`reset role`);
  await db.exec(resolutionMigrationSql);
  await db.exec(`set role authenticated`);
  const afterSecondRun = await stage({
    rows: [
      sourceRow({
        rowIndex: 1, airline: 'VJ', arrFlight: '5987', sta: '17:45',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
      sourceRow({
        rowIndex: 2, airline: 'VJ', arrFlight: '5987', sta: '00:05',
        effective: '2027-02-11', discontinue: '2027-02-11', isoDows: [4],
      }),
    ],
    expectedDataVersion: 8,
  });
  assert.deepEqual(warningCodes(afterSecondRun), ['duplicate-occurrence-resolved'], 're-running the migration keeps the resolution');

  console.log(
    JSON.stringify({
      suite: 'seasonal_import_duplicate_resolution_pglite.mjs',
      engine: 'PGlite',
      migrationRuns: 2,
      elapsedMs: Date.now() - startedAt,
      status: 'passed',
    }),
  );
} finally {
  await db.close();
}
