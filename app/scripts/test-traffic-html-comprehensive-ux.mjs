import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHtmlTestDatabase, htmlFixture } from '../supabase/tests/public_traffic_html_export_pglite.mjs';
import { validateHtmlEnvelope } from '../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../supabase/functions/_shared/trafficHtmlReportRenderer.ts';

const { chromium } = createRequire(process.env.TRAFFIC_BROWSER_RUNTIME ?? import.meta.url)('playwright');
const db = await createHtmlTestDatabase();

await db.exec(`
  delete from reporting.html_fixture_candidates;
  insert into public.operational_route_countries values ('KUL','Malaysia'),('ICN','Korea'),('NRT','Japan'),('SYD','Australia') on conflict do nothing;
  insert into reporting.html_fixture_candidates
  select y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,1,'test',y||'-'||d::date||'-'||airline||'-'||direction||'-'||n,
    (d+make_interval(years=>y-2026))::date,direction,airline,airline||'123',route,'A320',pax,
    600,(d+make_interval(years=>y-2026))+interval '10 hours','active'
  from generate_series(timestamp '2026-07-01',timestamp '2026-09-17',interval '1 day') d
  cross join (values(2025),(2026)) years(y)
  cross join (values('VN','ICN',180,3),('VJ','NRT',150,2),('KE','ICN',200,1),('AK','KUL',170,1)) specs(airline,route,pax,count)
  cross join (values('A'),('D')) dirs(direction)
  cross join lateral generate_series(1,count+case when y=2026 and airline='VN' and extract(month from d)=9 then 1 else 0 end) n;
`);

// Part A: Test BAO_CAO_SAN_LUONG (Sections, Multi-panel, Scroll, Search, Filters, Data Bars toggle)
const queryBao = 'report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24';
const { data: dataBao, request: reqBao } = await htmlFixture(db, queryBao, '2026-09-18T00:00:00Z');
await validateHtmlEnvelope(dataBao, reqBao);
const htmlBao = renderTrafficHtmlReport(dataBao);

const pathBao = resolve('tmp/html-pivot-review-20260906/comprehensive-ux-test.html');
const { writeFile } = await import('node:fs/promises');
await writeFile(pathBao, htmlBao, 'utf8');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => {
  errors.push(e.message);
  console.error('PAGE ERROR DETECTED:', e.message);
});

