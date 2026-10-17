import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {unzipSync} from 'fflate';
import {validateHtmlEnvelope} from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
const {chromium}=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME??import.meta.url)('playwright');
const base='https://report.ahtops.xyz',dir=resolve('tmp/production-html-20260906');
const browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],receipts=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes('/html-export'))console.log(JSON.stringify({export_url:r.url(),status:r.status(),error:r.status()===200?null:await r.text()}));});
 await page.goto(base+'/reports/traffic?from=2026-08-28&to=2026-09-03&comp=none',{waitUntil:'domcontentloaded'});
 await page.getByRole('button',{name:'Xuất báo cáo',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('radio',{name:'HTML offline (.html)',exact:true}).check();
 await dialog.locator('input[name="report-type"][value="WEEKLY_DETAIL"]').check();
 await dialog.getByLabel('Từ ngày',{exact:true}).fill('2026-08-28');await dialog.getByLabel('Đến ngày',{exact:true}).fill('2026-09-03');
 await page.screenshot({path:resolve(dir,'production-export-modal.png'),fullPage:true});
 const pending=page.waitForEvent('download',{timeout:60000});await dialog.getByRole('button',{name:'Tạo và tải file',exact:true}).click();
 const download=await pending.catch(async e=>{await page.screenshot({path:resolve(dir,'production-download-failure.png'),fullPage:true});console.log(await dialog.textContent());throw e;}),target=resolve(dir,'production-dialog-weekly.html');await download.saveAs(target);
 const html=await readFile(target,'utf8'),data=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 await validateHtmlEnvelope(data,data.normalized_request);
 assert.equal(data.normalized_request.from,'2026-08-28');assert.equal(data.normalized_request.to,'2026-09-03');
 receipts.push({name:'weekly-dialog',download:download.suggestedFilename(),bytes:Buffer.byteLength(html),watermark:data.source_watermark});
 const offline=await browser.newContext({offline:true,viewport:{width:1440,height:1050}}),saved=await offline.newPage();saved.on('pageerror',e=>errors.push(e.message));
 await saved.goto(pathToFileURL(target).href);await saved.locator('main table').waitFor();
 assert.equal(await saved.getByLabel('Sắp xếp',{exact:true}).inputValue(),'flights');
 assert.equal(await saved.locator('main input[type=date],main input[type=month],main input[type=number]').count(),0);
 assert.equal(await saved.locator('section .table-tools').getByRole('button',{name:'Mở tất cả',exact:true}).count(),1);
 const rootNames=await saved.locator('.pivot-group > th').allTextContents();
 const source=data.resources.find(r=>r.dataset==='market'&&r.period_id==='current').rows;
 const flights=new Map();for(const r of source)flights.set(r.grain.airline,(flights.get(r.grain.airline)??0)+(r.flights??0));
 const scores=rootNames.map(s=>flights.get(s.replace(/^\+ /,'')));assert.ok(scores.every(n=>Number.isFinite(n)));assert.deepEqual(scores,[...scores].sort((a,b)=>b-a));
 await saved.getByRole('button',{name:'Mở tất cả',exact:true}).click();await saved.screenshot({path:resolve(dir,'production-weekly-pivot.png'),fullPage:true});
 await saved.getByRole('button',{name:'Tóm tắt và phân tích',exact:true}).click();assert.equal(await saved.locator('main > .weekly-summary tbody tr').count(),6);
 await saved.screenshot({path:resolve(dir,'production-weekly-summary.png'),fullPage:true});
 for(const [name,q] of [
  ['monthly','report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=2026-09&from=2026-09-01&to=2026-09-30&comparison=previous'],
  ['period','report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-01-01&to=2026-09-05'],
  ['bao','report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24']]){
  await new Promise(resolve=>setTimeout(resolve,10500));
  const started=Date.now(),r=await page.request.get(base+'/api/report/v2/html-export?'+q,{timeout:60000});assert.equal(r.status(),200,await r.text());assert.match(r.headers()['cache-control'],/no-store/);
  const body=await r.text(),payload=JSON.parse(body.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);await validateHtmlEnvelope(payload,payload.normalized_request);
  await writeFile(resolve(dir,'production-'+name+'.html'),body,'utf8');receipts.push({name,status:200,bytes:Buffer.byteLength(body),watermark:payload.source_watermark,seconds:(Date.now()-started)/1000});
 }
 const excel=await page.request.get(base+'/api/report/v1/workbook-export?report_type=WEEKLY_DETAIL&template_version=weekly-detail-v1&period_mode=custom&from=2026-08-28&to=2026-09-03',{timeout:60000});assert.equal(excel.status(),200);
 const zip=unzipSync(await excel.body());assert.ok(zip['[Content_Types].xml']);assert.ok(zip['xl/workbook.xml']);receipts.push({name:'xlsx-weekly',status:200,zip_parts:Object.keys(zip).length});
 const dash=await page.request.get(base+'/api/report/v1/dashboard-publication?year=2026');assert.equal(dash.status(),200);const dashboard=await dash.json();receipts.push({name:'dashboard',status:200,contract:dashboard.contract_version});
 await dialog.getByRole('button',{name:'Đóng',exact:true}).click();await page.screenshot({path:resolve(dir,'production-report-page.png'),fullPage:true});
 assert.deepEqual(errors,[]);await writeFile(resolve(dir,'public-verification.json'),JSON.stringify({status:'passed',receipts,errors},null,2),'utf8');console.log(JSON.stringify({status:'passed',receipts,errors}));
}finally{await browser.close();}
