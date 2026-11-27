import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openM0FixtureDb, seedM0OperatorsAndSeasons, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
import { rollbackChainMigrationsAfter } from './seasonal_operational_separation_test_support.mjs';

const ctx = await openM0FixtureDb();
const { db, asWriter, asAdmin } = ctx;
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const window = async (overrides = {}) => {
  const p = { start: '2030-03-30', end: '2030-04-02', resource: 'all', size: 2, cursor: null, token: null, ...overrides };
  return (await db.query(`select public.get_operational_schedule_allocation_window_v1($1::date,$2::date,$3,$4,$5::date,$6::time,$7::uuid,$8) as result`,
    [p.start,p.end,p.resource,p.size,p.cursor?.operationalDate ?? null,p.cursor?.scheduledTime ?? null,p.cursor?.legId ?? null,p.token])).rows[0].result;
};
const rejected = async (fn, code) => assert.rejects(fn, (e) => e.code === code);
try {
  await seedM0OperatorsAndSeasons(ctx);
  // No season contains these dates. Equal times must still paginate by leg UUID.
  for (const [n, date, time, status] of [[1,'2030-03-30','23:00','active'],[2,'2030-03-31','06:00','active'],[3,'2030-03-31','06:00','active'],[4,'2030-04-01','07:00','active'],[5,'2030-04-02','08:00','deleted'],[6,'2030-04-03','09:00','active']]) {
    await db.query(`insert into public.operational_flight_legs(leg_id,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type,status,deletion_reason,pax)
      values($1, 'A'||chr(31)||$2||chr(31)||'VN'||chr(31)||$3,$2::date,$2::date,$4::time,'ARR','VN',$3,'operational_manual',$5,case when $5='deleted' then 'test' end,case when $3='VN1' then null else 0 end)`,
      [id(n),date,`VN${n}`,time,status]);
  }
  await db.query(`update public.operational_flight_legs set linked_leg_id=$1, turnaround_id='outside' where leg_id=$2`,[id(6),id(1)]);
  await db.exec(`insert into public.operational_gate_resources(id,label) values('m4-gate','Gate M4'); insert into public.operational_checkin_counters(id,label) values('m4-counter','Counter M4');`);
  await asWriter();
  const first = await window();
  assert.deepEqual(first.legs.map(l=>l.leg_id),[id(1),id(2)]);
  assert.equal(first.legs[0].source_season_id,null);
  assert.equal(first.legs[0].pax,null);
  assert.equal(first.legs[1].pax,0);
  assert.equal(first.resources.operational_gate_resources.find(r=>r.id==='m4-gate').label,'Gate M4');
  assert.deepEqual(first.linkedLegs.map(l=>l.leg_id),[id(6)]);
  const second = await window({ cursor:first.page.nextCursor, token:first.snapshot.token });
  assert.deepEqual(second.legs.map(l=>l.leg_id),[id(3),id(4)]);
  assert.equal(second.page.hasMore,false);
  assert.equal(second.page.nextCursor,null);
  assert.deepEqual((await window({start:'2031-01-01',end:'2031-01-01'})).legs,[]);
  assert.equal((await window({resource:'gate',token:first.snapshot.token})).status,'snapshot_changed');
  assert.equal((await window({end:'2030-04-01',token:first.snapshot.token})).status,'snapshot_changed');
  await rejected(()=>window({cursor:first.page.nextCursor}), '22023');
  await rejected(()=>window({cursor:{legId:id(1)},token:first.snapshot.token}), '22023');
  await rejected(()=>window({size:1001}), '22023');
  await rejected(()=>window({size:0}), '22023');
  await rejected(()=>window({start:'2030-01-01',end:'2031-01-02'}), '22023');
  await rejected(()=>window({start:'2030-04-03'}), '22023');
  await rejected(()=>window({resource:'bogus'}), '22023');
  await rejected(()=>db.query(`update public.operational_workspace_revision set revision=0`),'42501');

  await asAdmin();
  await db.exec('begin');
  await db.query(`update public.operational_flight_legs set pax=111 where leg_id=$1`,[id(2)]);
  await db.exec('rollback');
  await asWriter();
  assert.equal((await window({token:first.snapshot.token})).status,'ok','rolled-back write must not invalidate committed snapshot');
  await asAdmin();
  await db.query(`update public.operational_flight_legs set pax=222 where leg_id=$1`,[id(2)]);
  await asWriter();
  assert.equal((await window({cursor:first.page.nextCursor,token:first.snapshot.token})).status,'snapshot_changed');
  const edited = await window();
  assert.equal(edited.legs[1].pax,222);
  await asAdmin();
  await db.exec(`update public.operational_gate_resources set label='Changed M4' where id='m4-gate'`);
  await asWriter();
  assert.equal((await window({token:edited.snapshot.token})).status,'snapshot_changed','resource edit invalidates page');
  const resourceEdited = await window();
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key='daily.read'`,[M0_FIXTURE.writerId]);
  await asWriter();
  await rejected(()=>window(),'42501');
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='allow' where user_id=$1 and permission_key='daily.read'`,[M0_FIXTURE.writerId]);
  await db.exec('set role anon');
  await rejected(()=>window(),'42501');
  await asAdmin();
  const windowRollback = await readFile(new URL('../migrations/20260928160000_operational_window_v1.rollback.sql',import.meta.url),'utf8');
  await assert.rejects(()=>db.exec(windowRollback),e=>e.code==='P0001' && e.message.includes('Rollback M4 mutations'));
  await db.exec('rollback');
  await rollbackChainMigrationsAfter(db, '20260929120000_seasonal_operational_reader_cutover_v1.sql');
  await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928200000_seasonal_draft_import_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928190000_seasonal_planning_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928180000_operational_daily_import_v2.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928170000_operational_mutations_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928160000_operational_window_v1.rollback.sql',import.meta.url),'utf8'));
  assert.equal(Number((await db.query('select count(*) as n from public.operational_flight_legs')).rows[0].n),6,'rollback retains business rows');
  await db.exec(await readFile(new URL('../migrations/20260928160000_operational_window_v1.sql',import.meta.url),'utf8'));
  await asWriter();
  assert.equal((await window({token:resourceEdited.snapshot.token})).status,'snapshot_changed','reinstallation cannot resurrect an old page token');
  console.log('M4 window: no-season range, equal-time pagination, linked context, NULL/0 Pax, resource changes, scope-bound snapshot, rollback and permission boundaries passed.');
} finally {
  await db.close();
}
