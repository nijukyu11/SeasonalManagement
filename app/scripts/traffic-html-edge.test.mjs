import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createHtmlTestDatabase,htmlFixture} from '../supabase/tests/public_traffic_html_export_pglite.mjs';

const file=new URL('../supabase/functions/traffic-report/index.ts',import.meta.url);
const nginx=await readFile(new URL('../../deploy/traffic-report/nginx.conf',import.meta.url),'utf8');
assert.match(nginx,/zone=traffic_report_html_per_ip:10m rate=6r\/m/);
for(const name of ['nginx.conf','nginx-staging.conf']){
  const config=await readFile(new URL('../../deploy/traffic-report/'+name,import.meta.url),'utf8');
  const route=config.split('location = /api/report/v2/html-export {')[1].split('\n    }')[0];
  assert.match(route,/limit_req zone=traffic_report_html_per_ip burst=2 nodelay/);
  assert.doesNotMatch(route,/limit_req zone=traffic_report_per_ip /);
  assert.match(route,/proxy_cache off/);assert.match(route,/no-store/);
}
const source=(await readFile(file,'utf8')).replace("import 'jsr:@supabase/functions-js/edge-runtime.d.ts';",'')
  .replace("'npm:fflate@0.8.2'",JSON.stringify(import.meta.resolve('fflate')))
  .replace(/from '([^']+\.ts)'/g,(_,relative)=>`from ${JSON.stringify(new URL(relative,file).href)}`);
const env={TRAFFIC_HTML_EXPORT_ENABLED:'true',SUPABASE_URL:'https://source.test',SUPABASE_SERVICE_ROLE_KEY:'test-server-key'};
let handler;globalThis.Deno={env:{get:key=>env[key]},serve:fn=>{handler=fn;}};
const db=await createHtmlTestDatabase();const originalFetch=globalThis.fetch;
try {
  let {data}=await htmlFixture(db);let calls=0,lastArgs,fail=null;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://source.test/rest/v1/rpc/get_public_traffic_html_export_v2');
    assert.equal(options.method,'POST');assert.equal(options.headers.Authorization,'Bearer test-server-key');lastArgs=JSON.parse(options.body);
    return new Response(JSON.stringify(fail?{message:fail}:data),{status:fail?400:200});
  };
  await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const url='https://report.test/api/report/v2/html-export?html_template=weekly-detail-v1&report_type=WEEKLY_DETAIL&period_mode=custom&from=2026-09-01&to=2026-09-04';
  let response=await handler(new Request(url));assert.equal(response.status,200);assert.equal(calls,1);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-type'),/text\/html/);
  assert.match(response.headers.get('content-disposition'),/\.html"$/);assert.equal(lastArgs.p_data_as_of,null);
  const html=await response.text();assert.doesNotMatch(html,/test-server-key|source\.test|Authorization/);
  assert.equal((await handler(new Request(url,{method:'POST'}))).status,405);assert.equal(calls,1);
  assert.equal((await handler(new Request(url+'&raw=true'))).status,400);assert.equal(calls,1);
  env.TRAFFIC_HTML_EXPORT_ENABLED='false';assert.equal((await handler(new Request(url))).status,404);assert.equal(calls,1);env.TRAFFIC_HTML_EXPORT_ENABLED='true';
  const weekly=data;
  const monthlyUrl='https://report.test/api/report/v2/html-export?html_template=period-analysis-v1&report_type=MONTHLY_OVERVIEW_L2&period_mode=month&month=2026-09&from=2026-09-01&to=2026-09-30&comparison=previous&comparison=year_ago';
  data=(await htmlFixture(db,new URL(monthlyUrl).search.slice(1))).data;
  const before=calls;response=await handler(new Request(monthlyUrl));assert.equal(response.status,200);assert.equal(calls,before+1);
  assert.match(response.headers.get('content-disposition'),/tong-quan-khai-thac-thang/);
  assert.match(await response.text(),/previous_year_ago/);
  // An older SQL envelope missing the fourth month must fail closed, not export three months silently.
  data.periods=data.periods.filter(p=>p.id!=='previous_year_ago');assert.equal((await handler(new Request(monthlyUrl))).status,422);
  data=weekly;data.resources[0].filter_hash='bad';assert.equal((await handler(new Request(url))).status,422);
  for(const [reason,status] of [['HTML_RESOURCE_BUDGET',413],['DATA_VERSION_CHANGED',409],['HTML_PERIOD_UNAVAILABLE',422],['RPC not installed',503]]){
    fail=reason;response=await handler(new Request(url));assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.doesNotMatch(await response.text(),new RegExp(reason));
  }
  console.log(JSON.stringify({suite:'traffic-html-edge-behavior',status:'passed'}));
} finally {globalThis.fetch=originalFetch;delete globalThis.Deno;await db.close();}
