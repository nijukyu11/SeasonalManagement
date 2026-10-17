import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = createRequire(process.env.TRAFFIC_BROWSER_RUNTIME ?? import.meta.url)('playwright');
const outDir = resolve('tmp/production-live-verify');
await mkdir(outDir, { recursive: true });

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

console.log('1. Fetching live production HTML files...');
const urls = {
  period: 'https://report.ahtops.xyz/api/report/v2/html-export?report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-08-01&to=2026-08-15',
  weekly: 'https://report.ahtops.xyz/api/report/v2/html-export?report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-08-28&to=2026-09-03',
  bao: 'https://report.ahtops.xyz/api/report/v2/html-export?report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24',
};

const paths = {};
for (const [key, url] of Object.entries(urls)) {
  const res = await fetch(url);
  assert.equal(res.status, 200, `${key} must return 200`);
  const text = await res.text();
  const filePath = resolve(outDir, `${key}-live.html`);
  await writeFile(filePath, text, 'utf8');
  paths[key] = filePath;
  console.log(`  Fetched ${key}: ${text.length} bytes`);
}

console.log('2. Opening live HTML in Playwright (offline, msedge)...');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  offline: true,
  viewport: { width: 1680, height: 1050 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

try {
  // Test A: PERIOD_ANALYSIS
  console.log('Testing PERIOD_ANALYSIS live HTML...');
  await page.goto(pathToFileURL(paths.period).href);
  await page.locator('main h2').first().waitFor();

  // Check data badge
  assert.equal(await page.locator('.pivot-as-of-badge').count(), 1);

  // Check presets
  await page.getByText('Hiển thị', { exact: true }).click();
  const presetSelect = page.getByLabel('Mẫu Pivot nhanh');
  assert.equal(await presetSelect.count(), 1);
  await presetSelect.selectOption('country_month');
  const headers = await page.locator('thead tr').first().locator('th').allTextContents();
  assert.ok(headers.some(h => h.includes('Tháng')));

  // Check copy & clipboard
  await page.locator('.table-actions').first().getByRole('button', { name: 'Sao chép', exact: true }).click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clip.includes('\t'), 'Clipboard must contain TSV data');

  // Check CSV download & rectangularity
  const csvDownloadPromise = page.waitForEvent('download');
  await page.locator('.table-actions').first().getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const download = await csvDownloadPromise;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'CSV must have UTF-8 BOM');
  const periodRows = parseCsvRows(csv);
  assert.ok(periodRows.length > 2);
  const periodCols = periodRows[0].length;
  for (let i = 0; i < periodRows.length; i++) {
    assert.equal(periodRows[i].length, periodCols, `Row ${i} must have exactly ${periodCols} columns`);
  }

  // Test B: BAO_CAO_SAN_LUONG
  console.log('Testing BAO_CAO_SAN_LUONG live HTML...');
  await page.goto(pathToFileURL(paths.bao).href);
  await page.locator('main h2').first().waitFor();

  const sections = page.locator('section[data-table-key]');
  assert.equal(await sections.count(), 2);

  // WEEKLY table CSV
  const weeklyDownloadPromise = page.waitForEvent('download');
  await sections.nth(1).locator('.table-actions').getByRole('button', { name: 'Xuất CSV', exact: true }).click();
  const wDownload = await weeklyDownloadPromise;
  assert.equal(wDownload.suggestedFilename(), 'WEEKLY.csv');
  const wChunks = [];
  for await (const chunk of await wDownload.createReadStream()) wChunks.push(chunk);
  const wCsv = Buffer.concat(wChunks).toString('utf8');
  const wRows = parseCsvRows(wCsv);
  assert.equal(wRows[0].length, 8, 'WEEKLY must have 8 rectangular columns');
  for (let i = 0; i < wRows.length; i++) {
    assert.equal(wRows[i].length, 8);
  }

  // Check zero unhandled errors
  assert.equal(errors.length, 0, `Page errors encountered: ${errors.join(', ')}`);
  console.log('3. Live production HTML execution verified with ZERO errors and 100% rectangular grid!');
} finally {
  await browser.close();
}
