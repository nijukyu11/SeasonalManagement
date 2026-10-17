import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHtmlTestDatabase,htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport,trafficHtmlFilename } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

const query='report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=2026-09&from=2026-09-01&to=2026-09-30&comparison=previous&comparison=year_ago';
const output=resolve('tmp/html-monthly-review-20260905');await mkdir(output,{recursive:true});
const db=await createHtmlTestDatabase();
const {chromium}=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME??import.meta.url)('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({offline:true,viewport:{width:1440,height:1050},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],network=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
async function artifact(name,asOf='2026-10-02T00:00:00Z',requestQuery=query){
  const {request,data}=await htmlFixture(db,requestQuery,asOf);await validateHtmlEnvelope(data,request);
  const html=renderTrafficHtmlReport(data).replace('<div id="report">','<aside class="notice" style="margin:12px 24px">BẢN XEM THỬ — Dữ liệu minh họa, không phải production. Tổng chuyến bốn tháng theo ví dụ Word; phân bổ hãng/chặng và toàn bộ khách là giả lập. Mốc kiểm thử sau tháng báo cáo để kiểm tra so sánh đầy đủ.</aside><div id="report">');
  const path=resolve(output,name+'.html');await writeFile(path,html,'utf8');await page.goto(pathToFileURL(path).href);
  await page.locator('main h2').waitFor();assert.equal(await page.getByRole('button',{name:'Bảng pivot mẫu',exact:true}).count(),1);return {data,path};
}
try {
  await db.exec(`delete from reporting.html_fixture_candidates;
    insert into public.operational_route_countries values ('KUL','Malaysia'),('PUS','Korea'),('HKG','China');
    with specs(period,start_date,airline,route,arr,dep,pax) as (values
      ('current',date '2026-09-01','VN','ICN',900,900,180),('current',date '2026-09-01','AK','KUL',185,185,180),
      ('current',date '2026-09-01','KE','PUS',114,114,200),('current',date '2026-09-01','CN','HKG',326,324,180),('current',date '2026-09-01','VJ','NRT',425,425,100),
      ('previous',date '2026-08-01','VN','ICN',1000,1000,150),('previous',date '2026-08-01','AK','KUL',128,128,180),
      ('previous',date '2026-08-01','KE','PUS',97,97,200),('previous',date '2026-08-01','CN','HKG',339,339,180),('previous',date '2026-08-01','VJ','NRT',425,425,200),
      ('year_ago',date '2025-09-01','VN','ICN',900,900,150),('year_ago',date '2025-09-01','AK','KUL',147,147,180),
      ('year_ago',date '2025-09-01','KE','PUS',100,100,200),('year_ago',date '2025-09-01','CN','HKG',200,200,180),('year_ago',date '2025-09-01','VJ','NRT',304,306,180),
      ('previous_year_ago',date '2025-08-01','VN','ICN',950,950,150),('previous_year_ago',date '2025-08-01','AK','KUL',145,145,180),
      ('previous_year_ago',date '2025-08-01','KE','PUS',90,100,200),('previous_year_ago',date '2025-08-01','CN','HKG',256,244,180),('previous_year_ago',date '2025-08-01','VJ','NRT',392,394,180))
    insert into reporting.html_fixture_candidates
    select period||airline||direction||n,1,'test',period||airline||direction||n,start_date+(n-1)%extract(day from (start_date+interval '1 month'-interval '1 day'))::integer,
      direction,airline,airline||'123',route,'A320',pax,case when direction='A' then 600 else 1020 end,
      (start_date+(n-1)%extract(day from (start_date+interval '1 month'-interval '1 day'))::integer)::timestamp+interval '10 hours','active'
    from specs cross join lateral(values('A',arr),('D',dep)) d(direction,flights) cross join lateral generate_series(1,flights) n;`);
  const {data,path}=await artifact('tong-quan-thang-bo-cuc-moi');
  // Compare every monthly direction to the captured production V2 definition,
  // executed locally on the same isolated fixture and semantic as-of timestamp.
  await db.exec('create schema extensions; create extension pgcrypto with schema extensions');
  await db.exec(await readFile(new URL('../supabase/tests/fixtures/public_traffic_live_v2_reference_20260905.sql',import.meta.url),'utf8'));
  for(const p of data.periods)for(const direction of ['all','A','D']){
    const v2=(await db.query('select public.get_public_traffic_report_v2(p_from_date=>$1::date,p_to_date=>$2::date,p_type=>$3,p_comparison=>\'none\',p_data_as_of=>$4::timestamptz) result',[p.from,p.to,direction,data.data_as_of])).rows[0].result;
    const metric=data.resources.find(r=>r.period_id===p.id&&r.dataset==='kpi').rows.find(r=>r.direction===direction);
    for(const key of ['flights','reported_pax','reported_legs','due_legs','missing_due_legs','true_zero_reported_legs'])assert.equal(metric[key],v2.current[key],`${p.id}/${direction}/${key}`);
  }
  assert.match(trafficHtmlFilename(data),/^tong-quan-khai-thac-thang-/);
  const overview=page.locator('.monthly-overview');
  assert.deepEqual((await overview.locator('thead th').allTextContents()).slice(1,5),['T8/2025','T9/2025','T8/2026','T9/2026']);
  assert.equal(await overview.locator('tbody tr').count(),6);
  const values=key=>overview.locator(`tr[data-measure="${key}"] td`).allTextContents();
  assert.deepEqual(await values('all-flights'),['3.666TB/ngày: 118','3.304TB/ngày: 110','3.978TB/ngày: 128','3.898TB/ngày: 130','-80-2%','+594+18%']);
  assert.match((await values('A-flights'))[3],/^1\.950/);assert.match((await values('D-flights'))[3],/^1\.948/);
  assert.match(await page.locator('.monthly-reading').textContent(),/T8\/2025 → T9\/2025 -9,9%; T8\/2026 → T9\/2026 -2%; chênh lệch \+7,9 điểm %/);
  await page.screenshot({path:resolve(output,'tong-quan.png'),fullPage:true});
  await page.getByText('Nội dung dùng cho báo cáo Word',{exact:true}).click();
  assert.match(await page.getByLabel('Nhận xét để sao chép').inputValue(),/Đến — Chuyến bay: 1\.950/);
  await page.getByRole('button',{name:'Chọn văn bản',exact:true}).click();
  assert.equal(await page.getByLabel('Nhận xét để sao chép').evaluate(n=>n.selectionEnd===n.value.length),true);
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();
  const groups=page.locator('.monthly-groups'),grand=await groups.locator('.grand-total').allTextContents();
  assert.equal(await page.getByLabel('Sắp xếp',{exact:true}).inputValue(),'flights');
  const rankedFlights=await groups.locator('.monthly-group[data-measure="flights"]').evaluateAll(rows=>rows.map(r=>Number(r.querySelectorAll('td')[3].textContent.split('TB/ngày')[0].replaceAll('.',''))));
  assert.deepEqual(rankedFlights,[...rankedFlights].sort((a,b)=>b-a));
  assert.equal(await groups.locator('tbody tr').count(),12); // 2 total + 2 per airline
  const impacts=page.locator('main > .monthly-impact');
  assert.match(await impacts.locator('section').nth(0).textContent(),/VN: -200 chuyến/);
  assert.match(await impacts.locator('section').nth(1).textContent(),/VJ: -85\.000 khách/);
  const impactBefore=await impacts.textContent();await page.getByRole('searchbox').fill('AK');
  assert.equal(await groups.locator('tbody tr').count(),4);assert.deepEqual(await groups.locator('.grand-total').allTextContents(),grand);assert.equal(await impacts.textContent(),impactBefore);
  await page.getByRole('searchbox').fill('');const first=groups.locator('button[data-group]').first();await first.focus();await page.keyboard.press('Enter');
  assert.equal(await groups.locator('button[data-group]').first().getAttribute('aria-expanded'),'true');assert.equal(await groups.locator('.monthly-direction').count(),4);
  assert.ok(await groups.locator('.monthly-trend').count());assert.deepEqual(await groups.locator('.grand-total').allTextContents(),grand);
  await page.screenshot({path:resolve(output,'hang-hang-khong.png'),fullPage:true});
  await page.getByText('Bộ lọc và sắp xếp',{exact:true}).click();await page.getByLabel('Hãng hàng không',{exact:true}).selectOption('"AK"');
  assert.match(await groups.locator('.grand-total').first().textContent(),/\+114\+44,5%/);
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();assert.deepEqual(await groups.locator('.grand-total').allTextContents(),grand);
  await page.getByLabel('Phân tích ảnh hưởng so với').selectOption('year_ago');assert.match(await impacts.textContent(),/So T9\/2025/);
  await page.getByText('Cơ cấu chuyến bay và hành khách · tháng báo cáo / cùng kỳ',{exact:true}).click();assert.equal(await page.locator('figure').count(),4);
  const japanColor=fig=>page.locator('figure').nth(fig).locator('li').filter({hasText:/^Japan:/}).locator('.monthly-swatch').evaluate(n=>n.style.backgroundColor);
  assert.equal(await japanColor(2),await japanColor(3)); // Pax rank differs; category color must not.
  await page.screenshot({path:resolve(output,'thi-truong.png'),fullPage:true});
  await page.getByRole('button',{name:'Chặng bay',exact:true}).click();await page.getByLabel('Chiều',{exact:true}).selectOption('D');assert.match(await groups.locator('.grand-total').first().textContent(),/1\.948/);
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('.monthly-tools').isVisible(),false);await page.screenshot({path:resolve(output,'ban-in.png'),fullPage:true});await page.emulateMedia({media:'screen'});
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
  await page.setViewportSize({width:812,height:375});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1050});
  await page.getByRole('button',{name:'Ngày và giờ cao điểm',exact:true}).click();assert.equal(await page.locator('main > .monthly-impact h3').count(),4);
  const hourRows=page.locator('main > .monthly-impact').nth(1).locator('tbody tr');assert.match(await hourRows.first().textContent(),/10:00–11:00.*1\.950.*65/);
  assert.match(await page.locator('main > details').nth(1).locator('tbody tr').first().textContent(),/^05:00–06:00/);
  await page.screenshot({path:resolve(output,'cao-diem.png'),fullPage:true});
  await artifact('kiem-thu-utc','2026-10-02T00:00:00Z',query+'&tz=utc');await page.getByRole('button',{name:'Ngày và giờ cao điểm',exact:true}).click();
  assert.match(await page.locator('main > details').nth(1).locator('tbody tr').first().textContent(),/^22:00–23:00/);
  // Flight counts are still scheduled when the report month has future dates.
  await artifact('kiem-thu-thang-chua-ket-thuc','2026-09-05T00:00:00Z');assert.match(await page.locator('header').textContent(),/lịch bay tương lai/);
  // Incomplete Pax suppresses comparisons, ranking and shares, not the known subtotal.
  await db.exec("update reporting.html_fixture_candidates set effective_pax=null where record_id='currentVNA1'");
  await artifact('kiem-thu-thieu-khach');assert.equal((await values('all-reported_pax'))[4],'——');
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();assert.match(await impacts.locator('section').nth(1).textContent(),/Chưa đủ dữ liệu/);
  await page.getByText('Cơ cấu chuyến bay và hành khách · tháng báo cáo / cùng kỳ',{exact:true}).click();assert.match(await page.locator('figure').nth(2).textContent(),/Chưa đủ dữ liệu/);
  for(const comparisons of ['', '&comparison=previous','&comparison=year_ago']){
    await artifact(`kiem-thu-ky-${comparisons.split('=').at(-1)||'khong-so-sanh'}`,'2026-10-02T00:00:00Z',query.split('&comparison=')[0]+comparisons);
    assert.equal(await overview.locator('thead th').count(),comparisons?4:2);
    await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();assert.equal(await groups.locator('.grand-total').count(),2);
  }
  // New comparison-only groups, Unknown, zeros, Top 10/Other and pagination.
  await db.exec(`update reporting.html_fixture_candidates set effective_pax=180 where record_id='currentVNA1';
    insert into reporting.html_fixture_candidates
    select 'rank-'||n||'-'||j,1,'test','rank-'||n||'-'||j,date '2026-09-01','A','AL'||lpad(n::text,2,'0'),'AL1','ICN','A320',n*100,600,timestamp '2026-09-01 10:00','active'
    from generate_series(1,25) n cross join lateral generate_series(1,26-n) j;
    insert into reporting.html_fixture_candidates values
      ('old',1,'test','old','2025-08-01','A','ONLYOLD','O1','???','A320',null,600,'2025-08-01 10:00','active'),
      ('zero-now',1,'test','zero-now','2026-09-01','A','ZERO','Z1','???','A320',0,null,'2026-09-01 10:00','active'),
      ('zero-before',1,'test','zero-before','2026-08-01','A','ZERO','Z1','???','A320',0,null,'2026-08-01 10:00','active');`);
  await artifact('kiem-thu-phan-trang');await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();
  assert.equal(await groups.locator('.monthly-group').count(),40);const total=await groups.locator('.grand-total').allTextContents();
  await page.getByRole('button',{name:'Trang sau',exact:true}).click();assert.deepEqual(await groups.locator('.grand-total').allTextContents(),total);
  await page.getByText('Cơ cấu chuyến bay và hành khách · tháng báo cáo / cùng kỳ',{exact:true}).click();
  assert.equal(await page.locator('figure').first().locator('li').count(),11);assert.match(await page.locator('figure').first().locator('li').last().textContent(),/Khác:/);
  await page.getByRole('searchbox').fill('ONLYOLD');assert.match(await groups.locator('.monthly-group').first().textContent(),/ONLYOLD/);
  await page.getByRole('searchbox').fill('ZERO');assert.match(await groups.locator('.monthly-group').nth(1).textContent(),/Hành khách.*0.*0.*0—/);
  await db.exec("update public.operational_route_countries set country='</script><script>globalThis.__injected=1</script>' where route='ICN'");
  await artifact('kiem-thu-an-toan');await page.getByRole('button',{name:'Thị trường',exact:true}).click();assert.equal(await page.evaluate(()=>globalThis.__injected),undefined);assert.match(await groups.textContent(),/<\/script><script>/);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  await writeFile(resolve(output,'validation.json'),JSON.stringify({status:'passed',fixture_only:true,periods:data.periods.map(p=>({id:p.id,from:p.from,to:p.to})),network_requests:network.length,browser_errors:errors},null,2),'utf8');
  console.log(JSON.stringify({suite:'traffic-monthly-layout',status:'passed',path}));
} finally {await db.close();await browser.close();}
