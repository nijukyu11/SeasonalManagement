// M2 backfill contract test: legacy seasonal/daily data -> planning drafts,
// operational runtime, day authority and one baseline publish version.
//
// Proves on the M0 fixture that
//   * the backfill runs from the orchestrator under an operator role and records
//     its cutoff + season_change_events high-water,
//   * planning drafts mirror the legacy plan (every lifecycle) with legacy
//     overlays folded per changed_fields while daily import and manual rows stay
//     out of the planning space,
//   * each season with drafts gets exactly one planning-only baseline version
//     whose snapshot checksum is the payload digest,
//   * operational legs reproduce the canonical public-traffic resolution
//     (cross-season dedup, ambiguous keys quarantined) with lineage to batch,
//     occurrence key, draft and published version,
//   * the daily day authority carries the committed scope, keeps zero-leg days
//     and the reset state, and an unchanged replay duplicates no row,
//   * a catch-up replay reconciles real mutations that happened after the
//     snapshot: a retargeted overlay updates the linked leg and appends a new
//     audit event, a deleted plan row retires its leg (dropping the pairing), a
//     replacing daily batch supersedes the old occurrence and bumps the day
//     revision once, while the published baseline snapshot stays immutable,
//   * a plan row that vanished from the legacy table leaves the shadow copy,
//   * non-operators cannot read the backfill ledgers and the rollback refuses
//     while a run is recorded.
//
// Run: node supabase/tests/seasonal_operational_separation_m2_backfill_pglite.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildM0Fixture,
  commitDailyImport,
  dailyLeg as buildDailyLeg,
  dailyPayload,
  M0_FIXTURE,
  stageDailyImport,
} from './seasonal_operational_separation_fixture.mjs';

