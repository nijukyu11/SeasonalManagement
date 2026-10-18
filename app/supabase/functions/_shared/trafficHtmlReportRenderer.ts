import { HTML_MAX_BYTES,sumHtmlMetrics,compareHtmlMetrics,type HtmlEnvelope } from './trafficHtmlReportContract.ts';
import { mountTrafficHtmlReport } from './trafficHtmlReportRuntime.ts';
import { mountTrafficHtmlMonthly } from './trafficHtmlMonthlyRuntime.ts';
import { trafficHtmlMonthlyStyles } from './trafficHtmlMonthlyStyles.ts';
import { mountTrafficHtmlPivot } from './trafficHtmlPivotRuntime.ts';
import { trafficHtmlPivotStyles } from './trafficHtmlPivotStyles.ts';

export function serializeHtmlData(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
}
export function renderTrafficHtmlReport(data:HtmlEnvelope):string {
  const css=`:root{color-scheme:light;--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--accent:#1e40af;--surface:#f8fafc}*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:15px/1.4 Arial,sans-serif}#report{max-width:1600px;margin:auto;padding:16px 20px}h1{font-size:18px;margin:0}h2{font-size:18px;margin:10px 0 6px}h3{font-size:16px}h1,h2,h3{text-wrap:balance}p{text-wrap:pretty}header{border-bottom:2px solid var(--accent);padding-bottom:4px}header p{margin:2px 0;font-size:13px}button,input,select{font:inherit;color:inherit}button,select,input{min-height:36px;border:1px solid var(--line);border-radius:6px;background:white;padding:4px 10px}@media(pointer:coarse){button,select,input{min-height:44px}}button{cursor:pointer}button:hover{background:#eff6ff}button:active{background:#dbeafe}button:disabled{cursor:default;opacity:.5}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.tabs [aria-pressed=true]{background:var(--accent);color:white}.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:8px;padding:10px;background:white;border:1px solid var(--line)}label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600}label input,label select{font-weight:400;max-width:260px}.comparisons{flex-basis:100%;border:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap}.comparisons label{flex-direction:row;align-items:center}.comparisons input{min-height:20px;width:18px}.table-scroll{max-height:650px;overflow:auto;border:1px solid var(--line);margin-top:8px;background:white}table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}thead th{position:sticky;top:0;background:#e2e8f0;z-index:20;text-align:right;min-width:100px}thead th.name{z-index:30}.name{text-align:left;min-width:200px;max-width:320px;position:sticky;left:0;background:white;z-index:10;overflow-wrap:anywhere}.name button{text-align:left;max-width:300px;border:0;padding:0 6px;background:transparent}.number{text-align:right;white-space:nowrap}.grand-total td,.grand-total th{font-weight:700;background:#eff6ff}.notice{padding:6px 10px;background:#fffbeb;border-left:3px solid #a16207;color:#713f12;margin:4px 0;font-size:12px}.print-context{font-weight:600}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px;margin:12px 0}figure{margin:0;padding:12px;background:white;border:1px solid var(--line);min-width:0}figcaption{font-weight:700}figure svg{display:block;width:100%;max-height:250px;margin:12px auto}figure svg text{font:12px Arial,sans-serif;fill:var(--ink)}figure ol{columns:2;font-size:13px;padding-left:20px}section{margin-block:16px}.pagination{display:flex;gap:12px;align-items:center;justify-content:end;margin-top:8px}.skip{position:absolute;left:-10000px}.skip:focus{left:16px;top:8px;background:white;padding:8px;z-index:40}@media(max-width:600px){#report{padding:10px}h1{font-size:20px}.toolbar{padding:10px}.name{min-width:150px;max-width:200px}figure ol{columns:1}}@media print{@page{size:A4 landscape;margin:10mm}body{background:white;font-size:10px}#report{max-width:none;padding:0}.controls,.skip{display:none!important}.table-scroll{max-height:none;overflow:visible;border:0}table{font-size:9px;width:100%;table-layout:fixed}th,td{padding:4px;min-width:0!important;max-width:none!important;white-space:normal!important;overflow-wrap:anywhere}.name,thead th{position:static!important;min-width:0;max-width:none}thead{display:table-header-group}tr,figure{break-inside:avoid}.charts{display:grid;grid-template-columns:1fr 1fr}figure svg{max-height:160px}h2,h3{break-after:avoid}.notice{font-size:9px}.grand-total,.grand-total th,.grand-total td,.month-total,.month-total th,.month-total td,.meta-badge,.pivot-as-of-badge,.view-mode-badge,.diff-pos,.diff-neg,.diff-zero,.heatmap-cell,tr[class*="hot-"] .heatmap-cell{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
  const detailsCss='details{margin:6px 0 6px 12px;border-left:2px solid var(--line);padding-left:10px}summary{min-height:36px;padding:6px;cursor:pointer;font-weight:600}.diff-pos{color:#15803d!important;font-weight:600}.diff-neg{color:#b91c1c!important;font-weight:600}.diff-zero{color:#64748b!important}.number small.diff-pos{color:#15803d!important}.number small.diff-neg{color:#b91c1c!important}.number small.diff-zero{color:#64748b!important}@keyframes reportFadeIn{from{opacity:0.35;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}.report-fade-in{animation:reportFadeIn 160ms ease-out forwards}.view-mode-bar{display:inline-flex;align-items:center;gap:6px;margin-top:4px;padding:2px 8px;background:#f1f5f9;border-radius:6px;border:1px solid #cbd5e1;font-size:12px}.view-mode-label{font-size:12px;font-weight:700;color:var(--muted)}.view-mode-badge{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px;background:white;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,0.06)}.view-mode-btn{font-size:12px!important;font-weight:600!important;min-height:28px!important;padding:2px 10px!important;background:#eff6ff!important;border:1px solid #93c5fd!important;color:#1e40af!important;border-radius:4px!important;cursor:pointer;transition:all .15s ease}.view-mode-btn:hover{background:#dbeafe!important;border-color:#3b82f6!important}.tabs button.tab-mode-switch{background:#f8fafc!important;border:1.5px solid #64748b!important;color:#1e40af!important;font-weight:700!important;display:inline-flex;align-items:center;gap:6px;margin-right:6px;min-height:32px!important;height:32px!important;padding:2px 8px!important;box-shadow:0 1px 2px rgba(0,0,0,0.06)}.tabs button.tab-mode-switch:hover{background:#e2e8f0!important;border-color:#334155!important}.tab-divider{border-right:2px solid #cbd5e1;margin:2px 6px;align-self:stretch;display:inline-block}.pivot-clue-banner,.summary-clue-banner{display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-left:3px solid #16a34a;padding:6px 12px;margin:6px 0;border-radius:6px;font-size:13px;color:#166534}.pivot-clue-banner strong,.summary-clue-banner strong{color:#14532d}.clue-close{margin-left:auto;background:transparent!important;border:none!important;cursor:pointer;font-size:15px;color:#166534!important;min-height:auto!important;padding:1px 4px!important}';
  const weeklyCss=`.weekly-report #report{max-width:1380px}.weekly-report header{padding-bottom:10px}.weekly-report header .notice{font-size:13px;padding:8px;margin-bottom:0}.weekly-report .tabs{margin:14px 0;gap:6px}.weekly-report h2{margin:16px 0 8px}.weekly-report h3{font-size:16px;margin:0 0 8px}.weekly-report h4{font-size:14px;margin:12px 0 4px}.weekly-report section{margin-block:14px}.weekly-report .table-scroll{max-height:calc(100vh - 180px);max-height:70dvh}.weekly-report th,.weekly-report td{padding:8px 10px}.weekly-report thead th{min-width:82px;font-size:13px}.weekly-report .name{min-width:190px;max-width:240px}.weekly-report .weekly-summary .name{min-width:170px}.weekly-report .weekly-comparison table{min-width:990px}.weekly-report .weekly-summary table{min-width:680px}.weekly-report .weekly-comparison thead tr:nth-child(2) th{top:36px}.weekly-report .weekly-bands th{background:#dbeafe;text-align:center}.weekly-report .weekly-bands th.name{text-align:left}.weekly-report .weekly-comparison td:nth-child(6),.weekly-report .weekly-comparison thead tr:nth-child(2) th:nth-child(6){border-left:2px solid #94a3b8}.weekly-report .weekly-comparison td:nth-child(3),.weekly-report .weekly-comparison td:nth-child(7){font-weight:700;background:#f8fafc}.weekly-report .grand-total td{background:#eff6ff!important}.weekly-report .weekly-direction td,.weekly-report .weekly-direction th{background:#f1f5f9;color:#475569;font-size:13px}.weekly-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}.weekly-tools>label{flex-direction:row;align-items:center}.weekly-tools input[type=search]{max-width:260px}.weekly-options{border:0;margin:0;padding:0}.weekly-options .toolbar{margin-top:6px}.weekly-options[open]{flex-basis:100%}.weekly-disclosure{margin:14px 0;padding:0;border:1px solid var(--line);background:white}.weekly-disclosure>summary{padding:10px 14px}.weekly-disclosure>section,.weekly-disclosure>p,.weekly-disclosure>.charts{margin:12px}.weekly-impact{display:grid;grid-template-columns:1fr 1fr;gap:14px}.weekly-impact>section{background:white;border:1px solid var(--line);padding:14px;margin:0}.weekly-impact ul{margin:4px 0;padding-left:20px;font-size:14px}.weekly-impact li{margin:5px 0}.weekly-impact p,.period-note{font-size:13px;margin:6px 0;color:#475569}.weekly-footnote{font-size:12px;color:#475569;margin:8px 0}.weekly-reading{font-size:15px;border-left:3px solid #1e40af;padding:8px 12px;background:#eff6ff}.weekly-drill{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:14px}.weekly-report .print-context{font-size:14px;margin:10px 0}@media(max-width:700px){.weekly-impact{grid-template-columns:1fr}.weekly-report .name{min-width:150px;max-width:180px}.weekly-tools input[type=search]{width:100%}}@media print{.weekly-report .table-scroll{max-height:none!important;overflow:visible!important}.weekly-report .weekly-comparison table,.weekly-report .weekly-summary table{min-width:0}.weekly-report th,.weekly-report td{padding:4px}.weekly-report .weekly-comparison table{font-size:9px}.weekly-report thead th{font-size:9px}.weekly-report .name{min-width:0}.weekly-impact{grid-template-columns:1fr 1fr}.weekly-reading{font-size:11px}.weekly-report .grand-total td,.weekly-report .weekly-direction td,.weekly-report .weekly-direction th,.diff-pos,.diff-neg,.diff-zero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
  // Pick the documented envelope only; no HTTP headers, credentials or source rows.
  const embedded={contract_version:data.contract_version,source_mode:data.source_mode,source_watermark:data.source_watermark,data_version:data.data_version,
    data_as_of:data.data_as_of,snapshot_scope:data.snapshot_scope,normalized_request:data.normalized_request,request_hash:data.request_hash,
    periods:data.periods,comparison_pairs:data.comparison_pairs,calendar:data.calendar,resources:data.resources};
  const rt=data.normalized_request.report_type;
  const monthly=rt==='MONTHLY_OVERVIEW_L2';
  const mount=monthly?mountTrafficHtmlMonthly:mountTrafficHtmlReport;
 const docTitle=monthly?'Tổng quan khai thác tháng':rt==='WEEKLY_DETAIL'?'Báo cáo tuần chi tiết':rt==='BAO_CAO_SAN_LUONG'?'Báo cáo sản lượng':rt==='MASTER_OPERATIONS'?'Báo cáo tổng hợp khai thác':'Phân tích theo kỳ';
  const pivotFirst=rt==='BAO_CAO_SAN_LUONG'||rt==='PERIOD_ANALYSIS'||rt==='MASTER_OPERATIONS';
  // Pivot reference tables open first for season/period reports; weekly/monthly summaries open first.
  const runtime=`const data=JSON.parse(document.getElementById('report-data').textContent);
const syncState={summaryTab:'',pivotTab:'',lastSearch:'',fromMode:''};
const helpers={
  sum:(${sumHtmlMetrics.toString()}),
  compare:(${compareHtmlMetrics.toString()}),
  summary:function(tab,search){
    syncState.fromMode='pivot';
    if(tab)syncState.summaryTab=tab;
    if(search!==undefined)syncState.lastSearch=search;
    showSummary();
  },
  pivot:function(tab,search){
    syncState.fromMode='summary';
    if(tab)syncState.summaryTab=tab;
    if(search!==undefined)syncState.lastSearch=search;
    showPivot();
  },
  syncState:syncState
};
function showSummary(){
  document.body.classList.remove('pivot-report','report-fade-in');
  void document.body.offsetWidth;
  document.body.classList.add('report-fade-in');
  (${mount.toString()})(data,helpers);
  const bar=document.createElement('div');
  bar.className='view-mode-bar controls';
  bar.setAttribute('role','region');
  bar.setAttribute('aria-label','Chế độ xem báo cáo');
  const lbl=document.createElement('span');lbl.className='view-mode-label';lbl.textContent='Chế độ xem:';
  const cur=document.createElement('span');cur.className='view-mode-badge current-mode';cur.textContent='📊 Báo cáo chuẩn';
  const button=document.createElement('button');
  button.type='button';
  button.className='controls view-mode-btn';
  button.textContent='Bảng pivot mẫu';
  button.onclick=function(){
    const activeBtn=document.querySelector('nav.tabs button[aria-pressed=true]');
    const activeTab=activeBtn?activeBtn.dataset.tab:'';
    const searchInp=document.querySelector('input[type=search],input[placeholder*="Tìm"]');
    const searchVal=searchInp?searchInp.value:'';
    helpers.pivot(activeTab,searchVal);
  };
  bar.append(lbl,cur,button);
  const hdr=document.querySelector('#report header');
  if(hdr)hdr.append(bar);
}
function showPivot(){
  document.body.classList.remove('report-fade-in');
  void document.body.offsetWidth;
  document.body.classList.add('report-fade-in');
  (${mountTrafficHtmlPivot.toString()})(data,helpers);
}
${pivotFirst?'showPivot();':'showSummary();'}`;
  const html=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${docTitle}</title><style>${css}${detailsCss}${weeklyCss}${monthly?trafficHtmlMonthlyStyles:''}${trafficHtmlPivotStyles}</style></head><body><a class="skip" href="#main">Đến bảng báo cáo</a><div id="report"></div><noscript>Bật JavaScript trong trình duyệt để đọc báo cáo tương tác.</noscript><script id="report-data" type="application/json">${serializeHtmlData(embedded)}</script><script>${runtime}</script></body></html>`;
  if(new TextEncoder().encode(html).byteLength>HTML_MAX_BYTES)throw new Error('HTML_RESOURCE_BUDGET');
  return html;
}
export function trafficHtmlFilename(data:HtmlEnvelope):string {
  const prefix=data.normalized_request.report_type==='WEEKLY_DETAIL'?'bao-cao-tuan':data.normalized_request.report_type==='BAO_CAO_SAN_LUONG'?'bao-cao-san-luong':data.normalized_request.report_type==='MONTHLY_OVERVIEW_L2'?'tong-quan-khai-thac-thang':'phan-tich-theo-ky';
  return `${prefix}-${data.normalized_request.from}-${data.normalized_request.to}-${data.data_as_of.replace(/[^0-9]/g,'').slice(0,14)}.html`;
}
