// Scoped to the monthly document; weekly and existing period exports stay unchanged.
export const trafficHtmlMonthlyStyles=`
.monthly-report #report{max-width:1440px}
.monthly-report header{padding-bottom:10px}
.monthly-report header .notice{font-size:13px;padding:8px}
.monthly-report section{margin-block:16px}
.monthly-report h2{margin:16px 0 10px}
.monthly-report h3{font-size:16px;margin:0 0 10px}
.monthly-report h4{font-size:14px;margin:10px 0 4px}
.monthly-report th,.monthly-report td{padding:8px 10px}
.monthly-report .table-scroll{max-height:calc(100vh - 180px);max-height:70dvh}
.monthly-report thead th{min-width:90px;font-size:13px}
.monthly-report .name{min-width:175px;max-width:240px}
.monthly-report .monthly-metric{text-align:left;font-weight:400;min-width:105px;font-size:13px}
.monthly-report .monthly-matrix table{min-width:960px}
.monthly-report .number small{display:block;color:var(--muted);font-weight:400;font-size:12px;white-space:nowrap}
.monthly-report .monthly-current{background:#f1f5f9;font-weight:700;border-left:2px solid #94a3b8}
.monthly-report .grand-total td,.monthly-report .grand-total th{background:#eff6ff}
.monthly-direction td,.monthly-direction th{background:#f8fafc;color:var(--muted);font-size:13px}
.monthly-trend td{background:#f8fafc}.monthly-trend p{margin:3px 0;font-size:12px;color:var(--muted)}
.monthly-tools{display:flex;flex-wrap:wrap;align-items:end;gap:10px;margin:10px 0}
.monthly-tools input[type=search]{max-width:230px}
.monthly-options{margin:0;padding:0;border:0}
.monthly-options[open]{flex-basis:100%}
.monthly-options .toolbar{margin-top:6px}
.monthly-disclosure{margin:14px 0;border:1px solid var(--line);padding:0;background:white}
.monthly-disclosure>summary{padding:10px 14px}
.monthly-disclosure>p,.monthly-disclosure>.charts,.monthly-disclosure>textarea,.monthly-disclosure>button,.monthly-disclosure>.monthly-impact{margin:12px}
.monthly-disclosure textarea{display:block;width:calc(100% - 24px);font:14px/1.6 Arial,sans-serif;padding:12px;border:1px solid var(--line);resize:vertical;color:var(--ink);background:white}
.monthly-impact{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.monthly-impact>section{margin:0;padding:14px;background:white;border:1px solid var(--line);min-width:0}
.monthly-impact p,.monthly-impact li{font-size:14px;margin:5px 0}
.monthly-impact ul{padding-left:20px;margin:4px 0}
.monthly-highlights{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.monthly-highlights>section{background:white;border:1px solid var(--line);padding:14px;margin:0}
.monthly-highlights p{font-size:14px;margin:5px 0}
.monthly-highlights button{margin-top:10px}
.monthly-reading{background:#eff6ff;border-left:3px solid var(--accent);padding:14px}
.monthly-reading p{margin:6px 0;font-size:14px}
.monthly-footnote{font-size:12px;color:var(--muted);margin:8px 0}
.monthly-report .print-context{font-size:14px}
.monthly-swatch{display:inline-block;width:12px;height:12px;margin-right:6px}
.monthly-report .charts{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:700px){.monthly-impact,.monthly-highlights,.monthly-report .charts{grid-template-columns:1fr}.monthly-report .name{min-width:145px;max-width:180px}.monthly-tools label{max-width:100%}.monthly-tools input{min-width:0}.monthly-report .pagination{gap:8px;flex-wrap:wrap}}
@media print{.monthly-report .table-scroll{max-height:none!important;overflow:visible!important}.monthly-report .monthly-matrix table{min-width:0}.monthly-report th,.monthly-report td{padding:4px}.monthly-report thead th,.monthly-report .monthly-metric{font-size:9px;min-width:0}.monthly-report .number small{font-size:8px;white-space:normal}.monthly-report .name{min-width:0}.monthly-impact{grid-template-columns:1fr 1fr}.monthly-reading p,.monthly-impact p,.monthly-impact li{font-size:10px}.monthly-footnote,.monthly-trend p{font-size:9px}.monthly-disclosure textarea,.monthly-disclosure>button{display:none}.monthly-report .grand-total td,.monthly-report .grand-total th,.monthly-current,.diff-pos,.diff-neg,.diff-zero{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.diff-pos{color:#15803d!important;font-weight:600}.diff-neg{color:#b91c1c!important;font-weight:600}.diff-zero{color:#64748b!important}
.number small.diff-pos{color:#15803d!important}.number small.diff-neg{color:#b91c1c!important}.number small.diff-zero{color:#64748b!important}
`;