const MIGRATION_NAME = '20260928130000_seasonal_operational_backfill_v1.sql';
const ROLLBACK_URL = new URL(`../migrations/${MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

// The replacing daily import of the catch-up phase: VN101 moves from 06:30 to
// 08:00 with new resources, VN201 is confirmed unchanged.
const DAILY_THIRD_LEGS = [
  {
    sourceRowNumber: 1, flightNumber: 'VN101', rawFlightNumber: '101', scheduledTime: '08:00',
    resources: { route: 'SGN', schedule: '08:00', stand: '22A', gate: 8, counter: '30,M1', pax: 150 },
    rawResourceTokens: { stand: 'Stand22A', gate: 'G2', counter: 'C30 M1', carousel: null },
  },
  {
    sourceRowNumber: 2, flightNumber: 'VN201', rawFlightNumber: '201', scheduledTime: '12:00',
    resources: { route: 'SGN', schedule: '12:00', pax: 45 },
  },
];

const LEG_KEY = (side, date, airline, flightNumber) => `${side}\u001f${date}\u001f${airline}\u001f${flightNumber}`;
const DATE = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const writerId = M0_FIXTURE.writerId;
const request = (sql, params = []) => db.query(sql, params);
const scalar = async (sql, params = []) => (await request(sql, params)).rows[0];
const count = async (table, where = 'true', params = []) =>
  (await scalar(`select count(*)::integer as count from ${table} where ${where}`, params)).count;

const nonOperatorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

try {
  assert.equal(
    (await scalar(`select to_regprocedure('public.run_seasonal_operational_backfill_v1(date,uuid,bigint)') is not null as present`)).present,
    true,
    `the migration chain applies ${MIGRATION_NAME} (the orchestrator is present)`
  );

  // --- First run -----------------------------------------------------------
  await asWriter();
  const first = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid) as result`, ['2026-10-01', writerId])
  ).rows[0].result;
  await asAdmin();

  assert.deepEqual(
    pick(first, ['versions', 'authorityDays']),
    { versions: 3, authorityDays: 1 },
    `the backfill reports what it wrote (${JSON.stringify(first)})`
  );
  assert.deepEqual(
    pick(first.drafts, ['written', 'retired', 'removed']),
    { written: 11, retired: 0, removed: 0 },
    'the first run writes every draft and reconciles nothing away'
  );
  assert.deepEqual(
    pick(first.legs, ['written', 'updated', 'retired', 'quarantined']),
    { written: 8, updated: 0, retired: 0, quarantined: 1 },
    'the first run resolves every canonical leg and quarantines one business key'
  );
  assert.equal(
    Number(first.sourceHighWater),
    (await scalar(`select coalesce(max(server_seq), 0)::bigint as high_water from public.season_change_events`)).high_water,
    `the run records the season_change_events high-water at cutoff (${first.sourceHighWater})`
  );

  const run = await scalar(`select * from public.seasonal_operational_backfill_runs where run_id = $1`, [first.runId]);
  assert.equal(run.status, 'completed', 'the run ledger row is marked completed');
  assert.ok(run.completed_at instanceof Date, 'the run ledger records its completion time');
  assert.equal(run.published_by, writerId, 'the run ledger records the operator that ran the backfill');
  assert.equal(run.replayed_from_high_water, null, 'the first run replays nothing');
  assert.equal(Number(run.notes.legsQuarantined), 1, `the run reports the quarantined business key count (${JSON.stringify(run.notes)})`);
  assert.deepEqual(
    run.notes.quarantinedBusinessKeys,
    [LEG_KEY('A', '2026-12-18', 'JX', 'JX903')],
    'the run names the quarantined business key instead of dropping it silently'
  );

  // The refusal must outlive the run ledger: the shadow projection re-derives the
  // report quality numbers from this table after the M10 cutover.
  const quarantineLedger = (
    await request(`select business_leg_key, ops_date, candidate_count, source from public.operational_leg_quarantine order by business_leg_key`)
  ).rows;
  const canonicalQuarantine = (
    await request(`select ops_date, candidate_count from reporting.canonical_flight_legs_quarantine order by ops_date, candidate_count`)
  ).rows;
  assert.deepEqual(
    quarantineLedger.map((row) => pick(row, ['business_leg_key', 'candidate_count', 'source'])),
    [{ business_leg_key: LEG_KEY('A', '2026-12-18', 'JX', 'JX903'), candidate_count: canonicalQuarantine[0].candidate_count, source: 'backfill' }],
    `the backfill records the key it refused with the same candidate count the canonical store quarantined (${JSON.stringify(canonicalQuarantine)})`
  );
  assert.equal(
    DATE(quarantineLedger[0].ops_date),
    DATE(canonicalQuarantine[0].ops_date),
    'the ledger keeps the ops date of the quarantined key'
  );

  // --- Planning drafts -----------------------------------------------------
  const draftCounts = (
    await request(
      `select seasons.season_code, count(*)::integer as total,
              count(*) filter (where drafts.status = 'deleted')::integer as deleted
         from public.seasonal_flight_drafts drafts
         join public.seasons seasons on seasons.id = drafts.season_id
        group by seasons.season_code order by seasons.season_code`
    )
  ).rows;
  assert.deepEqual(
    draftCounts,
    [
      { season_code: 'L26', total: 1, deleted: 0 },
      { season_code: 'M26', total: 3, deleted: 0 },
      { season_code: 'W26', total: 7, deleted: 2 },
    ],
    `drafts mirror every seasonal lifecycle per season (${JSON.stringify(draftCounts)})`
  );
  assert.equal(await count('public.seasonal_flight_drafts', `source_kind <> 'imported'`), 0, 'drafts only hold imported plan rows');
  assert.equal(await count('public.seasonal_flight_drafts', `flight_number = 'VN555'`), 0, 'the manual leg stays out of the planning space');
  assert.equal(
    await count('public.seasonal_flight_drafts', `source_import_batch_id in (select batch_id from public.daily_schedule_import_batches)`),
    0,
    'daily import rows never become planning drafts'
  );

  const draftRow = (flightNumber, date, seasonCode) =>
    scalar(
      `select drafts.*, records.pax as base_pax, records.schedule as base_schedule,
              records.turnaround_id as base_turnaround_id, records.link_type as base_link_type,
              records.pair_anchor_date as base_pair_anchor_date
         from public.seasonal_flight_drafts drafts
         join public.seasons seasons on seasons.id = drafts.season_id
         join public.season_flight_records records
           on records.season_id = drafts.season_id and records.flight_number = drafts.flight_number
          and records.type = drafts.type and records.date = drafts.date
        where seasons.season_code = $3 and drafts.flight_number = $1 and drafts.date = $2`,
      [flightNumber, date, seasonCode]
    );

  const pickupDraft = await draftRow('JX701', '2026-10-25', 'W26');
  assert.equal(pickupDraft.base_pax, null, 'the fixture base row carries no pax, so folding is observable');
  assert.deepEqual(
    pick(pickupDraft, ['pax', 'gate', 'stand', 'carousel', 'schedule', 'source_kind', 'source_side', 'status', 'season_id']),
    {
      pax: 180,
      gate: 20,
      stand: '31',
      carousel: 4,
      schedule: '10:00',
      source_kind: 'imported',
      source_side: 'ARR',
      status: 'active',
      season_id: M0_FIXTURE.seasonW26,
    },
    'the JX701 overlay (pax/gate/stand/carousel) is folded into the draft'
  );

  const turnaroundDraft = await draftRow('JX703', '2026-10-25', 'W26');
  assert.equal(turnaroundDraft.base_schedule, '18:00', 'the fixture base schedule differs from the overlay value');
  assert.equal(turnaroundDraft.schedule, '18:45', 'the schedule overlay is folded into the draft');
  assert.equal(turnaroundDraft.pax, 0, 'a zero pax overlay is folded as zero, not treated as missing');
  assert.equal(turnaroundDraft.turnaround_id, turnaroundDraft.base_turnaround_id, 'pairing identity is carried');
  assert.equal(turnaroundDraft.link_type, 'sameday', 'pair link type is carried');
  assert.equal(turnaroundDraft.pair_anchor_date, '2026-10-25', 'pair anchor date is carried');

  const deletedDrafts = (
    await request(
      `select flight_number, action, status, deletion_reason, superseded_by_batch_id is not null as has_superseder
         from public.seasonal_flight_drafts where status = 'deleted' order by flight_number`
    )
  ).rows;
  assert.deepEqual(
    deletedDrafts.map((row) => pick(row, ['flight_number', 'action', 'status', 'deletion_reason', 'has_superseder'])),
    [
      { flight_number: 'JX701', action: 'deleted', status: 'deleted', deletion_reason: 'daily_replacement', has_superseder: true },
      { flight_number: 'JX703', action: 'deleted', status: 'deleted', deletion_reason: 'daily_replacement', has_superseder: true },
    ],
    'daily-superseded plan rows keep their deleted lifecycle and reason in the planning space'
  );

  const overlayEvents = (
    await request(
      `select target_id, changed_fields, before_state, after_state
         from public.seasonal_draft_events where client_id = 'legacy-backfill' order by target_id`
    )
  ).rows;
  assert.equal(overlayEvents.length, 2, 'each folded overlay leaves one draft event');
  assert.deepEqual(
    overlayEvents.map((event) => event.changed_fields).sort((left, right) => left.length - right.length),
    [
      ['pax', 'schedule'],
      ['pax', 'gate', 'stand', 'carousel'],
    ],
    `the folded events name the overlay fields (${JSON.stringify(overlayEvents.map((event) => event.changed_fields))})`
  );
  assert.equal(
    overlayEvents.filter((event) => event.after_state.source === 'season_modifications').length,
    2,
    'folded overlay events keep their provenance'
  );

  // --- Baseline versions ---------------------------------------------------
  const versions = (
    await request(
      `select versions.season_id, versions.version_id, versions.season_code, versions.version_tag, versions.sequence_in_day,
              versions.published_by, versions.total_flight_count, versions.range_start, versions.range_end,
              versions.backfill_run_id, versions.snapshot_checksum,
              snapshots.flight_count, snapshots.checksum, snapshots.snapshot_payload
         from public.seasonal_publish_versions versions
         join public.seasonal_publish_snapshots snapshots on snapshots.version_id = versions.version_id
        order by versions.season_code`
    )
  ).rows;
  assert.deepEqual(
    versions.map((row) => pick(row, ['season_code', 'version_tag', 'sequence_in_day', 'total_flight_count'])),
    [
      { season_code: 'L26', version_tag: 'L26-01OCT26', sequence_in_day: 1, total_flight_count: 1 },
      { season_code: 'M26', version_tag: 'M26-01OCT26', sequence_in_day: 1, total_flight_count: 3 },
      { season_code: 'W26', version_tag: 'W26-01OCT26', sequence_in_day: 1, total_flight_count: 5 },
    ],
    `one baseline version per season with drafts (${JSON.stringify(versions.map((row) => row.version_tag))})`
  );
  for (const version of versions) {
    assert.equal(version.backfill_run_id, first.runId, `${version.version_tag} is attributed to the backfill run`);
    assert.equal(version.published_by, writerId, `${version.version_tag} records the operator as publisher`);
    assert.equal(version.checksum, version.snapshot_checksum, `${version.version_tag} snapshot checksum matches the version row`);
    assert.equal(version.checksum.length, 64, `${version.version_tag} checksum is a sha256 digest`);
    assert.equal(version.flight_count, version.total_flight_count, `${version.version_tag} counts only active plan rows`);
    assert.equal(version.snapshot_payload.scope, 'planning', `${version.version_tag} snapshot is planning-only`);
    assert.equal(
      version.snapshot_payload.counts.deleted,
      version.season_code === 'W26' ? 2 : 0,
      `${version.version_tag} payload accounts for the deleted plan rows`
    );
    assert.equal(
      version.snapshot_payload.flights.length,
      version.snapshot_payload.counts.total,
      `${version.version_tag} payload lists every lifecycle row`
    );
    assert.ok(
      version.snapshot_payload.flights.every((flight) => flight.draftId.startsWith('DRF_')),
      `${version.version_tag} snapshot flights reference drafts`
    );
    assert.equal(
      version.snapshot_payload.flights.some((flight) => ['VN101', 'VN201', 'VN555'].includes(flight.flightNumber)),
      false,
      `${version.version_tag} snapshot holds no daily import or manual leg`
    );
  }
  const w26Version = versions.find((row) => row.season_code === 'W26');
  assert.deepEqual(
    [DATE(w26Version.range_start), DATE(w26Version.range_end)],
    ['2026-10-25', '2026-12-18'],
    'the baseline version range is the season effective window'
  );
  assert.equal(
    w26Version.snapshot_payload.flights.find((flight) => flight.flightNumber === 'JX703').schedule,
    '18:45',
    'the baseline snapshot carries the effective planned values'
  );

  // --- Operational legs ----------------------------------------------------
  const legs = (
    await request(
      `select legs.*, links.legacy_season_id, links.legacy_record_id
         from public.operational_flight_legs legs
         left join public.operational_leg_backfill_links links on links.leg_id = legs.leg_id
        order by legs.operational_date, legs.scheduled_time, legs.flight_number`
    )
  ).rows;
  assert.equal(legs.length, 8, `the runtime holds every resolved canonical leg (${legs.length})`);
  assert.equal(new Set(legs.map((leg) => leg.leg_key)).size, 8, 'one runtime row per business leg key');
  assert.deepEqual(
    legs.reduce((counts, leg) => ({ ...counts, [leg.source_type]: (counts[leg.source_type] ?? 0) + 1 }), {}),
    { daily_import: 2, operational_manual: 1, published_seasonal: 5 },
    'source types separate plan legs, daily imports and manual legs'
  );
  assert.equal(legs.filter((leg) => leg.legacy_record_id === null).length, 0, 'every backfilled leg keeps a lineage link');
  assert.equal(
    await count('public.operational_leg_backfill_links', 'run_id = $1', [first.runId]),
    8,
    'all eight lineage links belong to the backfill run'
  );

  const dailyLeg = legs.find((leg) => leg.flight_number === 'VN101');
  const dailyBatch = (
    await scalar(`select batch_id from public.daily_schedule_import_batches where committed_at is not null order by committed_at desc limit 1`)
  ).batch_id;
  const dailyStaging = await scalar(
    `select occurrence_key, source_row_number, counter_token, gate, stand
       from public.daily_schedule_import_batch_legs where canonical_record_id = $1`,
    [dailyLeg.legacy_record_id]
  );
  assert.deepEqual(
    pick(dailyLeg, ['source_type', 'source_batch_id', 'source_occurrence_key', 'source_row_number', 'published_version_id', 'source_season_id', 'source_draft_id', 'side']),
    {
      source_type: 'daily_import',
      source_batch_id: dailyBatch,
      source_occurrence_key: dailyStaging.occurrence_key,
      source_row_number: dailyStaging.source_row_number,
      published_version_id: null,
      source_season_id: null,
      source_draft_id: null,
      side: 'DEP',
    },
    'a daily leg keeps its batch, occurrence key and staging row and belongs to no season version'
  );
  assert.deepEqual(
    pick(dailyLeg, ['airline', 'flight_number', 'scheduled_time', 'route', 'pax', 'gate', 'stand', 'counter_token', 'flight_category', 'aircraft_type']),
    {
      airline: 'VN',
      flight_number: 'VN101',
      scheduled_time: '06:30:00',
      route: 'SGN',
      pax: 123,
      gate: 7,
      stand: '21A',
      counter_token: dailyStaging.counter_token,
      flight_category: 'J',
      aircraft_type: '321',
    },
    'the daily leg carries the committed operational resources'
  );
  assert.deepEqual(
    [dailyLeg.gate, dailyLeg.stand],
    [dailyStaging.gate, dailyStaging.stand],
    'the daily leg resources come from the winning daily import'
  );
  assert.equal(DATE(dailyLeg.operational_date), M0_FIXTURE.dailyDate, 'the daily leg lands on its operational date');
  assert.match(dailyLeg.legacy_record_id, /^DAILY_V2_/, 'the daily leg is linked to the legacy daily record it replaced');

  const planLeg = legs.find((leg) => leg.leg_key === LEG_KEY('A', '2026-10-25', 'JX', 'JX701'));
  assert.deepEqual(
    pick(planLeg, ['source_type', 'source_season_id', 'source_draft_id', 'published_version_id', 'pax', 'gate', 'stand', 'carousel', 'scheduled_time', 'raw_flight_number']),
    {
      source_type: 'published_seasonal',
      source_season_id: M0_FIXTURE.seasonW26,
      source_draft_id: pickupDraft.draft_id,
      published_version_id: w26Version.version_id,
      pax: 180,
      gate: 20,
      stand: '31',
      carousel: 4,
      scheduled_time: '10:00:00',
      raw_flight_number: '701',
    },
    'the plan leg points at its draft and baseline version and carries the overlaid values'
  );
  assert.equal(DATE(planLeg.operational_date), '2026-10-25', 'the plan leg lands on its operational date');
  assert.equal(planLeg.legacy_season_id, M0_FIXTURE.seasonW26, 'the plan leg keeps legacy lineage to its season');

  const shiftedLeg = legs.find((leg) => leg.leg_key === LEG_KEY('A', '2026-10-25', 'JX', 'JX703'));
  assert.deepEqual(
    pick(shiftedLeg, ['scheduled_time', 'pax', 'gate', 'stand', 'carousel', 'link_type']),
    { scheduled_time: '18:45:00', pax: 0, gate: null, stand: null, carousel: null, link_type: 'sameday' },
    'the shifted plan leg keeps the overlaid schedule and a real zero pax without inventing resources'
  );
  assert.equal(
    shiftedLeg.turnaround_id,
    turnaroundDraft.base_turnaround_id,
    'the runtime leg keeps the turnaround identity of the plan row'
  );
  assert.equal(DATE(shiftedLeg.pair_anchor_date), '2026-10-25', 'the runtime leg keeps the pair anchor date of the plan row');

  const manualLeg = legs.find((leg) => leg.source_type === 'operational_manual');
  assert.deepEqual(
    pick(manualLeg, ['airline', 'flight_number', 'side', 'flight_category', 'pax', 'gate', 'stand', 'route', 'source_batch_id', 'source_season_id', 'published_version_id', 'legacy_record_id']),
    {
      airline: 'VN',
      flight_number: 'VN555',
      side: 'DEP',
      flight_category: 'J',
      pax: 88,
      gate: 1,
      stand: '20A',
      route: 'SGN',
      source_batch_id: null,
      source_season_id: null,
      published_version_id: null,
      legacy_record_id: M0_FIXTURE.manualLegId,
    },
    'the manual leg stays a manual runtime row without a season version or batch'
  );

  // Canonical resolution parity: same business keys as the report store.
  const canonicalKeys = (await request(`select business_leg_key from reporting.canonical_flight_legs order by 1`)).rows.map((row) => row.business_leg_key);
  assert.deepEqual(
    legs.map((leg) => leg.leg_key).sort(),
    canonicalKeys,
    `runtime business keys equal the canonical report store (${canonicalKeys.length} keys)`
  );
  assert.equal(
    legs.filter((leg) => leg.flight_number === 'JX801').length,
    1,
    'the cross-season duplicate resolves to one runtime leg'
  );
  assert.equal(
    legs.filter((leg) => leg.flight_number === 'JX902').length,
    1,
    'the backfilled-record duplicate resolves to one runtime leg'
  );
  assert.equal(legs.filter((leg) => leg.flight_number === 'JX903').length, 0, 'the ambiguous business key is not duplicated in the runtime');
  assert.equal(legs.filter((leg) => ['VN102', 'VN103'].includes(leg.flight_number)).length, 0, 'superseded daily rows stay out of the runtime');
  assert.equal(
    legs.filter((leg) => leg.source_occurrence_key === 'W26|2026-10-26|DEP|VN|VN101|06:00').length,
    0,
    'the superseded VN101 occurrence is gone'
  );
  assert.equal(legs.find((leg) => leg.flight_number === 'JX801').pax, null, 'a missing plan pax stays NULL and is not coerced to zero');

  // --- Day authority -------------------------------------------------------
  const scope = await scalar(
    `select * from public.schedule_replacement_scopes where ops_date = $1::date`,
    [M0_FIXTURE.dailyDate]
  );
  const authority = (await request(`select * from public.operational_day_authority order by operational_date`)).rows;
  assert.equal(authority.length, 1, 'only the committed daily scope creates a day authority row');
  assert.deepEqual(
    pick(authority[0], ['authority_source', 'source_batch_id', 'leg_count', 'canonical_checksum', 'committed_by', 'authority_revision', 'reset_at']),
    {
      authority_source: 'daily_import',
      source_batch_id: scope.source_batch_id,
      leg_count: 2,
      canonical_checksum: scope.canonical_checksum,
      committed_by: writerId,
      authority_revision: 1,
      reset_at: null,
    },
    'the day authority copies the committed scope'
  );
  assert.equal(DATE(authority[0].operational_date), M0_FIXTURE.dailyDate, 'the authority row lands on the scope ops date');

  let authorityEvents = (await request(`select event_type, source_batch_id, leg_count, actor_user_id, reason from public.operational_day_authority_events order by created_at, event_type`)).rows;
  assert.deepEqual(
    authorityEvents.map((event) => pick(event, ['event_type', 'leg_count'])),
    [{ event_type: 'commit', leg_count: 2 }],
    'the backfill records one commit event for the committed daily scope'
  );
  assert.equal(authorityEvents[0].source_batch_id, scope.source_batch_id, 'the commit event carries the source batch');

  // --- Zero-leg + reset day, then replay ------------------------------------
  await request(
    `insert into public.schedule_replacement_scopes (
       season_id, ops_date, authority_source, source_batch_id, expected_leg_count,
       canonical_checksum, data_version, committed_by, committed_at, reset_at, reset_by, reset_reason)
     values ($1, '2026-11-01', 'daily', $3, 0, 'zero-leg-checksum', 4, $2, now(), now(), $2, 'ops reset: all flights cancelled')`,
    [M0_FIXTURE.seasonW26, writerId, dailyBatch]
  );

  await asWriter();
  const replay = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ])
  ).rows[0].result;
  await asAdmin();

  assert.deepEqual(
    pick(replay, ['versions']),
    { versions: 0 },
    `a replay rewrites the shadow copy without seeding another baseline (${JSON.stringify(replay)})`
  );
  assert.deepEqual(
    pick(replay.drafts, ['written', 'retired', 'removed']),
    { written: 11, retired: 0, removed: 0 },
    'an unchanged replay rewrites the same drafts and retires none'
  );
  assert.deepEqual(
    pick(replay.legs, ['written', 'updated', 'retired', 'quarantined']),
    { written: 0, updated: 0, retired: 0, quarantined: 1 },
    'an unchanged replay inserts, updates and retires no leg'
  );
  assert.equal(replay.authorityDays, 2, 'the replay writes the unchanged day plus the new zero-leg day');
  assert.equal(await count('public.seasonal_flight_drafts'), 11, 'a replay leaves the draft count unchanged');
  assert.equal(await count('public.operational_flight_legs'), 8, 'a replay leaves the operational runtime unchanged');
  assert.equal(await count('public.operational_leg_backfill_links'), 8, 'a replay leaves the lineage links unchanged');
  assert.equal(await count('public.seasonal_publish_versions'), 3, 'a replay does not seed a second baseline version');
  assert.equal(await count('public.seasonal_draft_events', `client_id = 'legacy-backfill'`), 2, 'a replay does not duplicate folded overlay events');
  assert.equal(await count('public.operational_leg_quarantine'), 1, 'a replay rebuilds the same single quarantine row instead of appending duplicates');

  const runs = (await request(`select * from public.seasonal_operational_backfill_runs order by started_at, run_id`)).rows;
  assert.equal(runs.length, 2, 'both runs are recorded in the ledger');
  assert.deepEqual(
    pick(runs[1], ['status', 'versions_seeded', 'legs_written', 'replayed_from_high_water']),
    { status: 'completed', versions_seeded: 0, legs_written: 0, replayed_from_high_water: Number(first.sourceHighWater) },
    'the replay run records that it started from the first high-water and wrote no new rows'
  );

  const authorityAfterReplay = (await request(`select * from public.operational_day_authority order by operational_date`)).rows;
  assert.equal(authorityAfterReplay.length, 2, 'the zero-leg day gets an authority row');
  assert.deepEqual(
    pick(authorityAfterReplay[0], ['leg_count', 'authority_revision', 'reset_at']),
    { leg_count: 2, authority_revision: 1, reset_at: null },
    'the unchanged daily day keeps its revision, so a replay is a no-op there'
  );
  assert.deepEqual(
    pick(authorityAfterReplay[1], ['leg_count', 'authority_revision', 'committed_by', 'reset_by', 'reset_reason']),
    {
      leg_count: 0,
      authority_revision: 1,
      committed_by: writerId,
      reset_by: writerId,
      reset_reason: 'ops reset: all flights cancelled',
    },
    'a zero-leg day with a reset is preserved instead of being treated as "no data"'
  );
  assert.equal(DATE(authorityAfterReplay[1].operational_date), '2026-11-01', 'the zero-leg authority row lands on its ops date');

  authorityEvents = (
    await request(`select event_type, leg_count, reason from public.operational_day_authority_events order by operational_date, event_type`)
  ).rows;
  assert.deepEqual(
    authorityEvents.map((event) => pick(event, ['event_type', 'leg_count', 'reason'])),
    [
      { event_type: 'commit', leg_count: 2, reason: null },
      { event_type: 'commit', leg_count: 0, reason: null },
      { event_type: 'reset', leg_count: 0, reason: 'ops reset: all flights cancelled' },
    ],
    `the audit trail keeps one event per distinct commit and reset (${JSON.stringify(authorityEvents)})`
  );

  // --- Pairing against the source: link and unlink --------------------------
  // The wiring pass must recompute the turnaround link, not only add it: the
  // source can remove a pairing between two legs that both stay active. The M0
  // fixture has no import-derived linked_record_id (its derived departure side
  // is dropped by the shared occurrence key), so this phase writes the legacy
  // pairing column the wiring reads, on the one active ARR/DEP pair of a date.
  const arrLegacy = await scalar(
    `select links.legacy_season_id, links.legacy_record_id, legs.leg_id
       from public.operational_flight_legs legs
       join public.operational_leg_backfill_links links on links.leg_id = legs.leg_id
      where legs.status = 'active' and legs.flight_number = 'JX703'
        and legs.operational_date = '2026-10-25'`
  );
  const depLegacy = await scalar(
    `select links.legacy_record_id, legs.leg_id
       from public.operational_flight_legs legs
       join public.operational_leg_backfill_links links on links.leg_id = legs.leg_id
      where legs.status = 'active' and legs.flight_number = 'VN555'`
  );
  assert.ok(arrLegacy && depLegacy, 'the fixture exposes one active ARR and one active DEP leg to pair');
  assert.equal(arrLegacy.leg_id === depLegacy.leg_id, false, 'the pairing targets two different legs');

  await request(
    `update public.season_flight_records set linked_record_id = $3, link_type = 'sameday', pair_anchor_date = '2026-10-25'
      where season_id = $1 and record_id = $2`,
    [arrLegacy.legacy_season_id, arrLegacy.legacy_record_id, depLegacy.legacy_record_id]
  );

  await asWriter();
  const linkRun = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ])
  ).rows[0].result;
  await asAdmin();

  const legAfterLink = await scalar(
    `select linked_leg_id, link_type, pair_anchor_date from public.operational_flight_legs where leg_id = $1`,
    [arrLegacy.leg_id]
  );
  assert.deepEqual(
    pick(legAfterLink, ['linked_leg_id', 'link_type']),
    { linked_leg_id: depLegacy.leg_id, link_type: 'sameday' },
    `a pairing created in the source materializes in the runtime (${JSON.stringify(linkRun.legs)})`
  );
  assert.equal(linkRun.legs.written, 0, 'pairing an existing leg writes no new leg');

  await request(
    `update public.season_flight_records set linked_record_id = null, link_type = null, pair_anchor_date = null
      where season_id = $1 and record_id = $2`,
    [arrLegacy.legacy_season_id, arrLegacy.legacy_record_id]
  );

  await asWriter();
  const unlink = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ])
  ).rows[0].result;
  await asAdmin();

  const legAfterUnlink = await scalar(
    `select linked_leg_id, link_type, pair_anchor_date from public.operational_flight_legs where leg_id = $1`,
    [arrLegacy.leg_id]
  );
  assert.deepEqual(
    pick(legAfterUnlink, ['linked_leg_id', 'link_type', 'pair_anchor_date']),
    { linked_leg_id: null, link_type: null, pair_anchor_date: null },
    `unlinking two still-active legs follows the source instead of keeping the stale runtime pairing (${JSON.stringify(unlink.legs)})`
  );
  assert.equal(unlink.legs.written, 0, 'unlinking a pairing writes no new leg');
  assert.equal(
    await count('public.operational_flight_legs', `leg_id = $1 and status = 'active'`, [depLegacy.leg_id]),
    1,
    'the former partner stays active after the pairing disappears'
  );

  // --- Catch-up replay: plan edit, plan deletion, daily replacement ---------
  // A replay must reconcile the shadow copy with the source in both directions:
  // rows whose source drifted follow it, rows whose source disappeared leave the
  // runtime. Replaying an unchanged source (above) cannot prove either.
  const shiftedLink = await scalar(`select legacy_record_id from public.operational_leg_backfill_links where leg_id = $1`, [shiftedLeg.leg_id]);
  const pickupLink = await scalar(`select legacy_record_id from public.operational_leg_backfill_links where leg_id = $1`, [planLeg.leg_id]);
  const snapshotChecksumBefore = (
    await scalar(`select checksum from public.seasonal_publish_snapshots where version_id = $1`, [w26Version.version_id])
  ).checksum;

  await asWriter();
  await request(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    M0_FIXTURE.seasonW26,
    JSON.stringify({ legId: pickupLink.legacy_record_id, action: 'modified', gate: 20, stand: '31', carousel: 4, pax: 210 }),
  ]);
  await request(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    M0_FIXTURE.seasonW26,
    JSON.stringify({ legId: shiftedLink.legacy_record_id, action: 'deleted' }),
  ]);
  await asAdmin();

  const thirdStage = await stageDailyImport(ctx, dailyPayload({
    requestId: '20000000-0000-4000-8000-0000000000b4',
    legs: DAILY_THIRD_LEGS.map((leg) => buildDailyLeg({ seasonCode: 'W26', requestIndex: 3, leg })),
    expectedDataVersion: 3,
    seasonCode: 'W26',
    seasonId: M0_FIXTURE.seasonW26,
  }));
  assert.equal(thirdStage.status, 'validated', `the replacing daily import stages against the current data version (${JSON.stringify(thirdStage)})`);
  await commitDailyImport(ctx, thirdStage, 3);

  await asWriter();
  const catchup = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ])
  ).rows[0].result;
  await asAdmin();

  assert.equal(catchup.legs.updated, 1, `the catch-up replay rewrites exactly the leg the plan edit touched (${JSON.stringify(catchup.legs)})`);
  assert.ok(catchup.legs.written >= 1, `the replacing daily day writes its own legs (${JSON.stringify(catchup.legs)})`);
  const retiredFlights = (
    await request(`select distinct flight_number from public.operational_flight_legs where status <> 'active' order by flight_number`)
  ).rows.map((row) => row.flight_number);
  assert.deepEqual(
    retiredFlights,
    ['JX703', 'VN101', 'VN201'],
    `the catch-up retires only the legs whose source disappeared: the deleted plan row and the replaced daily day (${JSON.stringify(retiredFlights)})`
  );

  const pickupAfter = await scalar(`select * from public.operational_flight_legs where leg_id = $1`, [planLeg.leg_id]);
  assert.equal(pickupAfter.pax, 210, 'the reconcile pass follows a post-snapshot overlay edit on an already linked leg');
  assert.equal(await count('public.operational_flight_legs'), await count('public.operational_leg_backfill_links'), 'every runtime leg still holds exactly one lineage link');

  const planDraftAfter = await scalar(`select pax, gate, stand, carousel from public.seasonal_flight_drafts where draft_id = $1`, [pickupDraft.draft_id]);
  assert.deepEqual(
    planDraftAfter,
    { pax: 210, gate: 20, stand: '31', carousel: 4 },
    'the draft follows the retargeted overlay'
  );
  const pickupEvents = (
    await request(`select before_state from public.seasonal_draft_events where target_id = $1 order by created_at, op_id`, [pickupDraft.draft_id])
  ).rows;
  assert.equal(pickupEvents.length, 2, 'a retargeted overlay appends a second event instead of overwriting the first');
  assert.equal(pickupEvents.at(-1).before_state.pax, 210, 'the newest folded event snapshots the retargeted state');

  const shiftedAfter = await scalar(
    `select status, deletion_reason, linked_leg_id from public.operational_flight_legs where leg_id = $1`,
    [shiftedLeg.leg_id]
  );
  assert.deepEqual(
    pick(shiftedAfter, ['status', 'deletion_reason', 'linked_leg_id']),
    { status: 'deleted', deletion_reason: 'backfill-source-removed', linked_leg_id: null },
    'a plan row deleted after the snapshot retires its leg instead of leaving it active next to the winner'
  );
  assert.equal(
    await count('public.operational_flight_legs', `status = 'active' and leg_key = $1`, [shiftedLeg.leg_key]),
    0,
    'the deleted plan key has no active runtime row left'
  );
  assert.equal(
    await count(
      'public.operational_flight_legs',
      `status = 'active' and linked_leg_id in (select leg_id from public.operational_flight_legs where status <> 'active')`
    ),
    0,
    'no active leg keeps a pairing with a retired partner'
  );
  assert.equal(
    await count('public.seasonal_flight_drafts', `draft_id = $1 and status = 'deleted' and deletion_reason <> 'legacy-source-removed'`, [turnaroundDraft.draft_id]),
    1,
    'the deleted plan row stays in the planning space as a deleted draft'
  );

  const vn101Key = LEG_KEY('D', '2026-10-26', 'VN', 'VN101');
  const activeDaily = (await request(`select * from public.operational_flight_legs where leg_key = $1 and status = 'active'`, [vn101Key])).rows;
  assert.equal(activeDaily.length, 1, `a replaced daily day keeps exactly one active VN101 leg (${activeDaily.length})`);
  assert.deepEqual(
    pick(activeDaily[0], ['scheduled_time', 'pax', 'gate', 'stand', 'source_occurrence_key', 'source_batch_id']),
    {
      scheduled_time: '08:00:00',
      pax: 150,
      gate: 8,
      stand: '22A',
      source_occurrence_key: 'W26|2026-10-26|DEP|VN|VN101|SGN|08:00',
      source_batch_id: thirdStage.batchId,
    },
    'the active daily leg carries the replacing batch, occurrence key and resources'
  );
  assert.equal(
    await count('public.operational_flight_legs', `status = 'active' and source_occurrence_key like 'W26|2026-10-26|DEP|VN|VN101|SGN|06:%'`),
    0,
    'the superseded daily occurrence leaves the active runtime'
  );
  assert.equal(await count('public.operational_flight_legs', `status = 'active' and leg_key = $1`, [vn101Key]), 1, 'the replaced key never doubles up');

  const authorityAfterCatchup = await scalar(`select * from public.operational_day_authority where operational_date = $1::date`, [M0_FIXTURE.dailyDate]);
  assert.deepEqual(
    pick(authorityAfterCatchup, ['leg_count', 'authority_revision', 'source_batch_id']),
    { leg_count: 2, authority_revision: 2, source_batch_id: thirdStage.batchId },
    'the replacing batch bumps the day revision exactly once'
  );
  const replacedDayEvents = (
    await request(
      `select event_type, source_batch_id from public.operational_day_authority_events where operational_date = $1::date order by created_at, event_type`,
      [M0_FIXTURE.dailyDate]
    )
  ).rows;
  assert.deepEqual(
    replacedDayEvents.map((event) => [event.event_type, event.source_batch_id]),
    [['commit', scope.source_batch_id], ['commit', thirdStage.batchId]],
    'the day audit keeps one commit event per replacing batch'
  );
  assert.equal(
    (await scalar(`select checksum from public.seasonal_publish_snapshots where version_id = $1`, [w26Version.version_id])).checksum,
    snapshotChecksumBefore,
    'a published baseline snapshot stays immutable while drafts move on'
  );

  // --- Source removal: a plan row that vanishes from the legacy table --------
  const victimDraft = await scalar(
    `select draft_id from public.seasonal_flight_drafts where season_id = $1 and flight_number = 'JX902'`,
    [M0_FIXTURE.seasonM26]
  );
  await request(`delete from public.season_flight_records where season_id = $1 and record_id = 'BACKFILL-M0-902'`, [M0_FIXTURE.seasonM26]);

  await asWriter();
  const removal = (
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ])
  ).rows[0].result;
  await asAdmin();

  assert.deepEqual(
    pick(removal.drafts, ['retired', 'removed']),
    { retired: 0, removed: 1 },
    `a plan row that no longer exists in the legacy table leaves the shadow copy (${JSON.stringify(removal.drafts)})`
  );
  assert.equal(await count('public.seasonal_flight_drafts', `draft_id = $1`, [victimDraft.draft_id]), 0, 'the orphan draft is removed, not kept as a stale plan row');
  assert.deepEqual(
    pick(removal.legs, ['written', 'updated', 'retired']),
    { written: 0, updated: 0, retired: 0 },
    'a removed duplicate source row leaves the surviving runtime leg untouched'
  );
  assert.equal(
    await count('public.operational_flight_legs', `status = 'active' and flight_number = 'JX902'`),
    1,
    'the surviving source row keeps the runtime leg alive'
  );

  // --- Access control ------------------------------------------------------
  const recordedLinks = await count('public.operational_leg_backfill_links');
  await request(`insert into auth.users(id,email) values ($1, 'm2-non-operator@example.test')`, [nonOperatorId]);
  await request(
    `insert into public.app_operators(user_id,email,username,display_name) values ($1, 'm2-non-operator@example.test', 'm2non', 'M2 non-operator')`,
    [nonOperatorId]
  );
  await db.exec('set role authenticated');
  await request(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [nonOperatorId]);
  assert.equal(await count('public.seasonal_operational_backfill_runs'), 0, 'a non-operator cannot read the backfill ledger');
  assert.equal(await count('public.operational_leg_backfill_links'), 0, 'a non-operator cannot read the runtime lineage');
  assert.equal(await count('public.operational_leg_quarantine'), 0, 'a non-operator cannot read the quarantine ledger');
  await request(`select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [writerId]);
  assert.equal(await count('public.seasonal_operational_backfill_runs'), 6, 'an operator with seasonal.read sees every run');
  assert.equal(
    await count('public.operational_leg_backfill_links'),
    recordedLinks,
    `an operator with seasonal.read sees the lineage links (${recordedLinks})`
  );
  await asAdmin();

  // --- Rollback guard ------------------------------------------------------
  const rollbackSql = await readFile(ROLLBACK_URL, 'utf8');
  await assert.rejects(
    () => db.exec(rollbackSql),
    (error) => {
      assert.match(
        String(error.message),
        /seasonal_operational_backfill_runs=6/,
        `the rollback refusal names the recorded runs (${error.message})`
      );
      return true;
    },
    'the M2 rollback refuses while backfill runs are recorded'
  );
  await db.exec('rollback');

  // --- Regression: Deterministic lifecycle source selection ----------------
  // Isolated rollback-contained suite testing duplicate seasonal_draft_id_v1 groups.
  // Proves that:
  //   1. Duplicate identity with exactly one base active row and one deleted predecessor
  //      selects the active source, folds its overlay (pax, schedule, counters, checkin windows),
  //      nullifies supersedes_draft_id when pointing to the same draft identity,
  //      preserves original legacy rows, and replays idempotently.
  //   2. Unique active whose overlay deletes it marks the draft deleted without resurrecting
  //      the deleted predecessor.
  //   3. Multiple base active rows sharing draft identity fail with SQLSTATE 22023.
  //   4. Multiple terminal rows without an active row sharing draft identity fail with SQLSTATE 22023.
  //   5. Singleton terminal source remains preserved as a deleted draft.
  await db.exec('begin');
  try {
    const seasonId = M0_FIXTURE.seasonW26;

    // Case 1: Active + deleted predecessor sharing draft identity
    const draftId990 = (
      await scalar(
        `select public.seasonal_draft_id_v1($1, 'A', '2026-11-20'::date, 'VN', 'VN990') as id`,
        [seasonId]
      )
    ).id;

    // 1a. Predecessor row (deleted)
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         deletion_reason, stand, gate
       ) values (
         $1, 'REG-PRED-DEL-990', 'A', 'VN', 'VN990', '990', 'HAN', '07:00',
         '320', 'J', 100, '2026-11-20', '2026-11-20', '07:00', '2026-11-20',
         'W26', 5, 10, 'seasonal', 'ARR', 'deleted', 'deleted',
         'legacy_rebuild', '10', 5
       )`,
      [seasonId]
    );
    await request(
      `insert into public.season_flight_record_counters (record_id, counter_group, item_index, counter_value)
       values ('REG-PRED-DEL-990', '__single__', 0, 'DEL_C1')`
    );
    await request(
      `insert into public.season_flight_record_checkin_windows (record_id, counter_key, window_start, window_end)
       values ('REG-PRED-DEL-990', 'DEL_C1', '05:00', '06:30')`
    );

    // 1b. Base active row (supersedes predecessor with same draft identity)
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         supersedes_record_id, stand, gate
       ) values (
         $1, 'REG-BASE-ACT-990', 'A', 'VN', 'VN990', '990', 'SGN', '14:00',
         '350', 'J', 220, '2026-11-20', '2026-11-20', '14:00', '2026-11-20',
         'W26', 5, 20, 'seasonal', 'ARR', 'active', 'modified',
         'REG-PRED-DEL-990', '22', 8
       )`,
      [seasonId]
    );
    await request(
      `insert into public.season_flight_record_counters (record_id, counter_group, item_index, counter_value)
       values ('REG-BASE-ACT-990', '__single__', 0, 'BASE_C2')`
    );
    await request(
      `insert into public.season_flight_record_checkin_windows (record_id, counter_key, window_start, window_end)
       values ('REG-BASE-ACT-990', 'BASE_C2', '12:00', '13:30')`
    );

    // 1c. Overlay on the base active row modifying schedule, pax, counters, windows
    await request(
      `insert into public.season_modifications (
         season_id, leg_id, action, changed_fields, schedule, pax
       ) values (
         $1, 'REG-BASE-ACT-990', 'modified',
         array['pax', 'schedule', 'counter', 'checkInCounterWindows'],
         '14:30', 250
       )`,
      [seasonId]
    );
    await request(
      `insert into public.season_modification_counters (leg_id, counter_group, item_index, counter_value)
       values ('REG-BASE-ACT-990', '__single__', 0, 'OV_C3')`
    );
    await request(
      `insert into public.season_modification_checkin_windows (leg_id, counter_key, window_start, window_end)
       values ('REG-BASE-ACT-990', 'OV_C3', '12:30', '14:00')`
    );

    // Case 2: Unique active whose overlay deletes it must not resurrect deleted predecessor
    const draftId991 = (
      await scalar(
        `select public.seasonal_draft_id_v1($1, 'A', '2026-11-21'::date, 'VN', 'VN991') as id`,
        [seasonId]
      )
    ).id;

    // 2a. Predecessor row (deleted)
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         deletion_reason
       ) values (
         $1, 'REG-PRED-DEL-991', 'A', 'VN', 'VN991', '991', 'DAD', '06:00',
         '320', 'J', 80, '2026-11-21', '2026-11-21', '06:00', '2026-11-21',
         'W26', 6, 11, 'seasonal', 'ARR', 'deleted', 'deleted',
         'predecessor_archived'
       )`,
      [seasonId]
    );

    // 2b. Base active row (with route CXR, pax 160)
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         supersedes_record_id
       ) values (
         $1, 'REG-BASE-ACT-991', 'A', 'VN', 'VN991', '991', 'CXR', '16:00',
         '321', 'J', 160, '2026-11-21', '2026-11-21', '16:00', '2026-11-21',
         'W26', 6, 21, 'seasonal', 'ARR', 'active', 'added',
         'REG-PRED-DEL-991'
       )`,
      [seasonId]
    );

    // 2c. Overlay deleting the active row
    await request(
      `insert into public.season_modifications (
         season_id, leg_id, action, changed_fields
       ) values (
         $1, 'REG-BASE-ACT-991', 'deleted', array[]::text[]
       )`,
      [seasonId]
    );

    // Case 5: Singleton terminal preserved
    const draftId994 = (
      await scalar(
        `select public.seasonal_draft_id_v1($1, 'A', '2026-11-24'::date, 'VN', 'VN994') as id`,
        [seasonId]
      )
    ).id;
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         deletion_reason
       ) values (
         $1, 'REG-SINGLE-TERM-994', 'A', 'VN', 'VN994', '994', 'PQC', '11:00',
         '321', 'J', 90, '2026-11-24', '2026-11-24', '11:00', '2026-11-24',
         'W26', 2, 14, 'seasonal', 'ARR', 'deleted', 'deleted',
         'cancelled_before_season'
       )`,
      [seasonId]
    );

    // Run backfill to verify Case 1, Case 2, and Case 5
    await asWriter();
    await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
      '2026-10-01',
      writerId,
      Number(first.sourceHighWater),
    ]);
    await asAdmin();

    // Assertions for Case 1: active row chosen, overlay folded, self-supersedes prevented
    const draft990 = await scalar(`select * from public.seasonal_flight_drafts where draft_id = $1`, [draftId990]);
    assert.ok(draft990, 'draft was written for the active + deleted predecessor duplicate identity');
    assert.equal(draft990.status, 'active', 'active source status chosen over deleted predecessor');
    assert.equal(draft990.route, 'SGN', 'route SGN chosen from active row, not HAN from deleted predecessor');
    assert.equal(draft990.aircraft, '350', 'aircraft 350 chosen from active row, not 320 from predecessor');
    assert.equal(draft990.schedule, '14:30', 'overlay schedule 14:30 folded, not predecessor schedule');
    assert.equal(draft990.pax, 250, 'overlay pax 250 folded, not predecessor pax');
    assert.equal(draft990.supersedes_draft_id, null, 'self-supersedes prevented when predecessor has same draft identity');
    assert.deepEqual(
      draft990.counters,
      [{ counter_group: '__single__', item_index: 0, counter_value: 'OV_C3' }],
      'active overlay counters folded, not predecessor counters'
    );
    assert.deepEqual(
      draft990.checkin_windows,
      [{ counter_key: 'OV_C3', window_start: '12:30', window_end: '14:00' }],
      'active overlay checkin windows folded, not predecessor windows'
    );

    // Verify legacy source rows preserved in season_flight_records
    const legacyDel = await scalar(
      `select record_id, status, action, route from public.season_flight_records where record_id = 'REG-PRED-DEL-990'`
    );
    assert.deepEqual(
      pick(legacyDel, ['record_id', 'status', 'action', 'route']),
      { record_id: 'REG-PRED-DEL-990', status: 'deleted', action: 'deleted', route: 'HAN' },
      'legacy deleted predecessor row remains preserved'
    );
    const legacyAct = await scalar(
      `select record_id, status, action, route from public.season_flight_records where record_id = 'REG-BASE-ACT-990'`
    );
    assert.deepEqual(
      pick(legacyAct, ['record_id', 'status', 'action', 'route']),
      { record_id: 'REG-BASE-ACT-990', status: 'active', action: 'modified', route: 'SGN' },
      'legacy active source row remains preserved'
    );

    // Assertions for Case 2: overlay deletion of unique active does not resurrect predecessor
    const draft991 = await scalar(`select * from public.seasonal_flight_drafts where draft_id = $1`, [draftId991]);
    assert.ok(draft991, 'draft was written for the overlay-deleted active group');
    assert.equal(draft991.status, 'deleted', 'status is deleted per overlay action');
    assert.equal(draft991.action, 'deleted', 'action is deleted per overlay action');
    assert.equal(draft991.route, 'CXR', 'route CXR retained from active source, not DAD from predecessor');
    assert.equal(draft991.pax, 160, 'pax 160 retained from active source, not 80 from predecessor');
    assert.equal(draft991.supersedes_draft_id, null, 'self-supersedes prevented');

    // Assertions for Case 5: singleton terminal preserved
    const draft994 = await scalar(`select * from public.seasonal_flight_drafts where draft_id = $1`, [draftId994]);
    assert.ok(draft994, 'singleton terminal draft was created');
    assert.equal(draft994.status, 'deleted', 'singleton terminal status preserved as deleted');
    assert.equal(draft994.route, 'PQC', 'singleton terminal route preserved');

    // Replay the Planning helpers inside this rollback-contained transaction.
    // Full orchestrator replay across committed requests is covered above.
    await request(`select public.backfill_seasonal_flight_drafts_v1($1::uuid)`, [first.runId]);
    await request(`select public.backfill_seasonal_draft_allocations_v1()`);

    const draft990Replay = await scalar(`select * from public.seasonal_flight_drafts where draft_id = $1`, [draftId990]);
    assert.equal(draft990Replay.status, 'active', 'idempotent replay preserves active status');
    assert.equal(draft990Replay.route, 'SGN', 'idempotent replay preserves route');
    assert.equal(draft990Replay.pax, 250, 'idempotent replay preserves pax');
    assert.deepEqual(draft990Replay.counters, draft990.counters, 'idempotent replay preserves counters');
    assert.deepEqual(draft990Replay.checkin_windows, draft990.checkin_windows, 'idempotent replay preserves checkin windows');

    // Case 3: Ambiguous duplicate identities rejected with meaningful SQL error
    // 3a. Multiple base active rows
    await db.exec('savepoint sp_ambiguous_active');
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action
       ) values
         ($1, 'REG-AMB-ACT-1', 'A', 'VN', 'VN992', '992', 'SGN', '08:00', '321', 'J', 100, '2026-11-22', '2026-11-22', '08:00', '2026-11-22', 'W26', 7, 31, 'seasonal', 'ARR', 'active', 'added'),
         ($1, 'REG-AMB-ACT-2', 'A', 'VN', 'VN992', '992', 'HAN', '09:00', '321', 'J', 120, '2026-11-22', '2026-11-22', '09:00', '2026-11-22', 'W26', 7, 32, 'seasonal', 'ARR', 'active', 'added')`,
      [seasonId]
    );
    await assert.rejects(
      async () => {
        await asWriter();
        await request(`select public.run_seasonal_operational_backfill_v1($1::date, $2::uuid, $3::bigint) as result`, [
          '2026-10-01',
          writerId,
          Number(first.sourceHighWater),
        ]);
      },
      (error) => {
        assert.equal(error.code, '22023', `rejects with SQLSTATE 22023 (${error.code})`);
        assert.match(
          String(error.message),
          /Ambiguous seasonal flight draft.*multiple base active/i,
          `identifies multiple base active rows (${error.message})`
        );
        return true;
      },
      'ambiguous multiple base active legacy rows sharing draft identity is rejected'
    );
    await db.exec('rollback to savepoint sp_ambiguous_active');

    // 3b. All-terminal duplicates resolve to the most recent lifecycle change
    await db.exec('savepoint sp_ambiguous_terminal');
    await request(
      `insert into public.season_flight_records (
         season_id, record_id, type, airline, flight_number, raw_flight_number, route, schedule,
         aircraft, category, pax, date, scheduled_date, scheduled_time, operational_date,
         iata_season_code, day_of_week, source_row_index, source_kind, source_side, status, action,
         deletion_reason, lifecycle_changed_at
       ) values
         ($1, 'REG-AMB-TERM-2', 'A', 'VN', 'VN993', '993', 'HAN', '11:00', '321', 'J', 120, '2026-11-23', '2026-11-23', '11:00', '2026-11-23', 'W26', 1, 42, 'seasonal', 'ARR', 'deleted', 'deleted', 'seasonal_rebuild', '2026-09-20T12:08:15Z'),
         ($1, 'REG-AMB-TERM-1', 'A', 'VN', 'VN993', '993', 'SGN', '10:00', '321', 'J', 100, '2026-11-23', '2026-11-23', '10:00', '2026-11-23', 'W26', 1, 41, 'seasonal', 'ARR', 'deleted', 'deleted', 'overlay_deleted', '2026-10-02T15:52:35Z')`,
      [seasonId]
    );
    // Both planning helpers carry the source selection; the full orchestrator
    // cannot run twice inside this transaction (its temp tables persist).
    await request(`select public.backfill_seasonal_flight_drafts_v1($1::uuid)`, [first.runId]);
    await request(`select public.backfill_seasonal_draft_allocations_v1()`);
    const terminalDraft = await scalar(
      `select status, route, deletion_reason, source_row_index from public.seasonal_flight_drafts
        where draft_id = public.seasonal_draft_id_v1($1, 'A', date '2026-11-23', 'VN', 'VN993')`,
      [seasonId]
    );
    assert.deepEqual(
      terminalDraft,
      { status: 'deleted', route: 'SGN', deletion_reason: 'overlay_deleted', source_row_index: 41 },
      'all-terminal duplicate identity resolves to the latest lifecycle change instead of failing'
    );
    await db.exec('rollback to savepoint sp_ambiguous_terminal');
  } finally {
    await db.exec('rollback');
  }


  console.log(
    'M2 backfill contract holds: drafts mirror the plan, baseline versions are planning-only, the runtime matches the canonical resolution, a replay is idempotent under an unchanged source and reconciles edits, deletions and daily replacements under a changed one.'
  );
} finally {
  await ctx.close();
}
