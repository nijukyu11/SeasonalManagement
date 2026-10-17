import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {buildM0Fixture,M0_FIXTURE,seasonalRow} from './seasonal_operational_separation_fixture.mjs';

let db;
try {
 const ctx=await buildM0Fixture(); db=ctx.db;
 const {asWriter,asAdmin}=ctx;
 const row=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 const rpc=async(name,params,args)=>(await row(`select public.${name}(${params}) r`,args)).r;
 const rejected=(fn,code)=>assert.rejects(fn,e=>e.code===code);
 for (const name of ['20261009110000_schedule_preview_lifecycle_v1', '20261009100000_operational_incremental_projection_v1', '20261009090000_seasonal_snapshot_integrity_indexed_v1', '20261008100000_seasonal_version_management_v1']) {
   await db.exec(await readFile(new URL(`../migrations/${name}.rollback.sql`, import.meta.url), 'utf8'));
 }
 const safetyRollback=new URL('../migrations/20261008090000_seasonal_publish_safety_v1.rollback.sql',import.meta.url);
 await db.exec(await readFile(safetyRollback,'utf8'));
 const rollback=new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url);
 await db.exec(await readFile(rollback,'utf8'));
 await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.sql',import.meta.url),'utf8'));
 const safetyMigration=new URL('../migrations/20261008090000_seasonal_publish_safety_v1.sql',import.meta.url);
 await db.exec(await readFile(safetyMigration,'utf8'));
 await asWriter();
 await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)",[M0_FIXTURE.writerId]);
 const dates=await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date+2)::text d1,((now() at time zone 'Asia/Ho_Chi_Minh')::date+3)::text d2");
 const requestId=randomUUID();
 const imported=await rpc('stage_seasonal_draft_import_v1','$1::jsonb',[JSON.stringify({requestId,checksum:requestId,seasonCode:'W99',expectedRevision:'0',fileName:'publish.xlsx',sourceRows:[seasonalRow({rowIndex:1,effective:dates.d1,discontinue:dates.d2,arrFlight:'701',arrRoute:'TPE',sta:'10:00'})]})]);
 assert.equal(imported.status,'validated',JSON.stringify(imported));
 const importedResult=await rpc('commit_seasonal_draft_import_v1','$1::uuid,$2',[imported.batchId,imported.previewHash]);
 const season=importedResult.seasonId;
 const window=()=>rpc('get_seasonal_draft_window_v1','$1',[season]);
 const preview=()=>rpc('preview_seasonal_publish_v1','$1,$2::uuid',[season,randomUUID()]);
 const commit=(p,notes='',ack=false)=>rpc('commit_seasonal_publish_v1','$1,$2::uuid,$3,$4,$5::boolean',[season,p.previewId,p.previewHash,notes,ack]);
 const patch=async(d,values)=>rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[season,randomUUID(),(await window()).revision,JSON.stringify([{draftId:d.draft_id,expected:Object.fromEntries(Object.keys(values).map(k=>[k,d[k]])),patch:values}])]);
 const getDraft=async(date)=>(await window()).drafts.find(d=>d.date===date);
 const legs=async()=>{await asAdmin();const rows=(await db.query('select to_jsonb(l) r from public.operational_flight_legs l where source_season_id=$1 order by operational_date,lineage_generation',[season])).rows.map(x=>x.r);await asWriter();return rows;};
 const otherWindow=await rpc('get_seasonal_draft_window_v1','$1',[M0_FIXTURE.seasonM26]);
 const otherPatches = [
   {draftId:'M7-OTHER-SEASON',expected:null,patch:{type:'A',airline:'JX',flight_number:'JX702',date:dates.d1,schedule:'10:00',route:'HAN'}},
   ...otherWindow.drafts
     .filter(d => ['JX801', 'JX902'].includes(d.flight_number))
     .map(d => ({draftId: d.draft_id, expected: {flight_number: d.flight_number}, patch: {flight_number: d.flight_number === 'JX801' ? 'JX881' : 'JX992'}}))
 ];
 await rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[M0_FIXTURE.seasonM26,randomUUID(),otherWindow.revision,JSON.stringify(otherPatches)]);
 const otherPreview=await rpc('preview_seasonal_publish_v1','$1,$2::uuid',[M0_FIXTURE.seasonM26,randomUUID()]);
 await rpc('commit_seasonal_publish_v1','$1,$2::uuid,$3',[M0_FIXTURE.seasonM26,otherPreview.previewId,otherPreview.previewHash]);
 await asAdmin();
 await db.query("insert into public.operational_flight_legs(leg_key,operational_date,scheduled_date,scheduled_time,side,airline,flight_number,source_type) values('A'||chr(31)||$1||chr(31)||'VN'||chr(31)||'VN999',$1::date,$1::date,'12:00','ARR','VN','VN999','operational_manual')",[dates.d1]);
 const others=(await row('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l')).r;
 await db.query('select reporting.refresh_operational_canonical_legs_v1()'); await asWriter();
 const first=await preview(); assert.equal(first.status,'ready',JSON.stringify(first));
 assert.deepEqual(first.preview.operationalCounts,{write:2,retire:0});
 const receipt=await commit(first,'first'); assert.equal(receipt.status,'committed');
 assert.deepEqual(await commit(first,'first'),receipt,'lost response retry is exact');
 await rejected(()=>commit(first,'first',true),'22023');
 await rejected(()=>commit(first,'different'),'22023');
 await rejected(()=>commit({...first,previewHash:'wrong'},'first'),'40001');
 const original=await legs(); assert.equal(original.length,2);
 assert.ok(original.every(l=>l.scheduled_time==='10:00:00'&&l.route==='TPE'&&l.lineage_generation===0));
 await asAdmin();
 const snapshot=(await row('select snapshot_payload from public.seasonal_publish_snapshots where version_id=$1',[receipt.versionId])).snapshot_payload;
 assert.equal((await row('select is_fresh from reporting.operational_projection_status_v1()')).is_fresh,false);
 await db.query('select reporting.refresh_operational_canonical_legs_v1()');
 assert.equal((await row('select is_fresh from reporting.operational_projection_status_v1()')).is_fresh,true); await asWriter();
 await patch(await getDraft(dates.d1),{schedule:'11:15',route:'ICN',pax:0,gate:12,counters:[{counter_group:'T1',item_index:0,counter_value:'21'}]});
 const second=await preview(); const stale=await preview();
 const secondReceipt=await commit(second);
 assert.equal(secondReceipt.versionTag,receipt.versionTag+'.2');
 await rejected(()=>commit(stale),'40001');
 const updated=(await legs()).find(l=>l.operational_date===dates.d1);
 assert.equal(updated.leg_id,original[0].leg_id); assert.equal(updated.route,'ICN'); assert.equal(updated.pax,0); assert.equal(updated.gate,12);
 await asAdmin();
 assert.equal((await row('select count(*)::int n from public.operational_resource_overrides where leg_id=$1',[updated.leg_id])).n,0,'Planning allocation must not become operator override');
 const revision=(await row('select revision::text r from public.operational_workspace_revision where singleton')).r; await asWriter();
 await rpc('apply_operational_resource_changes_v1','$1::uuid,$2::bigint,$3::jsonb',[randomUUID(),revision,JSON.stringify([{legId:updated.leg_id,expected:{gate:12,counters:[{counter_group:'T1',item_index:0,counter_value:'21'}]},patch:{gate:null,counters:[]}}])]);
 await patch(await getDraft(dates.d1),{pax:null,gate:20});
 const gatePrev=await preview();
 if (gatePrev.preview.requiresOperationalAcknowledgement) {
   await rejected(()=>commit(gatePrev),'40001');
   await commit(gatePrev,'',true);
 } else {
   await commit(gatePrev);
 }
 const overridden=(await legs()).find(l=>l.leg_id===updated.leg_id); assert.equal(overridden.gate,null); assert.equal(overridden.pax,null); assert.equal(overridden.counter_token,null);
 await patch(await getDraft(dates.d1),{status:'deleted',deletion_reason:'removed'});
 const removed=await preview(); assert.deepEqual(removed.preview.operationalCounts,{write:1,retire:1});
 if (removed.preview.requiresOperationalAcknowledgement) {
   await rejected(()=>commit(removed),'40001');
   await commit(removed,'',true);
 } else {
   await commit(removed);
 }
 assert.equal((await legs()).find(l=>l.leg_id===updated.leg_id).status,'deleted');
 await asAdmin(); const deleted=(await row('select to_jsonb(d) r from public.seasonal_flight_drafts d where draft_id=$1',[updated.source_draft_id])).r; await asWriter();
 await patch(deleted,{status:'active',deletion_reason:null}); await commit(await preview());
 const restored=(await legs()).find(l=>l.operational_date===dates.d1&&l.status==='active');
 assert.notEqual(restored.leg_id,updated.leg_id); assert.equal(restored.lineage_id,updated.lineage_id); assert.equal(restored.lineage_generation,1); assert.equal(restored.gate,null);
 const versions=await rpc('get_seasonal_publish_versions_v1','$1,null,1',[season]); assert.equal(versions.hasMore,true);
 const next=await rpc('get_seasonal_publish_versions_v1','$1,$2::bigint,1',[season,versions.nextSequence]); assert.notEqual(next.versions[0].version_id,versions.versions[0].version_id);
 const diff=await rpc('get_seasonal_published_diff_page_v1','$1::uuid,0,1',[receipt.versionId]); assert.equal(diff.hasMore,true); assert.equal(diff.entries[0].change_type,'added');
 await asAdmin();
 assert.deepEqual((await row('select snapshot_payload from public.seasonal_publish_snapshots where version_id=$1',[receipt.versionId])).snapshot_payload,snapshot);
 assert.deepEqual((await row('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l where source_season_id is distinct from $1',[season])).r,others);
 const draftStale=await preview(); await patch(await getDraft(dates.d1),{route:'NRT'});
 await rejected(()=>commit(draftStale),'40001');
 const expired=await preview(); await asAdmin();
 await db.query("update public.seasonal_publish_previews set expires_at=now()-interval '1 second' where preview_id=$1",[expired.previewId]);
 await asWriter(); await rejected(()=>commit(expired),'40001');
 const overrideStale=await preview(); await asAdmin();
 const currentRevision=(await row('select revision::text r from public.operational_workspace_revision where singleton')).r; await asWriter();
 await rpc('apply_operational_resource_changes_v1','$1::uuid,$2::bigint,$3::jsonb',[randomUUID(),currentRevision,JSON.stringify([{legId:restored.leg_id,expected:{gate:null},patch:{gate:27}}])]);
 await rejected(()=>commit(overrideStale),'40001');
 const daily=async(date,dailyLegs)=>{
   const staged=await rpc('stage_daily_schedule_import_v2','$1::jsonb',[JSON.stringify({contractVersion:2,requestId:randomUUID(),
     fileName:'daily.xlsx',workbookProfile:'ams',rawChecksum:'raw',canonicalChecksum:'canonical',resourcePolicyHash:'policy',
     legs:dailyLegs,affectedDates:[date],confirmedZeroFlightDates:dailyLegs.length?[]:[date],diagnostics:[]})]);
   assert.equal(staged.status,'validated',JSON.stringify(staged));
   return rpc('commit_daily_schedule_import_v2','$1::uuid,$2',[staged.batchId,staged.previewHash]);
 };
 const authorityStale=await preview(); await daily(dates.d2,[]); await rejected(()=>commit(authorityStale),'40001');
 await patch(await getDraft(dates.d2),{route:'HKG',pax:55});
 const zero=await preview(); assert.ok(zero.preview.skippedDays.includes(dates.d2));
 assert.deepEqual(zero.preview.operationalCounts,{write:1,retire:0}); await commit(zero);
 assert.equal((await legs()).filter(l=>l.operational_date===dates.d2&&l.status==='active').length,0,'Daily zero is authoritative');
 await daily(dates.d1,[{operationalDate:dates.d1,scheduledDate:dates.d1,scheduledTime:'10:00',side:'ARR',airline:'JX',flightNumber:'JX701',
   rawFlightNumber:'JX701',route:'HAN',aircraft:'321',category:'J',sourceRowNumber:1,sheetName:'AMS',resources:{pax:999,gate:7}}]);
 await asAdmin(); const dailyBefore=(await row("select to_jsonb(l) r from public.operational_flight_legs l where operational_date=$1 and status='active'",[dates.d1])).r; await asWriter();
 await patch(await getDraft(dates.d1),{pax:42,route:'SIN'});
 const dailyProtected=await preview(); assert.deepEqual(dailyProtected.preview.operationalCounts,{write:0,retire:0});
 const planningOnly=await commit(dailyProtected);
 await asAdmin();
 assert.deepEqual((await row('select to_jsonb(l) r from public.operational_flight_legs l where leg_id=$1',[dailyBefore.leg_id])).r,dailyBefore);
 assert.equal(dailyBefore.pax,999);
 assert.equal((await row('select snapshot_payload from public.seasonal_publish_snapshots where version_id=$1',[planningOnly.versionId])).snapshot_payload.flights.find(d=>d.draftId===restored.source_draft_id).pax,42);
 await asWriter();
 const moreDates=await row("select ((now() at time zone 'Asia/Ho_Chi_Minh')::date+4)::text d3,((now() at time zone 'Asia/Ho_Chi_Minh')::date+5)::text d4");
 await patch(await getDraft(dates.d1),{date:moreDates.d3,scheduled_date:moreDates.d3});
 const moved=await preview(); assert.deepEqual(moved.preview.operationalCounts,{write:1,retire:0}); await commit(moved);
 const movedLeg=(await legs()).find(l=>l.status==='active'); assert.equal(movedLeg.operational_date,moreDates.d3);
 assert.equal(movedLeg.lineage_id,restored.lineage_id); assert.equal(movedLeg.lineage_generation,dailyBefore.lineage_generation+1);
 await patch(await getDraft(moreDates.d3),{date:dates.d2,scheduled_date:dates.d2});
 const intoDaily=await preview(); assert.deepEqual(intoDaily.preview.operationalCounts,{write:0,retire:1});
 if (intoDaily.preview.requiresOperationalAcknowledgement) {
   await rejected(()=>commit(intoDaily),'40001');
   await commit(intoDaily,'',true);
 } else {
   await commit(intoDaily);
 }
 const pairChanges=[
   {draftId:'M7-PAIR-A',expected:null,patch:{type:'A',airline:'VN',flight_number:'VN801',date:moreDates.d3,schedule:'23:30',route:'HAN',
     linked_draft_id:'M7-PAIR-D',turnaround_id:'M7-PAIR',link_type:'overnight',pair_anchor_date:moreDates.d3}},
   {draftId:'M7-PAIR-D',expected:null,patch:{type:'D',airline:'VN',flight_number:'VN802',date:moreDates.d4,schedule:'06:00',route:'HAN',
     linked_draft_id:'M7-PAIR-A',turnaround_id:'M7-PAIR',link_type:'overnight',pair_anchor_date:moreDates.d3}}
 ];
 await rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[season,randomUUID(),(await window()).revision,JSON.stringify(pairChanges)]);
 await commit(await preview());
 const pair=(await legs()).filter(l=>l.status==='active'); assert.equal(pair.length,2);
 assert.equal(pair[0].linked_leg_id,pair[1].leg_id); assert.equal(pair[1].linked_leg_id,pair[0].leg_id);
 // A protected counterpart may remain linked, but cannot be rewritten to satisfy a later Planning edit.
 await asAdmin();
 await db.query("insert into public.operational_day_authority(operational_date,authority_source,source_batch_id,leg_count,canonical_checksum,committed_by) select $1,authority_source,source_batch_id,0,canonical_checksum,committed_by from public.operational_day_authority where operational_date=$2",[moreDates.d3,dates.d2]);
 const protectedBefore=(await row('select to_jsonb(l) r from public.operational_flight_legs l where leg_id=$1',[pair[0].leg_id])).r; await asWriter();
 const safePair=await preview();
 assert.equal(safePair.status,'ready'); assert.deepEqual(safePair.preview.operationalCounts,{write:1,retire:0});
 if (safePair.preview.requiresOperationalAcknowledgement) {
   await rejected(()=>commit(safePair),'40001');
   await commit(safePair,'',true);
 } else {
   await commit(safePair);
 }
 await asAdmin(); assert.deepEqual((await row('select to_jsonb(l) r from public.operational_flight_legs l where leg_id=$1',[pair[0].leg_id])).r,protectedBefore); await asWriter();
 await patch((await window()).drafts.find(d=>d.draft_id==='M7-PAIR-D'),{status:'deleted',deletion_reason:'removed'});
 const blockedPair=await preview(); assert.equal(blockedPair.status,'blocked'); assert.ok(blockedPair.preview.diagnostics.some(d=>d.code==='PROTECTED_COUNTERPART'));
 await rejected(()=>commit(blockedPair),'40001');
 const actor=randomUUID(); await asAdmin();
 await db.query("insert into auth.users(id,email) values($1,'m7-other@example.test')",[actor]);
 await db.query("insert into public.app_operators(user_id,email,username,display_name) values($1,'m7-other@example.test','m7-other','Other')",[actor]);
 await db.query("insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values($1,'seasonal.write','allow')",[actor]);
 await db.exec('set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 await rejected(()=>commit(first,'first'),'42501');
 await rejected(()=>rpc('get_seasonal_publish_versions_v1','$1',[season]),'42501');
 await asAdmin();
 await rejected(async()=>db.exec(await readFile(rollback,'utf8')),'55000'); await db.exec('rollback');
 await rejected(async()=>db.exec(await readFile(safetyRollback,'utf8')),'55000'); await db.exec('rollback');
 console.log('M7 Publish: lifecycle, allocation overrides, stale preview, exact receipts, immutable history and isolated Operations PASS');
 } catch(e) { console.error('FAILED AT:', e.stack); throw new Error(`${e.message} [${e.code??''}] ${e.where??''}`,{cause:e instanceof assert.AssertionError?e:undefined}); }
finally { if(db) await db.close(); }
