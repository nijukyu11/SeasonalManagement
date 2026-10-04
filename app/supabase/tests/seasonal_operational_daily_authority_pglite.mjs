import assert from 'node:assert/strict';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';

const ctx = await buildM0Fixture();
const { db, asAdmin, asWriter } = ctx;
const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
const backfill = async () => {
  await asWriter();
  const [run] = await rows("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid) result", [M0_FIXTURE.writerId]);
  await asAdmin();
  return run.result;
};
try {
  await asAdmin();
  const [daily] = await rows("select * from public.season_flight_records where source_kind='daily' and status='active' and flight_number='VN101'");
  assert.ok(daily, 'existing Daily import provides durable batch lineage');
  await db.query('update public.season_flight_records set pax=175 where season_id=$1 and record_id=$2', [daily.season_id, daily.record_id]);
  await db.query(`insert into public.season_flight_records(
    season_id,record_id,type,airline,flight_number,raw_flight_number,route,schedule,aircraft,category,
    date,scheduled_date,scheduled_time,operational_date,iata_season_code,day_of_week,source_row_index,source_kind,source_side,status,pax)
    values($1,'DAILY-AUTHORITY-SEASONAL','D','VN','VN101','101','SGN',$2,'321','J',
    $3,$3,$2,$4,'M26',0,0,'seasonal','DEP','active',999)`,
    [M0_FIXTURE.seasonM26,daily.scheduled_time,daily.scheduled_date,daily.operational_date]);
  await db.query(`insert into public.season_change_events(event_id,season_id,client_id,op_id,target_type,target_id,changed_fields)
    values('daily-authority-newer-seasonal',$1,'authority-test','newer','modification','DAILY-AUTHORITY-SEASONAL',array['pax'])`, [M0_FIXTURE.seasonM26]);
  await db.query('select reporting.refresh_public_traffic_canonical_legs_v1()');
  assert.equal((await rows("select pax from reporting.canonical_flight_legs where flight_number='VN101'"))[0].pax,999,
    'legacy baseline actually prefers the newer Seasonal candidate');

  for (const pax of [175,0,null]) {
    await db.query('update public.season_flight_records set pax=$3 where season_id=$1 and record_id=$2', [daily.season_id,daily.record_id,pax]);
    await backfill();
    const active = await rows("select source_type,pax from public.operational_flight_legs where status='active' and flight_number='VN101'");
    assert.deepEqual(active,[{source_type:'daily_import',pax}], 'Daily wins newer Seasonal without filling NULL/zero Pax');
    await db.query('select reporting.refresh_operational_canonical_legs_v1()');
    assert.deepEqual(await rows("select pax from reporting.operational_canonical_flight_legs where flight_number='VN101'"),[{pax}]);
  }
  const replay = await backfill();
  assert.equal(replay.legs.written,0);
  assert.equal(replay.legs.updated,0);
  assert.equal(replay.legs.retired,0);

  // Native projection must apply the policy independently of legacy backfill.
  const [leg] = await rows("select * from public.operational_flight_legs where status='active' and flight_number='VN101'");
  const [manual] = await rows(`insert into public.operational_flight_legs(
    leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,pax,source_type)
    select leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,999,'operational_manual'
    from public.operational_flight_legs where leg_id=$1 returning leg_id`,[leg.leg_id]);
  await db.query(`insert into public.operational_change_events(target_id,operational_date,changed_fields,before_state,after_state)
    values($1,$2,array['pax'],'{}','{}')`,[manual.leg_id,leg.operational_date]);
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.deepEqual(await rows("select pax from reporting.operational_canonical_flight_legs where flight_number='VN101'"),[{pax:null}],
    'native Daily NULL remains authoritative over a newer Manual event');

  const [overnight] = await rows(`insert into public.operational_flight_legs(
    leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,pax,source_type,source_batch_id,source_occurrence_key)
    select leg_key,operational_date,scheduled_date+1,'01:30',side,airline,flight_number,42,source_type,source_batch_id,source_occurrence_key||'-overnight'
    from public.operational_flight_legs where leg_id=$1 returning leg_id`,[leg.leg_id]);
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.deepEqual(await rows("select pax from reporting.operational_canonical_flight_legs where flight_number='VN101' order by scheduled_local_at"),[{pax:null},{pax:42}],
    'two scheduled dates in one 05:00 operational day remain distinct report flights');

  // A duplicate Daily with missing recency must quarantine, not fall back to Manual.
  await db.query(`insert into public.operational_flight_legs(
    leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,pax,source_type,source_batch_id,source_occurrence_key)
    select leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,43,source_type,source_batch_id,source_occurrence_key||'-duplicate'
    from public.operational_flight_legs where leg_id=$1`,[overnight.leg_id]);
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.deepEqual(await rows("select pax from reporting.operational_canonical_flight_legs where flight_number='VN101'"),[{pax:null}],
    'ambiguous Daily occurrence is excluded without dropping the other scheduled date');
  assert.deepEqual(await rows("select candidate_count from reporting.operational_canonical_flight_legs_quarantine where ops_date=$1",[leg.operational_date]),[{candidate_count:2}],
    'quarantine counts only competing Daily candidates');
  console.log('Daily authority PASS: older Daily beats newer Seasonal/Manual; Pax 175/0/NULL preserved; replay idempotent; overnight identities remain distinct; ambiguous Daily quarantines.');
} finally {
  await ctx.close();
}
