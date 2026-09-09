import type { HtmlEnvelope, HtmlMetric, HtmlRow, HtmlPeriod, Direction, sumHtmlMetrics, compareHtmlMetrics } from './trafficHtmlReportContract.ts';

// Embedded verbatim after TypeScript erasure. All runtime dependencies are passed explicitly.
export function mountTrafficHtmlPivot(data: HtmlEnvelope, helpers: {
  sum: typeof sumHtmlMetrics; compare: typeof compareHtmlMetrics; summary: () => void;
}) {
  type BaseMetric = 'flights' | 'reported_pax';
  type Metric = BaseMetric | 'flights_per_day' | 'pax_per_flight';
  type Row = HtmlRow & { period: string };
  type Column = { id: string; period: string; from: string; to: string; label: string; total?: boolean; dateSet?: Set<string> };
  type Tab = { id: string; label: string; levels: string[]; month?: string; analysis?: boolean };
  type State = { metric: string; direction: string; time: string; period: string; search: string; filters: Record<string, Set<string>>;
    depth: number; open: Set<string>; closed: Set<string>; page: number; pageSize: number; levels: string[]; sort: string };
  type Tree = { id: string; label: string; rows: Row[]; children: Tree[] };
  const { sum, compare } = helpers;
  const bao = data.normalized_request.report_type === 'BAO_CAO_SAN_LUONG';
  const weekly = data.normalized_request.report_type === 'WEEKLY_DETAIL';
  const current = data.periods.find(p => p.id === 'current')!;
  const ordinary = data.periods.filter(p => p.role !== 'analysis-week').sort((a,b) => a.from.localeCompare(b.from));
  const weeks = data.periods.filter(p => p.role === 'analysis-week').sort((a,b) => a.from.localeCompare(b.from));
  const resources = new Map(data.resources.map(r => [`${r.period_id}/${r.dataset}`, r]));
  const monthKeys = [...new Set(data.calendar.filter(d => d.period_id === 'current').map(d => d.month))].sort();
  const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const labels: Record<string,string> = { airline:'Hãng hàng không',country:'Thị trường',route:'Chặng bay',date:'Ngày',month:'Tháng' };
  const metricLabels = { flights:'Chuyến bay',reported_pax:'Hành khách',flights_per_day:'TB Chuyến / Ngày',pax_per_flight:'Khách / Chuyến' };
  const dirLabels = { A:'Đến',D:'Đi',all:'Tổng' };
  const fmt = (n: number | null, decimal = false) => n === null ? '—' : new Intl.NumberFormat('vi-VN',{maximumFractionDigits:decimal?2:0}).format(n);
  const date = (s: string) => `${s.slice(8,10)}/${s.slice(5,7)}/${s.slice(0,4)}`;
  const range = (p: {from:string;to:string}) => `${date(p.from)} – ${date(p.to)}`;
  const name = (field: string, value: unknown) => value == null || value === '' ? 'Chưa xác định'
    : field === 'date' ? date(String(value)) : field === 'month' ? `Tháng ${String(value).slice(5)}/${String(value).slice(0,4)}` : String(value);
  const latestCompletedOpsDate = (asOfIso: string): string => {
    const ms = Date.parse(asOfIso); if (isNaN(ms)) return asOfIso.slice(0, 10);
    const vn = new Date(ms + 7 * 3600000); const sub = vn.getUTCHours() < 5 ? 2 : 1;
    return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - sub)).toISOString().slice(0, 10);
  };
  const completedOpsDate = data.data_as_of ? latestCompletedOpsDate(data.data_as_of) : null;
  const sanitize = (t: string, isNumber = false) => {
    const clean = (t ?? '').trim().replace(/\s+/g, ' ');
    if (isNumber) return clean;
    return /^[=+@\-\t\r]/.test(clean) ? `'${clean}` : clean;
  };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
    const node = document.createElement(tag); if(text !== undefined) node.textContent = text; if(cls) node.className = cls; return node;
  };
  const button = (text: string, action: () => void) => { const b=el('button',text); b.type='button'; b.setAttribute('aria-label',text); b.onclick=action; return b; };
  const select = (label: string, options: string[][], value: string, action: (v:string)=>void) => {
    const wrap=el('label',label), control=el('select'); control.setAttribute('aria-label',label);
    for(const [key,text] of options){const o=el('option',text);o.value=key;control.append(o);} control.value=value;
    control.onchange=()=>action(control.value);wrap.append(control);return wrap;
  };
  const tabs: Tab[] = bao ? [
    {id:'total',label:'TOTAL',levels:['month','date']},
    ...monthKeys.map(month=>({id:month,label:`${monthNames[Number(month.slice(5))-1]} ${month.slice(0,4)}`,levels:['date'],month})),
    {id:'analysis-airline',label:'Analysis_Airline',levels:['airline'],analysis:true},
    {id:'analysis-country',label:'Analysis_Country',levels:['country'],analysis:true},
  ] : [
    {id:'airline',label:'Hãng hàng không',levels:['airline','route']},
    {id:'country',label:'Thị trường',levels:weekly?['country','route']:['country','route','airline']},
    {id:'route',label:'Chặng bay',levels:['route','airline']},
    {id:'days',label:'Theo ngày',levels:['month','date']},
  ];
  const defaults = (tab:Tab):State => ({metric:tab.analysis?'flights':'both',direction:tab.id==='days'?'each':'all',period:'current',
    time:weekly || data.normalized_request.period_mode==='month'?'period':'month',search:'',filters:{},depth:0,
    open:new Set(),closed:new Set(),page:0,pageSize:20,levels:[...tab.levels],sort:tab.levels.some(f=>['airline','country','route'].includes(f))?'flights':'name'});
  const states=new Map(tabs.map(t=>[t.id,defaults(t)])); let active=tabs[0];
  const dayStates=new Map(ordinary.map(p=>[p.id,{...defaults(tabs.find(t=>t.id==='days')??tabs[0]),period:p.id}]));
  const root=document.getElementById('report')!;
  document.body.classList.remove('weekly-report','monthly-report'); document.body.classList.add('pivot-report');
  const header=el('header'); header.append(el('h1',bao?'Báo cáo sản lượng':weekly?'Báo cáo tuần':'Báo cáo khai thác'));
  header.append(el('p',`${range(current)} · ${data.normalized_request.time_basis==='utc'?'Giờ UTC':'Giờ địa phương'}`));
  const fixed=[['Hãng',data.normalized_request.airlines],['Thị trường',data.normalized_request.countries],['Chặng',data.normalized_request.routes]] as const;
  const scope=fixed.filter(([,v])=>v.length).map(([k,v])=>`${k}: ${v.join(', ')}`).join(' · ');
  if(scope)header.append(el('p',`Phạm vi đã xuất: ${scope}`));
  header.append(el('p','—: chưa có số liệu. *: số khách đã ghi nhận, còn thiếu; không dùng để so sánh. Ngày tương lai là lịch bay, không phải sản lượng đã thực hiện.','pivot-note'));
  if(completedOpsDate)header.append(el('p',`Mốc chốt dữ liệu hoàn tất: Ops Date ${date(completedOpsDate)} · Sau ngày này là lịch bay dự kiến.`,'pivot-note pivot-as-of-badge'));
  const nav=el('nav',undefined,'tabs controls');nav.setAttribute('aria-label','Các bảng theo mẫu');
  if(!bao)nav.append(button('Tóm tắt và phân tích',()=>{observers.forEach(o=>o.disconnect());window.onbeforeprint=null;window.onafterprint=null;helpers.summary();}));
  for(const tab of tabs){const b=button(tab.label,()=>{active=tab;render();});b.dataset.tab=tab.id;nav.append(b);}
  header.append(button('In báo cáo',()=>window.print()));header.lastElementChild!.classList.add('controls');
  const main=el('main');main.id='main';const content=el('div');
  main.append(content);root.replaceChildren(header,nav,main);
  let observers:ResizeObserver[]=[];
  let printColumns:Column[]=[],printWidth=1;
  function clearPrint(){content.querySelector('.pivot-print-pages')?.remove();content.classList.remove('print-ready');}
  function preparePrint(){
    clearPrint();if(bao||printColumns.length*printWidth<=8)return;
    const source=content.querySelector('table');if(!source)return;
    const pages=el('div',undefined,'pivot-print-pages'),perPage=Math.max(1,Math.floor(8/printWidth));
    const context=content.querySelector('.print-context');
    for(let start=0;start<printColumns.length;start+=perPage){
      const end=Math.min(start+perPage,printColumns.length),section=el('section');section.append(el('h2',active.label));
      if(context)section.append(context.cloneNode(true));
      const clone=source.cloneNode(true) as HTMLTableElement;
      for(const [index,row] of Array.from(clone.tHead!.rows).entries())for(const [i,c] of Array.from(row.cells).entries()){
        if(index===0?i!==0&&(i-1<start||i-1>=end):i<start*printWidth||i>=end*printWidth)c.remove();
      }
      for(const row of [...Array.from(clone.tBodies[0].rows),...Array.from(clone.tFoot!.rows)])
        for(const [i,c] of Array.from(row.cells).entries())if(i!==0&&(i-1<start*printWidth||i-1>=end*printWidth))c.remove();
      for(const b of clone.querySelectorAll('button'))b.replaceWith(document.createTextNode(b.textContent??''));
      section.append(clone);pages.append(section);
    }
    content.append(pages);content.classList.add('print-ready');
  }
  window.onbeforeprint=preparePrint;window.onafterprint=clearPrint;
  const allRows=(analysis=false):Row[]=>data.resources.filter(r=>r.dataset===(analysis?'market':'market_daily')
    && (data.periods.find(p=>p.id===r.period_id)!.role==='analysis-week')===analysis)
    .flatMap(r=>r.rows.map(row=>({...row,period:r.period_id,grain:{...row.grain,...(row.grain.date?{month:String(row.grain.date).slice(0,7)}:{})}})));
  const raw=allRows(),analysisRows=allRows(true);
  const filtered=(s:State)=> (active.analysis?analysisRows:raw).filter(r=>Object.entries(s.filters).every(([f,v])=>!v.size||v.has(JSON.stringify(r.grain[f]??null))));
  const keys=(s:State):Metric[]=>s.metric==='both'?(weekly?['reported_pax','flights']:['flights','reported_pax']):[s.metric as Metric];
  const dirs=(s:State):Direction[]=>s.direction==='each'?['A','D','all']:[s.direction as Direction];
  // Coverage comes from the full calendar, not only dates on which this group flew.
  const coverageCache=new Map<string,HtmlMetric['flight_coverage']>();
  function coverage(c:Column,d:Direction){
    const key=JSON.stringify([c.period,c.id,d]); if(coverageCache.has(key))return coverageCache.get(key)!;
    const rows=resources.get(`${c.period}/timeline`)!.rows.filter(r=>
      (c.dateSet ? c.dateSet.has(String(r.grain.date)) : (String(r.grain.date)>=c.from&&String(r.grain.date)<=c.to))
      &&(d==='all'||r.direction===d));
    const value=sum(rows).flight_coverage;coverageCache.set(key,value);return value;
  }
  const periodCol=(p:HtmlPeriod):Column=>({id:p.id,period:p.id,from:p.from,to:p.to,label:`${p.label} · ${range(p)}`});
  function measure(rows:Row[],c:Column,d:Direction):HtmlMetric {
    const matched=rows.filter(r=>r.period===c.period&&(d==='all'||r.direction===d)
      && (!r.grain.date || (c.dateSet ? c.dateSet.has(String(r.grain.date)) : (String(r.grain.date)>=c.from&&String(r.grain.date)<=c.to))));
    const covered=coverage(c,d);return {...sum(matched,covered),flight_coverage:covered};
  }
  function cell(tr:HTMLTableRowElement,m:HtmlMetric,key:Metric,c?:Column){
    let val:number|null=null,tip='';
    if(key==='flights_per_day'){
      const daysCount=c?(c.dateSet?c.dateSet.size:Math.max(1,Math.round((new Date(c.to+'T00:00:00Z').getTime()-new Date(c.from+'T00:00:00Z').getTime())/86400000)+1)):1;
      val=m.flights!==null?m.flights/daysCount:null;
      tip=val!==null?`TB ${fmt(val,true)} chuyến/ngày (${m.flights} chuyến / ${daysCount} ngày)`:'';
    }else if(key==='pax_per_flight'){
      if(m.pax_status==='complete' && m.flight_coverage==='complete'){
        val=(m.flights&&m.reported_pax!==null)?m.reported_pax/m.flights:null;
        tip=val!==null?`Bình quân ${fmt(val,true)} khách/chuyến (${m.reported_pax} khách / ${m.flights} chuyến)`:'';
      }else if(m.reported_pax!==null && m.reported_legs && m.flights){
        val=m.reported_pax/m.reported_legs;
        tip=`Bình quân ${fmt(val,true)} khách/chuyến trên ${m.reported_legs}/${m.flights} chuyến bay (${m.due_legs} chuyến đến hạn).`;
      }else{val=null;tip='Chưa đủ dữ liệu khách để tính bình quân.';}
    }else if(key==='flights'||key==='reported_pax'){
      val=m[key];
    }
    const td=el('td',fmt(val,key==='flights_per_day'||key==='pax_per_flight'),'number');td.dataset.metric=key;
    if(key==='reported_pax' && m.reported_pax!==null && (m.unreported_legs!==0 || m.flight_coverage!=='complete')){
      td.append(el('sup','*'));td.title=m.unreported_legs?`Số khách đã ghi nhận; còn ${m.unreported_legs} chuyến chưa có số liệu khách.`:'Số khách đã ghi nhận; chưa đủ dữ liệu toàn phạm vi.';
    }else if(key==='pax_per_flight' && val!==null && (m.pax_status!=='complete' || m.flight_coverage!=='complete')){
      td.append(el('sup','*'));td.title=tip;
    }else if(tip){td.title=tip;}
    else if(key==='reported_pax' && m.reported_pax!==null){td.title='Số liệu hành khách đầy đủ.';}
    if(key==='flights' && m.flight_coverage!=='complete')td.title='Phạm vi chưa đủ dữ liệu chuyến bay.';
    tr.append(td);return td;
  }
  function frame(parent:HTMLElement,title:string){
    const section=el('section');section.dataset.tableKey=title;
    const headerRow=el('div',undefined,'section-header');headerRow.append(el('h2',title));
    const table=el('table'),head=el('thead'),body=el('tbody'),foot=el('tfoot');table.append(head,body,foot);
    const actions=el('div',undefined,'table-actions controls');
    const cellText=(c:HTMLTableCellElement)=>c.dataset.exportText??c.textContent??'';
    const tableGrid=()=>{
      const grid:string[][]=[];
      for(let r=0;r<table.rows.length;r++){
        grid[r]=grid[r]??[];let colIdx=0;const row=table.rows[r];
        for(let c=0;c<row.cells.length;c++){
          while(grid[r][colIdx]!==undefined)colIdx++;
          const cell=row.cells[c];
          const text=sanitize(cellText(cell), cell.classList.contains('number'));
          const rs=cell.rowSpan||1,cs=cell.colSpan||1;
          for(let dr=0;dr<rs;dr++){
            grid[r+dr]=grid[r+dr]??[];
            for(let dc=0;dc<cs;dc++){
              grid[r+dr][colIdx+dc]=dr===0&&dc===0?text:'';
            }
          }
          colIdx+=cs;
        }
      }
      const maxCols=Math.max(0,...grid.map(row=>row.length));
      for(const row of grid){
        while(row.length<maxCols)row.push('');
        for(let i=0;i<row.length;i++)if(row[i]===undefined)row[i]='';
      }
      return grid;
    };
    const copyBtn=button('Sao chép',()=>{
      const tsv=tableGrid().map(r=>r.join('\t')).join('\n');
      navigator.clipboard?.writeText(tsv).then(()=>{const orig=copyBtn.textContent;copyBtn.textContent='✓ Đã sao chép';setTimeout(()=>{copyBtn.textContent=orig;},2000);});
    });copyBtn.classList.add('pivot-btn-action');
    const csvBtn=button('Xuất CSV',()=>{
      const csv=tableGrid().map(r=>r.map(t=>/[",\n\r]/.test(t)?`"${t.replace(/"/g,'""')}"`:t).join(',')).join('\r\n');
      const blob=new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8;'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);
      a.download=`${title.replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1EA0-\u1EF9-]/g,'_')}.csv`;
      a.click();URL.revokeObjectURL(a.href);
    });csvBtn.classList.add('pivot-btn-action');
    actions.append(copyBtn,csvBtn);headerRow.append(actions);section.append(headerRow);
    const scroll=el('div',undefined,'table-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',title);
    scroll.append(table);section.append(scroll);parent.append(section);
    const sync=()=>{let top=0;for(const row of Array.from(head.rows)){for(const th of Array.from(row.cells))th.style.top=`${top}px`;top+=row.getBoundingClientRect().height;}};
    const observer=new ResizeObserver(sync);observer.observe(head);observers.push(observer);
    return {section,table,head,body,foot};
  }
  function th(row:HTMLTableRowElement,text:string,span=1,rowspan=1,sticky=false){
    const cell=el('th',text,sticky?'name':undefined);cell.scope=span>1?'colgroup':'col';cell.colSpan=span;cell.rowSpan=rowspan;row.append(cell);return cell;
  }
  function columns(s:State):Column[]{
    if(s.time==='period')return ordinary.map(periodCol);
    if(s.time==='weekday'){
      const weekdayNames=['Thứ 2','Thứ 3','Thứ 4','Thứ 5','Thứ 6','Thứ 7','Chủ Nhật'];
      const result:Column[]=[];
      for(const p of ordinary){
        const dayBuckets:string[][]=Array.from({length:7},()=>[]);
        for(const day of data.calendar.filter(d=>d.period_id===p.id)){
          const w=(new Date(day.date+'T00:00:00Z').getUTCDay()+6)%7;
          dayBuckets[w].push(day.date);
        }
        for(let w=0;w<7;w++){
          const dates=dayBuckets[w]; if(!dates.length)continue;
          dates.sort(); const from=dates[0],to=dates.at(-1)!;
          result.push({id:`${p.id}/w${w}`,period:p.id,from,to,label:`${weekdayNames[w]}\n(${dates.length} ngày)`,dateSet:new Set(dates)});
        }
        if(data.calendar.filter(d=>d.period_id===p.id).length>0)result.push({...periodCol(p),id:`${p.id}/total`,label:`Grand Total\n${range(p)}`,total:true});
      }
      return result;
    }
    const result:Column[]=[];
    for(const p of ordinary){
      const buckets=new Map<string,string[]>();
      for(const day of data.calendar.filter(d=>d.period_id===p.id)){
        const k=s.time==='month'?day.month:s.time==='iso_week'?day.iso_week:day.business_week;
        const dates=buckets.get(k)??[];dates.push(day.date);buckets.set(k,dates);
      }
      for(const [k,dates] of buckets){dates.sort();const from=dates[0],to=dates.at(-1)!;
        const title=s.time==='month'?name('month',k):s.time==='iso_week'?'Tuần ISO':'Tuần T6–T5';
        result.push({id:`${p.id}/${k}`,period:p.id,from,to,label:`${title}\n${range({from,to})}`});
      }
      if(buckets.size>1)result.push({...periodCol(p),id:`${p.id}/total`,label:`Grand Total\n${range(p)}`,total:true});
    }
    return result;
  }
  function tree(rows:Row[],levels:string[],path:unknown[]=[]):Tree[]{
    if(!levels.length)return [];const groups=new Map<string,Row[]>();
    for(const r of rows){const key=JSON.stringify(r.grain[levels[0]]??null);const group=groups.get(key)??[];group.push(r);groups.set(key,group);}
    return [...groups].map(([key,group])=>{const value=JSON.parse(key),next=[...path,levels[0],value];
      return {id:JSON.stringify(next),label:name(levels[0],value),rows:group,children:tree(group,levels.slice(1),next)};});
  }
  function matches(node:Tree,q:string):boolean{return !q||node.label.toLocaleLowerCase('vi').includes(q)||node.children.some(n=>matches(n,q));}
  function sorted(nodes:Tree[],s:State,period=current):Tree[]{
    return [...nodes].sort((a,b)=>{
      if(s.sort!=='name'){
        const k=s.sort as BaseMetric,c=periodCol(active.id==='days'?ordinary.find(p=>p.id===s.period)!:period),ma=measure(a.rows,c,'all'),mb=measure(b.rows,c,'all');
        const av=k==='reported_pax'&&ma.unreported_legs!==0?null:ma[k],bv=k==='reported_pax'&&mb.unreported_legs!==0?null:mb[k];
        if(av!==bv)return av===null?1:bv===null?-1:bv-av;
      }
      const field=String((JSON.parse(a.id) as unknown[]).at(-2));
      return (field==='date'||field==='month')?a.id.localeCompare(b.id):a.label.localeCompare(b.label,'vi',{numeric:true});
    });
  }
  function pagination(section:HTMLElement,n:number,s:State){
    const limit=s.pageSize===0?Math.max(1,n):(s.pageSize||20);
    const max=Math.max(0,Math.ceil(n/limit)-1);s.page=Math.min(s.page,max);
    if(n<=20&&s.pageSize===20)return;
    const bar=el('div',undefined,'pagination controls'),prev=button('Trang trước',()=>{s.page--;renderContent();}),next=button('Trang sau',()=>{s.page++;renderContent();});
    prev.disabled=s.page===0;next.disabled=s.page===max;
    const sizeSelect=select('Số nhóm/trang',[['20','20 nhóm/trang'],['50','50 nhóm/trang'],['100','100 nhóm/trang'],['0','Tất cả']],String(s.pageSize),v=>{s.pageSize=Number(v);s.page=0;renderContent();});
    bar.append(prev,el('span',`Trang ${s.page+1}/${max+1} · ${s.pageSize===0?'Tất cả':`${s.pageSize} nhóm/trang`}`),next,sizeSelect);section.append(bar);
    const startIdx=n===0?0:(s.pageSize===0?1:s.page*s.pageSize+1),endIdx=s.pageSize===0?n:Math.min(n,(s.page+1)*s.pageSize);
    section.append(el('p',`Đang hiển thị nhóm ${startIdx}–${endIdx} trong ${n} nhóm. Grand Total vẫn gồm toàn bộ bộ lọc.`,'pivot-note'));
  }
  function highlight(parent:HTMLElement,text:string,q:string){
    if(!q){parent.append(document.createTextNode(text));return;}
    const lower=text.toLocaleLowerCase('vi'),qLower=q.toLocaleLowerCase('vi');let start=0;
    while(start<text.length){
      const idx=lower.indexOf(qLower,start);
      if(idx===-1){parent.append(document.createTextNode(text.slice(start)));break;}
      if(idx>start)parent.append(document.createTextNode(text.slice(start,idx)));
      const mark=el('mark',text.slice(idx,idx+q.length),'pivot-highlight');parent.append(mark);
      start=idx+q.length;
    }
  }
  function pivot(s:State,rows:Row[]){
    const title=active.id==='days'?`${active.label} · ${periodCol(ordinary.find(p=>p.id===s.period)!).label}`:active.label;
    const cols=active.id==='days'?[periodCol(ordinary.find(p=>p.id===s.period)!)]:columns(s),{section,head,body,foot}=frame(content,title);
    section.querySelector('.table-scroll')!.before(controls(s));
    printColumns=cols;printWidth=keys(s).length*dirs(s).length;
    const band=el('tr'),sub=el('tr');th(band,s.levels.map(f=>labels[f]).join(' → '),1,2,true);
    for(const c of cols){const h=th(band,c.label,keys(s).length*dirs(s).length);if(c.total)h.classList.add('period-total');
      for(const k of keys(s))for(const d of dirs(s)){const h=th(sub,`${metricLabels[k]} · ${dirLabels[d]}`);if(c.total)h.classList.add('period-total');}}
    head.append(band,sub);
    // The day view uses a calendar spine; selected filters can yield certified no-flight days.
    if(active.id==='days'){
      rows=[...rows.filter(r=>r.period===s.period),...data.calendar.filter(d=>d.period_id===s.period).map(d=>({
        ...sum([]),direction:'A' as const,period:d.period_id,grain:{month:d.month,date:d.date},
      }))];
    }
    const query=s.search.toLocaleLowerCase('vi'),nodes=sorted(tree(rows,s.levels),s).filter(n=>matches(n,query));
    const limit=s.pageSize===0?Math.max(1,nodes.length):(s.pageSize||20);
    s.page=Math.min(s.page,Math.max(0,Math.ceil(nodes.length/limit)-1));
    const values=(tr:HTMLTableRowElement,rs:Row[])=>{for(const c of cols)for(const k of keys(s))for(const d of dirs(s)){
      // Calendar placeholders are not source measurements.
      const intersects=active.id!=='days'||rs.some(r=>r.period===c.period&&String(r.grain.date)>=c.from&&String(r.grain.date)<=c.to);
      const m=intersects?measure(rs.filter(r=>r.flights!==null),c,d):sum([]);const td=cell(tr,m,k,c);if(c.total)td.classList.add('period-total');
    }};
    const append=(node:Tree,depth:number,ancestorMatch=false)=>{
      if(!ancestorMatch&&!matches(node,query))return;const tr=el('tr',undefined,depth===0?'pivot-group':'pivot-child');tr.dataset.node=node.id;
      if(completedOpsDate){
        const idParts=JSON.parse(node.id) as unknown[];
        const field=String(idParts.at(-2)),val=String(idParts.at(-1));
        if(field==='date'&&val>completedOpsDate){
          tr.classList.add('future-row');
          tr.title='Lịch bay dự kiến (chưa hoàn tất Ops Date)';
        }
      }
      const label=el('th',undefined,'name');label.scope='row';label.style.paddingInlineStart=`${10+depth*18}px`;
      label.dataset.exportText=node.label;
      const open=!!query||(!s.closed.has(node.id)&&(s.depth>depth||s.open.has(node.id)));
      const btnText=`${open?'−':'+'} ${node.label}`;
      if(node.children.length){const b=button(btnText,()=>{
        if(open){s.open.delete(node.id);s.closed.add(node.id);}else{s.open.add(node.id);s.closed.delete(node.id);}renderContent();
        Array.from(content.querySelectorAll<HTMLButtonElement>('button[data-group]')).find(n=>n.dataset.group===node.id)?.focus({preventScroll:true});
      });b.dataset.group=node.id;b.setAttribute('aria-expanded',String(open));
      if(query){b.textContent='';b.append(document.createTextNode(`${open?'−':'+'} `));highlight(b,node.label,query);}
      label.append(b);
      }else if(query){highlight(label,node.label,query);}else label.textContent=node.label;
      tr.append(label);values(tr,node.rows);body.append(tr);
      if(open)for(const child of sorted(node.children,s))append(child,depth+1,ancestorMatch||!!query&&node.label.toLocaleLowerCase('vi').includes(query));
    };
    nodes.slice(s.page*limit,s.pageSize===0?nodes.length:(s.page+1)*limit).forEach(n=>append(n,0));
    const total=el('tr',undefined,'grand-total');const totalLabel=el('th','Grand Total','name');totalLabel.dataset.exportText='Grand Total';total.append(totalLabel);values(total,rows);foot.append(total);
    if(!nodes.length)section.append(el('p','Không có nhóm phù hợp. Xóa tìm kiếm hoặc về bố cục mẫu.','notice'));
    pagination(section,nodes.length,s);
    section.append(el('p','Tổng tính toàn bộ bộ lọc; tìm kiếm, thu gọn và phân trang không thay đổi tổng.','pivot-note'));
  }
  function trafficHead(head:HTMLTableSectionElement,weeklyTable=false){
    const band=el('tr'),sub=el('tr');
    for(const title of weeklyTable?['From','To']:['Month','Ops Date','Day'])th(band,title,1,2);
    th(band,'Flight',2);th(band,weeklyTable?'Total Flt':'Total Flight',1,2);th(band,'Pax',2);th(band,'Total Pax',1,2);
    for(const label of ['ARR','DEP','ARR','DEP'])th(sub,label);head.append(band,sub);
  }
  function six(tr:HTMLTableRowElement,rows:Row[],c:Column){for(const k of ['flights','reported_pax'] as Metric[])for(const d of ['A','D','all'] as Direction[])cell(tr,measure(rows,c,d),k,c);}
  function daily(parent:HTMLElement,rows:Row[],month?:string){
    const {head,body,foot}=frame(parent,month?`${monthNames[Number(month.slice(5))-1]} ${month.slice(0,4)}`:'DAILY');trafficHead(head);
    const months=month?[month]:monthKeys;
    for(const m of months){const days=data.calendar.filter(d=>d.period_id==='current'&&d.month===m).map(d=>d.date).sort();
      for(const day of days){const tr=el('tr');tr.dataset.date=day;
        if(completedOpsDate && day>completedOpsDate){tr.classList.add('future-row');tr.title='Lịch bay dự kiến (chưa hoàn tất Ops Date)';}
        tr.append(el('td',m.slice(5)),el('td',date(day)),el('td',new Intl.DateTimeFormat('vi-VN',{weekday:'short',timeZone:'UTC'}).format(new Date(day))));
        six(tr,rows,{id:day,period:'current',from:day,to:day,label:day});body.append(tr);}
      const subtotal=el('tr',undefined,'month-total'),label=el('th',`${monthNames[Number(m.slice(5))-1]} Total`);label.colSpan=3;label.scope='row';subtotal.append(label);
      six(subtotal,rows,{id:m,period:'current',from:days[0],to:days.at(-1)!,label:m});body.append(subtotal);
    }
    const visible=data.calendar.filter(d=>d.period_id==='current'&&(!month||d.month===month)).map(d=>d.date).sort();
    const total=el('tr',undefined,'grand-total'),label=el('th','Grand Total');label.colSpan=3;total.append(label);
    six(total,rows,{...periodCol(current),from:visible[0],to:visible.at(-1)!});foot.append(total);
  }
  function weeklyTable(parent:HTMLElement,rows:Row[]){
    const {section,head,body,foot}=frame(parent,'WEEKLY');trafficHead(head,true);
    const buckets=new Map<string,string[]>();for(const d of data.calendar.filter(d=>d.period_id==='current')){const dates=buckets.get(d.business_week)??[];dates.push(d.date);buckets.set(d.business_week,dates);}
    for(const [week,dates] of buckets){dates.sort();const c={id:week,period:'current',from:dates[0],to:dates.at(-1)!,label:week};const tr=el('tr');tr.dataset.week=week;
      tr.append(el('td',date(c.from)),el('td',date(c.to)));six(tr,rows,c);body.append(tr);}
    const tr=el('tr',undefined,'grand-total'),label=el('th','Grand Total');label.colSpan=2;tr.append(label);six(tr,rows,periodCol(current));foot.append(tr);
    section.append(el('p','Tuần Thứ Sáu–Thứ Năm. Tuần biên chỉ cộng các ngày trong mùa đã chọn.','pivot-note'));
  }
  function monthChart(parent:HTMLElement,rows:Row[],month:string,key:BaseMetric){
    const figure=el('figure'),title=`${metricLabels[key]} · ${name('month',month)}`;figure.append(el('figcaption',title));
    const svg=(tag:string,attrs:Record<string,string>,text?:string)=>{const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;return n;};
    const days=data.calendar.filter(d=>d.period_id==='current'&&d.month===month).map(d=>d.date).sort();
    const values=days.map(day=>{const c={id:day,period:'current',from:day,to:day,label:day};return (['A','D','all'] as Direction[]).map(d=>{
      const m=measure(rows,c,d);return key==='reported_pax'&&(m.unreported_legs!==0||m.flight_coverage!=='complete')?null:m[key];
    });});
    if(!values.some(v=>v.some(x=>x!==null))){figure.append(el('p','Chưa đủ dữ liệu cho biểu đồ. Xem số đã ghi nhận trong bảng ngày.'));parent.append(figure);return;}
    const max=Math.max(1,...values.flatMap(v=>v.filter((x):x is number=>x!==null))),chart=svg('svg',{viewBox:'0 0 1080 280',role:'img','aria-label':`${title}; cột Đến/Đi, đường Tổng. Số liệu chi tiết ở bảng ngày.`});
    chart.append(svg('text',{x:'5',y:'22'},fmt(max)),svg('text',{x:'5',y:'242'},'0'));
    const width=980/days.length;let segment:string[]=[];
    const flush=()=>{if(segment.length>1)chart.append(svg('polyline',{points:segment.join(' '),stroke:'#0f172a','stroke-width':'2.5',fill:'none'}));segment=[];};
    values.forEach((v,i)=>{const x=75+i*width;for(let j=0;j<2;j++)if(v[j]!==null){const h=v[j]!/max*210,r=svg('rect',{x:String(x+(j-.9)*width*.32),y:String(240-h),width:String(width*.3),height:String(h),fill:j===0?'#2563eb':'#93c5fd',stroke:j===0?'#1e40af':'#475569'});r.append(svg('title',{},`${date(days[i])} ${j===0?'Đến':'Đi'}: ${fmt(v[j])}`));chart.append(r);}
      if(v[2]===null)flush();else {const y=240-v[2]!/max*210;segment.push(`${x},${y}`);const dot=svg('circle',{cx:String(x),cy:String(y),r:'3',fill:'#0f172a'});dot.append(svg('title',{},`${date(days[i])} Tổng: ${fmt(v[2])}`));chart.append(dot);}
      if(i%Math.max(1,Math.ceil(days.length/12))===0||i===days.length-1)chart.append(svg('text',{x:String(x),y:'267','text-anchor':'middle'},days[i].slice(8)));
    });flush();figure.append(chart,el('p','Cột đậm: ARR (Đến) · Cột nhạt: DEP (Đi) · Đường: Tổng. Ngày thiếu khách không nối đường.','pivot-note'));parent.append(figure);
  }
  const analysisKeys=(s:State):BaseMetric[]=>s.metric==='both'?['flights','reported_pax']:s.metric==='reported_pax'?['reported_pax']:['flights'];
  function analysis(s:State,rows:Row[]){
    const field=active.levels[0],groups=tree(rows,[field]),query=s.search.toLocaleLowerCase('vi');
    const matching=groups.filter(n=>matches(n,query));
    const limit=s.pageSize===0?Math.max(1,matching.length):(s.pageSize||20);
    s.page=Math.min(s.page,Math.max(0,Math.ceil(matching.length/limit)-1));
    for(let i=1;i<weeks.length;i++)for(const key of analysisKeys(s))for(const dir of dirs(s)){
      const a=periodCol(weeks[i]),b=periodCol(weeks[i-1]),{section,head,body,foot}=frame(content,`${weeks[i-1].label} → ${weeks[i].label} · ${metricLabels[key]} · ${dirLabels[dir]}`);
      const visible=sorted(matching,s,weeks[i]);
      const h=el('tr');for(const [j,title] of [field==='airline'?'Airline':'Country',b.label,a.label,'Difference','% Difference','CTG (%)'].entries())th(h,title,1,1,j===0);head.append(h);
      const baseTotal=measure(rows,b,dir),newTotal=measure(rows,a,dir),totalComparison=compare(newTotal,baseTotal,key);
      const append=(label:string,group:Row[],total=false)=>{
        const tr=el('tr',undefined,total?'grand-total':'analysis-group');const thCell=el('th',label,'name');thCell.dataset.exportText=label;tr.append(thCell);
        const old=measure(group,b,dir),now=measure(group,a,dir),delta=compare(now,old,key);
        cell(tr,old,key,b);cell(tr,now,key,a);tr.append(el('td',fmt(delta.delta),'number'),el('td',delta.percent===null?'—':`${fmt(delta.percent*100,true)}%`,'number'));
        const contribution=delta.delta===null||totalComparison.delta===null||baseTotal[key]===null||baseTotal[key]===0?null:delta.delta/baseTotal[key]!*100;
        const ctg=el('td',contribution===null?'—':`${fmt(contribution,true)}%`,'number');ctg.dataset.ctg='true';tr.append(ctg);(total?foot:body).append(tr);
      };
      visible.slice(s.page*limit,s.pageSize===0?matching.length:(s.page+1)*limit).forEach(g=>append(g.label,g.rows));append('Grand Total',rows,true);
      if(weeks[i].contains_future)section.append(el('p','Kỳ này có lịch bay tương lai; chưa phải sản lượng thực hiện cả tuần.','pivot-note'));
    }
    pagination(content,matching.length,s);
    content.append(el('p','Difference = kỳ sau − kỳ trước. % Difference = Difference / giá trị nhóm kỳ trước. CTG = Difference / Grand Total kỳ trước, theo bộ lọc đang chọn.','pivot-note'));
  }
  function renderContent(){
    const focused=document.activeElement as HTMLElement|null,focusLabel=focused?.getAttribute('aria-label');
    const focusKey=focused?.closest<HTMLElement>('[data-table-key]')?.dataset.tableKey??'root';
    const selection=focused instanceof HTMLInputElement&&focused.type==='search'?[focused.selectionStart,focused.selectionEnd]:null;
    const scopes=[content,...Array.from(content.querySelectorAll<HTMLElement>('[data-table-key]'))];
    const saved=new Map(scopes.map(scope=>[scope.dataset.tableKey??'root',{
      details:Array.from(scope.querySelectorAll('details')).map(d=>d.open),
      top:scope.querySelector('.table-scroll')?.scrollTop??0,left:scope.querySelector('.table-scroll')?.scrollLeft??0,
    }]));
    observers.forEach(o=>o.disconnect());observers=[];content.replaceChildren();
    const s=states.get(active.id)!,rows=filtered(s);
    content.classList.remove('print-ready');
    if(bao)content.append(controls(s));
    if(active.analysis)analysis(s,rows);
    else if(bao&&active.month){
      const grid=el('div',undefined,'bao-total bao-month');content.append(grid);daily(grid,rows,active.month);
      monthChart(grid,rows,active.month,s.metric==='reported_pax'?'reported_pax':'flights');
    } else if(bao){const grid=el('div',undefined,'bao-total');content.append(grid);daily(grid,rows);weeklyTable(grid,rows);}
    else if(active.id==='days')for(const p of ordinary){const local=dayStates.get(p.id)!;pivot(local,filtered(local));}
    else pivot(s,rows);
    for(const scope of [content,...Array.from(content.querySelectorAll<HTMLElement>('[data-table-key]'))]){
      const old=saved.get(scope.dataset.tableKey??'root');if(!old)continue;
      Array.from(scope.querySelectorAll('details')).forEach((d,i)=>{if(old.details[i]!==undefined)d.open=old.details[i];});
      const scroll=scope.querySelector('.table-scroll');if(scroll){scroll.scrollTop=old.top;scroll.scrollLeft=old.left;}
    }
    const focusScope=focusKey==='root'?content:Array.from(content.querySelectorAll<HTMLElement>('[data-table-key]')).find(n=>n.dataset.tableKey===focusKey);
    if(focusLabel&&focusScope){const next=Array.from(focusScope.querySelectorAll<HTMLElement>('[aria-label]')).find(n=>n.getAttribute('aria-label')===focusLabel);
      next?.focus({preventScroll:true});if(selection&&next instanceof HTMLInputElement)next.setSelectionRange(selection[0],selection[1]);}
  }
  function controls(s:State){
    const toolbar=el('div',undefined,'pivot-tools table-tools controls');toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label',`Công cụ bảng ${active.label}`);
    const metricOptions = active.analysis
      ? [['flights','Chuyến bay'],['reported_pax','Hành khách'],['both','Chuyến bay và Hành khách']]
      : [['both','Chuyến bay và Hành khách'],['flights','Chuyến bay'],['reported_pax','Hành khách'],['flights_per_day','TB Chuyến / Ngày'],['pax_per_flight','Khách / Chuyến']];
    if(!bao||active.analysis)toolbar.append(select('Chỉ tiêu',metricOptions,s.metric,v=>{s.metric=v;renderContent();}),
      select('Chiều',[['all','Tổng Đến + Đi'],['A','Đến'],['D','Đi'],['each','Đến / Đi / Tổng']],s.direction,v=>{s.direction=v;renderContent();}));
    else if(active.month)toolbar.append(select('Biểu đồ',[['flights','Chuyến bay'],['reported_pax','Hành khách']],s.metric==='reported_pax'?s.metric:'flights',v=>{s.metric=v;renderContent();}));
    const display=el('details',undefined,'pivot-display');display.append(el('summary','Hiển thị'));const displayBody=el('div',undefined,'pivot-display-body');display.append(displayBody);
    if(!bao && !active.analysis && active.id !== 'days'){
      displayBody.append(select('Mẫu Pivot nhanh',[
        ['custom','Tùy chọn tự do'],
        ['country_month','1-Click: Thị trường × Tháng'],
        ['airline_month','1-Click: Hãng bay × Tháng'],
        ['country_weekday','1-Click: Thị trường × Thứ trong tuần'],
        ['route_dir','1-Click: Chặng bay × Chiều Đến/Đi'],
      ],'custom',v=>{
        if(v==='country_month'){s.levels=['country','airline'];s.time='month';s.direction='all';}
        else if(v==='airline_month'){s.levels=['airline','route'];s.time='month';s.direction='all';}
        else if(v==='country_weekday'){s.levels=['country','route'];s.time='weekday';s.direction='all';}
        else if(v==='route_dir'){s.levels=['route','airline'];s.time='period';s.direction='each';}
        s.page=0;s.open.clear();s.closed.clear();renderContent();
      }));
      const alternatives=[active.levels,...[['country','route','airline'],['airline','route'],['route','airline'],['country','airline']]];
      const unique=[...new Map(alternatives.map(a=>[a.join(','),a])).values()];
      displayBody.append(select('Cấp nhóm',unique.map(a=>[a.join(','),a.map(f=>labels[f]).join(' → ')]),s.levels.join(','),v=>{s.levels=v.split(',');s.page=0;s.open.clear();s.closed.clear();renderContent();}));
      displayBody.append(select('Trục cột',[['month','Theo Tháng'],['period','Toàn kỳ'],['iso_week','Tuần ISO'],['weekday','Thứ trong tuần (T2–CN)']],s.time,v=>{s.time=v;renderContent();}));
    }
    const selectedCount=Object.values(s.filters).reduce((n,v)=>n+v.size,0);
    const filterPanel=el('details',undefined,'pivot-filters'),filterSummary=el('summary',selectedCount?`Bộ lọc (${selectedCount} lựa chọn)`:'Bộ lọc');filterPanel.append(filterSummary);
    const filterGrid=el('div',undefined,'pivot-filter-grid');filterPanel.append(filterGrid);
    const pool=active.analysis?analysisRows:raw;
    for(const field of ['airline','country','route']){
      const group=el('fieldset'),legend=el('legend',labels[field]);group.append(legend);
      const search=el('input');search.type='search';search.setAttribute('aria-label',`Tìm bộ lọc ${labels[field]}`);search.placeholder='Tìm lựa chọn';group.append(search);
      const values=[...new Set(pool.map(r=>JSON.stringify(r.grain[field]??null)))].sort((a,b)=>name(field,JSON.parse(a)).localeCompare(name(field,JSON.parse(b)),'vi'));
      const options=el('div',undefined,'pivot-filter-options');
      for(const value of values){const label=el('label'),input=el('input');input.type='checkbox';input.checked=s.filters[field]?.has(value)??false;
        const text=name(field,JSON.parse(value));input.setAttribute('aria-label',`${labels[field]}: ${text}`);
        input.onchange=()=>{const selected=s.filters[field]??new Set<string>();if(input.checked)selected.add(value);else selected.delete(value);s.filters[field]=selected;s.page=0;
          filterSummary.textContent=`Bộ lọc (${Object.values(s.filters).reduce((n,v)=>n+v.size,0)} lựa chọn)`;renderContent();};label.append(input,el('span',text));options.append(label);
      }
      search.oninput=()=>{for(const label of Array.from(options.children) as HTMLElement[])label.hidden=!label.textContent!.toLocaleLowerCase('vi').includes(search.value.toLocaleLowerCase('vi'));};
      group.append(options,el('p','Không chọn: tất cả','pivot-note'));filterGrid.append(group);
    }
    toolbar.append(filterPanel);
    const selectedEntries:Array<{field:string;value:string;label:string}>=[];
    for(const field of ['airline','country','route']){
      const vals=s.filters[field];
      if(vals&&vals.size)for(const v of vals)selectedEntries.push({field,value:v,label:`${labels[field]}: ${name(field,JSON.parse(v))}`});
    }
    if(selectedEntries.length>0){
      const chipsBar=el('div',undefined,'pivot-filter-chips');
      for(const entry of selectedEntries){
        const chip=el('span',entry.label,'pivot-chip'),delBtn=el('button','×');
        delBtn.type='button';delBtn.setAttribute('aria-label',`Bỏ lọc ${entry.label}`);
        delBtn.onclick=()=>{s.filters[entry.field]?.delete(entry.value);s.page=0;renderContent();};
        chip.append(delBtn);chipsBar.append(chip);
      }
      const clearBtn=el('button','Xóa tất cả lọc','pivot-clear-filters');clearBtn.type='button';
      clearBtn.onclick=()=>{for(const f in s.filters)s.filters[f]?.clear();s.page=0;renderContent();};
      chipsBar.append(clearBtn,el('span','(Không chọn bộ lọc = toàn bộ sân bay)','pivot-note'));
      toolbar.append(chipsBar);
    }
    if(!bao||active.analysis){const wrap=el('label','Tìm trong bảng'),input=el('input');input.type='search';input.value=s.search;input.setAttribute('aria-label','Tìm trong bảng');
      input.oninput=()=>{s.search=input.value;s.page=0;renderContent();};wrap.append(input);toolbar.append(wrap);
      if(!bao && active.id !== 'days')displayBody.append(select('Sắp xếp',[['name','Tên / thời gian'],['flights','Chuyến bay giảm dần'],['reported_pax','Hành khách giảm dần']],s.sort,v=>{s.sort=v;renderContent();}));
    }
    if(!bao)toolbar.append(button('Mở tất cả',()=>{s.depth=10;s.closed.clear();renderContent();}),button('Thu gọn',()=>{s.depth=0;s.open.clear();s.closed.clear();renderContent();}));
    if(displayBody.children.length>0)toolbar.append(display);
    toolbar.append(button('Về bố cục mẫu',()=>{if(active.id==='days')dayStates.set(s.period,{...defaults(active),period:s.period});else states.set(active.id,defaults(active));render();}));return toolbar;
  }
  function render(){
    for(const b of nav.querySelectorAll<HTMLButtonElement>('button[data-tab]'))b.setAttribute('aria-pressed',String(b.dataset.tab===active.id));
    renderContent();
  }
  render();
}
