import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';

const files = [
  '../schema.sql',
  '../migrations/20260828083000_allow_alphanumeric_stand_values.sql',
  '../migrations/20260828090000_daily_schedule_import_v1.sql',
  '../migrations/20260828100000_preserve_daily_overlays_during_seasonal_replace.sql',
  '../migrations/20260829150000_canonical_flight_leg_store.sql',
  '../migrations/20260829153000_daily_schedule_canonical_commit.sql',
  '../migrations/20260829160000_canonical_manual_modifications.sql',
  '../migrations/20260829163000_canonical_effective_read.sql',
  '../migrations/20260829170000_seasonal_canonical_authority.sql',
];
const sql = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
const db = await createSupabasePGlite();
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seasonId = 'season-manual-canonical';
const legId = 'MANUAL-CANONICAL-1';

const added = {
  legId,
  action: 'added',
  addedLeg: {
    id: legId,
    type: 'D',
    airline: 'VN',
    flightNumber: 'VN555',
    rawFlightNumber: '555',
    route: 'SGN',
    schedule: '09:00',
    aircraft: '321',
    category: 'J',
    pax: 88,
    gate: 1,
    stand: '20A',
    date: '2026-08-23',
    scheduledDate: '2026-08-23',
    scheduledTime: '09:00',
    operationalDate: '2026-08-23',
    iataSeasonCode: 'S26',
  },
};

try {
  for (const source of sql) await db.exec(source);
  await db.query(`insert into auth.users(id,email) values ($1,'manual@example.test')`, [userId]);
  await db.query(`insert into public.app_operators(user_id,email,username,display_name) values ($1,'manual@example.test','manual','Manual')`, [userId]);
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values ($1,'detailed.write','allow'),($1,'seasonal.read','allow')`, [userId]);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version) values ($1,'S26','S26','',0,'2026-03-29','2026-10-24',0,0,1)`, [seasonId]);
  await db.exec(`select set_config('request.jwt.claim.sub','${userId}',false)`);

  const saved = await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb) as result`, [seasonId, JSON.stringify(added)]);
  assert.equal(saved.rows[0].result.sourceKind, 'manual');
  const base = await db.query(`select source_kind,status,action,pax,gate,stand from public.season_flight_records where record_id=$1`, [legId]);
  assert.deepEqual(base.rows, [{ source_kind: 'manual', status: 'active', action: 'added', pax: 88, gate: 1, stand: '20A' }]);
  const legacy = await db.query(`select count(*)::integer as count from public.season_modification_added_legs`);
  assert.equal(legacy.rows[0].count, 0, 'new manual writes must not create a legacy live child');
  const effective = await db.query(`select record_id,pax,gate,stand from reporting.effective_flight_operations where season_id=$1`, [seasonId]);
  assert.deepEqual(effective.rows, [{ record_id: legId, pax: 88, gate: 1, stand: '20A' }]);
  const canonicalRead = await db.query(`select record_id,source_kind,source_data_version from reporting.canonical_effective_flight_legs where season_id=$1`, [seasonId]);
  assert.deepEqual(canonicalRead.rows, [{ record_id: legId, source_kind: 'manual', source_data_version: 1 }]);

  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [seasonId, JSON.stringify({ legId, action: 'modified', gate: 7 })]);
  const edited = await db.query(`select pax,gate from reporting.effective_flight_operations where season_id=$1`, [seasonId]);
  assert.deepEqual(edited.rows, [{ pax: 88, gate: 7 }]);
  await db.query(`select public.remove_canonical_season_modification_v1($1,$2)`, [seasonId, legId]);
  const afterEditUndo = await db.query(`select pax,gate from reporting.effective_flight_operations where season_id=$1`, [seasonId]);
  assert.deepEqual(afterEditUndo.rows, [{ pax: 88, gate: 1 }]);

  await db.query(`insert into public.season_flight_records(
    season_id,record_id,link_id,type,airline,flight_number,raw_flight_number,route,
    schedule,aircraft,category,date,scheduled_date,scheduled_time,operational_date,
    iata_season_code,day_of_week,source_kind,source_side,status
  ) values ($1,'SEASONAL-DELETE-1','','D','KE','KE2094','2094','PUS',
    '11:00','738','J','2026-09-19','2026-09-19','11:00','2026-09-19',
    'S26',6,'seasonal','DEP','active')`, [seasonId]);
  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    seasonId,
    JSON.stringify({ legId: 'SEASONAL-DELETE-1', action: 'deleted' }),
  ]);
  const terminalDelete = await db.query(`select status,action,deletion_reason from public.season_flight_records where record_id='SEASONAL-DELETE-1'`);
  assert.deepEqual(terminalDelete.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'overlay_deleted' }]);
  await db.query(`select public.remove_canonical_season_modification_v1($1,'SEASONAL-DELETE-1')`, [seasonId]);
  const validUndo = await db.query(`select status,action,deletion_reason from public.season_flight_records where record_id='SEASONAL-DELETE-1'`);
  assert.deepEqual(validUndo.rows, [{ status: 'active', action: null, deletion_reason: null }]);

  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [
    seasonId,
    JSON.stringify({ legId: 'SEASONAL-DELETE-1', action: 'deleted' }),
  ]);
  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [seasonId, JSON.stringify({
    legId: 'MANUAL-REPLACEMENT-1',
    action: 'added',
    addedLeg: {
      id: 'MANUAL-REPLACEMENT-1', type: 'D', airline: 'KE', flightNumber: 'KE2094',
      rawFlightNumber: '2094', route: 'PUS', schedule: '11:00', aircraft: '738',
      category: 'J', date: '2026-09-19', scheduledDate: '2026-09-19',
      scheduledTime: '11:00', operationalDate: '2026-09-19', iataSeasonCode: 'S26',
    },
  })]);
  await assert.rejects(
    db.query(`select public.remove_canonical_season_modification_v1($1,'SEASONAL-DELETE-1')`, [seasonId]),
    (error) => error?.code === '23505',
    'stale Undo must not revive a deleted row when the occurrence is now occupied',
  );
  const staleDelete = await db.query(`select status,action,deletion_reason from public.season_flight_records where record_id='SEASONAL-DELETE-1'`);
  assert.deepEqual(staleDelete.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'overlay_deleted' }]);

  await db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [seasonId, JSON.stringify(added)]);
  await db.query(`select public.remove_canonical_season_modification_v1($1,$2)`, [seasonId, legId]);
  const deleted = await db.query(`select status,action,deletion_reason from public.season_flight_records where record_id=$1`, [legId]);
  assert.deepEqual(deleted.rows, [{ status: 'deleted', action: 'deleted', deletion_reason: 'manual_undo' }]);
  await assert.rejects(
    db.query(`select public.save_canonical_season_modification_v1($1,$2::jsonb)`, [seasonId, JSON.stringify({ legId, action: 'modified', gate: 4 })]),
    (error) => error?.code === '40001',
  );

  console.log(JSON.stringify({ suite: 'canonical-manual-modifications', status: 'passed' }));
} finally {
  await db.close();
}
