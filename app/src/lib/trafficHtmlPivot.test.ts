import assert from 'node:assert/strict';
import test from 'node:test';
import { createHtmlTestDatabase,htmlFixture } from '../../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../../supabase/functions/_shared/trafficHtmlReportModel.ts';
import type { HtmlEnvelope } from '../../supabase/functions/_shared/trafficHtmlReportContract.ts';

test('v2 daily market reconciles with v1, V2 KPI and rejects redistributed cells even if grand totals match',async()=>{
  const db=await createHtmlTestDatabase();
  try {
    for(const filter of ['', '&airline=VN','&country=Japan','&route=ICN&tz=utc']){
      const {data,request}=await htmlFixture(db,'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-09-01&to=2026-09-04'+filter);
      await validateHtmlEnvelope(data,request);
      const legacy=(await db.query<{result:HtmlEnvelope}>('select public.get_public_traffic_html_export_v1($1::jsonb,null,$2::timestamptz) result',[
        JSON.stringify({...request,contract_version:'traffic-html-data-v1'}),data.data_as_of])).rows[0].result;
      for(const resource of legacy.resources){const counterpart=data.resources.find((r:{dataset:string;period_id:string})=>r.dataset===resource.dataset&&r.period_id===resource.period_id);
        assert.deepEqual(counterpart.rows,resource.rows);assert.deepEqual(counterpart.totals,resource.totals);}
    }
    const {data,request}=await htmlFixture(db);
    const mutate=async(change:(d:typeof data)=>void,error:RegExp)=>{const copy=structuredClone(data);change(copy);await assert.rejects(validateHtmlEnvelope(copy,request),error);};
    await mutate(d=>{d.resources.find((r:{dataset:string;period_id:string})=>r.dataset==='market_daily'&&r.period_id==='current').rows[0].grain.date='2026-09-04';},/daily reconciliation/);
    await mutate(d=>{d.resources.find((r:{dataset:string;period_id:string})=>r.dataset==='market_daily'&&r.period_id==='current').rows[0].grain.airline='FORGED';},/dimension reconciliation/);
    const acl=(await db.query("select has_function_privilege('anon','public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)','execute') anon,has_function_privilege('authenticated','public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)','execute') authenticated,has_function_privilege('service_role','public.get_public_traffic_html_export_v2(jsonb,bigint,timestamptz)','execute') server")).rows[0];
    assert.deepEqual(acl,{anon:false,authenticated:false,server:true});
  }finally{await db.close();}
});

test('Bao weeks are stable without Pax and preserve full Friday-Thursday context across a season boundary',async()=>{
  const db=await createHtmlTestDatabase();
  try{
    const query='report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=W26&from=2026-10-25&to=2027-03-27';
    const before=await htmlFixture(db,query,'2026-10-26T00:00:00Z');await validateHtmlEnvelope(before.data,before.request);
    const weeks=before.data.periods.filter((p:{role:string})=>p.role==='analysis-week');
    assert.deepEqual(weeks.map((p:{from:string;to:string})=>[p.from,p.to]),[
      ['2026-10-09','2026-10-15'],['2026-10-16','2026-10-22'],['2026-10-23','2026-10-29'],['2026-10-30','2026-11-05']]);
    await db.exec('update reporting.html_fixture_candidates set effective_pax=null');
    const after=await htmlFixture(db,query,'2026-10-26T00:00:00Z');await validateHtmlEnvelope(after.data,after.request);
    assert.deepEqual(after.data.periods,before.data.periods);
    assert.equal(after.data.periods.filter((p:{role:string})=>p.role==='analysis-week').length,4);
  }finally{await db.close();}
});
