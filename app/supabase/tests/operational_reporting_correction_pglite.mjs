// Behavioral test for native Pax correction, dirty marker capture,
// public_dashboard_daily_wake handling, and cutover candidate selection.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const M10_MIGRATION_NAME = '20260929120000_seasonal_operational_reader_cutover_v1.sql';
const M10_MIGRATION_URL = new URL(`../migrations/${M10_MIGRATION_NAME}`, import.meta.url);

const CORRECTION_MIGRATION_NAME = '20261008110000_operational_reporting_correction_v1.sql';
const CORRECTION_MIGRATION_URL = new URL(`../migrations/${CORRECTION_MIGRATION_NAME}`, import.meta.url);
const CORRECTION_ROLLBACK_URL = new URL(`../migrations/${CORRECTION_MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const ctx = await buildM0Fixture();
const { db, asAdmin, asWriter } = ctx;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;

try {
  await asAdmin();

  // Apply M10 first to ensure full cutover schema and functions exist
  await db.exec(await readFile(M10_MIGRATION_URL, 'utf8'));

  // --- 1. Test Rollback & Re-apply Cleanliness -----------------------------
  await db.exec(await readFile(CORRECTION_MIGRATION_URL, 'utf8'));
  await db.exec(await readFile(CORRECTION_ROLLBACK_URL, 'utf8'));

  const triggersAbsent = (
    await rows(`
      select not exists (
        select 1 from pg_trigger
        where tgname in ('capture_operational_pax_correction', 'operational_capture_zzz_pax_correction')
      ) as absent
    `)
  )[0].absent;
  assert.equal(triggersAbsent, true, 'Rollback must drop pax correction triggers');

  const legacyHelperAbsent = (
    await rows(`
      select not exists (
        select 1 from pg_proc where proname = 'legacy_select_public_dashboard_correction_candidate_v1'
      ) as absent
    `)
  )[0].absent;
  assert.equal(legacyHelperAbsent, true, 'Rollback must restore original definition and drop legacy helper');

  // Re-apply correction migration for functional tests
  await db.exec(await readFile(CORRECTION_MIGRATION_URL, 'utf8'));

  // Genuine fixture prerequisite: run backfill + refresh as existing M10 suite
  await asWriter();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);
  await asAdmin();
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');

  // --- 2. Gate OFF parity: Native writes must NOT pollute legacy markers ---
  const isCutoverInitially = (await rows('select reporting.is_operational_reader_cutover_active_v1() as active'))[0].active;
  assert.equal(isCutoverInitially, false, 'Initial state must be default gate OFF');

  const testLegId = '00000000-0000-4000-8000-000000000888';
  await db.query(`
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time,
      side, airline, flight_number, status, source_type, pax
    ) values (
      $1, 'A\x1f2026-08-15\x1fVN\x1fVN888', '2026-08-15', '2026-08-15', '10:00:00',
      'ARR', 'VN', 'VN888', 'active', 'operational_manual', 120
    ) on conflict (leg_id) do nothing
  `, [testLegId]);

  // Insert native event while gate is OFF
  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-08-15', array['pax'],
      jsonb_build_object('pax', null), jsonb_build_object('pax', 120)
    )
  `, [testLegId]);

  const markersWhileOff = await rows(`
    select * from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(markersWhileOff.length, 0, 'Gate OFF: native operational events must NOT pollute dirty markers');

  // --- 3. Cutover Activation & Native Generation Alignment -----------------
  // Bring projection up to date before cutover
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  await db.query("select reporting.cutover_operational_readers_v1('test-operator')");
  const isCutoverNow = (await rows('select reporting.is_operational_reader_cutover_active_v1() as active'))[0].active;
  assert.equal(isCutoverNow, true, 'Cutover must now be active');

  // --- 4. Regression: Head watermark HIGH vs Native seq LOW ----------------
  // Genuine scenario:
  // 1. Seed actual legacy high-water mark in season_change_events: server_seq = 63500.
  // 2. Prior publication exists at exact prior generation: legacy (63500) + revision (e.g. 10) = 63510.
  // 3. Native mutation naturally advances workspace revision from 10 to 11.
  // 4. Native change event has low server_seq = 5 (e.g. in test or separate sequence).
  // 5. Marker gets actual generation: 63500 + 11 = 63511.
  // 6. Prior head (63510) < marker (63511) -> candidate does NOT return 'already_current'!

  // 1. Seed actual legacy high-water mark in season_change_events using genuine schema & fixture season
  await db.query(`
    insert into public.season_change_events (
      season_id, client_id, op_id, server_seq, target_type, target_id, changed_fields, op_payload
    ) overriding system value values (
      $1, 'client-seed-high-water', 'op-seed-63500', 63500, 'record', 'seed-record-high-water', array['pax'], '{}'::jsonb
    )
  `, [M0_FIXTURE.seasonW26]);

  // Read genuine baseline operational revision without tampering
  const [revPriorRow] = await rows('select revision from public.operational_workspace_revision where singleton');
  const priorRevision = Number(revPriorRow.revision);
  const priorGeneration = 63500 + priorRevision;

  // 2. Insert ready publication at exact prior generation using real schema & constraints
  const [pubRow] = await rows(`
    insert into reporting.public_dashboard_publications (
      dashboard_key, year, business_date, status, idempotency_key,
      trigger_kind, reason, expected_source_watermark, source_watermark,
      source_data_version, data_as_of, row_count, due_legs, reported_legs,
      payload, payload_checksum, completed_at
    ) values (
      'annual-passenger-kpi', 2026, '2026-08-15', 'ready', 'test-prior-gen-idemp',
      'daily_acceptance', 'Prior generation head publication', $1, $1,
      1, statement_timestamp(), 10, 10, 10,
      '{"status":"ready"}'::jsonb, repeat('a', 64), statement_timestamp()
    ) returning id
  `, [priorGeneration]);

  await db.query(`
    insert into reporting.public_dashboard_publication_heads (
      dashboard_key, year, publication_id
    ) values (
      'annual-passenger-kpi', 2026, $1
    ) on conflict (dashboard_key, year) do update set publication_id = excluded.publication_id
  `, [pubRow.id]);
  // Native mutation updates leg and inserts change event
  await db.query(`
    update public.operational_flight_legs
    set pax = 150
    where leg_id = $1
  `, [testLegId]);

  // Insert native Pax correction event with low server_seq = 5
  const [nativeEvent] = await rows(`
    insert into public.operational_change_events (
      server_seq, target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      5, 'operationalLeg', $1, '2026-08-15', array['pax'],
      jsonb_build_object('pax', 120), jsonb_build_object('pax', 150)
    ) returning server_seq
  `, [testLegId]);
  assert.equal(Number(nativeEvent.server_seq), 5, 'Inserted native event has low server_seq = 5');

  // Compute expected generation from real max(legacy server_seq) + actual CURRENT operational workspace revision
  const [legacyMaxRow] = await rows('select coalesce(max(server_seq), 0)::bigint as max_seq from public.season_change_events');
  const [revCurrentRow] = await rows('select revision from public.operational_workspace_revision where singleton');
  const currentRevision = Number(revCurrentRow.revision);
  const legacyMax = Number(legacyMaxRow.max_seq);
  const expectedGeneration = legacyMax + currentRevision;

  const [markerHighVsLow] = await rows(`
    select * from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.ok(markerHighVsLow, 'Dirty marker must be created for year 2026');
  assert.equal(markerHighVsLow.status, 'dirty');
  assert.equal(
    Number(markerHighVsLow.latest_event_seq),
    expectedGeneration,
    `latest_event_seq must be exact actual generation (${expectedGeneration}) rather than native server_seq (5)`
  );
  assert.ok(
    expectedGeneration > priorGeneration,
    `expectedGeneration (${expectedGeneration}) must be > priorGeneration (${priorGeneration})`
  );
  assert.ok(
    Number(nativeEvent.server_seq) < priorGeneration,
    `native server_seq (${nativeEvent.server_seq}) must be < priorGeneration (${priorGeneration})`
  );
  // Candidate evaluation after quiet window:
  // Bring shadow projection to current revision
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  // With head_watermark = 63510 and marker latest_event_seq = 63511,
  // candidate must NOT return 'already_current'!
  const candidateAfterQuiet = (
    await rows("select reporting.select_public_dashboard_correction_candidate_v1(statement_timestamp() + interval '3 minutes') as candidate")
  )[0].candidate;

  assert.notEqual(
    candidateAfterQuiet.status,
    'already_current',
    'Unseen correction must NOT be marked already_current despite head_watermark (63510) being higher than native_seq (5)'
  );

  // --- 5. Unknown / NULL / 0 corrections count ------------------------------
  // Zero Pax correction updates marker
  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-08-18', array['pax'],
      jsonb_build_object('pax', 150), jsonb_build_object('pax', 0)
    )
  `, [testLegId]);

  const [zeroMarker] = await rows(`
    select *, affected_from_date::text as from_date_str, affected_to_date::text as to_date_str
    from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(zeroMarker.to_date_str, '2026-08-18', 'Zero Pax expands affected range');

  // NULL Pax correction updates marker
  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-08-10', array['pax'],
      jsonb_build_object('pax', 0), jsonb_build_object('pax', null)
    )
  `, [testLegId]);

  const [nullMarker] = await rows(`
    select *, affected_from_date::text as from_date_str, affected_to_date::text as to_date_str
    from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(nullMarker.from_date_str, '2026-08-10', 'NULL Pax expands from_date');

  // Non-Pax operational event does NOT modify dirty marker
  const prevSeq = nullMarker.latest_event_seq;
  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-08-20', array['gate'],
      jsonb_build_object('gate', 1), jsonb_build_object('gate', 2)
    )
  `, [testLegId]);

  const [unmodifiedMarker] = await rows(`
    select * from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(unmodifiedMarker.latest_event_seq, prevSeq, 'Non-pax event must not alter dirty marker');

  // --- 6. Moved Leg Across Business Years ----------------------------------
  // Leg moved from 2025-12-31 to 2026-01-01 with pax correction
  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-01-01', array['pax'],
      jsonb_build_object('operational_date', '2025-12-31', 'pax', 90),
      jsonb_build_object('operational_date', '2026-01-01', 'pax', 110)
    )
  `, [testLegId]);

  const [marker2025] = await rows(`
    select *, affected_from_date::text as from_date_str, affected_to_date::text as to_date_str
    from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2025
  `);
  assert.ok(marker2025, 'Dirty marker must be created for previous business year 2025');
  assert.equal(marker2025.from_date_str, '2025-12-31');

  const [marker2026] = await rows(`
    select * from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.ok(marker2026, 'Dirty marker exists for new business year 2026');

  console.log('operational_reporting_correction_pglite PASS');
} finally {
  // Teardown handled by in-memory PGlite
}
