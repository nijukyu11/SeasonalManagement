// Shared fixture for the Seasonal/Operational separation milestones (M0+).
//
// The fixture is intentionally rich enough to pin the semantics the migration
// plan must preserve:
//   - two overlapping seasons (W26 ops window, M26 overlap window)
//   - one same-side duplicate row inside a seasonal import (JX701 22:00/KIX)
//   - one turnaround pair in a single source row (JX703 arrival + departure)
//   - operational overlays (gate/stand/carousel/pax and a schedule shift)
//   - a manual leg that survives every later import
//   - a Daily import, a Daily re-import of the same date, and a rejected
//     zero-flight attempt (M5 flips the last one on purpose)
//   - an ambiguous business leg whose candidate has no change events, which the
//     canonical store can only resolve by quarantining the date
//
// Reported surfaces are captured with volatile fields stripped so the M10
// shadow-parity run can compare semantics instead of counters.
import { createSeasonalOperationalSeparationDb } from './seasonal_operational_separation_test_support.mjs';

export const M0_FIXTURE = Object.freeze({
  writerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  seasonW26: 'season-m0-w26',
  seasonM26: 'season-m0-m26',
  seasonLegacy: 'season-m0-legacy',
  manualLegId: 'MANUAL-M0-1',
  dailyDate: '2026-10-26',
  // The traffic report only counts legs whose scheduled time already passed, so
  // the fixture pins an explicit data_as_of instead of reading the wall clock.
  dataAsOf: '2026-12-20T00:00:00+00:00',
  octoberWindow: { start: '2026-10-24', end: '2026-10-28' },
  decemberWindow: { start: '2026-12-14', end: '2026-12-18' },
});

const W26_SEASONAL_ROWS = [
  // Two same-side JX701 rows: the import keys legs by season|type|date|airline|flight
  // number, so the 22:00/KIX row cannot survive next to the 10:00/TPE row.
  { rowIndex: 1, arrFlight: '701', arrRoute: 'TPE', sta: '10:00' },
  { rowIndex: 2, arrFlight: '701', arrRoute: 'KIX', sta: '22:00' },
  // One row that carries both sides of a same-flight-number turnaround: the
  // engine derives the departure leg and points the arrival at it, but the
  // shared occurrence key (season|date|airline|flight number, no side) means
  // only the arrival survives the commit.
  { rowIndex: 3, arrFlight: '703', arrRoute: 'TPE', sta: '18:00', depFlight: '703', depRoute: 'TPE', std: '19:30' },
  // December legs for the overlap, backfill and quarantine probes.
  { rowIndex: 4, effective: '2026-12-15', discontinue: '2026-12-15', arrFlight: '801', arrRoute: 'TPE', sta: '10:00' },
  { rowIndex: 5, effective: '2026-12-17', discontinue: '2026-12-17', arrFlight: '902', arrRoute: 'TPE', sta: '10:00' },
  { rowIndex: 6, effective: '2026-12-18', discontinue: '2026-12-18', arrFlight: '903', arrRoute: 'TPE', sta: '10:00' },
];

const DAILY_FIRST_LEGS = [
  {
    sourceRowNumber: 1, flightNumber: 'VN101', rawFlightNumber: '101', scheduledTime: '06:00',
    resources: { route: 'SGN', schedule: '06:00', stand: '20A', gate: 9, counter: '30,M1', pax: 123 },
    rawResourceTokens: { stand: 'Stand20A', gate: 'G1', counter: 'C30 M1', carousel: null },
  },
  {
    sourceRowNumber: 2, flightNumber: 'VN102', rawFlightNumber: '102', scheduledTime: '07:00',
    resources: { route: 'SGN', schedule: '07:00', pax: null },
  },
  {
    sourceRowNumber: 3, flightNumber: 'VN103', rawFlightNumber: '103', scheduledTime: '08:00',
    resources: { route: 'SGN', schedule: '08:00', pax: 0 },
  },
];

const DAILY_REIMPORT_LEGS = [
  {
    sourceRowNumber: 1, flightNumber: 'VN101', rawFlightNumber: '101', scheduledTime: '06:30',
    resources: { route: 'SGN', schedule: '06:30', stand: '21A', gate: 7, pax: 123, counter: '30,M1' },
    rawResourceTokens: { stand: 'Stand21A', gate: 'G2', counter: 'C30 M1', carousel: null },
  },
  {
    sourceRowNumber: 2, flightNumber: 'VN201', rawFlightNumber: '201', scheduledTime: '12:00',
    resources: { route: 'SGN', schedule: '12:00', pax: 45 },
  },
];

