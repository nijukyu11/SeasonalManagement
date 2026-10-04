// M1 schema contract test: Seasonal / Operational separation (additive tables).
//
// Proves on a fixture PGlite database that
//   * the migration is applied by the chain and is re-runnable,
//   * the planning / operational / day-authority / versioning tables enforce the
//     invariants the later milestones rely on (stable leg key, lineage, one
//     active leg per draft, zero-flight authority days, version tag format,
//     diff state shapes),
//   * RLS hides the new tables from operators without the matching permission,
//   * the rollback refuses to run while rows exist and cleans up completely.
//
// Run: node supabase/tests/seasonal_operational_separation_m1_schema_pglite.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSeasonalOperationalSeparationDb } from './seasonal_operational_separation_test_support.mjs';
import { M0_FIXTURE, seedM0OperatorsAndSeasons } from './seasonal_operational_separation_fixture.mjs';

const MIGRATION_NAME = '20260928120000_seasonal_operational_separation_schema.sql';
const ROLLBACK_NAME = '20260928120000_seasonal_operational_separation_schema.rollback.sql';
const MIGRATION_URL = new URL(`../migrations/${MIGRATION_NAME}`, import.meta.url);
const ROLLBACK_URL = new URL(`../migrations/${ROLLBACK_NAME}`, import.meta.url);
// Later milestones depend on M1. Remove M6 -> M5 -> M4 while empty, then the rollback
// scenarios below can still exercise M2 -> M1 without dropping child data.
const M2_MIGRATION_NAME = '20260928130000_seasonal_operational_backfill_v1.sql';
const M2_MIGRATION_URL = new URL(`../migrations/${M2_MIGRATION_NAME}`, import.meta.url);
const M2_ROLLBACK_URL = new URL(`../migrations/${M2_MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const NEW_TABLES = [
  'seasonal_flight_drafts',
  'seasonal_draft_events',
  'operational_flight_legs',
  'operational_leg_quarantine',
  'operational_day_authority',
  'operational_day_authority_events',
  'seasonal_publish_versions',
  'seasonal_publish_snapshots',
  'seasonal_publish_diff_entries',
];

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

const run = (db, sql, params = []) => db.query(sql, params);

async function expectError(db, sql, params, code, message) {
  await assert.rejects(
    () => db.query(sql, params),
    (error) => {
      const actual = error?.code ?? error?.cause?.code;
      assert.equal(actual, code, `${message} (expected SQLSTATE ${code}, got ${actual}: ${error.message})`);
      return true;
    },
    message
  );
}

const LEG_KEY = (side, date, airline, flightNumber) => `${side}\u001f${date}\u001f${airline}\u001f${flightNumber}`;

const { db, applied } = await createSeasonalOperationalSeparationDb();
const writerId = M0_FIXTURE.writerId;
const seasonId = M0_FIXTURE.seasonW26;
let nonOperatorId = null;
let versionId = null;
let batchId = null;
let dailyLegId = null;

try {
  assert.ok(
    applied.includes(MIGRATION_NAME),
    `the migration chain applies ${MIGRATION_NAME} (applied tail: ${applied.slice(-3).join(', ')})`
  );
  await db.exec(await readFile(new URL('../migrations/20260929120000_seasonal_operational_reader_cutover_v1.rollback.sql',import.meta.url),'utf8'));
  for (const name of ['20260928210000_seasonal_publish_v1.rollback.sql','20260928200000_seasonal_draft_import_v1.rollback.sql','20260928190000_seasonal_planning_v1.rollback.sql','20260928180000_operational_daily_import_v2.rollback.sql','20260928170000_operational_mutations_v1.rollback.sql','20260928160000_operational_window_v1.rollback.sql']) {
    await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  }
  await seedM0OperatorsAndSeasons({ db });

  // --- Structure -----------------------------------------------------------
  const existing = (
    await run(
      db,
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[]) order by table_name`,
      [NEW_TABLES]
    )
  ).rows.map((row) => row.table_name);
  assert.deepEqual(existing, [...NEW_TABLES].sort(), 'M1 creates all eight tables');

  const legColumns = (
    await run(
      db,
      `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'operational_flight_legs'`
    )
  ).rows.reduce((acc, row) => ({ ...acc, [row.column_name]: row.data_type }), {});
  assert.equal(legColumns.operational_date, 'date', 'operational legs use a typed operational_date');
  assert.equal(legColumns.scheduled_time, 'time without time zone', 'operational legs use a typed scheduled_time');
  assert.equal(legColumns.authority_rank, 'smallint', 'authority_rank is a stored generated column');
  assert.equal(legColumns.source_occurrence_key, 'text', 'daily lineage keeps the staging occurrence key');

  const draftColumns = (
    await run(
      db,
      `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'seasonal_flight_drafts'`
    )
  ).rows.reduce((acc, row) => ({ ...acc, [row.column_name]: row.data_type }), {});
  assert.equal(draftColumns.date, 'text', 'drafts keep the text date contract used by export snapshot v2');
  assert.equal(draftColumns.schedule, 'text', 'drafts keep the text HH:mm schedule contract');

  // --- Version tag helper --------------------------------------------------
  const tags = (
    await run(
      db,
      `select public.seasonal_publish_version_tag('w26', date '2026-06-27') as first_tag,
              public.seasonal_publish_version_tag('W26', date '2026-06-27', 2) as second_tag,
              public.seasonal_publish_version_tag('s26', date '2026-04-15', 1) as third_tag`
    )
  ).rows[0];
  assert.equal(tags.first_tag, 'W26-27JUN26', 'season version tag follows [SEASON_CODE]-[DDMMMYY]');
  assert.equal(tags.second_tag, 'W26-27JUN26.2', 'second publish of the same day gets a .N suffix');
  assert.equal(tags.third_tag, 'S26-15APR26', 'season code is upper-cased and the day is zero-padded');

  // --- Publish versions ----------------------------------------------------
  versionId = (
    await run(
      db,
      `insert into public.seasonal_publish_versions(
         season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum, skipped_day_count)
       values ($1, 'W26', 'W26-27JUN26', $2, '2026-10-25', '2027-03-27', 'checksum-v1', 1)
       returning version_id`,
      [seasonId, writerId]
    )
  ).rows[0].version_id;
  assert.ok(versionId, 'a publish version row is inserted');

  await expectError(
    db,
    `insert into public.seasonal_publish_versions(
       season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
     values ($1, 'W26', 'W26-27JUN26', $2, '2026-10-25', '2027-03-27', 'checksum-v2')`,
    [seasonId, writerId],
    UNIQUE_VIOLATION,
    'a season cannot publish the same version tag twice'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_versions(
       season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
     values ($1, 'W26', 'W26-27JUN2026', $2, '2026-10-25', '2027-03-27', 'checksum-v3')`,
    [seasonId, writerId],
    CHECK_VIOLATION,
    'version tags must match the two-digit-year [SEASON]-[DDMMMYY] format'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_versions(
       season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
     values ($1, 'W26', 'W26-27JUN26.1', $2, '2027-03-27', '2026-10-25', 'checksum-v4')`,
    [seasonId, writerId],
    CHECK_VIOLATION,
    'a publish range must not run backwards'
  );

  // --- Planning drafts -----------------------------------------------------
  const draftId = 'DRF_TEST_1';
  await run(
    db,
    `insert into public.seasonal_flight_drafts(
       draft_id, season_id, type, airline, flight_number, raw_flight_number, route, schedule, aircraft, category,
       date, day_of_week, source_row_index, source_side, turnaround_id, source_kind)
     values ($1, $2, 'A', 'JX', 'JX701', '701', 'TPE', '10:00', '321', 'J', '2026-10-25', 7, 1, 'ARR', 'TRN_1', 'imported')`,
    [draftId, seasonId]
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, schedule, date)
     values ('DRF_TEST_BAD_TIME', $1, 'A', 'JX', '25:00', '2026-10-25')`,
    [seasonId],
    CHECK_VIOLATION,
    'draft schedule must be a valid HH:mm string'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date, status)
     values ('DRF_TEST_BAD_LIFECYCLE', $1, 'A', 'JX', '2026-10-25', 'deleted')`,
    [seasonId],
    CHECK_VIOLATION,
    'a deleted draft must carry action=deleted'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date, status, action, deletion_reason)
     values ('DRF_TEST_BAD_REASON', $1, 'A', 'JX', '2026-10-25', 'deleted', 'deleted', '   ')`,
    [seasonId],
    CHECK_VIOLATION,
    'a deleted draft must explain itself'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date, source_kind)
     values ('DRF_TEST_BAD_KIND', $1, 'A', 'JX', '2026-10-25', 'seasonal')`,
    [seasonId],
    CHECK_VIOLATION,
    'only imported/manual drafts exist: legacy seasonal rows map to imported in M2'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date, stand)
     values ('DRF_TEST_BAD_STAND', $1, 'A', 'JX', '2026-10-25', '0')`,
    [seasonId],
    CHECK_VIOLATION,
    'draft stand follows the shared stand format check'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date, linked_draft_id)
     values ('DRF_TEST_SELF_LINK', $1, 'A', 'JX', '2026-10-25', 'DRF_TEST_SELF_LINK')`,
    [seasonId],
    CHECK_VIOLATION,
    'a draft cannot be its own turnaround pair'
  );
  await expectError(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date)
     values ('DRF_TEST_NO_SEASON', 'season-does-not-exist', 'A', 'JX', '2026-10-25')`,
    [],
    FK_VIOLATION,
    'drafts belong to an existing season'
  );

  await run(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, flight_number, date)
     values ('DRF_TEST_2', $1, 'A', 'JX', 'JX702', '2026-10-25'),
            ('DRF_TEST_KEY_MISMATCH', $1, 'A', 'JX', 'JX701', '2026-10-25')`,
    [seasonId]
  );
  await run(
    db,
    `insert into public.seasonal_draft_events(season_id, client_id, op_id, actor_user_id, server_seq, target_id, changed_fields, before_state, after_state)
     values ($1, 'client-m1', 'op-1', $2, 1, $3, '{schedule}', '{"schedule":"10:00"}', '{"schedule":"10:30"}')`,
    [seasonId, writerId, draftId]
  );
  await expectError(
    db,
    `insert into public.seasonal_draft_events(season_id, client_id, op_id, actor_user_id, server_seq, target_id)
     values ($1, 'client-m1', 'op-1', $2, 2, $3)`,
    [seasonId, writerId, draftId],
    UNIQUE_VIOLATION,
    'a client op id is only applied once per client'
  );

  // --- Operational legs ----------------------------------------------------
  const publishedLegKey = LEG_KEY('A', '2026-10-25', 'JX', 'JX701');
  const publishedLegId = (
    await run(
      db,
      `insert into public.operational_flight_legs(
         leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, raw_flight_number,
         route, aircraft_type, flight_category, pax, gate, stand, carousel, counter_token,
         source_type, source_season_id, source_draft_id, published_version_id)
       values ($1, '2026-10-25', '2026-10-25', '10:00', 'ARR', 'JX', 'JX701', '701',
               'TPE', '321', 'J', 180, 12, '12B', 1, '30,M1',
               'published_seasonal', $2, $3, $4)
       returning leg_id, authority_rank`,
      [publishedLegKey, seasonId, draftId, versionId]
    )
  ).rows[0];
  assert.equal(publishedLegId.authority_rank, 1, 'published seasonal legs rank below manual and daily legs');

  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_draft_id, published_version_id)
     values ('A\u001f2026-10-25\u001fJX\u001fJX701', '2026-10-26', '2026-10-26', '10:00', 'ARR', 'JX', 'JX701',
             'published_seasonal', $1, 'DRF_TEST_KEY_MISMATCH', $2)`,
    [seasonId, versionId],
    CHECK_VIOLATION,
    'the stored leg key must match the business identity expression'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_draft_id, published_version_id)
     values ($1, '2026-10-25', '2026-10-25', '10:00', 'ARR', 'JX', 'JX701', 'published_seasonal', $2, $3, $4)`,
    [publishedLegKey, seasonId, draftId, versionId],
    UNIQUE_VIOLATION,
    'a draft owns at most one active operational leg per season'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_draft_id)
     values ('A\u001f2026-10-25\u001fJX\u001fJX702', '2026-10-25', '2026-10-25', '11:00', 'ARR', 'JX', 'JX702',
             'published_seasonal', $1, 'DRF_TEST_2')`,
    [seasonId],
    CHECK_VIOLATION,
    'published seasonal legs always carry a published_version_id'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_batch_id, source_occurrence_key)
     values ('A\u001f2026-10-25\u001fJX\u001fJX703', '2026-10-25', '2026-10-25', '18:00', 'ARR', 'JX', 'JX703',
             'daily_import', null, null)`,
    [],
    CHECK_VIOLATION,
    'daily legs need the batch and staging occurrence key'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_batch_id, source_occurrence_key)
     values ('A\u001f2026-10-25\u001fJX\u001fJX703', '2026-10-25', '2026-10-25', '18:00', 'ARR', 'JX', 'JX703',
             'daily_import', $1, $2, 'occ-1')`,
    [seasonId, '00000000-0000-4000-8000-000000000001'],
    CHECK_VIOLATION,
    'daily legs must not smuggle a season id back in'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, source_type, status)
     values ('A\u001f2026-10-25\u001fJX\u001fJX704', '2026-10-25', '2026-10-25', '19:00', 'ARR', 'JX', 'JX704',
             'operational_manual', 'deleted')`,
    [],
    CHECK_VIOLATION,
    'a deleted operational leg must carry a deletion reason'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, source_type, gate)
     values ('A\u001f2026-10-25\u001fJX\u001fJX705', '2026-10-25', '2026-10-25', '20:00', 'ARR', 'JX', 'JX705',
             'operational_manual', 0)`,
    [],
    CHECK_VIOLATION,
    'gate 0 is not a resource'
  );

  await run(
    db,
    `insert into public.daily_schedule_import_batches(
       batch_id, request_id, contract_version, status, file_name, workbook_profile,
       raw_checksum, canonical_checksum, resource_policy_hash, preview, preview_hash, created_by)
     values ($1, '00000000-0000-4000-8000-000000000010', 1, 'validated', 'daily.xlsx', 'ams-daily-v1',
             'raw-1', 'canonical-1', 'policy-1', '{}'::jsonb, 'preview-1', $2)`,
    ['00000000-0000-4000-8000-000000000002', writerId]
  );
  batchId = '00000000-0000-4000-8000-000000000002';

  dailyLegId = (
    await run(
      db,
      `insert into public.operational_flight_legs(
         leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, raw_flight_number,
         route, aircraft_type, flight_category, pax, stand, gate, source_type, source_batch_id,
         source_occurrence_key, source_row_number)
       values ($1, '2026-10-26', '2026-10-26', '06:30', 'DEP', 'VN', 'VN101', '101',
               'SGN', '321', 'C', 123, '21A', 7, 'daily_import', $2, 'occ-vn101', 1)
       returning leg_id, authority_rank`,
      [LEG_KEY('D', '2026-10-26', 'VN', 'VN101'), batchId]
    )
  ).rows[0];
  assert.equal(dailyLegId.authority_rank, 3, 'daily import legs outrank every other source');

  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_batch_id, source_occurrence_key)
     values ($1, '2026-10-26', '2026-10-26', '06:30', 'DEP', 'VN', 'VN101', 'daily_import', $2, 'occ-vn101')`,
    [LEG_KEY('D', '2026-10-26', 'VN', 'VN101'), batchId],
    UNIQUE_VIOLATION,
    'a staged daily row owns at most one active operational leg'
  );

  const manualLegId = (
    await run(
      db,
      `insert into public.operational_flight_legs(
         leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, raw_flight_number,
         route, aircraft_type, flight_category, source_type)
       values ($1, '2026-10-25', '2026-10-25', '09:00', 'DEP', 'VN', 'VN555', '555', 'SGN', '321', 'C', 'operational_manual')
       returning leg_id, authority_rank`,
      [LEG_KEY('D', '2026-10-25', 'VN', 'VN555')]
    )
  ).rows[0];
  assert.equal(manualLegId.authority_rank, 2, 'manual legs sit between published seasonal and daily legs');

  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_draft_id, published_version_id)
     values ($1, '2026-10-26', '2026-10-26', '10:00', 'ARR', 'JX', 'JX701',
             'published_seasonal', $2, $3, $4)`,
    [LEG_KEY('A', '2026-10-26', 'JX', 'JX701'), seasonId, draftId, versionId],
    UNIQUE_VIOLATION,
    'a publish cannot leave two active legs for the same draft: the old one is retired first'
  );
  // Retiring the first leg frees the draft slot for the replacement row.
  await run(db, `update public.operational_flight_legs set status = 'deleted', deletion_reason = 'replaced' where leg_id = $1`, [
    publishedLegId.leg_id,
  ]);
  const replacement = (
    await run(
      db,
      `insert into public.operational_flight_legs(
         leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
         source_type, source_season_id, source_draft_id, published_version_id, linked_leg_id, link_type, pair_anchor_date)
       values ($1, '2026-10-25', '2026-10-25', '10:30', 'ARR', 'JX', 'JX701',
               'published_seasonal', $2, $3, $4, $5, 'sameday', '2026-10-25')
       returning leg_id`,
      [publishedLegKey, seasonId, draftId, versionId, manualLegId.leg_id]
    )
  ).rows[0].leg_id;
  assert.ok(replacement, 'the retired slot can be taken by the replacement leg');
  await expectError(
    db,
    `update public.operational_flight_legs set linked_leg_id = leg_id where leg_id = $1`,
    [replacement],
    CHECK_VIOLATION,
    'a turnaround pair cannot point at itself'
  );

  // --- Daily authority per operational date --------------------------------
  await run(
    db,
    `insert into public.operational_day_authority(
       operational_date, authority_source, source_batch_id, leg_count, canonical_checksum, committed_by)
     values ('2026-10-26', 'daily_import', $1, 0, 'checksum-zero-day', $2)`,
    [batchId, writerId]
  );
  const authority = (
    await run(db, `select leg_count, authority_revision, reset_at from public.operational_day_authority where operational_date = '2026-10-26'`)
  ).rows[0];
  assert.equal(authority.leg_count, 0, 'a zero-flight daily import still owns the day');
  assert.equal(authority.authority_revision, 1, 'the first commit starts at revision 1');
  assert.equal(authority.reset_at, null, 'a committed day starts unlocked');

  await expectError(
    db,
    `insert into public.operational_day_authority(
       operational_date, authority_source, source_batch_id, leg_count, canonical_checksum, committed_by)
     values ('2026-10-26', 'daily_import', $1, 3, 'checksum-again', $2)`,
    [batchId, writerId],
    UNIQUE_VIOLATION,
    'one operational day has exactly one authority row'
  );
  await expectError(
    db,
    `update public.operational_day_authority set reset_at = now() where operational_date = '2026-10-26'`,
    [],
    CHECK_VIOLATION,
    'a reset stamps the actor as well as the time'
  );
  await run(
    db,
    `update public.operational_day_authority
        set reset_at = now(), reset_by = $1, reset_reason = 'operator mistake', authority_revision = authority_revision + 1
      where operational_date = '2026-10-26'`,
    [writerId]
  );
  assert.equal(
    (await run(db, `select authority_revision from public.operational_day_authority where operational_date = '2026-10-26'`)).rows[0]
      .authority_revision,
    2,
    'a reset bumps the authority revision so stale previews are rejected'
  );

  await run(
    db,
    `insert into public.operational_day_authority_events(
       operational_date, event_type, source_batch_id, leg_count, canonical_checksum, authority_revision, actor_user_id)
     values ('2026-10-26', 'commit', $1, 0, 'checksum-zero-day', 1, $2)`,
    [batchId, writerId]
  );
  await expectError(
    db,
    `insert into public.operational_day_authority_events(operational_date, event_type, leg_count, actor_user_id)
     values ('2026-10-26', 'commit', 0, $1)`,
    [writerId],
    CHECK_VIOLATION,
    'a commit event must record the batch and the checksum'
  );
  await expectError(
    db,
    `insert into public.operational_day_authority_events(operational_date, event_type, actor_user_id)
     values ('2026-10-26', 'reset', $1)`,
    [writerId],
    CHECK_VIOLATION,
    'a reset event must record why the day was released'
  );

  // --- Snapshots and diff entries -----------------------------------------
  await run(
    db,
    `insert into public.seasonal_publish_snapshots(version_id, season_id, snapshot_payload, flight_count, checksum)
     values ($1, $2, '{"flights":[]}'::jsonb, 0, 'checksum-v1')`,
    [versionId, seasonId]
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_snapshots(version_id, season_id, snapshot_payload, checksum)
     values ($1, $2, '{"flights":[]}'::jsonb, 'checksum-v1-again')`,
    [versionId, seasonId],
    UNIQUE_VIOLATION,
    'a version has exactly one immutable snapshot'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_snapshots(version_id, season_id, snapshot_payload, checksum)
     values ($1, $2, '"not-an-object"'::jsonb, 'checksum-v5')`,
    [versionId, seasonId],
    CHECK_VIOLATION,
    'a snapshot payload is a JSON object'
  );

  const diffBase = {
    version_id: versionId,
    base_version_id: null,
    season_id: seasonId,
    flight_key: LEG_KEY('A', '2026-10-25', 'JX', 'JX701'),
    operational_date: '2026-10-25',
    side: 'ARR',
    airline: 'JX',
    flight_number: 'JX701',
  };
  await run(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, change_type, flight_key, source_draft_id, season_id, operational_date, side, airline, flight_number, after_state, changed_fields)
     values ($1, 'added', $2, $3, $4, $5, $6, $7, $8, '{"schedule":"10:00"}'::jsonb, '{schedule}')`,
    [diffBase.version_id, diffBase.flight_key, draftId, diffBase.season_id, diffBase.operational_date, diffBase.side, diffBase.airline, diffBase.flight_number]
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, change_type, flight_key, season_id, operational_date, side, airline, flight_number, before_state, after_state)
     values ($1, 'added', $2, $3, '2026-10-25', 'ARR', 'JX', 'JX701', '{}'::jsonb, '{}'::jsonb)`,
    [versionId, diffBase.flight_key, seasonId],
    CHECK_VIOLATION,
    'an added entry has no before state'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, change_type, flight_key, season_id, operational_date, side, airline, flight_number, before_state)
     values ($1, 'modified', $2, $3, '2026-10-25', 'ARR', 'JX', 'JX701', '{}'::jsonb)`,
    [versionId, diffBase.flight_key, seasonId],
    CHECK_VIOLATION,
    'a modified entry needs both states'
  );
  await run(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, change_type, flight_key, season_id, operational_date, side, airline, flight_number, before_state, changed_fields)
     values ($1, 'removed', 'A\u001f2026-10-25\u001fJX\u001fJX999', $2, '2026-10-25', 'ARR', 'JX', 'JX999', '{"schedule":"23:00"}'::jsonb, '{schedule}')`,
    [versionId, seasonId]
  );

  // --- Same-season ownership (lineage) -------------------------------------
  const foreignVersionId = (
    await run(
      db,
      `insert into public.seasonal_publish_versions(
         season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
       values ($1, 'M26', 'M26-01DEC26', $2, '2026-12-01', '2027-03-31', 'checksum-m26')
       returning version_id`,
      [M0_FIXTURE.seasonM26, writerId]
    )
  ).rows[0].version_id;

  await expectError(
    db,
    `insert into public.seasonal_publish_snapshots(version_id, season_id, snapshot_payload, checksum)
     values ($1, $2, '{"flights":[]}'::jsonb, 'checksum-cross-season')`,
    [foreignVersionId, seasonId],
    FK_VIOLATION,
    'a snapshot cannot describe a version owned by another season'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, base_version_id, season_id, change_type, flight_key, operational_date, side, airline, flight_number, before_state, after_state)
     values ($1, null, $2, 'added', $3, '2026-12-01', 'ARR', 'JX', 'JX801', null, '{}'::jsonb)`,
    [versionId, M0_FIXTURE.seasonM26, LEG_KEY('A', '2026-12-01', 'JX', 'JX801')],
    FK_VIOLATION,
    'a diff entry cannot claim a season that does not own its version'
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, base_version_id, season_id, change_type, flight_key, operational_date, side, airline, flight_number, before_state, after_state)
     values ($1, $2, $3, 'modified', $4, '2026-10-25', 'ARR', 'JX', 'JX701', '{}'::jsonb, '{}'::jsonb)`,
    [versionId, foreignVersionId, seasonId, LEG_KEY('A', '2026-10-25', 'JX', 'JX701')],
    FK_VIOLATION,
    'a diff entry cannot compare against a base version of another season'
  );
  await run(
    db,
    `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, flight_number, date)
     values ('DRF_M26_1', $1, 'A', 'JX', 'JX801', '2026-12-01')`,
    [M0_FIXTURE.seasonM26]
  );
  await expectError(
    db,
    `insert into public.seasonal_publish_diff_entries(
       version_id, change_type, flight_key, source_draft_id, season_id, operational_date, side, airline, flight_number, after_state)
     values ($1, 'added', $2, 'DRF_M26_1', $3, '2026-10-25', 'ARR', 'JX', 'JX701', '{}'::jsonb)`,
    [versionId, LEG_KEY('A', '2026-10-25', 'JX', 'JX701'), seasonId],
    FK_VIOLATION,
    'a diff entry cannot point at a draft owned by another season'
  );
  await expectError(
    db,
    `insert into public.operational_flight_legs(
       leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number,
       source_type, source_season_id, source_draft_id, published_version_id)
     values ($1, '2026-10-25', '2026-10-25', '08:00', 'ARR', 'JX', 'JX706',
             'published_seasonal', $2, 'DRF_M26_1', $3)`,
    [LEG_KEY('A', '2026-10-25', 'JX', 'JX706'), seasonId, versionId],
    FK_VIOLATION,
    'a published leg cannot borrow a draft of another season'
  );

  // --- RLS ------------------------------------------------------------------
  const rls = (
    await run(
      db,
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])`,
      [NEW_TABLES]
    )
  ).rows;
  assert.equal(rls.length, NEW_TABLES.length, 'every M1 table is visible to the catalog check');
  assert.equal(rls.every((row) => row.relrowsecurity), true, 'RLS is enabled on every M1 table');

  const grants = (
    await run(
      db,
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any($1::text[]) order by grantee, privilege_type`,
      [NEW_TABLES]
    )
  ).rows;
  const grantees = [...new Set(grants.map((row) => row.grantee))];
  assert.equal(grantees.includes('anon'), false, 'anon has no grant on the M1 tables');
  assert.deepEqual(
    grantees.filter((grantee) => grantee !== 'postgres'),
    ['authenticated'],
    'outside the owning role, only authenticated may read the M1 tables'
  );
  assert.equal(
    grants.filter((row) => row.grantee !== 'postgres').every((row) => row.privilege_type === 'SELECT'),
    true,
    'outside the owning role, writes stay inside security definer RPCs'
  );
  assert.equal(
    grants.some((row) => row.grantee === 'authenticated' && row.privilege_type !== 'SELECT'),
    false,
    'authenticated never receives INSERT/UPDATE/DELETE on the M1 tables'
  );

  nonOperatorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await run(db, `insert into auth.users(id, email) values ($1, 'm1-outsider@example.test')`, [nonOperatorId]);
  const asUser = async (userId) => {
    await db.exec('set role authenticated');
    await run(db, `select pg_catalog.set_config('request.jwt.claim.sub', $1, false)`, [userId]);
  };

  await asUser(writerId);
  const writerDrafts = (
    await run(db, `select count(*)::integer as count from public.seasonal_flight_drafts where draft_id = $1`, [draftId])
  ).rows[0].count;
  const writerLegs = (await run(db, `select count(*)::integer as count from public.operational_flight_legs`)).rows[0].count;
  assert.equal(writerDrafts, 1, 'an operator with seasonal.read sees the draft');
  assert.ok(writerLegs >= 3, 'an operator with daily.read sees operational legs');

  await asUser(nonOperatorId);
  assert.equal(
    (await run(db, `select count(*)::integer as count from public.seasonal_flight_drafts`)).rows[0].count,
    0,
    'RLS hides drafts from operators without seasonal.read'
  );
  assert.equal(
    (await run(db, `select count(*)::integer as count from public.operational_flight_legs`)).rows[0].count,
    0,
    'RLS hides operational legs from operators without daily.read'
  );
  assert.equal(
    (await run(db, `select count(*)::integer as count from public.operational_day_authority`)).rows[0].count,
    0,
    'RLS hides the day authority scope from operators without daily.read'
  );
  await db.exec('reset role');

  // --- Re-runnable migration and rollback ----------------------------------
  const migrationSql = await readFile(MIGRATION_URL, 'utf8');
  const rollbackSql = await readFile(ROLLBACK_URL, 'utf8');
  const m2MigrationSql = await readFile(M2_MIGRATION_URL, 'utf8');
  const m2RollbackSql = await readFile(M2_ROLLBACK_URL, 'utf8');
  const draftsBeforeReplay = (
    await run(db, `select count(*)::integer as count from public.seasonal_flight_drafts`)
  ).rows[0].count;
  await db.exec(migrationSql);
  assert.equal(
    (await run(db, `select count(*)::integer as count from public.seasonal_flight_drafts`)).rows[0].count,
    draftsBeforeReplay,
    're-running the migration is a no-op that keeps data'
  );

  await assert.rejects(
    () => db.exec(rollbackSql),
    /M1 rollback refused/,
    'the rollback refuses to drop tables that still hold rows'
  );
  // The refused rollback left its own transaction open and aborted: unwind it
  // before touching the fixture rows again.
  await db.exec('rollback');

  await run(db, `delete from public.operational_flight_legs`);
  await run(db, `delete from public.seasonal_publish_versions`);
  await run(db, `delete from public.seasonal_draft_events`);
  await run(db, `delete from public.seasonal_flight_drafts`);
  await run(db, `delete from public.operational_day_authority_events`);
  await run(db, `delete from public.operational_day_authority`);

  // Every table the rollback drops must be able to stop it on its own: leave a
  // single row behind, one table at a time, and require a refusal that names it.
  const guardRows = [
    {
      table: 'seasonal_flight_drafts',
      insert: `insert into public.seasonal_flight_drafts(draft_id, season_id, type, airline, date)
               values ('DRF_GUARD', $1, 'A', 'JX', '2026-11-01')`,
      params: [seasonId],
      cleanup: `delete from public.seasonal_flight_drafts where draft_id = 'DRF_GUARD'`,
    },
    {
      table: 'seasonal_draft_events',
      insert: `insert into public.seasonal_draft_events(season_id, client_id, op_id, server_seq, target_id)
               values ($1, 'client-guard', 'op-guard', 1, 'DRF_GUARD')`,
      params: [seasonId],
      cleanup: `delete from public.seasonal_draft_events where client_id = 'client-guard'`,
    },
    {
      table: 'operational_flight_legs',
      insert: `insert into public.operational_flight_legs(
                 leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, source_type)
               values ('D\u001f2026-11-01\u001fVN\u001fVN900', '2026-11-01', '2026-11-01', '09:00', 'DEP', 'VN', 'VN900', 'operational_manual')`,
      params: [],
      cleanup: `delete from public.operational_flight_legs where operational_date = '2026-11-01'`,
    },
    {
      // Zero-flight day: the authority row alone must still block the rollback.
      table: 'operational_day_authority',
      insert: `insert into public.operational_day_authority(
                 operational_date, authority_source, source_batch_id, leg_count, canonical_checksum, committed_by)
               values ('2026-11-01', 'daily_import', $1, 0, 'checksum-guard-zero', $2)`,
      params: [batchId, writerId],
      cleanup: `delete from public.operational_day_authority where operational_date = '2026-11-01'`,
    },
    {
      table: 'operational_day_authority_events',
      insert: `insert into public.operational_day_authority_events(operational_date, event_type, reason)
               values ('2026-11-01', 'reset', 'guard probe')`,
      params: [],
      cleanup: `delete from public.operational_day_authority_events where operational_date = '2026-11-01'`,
    },
    {
      table: 'seasonal_publish_versions',
      insert: `insert into public.seasonal_publish_versions(
                 season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
               values ($1, 'W26', 'W26-01NOV26', $2, '2026-11-01', '2026-11-01', 'checksum-guard')`,
      params: [seasonId, writerId],
      cleanup: `delete from public.seasonal_publish_versions where version_tag = 'W26-01NOV26'`,
    },
    {
      table: 'seasonal_publish_snapshots',
      prepare: `insert into public.seasonal_publish_versions(
                  season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
                values ($1, 'W26', 'W26-02NOV26', $2, '2026-11-01', '2026-11-01', 'checksum-guard-snapshot')`,
      prepareParams: [seasonId, writerId],
      insert: `insert into public.seasonal_publish_snapshots(version_id, season_id, snapshot_payload, checksum)
               values ((select version_id from public.seasonal_publish_versions where version_tag = 'W26-02NOV26'),
                       $1, '{"flights":[]}'::jsonb, 'checksum-guard-snapshot')`,
      params: [seasonId],
      cleanup: `delete from public.seasonal_publish_versions where version_tag = 'W26-02NOV26'`,
    },
    {
      table: 'seasonal_publish_diff_entries',
      prepare: `insert into public.seasonal_publish_versions(
                  season_id, season_code, version_tag, published_by, range_start, range_end, snapshot_checksum)
                values ($1, 'W26', 'W26-03NOV26', $2, '2026-11-01', '2026-11-01', 'checksum-guard-diff')`,
      prepareParams: [seasonId, writerId],
      insert: `insert into public.seasonal_publish_diff_entries(
                 version_id, change_type, flight_key, season_id, operational_date, side, airline, flight_number, after_state)
               values ((select version_id from public.seasonal_publish_versions where version_tag = 'W26-03NOV26'),
                       'added', 'A\u001f2026-11-01\u001fJX\u001fJX900', $1, '2026-11-01', 'ARR', 'JX', 'JX900', '{}'::jsonb)`,
      params: [seasonId],
      cleanup: `delete from public.seasonal_publish_versions where version_tag = 'W26-03NOV26'`,
    },
  ];

  for (const guard of guardRows) {
    if (guard.prepare) {
      await run(db, guard.prepare, guard.prepareParams);
    }
    await run(db, guard.insert, guard.params);
    await assert.rejects(
      () => db.exec(rollbackSql),
      (error) => {
        assert.match(
          String(error.message),
          new RegExp(`${guard.table}=1`),
          `the rollback refusal names ${guard.table} as populated`
        );
        return true;
      },
      `${guard.table} alone blocks the rollback`
    );
    await db.exec('rollback');
    await run(db, guard.cleanup, guard.cleanupParams ?? []);
  }

  await db.exec(m2RollbackSql);
  assert.equal(
    (await run(db, `select count(*)::integer as count from information_schema.tables
                      where table_schema = 'public' and table_name = any($1::text[])`, [
      ['seasonal_operational_backfill_runs', 'operational_leg_backfill_links'],
    ])).rows[0].count,
    0,
    'the M2 rollback removes its own tables before the M1 rollback runs'
  );

  await db.exec(rollbackSql);
  const afterRollback = (
    await run(
      db,
      `select count(*)::integer as count from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])`,
      [NEW_TABLES]
    )
  ).rows[0].count;
  assert.equal(afterRollback, 0, 'the rollback removes every M1 table');
  assert.equal(
    (await run(db, `select count(*)::integer as count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname = 'seasonal_publish_version_tag'`)).rows[0].count,
    0,
    'the rollback removes the version tag helper'
  );

  await db.exec(migrationSql);
  assert.equal(
    (await run(db, `select count(*)::integer as count from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])`, [
      NEW_TABLES,
    ])).rows[0].count,
    NEW_TABLES.length,
    'the migration can be re-applied after a rollback'
  );

  await db.exec(m2MigrationSql);
  assert.equal(
    (await run(db, `select count(*)::integer as count from information_schema.tables
                      where table_schema = 'public' and table_name = 'seasonal_operational_backfill_runs'`)).rows[0].count,
    1,
    'the M2 backfill migration re-applies on top of a re-applied M1'
  );

  console.log('M1 schema contract holds: tables, invariants, RLS, rollback guard.');
} finally {
  await db.close();
}
