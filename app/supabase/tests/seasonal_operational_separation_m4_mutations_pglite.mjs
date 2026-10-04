import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
const ctx = await buildM0Fixture();
const { db, asWriter, asAdmin } = ctx;
const migration = new URL('../migrations/20260928170000_operational_mutations_v1.sql',import.meta.url);
const rollback = new URL('../migrations/20260928170000_operational_mutations_v1.rollback.sql',import.meta.url);
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const result = async (sql,params=[]) => (await db.query(sql,params)).rows[0];
const window = async () => (await result(`select public.get_operational_schedule_allocation_window_v1('2030-03-30','2030-04-02') as r`)).r;
const apply = async (request,revision,changes) => (await result(`select public.apply_operational_resource_changes_v1($1::uuid,$2::bigint,$3::jsonb) as r`,[request,revision,JSON.stringify(changes)])).r;
const reject = async (fn,code) => assert.rejects(fn,e=>e.code===code);
try {
  // Empty-table rollback/reapply restores prior functions and retains legacy data.
  await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928200000_seasonal_draft_import_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928190000_seasonal_planning_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928180000_operational_daily_import_v2.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(rollback,'utf8'));
  await db.exec(await readFile(migration,'utf8'));
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  const empty = await result('select * from reporting.operational_projection_status_v1()');
  assert.equal(empty.is_fresh,true);
  assert.equal(empty.leg_count,0);
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  await asAdmin();
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,false,'backfill invalidates a previously fresh empty projection');
  const link = await result(`select * from public.operational_leg_backfill_links order by leg_id limit 1`);
  await db.query(`insert into public.season_flight_record_counters(record_id,counter_group,item_index,counter_value) values($1,'T1',0,'21'),($1,'T1',1,'22') on conflict do nothing`,[link.legacy_record_id]);
  await db.query(`insert into public.season_flight_record_checkin_windows(record_id,counter_key,window_start,window_end) values($1,'21','22:00','01:00') on conflict do nothing`,[link.legacy_record_id]);
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  await asAdmin();
  assert.deepEqual((await db.query(`select counter_value from public.operational_leg_counters where leg_id=$1 and counter_group='T1' order by item_index`,[link.leg_id])).rows.map(r=>r.counter_value),['21','22']);
  assert.equal((await result(`select window_end from public.operational_leg_checkin_windows where leg_id=$1 and counter_key='21'`,[link.leg_id])).window_end,'01:00');
  // Explicit empty overlay must clear rather than resurrect base child rows.
  await db.query(`insert into public.season_modifications(season_id,leg_id,action,changed_fields) values($1,$2,'modified',array['counter','checkInCounterWindows']) on conflict(leg_id) do update set changed_fields=array['counter','checkInCounterWindows']`,[link.legacy_season_id,link.legacy_record_id]);
  await db.query(`delete from public.season_modification_counters where leg_id=$1`,[link.legacy_record_id]);
  await db.query(`delete from public.season_modification_checkin_windows where leg_id=$1`,[link.legacy_record_id]);
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  await asAdmin();
  assert.equal(Number((await result(`select count(*) n from public.operational_leg_counters where leg_id=$1`,[link.leg_id])).n),0);
  assert.equal(Number((await result(`select count(*) n from public.operational_leg_checkin_windows where leg_id=$1`,[link.leg_id])).n),0);
  for (const [n,date,side] of [[1,'2030-03-31','ARR'],[2,'2030-04-01','DEP']]) {
    await db.query(`insert into public.operational_flight_legs(leg_id,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type)
      values($1,(case $3 when 'ARR' then 'A' else 'D' end)||chr(31)||$2||chr(31)||'VN'||chr(31)||'VN900',$2::date,$2::date,'06:00',$3,'VN','VN900','operational_manual')`,[id(n),date,side]);
  }
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,true);
  await asWriter();
  const initial = await window();
  const changes = [{legId:id(1),expected:{pax:null,gate:null,counters:[],checkin_windows:[]},patch:{pax:0,gate:12,counters:[{counter_group:'T1',item_index:0,counter_value:'21'},{counter_group:'T1',item_index:1,counter_value:'22'}],checkin_windows:[{counter_key:'21',window_start:'22:00',window_end:'01:00'}]}}];
  const receipt = await apply(id(100),initial.snapshot.revision,changes);
  assert.equal(receipt.status,'committed');
  assert.equal(receipt.events[0].after.pax,0);
  assert.equal(receipt.events[0].after.gate,12);
  assert.equal(receipt.events[0].after.counters[1].counter_value,'22');
  assert.deepEqual(await apply(id(100),initial.snapshot.revision,changes),receipt,'retry returns exact durable receipt even after revision advanced');
  await reject(()=>apply(id(100),initial.snapshot.revision,[{...changes[0],patch:{pax:1}}]),'22023');
  await reject(()=>apply(id(101),initial.snapshot.revision,changes),'40001');
  const changed = await window();
  assert.equal(changed.legCounters.find(c=>c.leg_id===id(1)&&c.item_index===1).counter_value,'22');
  assert.equal(changed.legCheckinWindows.find(w=>w.leg_id===id(1)).window_end,'01:00');
  await reject(()=>apply(id(102),changed.snapshot.revision,[{legId:id(1),expected:{pax:null},patch:{pax:1}}]),'40001');
  await reject(()=>apply(id(103),changed.snapshot.revision,[{legId:id(1),expected:{source_type:'operational_manual'},patch:{source_type:'daily_import'}}]),'22023');
  await asAdmin();
  assert.equal(Number((await result('select count(*) n from public.operational_change_events')).n),1,'retries and rejected writes add no events');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,false,'no-season Pax write invalidates projection');
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,true);
  assert.equal((await result(`select pax from reporting.operational_canonical_flight_legs where ops_date='2030-03-31' and flight_number='VN900'`)).pax,0);
  const recency = await result(`select authoritative_server_seq from reporting.get_operational_candidate_slice_v1('2030-03-31','2030-03-31') where record_id=$1`,[id(1)]);
  assert.equal(String(recency.authoritative_server_seq),receipt.events[0].serverSeq);
  await db.exec(`create function pg_temp.m4_race() returns trigger language plpgsql as $$
    begin update public.operational_flight_legs set pax=7 where leg_id='${id(1)}'; return null; end $$;
    create trigger m4_race after insert on reporting.operational_canonical_flight_legs for each statement execute function pg_temp.m4_race();`);
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,false,'mid-refresh operational write must not be claimed');
  await db.exec('drop trigger m4_race on reporting.operational_canonical_flight_legs');
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,true);
  assert.equal((await result(`select pax from reporting.operational_canonical_flight_legs where ops_date='2030-03-31' and flight_number='VN900'`)).pax,7);
  await db.query('update public.operational_flight_legs set pax=0 where leg_id=$1',[id(1)]);
  await asWriter();
  const pairState = await window();
  const pair = [1,2].map(n=>({legId:id(n),expected:{linked_leg_id:null,turnaround_id:null,link_type:null,pair_anchor_date:null},patch:{linked_leg_id:id(n===1?2:1),turnaround_id:'m4-pair',link_type:'overnight',pair_anchor_date:'2030-03-31'}}));
  await reject(()=>apply(id(104),pairState.snapshot.revision,[pair[0]]),'22023');
  assert.equal((await window()).snapshot.revision,pairState.snapshot.revision,'half-pair failure rolls back row, revision and events');
  await apply(id(105),pairState.snapshot.revision,pair);
  const paired = await window();
  assert.equal(paired.legs.find(l=>l.leg_id===id(2)).linked_leg_id,id(1));
  const unlink = paired.legs.map(l=>({legId:l.leg_id,expected:{linked_leg_id:l.linked_leg_id,turnaround_id:l.turnaround_id,link_type:l.link_type,pair_anchor_date:l.pair_anchor_date},patch:{linked_leg_id:null,turnaround_id:null,link_type:null,pair_anchor_date:null}}));
  await reject(()=>apply(id(106),paired.snapshot.revision,[unlink[0]]),'22023');
  await apply(id(107),paired.snapshot.revision,unlink);
  const unpaired = await window();
  assert.deepEqual(unpaired.legs.map(l=>l.linked_leg_id),[null,null]);
  await apply(id(108),unpaired.snapshot.revision,[{legId:id(1),expected:{pax:0,counters:changes[0].patch.counters,checkin_windows:changes[0].patch.checkin_windows},patch:{pax:null,counters:[],checkin_windows:[]}}]);
  const cleared = await window();
  assert.equal(cleared.legs[0].pax,null);
  assert.deepEqual(cleared.legCounters,[]);
  assert.deepEqual(cleared.legCheckinWindows,[]);
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key='daily.write'`,[M0_FIXTURE.writerId]);
  await asWriter();
  await reject(()=>apply(id(109),cleared.snapshot.revision,changes),'42501');
  assert.equal(Number((await result('select count(*) n from public.operational_change_events')).n),6,'daily.read can consume committed operational events');
  await reject(()=>db.exec('delete from public.operational_change_events'),'42501');
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key='daily.read'`,[M0_FIXTURE.writerId]);
  await asWriter();
  assert.deepEqual((await db.query('select * from public.operational_change_events')).rows,[],'event RLS hides data without daily.read');
  await asAdmin();
  const rollbackSql = await readFile(rollback,'utf8');
  const guardSeeds = {
    operational_leg_counters: `insert into public.operational_leg_counters values('${id(1)}','T1',0,'21')`,
    operational_leg_checkin_windows: `insert into public.operational_leg_checkin_windows values('${id(1)}','21','22:00','01:00')`,
    operational_mutation_receipts: `insert into public.operational_mutation_receipts(actor_id,request_id,request_payload,result) values('${M0_FIXTURE.writerId}','${id(900)}','{}','{}')`,
    operational_change_events: `insert into public.operational_change_events(target_id,operational_date,changed_fields,before_state,after_state) values('${id(1)}','2030-03-31',array['pax'],'{}','{}')`,
  };
  for (const [table,seed] of Object.entries(guardSeeds)) {
    await db.exec('begin');
    for (const name of Object.keys(guardSeeds)) await db.exec(`delete from public.${name}`);
    await db.exec(seed);
    await assert.rejects(()=>db.exec(rollbackSql),e=>e.code==='P0001' && e.message.includes(table));
    await db.exec('rollback');
  }
  console.log('M4 mutation: backfill child allocations, clear precedence, no-season writes, preimage/revision conflicts, exact retry receipt, reciprocal pairing and projection freshness passed.');
} finally {
  await db.close();
}
