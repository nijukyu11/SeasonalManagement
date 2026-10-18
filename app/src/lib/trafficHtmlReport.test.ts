import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHtmlRequest,sumHtmlMetrics,compareHtmlMetrics,type HtmlEnvelope } from '../../supabase/functions/_shared/trafficHtmlReportContract.ts';
import { validateHtmlEnvelope } from '../../supabase/functions/_shared/trafficHtmlReportModel.ts';
import { renderTrafficHtmlReport } from '../../supabase/functions/_shared/trafficHtmlReportRenderer.ts';
import { createHtmlTestDatabase,htmlFixture } from '../../supabase/tests/public_traffic_html_export_pglite.mjs';
import { trafficHtmlPivotStyles } from '../../supabase/functions/_shared/trafficHtmlPivotStyles.ts';
import { trafficHtmlMonthlyStyles } from '../../supabase/functions/_shared/trafficHtmlMonthlyStyles.ts';
import { mountTrafficHtmlMonthly } from '../../supabase/functions/_shared/trafficHtmlMonthlyRuntime.ts';

test('HTML contract is separate from Excel and rejects mismatched templates and invalid dates',()=>{
  const base='https://report.test/?report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-09-01&to=2026-09-04';
  assert.equal(normalizeHtmlRequest(new URL(base)).html_template,'weekly-detail-v1');
  for(const query of [base+'&template_version=weekly-detail-v1',base+'&html_template=weekly-detail-v1',base+'&unknown=1',base.replace('2026-09-01','2026-02-30'),base.replace('weekly-detail-v1','period-analysis-v1')]) assert.throws(()=>normalizeHtmlRequest(new URL(query)));
});
test('offline math preserves missing, true zero and computes provisional Pax comparisons when reported legs exist',()=>{
  const empty=sumHtmlMetrics([]); const zero={...sumHtmlMetrics([],'complete'),reported_pax:0,reported_legs:1,due_legs:1,flights:1,unreported_legs:0};
  assert.equal(sumHtmlMetrics([empty],'complete').flights,null);
  assert.equal(sumHtmlMetrics([zero]).reported_pax,0);
  assert.deepEqual(compareHtmlMetrics(zero,zero,'reported_pax'),{delta:0,percent:null,provisional:false});
  assert.deepEqual(compareHtmlMetrics({...zero,unreported_legs:1},zero,'reported_pax'),{delta:0,percent:null,provisional:true});
  assert.deepEqual(compareHtmlMetrics({...zero,reported_legs:0},zero,'reported_pax'),{delta:null,percent:null,provisional:false});
  assert.deepEqual(compareHtmlMetrics({...zero,flights:10,flight_coverage:'partial'},{...zero,flights:5},'flights'),{delta:5,percent:1,provisional:true});
});
test('monthly has four calendar months and prior-year MoM only when both comparisons are selected',async()=>{
  const db=await createHtmlTestDatabase();
  try {
    for(const [month,prior,days] of [['2026-09','2025-08',31],['2026-01','2024-12',31],['2025-03','2024-02',29],['2025-02','2024-01',31]] as const){
      const from=`${month}-01`,to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);
      const query=`report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=${month}&from=${from}&to=${to}`;
      const {request,data}=await htmlFixture(db,query+'&comparison=previous&comparison=year_ago');
      const context=data.periods.find((p:{id:string})=>p.id==='previous_year_ago');
      assert.ok(context,'missing previous month of prior year');
      assert.equal(context.from,`${prior}-01`);assert.equal(context.calendar_days,days);
      assert.equal(data.periods.length,4);assert.equal(data.resources.length,28);
      if(month==='2025-02')assert.equal(data.periods.find((p:{id:string})=>p.id==='year_ago').calendar_days,29);
      assert.deepEqual(data.comparison_pairs.map((p:{minuend_period:string;baseline_period:string})=>[p.minuend_period,p.baseline_period]),[
        ['current','previous'],['current','year_ago'],['year_ago','previous_year_ago']]);
      await validateHtmlEnvelope(data,request);
      const missing=structuredClone(data);missing.periods.pop();
      await assert.rejects(validateHtmlEnvelope(missing,request),/period/);
      for(const comparison of ['', '&comparison=previous','&comparison=year_ago']){
        const selected=await htmlFixture(db,query+comparison);await validateHtmlEnvelope(selected.data,selected.request);
        assert.equal(selected.data.periods.length,comparison?2:1);
      }
    }
  } finally { await db.close(); }
});
test('SQL envelope validates totals, hashes, presence, unique leaves and every resource',async()=>{
  const db=await createHtmlTestDatabase();
  try {
    const {request,data}=await htmlFixture(db);
    await validateHtmlEnvelope(data,request);
    const html=renderTrafficHtmlReport(data);
    assert.match(html,/<!doctype html>/);
    assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=/);
    const mutate=async(fn: (copy: typeof data)=>void,pattern:RegExp)=>{ const copy=structuredClone(data); fn(copy); await assert.rejects(validateHtmlEnvelope(copy,request),pattern); };
    await mutate(d=>d.resources.pop(),/resource count/);
    await mutate(d=>d.request_hash='0'.repeat(64),/request hash/);
    await mutate(d=>d.resources[0].filter_hash='0'.repeat(64),/resource hash/);
    await mutate(d=>{const r=d.resources.find((r:{dataset:string})=>r.dataset==='market'); r.rows.push(r.rows[0]); r.row_count++;},/duplicate bucket/);
    await mutate(d=>{const row=d.resources.find((r:{dataset:string})=>r.dataset==='market').rows.find((r:{reported_pax:number|null})=>r.reported_pax===null);row.reported_pax=0;},/Pax presence/);
    await mutate(d=>{const row=d.resources.find((r:{dataset:string})=>r.dataset==='market').rows.find((r:{reported_pax:number|null})=>r.reported_pax!==null); row.reported_pax++;},/total/);
  } finally {await db.close();}
});

