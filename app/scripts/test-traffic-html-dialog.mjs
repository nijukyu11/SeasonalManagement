import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHtmlTestDatabase,htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

// Run after a report-only build with both export feature flags enabled.
const {chromium}=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME??import.meta.url)('playwright');
const server=spawn(process.execPath,['scripts/traffic-report-preview-server.mjs'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TRAFFIC_REPORT_PREVIEW_ROOT:'out-report',TRAFFIC_REPORT_PREVIEW_PORT:'4177'}});
let browser,db;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('preview startup timeout')),10000);server.once('error',reject);server.once('exit',code=>reject(new Error(`preview exited ${code}`)));server.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
  db=await createHtmlTestDatabase();browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage();const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/report/v2/html-export?*',async route=>{
    const url=new URL(route.request().url());requests.push(url.pathname+url.search);
    assert.equal(route.request().headers().accept,'text/html');
    assert.equal(url.searchParams.get('html_template'),url.searchParams.get('report_type')==='WEEKLY_DETAIL'?'weekly-detail-v1':'period-analysis-v1');
    assert.equal(url.searchParams.has('template_version'),false);
    const {request,data}=await htmlFixture(db,url.search.slice(1));await validateHtmlEnvelope(data,request);
    await route.fulfill({status:200,headers:{'content-type':'text/html; charset=utf-8','content-disposition':'attachment; filename="offline-dialog.html"','cache-control':'no-store'},body:renderTrafficHtmlReport(data)});
  });
  await page.goto('http://127.0.0.1:4177/reports/traffic');
  await page.getByRole('button',{name:'Xuất báo cáo',exact:true}).click();
  const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByRole('radio',{name:'HTML offline (.html)',exact:true}).isChecked(),true);
  await dialog.getByRole('radio',{name:'HTML offline (.html)',exact:true}).check();
  await dialog.locator('input[name="report-type"][value="PERIOD_ANALYSIS"]').check();
  assert.equal(await dialog.getByText('Kỳ báo cáo',{exact:true}).isVisible(),true);
  assert.equal(await dialog.getByText(/File đã tải giữ cố định kỳ này/).isVisible(),true);
  for(const [mode,label] of [['Một tháng','Tháng báo cáo'],['Nhiều tháng','Từ tháng'],['Cả năm','Năm báo cáo'],['Cả mùa','Mùa khai thác'],['Khoảng ngày','Từ ngày']]){
    await dialog.getByRole('radio',{name:mode,exact:true}).check();
    await dialog.getByLabel(new RegExp(`^${label}`)).waitFor({state:'visible'});
  }
  await dialog.locator('input[name="report-type"][value="WEEKLY_DETAIL"]').check();
  const downloadPromise=page.waitForEvent('download');
  await dialog.getByRole('button',{name:'Tạo và tải file',exact:true}).click();
  const download=await downloadPromise;
  assert.equal(download.suggestedFilename(),'offline-dialog.html');
  const dir=resolve('tmp/html-offline-20260905');await mkdir(dir,{recursive:true});
  const target=resolve(dir,'dialog-download.html');await download.saveAs(target);
  assert.match(await readFile(target,'utf8'),/<!doctype html>/);
  assert.equal(requests.length,1);
  await dialog.getByRole('button',{name:'Đóng',exact:true}).click();
  await page.getByRole('button',{name:'Xuất báo cáo',exact:true}).click();
  assert.equal(await dialog.getByRole('radio',{name:'HTML offline (.html)',exact:true}).isChecked(),true);
  await page.screenshot({path:resolve(dir,'export-dialog.png'),fullPage:true});
  await dialog.getByRole('radio',{name:'HTML offline (.html)',exact:true}).check();
  await dialog.locator('input[name="report-type"][value="MONTHLY_OVERVIEW_L2"]').check();
  await dialog.getByLabel('Tháng báo cáo',{exact:true}).fill('2026-09');
  assert.equal(await dialog.getByText(/Tự động thêm tháng trước của năm trước/).isVisible(),true);
  const monthlyDownloadPromise=page.waitForEvent('download');
  await dialog.getByRole('button',{name:'Tạo và tải file',exact:true}).click();
  const monthlyDownload=await monthlyDownloadPromise,monthlyTarget=resolve(dir,'monthly-dialog-download.html');await monthlyDownload.saveAs(monthlyTarget);
  assert.match(await readFile(monthlyTarget,'utf8'),/previous_year_ago/);assert.equal(requests.length,2);
  assert.deepEqual(errors,[]);
  await writeFile(resolve(dir,'dialog-validation.json'),JSON.stringify({status:'passed',html_requests:requests.length,monthly_four_periods:true,html_default_preserved:true,browser_errors:errors},null,2),'utf8');
  console.log(JSON.stringify({suite:'traffic-html-dialog',status:'passed'}));
} finally {await db?.close();await browser?.close();server.kill();}
