import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHtmlTestDatabase,htmlFixture} from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import {validateHtmlEnvelope} from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import {renderTrafficHtmlReport} from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

const output=resolve('tmp/html-pivot-review-20260906');await mkdir(output,{recursive:true});
const db=await createHtmlTestDatabase();
const {chromium}=createRequire(process.env.TRAFFIC_BROWSER_RUNTIME??import.meta.url)('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({offline:true,viewport:{width:1680,height:1050},reducedMotion:'reduce'}),page=await context.newPage();
const errors=[],network=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
const nf=n=>new Intl.NumberFormat('vi-VN').format(n);
async function artifact(name,query,asOf='2026-09-05T00:00:00Z'){
  const {data,request}=await htmlFixture(db,query,asOf);await validateHtmlEnvelope(data,request);
  const html=renderTrafficHtmlReport(data).replace('<div id="report">','<aside class="notice" style="margin:12px">BẢN XEM THỬ — Dữ liệu minh họa giả lập, không phải production.</aside><div id="report">');
  const path=resolve(output,name+'.html');await writeFile(path,html,'utf8');await page.goto(pathToFileURL(path).href);await page.locator('main h2').first().waitFor();return {data,path};
}
const query='report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-07-15&to=2026-09-04&comparison_year=2025';
try{
  await db.exec(`delete from reporting.html_fixture_candidates;
    insert into public.operational_route_countries values ('KUL','Malaysia');
    insert into reporting.html_fixture_candidates
    select y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,1,'test',y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,
      (d+make_interval(years=>y-2026))::date,direction,airline,airline||'123',route,'A320',pax,
      600,(d+make_interval(years=>y-2026))+interval '10 hours','active'
    from generate_series(timestamp '2026-07-01',timestamp '2026-09-17',interval '1 day') d
    cross join (values(2025),(2026)) years(y)
    cross join (values('VN','ICN',180,3),('VJ','NRT',150,2),('KE','ICN',200,1),('AK','KUL',170,1)) specs(airline,route,pax,count)
    cross join (values('A'),('D')) dirs(direction)
    cross join lateral generate_series(1,count+case when y=2026 and airline='VN' and extract(month from d)=9 then 1 else 0 end) n;
    insert into reporting.html_fixture_candidates values
      ('onlyold',1,'test','onlyold','2025-08-02','A','ONLYOLD','O1','???','A320',50,null,null,'active'),
      ('zero',1,'test','zero','2026-08-02','D','ZERO','Z1','???','A320',0,600,'2026-08-02 10:00','active');`);
  const {data:periodData,path}=await artifact('phan-tich-theo-ky-pivot-mau',query);
  const table=page.locator('main table');
  const rankedNames=()=>table.locator('tbody .pivot-group > th').allTextContents();
  assert.deepEqual(await rankedNames(),['+ VN','+ VJ','+ AK','+ KE','+ ZERO','+ ONLYOLD']);
  assert.equal(await page.getByLabel('Sắp xếp',{exact:true}).inputValue(),'flights');
  await page.getByLabel('Chỉ tiêu',{exact:true}).selectOption('reported_pax');
  assert.deepEqual(await rankedNames(),['+ VN','+ VJ','+ AK','+ KE','+ ZERO','+ ONLYOLD']);
  await page.getByLabel('Chỉ tiêu',{exact:true}).selectOption('both');
  await page.getByText('Hiển thị',{exact:true}).click();
  await page.getByLabel('Sắp xếp',{exact:true}).selectOption('name');
  assert.equal((await rankedNames())[0],'+ AK');
  await page.getByRole('button',{name:'Về bố cục mẫu',exact:true}).click();
  assert.equal((await rankedNames())[0],'+ VN');
  assert.equal(await page.getByLabel('Cột thời gian',{exact:true}).count(),0);
  assert.equal(await page.getByLabel('Kỳ dữ liệu',{exact:true}).count(),0);
  assert.equal(await page.locator('main input[type=date],main input[type=month],main input[type=number]').count(),0);
  assert.equal(await page.locator('main > .pivot-tools').count(),0);
  assert.equal(await page.locator('section .table-tools').getByRole('button',{name:'Mở tất cả',exact:true}).count(),1);
  assert.equal(await table.count(),1);assert.equal(await table.locator('thead tr').count(),2);
  assert.equal(await table.locator('thead tr').first().locator('th').count(),9);
  assert.equal(await table.locator('tfoot td').count(),16);
  const grand=await table.locator('tfoot').textContent();
  // Independent SQL expectation for VN September, asymmetric growth across years.
  const vn=table.locator('tbody tr').filter({has:page.getByRole('button',{name:'+ VN',exact:true})});
  assert.deepEqual(await vn.locator('td').allTextContents(),['102','18.360','186','33.480','24','4.320','312','56.160','102','18.360','186','33.480','32','5.760','320','57.600']);
  await page.getByRole('button',{name:'+ VN',exact:true}).focus();await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:'− VN',exact:true}).getAttribute('aria-expanded'),'true');
  assert.equal(await page.getByRole('button',{name:'− VN',exact:true}).evaluate(n=>document.activeElement===n),true);
  assert.equal(await table.locator('tfoot').textContent(),grand);
  await page.getByLabel('Tìm trong bảng',{exact:true}).fill('ONLYOLD');assert.equal(await table.locator('.pivot-group').count(),1);assert.equal(await table.locator('tfoot').textContent(),grand);
  await page.getByLabel('Tìm trong bảng',{exact:true}).fill('');
  await page.getByText('Bộ lọc',{exact:true}).click();await page.getByLabel('Hãng hàng không: VN',{exact:true}).check();await page.getByLabel('Hãng hàng không: VJ',{exact:true}).check();
  assert.equal(await table.locator('.pivot-group').count(),2);
  assert.notEqual(await table.locator('tfoot').textContent(),grand);
  const chosen=await table.locator('tfoot td').allTextContents();assert.equal(chosen.at(-2),'528');assert.equal(chosen.at(-1),'88.800');
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();assert.equal(await table.locator('tfoot').textContent(),grand);
  await page.getByRole('button',{name:'Hãng hàng không',exact:true}).click();assert.deepEqual(await table.locator('tfoot td').allTextContents(),chosen);
  await page.getByRole('button',{name:'Về bố cục mẫu',exact:true}).click();assert.equal(await table.locator('tfoot').textContent(),grand);
  await page.getByLabel('Chiều',{exact:true}).selectOption('each');assert.equal(await table.locator('tfoot td').count(),48);
  const nums=await table.locator('tfoot td').allTextContents();for(let i=0;i<nums.length;i+=3)assert.equal(Number(nums[i].replaceAll('.',''))+Number(nums[i+1].replaceAll('.','')),Number(nums[i+2].replaceAll('.','')));
  await page.getByRole('button',{name:'Về bố cục mẫu',exact:true}).click();await page.getByRole('button',{name:'Mở tất cả',exact:true}).click();
  await page.screenshot({path:resolve(output,'pivot-hang.png'),fullPage:true});
  await page.getByRole('button',{name:'Theo ngày',exact:true}).click();
  const daily=page.locator('section[data-table-key]');assert.equal(await daily.count(),2);
  assert.deepEqual(await daily.last().locator('.pivot-group > th').allTextContents(),['+ Tháng 07/2026','+ Tháng 08/2026','+ Tháng 09/2026']);
  await daily.last().getByRole('button',{name:'Mở tất cả',exact:true}).click();
  assert.equal(await daily.first().locator('.pivot-child').count(),0);
  assert.equal(await daily.last().locator('.pivot-child').count(),52);assert.equal(await daily.last().locator('tfoot td').count(),6);
  assert.deepEqual(await daily.last().locator('tfoot td').allTextContents(),['368','369','737','63.640','63.640','127.280']);
  await daily.last().locator('.table-scroll').evaluate(n=>{n.scrollTop=400;});
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  const controlsBox=await daily.last().locator('.table-tools').boundingBox();assert.ok(controlsBox.y>=0&&controlsBox.y+controlsBox.height<1050);
  await daily.last().getByRole('button',{name:'Thu gọn',exact:true}).click();assert.equal(await daily.last().locator('.pivot-child').count(),0);
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('button',{name:'Thị trường',exact:true}).click();await page.getByRole('button',{name:'Mở tất cả',exact:true}).click();
  await page.screenshot({path:resolve(output,'pivot-thi-truong.png'),fullPage:true});
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:resolve(output,'pivot-mobile.png'),fullPage:true});
  await page.setViewportSize({width:812,height:375});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1680,height:1050});
  assert.equal(await table.locator('tfoot td').first().evaluate(el=>window.getComputedStyle(el).position),'sticky');
  assert.equal(await table.locator('tfoot td').first().evaluate(el=>window.getComputedStyle(el).bottom),'0px');
  assert.equal(await page.locator('header h1').textContent(),'Báo cáo khai thác');
  assert.equal(await page.locator('.print-context').count(),0);
  const beforePrint=await table.locator('tfoot td').allTextContents();
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));await page.emulateMedia({media:'print'});
  assert.equal(await table.locator('tfoot td').first().evaluate(el=>window.getComputedStyle(el).position),'static');
  assert.equal(await page.locator('.pivot-tools').isVisible(),false);assert.equal(await page.locator('.pivot-print-pages').isVisible(),true);
  assert.deepEqual(await page.locator('.pivot-print-pages tfoot td').allTextContents(),beforePrint);
  for(const t of await page.locator('.pivot-print-pages table').all())assert.ok(await t.locator('tfoot td').count()<=8);
  await page.screenshot({path:resolve(output,'pivot-ban-in.png'),fullPage:true});
  await page.emulateMedia({media:'screen'});await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  await artifact('bao-cao-tuan-pivot-mau','report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-09-01&to=2026-09-04');
  assert.equal(await page.locator('header h1').textContent(),'Báo cáo tuần chi tiết');
  assert.equal(await page.locator('main > .weekly-summary tbody tr').count(),6);
  await page.getByRole('button',{name:'Bảng pivot mẫu',exact:true}).click();assert.deepEqual(await table.locator('tfoot td').allTextContents(),['98','16.940','64','11.120','112','—']);
  await page.getByRole('button',{name:'Tóm tắt và phân tích',exact:true}).click();assert.equal(await page.locator('main > .weekly-summary tbody tr').count(),6);
  // MASTER title/h1 follow report_type; empty comparison hides fully incl. its Grand Total, zeros stay.
  const masterHtml=renderTrafficHtmlReport({...periodData,normalized_request:{...periodData.normalized_request,report_type:'MASTER_OPERATIONS'}});
  assert.match(masterHtml,/<title>Báo cáo tổng hợp khai thác<\/title>/);
  await writeFile(resolve(output,'kiem-thu-master.html'),masterHtml,'utf8');
  await page.goto(pathToFileURL(resolve(output,'kiem-thu-master.html')).href);await table.first().waitFor();
  assert.equal(await page.locator('header h1').textContent(),'Báo cáo tổng hợp khai thác');
  const bands=()=>table.locator('thead tr').first().locator('th').allTextContents();
  const victim=periodData.periods.find(p=>p.id!=='current'&&p.role!=='analysis-week');
  const emptied=JSON.parse(JSON.stringify(periodData));
  for(const r of emptied.resources)if(r.dataset==='market_daily'&&r.period_id===victim.id)r.rows=[];
  await writeFile(resolve(output,'kiem-thu-ky-rong.html'),renderTrafficHtmlReport(emptied),'utf8');
  await page.goto(pathToFileURL(resolve(output,'kiem-thu-ky-rong.html')).href);await table.first().waitFor();
  const emptyBands=await bands();
  assert.equal(emptyBands.some(t=>t.includes(victim.from.slice(0,4))),false);
  assert.equal(emptyBands.some(t=>t.includes('Grand Total')),true);
  const zeroed=JSON.parse(JSON.stringify(periodData));
  for(const r of zeroed.resources)if(r.dataset==='market_daily'&&r.period_id===victim.id)for(const row of r.rows){row.flights=0;row.reported_pax=0;}
  await writeFile(resolve(output,'kiem-thu-ky-khong.html'),renderTrafficHtmlReport(zeroed),'utf8');
  await page.goto(pathToFileURL(resolve(output,'kiem-thu-ky-khong.html')).href);await table.first().waitFor();
  assert.equal((await bands()).some(t=>t.includes(victim.from.slice(0,4))),true);
  const baoQuery='report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24';
  const bao=await artifact('bao-cao-san-luong-theo-mau',baoQuery);
  assert.equal(await page.locator('.bao-total table').count(),2);
  const total=bao.data.resources.find(r=>r.dataset==='kpi'&&r.period_id==='current').rows.find(r=>r.direction==='all');
  const dailyTotals=await page.locator('.bao-total table').first().locator('tfoot td').allTextContents();
  assert.equal(dailyTotals[2],nf(total.flights));assert.equal(dailyTotals[5],nf(total.reported_pax)+'*');
  assert.deepEqual(await page.locator('.bao-total table').last().locator('tfoot td').allTextContents(),dailyTotals);
  await page.screenshot({path:resolve(output,'bao-total.png'),fullPage:true});
  await page.getByRole('button',{name:'AUG 2026',exact:true}).click();assert.equal(await page.locator('figure svg rect').count(),62);
  assert.equal(await page.locator('tbody tr[data-date]').count(),31);
  await page.getByLabel('Biểu đồ',{exact:true}).selectOption('reported_pax');assert.match(await page.locator('figcaption').textContent(),/Hành khách/);
  await page.screenshot({path:resolve(output,'bao-thang.png'),fullPage:true});
  await page.getByRole('button',{name:'Analysis_Airline',exact:true}).click();assert.equal(await page.locator('main table').count(),3);
  for(const t of await page.locator('main table').all())assert.equal(await t.locator('tbody tr > th').first().textContent(),'VN');
  const middle=page.locator('main table').nth(1),v=middle.locator('tbody tr').filter({hasText:/^VN/});
  // Aug 28-31: 4*6; Sep 1-3: 3*8 => 48 VN flights. Other carriers: 7*8 => baseline 104.
  const cells=await v.locator('td').allTextContents();assert.deepEqual(cells.slice(0,3),['48','56','8']);assert.equal(cells[3],'16,67%');assert.equal(cells[4],'7,69%');
  await page.getByLabel('Chỉ tiêu',{exact:true}).selectOption('both');assert.equal(await page.locator('main table').count(),6);
  assert.equal(await page.locator('main table').nth(3).locator('tfoot td[data-ctg]').textContent(),'—');
  await page.screenshot({path:resolve(output,'bao-analysis.png'),fullPage:true});
  await page.getByRole('button',{name:'Analysis_Country',exact:true}).click();assert.equal(await page.locator('main table').count(),3);
  await artifact('kiem-thu-winter','report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=W26&from=2026-10-25&to=2027-03-27');
  assert.ok(await page.getByRole('button',{name:'JAN 2027',exact:true}).count());assert.ok(await page.getByRole('button',{name:'MAR 2027',exact:true}).count());
  await db.exec(`insert into reporting.html_fixture_candidates select 'rank'||n,1,'test','rank'||n,'2026-08-01','A','R'||lpad(n::text,2,'0'),'R1','ICN','A320',n,600,'2026-08-01 10:00','active' from generate_series(1,25) n;`);
  await artifact('kiem-thu-phan-trang',query);assert.equal(await table.locator('.pivot-group').count(),20);const pagedGrand=await table.locator('tfoot').textContent();
  await page.getByRole('button',{name:'Trang sau',exact:true}).click();assert.equal(await table.locator('tfoot').textContent(),pagedGrand);
  await db.exec("update public.operational_route_countries set country='</script><script>globalThis.__injected=1</script>' where route='ICN'");
  await artifact('kiem-thu-xss',query);await page.getByRole('button',{name:'Thị trường',exact:true}).click();assert.equal(await page.evaluate(()=>globalThis.__injected),undefined);assert.match(await table.textContent(),/<\/script>/);
  assert.deepEqual(errors,[]);assert.deepEqual(network,[]);
  await writeFile(resolve(output,'validation.json'),JSON.stringify({status:'passed',fixture_only:true,network_requests:0,browser_errors:[],artifacts:[path,bao.path]},null,2));
  console.log(JSON.stringify({suite:'traffic-reference-pivot-layout',status:'passed',artifacts:[path,bao.path]}));
}finally{await db.close();await browser.close();}
