import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildM0Fixture,M0_FIXTURE } from './seasonal_operational_separation_fixture.mjs';
const {db,asWriter,asAdmin}=await buildM0Fixture();
const id=n=>`60000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let request=100;
const row=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
const window=async(size=500,after=null,epoch=null,revision=null)=>(await row('select public.get_seasonal_draft_window_v1($1,$2,$3,$4::uuid,$5::bigint) r',[M0_FIXTURE.seasonW26,size,after,epoch,revision])).r;
const preview=async(req=id(request++))=>(await row(`select public.preview_seasonal_publish_v1($1,$2::uuid,'2026-10-01') r`,[M0_FIXTURE.seasonW26,req])).r;
const page=async(p,after=0,size=100)=>(await row('select public.get_seasonal_publish_preview_page_v1($1::uuid,$2,$3::bigint,$4) r',[p.previewId,p.previewHash,after,size])).r;
const apply=async(revision,changes,req=id(request++))=>(await row('select public.apply_seasonal_draft_changes_v1($1,$2::uuid,$3::bigint,$4::jsonb) r',[M0_FIXTURE.seasonW26,req,revision,JSON.stringify(changes)])).r;
const patch=(d,values)=>({draftId:d.draft_id,expected:Object.fromEntries(Object.keys(values).map(k=>[k,d[k]])),patch:values});
const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const rollback=new URL('../migrations/20260928190000_seasonal_planning_v1.rollback.sql',import.meta.url);
try {
  for (const name of ['20261016100000_operational_daily_full_import_v2', '20261016090000_seasonal_full_import_v1', '20261009110000_schedule_preview_lifecycle_v1', '20261009100000_operational_incremental_projection_v1', '20261009090000_seasonal_snapshot_integrity_indexed_v1', '20261008100000_seasonal_version_management_v1', '20261008090000_seasonal_publish_safety_v1']) {
    await db.exec(await readFile(new URL(`../migrations/${name}.rollback.sql`, import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('../migrations/20260928210000_seasonal_publish_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../migrations/20260928200000_seasonal_draft_import_v1.rollback.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(rollback,'utf8'));
  // Older shadow snapshots cannot reconstruct missing historical pairing.
  await db.exec('begin');
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  await asAdmin();
  await reject(async()=>db.exec(await readFile(new URL('../migrations/20260928190000_seasonal_planning_v1.sql',import.meta.url),'utf8')),'55000');
  await db.exec('rollback');
  await db.exec(await readFile(new URL('../migrations/20260928190000_seasonal_planning_v1.sql',import.meta.url),'utf8'));
  await asWriter();
  await db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]);
  const first=await window(2);
  assert.equal(first.hasMore,true);
  const next=await window(2,first.nextDraftId,first.epoch,first.revision);
  assert.equal(new Set([...first.drafts,...next.drafts].map(d=>d.draft_id)).size,4);
  const initial=await preview();
  assert.deepEqual(initial.preview.planningCounts,{added:0,modified:0,removed:0,unchanged:5,ambiguous:0},'Planning excludes Daily and operational manual legs');
  assert.deepEqual((await page(initial)).entries,[],'full baseline has no artificial diff from absent pairing fields');
  assert.ok(initial.preview.skippedDays.includes(M0_FIXTURE.dailyDate));
  await asAdmin();
  const operationalBefore=(await row('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l')).r;
  const oldSnapshot=(await row('select snapshot_payload from public.seasonal_publish_snapshots where version_id=$1',[initial.preview.baseVersionId])).snapshot_payload;
  await db.query('select reporting.refresh_operational_canonical_legs_v1()');
  await asWriter();
  const full=await window();
  const selected=full.drafts.find(d=>d.flight_number==='JX701'&&d.date==='2026-10-25');
  const req=id(request++);
  const changes=[patch(selected,{schedule:'11:15',route:'ICN',aircraft:'789',pax:null})];
  const receipt=await apply(full.revision,changes,req);
  assert.deepEqual(await apply(full.revision,changes,req),receipt);
  await reject(()=>apply(full.revision,[patch(selected,{pax:12})],req),'22023');
  await reject(()=>apply(full.revision,[patch(selected,{pax:12})]),'40001');
  assert.equal((await window(2,first.nextDraftId,first.epoch,first.revision)).status,'snapshot_changed');
  const changed=await preview();
  assert.deepEqual(changed.preview.planningCounts,{added:0,modified:1,removed:0,unchanged:4,ambiguous:0});
  const diff=(await page(changed)).entries[0];
  assert.equal(diff.source_draft_id,selected.draft_id);
  assert.equal(diff.before_state.schedule,'10:00');
  assert.equal(diff.after_state.schedule,'11:15');
  assert.equal(diff.after_state.pax,null);
  assert.ok(diff.changed_fields.includes('route'));
  assert.equal((await page(initial)).stale,true);
  const changedWindow=await window();
  await reject(()=>apply(changedWindow.revision,[{draftId:selected.draft_id,expected:{pax:180},patch:{pax:3}}]),'40001');
  await reject(()=>apply(changedWindow.revision,[{draftId:selected.draft_id,expected:{season_id:M0_FIXTURE.seasonW26},patch:{season_id:M0_FIXTURE.seasonM26}}]),'22023');
  await reject(()=>row('select public.get_seasonal_draft_export_snapshot_v1($1,$2::uuid,$3::bigint)',[M0_FIXTURE.seasonW26,first.epoch,first.revision]),'PT409');
  const exported=(await row('select public.get_seasonal_draft_export_snapshot_v1($1,$2::uuid,$3::bigint) r',[M0_FIXTURE.seasonW26,changedWindow.epoch,changedWindow.revision])).r;
  assert.equal(exported.flightRecords.find(d=>d.record_id===selected.draft_id).schedule,'11:15');
  assert.equal(exported.flightRecords.find(d=>d.record_id===selected.draft_id).pax,null);
  await asAdmin();
  assert.deepEqual((await row('select jsonb_agg(to_jsonb(l) order by leg_id) r from public.operational_flight_legs l')).r,operationalBefore,'draft edits never write Operations');
  assert.equal((await row('select is_fresh from reporting.operational_projection_status_v1()')).is_fresh,true,'draft edits do not dirty the operational projection');
  assert.deepEqual((await row('select snapshot_payload from public.seasonal_publish_snapshots where version_id=$1',[initial.preview.baseVersionId])).snapshot_payload,oldSnapshot,'published planning snapshot is immutable');
  // Business identity fallback: changing time/route still modifies one planning leg.
  const base=oldSnapshot.flights.find(f=>f.draftId===selected.draft_id);
  const diffRows=async(before,after)=>(await db.query('select * from public.seasonal_planning_diff_v1($1::jsonb,$2::jsonb)',[JSON.stringify({flights:before}),JSON.stringify({flights:after})])).rows;
  const fallback=await diffRows([base],[{...base,draftId:'new-id',schedule:'15:00',scheduledTime:'15:00',route:'NRT'}]);
  assert.deepEqual(fallback.map(d=>d.change_type),['modified']);
  const ambiguous=await diffRows([base,{...base,draftId:'old-2',schedule:'12:00'}],[{...base,draftId:'new-1',schedule:'13:00'},{...base,draftId:'new-2',schedule:'14:00'}]);
  assert.deepEqual(ambiguous.map(d=>d.change_type),['ambiguous','ambiguous','ambiguous','ambiguous']);
  const exactTimes=await diffRows([base,{...base,draftId:'old-2',schedule:'12:00'}],[{...base,draftId:'new-1',route:'NRT'},{...base,draftId:'new-2',schedule:'12:00',route:'ICN'}]);
  assert.deepEqual(exactTimes.map(d=>d.change_type),['modified','modified']);
  const splitLineage=await diffRows([base],[{...base,draftId:'split-1',supersedesDraftId:base.draftId,flightNumber:'JX991'},{...base,draftId:'split-2',supersedesDraftId:base.draftId,flightNumber:'JX992'}]);
  assert.deepEqual(splitLineage.map(d=>d.change_type),['ambiguous','ambiguous','ambiguous'],'one prior lineage cannot silently become two matched flights');
  await asWriter();
  const w=await window();
  const toDelete=w.drafts.filter(d=>d.date==='2026-10-25');
  await apply(w.revision,toDelete.map(d=>patch(d,{status:'deleted',deletion_reason:'planning_removed'})));
  const removed=await preview();
  assert.equal(removed.preview.planningCounts.removed,toDelete.length,'removing every draft on a day keeps all old rows in the diff');
  const page1=await page(removed,0,1);
  assert.equal(page1.entries[0].change_type,'removed');
  assert.equal(page1.hasMore,true);
  const page2=await page(removed,page1.nextIndex,1);
  assert.notEqual(page2.entries[0].source_draft_id,page1.entries[0].source_draft_id);
  await asAdmin();
  await db.query(`update public.operational_day_authority set authority_revision=authority_revision+1 where operational_date=$1`,[M0_FIXTURE.dailyDate]);
  await asWriter();
  assert.equal((await page(removed)).stale,true,'Daily scope change invalidates an approved preview');
  await reject(()=>db.query(`select public.run_seasonal_operational_backfill_v1('2026-10-01',$1::uuid)`,[M0_FIXTURE.writerId]),'55000');
  const fresh=await window();
  const createReq=id(request++);
  await apply(fresh.revision,[{draftId:'M6-NEW',expected:null,patch:{type:'D',airline:'VN',flight_number:'VN999',route:'SGN',date:'2026-11-01',schedule:'04:59',aircraft:'A321',pax:0,counters:[{counter_group:'T1',item_index:0,counter_value:'21'}],checkin_windows:[{counter_key:'21',window_start:'22:00',window_end:'01:00'}]}}],createReq);
  const added=(await window()).drafts.find(d=>d.draft_id==='M6-NEW');
  assert.equal(added.operational_date,'2026-10-31');
  assert.equal(added.pax,0);
  assert.equal(added.source_kind,'manual');
  assert.equal((await preview()).preview.planningCounts.added,1);
  const allocationWindow=await window();
  await apply(allocationWindow.revision,[patch(added,{counters:[
    {counter_group:'T1',item_index:1,counter_value:'22'},{counter_group:'T1',item_index:0,counter_value:'21'}
  ]})]);
  const orderedWindow=await window();
  const ordered=orderedWindow.drafts.find(d=>d.draft_id==='M6-NEW');
  assert.deepEqual(ordered.counters.map(c=>c.counter_value),['21','22']);
  const beforeReorderPreview=await preview();
  await asAdmin();
  const allocationBefore=(await row(`select public.seasonal_draft_planning_state_v1(d) r from public.seasonal_flight_drafts d where draft_id='M6-NEW'`)).r;
  await asWriter();
  await apply(orderedWindow.revision,[patch(ordered,{counters:[...ordered.counters].reverse()})]);
  assert.equal((await page(beforeReorderPreview)).stale,true,'revision-bound preview stays stale even when values are equivalent');
  await asAdmin();
  const allocationAfter=(await row(`select public.seasonal_draft_planning_state_v1(d) r from public.seasonal_flight_drafts d where draft_id='M6-NEW'`)).r;
  assert.deepEqual((await diffRows([allocationBefore],[allocationAfter])).map(d=>d.change_type),['unchanged'],'allocation order cannot invent a Planning change');
  await asWriter();
  const pairWindow=await window();
  const dep=pairWindow.drafts.find(d=>d.draft_id==='M6-NEW');
  const depLink=patch(dep,{linked_draft_id:'M6-ARR',turnaround_id:'M6-PAIR',link_type:'overnight',pair_anchor_date:'2026-10-31'});
  await reject(()=>apply(pairWindow.revision,[depLink]),'22023');
  assert.equal((await window()).revision,pairWindow.revision,'half-pair rejection is atomic');
  await apply(pairWindow.revision,[depLink,{draftId:'M6-ARR',expected:null,patch:{
    type:'A',airline:'VN',flight_number:'VN998',route:'SGN',date:'2026-10-31',schedule:'23:00',
    linked_draft_id:'M6-NEW',turnaround_id:'M6-PAIR',link_type:'overnight',pair_anchor_date:'2026-10-31'
  }}]);
  const paired=await window();
  assert.equal(paired.drafts.find(d=>d.draft_id==='M6-NEW').link_id,'M6-PAIR','link identity used by existing grids follows the persisted turnaround');
  const pairExport=(await row('select public.get_seasonal_draft_export_snapshot_v1($1,$2::uuid,$3::bigint) r',[M0_FIXTURE.seasonW26,paired.epoch,paired.revision])).r;
  assert.equal(pairExport.flightRecords.find(d=>d.record_id==='M6-NEW').link_id,'M6-PAIR');
  const pairReceipt=await apply(paired.revision,[
    patch(paired.drafts.find(d=>d.draft_id==='M6-ARR'),{status:'deleted',deletion_reason:'planning_removed'}),
    patch(paired.drafts.find(d=>d.draft_id==='M6-NEW'),{pax:null})
  ]);
  const survivor=(await window()).drafts.find(d=>d.draft_id==='M6-NEW');
  assert.deepEqual([survivor.linked_draft_id,survivor.turnaround_id,survivor.link_type,survivor.pair_anchor_date,survivor.pax],[null,null,null,null,null]);
  const survivorReceipt=pairReceipt.events.filter(e=>e.draftId==='M6-NEW').at(-1).after;
  assert.equal(survivorReceipt.linked_draft_id,null);
  assert.equal(survivorReceipt.pax,null);
  assert.equal(survivor.link_id,survivor.draft_id,'deleting a counterpart clears the grouping identity too');
  // The 05:00 boundary may put an operational day before season metadata.
  await asAdmin();
  const dates=await row(`select today::text today,(today+2)::text ops,(today+3)::text scheduled,(today+5)::text last
    from (select (now() at time zone 'Asia/Ho_Chi_Minh')::date today) x`);
  await db.query(`insert into public.seasons(id,season_code,name,file_name,uploaded_at,effective_start,effective_end,total_legs,total_source_rows,data_version)
    values('m6-boundary','W99','Boundary','',0,$1,$2,0,0,0)`,[dates.scheduled,dates.last]);
  await asWriter();
  const boundaryWindow=(await row(`select public.get_seasonal_draft_window_v1('m6-boundary') r`)).r;
  await row(`select public.apply_seasonal_draft_changes_v1('m6-boundary',$1::uuid,$2::bigint,$3::jsonb)`,
    [id(request++),boundaryWindow.revision,JSON.stringify([{draftId:'M6-EARLY',expected:null,patch:{
      type:'A',airline:'VN',flight_number:'VN997',route:'SGN',date:dates.scheduled,schedule:'04:59'
    }}])]);
  const boundaryPreview=(await row(`select public.preview_seasonal_publish_v1('m6-boundary',$1::uuid,$2::date) r`,[id(request++),dates.today])).r;
  assert.equal(boundaryPreview.preview.rangeStart,dates.ops);
  assert.ok(boundaryPreview.preview.publishableDays.includes(dates.ops));
  const zero=(await row(`select public.stage_daily_schedule_import_v2($1::jsonb) r`,[JSON.stringify({
    contractVersion:2,requestId:id(request++),fileName:'zero.xlsx',canonicalChecksum:'zero',affectedDates:[dates.ops],
    confirmedZeroFlightDates:[dates.ops],legs:[],diagnostics:[]
  })])).r;
  await row(`select public.commit_daily_schedule_import_v2($1::uuid,$2)`,[zero.batchId,zero.previewHash]);
  assert.equal((await page(boundaryPreview)).stale,true,'authority before metadata start is inside the real operational scope');
  const skipped=(await row(`select public.preview_seasonal_publish_v1('m6-boundary',$1::uuid,$2::date) r`,[id(request++),dates.today])).r;
  assert.ok(skipped.preview.skippedDays.includes(dates.ops));
  assert.equal(skipped.preview.operationalCounts.write,0,'zero-flight Daily protects the day before season start');
  assert.equal(skipped.preview.planningCounts.added,1,'Daily protection does not erase the Planning change');
  await asAdmin();
  await reject(async()=>db.exec(await readFile(rollback,'utf8')),'55000');
  await db.exec('rollback');
  await db.query(`insert into public.app_operator_permission_overrides(user_id,permission_key,effect)
    values($1,'seasonal.read','deny'),($1,'seasonal.write','deny'),($1,'detailed.read','allow'),($1,'detailed.write','allow')
    on conflict(user_id,permission_key) do update set effect=excluded.effect`,[M0_FIXTURE.writerId]);
  await asWriter();
  const detailedWindow=await window();
  await reject(()=>preview(),'42501','Detailed access does not grant Publish');
  const group=Array.from({length:366},(_,i)=>{
    const date=new Date(Date.UTC(2027,0,1+i)).toISOString().slice(0,10);
    return {draftId:`M8-GROUP-${i}`,expected:null,patch:{type:'A',airline:'VN',flight_number:'VN888',route:'HAN',date,schedule:'10:00'}};
  });
  const groupReceipt=await apply(detailedWindow.revision,group);
  assert.equal(groupReceipt.events.length,366);
  const detailedCurrent=await window();
  const groupExport=(await row('select public.get_seasonal_draft_export_snapshot_v1($1,$2::uuid,$3::bigint) r',[M0_FIXTURE.seasonW26,detailedCurrent.epoch,detailedCurrent.revision])).r;
  assert.deepEqual(groupExport.flightRecords.filter(d=>d.record_id.startsWith('M8-GROUP-')).map(d=>d.date).sort(),group.map(d=>d.patch.date).sort(),'a complete seasonal group persists and exports through Detailed-only permission');
  assert.equal((await row('select count(*)::int n from public.seasonal_draft_events where season_id=$1 and target_id=$2',[M0_FIXTURE.seasonW26,'M8-GROUP-365'])).n,1,'Detailed-only clients can receive their authoritative draft event');
  const firstGroup=detailedCurrent.drafts.find(d=>d.draft_id==='M8-GROUP-0');
  const lastGroup=detailedCurrent.drafts.find(d=>d.draft_id==='M8-GROUP-365');
  await reject(()=>apply(detailedCurrent.revision,[patch(firstGroup,{pax:30}),{draftId:lastGroup.draft_id,expected:{pax:999},patch:{pax:40}}]),'40001');
  assert.equal((await window()).drafts.find(d=>d.draft_id==='M8-GROUP-0').pax,null,'a failed group operation does not partially save');
  await asAdmin();
  await db.query(`update public.app_operator_permission_overrides set effect='deny' where user_id=$1 and permission_key in('seasonal.write','detailed.write')`,[M0_FIXTURE.writerId]);
  await asWriter();
  await reject(()=>preview(),'42501');
  await reject(()=>apply('0',[{draftId:'NO',expected:null,patch:{type:'A'}}]),'42501');
  console.log('M6 planning PASS: revision/field conflicts, exact receipts, draft-only writes, immutable baseline, semantic matching/ambiguity, removed empty days, scoped preview staleness, paged diff and version-pinned export');
} finally { await db.close(); }