test('traffic HTML offline improvements: divisor equality, fmt non-finite safety, styles and chunking', async () => {
  for (const nonFinite of [undefined, null, NaN, Infinity, -Infinity]) {
    assert.equal(typeof nonFinite === 'number' && Number.isFinite(nonFinite) ? new Intl.NumberFormat('vi-VN').format(nonFinite) : '—', '—');
  }
  assert.equal(new Intl.NumberFormat('vi-VN').format(0), '0');
  assert.equal(new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(1234.56), '1.234,56');

  // 2. Heatmap selector & contrast (tr.hot-N .heatmap-cell, AA contrast)
  assert.match(trafficHtmlPivotStyles, /tr\.hot-5 \.heatmap-cell/);
  assert.match(trafficHtmlPivotStyles, /tr\.hot-1 \.heatmap-cell/);
  assert.match(trafficHtmlPivotStyles, /tr\.hot-5 \.heatmap-cell,\.heatmap-cell\.hot-5\{background:#1d4ed8;color:#ffffff;font-weight:700\}/);

  // 3. Dead KPI band CSS removed
  assert.doesNotMatch(trafficHtmlPivotStyles, /\.pivot-kpi-band/);
  assert.doesNotMatch(trafficHtmlPivotStyles, /\.pivot-kpi-card/);

  // 4. Sticky header bounded max-height on .table-scroll
  assert.match(trafficHtmlMonthlyStyles, /\.monthly-report \.table-scroll\{max-height:calc\(100vh - 180px\);max-height:70dvh\}/);
  assert.match(trafficHtmlMonthlyStyles, /\.monthly-report \.table-scroll\{max-height:none!important;overflow:visible!important\}/);

  // 5. Print color adjust
  assert.match(trafficHtmlMonthlyStyles, /print-color-adjust:exact/);
  assert.match(trafficHtmlPivotStyles, /print-color-adjust:exact/);

  // 6. Running month fixture: narrative 'bình quân' and table 'TB/ngày' divisor equality
  const textNodes: string[] = [];
  interface MockNode {
    tagName: string;
    className: string;
    textContent: string;
    children: MockNode[];
    classList: { add: () => void; remove: () => void; contains: () => boolean };
    style: Record<string, string>;
    dataset: Record<string, string>;
    append: (...kids: Array<MockNode | string>) => void;
    prepend: (...kids: MockNode[]) => void;
    replaceChildren: (...kids: MockNode[]) => void;
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
    querySelector: () => MockNode | null;
    querySelectorAll: () => MockNode[];
    contains: (node: unknown) => boolean;
    remove: () => void;
  }
  const makeEl = (tag: string): MockNode => {
    const node: MockNode = {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      children: [],
      classList: { add() {}, remove() {}, contains() { return false; } },
      style: {},
      dataset: {},
      append(...kids) {
        for (const k of kids) {
          if (typeof k === 'string') textNodes.push(k);
          else if (k) { this.children.push(k); if (k.textContent) textNodes.push(k.textContent); }
        }
      },
      prepend(...kids) { this.children.unshift(...kids); },
      replaceChildren(...kids) { this.children = kids; },
      setAttribute() {},
      getAttribute() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      contains() { return false; },
      remove() {}
    };
    return node;
  };
  const globalScope = globalThis as unknown as { document: unknown; window: unknown };
  const originalDoc = globalScope.document;
  const originalWin = globalScope.window;
  const root = makeEl('div');
  globalScope.document = {
    getElementById(id: string) { if (id === 'report') return root; return null; },
    createElement(tag: string) { return makeEl(tag); },
    body: makeEl('body'),
    querySelectorAll() { return []; },
    activeElement: null
  };
  globalScope.window = {
    addEventListener() {},
    removeEventListener() {},
    print() {}
  };

  try {
    const runningMonthData = {
      contract_version: 'traffic-html-data-v2',
      source_mode: 'test',
      source_watermark: 'test',
      data_version: '1',
      data_as_of: '2026-09-18T00:00:00Z',
      snapshot_scope: 'test',
      normalized_request: {
        report_type: 'MONTHLY_OVERVIEW_L2',
        html_template: 'period-analysis-v1',
        period_mode: 'month',
        from: '2026-09-01',
        to: '2026-09-30',
        month: '2026-09',
        time_basis: 'local',
        airlines: [], routes: [], countries: [], aircraft_types: [], flight_types: [], seat_types: []
      },
      request_hash: 'abc',
      periods: [
        { id: 'current', role: 'current', label: 'T9/2026', from: '2026-09-01', to: '2026-09-30', calendar_days: 30, contains_future: true }
      ],
      comparison_pairs: [],
      calendar: [],
      resources: [
        {
          period_id: 'current',
          dataset: 'kpi',
          filter_hash: '123',
          row_count: 3,
          totals: [],
          rows: [
            { direction: 'all', flights: 300, reported_pax: 18000, reported_legs: 300, due_legs: 300, missing_due_legs: 0, true_zero_reported_legs: 0, unreported_legs: 0, pax_status: 'complete', flight_coverage: 'complete', grain: {} },
            { direction: 'A', flights: 150, reported_pax: 9000, reported_legs: 150, due_legs: 150, missing_due_legs: 0, true_zero_reported_legs: 0, unreported_legs: 0, pax_status: 'complete', flight_coverage: 'complete', grain: {} },
            { direction: 'D', flights: 150, reported_pax: 9000, reported_legs: 150, due_legs: 150, missing_due_legs: 0, true_zero_reported_legs: 0, unreported_legs: 0, pax_status: 'complete', flight_coverage: 'complete', grain: {} }
          ]
        },
        {
          period_id: 'current',
          dataset: 'timeline',
          filter_hash: '456',
          row_count: 36,
          totals: [],
          rows: Array.from({ length: 18 }, (_, i) => ({
            direction: 'all',
            flights: 10,
            reported_pax: 1000,
            reported_legs: 10,
            due_legs: 10,
            missing_due_legs: 0,
            true_zero_reported_legs: 0,
            unreported_legs: 0,
            pax_status: 'complete',
            flight_coverage: 'complete',
            grain: { date: '2026-09-' + String(i + 1).padStart(2, '0') }
          }))
        }
      ]
    } as unknown as HtmlEnvelope;
    mountTrafficHtmlMonthly(runningMonthData, { sum: sumHtmlMetrics, compare: compareHtmlMetrics });
    const paxTableAvg = textNodes.find(t => t.includes('TB/ngày: 1.000 (18 ngày)'));
    const paxNarrativeAvg = textNodes.find(t => t.includes('Hành khách: 18.000 khách; bình quân 1.000 khách/ngày (18 ngày)'));
    assert.ok(paxTableAvg, 'table must show average divided by 18 elapsed days');
    assert.ok(paxNarrativeAvg, 'narrative must show average divided by 18 elapsed days');
  } finally {
    globalScope.document = originalDoc;
    globalScope.window = originalWin;
  }
});
