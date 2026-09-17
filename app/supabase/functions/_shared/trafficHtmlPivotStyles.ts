export const trafficHtmlPivotStyles = `
.pivot-tools .pivot-filter-grid{max-height:min(320px,35dvh);overflow:auto;overscroll-behavior:contain}
.table-tools{position:sticky;top:0;z-index:40;background:white;display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 8px;border:1px solid var(--line)}.table-tools button{font-size:13px;min-height:32px;height:32px;padding:3px 8px}.pivot-tools.table-tools{margin:4px 0}.pivot-tools .pivot-display{border:0;margin:0;padding:0}.pivot-display summary{border:1px solid var(--line);border-radius:6px;font-size:13px;min-height:32px;padding:4px 8px}.pivot-display[open]{flex-basis:100%}.pivot-display-body{display:flex;flex-wrap:wrap;gap:8px;align-items:end;padding-top:6px}.report-table-section{position:relative}.pivot-report .table-tools label{font-size:12px}.pivot-report .table-tools>label>input{max-width:200px}@media print{.table-tools{display:none!important}}
.pivot-report .period-total{background:#f1f5f9;font-weight:700;border-left:1px solid #94a3b8}.pivot-report .bao-month>figure{margin-top:43px;overflow-x:auto}.bao-month figure svg{max-height:none;min-height:220px;min-width:640px}.bao-month figure svg text{font-size:20px}.pivot-print-pages{display:none}
@media print{.pivot-print-pages{display:block}.print-ready>*:not(.pivot-print-pages){display:none!important}.pivot-print-pages>section{break-before:page}.pivot-print-pages>section:first-child{break-before:auto}.pivot-print-pages table th,.pivot-print-pages table td{font-size:10px!important}.bao-month figure svg{min-width:0}.pivot-report .bao-month>figure{overflow:visible}}
.pivot-report #report{max-width:1800px;padding:12px 16px}.pivot-report header{padding-bottom:4px}.pivot-report h1{font-size:17px;line-height:1.2;margin:0}.pivot-report h2{font-size:16px;margin:6px 0}.pivot-report section{margin:8px 0;min-width:0}.pivot-report .tabs{gap:4px;margin:4px 0 6px;display:flex;flex-wrap:nowrap;overflow-x:auto;border-bottom:2px solid #cbd5e1;padding-bottom:0}
.header-main{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:2px}
.header-title-box{display:inline-flex;align-items:baseline;gap:8px;min-width:0;flex-wrap:wrap}
.header-sub{font-size:12px;color:var(--muted);white-space:nowrap}
.header-meta-row{font-size:12px;color:#475569;margin:2px 0 4px;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;line-height:1.4}
.meta-item{display:inline-flex;align-items:center;gap:4px}
.meta-scope{max-width:min(550px,65vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta-badge{background:#f1f5f9;border:1px solid #e2e8f0;padding:1px 6px;border-radius:4px;font-size:11px}
.btn-print{font-size:12px!important;min-height:30px!important;height:30px!important;padding:2px 10px!important}
.pivot-report nav.tabs button{border:none;border-bottom:2px solid transparent;background:transparent;padding:4px 12px;min-height:32px;height:32px;font-size:13px;font-weight:500;color:#475569;border-radius:4px 4px 0 0;cursor:pointer;white-space:nowrap;flex:none;transition:all .15s}
.pivot-report nav.tabs button:hover{background:#f1f5f9;color:#0f172a}
.pivot-report nav.tabs button[aria-pressed="true"]{color:#1e40af;font-weight:700;border-bottom-color:#1e40af;background:#eff6ff}
.pivot-note{font-size:12px;color:var(--muted);margin:4px 0}.pivot-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--line);background:white}.pivot-tools>label{font-size:12px}.pivot-tools button,.pivot-tools input,.pivot-tools select{font-size:13px;min-height:32px;height:32px;padding:3px 8px}.pivot-tools .pivot-filters{border:0;margin:0;padding:0}.pivot-filters[open]{flex-basis:100%}.pivot-filters summary{border:1px solid var(--line);border-radius:6px;font-size:13px;min-height:32px;padding:4px 8px}.pivot-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding-top:6px}.pivot-filter-grid fieldset{min-width:0;border:1px solid var(--line)}.pivot-filter-grid input[type=search]{width:100%;max-width:none}.pivot-filter-options{max-height:180px;overflow:auto;margin-top:6px}.pivot-filter-options label{flex-direction:row;align-items:center;min-height:32px;font-weight:400}.pivot-filter-options input{min-height:18px;width:18px;height:18px;flex:none}.pivot-filter-options label[hidden]{display:none}
@media(pointer:coarse){.pivot-report nav.tabs button,.pivot-tools button,.pivot-tools input,.pivot-tools select,.btn-print{min-height:44px!important;height:44px!important}}
.pivot-report th,.pivot-report td{padding:7px 9px;border-right:1px solid #e2e8f0;vertical-align:middle}.pivot-report thead th{min-width:92px;text-align:center;white-space:pre-line;background:#dbe5f1;font-size:13px;position:sticky;top:0;z-index:20}.pivot-report thead tr:first-child th{border-bottom:1px solid #94a3b8;top:0;z-index:22}.pivot-report thead tr:nth-child(2) th{top:35px;z-index:20}.pivot-report thead .name{z-index:35}.pivot-report .name{min-width:210px;max-width:310px;text-align:left;position:sticky;left:0;background:white;z-index:10}.pivot-report .name button{min-height:36px;font-size:14px;padding:0 4px}.pivot-report .table-scroll{max-height:70dvh;margin-top:8px;position:relative;overflow:auto}.pivot-group>.name{font-weight:700}.pivot-child>.name{font-weight:400}.pivot-report .grand-total>*{background:#dbe5f1;font-weight:700;border-top:2px solid #94a3b8;position:sticky;bottom:0;z-index:25;box-shadow:0 -2px 5px rgba(15,23,42,0.08)}.pivot-report .grand-total .name{z-index:30}.pivot-report .month-total>*{background:#f1f5f9;font-weight:700;border-top:1px solid #94a3b8}.pivot-report td sup{margin-left:3px;font-size:12px}.pivot-report .print-context{font-size:14px;margin:12px 0 4px}.bao-total{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:18px;align-items:start}.bao-total table{font-size:13px}.bao-total th,.bao-total td{padding:7px 6px;white-space:nowrap}.bao-total thead th{min-width:66px;font-size:12px}.bao-total td:nth-child(2){min-width:88px}.pivot-report figure svg{max-height:320px}.pivot-report figure{margin:12px 0}
@media(max-width:1000px){.bao-total{grid-template-columns:1fr}.pivot-report #report{padding:12px}.pivot-report .name{min-width:165px;max-width:200px}}@media(max-width:600px){.pivot-filter-grid{grid-template-columns:1fr}.pivot-tools{padding:10px}.pivot-tools>label{max-width:100%}.pivot-tools label select{max-width:100%}.pivot-report h1{font-size:22px}}
.section-header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0}.section-header h2{margin:0}.table-actions{display:flex;gap:6px;align-items:center}@media print{.table-actions{display:none!important}}
@media print{.pivot-report #report{padding:0}.pivot-report .table-scroll{max-height:none;overflow:visible}.pivot-report table{font-size:8px;table-layout:fixed}.pivot-report thead th{font-size:8px}.pivot-report th,.pivot-report td{padding:3px!important;white-space:normal!important}.pivot-report .name{min-width:0}.pivot-report .name button{min-height:0;font-size:8px}.pivot-report .pagination{display:none}.pivot-report .grand-total>*{position:static}.bao-total{grid-template-columns:1fr 1fr;gap:10px}.pivot-note{font-size:9px}.pivot-report h2{font-size:12px}.pivot-report figure svg{max-height:190px}}
.pivot-report .name{box-shadow:2px 0 5px -2px rgba(15,23,42,0.18)}
.pivot-highlight{background-color:#fef08a;color:#854d0e;padding:0 2px;border-radius:2px;font-weight:600}
.pivot-filter-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;margin-top:6px;padding:6px 8px;background:#f8fafc;border:1px dashed var(--line);border-radius:6px;font-size:13px}
.pivot-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#e2e8f0;color:#1e293b;border-radius:9999px;font-size:12px;font-weight:500}
.pivot-chip button{background:none;border:none;padding:0 2px;cursor:pointer;color:#64748b;font-size:14px;line-height:1;border-radius:50%}
.pivot-chip button:hover{color:#dc2626;background:#fee2e2}
.pivot-clear-filters{font-size:12px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:white;cursor:pointer;color:#dc2626;font-weight:600}
.pivot-clear-filters:hover{background:#fef2f2;border-color:#fca5a5}
.pivot-as-of-badge{display:inline-flex;align-items:center;gap:6px;background:#f1f5f9;padding:3px 8px;border-radius:4px;border:1px solid #e2e8f0;font-size:12px;color:#334155}
.future-row{opacity:0.92;background-color:#f8fafc}
.pivot-btn-action{background:#f8fafc;border:1px solid var(--line);border-radius:4px;cursor:pointer;font-size:13px;padding:4px 8px}
.pivot-btn-action:hover{background:#e2e8f0}
.pivot-filter-actions{display:flex;gap:6px;margin:4px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.pivot-filter-btn{font-size:11px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;cursor:pointer;color:#1e40af;font-weight:600}
.pivot-filter-btn:hover{background:#eff6ff;border-color:#93c5fd}
.pivot-cell-bar{position:absolute;left:0;top:0;bottom:0;background:rgba(37,99,235,0.12);pointer-events:none;z-index:0;border-radius:2px}
.pivot-cell-val{position:relative;z-index:1}
.pivot-child .name{border-left:2px solid #cbd5e1}
.pivot-drawer-overlay{position:fixed;inset:0;background:rgba(15,23,42,0.4);z-index:998;backdrop-filter:blur(2px)}
.pivot-drawer{position:fixed;top:0;right:0;bottom:0;width:min(720px,92vw);background:white;z-index:999;box-shadow:-6px 0 24px rgba(15,23,42,0.18);display:flex;flex-direction:column;padding:20px;overflow:auto}
.pivot-drawer-header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid var(--accent);padding-bottom:12px;margin-bottom:16px}
.pivot-drawer-header h3{margin:0;font-size:18px}
.pivot-drawer-close{background:#f1f5f9;border:1px solid var(--line);border-radius:6px;cursor:pointer;font-size:18px;font-weight:bold;padding:4px 10px}
.pivot-drawer-close:hover{background:#fee2e2;color:#dc2626}
.pivot-clickable{cursor:pointer;text-decoration:underline dotted #64748b;text-underline-offset:3px}
.pivot-clickable:hover{color:#1e40af;background:#eff6ff!important;font-weight:700}
.heatmap-cell{transition:background-color .15s}
.heatmap-cell.hot-1{background:#eff6ff}
.heatmap-cell.hot-2{background:#dbeafe}
.heatmap-cell.hot-3{background:#bfdbfe}
.heatmap-cell.hot-4{background:#93c5fd;font-weight:600}
.heatmap-cell.hot-5{background:#60a5fa;color:white;font-weight:700}
.pivot-tab-panel{display:none}
.pivot-tab-panel.active{display:block}
@media print{.pivot-report .name{box-shadow:none}}
.pivot-report .period-total{border-left:2px solid #64748b}
.pivot-report th.period-start,.pivot-report td.period-start{border-left:2px solid #64748b}
.pivot-report thead th.period-current{background-color:#bfdbfe}
.pivot-report td.period-current{background-color:#eff6ff}
@media(max-width:600px){.pivot-report .tabs{flex-wrap:nowrap;overflow-x:auto}.pivot-report nav.tabs button{flex:none;white-space:nowrap}}
.diff-pos{color:#15803d!important;font-weight:600}.diff-neg{color:#b91c1c!important;font-weight:600}.diff-zero{color:#64748b!important}
.number small.diff-pos{color:#15803d!important}.number small.diff-neg{color:#b91c1c!important}.number small.diff-zero{color:#64748b!important}
.pivot-kpi-band{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;margin:4px 0 6px}
.pivot-kpi-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:4px 10px;box-shadow:0 1px 2px rgba(0,0,0,0.04)}
.pivot-kpi-label{font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:1px}
.pivot-kpi-value{font-size:15px;font-weight:700;color:#0f172a;line-height:1.2}
.pivot-kpi-sub{font-size:11px;color:#475569;margin-top:1px}
.pivot-kpi-alert{color:#b45309}
@media print{.pivot-kpi-band{grid-template-columns:repeat(4,1fr);gap:4px}.pivot-kpi-card{padding:3px 6px;border:1px solid #ccc}.pivot-kpi-value{font-size:14px}}
`;