export async function openM0FixtureDb() {
  const { db } = await createSeasonalOperationalSeparationDb();
  const asWriter = async () => {
    await db.exec('set role authenticated');
    await db.query(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [M0_FIXTURE.writerId]);
  };
  const asAdmin = async () => {
    await db.exec('reset role');
  };
  return { db, asWriter, asAdmin };
}

export async function seedM0OperatorsAndSeasons({ db }) {
  await db.query(`insert into auth.users(id,email) values ($1,'m0@example.test')`, [M0_FIXTURE.writerId]);
  await db.query(
    `insert into public.app_operators(user_id,email,username,display_name) values ($1,'m0@example.test','m0','M0')`,
    [M0_FIXTURE.writerId]
  );
  await db.query(
    `insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values
      ($1,'seasonal.read','allow'),($1,'seasonal.write','allow'),($1,'detailed.write','allow'),
      ($1,'daily.read','allow'),($1,'daily.write','allow'),($1,'season.repair','allow')`,
    [M0_FIXTURE.writerId]
  );
  await db.query(
    `insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
     values ($1,'W26','W26','',0,'2026-10-25','2027-03-27',0,0,0),
            ($2,'M26','M26','',0,'2026-12-01','2027-03-31',0,0,0)`,
    [M0_FIXTURE.seasonW26, M0_FIXTURE.seasonM26]
  );
}

export const seasonalRow = (overrides) => ({
  effective: '2026-10-25', discontinue: '2026-10-26',
  airline: 'JX', aircraft: '321', daysOfWeek: [true, true, true, true, true, true, true],
  arrFlightType: 'PAX', arrFlightCategory: 'J', arrIntDomInd: 'I',
  ...overrides,
});

export function seasonalStagePayload({ requestId, strategy, expectedDataVersion, seasonId, seasonCode, sourceRows }) {
  return {
    contractVersion: 3, requestId, checksum: `checksum-${requestId}`, strategy,
    seasonId, seasonCode, expectedDataVersion, fileName: `${seasonCode}_m0.xlsx`, sourceRows,
  };
}

export async function stageAndCommitSeasonalImport({ db, asWriter, asAdmin }, payload) {
  await asWriter();
  const stage = (await db.query(`select public.stage_seasonal_import_v3($1::jsonb) as result`, [JSON.stringify(payload)])).rows[0].result;
  await asAdmin();
  if (stage.status !== 'validated') return { stage, commit: null };
  await asWriter();
  const commit = (
    await db.query(`select public.commit_seasonal_import_v3($1,$2,$3) as result`, [stage.batchId, payload.expectedDataVersion, stage.previewHash])
  ).rows[0].result;
  await asAdmin();
  return { stage, commit };
}

export async function importW26SeasonalSchedule(ctx) {
  // One replace batch carries the whole season: October legs plus the December
  // legs used by the overlap, backfill and quarantine probes.
  const rows = W26_SEASONAL_ROWS.map((row) => seasonalRow(row));
  return stageAndCommitSeasonalImport(ctx, seasonalStagePayload({
    requestId: '10000000-0000-4000-8000-0000000000a1', strategy: 'replace', expectedDataVersion: 0,
    seasonId: M0_FIXTURE.seasonW26, seasonCode: 'W26', sourceRows: rows,
  }));
}

export async function importM26SeasonalSchedule(ctx) {
  const rows = [
    { rowIndex: 1, effective: '2026-12-15', discontinue: '2026-12-15', arrFlight: '801', arrRoute: 'TPE', sta: '10:00' },
    { rowIndex: 2, effective: '2026-12-16', discontinue: '2026-12-16', arrFlight: '901', arrRoute: 'KIX', sta: '10:00' },
  ].map((row) => seasonalRow(row));
  return stageAndCommitSeasonalImport(ctx, seasonalStagePayload({
    requestId: '10000000-0000-4000-8000-0000000000a3', strategy: 'replace', expectedDataVersion: 0,
    seasonId: M0_FIXTURE.seasonM26, seasonCode: 'M26', sourceRows: rows,
  }));
}

