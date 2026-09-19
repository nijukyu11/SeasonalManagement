import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHtmlTestDatabase,htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

// Independent illustrative breakdown, not a reconstruction of production.
const db=await createHtmlTestDatabase();
const {chromium}=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME??import.meta.url)('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=resolve('tmp/html-weekly-review-20260905');await mkdir(output,{recursive:true});
const context=await browser.newContext({offline:true,viewport:{width:1440,height:1100},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],network=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
try {
  await db.exec(`delete from reporting.html_fixture_candidates;
    insert into public.operational_route_countries values ('TPE','Taiwan');
    insert into public.operational_aircraft_groups values ('wb','Widebody');
    insert into public.operational_aircraft_group_types values ('wb','B787');
    with specs(period,start_date,airline,route,direction,flights,pax) as (values
      ('current',date '2026-08-29','VN','ICN','A',150,25500),('current',date '2026-08-29','VN','ICN','D',150,25500),
      ('current',date '2026-08-29','VJ','NRT','A',110,17000),('current',date '2026-08-29','VJ','NRT','D',110,19000),
      ('current',date '2026-08-29','KE','ICN','A',80,14000),('current',date '2026-08-29','KE','ICN','D',80,14400),
      ('current',date '2026-08-29','TW','TPE','A',49,7655),('current',date '2026-08-29','TW','TPE','D',51,8459),
      ('previous',date '2026-08-22','VN','ICN','A',160,28000),('previous',date '2026-08-22','VN','ICN','D',160,29000),
      ('previous',date '2026-08-22','VJ','NRT','A',115,20000),('previous',date '2026-08-22','VJ','NRT','D',115,20000),
      ('previous',date '2026-08-22','KE','ICN','A',75,13000),('previous',date '2026-08-22','KE','ICN','D',75,13500),
      ('previous',date '2026-08-22','TW','TPE','A',45,7000),('previous',date '2026-08-22','TW','TPE','D',45,7211),
      ('next',date '2026-09-05','VN','ICN','A',140,null),('next',date '2026-09-05','VN','ICN','D',140,null))
    insert into reporting.html_fixture_candidates
    select period||airline||direction||n,1,'test',period||airline||direction||n,start_date+(n-1)%7,direction,airline,airline||'123',route,
      case when airline='KE' then 'B787' else 'A320' end,
      pax/flights+case when n<=pax%flights then 1 else 0 end,600,(start_date+(n-1)%7)::timestamp+interval '10 hours','active'
    from specs cross join lateral generate_series(1,flights) n;`);
  const {request,data}=await htmlFixture(db,'report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-08-29&to=2026-09-04');
  await validateHtmlEnvelope(data,request);
  const render=raw=>renderTrafficHtmlReport(raw).replace('<div id="report">','<aside class="notice" style="margin:12px 24px">BẢN XEM THỬ — Dữ liệu minh họa. Tổng tuần báo cáo theo ví dụ; tuần trước, tuần sau và phân bổ hãng/chặng là giả lập, không phải dữ liệu production.</aside><div id="report">');
  const path=resolve(output,'bao-cao-tuan-bo-cuc-moi.html');await writeFile(path,render(data),'utf8');
  await page.goto(pathToFileURL(path).href);
  await page.locator('main h2').waitFor();assert.equal(await page.getByRole('button',{name:'Bảng pivot mẫu',exact:true}).count(),1);
  const cells=async key=>page.locator(`main > .weekly-summary tr[data-measure="${key}"] td`).allTextContents();
  assert.deepEqual((await cells('A-flights')).slice(0,2),['395','389']);
  assert.deepEqual((await cells('D-flights')).slice(0,2),['395','391']);
  assert.equal((await cells('A-reported_pax'))[1],'64.155');
  assert.equal((await cells('D-reported_pax'))[1],'67.359');
  assert.equal((await cells('all-flights'))[1],'780');assert.equal((await cells('all-reported_pax'))[1],'131.514');
  assert.equal((await cells('all-flights'))[3],'-1,3%');assert.equal((await cells('all-reported_pax'))[3],'-4,5%');
  assert.equal((await cells('A-flights')).at(-1),'56');assert.equal((await cells('D-reported_pax')).at(-1),'9.623');assert.equal((await cells('all-reported_pax')).at(-1),'18.788');
  assert.equal(await page.locator('.weekly-disclosure[open]').count(),0);
  await page.screenshot({path:resolve(output,'tong-quan.png'),fullPage:true});
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();
  const table=page.locator('main > .weekly-comparison');
  assert.equal(await page.getByLabel('Sắp xếp',{exact:true}).inputValue(),'flights');
  const rankedFlights=await table.locator('tbody tr:not(.grand-total)').evaluateAll(rows=>rows.map(r=>Number(r.querySelectorAll('td')[1].textContent.replaceAll('.',''))));
  assert.deepEqual(rankedFlights,[...rankedFlights].sort((a,b)=>b-a));
  assert.equal(await table.locator('tbody tr').count(),5);assert.equal(await table.locator('tbody tr').first().locator('td').count(),8);
  const grand=await table.locator('.grand-total td').allTextContents();
  assert.deepEqual(grand.slice(0,3),['790','780','-10']);assert.deepEqual(grand.slice(4,7),['137.711','131.514','-6.197']);
  const paxImpact=page.locator('.weekly-impact > section').nth(1);
  assert.match(await paxImpact.locator('ul').first().locator('li').first().textContent(),/^VN: -6.000 khách/);
  assert.match(await paxImpact.locator('ul').nth(1).locator('li').first().textContent(),/^TW: \+1.903 khách/);
  const influence=await paxImpact.textContent();
  await page.getByRole('searchbox').fill('VJ');assert.deepEqual(await table.locator('.grand-total td').allTextContents(),grand);assert.equal(await paxImpact.textContent(),influence);
  await page.getByRole('searchbox').fill('');
  const first=table.locator('button[data-group]').first();await first.focus();await page.keyboard.press('Enter');
  assert.equal(await table.locator('button[data-group]').first().getAttribute('aria-expanded'),'true');
  assert.equal(await table.locator('.weekly-direction').count(),2);
  assert.deepEqual(await table.locator('.grand-total td').allTextContents(),grand);
  await page.screenshot({path:resolve(output,'hang-hang-khong.png'),fullPage:true});
  await page.getByText('Bộ lọc và sắp xếp',{exact:true}).click();await page.getByLabel('Hãng hàng không',{exact:true}).selectOption('"VN"');
  assert.equal((await table.locator('.grand-total td').allTextContents())[1],'300');
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();assert.equal((await table.locator('.grand-total td').allTextContents())[1],'780');
  await page.screenshot({path:resolve(output,'thi-truong.png'),fullPage:true});
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('.weekly-tools').isVisible(),false);
  await page.screenshot({path:resolve(output,'ban-in.png'),fullPage:true});await page.emulateMedia({media:'screen'});
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
  // A missing passenger leg must suppress impact ranking and narrative.
  await db.exec("update reporting.html_fixture_candidates set effective_pax=null where record_id='currentVNA1'");
  const incomplete=await htmlFixture(db,'report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-08-29&to=2026-09-04');await validateHtmlEnvelope(incomplete.data,incomplete.request);
  const incompletePath=resolve(output,'kiem-thu-thieu-khach.html');await writeFile(incompletePath,render(incomplete.data),'utf8');await page.goto(pathToFileURL(incompletePath).href);
  await page.locator('main h2').waitFor();assert.equal(await page.getByRole('button',{name:'Bảng pivot mẫu',exact:true}).count(),1);
  assert.equal((await cells('all-reported_pax'))[2],'—');assert.match(await page.locator('.weekly-reading').first().textContent(),/Tổng khách: chưa đủ/);
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();assert.match(await page.locator('.weekly-impact > section').nth(1).textContent(),/Chưa đủ dữ liệu/);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  await writeFile(resolve(output,'validation.json'),JSON.stringify({status:'passed',fixture_only:true,current_flights:780,current_pax:131514,network_requests:network.length,browser_errors:errors},null,2),'utf8');
  console.log(JSON.stringify({suite:'traffic-weekly-layout',status:'passed',path}));
}finally{await db.close();await browser.close();}
