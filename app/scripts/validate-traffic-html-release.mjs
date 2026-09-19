import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {normalizeHtmlRequest} from '../supabase/functions/_shared/trafficHtmlReportContract.ts';
import {validateHtmlEnvelope} from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import {renderTrafficHtmlReport} from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';
const dir=resolve('tmp/production-html-20260906');
const queries=[
 ['weekly','report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-08-28&to=2026-09-03'],
 ['monthly','report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=2026-09&from=2026-09-01&to=2026-09-30&comparison=previous'],
 ['period','report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-01-01&to=2026-09-05'],
 ['bao','report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24']
];
if(process.argv[2]==='sql'){
 const asOf='2026-09-06T01:30:00Z';
 const sql=queries.map(([name,q])=>{
  const r=normalizeHtmlRequest(new URL('https://report.ahtops.xyz/api/report/v2/html-export?'+q)),json=JSON.stringify(r).replaceAll("'","''");
  return "select jsonb_build_object('name','"+name+"','data',h,'report', (select jsonb_agg(jsonb_build_object('direction',d,'data', public.get_public_traffic_report_v2(p_from_date=>'"+r.from+"',p_to_date=>'"+r.to+"',p_type=>d,p_comparison=>'none',p_data_as_of=>'"+asOf+"'))) from unnest(array['all','A','D']) d)) from (select public.get_public_traffic_html_export_v2('"+json+"'::jsonb,p_data_as_of=>'"+asOf+"') h) s;";
 }).join('\n');
 await writeFile(resolve(dir,'reconcile.sql'),"begin isolation level repeatable read read only;\nset statement_timeout='180s';\n"+sql+'\ncommit;\n','utf8');
}else{
 const input=process.argv[2],rows=(await readFile(resolve(dir,input),'utf8')).split('\n').filter(l=>l.startsWith('{')).map(JSON.parse),receipt=[];
 assert.equal(rows.length,4);
 for(const {name,data,report} of rows){
  await validateHtmlEnvelope(data,data.normalized_request);
  const kpi=data.resources.find(r=>r.dataset==='kpi'&&r.period_id==='current').rows;
  for(const {direction,data:v2} of report){
   const m=kpi.find(r=>r.direction===direction);
   assert.equal(String(v2.source_watermark),data.source_watermark);
   assert.equal(v2.data_as_of,data.data_as_of);
   for(const key of ['flights','reported_pax','reported_legs','due_legs','missing_due_legs','true_zero_reported_legs'])assert.equal(v2.current[key],m[key],name+'/'+direction+'/'+key);
  }
  const html=renderTrafficHtmlReport(data);await writeFile(resolve(dir,name+'-verified.html'),html,'utf8');
  receipt.push({name,watermark:data.source_watermark,as_of:data.data_as_of,bytes:Buffer.byteLength(html),rows:data.resources.reduce((n,r)=>n+r.row_count,0),directions:kpi});
 }
 await writeFile(resolve(dir,input+'.receipt.json'),JSON.stringify(receipt,null,2),'utf8');
 console.log(JSON.stringify({status:'passed',reports:receipt.map(({name,watermark,bytes,rows})=>({name,watermark,bytes,rows})),directions:'all/A/D'}));
}