export async function findW26Legs({ db }) {
  const rows = (
    await db.query(
      `select record_id, flight_number, type, date, scheduled_time, route, status, action, deletion_reason, source_kind, pax
       from public.season_flight_records
       where season_id = $1
       order by date, scheduled_time, flight_number, type`,
      [M0_FIXTURE.seasonW26]
    )
  ).rows;
  return rows;
}

export async function applyM0Overlays({ db, asWriter, asAdmin }) {
  const legs = await findW26Legs({ db });
  const pickup = legs.find((leg) => leg.flight_number === 'JX701' && leg.date === '2026-10-25' && leg.type === 'A');
  const turnaround = legs.find((leg) => leg.flight_number === 'JX703' && leg.date === '2026-10-25' && leg.type === 'A');
  if (!pickup || !turnaround) throw new Error('Overlay targets missing: seasonal import did not produce the expected legs');
  await asWriter();
  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    M0_FIXTURE.seasonW26,
    JSON.stringify({ legId: pickup.record_id, action: 'modified', gate: 20, stand: '31', carousel: 4, pax: 180 }),
  ]);
  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    M0_FIXTURE.seasonW26,
    JSON.stringify({ legId: turnaround.record_id, action: 'modified', schedule: '18:45', pax: 0 }),
  ]);
  await asAdmin();
  return { pickupLegId: pickup.record_id, turnaroundLegId: turnaround.record_id };
}

