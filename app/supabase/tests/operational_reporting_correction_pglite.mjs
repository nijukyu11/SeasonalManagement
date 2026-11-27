// Behavioral test for native Pax correction, dirty marker capture,
// public_dashboard_daily_wake handling, and cutover candidate selection.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
const CORRECTION_MIGRATION_NAME = '20261008110000_operational_reporting_correction_v1.sql';
const CORRECTION_MIGRATION_URL = new URL(`../migrations/${CORRECTION_MIGRATION_NAME}`, import.meta.url);
const CORRECTION_ROLLBACK_URL = new URL(`../migrations/${CORRECTION_MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);
const FORWARD_MIGRATION_NAME = '20261105101000_operational_reporting_correction_selector_contract_v1.sql';
const FORWARD_MIGRATION_URL = new URL(`../migrations/${FORWARD_MIGRATION_NAME}`, import.meta.url);
const FORWARD_ROLLBACK_URL = new URL(`../migrations/${FORWARD_MIGRATION_NAME.replace(/\.sql$/, '.rollback.sql')}`, import.meta.url);

const ctx = await buildM0Fixture();
const { db, asAdmin, asWriter } = ctx;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;

try {
  await asAdmin();
  // --- 1. Unwind forward migration so baseline is at 20261008110000 ----------
  // buildM0Fixture applies full chain including 20261105101000. Roll back
  // forward migration first to keep preimage capture consistent and test baseline.
  await db.exec(await readFile(FORWARD_ROLLBACK_URL, 'utf8'));
  // --- 2. Test Rollback & Re-apply Cleanliness for 20261008110000 ------------
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
  // Seed contiguous canonical coverage from year start through head business date
  await db.query(`
    insert into reporting.public_traffic_coverage (
      from_date, to_date, status, reason_code, certified_at
    ) values (date '2026-01-01', date '2026-08-15', 'complete', 'test-coverage', now())
    on conflict do nothing
  `);

  // Bring shadow projection to current revision so projection status is fresh
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');

  // --- 4. Candidate evaluation after quiet window ----------------------------
  // 4a. Failing Before Fix: Under 20261008110000, selector calls get_public_annual_passenger_kpi_v1
  // which does not have 'timeline' or 'current', resulting in missing_timeline and ineligibility.
  const candidateBeforeFix = (
    await rows("select reporting.select_public_dashboard_correction_candidate_v1(statement_timestamp() + interval '3 minutes') as candidate")
  )[0].candidate;

  assert.equal(candidateBeforeFix.eligible, false, 'Candidate before fix must be ineligible due to line 298 bug');
  assert.equal(candidateBeforeFix.status, 'missing_timeline', 'Status before fix must be missing_timeline');
  assert.equal(candidateBeforeFix.business_date, undefined, 'Contract before fix lacks business_date field');
  // Save exact live function metadata pre-forward migration
  const [preForwardMeta] = await rows(`
    select
      pg_catalog.pg_get_functiondef(p.oid) as def,
      r.rolname as owner,
      p.proacl::text as acl
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'reporting'
      and p.proname = 'select_public_dashboard_correction_candidate_v1'
  `);

  // 4b. Apply forward migration 20261105101000
  await db.exec(await readFile(FORWARD_MIGRATION_URL, 'utf8'));
  // 4c. Passing After Fix: Candidate evaluation succeeds with complete runner contract
  const candidateAfterQuiet = (
    await rows("select reporting.select_public_dashboard_correction_candidate_v1(statement_timestamp() + interval '3 minutes') as candidate")
  )[0].candidate;

  assert.notEqual(
    candidateAfterQuiet.status,
    'already_current',
    'Unseen correction must NOT be marked already_current despite head_watermark (63510) being higher than native_seq (5)'
  );
  assert.equal(candidateAfterQuiet.eligible, true, 'Candidate must be eligible for correction republish');
  assert.equal(candidateAfterQuiet.status, 'correction_ready');
  assert.equal(candidateAfterQuiet.business_date, '2026-08-15');
  assert.equal(candidateAfterQuiet.head_publication_id, pubRow.id);
  assert.equal(Number(candidateAfterQuiet.head_source_watermark), priorGeneration);
  assert.equal(Number(candidateAfterQuiet.source_watermark), expectedGeneration);
  assert.match(candidateAfterQuiet.idempotency_key, /^annual-kpi:2026:2026-08-15:[0-9]+$/);
  assert.equal(Number(candidateAfterQuiet.reported_pax), 150);
  assert.equal(candidateAfterQuiet.reported_legs, 1);
  assert.equal(candidateAfterQuiet.due_legs, 1);
  assert.equal(Number(candidateAfterQuiet.pax_coverage_pct), 100);
  // Republish head publication with native correction
  const [publishReceipt] = await rows(`
    select public.publish_public_dashboard_daily_v1(
      2026, date '2026-08-15', $1, $2,
      'manual_correction', 'Daily Pax auto-save correction after two-minute quiet window'
    ) as r
  `, [candidateAfterQuiet.source_watermark, candidateAfterQuiet.idempotency_key]);

  assert.equal(publishReceipt.r.status, 'ready', `Republish must succeed: ${publishReceipt.r.error}`);
  assert.notEqual(publishReceipt.r.publication_id, pubRow.id, 'Republish must produce a new publication ID');
  assert.equal(Number(publishReceipt.r.source_watermark), expectedGeneration);

  const [newHeadRow] = await rows(`
    select publication_id from reporting.public_dashboard_publication_heads
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(newHeadRow.publication_id, publishReceipt.r.publication_id, 'Publication head pointer must advance to new publication');

  const [kpiVersionRow] = await rows('select public.get_public_annual_passenger_kpi_version_v1(2026) as v');
  assert.equal(Number(kpiVersionRow.v.source_watermark), expectedGeneration, 'KPI version reflects updated head watermark');

  // Acknowledge correction marker
  const [ackReceipt] = await rows(`
    select reporting.acknowledge_public_dashboard_corrections_v1(2026, $1, $2) as ack
  `, [publishReceipt.r.publication_id, candidateAfterQuiet.source_watermark]);
  assert.equal(ackReceipt.ack.acknowledged, 1, 'Dirty marker must be acknowledged');

  const [appliedMarker] = await rows(`
    select status, applied_publication_id, applied_watermark
    from reporting.public_dashboard_dirty_markers
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(appliedMarker.status, 'applied', 'Dirty marker status transitions to applied');
  assert.equal(appliedMarker.applied_publication_id, publishReceipt.r.publication_id);
  assert.equal(Number(appliedMarker.applied_watermark), expectedGeneration);

  // Subsequent candidate check returns no_correction
  const [subsequentCandidate] = await rows(`
    select reporting.select_public_dashboard_correction_candidate_v1(statement_timestamp() + interval '5 minutes') as c
  `);
  assert.equal(subsequentCandidate.c.eligible, false);
  assert.equal(subsequentCandidate.c.status, 'no_correction');

  // 4e. Test rollback & byte-exact preimage restoration
  await db.exec(await readFile(FORWARD_ROLLBACK_URL, 'utf8'));

  const [postRollbackMeta] = await rows(`
    select
      pg_catalog.pg_get_functiondef(p.oid) as def,
      r.rolname as owner,
      p.proacl::text as acl
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_roles r on r.oid = p.proowner
    where n.nspname = 'reporting'
      and p.proname = 'select_public_dashboard_correction_candidate_v1'
  `);
  assert.equal(postRollbackMeta.def, preForwardMeta.def, 'Rollback must restore byte-exact function definition');
  assert.equal(postRollbackMeta.owner, preForwardMeta.owner, 'Rollback must restore original function owner');
  assert.equal(postRollbackMeta.acl, preForwardMeta.acl, 'Rollback must restore original function ACL');

  // Re-apply forward migration for subsequent tests
  await db.exec(await readFile(FORWARD_MIGRATION_URL, 'utf8'));

  // --- 4b. Zero-Pax native correction republish lifecycle -------------------
  await db.query(`
    update public.operational_flight_legs
    set pax = 0
    where leg_id = $1
  `, [testLegId]);

  await db.query(`
    insert into public.operational_change_events (
      target_type, target_id, operational_date, changed_fields, before_state, after_state
    ) values (
      'operationalLeg', $1, '2026-08-15', array['pax'],
      jsonb_build_object('pax', 150), jsonb_build_object('pax', 0)
    )
  `, [testLegId]);

  await db.query('select reporting.refresh_operational_canonical_legs_v1()');

  const zeroCandidate = (
    await rows("select reporting.select_public_dashboard_correction_candidate_v1(statement_timestamp() + interval '3 minutes') as candidate")
  )[0].candidate;

  assert.equal(zeroCandidate.eligible, true, 'Zero-Pax correction must remain eligible when all due legs report');
  assert.equal(zeroCandidate.status, 'correction_ready');
  assert.equal(Number(zeroCandidate.reported_pax), 0, 'Reported Pax is zero');
  assert.equal(zeroCandidate.reported_legs, 1, 'Leg with 0 pax counts as reported');
  assert.equal(Number(zeroCandidate.pax_coverage_pct), 100);

  const [zeroPublishReceipt] = await rows(`
    select public.publish_public_dashboard_daily_v1(
      2026, date '2026-08-15', $1, $2,
      'manual_correction', 'Zero-Pax correction republish'
    ) as r
  `, [zeroCandidate.source_watermark, zeroCandidate.idempotency_key]);

  assert.equal(zeroPublishReceipt.r.status, 'ready');
  assert.notEqual(zeroPublishReceipt.r.publication_id, publishReceipt.r.publication_id, 'Zero-Pax republish advances publication ID');
  assert.equal(Number(zeroPublishReceipt.r.source_watermark), Number(zeroCandidate.source_watermark));

  const [zeroHead] = await rows(`
    select publication_id from reporting.public_dashboard_publication_heads
    where dashboard_key = 'annual-passenger-kpi' and year = 2026
  `);
  assert.equal(zeroHead.publication_id, zeroPublishReceipt.r.publication_id, 'Head advances to zero-pax publication');

  const [zeroKpiVersion] = await rows('select public.get_public_annual_passenger_kpi_version_v1(2026) as v');
  assert.equal(Number(zeroKpiVersion.v.source_watermark), Number(zeroCandidate.source_watermark), 'KPI version reflects zero-pax watermark');

  const [zeroAck] = await rows(`
    select reporting.acknowledge_public_dashboard_corrections_v1(2026, $1, $2) as ack
  `, [zeroPublishReceipt.r.publication_id, zeroCandidate.source_watermark]);
  assert.equal(zeroAck.ack.acknowledged, 1);

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
