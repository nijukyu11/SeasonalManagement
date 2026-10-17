import { HTML_DATA_VERSION, HTML_MAX_ROWS, sumHtmlMetrics, type Dataset, type HtmlEnvelope, type HtmlRequest, type HtmlRow } from './trafficHtmlReportContract.ts';
import { workbookComparisonYearRanges, workbookMonthRange, workbookSeasonRange } from './trafficWorkbookCore.ts';

const DATASETS: Dataset[] = ['kpi','timeline','market','market_daily','aircraft','hours','frequency'];
const FIELDS: Record<Dataset, string[]> = { kpi: [], timeline: ['date'], market: ['country','route','airline'], market_daily: ['date','country','route','airline'], aircraft: ['group_id','group','type'], hours: ['hour'], frequency: ['hour','airline','route','flight_number'] };
const METRICS = ['flights','reported_pax','reported_legs','due_legs','missing_due_legs','true_zero_reported_legs','unreported_legs'] as const;
function ensure(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(`HTML_DATA_INVALID: ${reason}`); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

// PostgreSQL jsonb text is deterministic: UTF-8 key length, then byte ordering.
// Request/resource keys are ASCII; nested labels are serialized as values, never keys.
export function pgJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pgJson).join(', ')}]`;
  if (object(value)) return `{${Object.keys(value).sort((a,b)=>a.length-b.length || (a<b?-1:a>b?1:0)).map(k=>`${JSON.stringify(k)}: ${pgJson(value[k])}`).join(', ')}}`;
  return JSON.stringify(value);
}
export async function htmlHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pgJson(value)));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}
function validateMetric(row: HtmlRow) {
  for (const field of METRICS) ensure((['flights','reported_pax','unreported_legs'].includes(field) && row[field]===null)
    || (Number.isSafeInteger(row[field]) && row[field]!>=0), `invalid ${field}`);
  ensure(['complete','partial','missing'].includes(row.flight_coverage),'coverage');
  ensure((row.reported_pax===null)===(row.reported_legs===0),'Pax presence');
  ensure(row.pax_status===(row.reported_legs===0?'missing':row.flights===row.reported_legs?'complete':'partial'),'Pax status');
  ensure(row.reported_legs+row.missing_due_legs===row.due_legs,'due count');
  ensure(row.true_zero_reported_legs<=row.reported_legs,'zero presence');
  ensure(row.flights===null ? row.unreported_legs===null && row.reported_legs===0
    : row.flights>=row.due_legs && row.unreported_legs===row.flights-row.reported_legs,'flight presence');
  ensure(!(row.flights===0 && row.flight_coverage!=='complete'),'uncertified zero');
}
function sameMetrics(a: HtmlRow | ReturnType<typeof sumHtmlMetrics>, b: HtmlRow) {
  return METRICS.every(key=>a[key]===b[key]);
}
function shiftDate(date:string,days:number) { return new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10); }
function expectedPeriods(request:HtmlRequest,data:HtmlEnvelope) {
  const result=[{id:'current',role:'current',from:request.from,to:request.to}];
  if(request.report_type==='WEEKLY_DETAIL')result.push({id:'previous',role:'previous',from:shiftDate(request.from,-7),to:shiftDate(request.from,-1)},
    {id:'next',role:'next',from:shiftDate(request.to,1),to:shiftDate(request.to,7)});
  for(const comparison of request.comparisons){
    let range:{from:string;to:string};
    if(comparison==='previous')range=request.period_mode==='month'?workbookMonthRange(shiftDate(request.from,-1).slice(0,7))
      :{from:shiftDate(request.from,-((Date.parse(request.to)-Date.parse(request.from))/86400000+1)),to:shiftDate(request.from,-1)};
    else if(request.period_mode==='month')range=workbookMonthRange(`${Number(request.from.slice(0,4))-1}-${request.from.slice(5,7)}`);
    else if(request.period_mode==='season')range=workbookSeasonRange(`${request.season_code![0]}${String(Number(request.season_code!.slice(1))-1).padStart(2,'0')}`);
    else range=workbookComparisonYearRanges({periodMode:request.period_mode,seasonCode:request.season_code,from:request.from,to:request.to,comparisonYears:[Number(request.from.slice(0,4))-1]})[0];
    result.push({id:comparison,role:comparison==='previous'?'previous':'comparison',from:range.from,to:range.to});
  }
  if(request.report_type==='MONTHLY_OVERVIEW_L2'&&request.comparisons.includes('previous')&&request.comparisons.includes('year_ago')){
    const previous=shiftDate(request.from,-1).slice(0,7);
    result.push({id:'previous_year_ago',role:'previous',...workbookMonthRange(`${Number(previous.slice(0,4))-1}-${previous.slice(5)}`)});
  }
  for(const period of workbookComparisonYearRanges({periodMode:request.period_mode,seasonCode:request.season_code,from:request.from,to:request.to,comparisonYears:request.comparison_years}))
    result.push({id:period.id,role:'comparison',from:period.from,to:period.to});
  if(request.report_type==='BAO_CAO_SAN_LUONG'){
    const completed=shiftDate(new Date(Date.parse(data.data_as_of)+2*3600000).toISOString().slice(0,10),-1);
    const anchor=completed<request.from?request.from:completed>request.to?request.to:completed;
    const start=shiftDate(anchor,-((new Date(anchor).getUTCDay()+2)%7));
    for(let offset=-2;offset<=1;offset++){
      const from=shiftDate(start,offset*7);
      result.push({id:`analysis-${from}`,role:'analysis-week',from,to:shiftDate(from,6)});
    }
  }
  return result;
}
export async function validateHtmlEnvelope(raw: unknown, request: HtmlRequest): Promise<HtmlEnvelope> {
  ensure(object(raw),'envelope');
  ensure(raw.contract_version===HTML_DATA_VERSION && raw.source_mode==='live' && raw.snapshot_scope==='single-statement','version');
  ensure(typeof raw.source_watermark==='string' && /^\d+$/.test(raw.source_watermark),'watermark');
  ensure(Number.isSafeInteger(raw.data_version) && Number(raw.data_version)>=0,'data version');
  ensure(typeof raw.data_as_of==='string' && Number.isFinite(Date.parse(raw.data_as_of)),'as of');
  ensure(pgJson(raw.normalized_request)===pgJson(request) && raw.request_hash===await htmlHash(request),'request hash');
  ensure(Array.isArray(raw.periods) && raw.periods.length>0 && Array.isArray(raw.resources) && Array.isArray(raw.calendar) && Array.isArray(raw.comparison_pairs),'arrays');
  const data = raw as unknown as HtmlEnvelope;
  ensure(data.resources.every(r=>object(r)&&Array.isArray(r.rows)),'resource shape');
  const ids = new Set<string>();
  for (const p of data.periods) {
    ensure(object(p) && typeof p.id==='string' && !ids.has(p.id),'period key'); ids.add(p.id);
    ensure(Object.keys(p).every(k=>['id','role','label','from','to','calendar_days','contains_future'].includes(k)),'unexpected period field');
    ensure(typeof p.from==='string' && typeof p.to==='string' && /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to)
      && p.from<=p.to && p.calendar_days===(Date.parse(p.to)-Date.parse(p.from))/86400000+1,'period bounds');
    ensure(typeof p.label==='string' && typeof p.contains_future==='boolean' && ['current','previous','next','comparison','analysis-week'].includes(p.role),'period role');
  }
  const current = data.periods.find(p=>p.id==='current');
  ensure(current?.from===request.from && current?.to===request.to && current.role==='current','current period');
  const expected=expectedPeriods(request,data);
  ensure(expected.length===data.periods.length && expected.every(p=>data.periods.some(actual=>actual.id===p.id&&actual.role===p.role&&actual.from===p.from&&actual.to===p.to)),'period semantics');
  const pairIds = new Set<string>();
  for (const pair of data.comparison_pairs) {
    ensure(object(pair)&&Object.keys(pair).every(k=>['id','minuend_period','baseline_period'].includes(k))&&typeof pair.id==='string','comparison fields');
    ensure(ids.has(pair.minuend_period) && ids.has(pair.baseline_period) && pair.minuend_period!==pair.baseline_period && !pairIds.has(pair.id),'comparison pair'); pairIds.add(pair.id);
  }
  const expectedPairs=expected.filter(p=>(p.role==='previous'||p.role==='comparison')&&p.id!=='previous_year_ago').map(p=>['current',p.id]);
  if(expected.some(p=>p.id==='previous_year_ago'))expectedPairs.push(['year_ago','previous_year_ago']);
  if(request.report_type==='WEEKLY_DETAIL')expectedPairs.push(['next','current']);
  const analysis=expected.filter(p=>p.role==='analysis-week').sort((a,b)=>a.from.localeCompare(b.from));
  analysis.slice(1).forEach((p,i)=>expectedPairs.push([p.id,analysis[i].id]));
  ensure(pgJson(expectedPairs.sort())===pgJson(data.comparison_pairs.map(p=>[p.minuend_period,p.baseline_period]).sort()),'comparison sign or pairs');
  ensure(data.resources.length===data.periods.length*DATASETS.length,'resource count');
  let count = 0;
  for (const p of data.periods) {
    const calendar = data.calendar.filter(d=>d.period_id===p.id);
    const calendarDates = new Set(calendar.map(d=>d.date));
    ensure(calendar.length===p.calendar_days && calendarDates.size===p.calendar_days,'calendar spine');
    for (const d of calendar) {ensure(object(d)&&Object.keys(d).every(k=>['period_id','date','month','iso_week','business_week'].includes(k)),'calendar fields');const day=new Date(d.date).getUTCDay();ensure(d.date>=p.from && d.date<=p.to && d.month===d.date.slice(0,7)
      && d.iso_week===shiftDate(d.date,-((day+6)%7)) && d.business_week===shiftDate(d.date,-((day+2)%7)),'calendar bucket');}
    for (const dataset of DATASETS) {
      const matches = data.resources.filter(r=>r.period_id===p.id && r.dataset===dataset);
      ensure(matches.length===1,'resource identity'); const res=matches[0];
      const expectedFilter = { dataset,period_id:p.id,from:p.from,to:p.to,airlines:request.airlines,routes:request.routes,countries:request.countries,time_basis:request.time_basis,directions:['A','D'] };
      ensure(res.complete===true && Array.isArray(res.rows) && res.row_count===res.rows.length && Array.isArray(res.totals),'complete resource');
      ensure(Object.keys(res).every(k=>['dataset','period_id','filter_hash','normalized_filter','complete','row_count','totals','rows'].includes(k)),'unexpected resource field');
      ensure(pgJson(res.normalized_filter)===pgJson(expectedFilter) && res.filter_hash===await htmlHash(expectedFilter),'resource hash');
      count+=res.rows.length; ensure(count<=HTML_MAX_ROWS,'HTML_RESOURCE_BUDGET');
      const keys=new Set<string>();
      for (const row of res.rows) {
        ensure(object(row) && object(row.grain) && ['A','D',...(dataset==='kpi'?['all']:[])].includes(row.direction),'row direction');
        ensure(Object.keys(row.grain).length===FIELDS[dataset].length && FIELDS[dataset].every(k=>Object.hasOwn(row.grain,k)),'grain fields');
        ensure(Object.values(row.grain).every(v=>v===null || typeof v==='string' || Number.isSafeInteger(v)),'grain values');
        const allowedRowKeys = dataset==='frequency' ? ['direction','grain','operating_days','occurrence_days','eligible_days','consistency_percent','typical_time'] : ['direction','grain','flight_coverage','pax_status',...METRICS];
        ensure(Object.keys(row).every(key=>allowedRowKeys.includes(key)),'unexpected row field');
        const key=pgJson([row.direction,row.grain]); ensure(!keys.has(key),'duplicate bucket'); keys.add(key);
        if (dataset==='frequency') {
          ensure(Number.isSafeInteger(row.occurrence_days) && Number.isSafeInteger(row.eligible_days) && row.occurrence_days!>=4
            && row.eligible_days!>=row.occurrence_days! && Number.isFinite(row.consistency_percent) && row.consistency_percent!>=70
            && row.consistency_percent!<=100 && Array.isArray(row.operating_days) && row.operating_days.every(d=>Number.isInteger(d)&&d>=1&&d<=7)
            && typeof row.typical_time==='string','frequency');
        } else validateMetric(row);
      }
      if (dataset==='frequency') { ensure(res.totals.length===0,'frequency is not a KPI partition'); continue; }
      ensure(res.totals.length===3 && new Set(res.totals.map(t=>t.direction)).size===3,'totals directions');
      for (const total of res.totals) { validateMetric(total); ensure(['A','D','all'].includes(total.direction),'total direction');
        ensure(Object.keys(total).every(k=>['direction','grain','flight_coverage','pax_status',...METRICS].includes(k)) && object(total.grain)&&Object.keys(total.grain).length===0,'total fields'); }
      for (const direction of ['A','D','all']) {
        const total=res.totals.find(t=>t.direction===direction)!;
        const rows=res.rows.filter(row=>dataset==='kpi' ? row.direction===direction : direction==='all' || row.direction===direction);
        const summed=sumHtmlMetrics(rows,total.flight_coverage);
        ensure(sameMetrics(summed,total),`${dataset} ${p.id} ${direction} total`);
        const kpi=data.resources.find(r=>r.dataset==='kpi'&&r.period_id===p.id)?.rows.find(t=>t.direction===direction);
        ensure(kpi && sameMetrics(total,kpi),'KPI reconciliation');
      }
      if (dataset==='kpi') {
        ensure(res.rows.length===3,'KPI rows');
        ensure(sameMetrics(sumHtmlMetrics(res.rows.filter(r=>r.direction!=='all')),res.rows.find(r=>r.direction==='all')!),'A+D KPI');
      }
      if (dataset==='timeline') {
        ensure(res.rows.length===p.calendar_days*2,'timeline spine');
        for (const row of res.rows) ensure(calendarDates.has(String(row.grain.date)),'timeline date');
      }
      if (dataset==='market_daily') {
        const byDay=new Map<string,HtmlRow[]>(),byMarket=new Map<string,HtmlRow[]>();
        for(const row of res.rows){
          ensure(calendarDates.has(String(row.grain.date)),'market daily date');
          const dayKey=pgJson([row.direction,row.grain.date]);
          const marketKey=pgJson([row.direction,row.grain.country,row.grain.route,row.grain.airline]);
          for(const [map,key] of [[byDay,dayKey],[byMarket,marketKey]] as const){const group=map.get(key)??[];group.push(row);map.set(key,group);}
        }
        const timeline=data.resources.find(r=>r.period_id===p.id&&r.dataset==='timeline')!;
        for(const day of timeline.rows)ensure(sameMetrics(sumHtmlMetrics(byDay.get(pgJson([day.direction,day.grain.date]))??[],day.flight_coverage),day),'market daily reconciliation');
        const market=data.resources.find(r=>r.period_id===p.id&&r.dataset==='market')!;
        for(const row of market.rows){const key=pgJson([row.direction,row.grain.country,row.grain.route,row.grain.airline]);
          ensure(sameMetrics(sumHtmlMetrics(byMarket.get(key)??[],row.flight_coverage),row),'market dimension reconciliation');byMarket.delete(key);}
        ensure(byMarket.size===0,'unexpected daily market group');
      }
    }
  }
  ensure(data.calendar.every(d=>ids.has(d.period_id)),'unknown calendar period');
  return data;
}
