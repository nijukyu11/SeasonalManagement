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
  const css=`:root{color-scheme:light;--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--accent:#1e40af;--surface:#f8fafc}*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}#report{max-width:1680px;margin:auto;padding:12px 16px}h1{font-size:17px;line-height:1.2;margin:0}h2{font-size:16px;margin:8px 0 6px}h3{font-size:15px}h1,h2,h3{text-wrap:balance}p{text-wrap:pretty}header{border-bottom:2px solid var(--accent);padding-bottom:6px;margin-bottom:4px}header p{margin:2px 0;font-size:12px}.header-main{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:4px}.header-title-box{display:inline-flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}.header-sub{font-size:12px;color:var(--muted);white-space:nowrap}.header-actions{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}.header-meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11px;color:var(--muted)}.meta-item{display:inline-flex;align-items:center}.meta-scope{max-width:460px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#334155}.meta-badge{background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:4px;font-weight:600}.meta-note{color:#64748b;background:transparent!important;border:0!important;padding:0!important;margin:0!important;font-size:11px!important}.btn-print{font-size:12px!important;min-height:30px!important;height:30px!important;padding:2px 10px!important}button,input,select{font:inherit;color:inherit}button,select,input{min-height:32px;border:1px solid var(--line);border-radius:6px;background:white;padding:3px 8px;font-size:13px}@media(pointer:coarse){button,select,input{min-height:44px}}button{cursor:pointer}button:hover{background:#eff6ff}button:active{background:#dbeafe}button:disabled{cursor:default;opacity:.5}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}nav.tabs{display:flex;flex-wrap:nowrap;overflow-x:auto;gap:4px;margin:4px 0 8px;border-bottom:2px solid #cbd5e1;padding-bottom:0}nav.tabs button{border:none;border-bottom:2px solid transparent;background:transparent;padding:4px 12px;min-height:32px;height:32px;font-size:13px;font-weight:500;color:#475569;border-radius:4px 4px 0 0;cursor:pointer;white-space:nowrap;flex:none;transition:all .15s}nav.tabs button:hover{background:#f1f5f9;color:#0f172a}nav.tabs button[aria-pressed="true"]{color:#1e40af;font-weight:700;border-bottom-color:#1e40af;background:#eff6ff}.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:8px;padding:8px 10px;background:white;border:1px solid var(--line);border-radius:6px}label{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:600}label input,label select{font-weight:400;max-width:260px}.comparisons{flex-basis:100%;border:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap}.comparisons label{flex-direction:row;align-items:center}.comparisons input{min-height:20px;width:18px}.table-scroll{max-height:calc(100vh - 180px);max-height:70dvh;overflow:auto;border:1px solid var(--line);margin-top:6px;background:white}table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;font-variant-numeric:tabular-nums}th,td{padding:7px 9px;border-bottom:1px solid #e2e8f0;border-right:1px solid #e2e8f0;vertical-align:middle}thead th{position:sticky;top:0;background:#dbe5f1;color:#0f172a;z-index:20;text-align:right;min-width:92px;font-size:13px}thead th.name{z-index:30;text-align:left}.name{text-align:left;min-width:200px;max-width:310px;position:sticky;left:0;background:white;z-index:10;overflow-wrap:anywhere;box-shadow:2px 0 5px -2px rgba(15,23,42,0.14)}.name button{text-align:left;max-width:290px;border:0;padding:0 4px;background:transparent;min-height:24px;font:inherit}.number{text-align:right;white-space:nowrap}.grand-total td,.grand-total th{font-weight:700;background:#dbeafe;color:#1e3a8a;border-top:2px solid #3b82f6}.notice{padding:6px 10px;background:#fffbeb;border-left:3px solid #a16207;color:#713f12;margin:4px 0;font-size:12px}.print-context{font-weight:600}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px;margin:10px 0}figure{margin:0;padding:12px;background:white;border:1px solid var(--line);min-width:0}figcaption{font-weight:700}figure svg{display:block;width:100%;max-height:250px;margin:12px auto}figure svg text{font:12px Arial,sans-serif;fill:var(--ink)}figure ol{columns:2;font-size:13px;padding-left:20px}section{margin-block:10px}.pagination{display:flex;gap:12px;align-items:center;justify-content:end;margin-top:8px}.skip{position:absolute;left:-10000px}.skip:focus{left:16px;top:8px;background:white;padding:8px;z-index:40}@media(max-width:600px){#report{padding:10px}h1{font-size:18px}.toolbar{padding:8px}.name{min-width:150px;max-width:200px}figure ol{columns:1}}@media print{@page{size:A4 landscape;margin:10mm}body{background:white;font-size:10px}#report{max-width:none;padding:0}.controls,.skip{display:none!important}.table-scroll{max-height:none;overflow:visible;border:0}table{font-size:9px;width:100%;table-layout:fixed}th,td{padding:4px;min-width:0!important;max-width:none!important;white-space:normal!important;overflow-wrap:anywhere}.name,thead th{position:static!important;min-width:0;max-width:none;box-shadow:none!important}thead{display:table-header-group}tr,figure{break-inside:avoid}.charts{display:grid;grid-template-columns:1fr 1fr}figure svg{max-height:160px}h2,h3{break-after:avoid}.notice{font-size:9px}.grand-total,.grand-total th,.grand-total td,.month-total,.month-total th,.month-total td,.pivot-group th,.pivot-group td,.meta-badge,.pivot-as-of-badge,.view-mode-badge,.diff-pos,.diff-neg,.diff-zero,.diff-warn,.heatmap-cell,tr[class*="hot-"] .heatmap-cell{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
  const detailsCss='details{margin:6px 0 6px 12px;border-left:2px solid var(--line);padding-left:10px}summary{min-height:32px;padding:4px 8px;cursor:pointer;font-weight:600}.diff-pos{color:#15803d!important;font-weight:600}.diff-neg{color:#b91c1c!important;font-weight:600}.diff-zero{color:#64748b!important}.diff-warn{color:#b45309!important;font-weight:600}.number small.diff-pos{color:#15803d!important}.number small.diff-neg{color:#b91c1c!important}.number small.diff-zero{color:#64748b!important}.number small.diff-warn{color:#b45309!important}.view-mode-bar{display:inline-flex;align-items:center;gap:2px;padding:2px;background:#e2e8f0;border-radius:6px;border:1px solid #cbd5e1;font-size:12px}.view-mode-badge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:4px;background:white;color:#1e40af;box-shadow:0 1px 2px rgba(15,23,42,0.08);min-height:26px;display:inline-flex;align-items:center}.view-mode-btn{font-size:12px!important;font-weight:600!important;min-height:26px!important;height:26px!important;padding:2px 10px!important;background:transparent!important;border:0!important;color:#475569!important;border-radius:4px!important;cursor:pointer;transition:all .15s ease}.view-mode-btn:hover{background:rgba(255,255,255,0.6)!important;color:#0f172a!important}.pivot-clue-banner,.summary-clue-banner{display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-left:3px solid #16a34a;padding:5px 10px;margin:4px 0;border-radius:6px;font-size:12px;color:#166534}.pivot-clue-banner strong,.summary-clue-banner strong{color:#14532d}.clue-close{margin-left:auto;background:transparent!important;border:none!important;cursor:pointer;font-size:14px;color:#166534!important;min-height:auto!important;padding:1px 4px!important}';
  const weeklyCss=`.weekly-report #report{max-width:1680px}.weekly-report .table-scroll{max-height:calc(100vh - 180px);max-height:70dvh}.weekly-report th,.weekly-report td{padding:7px 9px}.weekly-report thead th{min-width:82px;font-size:13px}.weekly-report .name{min-width:190px;max-width:260px}.weekly-report .weekly-summary .name{min-width:170px}.weekly-report .weekly-comparison table{min-width:990px}.weekly-report .weekly-summary table{min-width:680px}.weekly-report .weekly-comparison thead tr:nth-child(2) th{top:35px}.weekly-report .weekly-bands th{background:#dbe5f1;text-align:center}.weekly-report .weekly-bands th.name{text-align:left}.weekly-report .weekly-comparison td:nth-child(6),.weekly-report .weekly-comparison thead tr:nth-child(2) th:nth-child(6){border-left:2px solid #94a3b8}.weekly-report .weekly-comparison td:nth-child(3),.weekly-report .weekly-comparison td:nth-child(7){font-weight:700;background:#f8fafc}.weekly-report .grand-total td{background:#dbeafe!important;color:#1e3a8a!important}.weekly-report .weekly-direction td,.weekly-report .weekly-direction th{background:#f1f5f9;color:#475569;font-size:13px;font-weight:600}.weekly-tools{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px}.weekly-tools>label{flex-direction:row;align-items:center}.weekly-tools input[type=search]{max-width:260px}.weekly-options{border:0;margin:0;padding:0}.weekly-options .toolbar{margin-top:6px}.weekly-options[open]{flex-basis:100%}.weekly-disclosure{margin:10px 0;padding:0;border:1px solid var(--line);background:white;border-radius:6px}.weekly-disclosure>summary{padding:8px 12px}.weekly-disclosure>section,.weekly-disclosure>p,.weekly-disclosure>.charts{margin:10px}.weekly-impact{display:grid;grid-template-columns:1fr 1fr;gap:12px}.weekly-impact>section{background:white;border:1px solid var(--line);padding:12px;margin:0;border-radius:6px}.weekly-impact ul{margin:4px 0;padding-left:20px;font-size:13px}.weekly-impact li{margin:4px 0}.weekly-impact p,.period-note{font-size:12px;margin:4px 0;color:#475569}.weekly-footnote{font-size:12px;color:#475569;margin:6px 0}.weekly-reading{font-size:14px;border-left:3px solid #1e40af;padding:8px 12px;background:#eff6ff;border-radius:0 6px 6px 0}.weekly-drill{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}.weekly-report .print-context{font-size:13px;margin:8px 0}@media(max-width:700px){.weekly-impact{grid-template-columns:1fr}.weekly-report .name{min-width:150px;max-width:180px}.weekly-tools input[type=search]{width:100%}}@media print{.weekly-report .table-scroll{max-height:none!important;overflow:visible!important}.weekly-report .weekly-comparison table,.weekly-report .weekly-summary table{min-width:0}.weekly-report th,.weekly-report td{padding:4px}.weekly-report .weekly-comparison table{font-size:9px}.weekly-report thead th{font-size:9px}.weekly-report .name{min-width:0}.weekly-impact{grid-template-columns:1fr 1fr}.weekly-reading{font-size:11px}.weekly-report .grand-total td,.weekly-report .weekly-direction td,.weekly-report .weekly-direction th,.diff-pos,.diff-neg,.diff-zero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
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
const syncState={summaryTab:'',pivotTab:'',lastSearch:'',direction:'',metric:'',filters:{},fromMode:''};
const helpers={sum:${sumHtmlMetrics.toString()},compare:${compareHtmlMetrics.toString()},summary:function(tab,search){if(typeof tab==='string')syncState.summaryTab=tab;if(typeof search==='string')syncState.lastSearch=search;syncState.fromMode='pivot';showSummary();},pivot:function(tab,search){if(typeof tab==='string'){syncState.lastTab=tab;syncState.summaryTab=tab;}if(typeof search==='string')syncState.lastSearch=search;syncState.fromMode='summary';showPivot();},syncState,cleanup:undefined};
function attachModeBar(mode){
  if(data.normalized_request.report_type==='BAO_CAO_SAN_LUONG')return;
  const hdr=document.querySelector('#report header');
  if(!hdr)return;
  let actions=hdr.querySelector('.header-actions');
  if(!actions){
    let topRow=hdr.querySelector('.header-main');
    if(!topRow){
      topRow=document.createElement('div');
      topRow.className='header-main';
      const titleBox=document.createElement('div');
      titleBox.className='header-title-box';
      const h1=hdr.querySelector('h1');
      const p=hdr.querySelector('p');
      if(h1)titleBox.append(h1);
      if(p){p.className='header-sub';titleBox.append(p);}
      topRow.append(titleBox);
      hdr.prepend(topRow);
    }
    actions=document.createElement('div');
    actions.className='header-actions controls';
    const existingPrint=topRow.querySelector('.btn-print');
    if(existingPrint)actions.append(existingPrint);
    topRow.append(actions);
  }
  const oldBar=hdr.querySelector('.view-mode-bar');
  if(oldBar)oldBar.remove();
  const bar=document.createElement('div');
  bar.className='view-mode-bar controls';
  bar.setAttribute('role','region');
  bar.setAttribute('aria-label','Chế độ xem báo cáo');
  if(mode==='summary'){
    const cur=document.createElement('span');cur.className='view-mode-badge current-mode';cur.textContent='Tóm tắt và phân tích';
    const btn=document.createElement('button');btn.type='button';btn.className='controls view-mode-btn';btn.textContent='Bảng pivot mẫu';
    btn.onclick=function(){
      const activeBtn=document.querySelector('nav.tabs button[aria-pressed=true]');
      const activeTab=activeBtn?activeBtn.dataset.tab:'';
      const searchInp=document.querySelector('input[type=search],input[placeholder*="Tìm"]');
      const searchVal=searchInp?searchInp.value:'';
      helpers.pivot(activeTab,searchVal);
    };
    bar.append(cur,btn);
  }else{
    const btn=document.createElement('button');btn.type='button';btn.className='controls view-mode-btn';btn.textContent='Tóm tắt và phân tích';
    btn.onclick=function(){
      const activeBtn=document.querySelector('nav.tabs button[aria-pressed=true]');
      const activeTab=activeBtn?activeBtn.dataset.tab:'';
      const searchInp=document.querySelector('input[type=search],input[placeholder*="Tìm"]');
      const searchVal=searchInp?searchInp.value:'';
      helpers.summary(syncState.summaryTab||activeTab,searchVal);
    };
    const cur=document.createElement('span');cur.className='view-mode-badge current-mode';cur.textContent='Bảng pivot mẫu';
    bar.append(btn,cur);
  }
  actions.prepend(bar);
  if(!actions.querySelector('.btn-print')){
    const printBtn=document.createElement('button');
    printBtn.type='button';
    printBtn.className='controls btn-print';
    printBtn.textContent='In báo cáo';
    printBtn.onclick=function(){window.print();};
    actions.append(printBtn);
  }
}
function showSummary(){
if(helpers.cleanup){helpers.cleanup();helpers.cleanup=undefined;}
  document.body.classList.remove('pivot-report');
  (${mount.toString()})(data,helpers);
  attachModeBar('summary');
}
function showPivot(){
  (${mountTrafficHtmlPivot.toString()})(data,helpers);
  attachModeBar('pivot');
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
