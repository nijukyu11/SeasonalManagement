import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

let db;
try {
  const ctx = await buildM0Fixture();
  db = ctx.db;
  const { asWriter, asAdmin } = ctx;
  const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const rpc = async (name, params, args) => (await row(`select public.${name}(${params}) r`, args)).r;
  const rejected = (fn, code) => assert.rejects(fn, e => {
    if (code && e.code !== code) {
      throw new Error(`Expected error code ${code}, got ${e.code}: ${e.message}`);
    }
    return true;
  });

  const safetyRollback = new URL('../migrations/20261008090000_seasonal_publish_safety_v1.rollback.sql', import.meta.url);
  await asWriter();
  await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)", [M0_FIXTURE.writerId]);

  const dates = await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date+2)::text d1,((now() at time zone 'Asia/Ho_Chi_Minh')::date+3)::text d2");
  const season = 'season-publish-safety';
  await asAdmin();
  await db.query(
    "insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values($1,'W99','Safety Season','',0,$2::date-1,$3::date+10,0,0,0) on conflict (id) do nothing",
    [season, dates.d1, dates.d2]
  );
  await db.query("delete from public.seasonal_flight_drafts where season_id = $1", [season]);
  await db.query("delete from public.seasonal_draft_workspace where season_id = $1", [season]);
  await db.query("insert into public.seasonal_draft_workspace(season_id,revision,epoch) values($1,0,gen_random_uuid())", [season]);

  const window = () => rpc('get_seasonal_draft_window_v1', '$1', [season]);
  const preview = (reqId = randomUUID()) => rpc('preview_seasonal_publish_v1', '$1,$2::uuid', [season, reqId]);
  const commit = (p, notes = '', ack = false) => rpc('commit_seasonal_publish_v1', '$1,$2::uuid,$3,$4,$5::boolean', [season, p.previewId, p.previewHash, notes, ack]);
  const patch = async (d, values) => rpc(
    'apply_seasonal_draft_changes_v1',
    '$1,$2::uuid,$3::bigint,$4::jsonb',
    [season, randomUUID(), (await window()).revision, JSON.stringify([{ draftId: d.draft_id, expected: Object.fromEntries(Object.keys(values).map(k => [k, d[k]])), patch: values }])]
  );
  const addDraft = async (drafts) => rpc(
    'apply_seasonal_draft_changes_v1',
    '$1,$2::uuid,$3::bigint,$4::jsonb',
    [season, randomUUID(), (await window()).revision, JSON.stringify(drafts.map(d => {
      const { draft_id, ...patchData } = d;
      return { draftId: draft_id, expected: null, patch: patchData };
    }))]
  );
  const getDraft = async (date) => (await window()).drafts.find(d => d.date === date);
  const legs = async () => {
    await asAdmin();
    const l = await rows("select to_jsonb(l) r from public.operational_flight_legs l where source_season_id=$1 order by operational_date,lineage_generation", [season]);
    await asWriter();
    return l.map(x => x.r);
  };

  // Setup initial draft flight
  await asWriter();
  await addDraft([{
    draft_id: 'SAFE-01',
    airline: 'VN',
    flight_number: 'VN901',
    type: 'A',
    date: dates.d1,
    schedule: '10:00',
    route: 'HAN',
    aircraft: '321',
    pax: 150
  }]);

  // 1. Initial Publish (Release)
  console.log('Testing 1: Initial publish as release...');
  const prev1 = await preview();
  assert.equal(prev1.preview.publishKind, 'release');
  assert.equal(prev1.preview.requiresOperationalAcknowledgement, false);
  const receipt1 = await commit(prev1, 'Initial release');
  assert.equal(receipt1.status, 'committed');

  const publishedLegs1 = await legs();
  assert.equal(publishedLegs1.length, 1);
  assert.equal(publishedLegs1[0].pax, 150);
  assert.equal(publishedLegs1[0].status, 'active');

  // 2. No-op Detection & Preservation
  console.log('Testing 2: Unchanged preview produces noop...');
  const prevNoop = await preview();
  assert.equal(prevNoop.preview.publishKind, 'noop');
  assert.equal(prevNoop.preview.operationalImpactCounts.added, 0);
  assert.equal(prevNoop.preview.operationalImpactCounts.modified, 0);
  assert.equal(prevNoop.preview.operationalImpactCounts.removed, 0);
  assert.equal(prevNoop.preview.requiresOperationalAcknowledgement, false);

  const versionsBefore = (await rows("select * from public.seasonal_publish_versions where season_id = $1", [season])).length;
  const receiptNoop = await commit(prevNoop, 'No-op commit');
  assert.equal(receiptNoop.status, 'committed');
  const versionsAfter = (await rows("select * from public.seasonal_publish_versions where season_id = $1", [season])).length;
  assert.equal(versionsAfter, versionsBefore, 'Noop commit must not create extra versions in seasonal_publish_versions');

  // 3. Operational Impact Pagination RPC
  console.log('Testing 3: Operational impact pagination RPC...');
  const impactPage = await rpc(
    'get_seasonal_publish_operational_impact_page_v1',
    '$1::uuid,$2,$3::bigint,$4::integer',
    [prevNoop.previewId, prevNoop.previewHash, 0, 50]
  );
  assert.equal(impactPage.stale, false);
  assert.equal(Array.isArray(impactPage.entries), true);
  assert.equal(impactPage.hasMore, false);

  // 4. Pax Overrides Preservation (Pax 777, 0, NULL overrides in Operations)
  console.log('Testing 4: Operational Pax override preservation (777, 0, NULL)...');
  const legId = publishedLegs1[0].leg_id;
  const getOpRevision = async () => {
    await asAdmin();
    const rev = (await row("select revision::text r from public.operational_workspace_revision where singleton")).r;
    await asWriter();
    return rev;
  };
  const opRev = await getOpRevision();
  await rpc('apply_operational_resource_changes_v1', '$1::uuid,$2::bigint,$3::jsonb', [
    randomUUID(),
    opRev,
    JSON.stringify([{ legId, expected: { pax: 150 }, patch: { pax: 777 } }])
  ]);

  let activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, 777, 'Operations Pax successfully overridden to 777');

  // Republish draft where draft still has pax = 150 (Planning did NOT change draft)
  const prevRepublish = await preview();
  // Operational impact preview should show overwrite = 0 because planning did not change anything
  assert.equal(prevRepublish.preview.requiresOperationalAcknowledgement, false);
  await commit(prevRepublish);

  activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, 777, 'Pax 777 must NOT be wiped or reset on draft republish');

  // Test Pax override to 0
  const opRev2 = await getOpRevision();
  await rpc('apply_operational_resource_changes_v1', '$1::uuid,$2::bigint,$3::jsonb', [
    randomUUID(),
    opRev2,
    JSON.stringify([{ legId, expected: { pax: 777 }, patch: { pax: 0 } }])
  ]);
  activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, 0);

  const prevRepublish2 = await preview();
  await commit(prevRepublish2);
  activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, 0, 'Pax 0 override must NOT be wiped on draft republish');

  // Test Pax override to NULL
  const opRev3 = await getOpRevision();
  await rpc('apply_operational_resource_changes_v1', '$1::uuid,$2::bigint,$3::jsonb', [
    randomUUID(),
    opRev3,
    JSON.stringify([{ legId, expected: { pax: 0 }, patch: { pax: null } }])
  ]);
  activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, null);

  const prevRepublish3 = await preview();
  await commit(prevRepublish3);
  activeLeg = (await legs()).find(l => l.leg_id === legId);
  assert.equal(activeLeg.pax, null, 'Pax NULL override must NOT be wiped on draft republish');

  // 5. Overwriting Operational Edits requires Acknowledgement
  console.log('Testing 5: Overwriting operational edits requires explicit acknowledgement...');
  const currentActiveLeg = (await legs()).find(l => l.status === 'active');
  const activeLegId = currentActiveLeg.leg_id;
  
  // Operator changes scheduled_time to 10:30 via apply_operational_flight_schedule_changes_v1
  const opRev4 = await getOpRevision();
  await rpc('apply_operational_flight_schedule_changes_v1', '$1::uuid,$2::bigint,$3::jsonb', [
    randomUUID(),
    opRev4,
    JSON.stringify([{
      legId: activeLegId,
      expected: { scheduled_time: '10:00:00' },
      patch: { scheduled_time: '10:30' }
    }])
  ]);

  // Planning modifies schedule to 11:00 in the draft
  const dBefore = await getDraft(dates.d1);
  await patch(dBefore, { schedule: '11:00' });
  const prevConflict = await preview();
  assert.equal(prevConflict.preview.requiresOperationalAcknowledgement, true, 'Must require operational acknowledgement');
  assert.equal(prevConflict.preview.operationalImpactCounts.overwrites, 1);

  // Committing without ack must fail with 40001
  await rejected(() => commit(prevConflict, 'Unacknowledged', false), '40001');

  // Committing with ack must succeed
  const receiptAck = await commit(prevConflict, 'Acknowledged override', true);
  assert.equal(receiptAck.status, 'committed');

  // 6. Receipt replay consistency
  console.log('Testing 6: Deterministic receipt replay...');
  // Replaying with identical notes and ack succeeds with identical receipt
  const replayedReceipt = await commit(prevConflict, 'Acknowledged override', true);
  assert.deepEqual(replayedReceipt, receiptAck);

  // Replaying with different ack or notes is rejected
  await rejected(() => commit(prevConflict, 'Different notes', true), '22023');
  await rejected(() => commit(prevConflict, 'Acknowledged override', false), '22023');

  // 7. Manual Collision Prevention
  console.log('Testing 7: Manual collision prevention...');
  // Insert an active manual leg with flight number VN999 on date d2
  await asAdmin();
  await db.query(
    "insert into public.operational_flight_legs(leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type,status) values('A'||chr(31)||$1||chr(31)||'VN'||chr(31)||'VN999',$1::date,$1::date,'15:00','ARR','VN','VN999','operational_manual','active')",
    [dates.d2]
  );
  await asWriter();

  // Planning tries to add a draft leg on date d2 with same flight number VN999
  await addDraft([{
    draft_id: 'SAFE-COLLIDE',
    airline: 'VN',
    flight_number: 'VN999',
    type: 'A',
    date: dates.d2,
    schedule: '15:00',
    route: 'HAN',
    aircraft: '321'
  }]);

  const prevCollide = await preview();
  // It should be blocked due to OPERATIONAL_KEY_COLLISION
  assert.equal(prevCollide.status, 'blocked');
  assert.ok(prevCollide.preview.diagnostics.some(d => d.code === 'OPERATIONAL_KEY_COLLISION'));
  await rejected(() => commit(prevCollide), '40001');

  // 8. Migration Rollback
  console.log('Testing 8: Rollback safety...');
  await asAdmin();
  // Should fail rollback while native published versions exist
  await rejected(async () => db.exec(await readFile(safetyRollback, 'utf8')), '55000');
  await db.exec('rollback');

  // Clean up published versions for this test season to test clean rollback.
  // Published history is immutable by design; only this admin fixture cleanup bypasses the row guards.
  const immutableGuards = [
    ['seasonal_publish_snapshots', 'seasonal_publish_snapshots_guard_trigger'],
    ['seasonal_published_snapshot_flights', 'seasonal_published_snapshot_flights_guard_trigger'],
    ['seasonal_publish_versions', 'seasonal_publish_versions_guard_trigger'],
  ];
  for (const [table, trigger] of immutableGuards) await db.query(`alter table public.${table} disable trigger ${trigger}`);
  await db.query("delete from public.operational_flight_legs where source_season_id = $1", [season]);
  await db.query("delete from public.seasonal_publish_snapshots where season_id = $1", [season]);
  await db.query("delete from public.seasonal_publish_diff_entries where season_id = $1", [season]);
  await db.query("delete from public.seasonal_publish_previews where season_id = $1", [season]);
  await db.query("delete from public.seasonal_publish_versions where season_id = $1", [season]);
  for (const [table, trigger] of immutableGuards) await db.query(`alter table public.${table} enable trigger ${trigger}`);
  // Rollback executes cleanly
  await db.exec(await readFile(safetyRollback, 'utf8'));

  console.log('PASS: Seasonal publish safety PGlite regression passed all checks!');
} catch (e) {
  console.error('FAILED:', e);
  throw e;
} finally {
  if (db) await db.close();
}
