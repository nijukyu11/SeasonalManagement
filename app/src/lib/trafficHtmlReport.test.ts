import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHtmlRequest,sumHtmlMetrics,compareHtmlMetrics } from '../../supabase/functions/_shared/trafficHtmlReportContract.ts';
import { validateHtmlEnvelope } from '../../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../../supabase/functions/_shared/trafficHtmlReportRenderer.ts';
import { createHtmlTestDatabase,htmlFixture } from '../../supabase/tests/public_traffic_html_export_pglite.mjs';

test('HTML contract is separate from Excel and rejects mismatched templates and invalid dates',()=>{
  const base='https://report.test/?report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-09-01&to=2026-09-04';
  assert.equal(normalizeHtmlRequest(new URL(base)).html_template,'weekly-detail-v1');
  for(const query of [base+'&template_version=weekly-detail-v1',base+'&html_template=weekly-detail-v1',base+'&unknown=1',base.replace('2026-09-01','2026-02-30'),base.replace('weekly-detail-v1','period-analysis-v1')]) assert.throws(()=>normalizeHtmlRequest(new URL(query)));
});
test('offline math preserves missing, true zero and suppresses incomplete Pax comparisons',()=>{
  const empty=sumHtmlMetrics([]); const zero={...sumHtmlMetrics([],'complete'),reported_pax:0,reported_legs:1,due_legs:1,flights:1,unreported_legs:0};
  assert.equal(sumHtmlMetrics([empty],'complete').flights,null);
  assert.equal(sumHtmlMetrics([zero]).reported_pax,0);
  assert.deepEqual(compareHtmlMetrics(zero,zero,'reported_pax'),{delta:0,percent:null});
  assert.deepEqual(compareHtmlMetrics({...zero,unreported_legs:1},zero,'reported_pax'),{delta:null,percent:null});
});
test('monthly has four calendar months and prior-year MoM only when both comparisons are selected',async()=>{
  const db=await createHtmlTestDatabase();
  try {
    for(const [month,prior,days] of [['2026-09','2025-08',31],['2026-01','2024-12',31],['2025-03','2024-02',29],['2025-02','2024-01',31]] as const){
      const from=`${month}-01`,to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
      const query=`report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=${month}&from=${from}&to=${to}`;
      const {request,data}=await htmlFixture(db,query+'&comparison=previous&comparison=year_ago');
      const context=data.periods.find((p:{id:string})=>p.id==='previous_year_ago');
      assert.ok(context,'missing previous month of prior year');
      assert.equal(context.from,`${prior}-01`);assert.equal(context.calendar_days,days);
      assert.equal(data.periods.length,4);assert.equal(data.resources.length,28);
      if(month==='2025-02')assert.equal(data.periods.find((p:{id:string})=>p.id==='year_ago').calendar_days,29);
      assert.deepEqual(data.comparison_pairs.map((p:{minuend_period:string;baseline_period:string})=>[p.minuend_period,p.baseline_period]),[
        ['current','previous'],['current','year_ago'],['year_ago','previous_year_ago']]);
      await validateHtmlEnvelope(data,request);
      const missing=structuredClone(data);missing.periods.pop();
      await assert.rejects(validateHtmlEnvelope(missing,request),/period/);
      for(const comparison of ['', '&comparison=previous','&comparison=year_ago']){
        const selected=await htmlFixture(db,query+comparison);await validateHtmlEnvelope(selected.data,selected.request);
        assert.equal(selected.data.periods.length,comparison?2:1);
      }
    }
  } finally { await db.close(); }
});
test('SQL envelope validates totals, hashes, presence, unique leaves and every resource',async()=>{
  const db=await createHtmlTestDatabase();
  try {
    const {request,data}=await htmlFixture(db);
    await validateHtmlEnvelope(data,request);
    const html=renderTrafficHtmlReport(data);
    assert.match(html,/<!doctype html>/);
    assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=/);
    const mutate=async(fn: (copy: typeof data)=>void,pattern:RegExp)=>{ const copy=structuredClone(data); fn(copy); await assert.rejects(validateHtmlEnvelope(copy,request),pattern); };
    await mutate(d=>d.resources.pop(),/resource count/);
    await mutate(d=>d.request_hash='0'.repeat(64),/request hash/);
    await mutate(d=>d.resources[0].filter_hash='0'.repeat(64),/resource hash/);
    await mutate(d=>{const r=d.resources.find((r:{dataset:string})=>r.dataset==='market'); r.rows.push(r.rows[0]); r.row_count++;},/duplicate bucket/);
    await mutate(d=>{const row=d.resources.find((r:{dataset:string})=>r.dataset==='market').rows.find((r:{reported_pax:number|null})=>r.reported_pax===null);row.reported_pax=0;},/Pax presence/);
    await mutate(d=>{const row=d.resources.find((r:{dataset:string})=>r.dataset==='market').rows.find((r:{reported_pax:number|null})=>r.reported_pax!==null); row.reported_pax++;},/total/);
  } finally {await db.close();}
});
