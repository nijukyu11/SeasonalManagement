import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture, M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
const { db, asWriter, asAdmin } = await buildM0Fixture();
const id = n => `50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let sequence=100;
const result=async(sql,params=[]) => (await db.query(sql,params)).rows[0];
const rpc=async(name,value) => (await result(`select public.${name}($1::jsonb) r`,[JSON.stringify(value)])).r;
const stage=p=>rpc('stage_daily_schedule_import_v2',p);
const commit=p=>result('select public.commit_daily_schedule_import_v2($1::uuid,$2) r',[p.batchId,p.previewHash]).then(x=>x.r);
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const leg=(date,side='ARR',number='VN900',row=1,resources={pax:null,gate:3})=>({
  operationalDate:date,scheduledDate:date,scheduledTime:'06:00',side,airline:'VN',flightNumber:number,
  rawFlightNumber:number,route:'HAN',aircraft:'A321',category:'C',sourceRowNumber:row,sheetName:'AMS',resources,
});
const payload=(legs,dates=[...new Set(legs.map(l=>l.operationalDate))],zero=[])=>({
  contractVersion:2,requestId:id(sequence++),fileName:'daily.xlsx',workbookProfile:'ams',rawChecksum:'raw',
  canonicalChecksum:'canonical',resourcePolicyHash:'policy',legs,affectedDates:dates,confirmedZeroFlightDates:zero,diagnostics:[],
});
const active=async(date)=>{await asAdmin();return (await db.query(`select * from public.operational_flight_legs where operational_date=$1 and status='active' order by side,flight_number`,[date])).rows;};
const rollback=new URL('../migrations/20260928180000_operational_daily_import_v2.rollback.sql',import.meta.url);
try {
  await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928200000_seasonal_draft_import_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928190000_seasonal_planning_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(rollback,'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928180000_operational_daily_import_v2.sql',import.meta.url),'utf8'));
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  await asAdmin();
  const legacyBefore=(await db.query(`select to_jsonb(r) r from public.season_flight_records r order by record_id`)).rows;
  await db.query(`insert into public.operational_flight_legs(leg_id,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type)
    values($1,'A'||chr(31)||'2030-03-31'||chr(31)||'VN'||chr(31)||'VN901','2030-03-31','2030-03-31','06:00','ARR','VN','VN901','operational_manual')`,[id(1)]);
  assert.deepEqual((await result(`select o.fields from public.operational_resource_overrides o join public.operational_flight_legs l using(leg_id) where l.flight_number='JX701' and l.operational_date='2026-10-25'`)).fields,{gate:20,stand:'31',carousel:4});
  await asWriter();
  const firstPayload=payload([leg('2030-03-31'),leg('2030-04-01','DEP')]);
  const first=await stage(firstPayload);
  assert.equal(first.status,'validated',JSON.stringify(first.diagnostics));
  assert.equal(first.preview.replacedBySource.operational_manual,1);
  assert.equal(first.preview.replacedLegs[0].legId,id(1));
  assert.deepEqual(await stage(firstPayload),first,'stage retry preserves batch and preview');
  await reject(()=>stage({...firstPayload,fileName:'changed.xlsx'}),'23505');
  await reject(()=>result(`select public.commit_daily_schedule_import_v1($1::uuid,'{}'::jsonb,$2) r`,[first.batchId,first.previewHash]),'PT409');
  const receipt=await commit(first);
  assert.equal(receipt.status,'committed');
  assert.deepEqual(await commit(first),receipt,'commit retry returns persisted receipt');
  await reject(()=>commit({...first,previewHash:'wrong'}),'PT409');
  await asAdmin();
  await db.query(`insert into auth.users(id,email) values($1,'m5-other@example.test')`,[id(2)]);
  await db.query(`insert into public.app_operators(user_id,email,username,display_name) values($1,'m5-other@example.test','m5-other','Other')`,[id(2)]);
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values($1,'daily.write','allow')`,[id(2)]);
  await db.exec('set role authenticated');
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id(2)]);
  await reject(()=>commit(first),'P0002');
  await reject(()=>result('select public.cancel_daily_schedule_import_v2($1::uuid)',[first.batchId]),'P0002');
  assert.equal((await result('select public.get_daily_schedule_import_v2_status($1::uuid) r',[firstPayload.requestId])).r,null);
  const own=await stage(firstPayload);
  assert.notEqual(own.batchId,first.batchId,'request IDs are scoped by owner');
  await asWriter();
  const arrival=(await active('2030-03-31'))[0];
  const departure=(await active('2030-04-01'))[0];
  assert.equal(arrival.linked_leg_id,departure.leg_id);
  assert.equal(departure.linked_leg_id,arrival.leg_id);
  assert.equal(arrival.link_type,'overnight');
  assert.equal(arrival.source_season_id,null);
  assert.equal(arrival.pax,null);
  await asWriter();
  await reject(()=>db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]),'55000');
  const snapshot=(await result(`select public.get_operational_schedule_allocation_window_v1('2030-03-31','2030-04-01') r`)).r.snapshot;
  await result(`select public.apply_operational_resource_changes_v1($1::uuid,$2::bigint,$3::jsonb)`,[id(sequence++),snapshot.revision,JSON.stringify([
    {legId:arrival.leg_id,expected:{gate:3,pax:null,counters:[],checkin_windows:[]},patch:{gate:null,pax:77,counters:[{counter_group:'T1',item_index:0,counter_value:'21'}],checkin_windows:[{counter_key:'21',window_start:'22:00',window_end:'01:00'}]}}
  ])]);
  const second=await stage(payload([{...leg('2030-03-31','ARR','VN900',8,{pax:0,gate:8,counter:'22'}),scheduledTime:'09:15'}]));
  assert.equal(second.preview.rebaseCount,1);
  assert.equal(second.preview.replacedBySource.daily_import,1);
  await commit(second);
  const replacement=(await active('2030-03-31'))[0];
  assert.equal(replacement.gate,null,'explicit operator clear survives new AMS gate');
  assert.equal(replacement.pax,0,'AMS zero never inherits operator Pax');
  assert.equal(replacement.linked_leg_id,null,'AMS row without departure unlinks');
  assert.equal(replacement.lineage_id,arrival.lineage_id);
  assert.equal(replacement.scheduled_time,'09:15:00','time changes do not break loose identity rebase');
  assert.equal(Number(replacement.lineage_generation),1);
  assert.equal((await active('2030-04-01'))[0].linked_leg_id,null,'outside-date survivor unlinks');
  assert.deepEqual((await db.query('select counter_value from public.operational_leg_counters where leg_id=$1',[replacement.leg_id])).rows,[{counter_value:'21'}]);
  assert.equal((await result('select window_end from public.operational_leg_checkin_windows where leg_id=$1',[replacement.leg_id])).window_end,'01:00');
  assert.equal((await result('select status from public.operational_flight_legs where leg_id=$1',[arrival.leg_id])).status,'deleted');
  await asWriter();
  const third=await stage(payload([leg('2030-04-01','DEP','VN900',4,{pax:null,gate:9})]));
  await commit(third);
  assert.equal((await active('2030-04-01'))[0].gate,9,'prior raw AMS gate is not an operator override');
  await asWriter();
  const sparse=await stage(payload([leg('2030-04-03'),leg('2030-04-05','DEP')]));
  await commit(sparse);
  await asAdmin();
  assert.equal(Number((await result(`select count(*) n from public.operational_day_authority where operational_date='2030-04-04'`)).n),0,'sparse workbook does not invent middle dates');
  await asWriter();
  await reject(()=>stage(payload([],[])),'22023');
  const unconfirmed=await stage(payload([],['2030-03-31']));
  assert.equal(unconfirmed.status,'failed');
  assert.equal(unconfirmed.diagnostics[0].code,'DAILY_ZERO_FLIGHT_CONFIRMATION');
  await reject(()=>commit(unconfirmed),'PT409');
  const zero=await stage(payload([],['2030-03-31'],['2030-03-31']));
  await commit(zero);
  assert.deepEqual(await active('2030-03-31'),[]);
  assert.equal((await result(`select leg_count from public.operational_day_authority where operational_date='2030-03-31'`)).leg_count,0);
  await asWriter();
  const restored=await stage(payload([leg('2030-03-31','ARR','VN900',1,{pax:null,gate:6})]));
  assert.equal(restored.status,'validated','multiple terminals of the same lineage remain unambiguous');
  await commit(restored);
  const restoredLeg=(await active('2030-03-31'))[0];
  assert.equal(restoredLeg.pax,null);
  assert.equal(restoredLeg.gate,null);
  assert.equal(Number(restoredLeg.lineage_generation),2);
  await asWriter();
  const stale=await stage(payload([leg('2030-03-31')]));
  await asAdmin();
  await db.query('update public.operational_flight_legs set pax=45 where leg_id=$1',[restoredLeg.leg_id]);
  await asWriter();
  await reject(()=>commit(stale),'PT409');
  assert.equal((await active('2030-03-31'))[0].pax,45,'stale preview makes no replacement');
  await asWriter();
  const unrelated=await stage(payload([leg('2030-04-05','DEP')]));
  await asAdmin();
  await db.query('update public.operational_flight_legs set pax=46 where leg_id=$1',[restoredLeg.leg_id]);
  await asWriter();
  await commit(unrelated);
  const cancelled=await stage(payload([leg('2030-04-06')]));
  assert.equal((await result('select public.cancel_daily_schedule_import_v2($1::uuid) r',[cancelled.batchId])).r.status,'cancelled');
  await reject(()=>commit(cancelled),'PT409');
  const expiredPayload=payload([leg('2030-04-07')]);
  const expired=await stage(expiredPayload);
  await asAdmin();
  await db.query(`update public.daily_schedule_import_batches set expires_at=now()-interval '1 minute' where batch_id=$1`,[expired.batchId]);
  await asWriter();
  assert.equal((await result('select public.get_daily_schedule_import_v2_status($1::uuid) r',[expiredPayload.requestId])).r.status,'expired');
  await reject(()=>commit(expired),'PT409');
  const duplicate=await stage(payload([leg('2030-04-08'),{...leg('2030-04-08'),scheduledTime:'07:00',sourceRowNumber:2}]));
  assert.equal(duplicate.status,'failed');
  assert.ok(duplicate.diagnostics.some(d=>d.code==='DAILY_LOOSE_IDENTITY_COLLISION'));
  const boundary=await stage(payload([{...leg('2030-04-09'),scheduledTime:'04:59',scheduledDate:'2030-04-10'}]));
  assert.equal(boundary.status,'validated','04:59 belongs to previous operational day');
  await commit(boundary);
  // Two active sources conflict; one active wins over unrelated terminal history.
  await asAdmin();
  await db.query(`insert into public.operational_flight_legs(leg_id,leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type)
    values($1,'A'||chr(31)||'2030-03-31'||chr(31)||'VN'||chr(31)||'VN900','2030-03-31','2030-03-31','07:00','ARR','VN','VN900','operational_manual')`,[id(3)]);
  await asWriter();
  const collision=await stage(payload([leg('2030-03-31')]));
  assert.equal(collision.status,'failed');
  assert.ok(collision.diagnostics.some(d=>d.code==='DAILY_LOOSE_IDENTITY_COLLISION'));
  await asAdmin();
  await db.query(`update public.operational_flight_legs set status='deleted',deletion_reason='fixture' where leg_id=$1`,[id(3)]);
  await asWriter();
  assert.equal((await stage(payload([leg('2030-03-31')]))).status,'validated');
  const clearForTerminal=await stage(payload([],['2030-03-31'],['2030-03-31']));
  await commit(clearForTerminal);
  const terminalCollision=await stage(payload([leg('2030-03-31')]));
  assert.equal(terminalCollision.status,'failed');
  assert.ok(terminalCollision.diagnostics.some(d=>d.code==='DAILY_LOOSE_IDENTITY_COLLISION'));
  await asAdmin();
  await db.query(`update public.operational_flight_legs set status='active',deletion_reason=null where leg_id=$1`,[restoredLeg.leg_id]);
  const seasonalDay='2026-10-25';
  await asWriter();
  const seasonalImport=await stage(payload([{...leg(seasonalDay,'ARR','JX701',1,{pax:null,gate:3,stand:'20A',carousel:2}),airline:'JX',scheduledTime:'11:15'}]));
  assert.equal(seasonalImport.preview.replacedLegs.find(l=>l.flightNumber==='JX701').sourceType,'published_seasonal');
  await commit(seasonalImport);
  const rebasedLegacy=await active(seasonalDay);
  assert.equal(rebasedLegacy.length,1);
  assert.deepEqual([rebasedLegacy[0].gate,rebasedLegacy[0].stand,rebasedLegacy[0].carousel,rebasedLegacy[0].pax],[20,'31',4,null]);
  await asWriter();
  const seasonalZero=await stage(payload([],[seasonalDay],[seasonalDay]));
  await commit(seasonalZero);
  assert.deepEqual(await active(seasonalDay),[],'Daily zero replaces all active legs');
  // Same flight on two calendar dates inside one 05:00 operational day.
  const overnightDay='2031-01-01';
  const overnightLegs=[
    {...leg(overnightDay,'DEP','VN818',1,{pax:0,gate:3}),scheduledTime:'12:00'},
    {...leg(overnightDay,'DEP','VN818',2,{pax:null,gate:4}),scheduledDate:'2031-01-02',scheduledTime:'01:30'},
  ];
  await asWriter();
  const overnightFirst=await stage(payload(overnightLegs));
  assert.equal(overnightFirst.status,'validated',JSON.stringify(overnightFirst.diagnostics));
  assert.equal((await commit(overnightFirst)).status,'committed');
  const overnightBefore=(await active(overnightDay)).sort((a,b)=>a.scheduled_date-b.scheduled_date);
  assert.deepEqual(overnightBefore.map(l=>l.pax),[0,null]);
  await asWriter();
  const overnightSnapshot=(await result(`select public.get_operational_schedule_allocation_window_v1($1::date,$1::date) r`,[overnightDay])).r.snapshot;
  await result(`select public.apply_operational_resource_changes_v1($1::uuid,$2::bigint,$3::jsonb)`,[
    id(sequence++),overnightSnapshot.revision,JSON.stringify(overnightBefore.map((l,i)=>({
      legId:l.leg_id,expected:{gate:l.gate},patch:{gate:11+i},
    }))),
  ]);
  const overnightMoved=overnightLegs.map((l,i)=>({...l,scheduledTime:i?'02:00':'13:00'}));
  const overnightAgain=await stage(payload(overnightMoved));
  assert.equal(overnightAgain.status,'validated',JSON.stringify(overnightAgain.diagnostics));
  const overnightReceipt=await commit(overnightAgain);
  assert.equal(overnightReceipt.status,'committed');
  assert.deepEqual(await commit(overnightAgain),overnightReceipt);
  const overnightAfter=(await active(overnightDay)).sort((a,b)=>a.scheduled_date-b.scheduled_date);
  assert.deepEqual(overnightAfter.map(l=>[l.lineage_id,Number(l.lineage_generation),l.gate,l.pax,l.scheduled_time]),
    overnightBefore.map((l,i)=>[l.lineage_id,1,11+i,i?null:0,i?'02:00:00':'13:00:00']),
    're-import keeps the two calendar-day lineages and their own operator overrides');
  await asWriter();
  const overnightEmpty=await stage(payload([],[overnightDay],[overnightDay]));
  await commit(overnightEmpty);
  const overnightRestore=await stage(payload(overnightMoved));
  assert.equal(overnightRestore.status,'validated',JSON.stringify(overnightRestore.diagnostics));
  await commit(overnightRestore);
  const overnightRestored=(await active(overnightDay)).sort((a,b)=>a.scheduled_date-b.scheduled_date);
  assert.deepEqual(overnightRestored.map(l=>[l.lineage_id,Number(l.lineage_generation),l.gate]),
    overnightBefore.map((l,i)=>[l.lineage_id,2,11+i]),
    'terminal lookup restores each scheduled date without cross-date collision');
  await asAdmin();
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  assert.equal((await result('select * from reporting.operational_projection_status_v1()')).is_fresh,true);
  assert.equal((await result(`select pax from reporting.operational_canonical_flight_legs where ops_date='2030-03-31' and flight_number='VN900'`)).pax,46);
  assert.deepEqual((await db.query(`select to_jsonb(r) r from public.season_flight_records r order by record_id`)).rows,legacyBefore,'V2 never mutates legacy schedule');
  await reject(async()=>db.exec(await readFile(rollback,'utf8')),'55000');
  await db.exec('rollback');
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key='daily.write'`,[M0_FIXTURE.writerId]);
  await asWriter();
  await reject(()=>stage(payload([leg('2030-04-11')])),'42501');
  await reject(()=>commit(receipt),'42501');
  console.log('M5 Daily V2 PASS: no-season scope, zero/sparse dates, receipts, stale preimages, overlay provenance, Pax NULL/0, lineage, pairing, expiry/cancel, projection, legacy isolation');
} finally { await db.close(); }
