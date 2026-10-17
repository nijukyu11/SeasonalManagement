import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {buildM0Fixture,M0_FIXTURE,seasonalRow} from './seasonal_operational_separation_fixture.mjs';

const ctx=await buildM0Fixture();
const {db,asWriter,asAdmin}=ctx;
const migration=new URL('../migrations/20260928200000_seasonal_draft_import_v1.sql',import.meta.url);
const rollback=new URL('../migrations/20260928200000_seasonal_draft_import_v1.rollback.sql',import.meta.url);
const rpc=async(name,params,args)=>(await db.query(`select public.${name}(${params}) r`,args)).rows[0].r;
const rejected=async(fn,code)=>assert.rejects(fn,e=>e.code===code);
const window=()=>rpc('get_seasonal_draft_window_v1','$1',[M0_FIXTURE.seasonW26]);
const make=async(rows,strategy='merge',extra={})=>{
 const w=await window(); const requestId=randomUUID();
 return {requestId,checksum:requestId,seasonId:M0_FIXTURE.seasonW26,seasonCode:'W26',strategy,
   expectedEpoch:w.epoch,expectedRevision:w.revision,fileName:'planning.xlsx',sourceRows:rows,...extra};
};
const stage=p=>rpc('stage_seasonal_draft_import_v1','$1::jsonb',[JSON.stringify(p)]);
const commit=p=>rpc('commit_seasonal_draft_import_v1','$1::uuid,$2',[p.batchId,p.previewHash]);
const draft=async(flight)=>(await window()).drafts.find(d=>d.flight_number===flight&&d.date==='2026-10-25');
const patch=async(d,changes)=>rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[
 M0_FIXTURE.seasonW26,randomUUID(),(await window()).revision,JSON.stringify([{draftId:d.draft_id,
   expected:Object.fromEntries(Object.keys(changes).map(k=>[k,d[k]])),patch:changes}])]);