export async function addM0ManualLeg({ db, asWriter, asAdmin }) {
  await asWriter();
  const result = (
    await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb) as result`, [
      M0_FIXTURE.seasonW26,
      JSON.stringify({
        legId: M0_FIXTURE.manualLegId,
        action: 'added',
        addedLeg: {
          id: M0_FIXTURE.manualLegId, type: 'D', airline: 'VN', flightNumber: 'VN555', rawFlightNumber: '555',
          route: 'SGN', schedule: '09:00', aircraft: '321', category: 'J', pax: 88, gate: 1, stand: '20A',
          date: '2026-10-25', scheduledDate: '2026-10-25', scheduledTime: '09:00',
          operationalDate: '2026-10-25', iataSeasonCode: 'W26',
        },
      }),
    ])
  ).rows[0].result;
  await asAdmin();
  return result;
}

export function dailyLeg({ seasonCode, requestIndex, leg }) {
  const date = M0_FIXTURE.dailyDate;
  const occurrenceKey = `${seasonCode}|${date}|DEP|VN|${leg.flightNumber}|SGN|${leg.scheduledTime}`;
  return {
    sourceRowNumber: leg.sourceRowNumber, sheetName: 'Daily', side: 'DEP', seasonCode, operationalDate: date,
    scheduledDate: date, scheduledTime: leg.scheduledTime, airline: 'VN', flightNumber: leg.flightNumber,
    rawFlightNumber: leg.rawFlightNumber, route: 'SGN', aircraft: '321', category: 'J', flightType: 'PAX',
    requestStatusCode: null,
    resources: leg.resources,
    rawResourceTokens: leg.rawResourceTokens ?? {},
    occurrenceKey, looseOccurrenceKey: `${seasonCode}|${date}|DEP|VN|${leg.flightNumber}`,
    __requestIndex: requestIndex,
  };
}

export function dailyPayload({ requestId, legs, expectedDataVersion, seasonCode, seasonId }) {
  return {
    contractVersion: 1, requestId, fileName: `daily-${requestId.slice(-2)}.xlsx`, workbookProfile: 'compact-lb',
    rawChecksum: `raw-${requestId}`, canonicalChecksum: `canonical-${requestId}`, resourcePolicyHash: 'policy-v1',
    legs: legs.map(({ __requestIndex, ...leg }) => leg),
    diagnostics: [],
    seasons: [{
      seasonId, seasonCode, expectedDataVersion,
      rangeStart: M0_FIXTURE.dailyDate, rangeEnd: M0_FIXTURE.dailyDate,
      affectedDates: [M0_FIXTURE.dailyDate], legCount: legs.length,
    }],
  };
}

async function readEffectiveDailyLegs({ db }) {
  return (
    await db.query(
      `select flight, scheduled_time, pax, gate, stand, carousel, source_kind, status
       from reporting.canonical_effective_flight_legs
       where season_id = $1 and ops_date = $2 and status = 'active'
       order by scheduled_time, flight`,
      [M0_FIXTURE.seasonW26, M0_FIXTURE.dailyDate]
    )
  ).rows;
}

export async function stageDailyImport({ db, asWriter, asAdmin }, payload) {
  await asWriter();
  const stage = (await db.query(`select public.stage_daily_schedule_import_v1($1::jsonb) as result`, [JSON.stringify(payload)])).rows[0].result;
  await asAdmin();
  return stage;
}

export async function commitDailyImport({ db, asWriter, asAdmin }, stage, expectedDataVersion) {
  await asWriter();
  const commit = (
    await db.query(`select public.commit_daily_schedule_import_v1($1,$2::jsonb,$3) as result`, [
      stage.batchId, JSON.stringify({ [M0_FIXTURE.seasonW26]: expectedDataVersion }), stage.previewHash,
    ])
  ).rows[0].result;
  await asAdmin();
  return commit;
}

export async function runM0DailyImports(ctx) {
  const { db } = ctx;
  const firstLegs = DAILY_FIRST_LEGS.map((leg) => dailyLeg({ seasonCode: 'W26', requestIndex: 1, leg }));
  const firstStage = await stageDailyImport(ctx, dailyPayload({
    requestId: '20000000-0000-4000-8000-0000000000b1', legs: firstLegs, expectedDataVersion: 1,
    seasonCode: 'W26', seasonId: M0_FIXTURE.seasonW26,
  }));
  const firstCommit = firstStage.status === 'validated'
    ? await commitDailyImport(ctx, firstStage, 1)
    : null;
  const firstEffectiveLegs = firstCommit ? await readEffectiveDailyLegs(ctx) : [];

  const reimportLegs = DAILY_REIMPORT_LEGS.map((leg) => dailyLeg({ seasonCode: 'W26', requestIndex: 2, leg }));
  const reimportStage = await stageDailyImport(ctx, dailyPayload({
    requestId: '20000000-0000-4000-8000-0000000000b2', legs: reimportLegs, expectedDataVersion: 2,
    seasonCode: 'W26', seasonId: M0_FIXTURE.seasonW26,
  }));
  const reimportCommit = reimportStage.status === 'validated'
    ? await commitDailyImport(ctx, reimportStage, 2)
    : null;
  const reimportEffectiveLegs = reimportCommit ? await readEffectiveDailyLegs(ctx) : [];

  // A day cannot be cleared through the v1 import contract: zero legs plus an
  // affected date is rejected. M5 replaces this contract on purpose.
  const zeroFlightStage = await stageDailyImport(ctx, dailyPayload({
    requestId: '20000000-0000-4000-8000-0000000000b3', legs: [], expectedDataVersion: 3,
    seasonCode: 'W26', seasonId: M0_FIXTURE.seasonW26,
  }));

  return { firstStage, firstCommit, firstEffectiveLegs, reimportStage, reimportCommit, reimportEffectiveLegs, zeroFlightStage };
}

async function insertBackfilledLeg(db, { seasonId, recordId, seasonCode, date, flightNumber }) {
  await db.query(
    `insert into public.season_flight_records(
       season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule, aircraft, category,
       date, scheduled_date, scheduled_time, operational_date, iata_season_code, day_of_week,
       source_row_index, source_kind, source_side, status
     ) values ($1,$2,'A','JX',$3,$4,'TPE','10:00','321','J',$5,$5,'10:00',$5,$6,0,0,'seasonal','ARR','active')`,
    [seasonId, recordId, flightNumber, flightNumber.replace(/[^0-9]/g, ''), date, seasonCode]
  );
}

// A backfilled leg written without season_change_events only has a season-level
// recency fallback. Inside a season that was imported at least once that is
// enough to win the ranking; inside a season with no events at all the business
// leg can no longer be resolved and the canonical store quarantines the date.
export async function addBackfilledLegs({ db }) {
  await insertBackfilledLeg(db, {
    seasonId: M0_FIXTURE.seasonM26, recordId: 'BACKFILL-M0-902', seasonCode: 'M26',
    date: '2026-12-17', flightNumber: 'JX902',
  });
  await db.query(
    `insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
     values ($1,'L26','L26','',0,'2026-12-01','2027-03-31',0,0,0)`,
    [M0_FIXTURE.seasonLegacy]
  );
  await insertBackfilledLeg(db, {
    seasonId: M0_FIXTURE.seasonLegacy, recordId: 'BACKFILL-M0-903', seasonCode: 'L26',
    date: '2026-12-18', flightNumber: 'JX903',
  });
}

export async function refreshM0CanonicalStore({ db }) {
  await db.query(`select reporting.refresh_public_traffic_canonical_legs_v1()`);
}

export async function buildM0Fixture() {
  const ctx = await openM0FixtureDb();
  const { db } = ctx;
  await seedM0OperatorsAndSeasons(ctx);
  const w26 = await importW26SeasonalSchedule(ctx);
  const m26 = await importM26SeasonalSchedule(ctx);
  const overlays = await applyM0Overlays(ctx);
  const manual = await addM0ManualLeg(ctx);
  const daily = await runM0DailyImports(ctx);
  await addBackfilledLegs(ctx);
  const legsAfterDaily = await findW26Legs(ctx);
  const scopes = (
    await db.query(
      `select season_id, ops_date, authority_source, expected_leg_count, reset_at
       from public.schedule_replacement_scopes order by ops_date, season_id`
    )
  ).rows;
  const versions = (await db.query(`select id, data_version from public.seasons order by id`)).rows;
  await refreshM0CanonicalStore(ctx);
  return {
    ...ctx,
    close: () => db.close(),
    evidence: { w26, m26, overlays, manual, daily, legsAfterDaily, scopes, versions },
  };
}

// ---------------------------------------------------------------- surfaces ---

const VOLATILE_KEY_PATTERN = new RegExp([
  'watermark', 'data_as_of|dataasof', 'data_version|dataversion',
  'created_at|updated_at|uploaded_at|changed_at|changed_by|completed_at|published_at|reset_at|reset_by',
  'server_seq|serverseq|highwater|high_water',
  'request_id|requestid|batch_id|batchid|preview_hash|previewhash|file_hash', 'checksum',
].join('|'), 'i');

export function normalizeM0Surface(value) {
  // PGlite hands back Date instances for date/timestamptz columns; pin them to
  // ISO text so the baseline stays comparable across drivers.
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => normalizeM0Surface(entry));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_KEY_PATTERN.test(key)) continue;
      out[key] = normalizeM0Surface(entry);
    }
    return out;
  }
  return value;
}

async function captureReport(db, window) {
  const result = (
    await db.query(
      `select public.get_public_traffic_report_v2($1::date,$2::date,'all','{}'::text[],'{}'::text[],'{}'::text[],
         'previous','local',null,'traffic-report-v2','full',$3::timestamptz) as result`,
      [window.start, window.end, M0_FIXTURE.dataAsOf]
    )
  ).rows[0].result;
  return normalizeM0Surface({
    current: result.current,
    comparison: result.comparison,
    timeline: result.timeline,
    dimensions: result.dimensions,
    coverage: result.report?.coverage,
    coverage_counts: result.report?.coverage_counts,
    quality: result.report?.quality,
  });
}

// Seasonal and Daily record ids embed the import batch (a fresh UUID per
// fixture run), so the baseline replaces every id with the content identity the
// plan actually reasons about: side|date|airline|flight number.
const LEG_REFERENCE_KEYS = ['link_id', 'linked_record_id', 'turnaround_id', 'supersedes_record_id', 'source_import_batch_id', 'source_file_hash'];

const legIdentity = (row) => [
  String(row.type ?? '').toUpperCase(),
  String(row.operational_date ?? row.date ?? row.ops_date ?? '').slice(0, 10),
  String(row.airline ?? '').toUpperCase(),
  String(row.flight_number ?? row.flight ?? ''),
].join('|');

async function loadLegIdentityIndex(db) {
  const rows = (
    await db.query(`select record_id, type, coalesce(nullif(operational_date,''), date) as ops_date, airline, flight_number from public.season_flight_records`)
  ).rows;
  return new Map(rows.map((row) => [row.record_id, legIdentity(row)]));
}

function stabilizeLegRow(row, idIndex) {
  const out = { ...row, identity: legIdentity(row) };
  delete out.record_id;
  for (const key of LEG_REFERENCE_KEYS) delete out[key];
  return out;
}

function stabilizeModificationRow(row, idIndex) {
  const out = { ...row, target: idIndex.get(row.leg_id) ?? null };
  delete out.leg_id;
  return out;
}

function stabilizeCounterRow(row, idIndex) {
  const id = row.record_id ?? row.leg_id;
  const out = { ...row, leg: idIndex.get(id) ?? null };
  delete out.record_id;
  delete out.leg_id;
  return out;
}

const sortBy = (keyOf) => (left, right) => String(keyOf(left)).localeCompare(String(keyOf(right)));

const legSortKey = (row) => `${row.identity} ${row.scheduled_time ?? ''} ${row.route ?? ''}`;
const modificationSortKey = (row) => `${row.target ?? ''} ${row.action} ${(row.changed_fields ?? []).join(',')}`;
const counterSortKey = (row) => `${row.leg ?? ''} ${row.counter_group} ${row.item_index ?? ''}`;

export async function captureM0ReadSurfaces({ db }) {
  const idIndex = await loadLegIdentityIndex(db);

  const effectiveLegs = (
    await db.query(
      `select ops_date, season_id, type, flight, airline, route, source_kind, status, scheduled_time, pax, gate, stand, carousel
       from reporting.canonical_effective_flight_legs
       where ops_date between '2026-10-24' and '2026-12-18'
       order by ops_date, season_id, scheduled_time, flight`
    )
  ).rows.map((row) => stabilizeLegRow(row, idIndex));
  const canonicalStore = (
    await db.query(
      `select business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type, flight_category, pax, local_minutes
       from reporting.canonical_flight_legs
       order by ops_date, business_leg_key`
    )
  ).rows;
  const quarantine = (
    await db.query(`select ops_date, candidate_count from reporting.canonical_flight_legs_quarantine order by ops_date`)
  ).rows;

  const seasonalExports = {};
  for (const [label, seasonId] of [
    ['W26', M0_FIXTURE.seasonW26],
    ['M26', M0_FIXTURE.seasonM26],
  ]) {
    const dataVersion = (
      await db.query(`select data_version from public.seasons where id = $1`, [seasonId])
    ).rows[0].data_version;
    const result = (
      await db.query(`select public.get_seasonal_export_snapshot_v2($1,$2) as result`, [seasonId, dataVersion])
    ).rows[0].result;
    seasonalExports[label] = normalizeM0Surface({
      seasonId: result.seasonId, seasonCode: result.seasonCode, totalCount: result.totalCount,
      sourceRowCount: result.sourceRowCount, truncated: result.truncated,
      flightRecords: result.flightRecords
        .map((row) => stabilizeLegRow(row, idIndex))
        .sort(sortBy(legSortKey)),
      modifications: result.modifications
        .map((row) => stabilizeModificationRow(row, idIndex))
        .sort(sortBy(modificationSortKey)),
      flightRecordCounters: result.flightRecordCounters
        .map((row) => stabilizeCounterRow(row, idIndex))
        .sort(sortBy(counterSortKey)),
      modificationCounters: result.modificationCounters
        .map((row) => stabilizeCounterRow(row, idIndex))
        .sort(sortBy(counterSortKey)),
      modificationAddedLegs: result.modificationAddedLegs
        .map((row) => stabilizeModificationRow(row, idIndex))
        .sort(sortBy(modificationSortKey)),
    });
  }

  const window = (
    await db.query(
      `select public.get_season_schedule_allocation_window_v2($1,'2026-10-25','2026-10-27','all',500) as result`,
      [M0_FIXTURE.seasonW26]
    )
  ).rows[0].result;

  return normalizeM0Surface({
    effectiveLegs,
    canonicalStore,
    quarantine,
    seasonalExports,
    operationalWindow: {
      startDate: window.startDate, endDate: window.endDate, status: window.status,
      page: window.page, snapshot: window.snapshot,
      flightRecords: window.flightRecords.map((row) => stabilizeLegRow(row, idIndex)).sort(sortBy(legSortKey)),
      modifications: window.modifications.map((row) => stabilizeModificationRow(row, idIndex)).sort(sortBy(modificationSortKey)),
      flightRecordCounters: window.flightRecordCounters.map((row) => stabilizeCounterRow(row, idIndex)).sort(sortBy(counterSortKey)),
      modificationCounters: window.modificationCounters.map((row) => stabilizeCounterRow(row, idIndex)).sort(sortBy(counterSortKey)),
      modificationAddedLegs: window.modificationAddedLegs.map((row) => stabilizeModificationRow(row, idIndex)).sort(sortBy(modificationSortKey)),
    },
    report: {
      october: await captureReport(db, M0_FIXTURE.octoberWindow),
      december: await captureReport(db, M0_FIXTURE.decemberWindow),
    },
  });
}
