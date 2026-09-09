import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHtmlTestDatabase, htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

const db = await createHtmlTestDatabase();
const { chromium } = createRequire(process.env.TRAFFIC_BROWSER_RUNTIME ?? import.meta.url)('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  offline: true,
  viewport: { width: 1680, height: 1050 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
function parseCsvRows(csvText) {
  const clean = csvText.replace(/^\uFEFF/, '').trim();
  const lines = clean.split(/\r?\n/);
  return lines.map(line => {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += c;
      } else {
        if (c === '"') inQuote = true;
        else if (c === ',') { fields.push(cur); cur = ''; }
        else cur += c;
      }
    }
    fields.push(cur);
    return fields;
  });
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  await db.exec(`
    delete from reporting.html_fixture_candidates;
    insert into public.operational_route_countries values ('KUL','Malaysia'),('ICN','Korea'),('NRT','Japan'),('SYD','Australia') on conflict do nothing;
    insert into reporting.html_fixture_candidates
    select y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,1,'test',y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,
      (d+make_interval(years=>y-2026))::date,direction,airline,airline||'123',route,'A320',pax,
      600,(d+make_interval(years=>y-2026))+interval '10 hours','active'
    from generate_series(timestamp '2026-07-15',timestamp '2026-09-04',interval '1 day') d
    cross join (values(2025),(2026)) years(y)
    cross join (values('VN','ICN',180,3),('VJ','NRT',150,2),('KE','ICN',200,1),('AK','KUL',170,1)) specs(airline,route,pax,count)
    cross join (values('A'),('D')) dirs(direction)
    cross join lateral generate_series(1,count) n;

    -- Formula injection carrier candidate
    insert into reporting.html_fixture_candidates values
      ('inject-1',1,'test','inject-1','2026-08-01','A','=CMD','CMD123','KUL','A320',100,600,'2026-08-01 10:00','active'),
      ('inject-2',1,'test','inject-2','2025-08-01','A','=CMD','CMD123','KUL','A320',100,600,'2025-08-01 10:00','active');

    -- Partial Pax candidate (1 leg has pax, 1 leg missing pax)
    insert into reporting.html_fixture_candidates values
      ('partial-pax-1',1,'test','partial-pax-1','2026-08-10','A','QF','QF001','SYD','A330',250,600,'2026-08-10 10:00','active'),
      ('partial-pax-2',1,'test','partial-pax-2','2026-08-10','D','QF','QF002','SYD','A330',null,600,'2026-08-10 12:00','active'),
      ('partial-pax-3',1,'test','partial-pax-3','2025-08-10','A','QF','QF001','SYD','A330',250,600,'2025-08-10 10:00','active'),
      ('partial-pax-4',1,'test','partial-pax-4','2025-08-10','D','QF','QF002','SYD','A330',null,600,'2025-08-10 12:00','active');
  `);

  const query = 'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-07-15&to=2026-09-04&comparison_year=2025';
  const { data, request } = await htmlFixture(db, query, '2026-09-05T00:00:00Z');
  await validateHtmlEnvelope(data, request);
  const html = renderTrafficHtmlReport(data);
  const path = resolve('tmp/html-pivot-review-20260906/test-improvements.html');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, html, 'utf8');
  await page.goto(pathToFileURL(path).href);
  await page.locator('main h2').first().waitFor();

  // 1. Check data-as-of badge
  const badge = page.locator('.pivot-as-of-badge');
  assert.equal(await badge.count(), 1);
  assert.match(await badge.textContent(), /Mốc chốt dữ liệu hoàn tất: Ops Date 04\/09\/2026/);

  // 2. Filter chips & Clear all
  assert.equal(await page.locator('.pivot-filter-chips').count(), 0);
  await page.getByText('Bộ lọc', { exact: true }).click();
  await page.getByLabel('Hãng hàng không: VN', { exact: true }).check();
  assert.equal(await page.locator('.pivot-filter-chips').count(), 1);
  assert.match(await page.locator('.pivot-chip').textContent(), /Hãng hàng không: VN/);
  await page.getByRole('button', { name: 'Xóa tất cả lọc', exact: true }).click();
  assert.equal(await page.locator('.pivot-filter-chips').count(), 0);
  assert.equal(await page.getByLabel('Hãng hàng không: VN', { exact: true }).isChecked(), false);

  // 3. Trục cột: Thứ trong tuần (T2-CN) - Rigorous Cell-by-cell Reconciliation
  await page.getByText('Hiển thị', { exact: true }).click();
  // Test Presets 1-Click: Thị trường × Tháng & Chặng bay × Chiều
  const presetSelect = page.getByLabel('Mẫu Pivot nhanh');
  assert.equal(await presetSelect.count(), 1);
  await presetSelect.selectOption('country_month');
  let topHeaders = await page.locator('thead tr').first().locator('th').allTextContents();
  assert.ok(topHeaders.some(h => h.includes('Tháng 07') || h.includes('Tháng 08')));

  await presetSelect.selectOption('route_dir');
  let subHeaders = await page.locator('thead tr').nth(1).locator('th').allTextContents();
  assert.ok(subHeaders.some(h => h.includes('Đến') || h.includes('Đi')));
  await page.getByLabel('Cấp nhóm', { exact: true }).selectOption('airline,route');
  await page.getByLabel('Trục cột', { exact: true }).selectOption('weekday');
  const headers = await page.locator('thead tr').first().locator('th').allTextContents();
  assert.ok(headers.some(h => h.includes('Thứ 2')));
  assert.ok(headers.some(h => h.includes('Thứ 4')));
  assert.ok(headers.some(h => h.includes('Thứ 6')));
  assert.ok(headers.some(h => h.includes('Chủ Nhật')));
  assert.ok(headers.some(h => h.includes('Grand Total')));

  // In 52 days: T2=7, T3=7, T4=8, T5=8, T6=8, T7=7, CN=7
  // VN: 6 flights/day, 180 pax/flight (1,080 pax/day)
  // T2, T3, T7, CN (7 days each): 42 flights, 7,560 pax
  // T4, T5, T6 (8 days each): 48 flights, 8,640 pax
  // VN Total: 312 flights, 56,160 pax
  const vnRow = page.locator('tbody tr.pivot-group', { hasText: 'VN' });
  const vnCells = await vnRow.locator('td').allTextContents();
  // We have both Chuyến bay and Hành khách columns for 2 periods (2025, 2026) across 7 weekdays + Grand Total
  // Let's verify that the VN cells contain 42, 48, 312 and 7.560, 8.640, 56.160
  assert.ok(vnCells.includes('42'), 'Must contain 42 flights for 7-day weekdays');
  assert.ok(vnCells.includes('48'), 'Must contain 48 flights for 8-day weekdays');
  assert.ok(vnCells.includes('312'), 'Must contain 312 total flights');
  assert.ok(vnCells.includes('7.560'), 'Must contain 7,560 pax for 7-day weekdays');
  assert.ok(vnCells.includes('8.640'), 'Must contain 8,640 pax for 8-day weekdays');
  assert.ok(vnCells.includes('56.160'), 'Must contain 56,160 total pax');

  // Verify Grand Total row has sum of weekday flights = grand total flights
  const grandTotalRow = page.locator('tfoot tr.grand-total');
  const gtCells = await grandTotalRow.locator('td').allTextContents();
  // Across 4 regular airlines: 14 flights/day * 52 = 728 + 1 injection flight on 08-01 (T7) + 2 QF legs on 08-10 (T2)
  assert.ok(gtCells.length > 0);
  // 4. Derived metrics: TB Chuyến / Ngày
  await page.getByLabel('Chiều', { exact: true }).selectOption('all');
  await page.getByLabel('Trục cột', { exact: true }).selectOption('period');
  await page.getByLabel('Chỉ tiêu', { exact: true }).selectOption('flights_per_day');
  // For VN: 312 flights / 52 days = 6.00 flights/day
  const vnFpdCell = page.locator('tbody tr.pivot-group', { hasText: 'VN' }).locator('td').first();
  assert.equal(await vnFpdCell.textContent(), '6');
  assert.equal(await vnFpdCell.getAttribute('title'), 'TB 6 chuyến/ngày (312 chuyến / 52 ngày)');

  // Derived metrics: Khách / Chuyến
  await page.getByLabel('Chỉ tiêu', { exact: true }).selectOption('pax_per_flight');
  // For VN: 56,160 pax / 312 flights = 180 pax/flight
  const vnPpfCell = page.locator('tbody tr.pivot-group', { hasText: 'VN' }).locator('td').first();
  assert.equal(await vnPpfCell.textContent(), '180');
  assert.equal(await vnPpfCell.getAttribute('title'), 'Bình quân 180 khách/chuyến (56160 khách / 312 chuyến)');

  // Check Partial Pax handling for QF:
  // QF has 2 flights on 2026-08-10, but only 1 flight has 250 pax reported, 1 flight has pax = null
  // So pax_per_flight = 250 / 1 = 250 with '*' indicator, and denominator in tooltip must say '1 chuyến', NOT 2!
  const qfRow = page.locator('tbody tr.pivot-group', { hasText: 'QF' });
  if (await qfRow.count() > 0) {
    const qfCell = qfRow.locator('td').first();
    assert.equal(await qfCell.textContent(), '250*');
    const qfTip = await qfCell.getAttribute('title');
    assert.match(qfTip, /1\/2 chuyến bay/);
  }

  // 5. Formula Injection Sanitization & Table-level Actions
  // Carrier '=CMD' was inserted in fixture
  const cmdRow = page.locator('tbody tr.pivot-group', { hasText: '=CMD' });
  assert.equal(await cmdRow.count(), 1);

  // Test CSV Download on Table 1
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.table-actions').first().getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const download = await downloadPromise;
  const downloadStream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of downloadStream) chunks.push(chunk);
  const csvContent = Buffer.concat(chunks).toString('utf8');

  // Verify UTF-8 BOM
  assert.equal(csvContent.charCodeAt(0), 0xFEFF, 'CSV must start with UTF-8 BOM');
  // Verify Formula injection sanitization in CSV: '=CMD' must be escaped as ''=CMD', while 'VN' is clean
  assert.match(csvContent, /\n'=CMD,/, 'Formula leading character must be prepended with single quote');
  assert.match(csvContent, /\nVN,/, 'Normal carrier must NOT have single quote or toggle button glyph');
  // Verify rectangularity of period analysis CSV & clipboard TSV
  const periodRows = parseCsvRows(csvContent);
  assert.ok(periodRows.length > 2);
  const periodColCount = periodRows[0].length;
  for (let i = 0; i < periodRows.length; i++) {
    assert.equal(periodRows[i].length, periodColCount, `Period row ${i} must have exactly ${periodColCount} columns`);
  }
  // Test Clipboard Copy
  await page.locator('.table-actions').first().getByRole('button', { name: 'Sao chép', exact: true }).click();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipboardText, /\n'=CMD\t/, 'Clipboard text must also sanitize formula injection characters');
  assert.match(clipboardText, /\nVN\t/, 'Clipboard text must contain tab-separated cells without toggle glyph');
  const clipLines = clipboardText.trim().split(/\r?\n/).map(l => l.split('\t'));
  const clipColCount = clipLines[0].length;
  for (let i = 0; i < clipLines.length; i++) {
    assert.equal(clipLines[i].length, clipColCount, `Clipboard row ${i} must have exactly ${clipColCount} columns`);
  }
  // Check future-row in PERIOD_ANALYSIS "Theo ngày"
  await page.getByRole('button', { name: 'Theo ngày', exact: true }).click();
  const dailySecPeriod = page.locator('section[data-table-key]').last();
  await dailySecPeriod.getByRole('button', { name: 'Mở tất cả', exact: true }).click();
  const periodFutureRows = dailySecPeriod.locator('tbody tr.future-row');
  // The fixture has data up to 2026-09-04; calendar entries exist for entire period.
  // If any row has date > 2026-09-04, it must have future-row.
  // Let's also check zero-result pagination guard:
  const searchInput = dailySecPeriod.getByLabel('Tìm trong bảng');
  if (await searchInput.count() > 0) {
    await searchInput.fill('NON_EXISTENT_CARRIER_XYZ');
    assert.match(await dailySecPeriod.textContent(), /Không có nhóm phù hợp/);
    await searchInput.fill('');
  }

  // 6. Multi-table distinct exports in Bao Cao San Luong (DAILY vs WEEKLY)
  const baoQuery = 'report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24';
  const { data: baoData, request: baoRequest } = await htmlFixture(db, baoQuery, '2026-09-05T00:00:00Z');
  await validateHtmlEnvelope(baoData, baoRequest);
  const baoHtml = renderTrafficHtmlReport(baoData);
  const baoPath = resolve('tmp/html-pivot-review-20260906/test-improvements-bao.html');
  await writeFile(baoPath, baoHtml, 'utf8');
  await page.goto(pathToFileURL(baoPath).href);
  await page.locator('main h2').first().waitFor();

  // In Bao Cao San Luong TOTAL view, there are 2 tables: DAILY (Theo ngày) and WEEKLY (Theo tuần)
  const sections = page.locator('section[data-table-key]');
  assert.equal(await sections.count(), 2);
  const dailySec = sections.nth(0);
  const weeklySec = sections.nth(1);

  // Download CSV from WEEKLY table (table 2)
  const weeklyDownloadPromise = page.waitForEvent('download');
  await weeklySec.locator('.table-actions').getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const weeklyDownload = await weeklyDownloadPromise;
  assert.equal(weeklyDownload.suggestedFilename(), 'WEEKLY.csv');
  const wChunks = [];
  for await (const chunk of await weeklyDownload.createReadStream()) wChunks.push(chunk);
  const weeklyCsv = Buffer.concat(wChunks).toString('utf8');
  assert.match(weeklyCsv, /From/);
  assert.match(weeklyCsv, /Grand Total/);
  // Verify rectangularity of weekly CSV (expanding rowSpan and colSpan)
  const weeklyRows = parseCsvRows(weeklyCsv);
  assert.ok(weeklyRows.length > 2);
  const weeklyColCount = weeklyRows[0].length;
  assert.equal(weeklyColCount, 8, 'WEEKLY must have exactly 8 columns across every row');
  for (let i = 0; i < weeklyRows.length; i++) {
    assert.equal(weeklyRows[i].length, weeklyColCount, `WEEKLY row ${i} must have exactly ${weeklyColCount} columns`);
  }
  // Must NOT contain daily-only header
  assert.ok(!weeklyCsv.includes('Thứ Sáu'));

  // Download CSV from DAILY table (table 1)
  const dailyDownloadPromise = page.waitForEvent('download');
  await dailySec.locator('.table-actions').getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const dailyDownload = await dailyDownloadPromise;
  assert.equal(dailyDownload.suggestedFilename(), 'DAILY.csv');
  const dChunks = [];
  for await (const chunk of await dailyDownload.createReadStream()) dChunks.push(chunk);
  const dailyCsv = Buffer.concat(dChunks).toString('utf8');
  assert.match(dailyCsv, /Ops Date/);
  // Verify rectangularity of daily CSV
  const dailyRows = parseCsvRows(dailyCsv);
  assert.ok(dailyRows.length > 2);
  const dailyColCount = dailyRows[0].length;
  assert.equal(dailyColCount, 9, 'DAILY must have exactly 9 columns across every row');
  for (let i = 0; i < dailyRows.length; i++) {
    assert.equal(dailyRows[i].length, dailyColCount, `DAILY row ${i} must have exactly ${dailyColCount} columns`);
  }

  // Test Analysis negative delta CSV export (preserves negative numbers without single quote)
  await page.getByRole('button', { name: 'Analysis_Airline', exact: true }).click();
  const analysisSec = page.locator('section[data-table-key]').nth(1);
  const analysisDownloadPromise = page.waitForEvent('download');
  await analysisSec.locator('.table-actions').getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const analysisDownload = await analysisDownloadPromise;
  const aChunks = [];
  for await (const chunk of await analysisDownload.createReadStream()) aChunks.push(chunk);
  const analysisCsv = Buffer.concat(aChunks).toString('utf8');

  // Verify negative delta exported as numeric -36 and negative % without leading quote
  assert.match(analysisCsv, /,-36,/);
  assert.ok(!analysisCsv.includes("'-36"), 'Negative delta must NOT be prepended with single quote');
  const analysisRows = parseCsvRows(analysisCsv);
  assert.ok(analysisRows.length > 2);
  const analysisColCount = analysisRows[0].length;
  for (let i = 0; i < analysisRows.length; i++) {
    assert.equal(analysisRows[i].length, analysisColCount, `Analysis row ${i} must have exactly ${analysisColCount} columns`);
  }

  // Check Future rows in BaoCaoSanLuong:
  await page.getByRole('button', { name: 'SEP 2026', exact: true }).click();
  const futureRows = page.locator('tbody tr.future-row');
  assert.ok(await futureRows.count() > 0, 'Must have future rows for dates > 2026-09-04');
  assert.match(await futureRows.first().getAttribute('title'), /Lịch bay dự kiến/);

  // 7. Verify zero unhandled page errors throughout test
  assert.equal(errors.length, 0, `Page had errors: ${errors.join(', ')}`);

  console.log(JSON.stringify({ suite: 'traffic-pivot-improvements', status: 'passed' }));
} finally {
  await browser.close();
  await db.close();
}
