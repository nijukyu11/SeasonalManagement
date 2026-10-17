import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHtmlTestDatabase,htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

const require=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME ?? import.meta.url);
const {chromium}=require('playwright');
const output=resolve('tmp/html-offline-20260905');await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:process.env.TRAFFIC_BROWSER_CHANNEL??'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},offline:true});
const page=await context.newPage();const errors=[],network=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
const db=await createHtmlTestDatabase();
const receipts=[];
async function artifact(name,query){
  const {request,data}=await htmlFixture(db,query);await validateHtmlEnvelope(data,request);
  const html=renderTrafficHtmlReport(data);const path=resolve(output,name+'.html');await writeFile(path,html,'utf8');
  const start=performance.now();await page.goto(pathToFileURL(path).href);await page.locator('main h2').first().waitFor();
  receipts.push({name,bytes:Buffer.byteLength(html),open_ms:Math.round(performance.now()-start),rows:data.resources.reduce((a,r)=>a+r.row_count,0)});
  if(['WEEKLY_DETAIL','MONTHLY_OVERVIEW_L2'].includes(data.normalized_request.report_type)){await page.locator('main h2').waitFor();assert.equal(await page.getByRole('button',{name:'Bảng pivot mẫu',exact:true}).count(),1);}
  return data;
}
try {
  await artifact('bao-cao-tuan');
  assert.equal(await page.locator('main h2').textContent(),'Tổng quan');
  assert.equal(await page.locator('main > .weekly-summary tbody tr').count(),6);
  assert.match(await page.locator('main > .weekly-summary tr[data-measure="all-reported_pax"]').textContent(),/150/);
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();
  const totalBefore=await page.locator('.grand-total').first().textContent();
  await page.getByRole('searchbox').fill('Korea');
  assert.equal(await page.locator('.grand-total').first().textContent(),totalBefore);
  assert.match(await page.locator('.notice').last().textContent(),/thiếu/);
  await page.getByRole('searchbox').fill('');
  const group=page.locator('button[data-group]').first();await group.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('button[data-group]').first().getAttribute('aria-expanded'),'true');
  await page.getByText('Bộ lọc và sắp xếp',{exact:true}).click();
  await page.getByLabel('Quốc gia',{exact:true}).selectOption('"Korea"');
  assert.match(await page.locator('.grand-total').first().textContent(),/2/);
  await page.getByRole('button',{name:'Chặng bay',exact:true}).click();
  assert.equal(await page.locator('.grand-total').first().textContent(),totalBefore);
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();
  assert.equal(await page.getByLabel('Quốc gia',{exact:true}).inputValue(),'"Korea"');
  await page.getByRole('button',{name:'Đặt lại',exact:true}).click();
  assert.equal(await page.getByLabel('Quốc gia',{exact:true}).inputValue(),'');
  await page.getByLabel('Chiều',{exact:true}).selectOption('A');
  assert.equal(await page.locator('main > .weekly-comparison').count(),1);
  await page.getByRole('button',{name:'Đặt lại',exact:true}).click();
  await page.getByRole('button',{name:'Mở toàn bộ',exact:true}).click();
  await page.screenshot({path:resolve(output,'weekly-desktop.png'),fullPage:true});
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('.toolbar').isVisible(),false);
  assert.equal(await page.locator('.print-context').isVisible(),true);
  await page.screenshot({path:resolve(output,'weekly-print.png'),fullPage:true});await page.emulateMedia({media:'screen'});
  await page.setViewportSize({width:375,height:812});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(output,'weekly-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});

  await artifact('phan-tich-theo-ky','report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=year&year=2026&from=2026-01-01&to=2026-12-31&comparison_year=2025&comparison_year=2024');
  await page.getByRole('button',{name:'Tóm tắt và phân tích',exact:true}).click();
  await page.getByRole('button',{name:'Theo thời gian',exact:true}).click();
  assert.equal(await page.getByLabel('Nhóm thời gian',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('Tháng',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Tàu bay',exact:true}).click();await page.locator('.table-tools').getByRole('button',{name:'Mở toàn bộ',exact:true}).first().click();
  assert.match(await page.locator('main').textContent(),/A320/);
  await page.screenshot({path:resolve(output,'period-desktop.png'),fullPage:true});

  await artifact('bao-cao-san-luong','report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24');
  assert.ok(await page.getByRole('button',{name:'MAR 2026',exact:true}).count());
  assert.ok(await page.getByRole('button',{name:'OCT 2026',exact:true}).count());
  await page.getByRole('button',{name:'Analysis_Airline',exact:true}).click();
  assert.equal(await page.locator('main table').count(),3);
  await page.screenshot({path:resolve(output,'bao-desktop.png'),fullPage:true});

  // Enough independent leaves to test real Top 10/Other behavior and paging.
  await db.exec(`insert into reporting.html_fixture_candidates
    select 'rank-'||n||'-'||j,1,'test','rank-'||n||'-'||j,date '2026-09-01','A','AL'||lpad(n::text,2,'0'),'RANK'||n,'ICN','A320',n*100,600,timestamp '2026-09-01 10:00','active'
    from generate_series(1,25) n cross join lateral generate_series(1,26-n) j;
    insert into reporting.html_fixture_candidates
    select 'regular-'||n,1,'test','regular-'||n,date '2026-08-03'+n*7,'A','REG','REG1','NRT','A320',10,600,timestamp '2026-08-03 10:00'+n*interval '7 days','active' from generate_series(0,3) n;`);
  await artifact('top-10-va-tan-suat','report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-08-01&to=2026-09-04');
  await page.getByRole('button',{name:'Tóm tắt và phân tích',exact:true}).click();
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();
  const legends=page.locator('figure ol');
  assert.equal(await legends.nth(0).locator('li').count(),11);
  assert.equal(await legends.nth(1).locator('li').count(),11);
  assert.match(await legends.nth(0).locator('li').first().textContent(),/^AL01:/);
  assert.match(await legends.nth(1).locator('li').first().textContent(),/^AL13:/);
  assert.match(await legends.nth(0).locator('li').last().textContent(),/^Khác:/);
  assert.equal(await page.locator('tbody tr').count(),21); // grand total plus 20 root groups
  const allTotal=await page.locator('.grand-total').textContent();
  await page.getByRole('button',{name:'Trang sau',exact:true}).click();
  assert.equal(await page.locator('.grand-total').textContent(),allTotal);
  await page.getByRole('button',{name:'Tần suất',exact:true}).click();
  await page.getByRole('button',{name:'Mở toàn bộ',exact:true}).click();
  assert.equal(await page.locator('details[open]').count(),3);
  assert.match(await page.locator('tbody').textContent(),/REG1.*Đến.*10:00.*T2.*4.*4.*100%/);
  await page.screenshot({path:resolve(output,'frequency-desktop.png'),fullPage:true});

  await artifact('tổng quan tháng kiểm thử','report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=2026-09&from=2026-09-01&to=2026-09-30&comparison=previous');
  assert.equal(await page.locator('.monthly-overview tbody tr').count(),6);
  assert.match(await page.locator('thead').first().textContent(),/So T8\/2026/);
  await page.getByRole('button',{name:'Ngày và giờ cao điểm',exact:true}).click();
  await page.getByLabel('Chiều',{exact:true}).selectOption('A');
  assert.equal(await page.locator('main > .monthly-impact h3').count(),4);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);

  await db.exec(`update public.operational_route_countries set country='</script><script>globalThis.__injected=1</script>' where route='ICN'`);
  await artifact('security-fixture');
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();
  assert.equal(await page.evaluate(()=>globalThis.__injected),undefined);
  assert.match(await page.locator('main').textContent(),/<\/script><script>/);
  assert.deepEqual(network,[]);assert.deepEqual(errors,[]);
  await writeFile(resolve(output,'validation.json'),JSON.stringify({status:'passed',network_requests:network.length,browser_errors:errors,receipts},null,2),'utf8');
  console.log(JSON.stringify({suite:'traffic-html-offline-browser',status:'passed',output,receipts}));
} finally {await db.close();await browser.close();}