try {
 await asAdmin();
 for (const name of ['20261016100000_operational_daily_full_import_v2', '20261016090000_seasonal_full_import_v1', '20261009110000_schedule_preview_lifecycle_v1', '20261009100000_operational_incremental_projection_v1', '20261009090000_seasonal_snapshot_integrity_indexed_v1', '20261008100000_seasonal_version_management_v1', '20261008090000_seasonal_publish_safety_v1']) {
   await db.exec(await readFile(new URL(`../migrations/${name}.rollback.sql`, import.meta.url), 'utf8'));
 }
 await asAdmin(); await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url),'utf8'));
 await asAdmin(); await db.exec(await readFile(rollback,'utf8')); await db.exec(await readFile(migration,'utf8'));
 await asWriter(); await db.query("select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)",[M0_FIXTURE.writerId]);
 await asAdmin();
 await db.query("update public.seasons set effective_end='2027-03-27' where id=$1",[M0_FIXTURE.seasonW26]);
 const operations=(await db.query('select jsonb_agg(to_jsonb(o) order by leg_id) r from public.operational_flight_legs o')).rows[0].r;
 const legacy=(await db.query('select jsonb_agg(to_jsonb(o) order by record_id) r from public.season_flight_records o')).rows[0].r;
 const legacyVersion=(await db.query('select data_version from public.seasons where id=$1',[M0_FIXTURE.seasonW26])).rows[0].data_version;
 await db.query('select reporting.refresh_operational_canonical_legs_v1()'); await asWriter();
 const original=await draft('JX701');
 const input=await make([seasonalRow({rowIndex:1,arrFlight:'701',arrRoute:'ICN',sta:'11:15'})]);
 const staged=await stage(input); assert.equal(staged.status,'validated',JSON.stringify(staged));
 assert.deepEqual(await stage(input),staged);
 await rejected(()=>stage({...input,fileName:'changed.xlsx'}),'22023');
 assert.equal((await draft('JX701')).schedule,'10:00');
 const details=await rpc('get_seasonal_draft_import_preview_v1','$1::uuid,null,1',[staged.batchId]);
 assert.equal(details.entries[0].operation,'upsert'); assert.equal(details.hasMore,true);
 await rejected(()=>rpc('commit_seasonal_import_v3','$1::uuid,$2::integer,$3',[staged.batchId,legacyVersion,staged.previewHash]),'42501');
 await rejected(()=>rpc('commit_seasonal_import_v2','$1::uuid,$2::integer',[staged.batchId,legacyVersion]),'0A000');
 const committed=await commit(staged); assert.equal(committed.status,'committed');
 assert.deepEqual(await commit(staged),committed);
 assert.equal((await db.query('select effective_end from public.seasons where id=$1',[M0_FIXTURE.seasonW26])).rows[0].effective_end,'2027-03-27','merge retains the full season range');
 assert.deepEqual(await rpc('get_seasonal_draft_import_status_v1','$1::uuid',[input.requestId]),committed);
 const updated=await draft('JX701');
 assert.equal(updated.draft_id,original.draft_id); assert.equal(updated.schedule,'11:15'); assert.equal(updated.route,'ICN');
 assert.equal(updated.pax,180); assert.equal(updated.gate,20); assert.equal(updated.stand,'31');
 assert.ok((await window()).drafts.some(d=>d.flight_number==='JX801'),'merge retains outside scope');
 await patch(updated,{status:'deleted',deletion_reason:'operator_deleted'});
 const restore=await stage(await make(input.sourceRows,'replace'));
 assert.equal(restore.status,'validated',JSON.stringify(restore)); await commit(restore);
 const revived=await draft('JX701'); assert.equal(revived.status,'active'); assert.equal(revived.deletion_reason,null);
 assert.equal((await window()).drafts.some(d=>d.flight_number==='JX801'),false,'replace removes absent imported rows');
 const allocations={pax:0,gate:null,counters:[{counter_group:'X',item_index:0,counter_value:'30'}],
   checkin_windows:[{counter_key:'30',window_start:'08:00',window_end:'10:00'}]};
 await patch(revived,allocations);
 const reimport=await stage(await make([seasonalRow({rowIndex:1,arrFlight:'701',arrRoute:'KIX',sta:'12:15'})]));
 await commit(reimport); const rebased=await draft('JX701');
 for(const [key,value] of Object.entries(allocations)) assert.deepEqual(rebased[key],value,key);
 const stale=await stage(await make(input.sourceRows)); await patch(rebased,{pax:null});
 await rejected(()=>commit(stale),'40001');
 assert.equal((await rpc('get_seasonal_draft_import_preview_v1','$1::uuid',[stale.batchId])).stale,true);
 const cancelled=await stage(await make(input.sourceRows));
 assert.equal((await rpc('cancel_seasonal_draft_import_v1','$1::uuid',[cancelled.batchId])).status,'cancelled');
 await rejected(()=>commit(cancelled),'40001');
 const expired=await stage(await make(input.sourceRows)); await asAdmin();
 await db.query("update public.season_import_batches set expires_at=now()-interval '1 minute' where batch_id=$1",[expired.batchId]);
 await asWriter(); await rejected(()=>commit(expired),'40001');
 const manualIds=['M6-IMPORT-MANUAL','M6-IMPORT-RETAINED'];
 await rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[
   M0_FIXTURE.seasonW26,randomUUID(),(await window()).revision,JSON.stringify(manualIds.map((draftId,index)=>({
     draftId,expected:null,patch:{type:index?'D':'A',airline:'JX',flight_number:index?'JX999':'JX701',route:'SGN',
       date:'2026-10-25',schedule:index?'13:00':'12:00',pax:0,gate:88,linked_draft_id:manualIds[1-index],
       turnaround_id:'manual-import-pair',link_type:'sameday',pair_anchor_date:'2026-10-25'}
   })))]);
 const collision=await stage(await make(input.sourceRows));
 assert.equal(collision.status,'failed'); await rejected(()=>commit(collision),'40001');
 const replacement=await stage(await make(input.sourceRows,'replace'));
 assert.equal(replacement.status,'validated',JSON.stringify(replacement));
 assert.equal(replacement.counts.supersedeManualCount,1); assert.equal(replacement.counts.unlinkCount,1);
 await commit(replacement);
 const manualRebase=await draft('JX701');
 assert.equal(manualRebase.gate,88); assert.equal(manualRebase.pax,0);
 assert.deepEqual(manualRebase.counters,[]); assert.deepEqual(manualRebase.checkin_windows,[]);
 const retained=(await window()).drafts.find(d=>d.draft_id===manualIds[1]);
 assert.equal(retained.source_kind,'manual'); assert.equal(retained.linked_draft_id,null);
 assert.equal(retained.link_id,retained.draft_id,'import unlink clears the old display/export pair identity');
 assert.equal(retained.linked_source_row_index,null);
 const unchanged=await stage(await make(input.sourceRows));
 assert.equal(unchanged.counts.unchangedCount,2); assert.equal(unchanged.counts.baselineUpdateCount,0);
 await commit(unchanged);
 const duplicate=await stage(await make([...input.sourceRows,
   seasonalRow({rowIndex:2,effective:'2026-10-25',discontinue:'2026-10-25',arrFlight:'701',arrRoute:'SGN',sta:'13:15'})]));
 assert.equal(duplicate.status,'validated',JSON.stringify(duplicate));
 assert.ok(duplicate.warnings.some(w=>w.code==='duplicate-occurrence-resolved'));
 const other=randomUUID(); await asAdmin();
 await db.query("insert into auth.users(id,email) values($1,'m6-import-other@example.test')",[other]);
 await db.query("insert into public.app_operators(user_id,email,username,display_name) values($1,'m6-import-other@example.test','m6-import-other','Other')",[other]);
 await db.query("insert into public.app_operator_permission_overrides(user_id,permission_key,effect) values($1,'seasonal.write','allow')",[other]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]); await db.exec('set role authenticated');
 await rejected(()=>commit(unchanged),'42501');
 await rejected(()=>rpc('get_seasonal_draft_import_status_v1','$1::uuid',[input.requestId]),'42501');
 await rejected(()=>rpc('get_seasonal_draft_import_preview_v1','$1::uuid',[unchanged.batchId]),'42501');
 await rejected(()=>rpc('cancel_seasonal_draft_import_v1','$1::uuid',[duplicate.batchId]),'42501');
 await rejected(()=>stage(input),'42501');
 await rejected(()=>stage({...input,requestId:randomUUID(),strategy:'replace'}),'42501');
 await asWriter();
 const newRequest=randomUUID();
 const newSeason=await stage({requestId:newRequest,checksum:newRequest,seasonCode:'N30',strategy:'merge',expectedRevision:'0',
   sourceRows:[seasonalRow({rowIndex:1,effective:'2030-06-01',discontinue:'2030-06-01',airline:'VN',arrFlight:'101',arrRoute:'SGN',sta:'23:30',
     depFlight:'102',depRoute:'SGN',std:'01:00'})]});
 assert.equal(newSeason.status,'validated',JSON.stringify(newSeason)); await commit(newSeason);
 const pair=(await rpc('get_seasonal_draft_window_v1','$1',[newSeason.seasonId])).drafts;
 assert.equal(pair.length,2); assert.equal(pair[0].linked_draft_id,pair[1].draft_id); assert.equal(pair[1].linked_draft_id,pair[0].draft_id);
 assert.equal(pair.find(d=>d.type==='D').scheduled_date,'2030-06-02');
 const racePayload={seasonCode:'R26',strategy:'merge',expectedRevision:'0',sourceRows:input.sourceRows};
 const firstRace=await stage({...racePayload,requestId:randomUUID(),checksum:'first'});
 const secondRace=await stage({...racePayload,requestId:randomUUID(),checksum:'second'});
 await commit(firstRace); await rejected(()=>commit(secondRace),'40001');
 // Another season can claim an opaque draft ID after staging; never overwrite it.
 const identityInput=await make([seasonalRow({rowIndex:1,arrFlight:'888',arrRoute:'ICN',sta:'10:00'})]);
 const identityStage=await stage(identityInput); assert.equal(identityStage.status,'validated');
 const foreignId=await rpc('seasonal_draft_id_v1',"$1,'A','2026-10-25'::date,'JX','JX888'",[M0_FIXTURE.seasonW26]);
 const otherWindow=await rpc('get_seasonal_draft_window_v1','$1',[M0_FIXTURE.seasonM26]);
 await rpc('apply_seasonal_draft_changes_v1','$1,$2::uuid,$3::bigint,$4::jsonb',[
   M0_FIXTURE.seasonM26,randomUUID(),otherWindow.revision,JSON.stringify([{draftId:foreignId,expected:null,
     patch:{type:'A',airline:'VN',flight_number:'VN888',route:'SGN',date:'2026-10-25',schedule:'08:00'}}])]);
 await rejected(()=>commit(identityStage),'40001');
 const foreign=(await rpc('get_seasonal_draft_window_v1','$1',[M0_FIXTURE.seasonM26])).drafts.find(d=>d.draft_id===foreignId);
 assert.equal(foreign.flight_number,'VN888'); assert.equal(foreign.route,'SGN'); assert.equal(foreign.schedule,'08:00');
 const identityRestage=await stage({...identityInput,requestId:randomUUID()});
 assert.equal(identityRestage.status,'failed');
 assert.ok(identityRestage.diagnostics.some(d=>d.code==='draft-id-ownership-conflict'));
 await asAdmin();
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(o) order by leg_id) r from public.operational_flight_legs o')).rows[0].r,operations);
 assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(o) order by record_id) r from public.season_flight_records o')).rows[0].r,legacy);
 assert.equal((await db.query('select is_fresh from reporting.operational_projection_status_v1()')).rows[0].is_fresh,true);
 await rejected(async()=>db.exec(await readFile(rollback,'utf8')),'55000');
 console.log('M6 draft import PASS: parser reuse, merge/replace, exact receipts, legacy commit fence, time/presence precedence, allocation/Pax preservation, stale/cancel/expiry, new season overnight pair, Operations and legacy isolation');
} finally { await db.close(); }