try {
  await page.goto(pathToFileURL(pathBao).href);
  await page.locator('main h2').first().waitFor();

  // 1. Initial Load of BAO_CAO_SAN_LUONG
  console.log('Test 1: Initial Load & Sections');
  const h2s = await page.locator('main h2').allTextContents();
  assert.ok(h2s.includes('DAILY'), 'Must contain DAILY section');
  assert.ok(h2s.includes('WEEKLY'), 'Must contain WEEKLY section');

  // 2. Tab switching & DOM Caching (< 15ms in-browser switch)
  console.log('Test 2: Tab Switching & DOM Caching');
  const monthBtn = page.getByRole('button', { name: /JUL 2026/ });
  await monthBtn.click();
  await page.waitForTimeout(50);

  // Switch back to TOTAL (cached) and measure internal duration
  const switchDuration = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('nav button')).find(b => b.textContent.trim() === 'TOTAL');
    const t0 = performance.now();
    btn.click();
    return performance.now() - t0;
  });
  console.log(`Tab switch back to TOTAL in-browser time: ${switchDuration.toFixed(2)}ms`);
  assert.ok(switchDuration < 15, `Tab switch must be under 15ms, got ${switchDuration}ms`);

  // 3. Scroll position preservation (UX-02)
  console.log('Test 3: Scroll Preservation per Tab');
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    window.scrollTo(0, 20);
    const tbl = document.querySelector('.table-scroll');
    if (tbl) tbl.scrollTop = 400;
  });
  await page.waitForTimeout(20);
  const scrollBefore = await page.evaluate(() => ({
    win: window.scrollY,
    tbl: document.querySelector('.table-scroll')?.scrollTop ?? 0
  }));
  console.log('Scroll before switch:', scrollBefore);
  assert.equal(scrollBefore.win, 20, 'Window scroll must be 20');
  assert.equal(scrollBefore.tbl, 400, 'Table scroll must be 400');

  // Switch to JUL 2026 tab
  await page.getByRole('button', { name: /JUL 2026/ }).click();
  await page.waitForTimeout(50);

  // Switch back to TOTAL: both window and table scroll should be restored
  await page.getByRole('button', { name: 'TOTAL' }).click();
  await page.waitForTimeout(50);
  const scrollAfter = await page.evaluate(() => ({
    win: window.scrollY,
    tbl: document.querySelector('.table-scroll')?.scrollTop ?? 0
  }));
  console.log('Scroll after switch back to TOTAL:', scrollAfter);
  assert.equal(scrollAfter.win, 20, 'Window scroll must be preserved on return');
  assert.equal(scrollAfter.tbl, 400, 'Table scroll must be preserved on return');

  // 4. Universal Search
  console.log('Test 4: Universal Search in Table');
  const searchInput = page.getByLabel('Tìm trong bảng');
  await searchInput.fill('01/07/2026');
  await page.waitForTimeout(50);
  const rows = await page.locator('tbody tr[data-date]').all();
  assert.equal(rows.length, 1);
  await searchInput.fill('');

  // 5. Enhanced Filter Drawer (Chọn tất cả / Bỏ chọn)
  console.log('Test 5: Filter Drawer Actions');
  await page.getByText('Bộ lọc').first().click();
  const selAllBtns = await page.locator('.pivot-filter-btn').all();
  assert.ok(selAllBtns.length >= 6, 'Must have at least 6 filter buttons (2 per fieldset)');

  // Test 1-click select all and clear all on the first fieldset
  const firstFieldset = page.locator('details.pivot-filters fieldset').first();
  const checkboxes = firstFieldset.locator('input[type="checkbox"]');
  const cbCount = await checkboxes.count();
  assert.ok(cbCount > 0, 'First fieldset must have checkboxes');

  // Click 'Chọn tất cả' in the first fieldset
  const selAllBtn = firstFieldset.getByRole('button', { name: 'Chọn tất cả' });
  await selAllBtn.click();
  await page.waitForTimeout(50);

  // Assert all checkboxes in that fieldset are now checked
  const checkedCount = await firstFieldset.locator('input[type="checkbox"]:checked').count();
  assert.equal(checkedCount, cbCount, 'All checkboxes in fieldset must be checked after "Chọn tất cả"');

  // Assert summary reflects the selected count
  const summaryText = await page.locator('details.pivot-filters summary').first().textContent();
  assert.match(summaryText, /Bộ lọc \(\d+ lựa chọn\)/, 'Filter summary must reflect active selection count');

  // Click 'Bỏ chọn' in the first fieldset
  const clrAllBtn = firstFieldset.getByRole('button', { name: 'Bỏ chọn' });
  await clrAllBtn.click();
  await page.waitForTimeout(50);

  // Assert all checkboxes in that fieldset are now unchecked
  const checkedAfterClr = await firstFieldset.locator('input[type="checkbox"]:checked').count();
  assert.equal(checkedAfterClr, 0, 'No checkboxes in fieldset must be checked after "Bỏ chọn"');

  // 6. Sticky Grand Total check
  console.log('Test 6: Sticky Grand Total');
  const grandTotal = page.locator('.grand-total').first();
  const gtPosition = await grandTotal.evaluate(el => getComputedStyle(el.children[0]).position);
  assert.equal(gtPosition, 'sticky');

  // 7. Week Horizon View
  console.log('Test 7: Week Horizon View');
  const horizonBtn = page.getByRole('button', { name: 'Tuần cả mùa' });
  assert.ok(await horizonBtn.count() > 0);
  await horizonBtn.click();
  await page.waitForTimeout(50);
  const horizonH2 = await page.locator('main h2').first().textContent();
  assert.match(horizonH2, /Tuần cả mùa/);

  // 8. In-cell Data Bars via linear-gradient & Relative Scaling (DAT-05)
  console.log('Test 8: In-cell Data Bars with Toggle & Relative Scaling (DAT-05)');
  await page.getByRole('button', { name: 'TOTAL' }).click();
  await page.waitForTimeout(50);
  const barCells = await page.locator('td[data-bar-percent]').all();
  assert.ok(barCells.length > 0, 'Must have cells with data-bar-percent rendered');
  const firstBg = await barCells[0].evaluate(el => el.style.backgroundImage);
  assert.ok(firstBg.includes('linear-gradient'), `Background must be linear-gradient, got: ${firstBg}`);

  // 8.1 Summary rows must NOT have in-cell data bars (prevents distortion and preserves clean aggregates)
  const monthTotalBars = await page.locator('.month-total td[data-bar-percent]').count();
  assert.equal(monthTotalBars, 0, 'Month total rows must not have data bars');
  const grandTotalBars = await page.locator('.grand-total td[data-bar-percent]').count();
  assert.equal(grandTotalBars, 0, 'Grand total rows must not have data bars');

  // 8.2 Strict relative scaling check across numeric columns
  // Helper to extract and verify column scaling with vi-VN and en-US grouping tolerance
  const verifyColumnScaling = async (colIndex, colName) => {
    const colData = await page.evaluate((idx) => {
      const rows = Array.from(document.querySelectorAll('tbody tr[data-date]'));
      return rows.map(r => {
        const cell = r.children[idx];
        const raw = cell.textContent.trim();
        if (!raw || raw === '—' || raw === '0') return null;
        const val = parseInt(raw.replace(/[.,]/g, ''), 10);
        const pct = cell.getAttribute('data-bar-percent');
        return { val, pct: pct ? Number(pct) : null };
      }).filter(d => d && !isNaN(d.val) && d.val > 0);
    }, colIndex);

    assert.ok(colData.length > 0, `Must have non-zero cells in ${colName}`);
    const maxVal = Math.max(...colData.map(d => d.val));
    const maxPct = Math.max(...colData.map(d => d.pct));
    assert.equal(maxPct, 100, `Maximum cell in ${colName} column must scale to exactly 100%`);
    for (const item of colData) {
      const expectedPct = Math.min(100, Math.max(2, Math.round((item.val / maxVal) * 100)));
      assert.equal(item.pct, expectedPct, `Cell in ${colName} with val=${item.val} must scale to ${expectedPct}% of max=${maxVal}, got ${item.pct}%`);
    }
  };

  // Check Flight ARR (col 3), Flight Total (col 5), Pax ARR (col 6), and Pax Total (col 8)
  await verifyColumnScaling(3, 'Flight ARR');
  await verifyColumnScaling(5, 'Flight Total');
  await verifyColumnScaling(6, 'Pax ARR');
  await verifyColumnScaling(8, 'Pax Total');

  // 8.4 Test Toggle Data Bars Off:
  await page.getByText('Hiển thị').first().click();
  const barToggle = page.getByLabel('Thanh tỷ trọng (Data Bars)').first();
  await barToggle.uncheck();
  await page.waitForTimeout(50);
  const barCellsOff = await page.locator('td[data-bar-percent]').count();
  assert.equal(barCellsOff, 0, 'Turning off Data Bars toggle must remove all data bars');

  // Turn it back on:
  await barToggle.check();
  await page.waitForTimeout(50);
  assert.ok(await page.locator('td[data-bar-percent]').count() > 0, 'Re-enabling Data Bars must render them again');

  // Part B: Test PERIOD_ANALYSIS for End-to-End LocalStorage & Reset Semantics (ADV-01)
  console.log('Test 9: End-to-End LocalStorage Persistence & Reset Semantics (ADV-01)');
  const queryPeriod = 'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-07-15&to=2026-09-04&comparison_year=2025';
  const { data: dataPeriod, request: reqPeriod } = await htmlFixture(db, queryPeriod, '2026-09-05T00:00:00Z');
  await validateHtmlEnvelope(dataPeriod, reqPeriod);
  const htmlPeriod = renderTrafficHtmlReport(dataPeriod);
  const pathPeriod = resolve('tmp/html-pivot-review-20260906/comprehensive-period-test.html');
  await writeFile(pathPeriod, htmlPeriod, 'utf8');

  await page.goto(pathToFileURL(pathPeriod).href);
  await page.locator('main h2').first().waitFor();

  // Template default row header is "Hãng hàng không → Chặng bay"
  const defaultHeader = await page.locator('thead th.name').first().textContent();
  assert.equal(defaultHeader, 'Hãng hàng không → Chặng bay');

  // Change preset to country_month and click Save Configuration
  await page.getByText('Hiển thị', { exact: true }).click();
  const presetSelect = page.getByLabel('Mẫu Pivot nhanh');
  await presetSelect.selectOption('country_month');
  await page.waitForTimeout(50);

  const changedHeader = await page.locator('thead th.name').first().textContent();
  assert.equal(changedHeader, 'Thị trường → Hãng hàng không');

  await page.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  await page.waitForTimeout(50);

  // Reload page to verify persistence
  await page.reload();
  await page.locator('main h2').first().waitFor();
  const reloadedHeader = await page.locator('thead th.name').first().textContent();
  assert.equal(reloadedHeader, 'Thị trường → Hãng hàng không', 'Reload must restore saved country_month configuration');

  // Click "Về bố cục mẫu" and verify it reaches original template defaults
  await page.getByRole('button', { name: 'Về bố cục mẫu', exact: true }).click();
  await page.waitForTimeout(50);
  const resetHeader = await page.locator('thead th.name').first().textContent();
  assert.equal(resetHeader, 'Hãng hàng không → Chặng bay', 'Reset must restore template default levels');

  // Reload page again: template default must still be active (saved config was cleared from localStorage)
  await page.reload();
  await page.locator('main h2').first().waitFor();
  const reloadedAfterReset = await page.locator('thead th.name').first().textContent();
  assert.equal(reloadedAfterReset, 'Hãng hàng không → Chặng bay', 'Reload after reset must stay on template default');

  // 10. Strict check: ZERO page errors across the entire execution
  console.log('Test 10: Zero Page Errors');
  assert.deepEqual(errors, [], `Page must not produce any runtime errors, got: ${JSON.stringify(errors)}`);

  console.log('All comprehensive UX checks PASSED!');
} finally {
  await browser.close();
}
