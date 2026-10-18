import type { HtmlEnvelope, HtmlMetric, HtmlRow, HtmlPeriod, HtmlResource, Direction } from './trafficHtmlReportContract.ts';
import type { sumHtmlMetrics, compareHtmlMetrics } from './trafficHtmlReportContract.ts';

// Self-contained function: its JS source is embedded after transpilation. All dependencies
// are explicit parameters; no module imports, remote assets or storage in the saved file.
export function mountTrafficHtmlReport(data: HtmlEnvelope, helpers: {
  sum: typeof sumHtmlMetrics; compare: typeof compareHtmlMetrics;
  pivot?: (tab?: string, search?: string) => void;
  syncState?: { summaryTab?: string; lastTab?: string; lastSearch?: string; fromMode?: string };
}) {
  type Tab = { id:string; label:string; dataset:HtmlResource['dataset']; levels:string[]; filters:string[]; analysis?:boolean; frequency?:boolean; peaks?:boolean };
  type State = { metric:string; direction:string; pairs:string[]; filters:Record<string,string>; search:string; sort:string; order:string; expanded:Set<string>; collapsed:Set<string>; depth:number; page:number; time:string };
  type Row = HtmlRow & { period:string };
  type Tree = { id:string; label:string; rows:Row[]; children:Tree[] };
  const sum=helpers.sum, compare=helpers.compare;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{
    const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(cls) node.className=cls; return node;
  };
  const fmt=(value:number|null|undefined,decimal=false)=>value==null?'—':new Intl.NumberFormat('vi-VN',{maximumFractionDigits:decimal?2:0}).format(value);
  const date=(value:string)=>`${value.slice(8,10)}/${value.slice(5,7)}/${value.slice(0,4)}`;
  const range=(p:HtmlPeriod)=>`${date(p.from)} – ${date(p.to)} (${p.calendar_days} ngày)`;
  const titles:Record<string,string>={WEEKLY_DETAIL:'Báo cáo tuần chi tiết',MASTER_OPERATIONS:'Báo cáo tổng hợp khai thác',MONTHLY_OVERVIEW_L2:'Tổng quan khai thác tháng',PERIOD_ANALYSIS:'Phân tích theo kỳ',BAO_CAO_SAN_LUONG:'Báo cáo sản lượng'};
  const fields:Record<string,string>={airline:'Hãng hàng không',country:'Quốc gia',route:'Chặng bay',group_id:'Nhóm tàu bay',type:'Loại tàu bay',hour:'Giờ khai thác',month:'Tháng',business_week:'Tuần Thứ Sáu–Thứ Năm',iso_week:'Tuần ISO',date:'Ngày',flight_number:'Số hiệu'};
  const directionNames:Record<string,string>={A:'Đến',D:'Đi',all:'Tổng'};
  const metricNames={flights:'Chuyến bay',reported_pax:'Hành khách'};
  const report=data.normalized_request.report_type, bao=report==='BAO_CAO_SAN_LUONG', weekly=report==='WEEKLY_DETAIL';
  const tabs:Tab[]=bao ? [
    {id:'total',label:'Tổng hợp',dataset:'timeline',levels:['month','date'],filters:['month']},
    {id:'weeks',label:'Theo tuần',dataset:'timeline',levels:['business_week','date'],filters:['business_week']},
    {id:'months',label:'Theo tháng',dataset:'timeline',levels:['month','date'],filters:['month']},
    {id:'analysis-airline',label:'Phân tích Airline',dataset:'market',levels:['airline'],filters:['airline'],analysis:true},
    {id:'analysis-country',label:'Phân tích Country',dataset:'market',levels:['country'],filters:['country'],analysis:true},
  ] : [
    {id:'overview',label:'Tổng quan',dataset:'kpi',levels:[],filters:[]},
    {id:'time',label:weekly?'Theo ngày':'Theo thời gian',dataset:'timeline',levels:weekly?['date']:['month','date'],filters:weekly?[]:['month']},
    {id:'airline',label:'Hãng hàng không',dataset:'market',levels:['airline','route'],filters:['airline','route']},
    {id:'market',label:'Thị trường',dataset:'market',levels:['country','route','airline'],filters:['country','route','airline']},
    {id:'route',label:'Chặng bay',dataset:'market',levels:['route','airline'],filters:['route','airline']},
    {id:'aircraft',label:'Tàu bay',dataset:'aircraft',levels:['group_id','type'],filters:['group_id','type']},
    ...(!weekly ? [
      {id:'hours',label:'Giờ khai thác',dataset:'hours' as const,levels:['hour'],filters:['hour']},
      {id:'frequency',label:'Tần suất',dataset:'frequency' as const,levels:['airline','route','flight_number'],filters:['airline','route'],frequency:true},
      ...(report==='MONTHLY_OVERVIEW_L2' ? [{id:'peak-days',label:'Ngày cao điểm',dataset:'timeline' as const,levels:['date'],filters:[],peaks:true},
        {id:'peak-hours',label:'Giờ cao điểm',dataset:'hours' as const,levels:['hour'],filters:[],peaks:true}] : []),
    ] : []),
  ];
  const calendar=new Map(data.calendar.map(d=>[`${d.period_id}/${d.date}`,d]));
  const resources=new Map(data.resources.map(r=>[`${r.period_id}/${r.dataset}`,r]));
  const periods=new Map(data.periods.map(p=>[p.id,p]));
  const ordinary=data.periods.filter(p=>p.role!=='analysis-week');
  const pairOptions=(tab:Tab)=>data.comparison_pairs.filter(pair=>(periods.get(pair.minuend_period)!.role==='analysis-week')===!!tab.analysis);
  const defaults=(tab:Tab):State=>({metric:'both',direction:'all',pairs:pairOptions(tab).slice(0,1).map(p=>p.id),filters:{},search:'',sort:['timeline','hours','frequency','kpi'].includes(tab.dataset)?'name':'flights',order:['timeline','hours','frequency','kpi'].includes(tab.dataset)?'asc':'desc',expanded:new Set(),collapsed:new Set(),depth:0,page:0,time:'month'});
  const states=new Map(tabs.map(t=>[t.id,defaults(t)])); let active=tabs[0];
  const syncMap: Record<string, string> = {
    country: 'market', days: weekly ? 'time' : 'time', airline: 'airline', route: 'route',
    aircraft: 'aircraft', frequency: 'frequency', hours: 'hours', total: 'total',
    'analysis-airline': 'analysis-airline', 'analysis-country': 'analysis-country'
  };
  const srcTab = helpers.syncState?.summaryTab || helpers.syncState?.lastTab;
  const targetTabId = syncMap[srcTab ?? ''] ?? srcTab;
  if(targetTabId) {
    const matched = tabs.find(t => t.id === targetTabId);
    if(matched) active = matched;
  }
  if(helpers.syncState?.lastSearch) {
    const curState = states.get(active.id);
    if(curState) curState.search = helpers.syncState.lastSearch;
  }
  const root=document.getElementById('report')!;
  const header=el('header'); header.append(el('h1',titles[report]));
  header.append(el('p',`${range(periods.get('current')!)} · ${data.normalized_request.time_basis==='utc'?'Giờ UTC':'Giờ địa phương'}`));
  const fixedFilters=[['Hãng',data.normalized_request.airlines],['Chặng',data.normalized_request.routes],['Quốc gia',data.normalized_request.countries]] as const;
  const fixedText=fixedFilters.filter(([,values])=>values.length).map(([label,values])=>`${label}: ${values.join(', ')}`).join(' · ');
  if(fixedText) header.append(el('p',`Phạm vi đã xuất: ${fixedText}`));
  header.append(el('p','Hành khách là số đã ghi nhận. Dấu — nghĩa là chưa có số liệu; kỳ lịch bay tương lai không phải sản lượng đã thực hiện.','notice'));
  const nav=el('nav',undefined,'tabs controls'); nav.setAttribute('aria-label','Các bảng báo cáo');
  const main=el('main'); main.id='main';
  root.replaceChildren(header,nav,main);
  const showClue=()=>{
    if(helpers.syncState?.fromMode === 'pivot') {
      const clueBanner = el('aside', undefined, 'summary-clue-banner controls');
      clueBanner.setAttribute('role', 'status');clueBanner.setAttribute('aria-live', 'polite');
      const icon = el('span', '📊', 'clue-icon');
      const msg = el('span', undefined, 'clue-text');
      msg.innerHTML = `Chế độ <strong>Báo cáo tổng quan chuẩn</strong>: Đang xem góc nhìn <strong>[${active.label}]</strong>.`;
      const closeBtn = el('button', '✕', 'clue-close');closeBtn.type = 'button';closeBtn.title = 'Đóng thông báo';
      closeBtn.onclick = () => { if(helpers.syncState) helpers.syncState.fromMode = ''; clueBanner.remove(); };
      clueBanner.append(icon, msg, closeBtn);
      main.prepend(clueBanner);
    }
  };
  const button=(text:string,fn:()=>void)=>{const b=el('button',text);b.type='button';b.addEventListener('click',fn);return b;};
  for(const tab of tabs) {const b=button(tab.label,()=>{active=tab;render();});b.dataset.tab=tab.id;nav.append(b);}
  const select=(label:string,options:Array<[string,string]>,value:string,change:(v:string)=>void)=>{
    const wrap=el('label',label);const input=el('select');input.setAttribute('aria-label',label);
    for(const [key,text] of options){const opt=el('option',text);opt.value=key;input.append(opt);} input.value=value;
    input.addEventListener('change',()=>change(input.value));wrap.append(input);return wrap;
  };
  const labelOf=(field:string,value:unknown,row?:Row)=>{
    if(value===null || value==='')return 'Chưa xác định';
    if(field==='group_id')return String(row?.grain.group ?? value);
    if(field==='month')return `Tháng ${String(value).slice(5,7)}/${String(value).slice(0,4)}`;
    if(field==='date')return date(String(value));
    if(field==='iso_week'||field==='business_week')return `Từ ${date(String(value))}`;
    if(field==='hour')return `${String(value).padStart(2,'0')}:00`;
    return String(value);
  };
  const rawRows=(tab:Tab):Row[]=>data.resources.filter(r=>r.dataset===tab.dataset && (periods.get(r.period_id)!.role==='analysis-week')===!!tab.analysis)
    .flatMap(r=>r.rows.map(row=>({...row,period:r.period_id,grain:{...row.grain,...(row.grain.date ? calendar.get(`${r.period_id}/${row.grain.date}`) : {})}})));
  const values=(tab:Tab,s:State)=>rawRows(tab).filter(row=>Object.entries(s.filters).every(([f,v])=>!v||JSON.stringify(row.grain[f])===v));
  const coverage=(period:string,tab:Tab,direction:Direction)=>resources.get(`${period}/${tab.dataset}`)!.totals.find(t=>t.direction===direction)?.flight_coverage ?? 'missing';
  const measure=(rows:Row[],period:string,direction:Direction,tab:Tab):HtmlMetric=>sum(rows.filter(r=>r.period===period && (tab.dataset==='kpi'?r.direction===direction:direction==='all'||r.direction===direction)),coverage(period,tab,direction));
  const dims=(s:State):Direction[]=>s.direction==='each'?['A','D','all']:[s.direction as Direction];
  const metrics=(s:State):Array<'flights'|'reported_pax'>=>s.metric==='both'?['flights','reported_pax']:[s.metric as 'flights'|'reported_pax'];
  function tree(rows:Row[],levels:string[],path:unknown[]=[]):Tree[] {
    if(!levels.length)return [];
    const groups=new Map<string,Row[]>();
    for(const row of rows){const k=JSON.stringify(row.grain[levels[0]]);const group=groups.get(k)??[];group.push(row);groups.set(k,group);}
    return [...groups.entries()].map(([key,group])=>{const next=[...path,levels[0],JSON.parse(key)];let label=labelOf(levels[0],JSON.parse(key),group[0]);
      if(['month','iso_week','business_week'].includes(levels[0])){const dates=[...new Set(group.map(r=>String(r.grain.date)))].sort();label+=` (${date(dates[0])} – ${date(dates.at(-1)!)})`;}
      return {id:JSON.stringify(next),label,rows:group,children:tree(group,levels.slice(1),next)};});
  }
  function visibleSearch(node:Tree,query:string):boolean {return !query||node.label.toLocaleLowerCase('vi').includes(query)||node.children.some(c=>visibleSearch(c,query));}
  function sortNodes(nodes:Tree[],s:State,period:string,tab:Tab):Tree[] {
    return [...nodes].sort((a,b)=>{
      let n=0;
      if(s.sort==='name') {const path=JSON.parse(a.id) as unknown[];
        n=['month','date','iso_week','business_week','hour'].includes(String(path.at(-2)))
          ?String(path.at(-1)??'~').localeCompare(String((JSON.parse(b.id) as unknown[]).at(-1)??'~'),'en',{numeric:true})
          :a.label.localeCompare(b.label,'vi',{numeric:true});}
      else {const direction=s.sort==='flights'||s.direction==='each'?'all':s.direction as Direction;
        const x=measure(a.rows,period,direction,tab)[s.sort as 'flights'|'reported_pax'];const y=measure(b.rows,period,direction,tab)[s.sort as 'flights'|'reported_pax'];
        if(x===null||y===null)return x===y?a.label.localeCompare(b.label,'vi'):x===null?1:-1;
        n=x-y;
      }
      return (s.order==='desc'?-n:n)||a.label.localeCompare(b.label,'vi',{numeric:true})||a.id.localeCompare(b.id);
    });
  }
  const numberCell=(row:HTMLTableRowElement,value:number|null,decimal=false)=>row.append(el('td',fmt(value,decimal),'number'));
  const tableFrame=(section:HTMLElement,headers:string[])=>{
    const scroll=el('div',undefined,'table-scroll');scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',section.querySelector('h2,h3')?.textContent??'Bảng số liệu');
    const table=el('table');const head=el('thead');const tr=el('tr');
    headers.forEach((text,i)=>{const th=el('th',text);th.scope='col';if(i===0)th.className='name';tr.append(th);});head.append(tr);
    const body=el('tbody');table.append(head,body);scroll.append(table);section.append(scroll);return body;
  };
  function valueCells(tr:HTMLTableRowElement,rows:Row[],s:State,tab:Tab,period:string,baseline:string|null,denominator:Row[],metric?:'flights'|'reported_pax',direction?:Direction) {
    for(const d of direction?[direction]:dims(s)) for(const key of metric?[metric]:metrics(s)) {
      const a=measure(rows,period,d,tab); numberCell(tr,a[key]);
      if(baseline){const b=measure(rows,baseline,d,tab),delta=compare(a,b,key);numberCell(tr,b[key]);numberCell(tr,delta.delta);tr.append(el('td',delta.percent===null?'—':`${fmt(delta.percent*100,true)}%`,'number'));}
      else {const total=measure(denominator,period,d,tab)[key];tr.append(el('td',a[key]===null||total===null||total===0?'—':`${fmt(a[key]!/total*100,true)}%`,'number'));
        if(tab.dataset==='timeline'||tab.dataset==='hours'){const days=tab.dataset==='timeline'?new Set(rows.filter(r=>r.period===period).map(r=>r.grain.date)).size:periods.get(period)!.calendar_days;numberCell(tr,a[key]===null||days===0?null:a[key]!/days,true);}}
    }
  }
  const tableFolding=new Map<string,{depth:number;expanded:Set<string>;collapsed:Set<string>}>();
  function folding(key:string){let state=tableFolding.get(key);if(!state){state={depth:0,expanded:new Set(),collapsed:new Set()};tableFolding.set(key,state);}return state;}
  function resetTab(){states.set(active.id,defaults(active));for(const key of tableFolding.keys())if(JSON.parse(key)[0]===active.id)tableFolding.delete(key);render();}
  function foldTools(section:HTMLElement,state:{depth:number;expanded:Set<string>;collapsed:Set<string>}){
    section.classList.add('report-table-section');const tools=el('div',undefined,'table-tools controls');tools.setAttribute('role','group');tools.setAttribute('aria-label','Công cụ bảng');
    tools.append(button('Mở toàn bộ',()=>{state.depth=99;state.collapsed.clear();render();}),button('Thu gọn',()=>{state.depth=0;state.expanded.clear();state.collapsed.clear();render();}));section.append(tools);
    const key=[...tableFolding].find(([,value])=>value===state)?.[0];tools.querySelectorAll('button').forEach((b,i)=>b.dataset.fold=JSON.stringify([key,i]));
  }
  function renderTree(section:HTMLElement,rows:Row[],tab:Tab,s:State,period:string,baseline:string|null,key?:'flights'|'reported_pax',direction?:Direction) {
    const local=folding(JSON.stringify([tab.id,period,baseline,key,direction]));s={...s,...local};
    if(tab.levels.length>1)foldTools(section,local);
    const levels=tab.id==='time'&&!weekly&&s.time!=='month'?[s.time,'date']:tab.levels;
    const nodes=sortNodes(tree(rows,levels),s,period,tab).filter(n=>visibleSearch(n,s.search.toLocaleLowerCase('vi')));
    const columns=['Chỉ tiêu'];
    for(const d of direction?[direction]:dims(s))for(const m of key?[key]:metrics(s)) columns.push(...(baseline
      ?[`${metricNames[m]} ${directionNames[d]} · ${periods.get(period)!.label}`,`${metricNames[m]} ${directionNames[d]} · ${periods.get(baseline)!.label}`,'Chênh lệch','% thay đổi']
      :[`${metricNames[m]} ${directionNames[d]}`,'Tỷ trọng',...(tab.dataset==='timeline'||tab.dataset==='hours'?['TB/ngày']:[])]));
    const body=tableFrame(section,columns),grand=el('tr',undefined,'grand-total');grand.append(el('th','Tổng phạm vi đang lọc','name'));valueCells(grand,rows,s,tab,period,baseline,rows,key,direction);body.append(grand);
    const pageSize=20,maxPage=Math.max(0,Math.ceil(nodes.length/pageSize)-1),page=Math.min(s.page,maxPage);
    const search=s.search.toLocaleLowerCase('vi');
    const append=(node:Tree,depth:number,ancestorMatch=false)=>{
      const selfMatch=!!search&&node.label.toLocaleLowerCase('vi').includes(search);
      if(!ancestorMatch&&!visibleSearch(node,search))return;
      const tr=el('tr'); const th=el('th',undefined,'name');th.scope='row';th.style.paddingInlineStart=`${12+depth*20}px`;
      const open=!!search || (!s.collapsed.has(node.id)&&(s.depth>depth || s.expanded.has(node.id)));
      if(node.children.length){const b=button(`${open?'−':'+'} ${node.label}`,()=>{if(open){s.expanded.delete(node.id);s.collapsed.add(node.id);}else{s.expanded.add(node.id);s.collapsed.delete(node.id);}render();});b.setAttribute('aria-expanded',String(open));b.dataset.group=JSON.stringify([period,baseline,key,direction,node.id]);th.append(b);}else th.textContent=node.label;
      tr.append(th);valueCells(tr,node.rows,s,tab,period,baseline,rows,key,direction);body.append(tr);
      if(open)for(const child of sortNodes(node.children,s,period,tab))append(child,depth+1,ancestorMatch||selfMatch);
    };
    nodes.slice(page*pageSize,(page+1)*pageSize).forEach(n=>append(n,0));
    if(!nodes.length)section.append(el('p','Không có dòng phù hợp. Đặt lại bộ lọc hoặc xóa tìm kiếm.','notice'));
    if(nodes.length>pageSize){const pagination=el('div',undefined,'pagination controls');const previous=button('Trang trước',()=>{states.get(tab.id)!.page=page-1;render();});previous.disabled=page===0;
      const next=button('Trang sau',()=>{states.get(tab.id)!.page=page+1;render();});next.disabled=page===maxPage;pagination.append(previous,el('span',`Trang ${page+1}/${maxPage+1} · 20 nhóm/trang`),next);section.append(el('p',`Đang hiển thị nhóm ${page*pageSize+1}–${Math.min(nodes.length,(page+1)*pageSize)} trong ${nodes.length} nhóm. Tổng vẫn tính toàn bộ phạm vi lọc.`),pagination);}
  }
  function svgNode(tag:string,attrs:Record<string,string>,text?:string){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;return n;}
  function chart(section:HTMLElement,rows:Row[],tab:Tab,s:State,period:string) {
    if(!tab.levels.length||tab.frequency||tab.analysis)return;
    const panel=el('div',undefined,'charts');
    for(const dir of dims(s)) for(const key of metrics(s)) {
      const levels=tab.id==='time'&&!weekly&&s.time!=='month'?[s.time,'date']:tab.levels;
      const nodes=tree(rows.filter(r=>r.period===period),levels);
      const points=nodes.map(n=>({label:n.label,order:String((JSON.parse(n.id) as unknown[]).at(-1)??'~'),value:measure(n.rows,period,dir,tab)[key]}));
      const known=points.filter((p):p is {label:string;order:string;value:number}=>p.value!==null);
      const figure=el('figure');figure.append(el('figcaption',`${metricNames[key]} · ${directionNames[dir]} · ${periods.get(period)!.label}`));
      if(!known.length){figure.append(el('p','Chưa có số liệu cho biểu đồ.'));panel.append(figure);continue;}
      const isTime=tab.dataset==='timeline'||tab.dataset==='hours';
      if(isTime){
        points.sort((a,b)=>a.order.localeCompare(b.order,'en',{numeric:true}));
        const max=Math.max(1,...known.map(p=>p.value));const svg=svgNode('svg',{viewBox:'0 0 720 260',role:'img','aria-label':`${metricNames[key]} theo ${tab.dataset==='hours'?'giờ':'thời gian'}; số liệu chi tiết ở bảng bên dưới`});
        svg.append(svgNode('text',{x:'8',y:'20'},fmt(max)),svgNode('text',{x:'8',y:'226'},'0'));
        let segment:string[]=[];const flush=()=>{if(segment.length>1)svg.append(svgNode('polyline',{points:segment.join(' '),fill:'none',stroke:'#1e40af','stroke-width':'3'}));segment=[];};
        points.forEach((p,i)=>{const x=60+(points.length===1?310:i*620/(points.length-1));if(p.value===null){flush();return;}
          const y=220-p.value/max*185;segment.push(`${x},${y}`);const dot=svgNode('circle',{cx:String(x),cy:String(y),r:'4',fill:'#1e40af'});dot.append(svgNode('title',{},`${p.label}: ${fmt(p.value)}`));svg.append(dot);
          if(i===0||i===points.length-1||i%Math.max(1,Math.ceil(points.length/5))===0){const tick=p.order==='~'?'Chưa rõ':tab.dataset==='hours'?`${p.order}h`:p.order.length===7?`${p.order.slice(5)}/${p.order.slice(0,4)}`:date(p.order);
            svg.append(svgNode('text',{x:String(x),y:'246','text-anchor':i===0?'start':i===points.length-1?'end':'middle'},tick));}});flush();figure.append(svg);
      }else{
        known.sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label,'vi'));const top=known.slice(0,10),other=known.slice(10).reduce((a,p)=>a+p.value,0);
        if(known.length>10)top.push({label:'Khác',order:'~',value:other});const total=known.reduce((a,p)=>a+p.value,0);
        if(total===0)figure.append(el('p','Sản lượng bằng 0; không có cơ sở tính tỷ trọng.'));
        else {const svg=svgNode('svg',{viewBox:'0 0 240 240',role:'img','aria-label':`Tỷ trọng ${metricNames[key].toLowerCase()}: Top 10 và Khác`});
          const colors=['#1e3a8a','#2563eb','#075985','#0369a1','#0e7490','#115e59','#047857','#3f6212','#854d0e','#9a3412','#64748b'];let offset=0;
          top.forEach((p,i)=>{const amount=p.value/total*100;const c=svgNode('circle',{cx:'120',cy:'120',r:'85',fill:'none',stroke:colors[i],'stroke-width':'36',pathLength:'100','stroke-dasharray':`${amount} ${100-amount}`,'stroke-dashoffset':String(-offset),transform:'rotate(-90 120 120)'});c.append(svgNode('title',{},`${p.label}: ${fmt(p.value)} (${fmt(amount,true)}%)`));svg.append(c);offset+=amount;});
          svg.append(svgNode('text',{x:'120',y:'125','text-anchor':'middle'},fmt(total)));figure.append(svg);
          const legend=el('ol');top.forEach(p=>legend.append(el('li',`${p.label}: ${fmt(p.value)} (${fmt(p.value/total*100,true)}%)`)));figure.append(legend);}
      }
      panel.append(figure);
    }
    section.append(panel);
  }
  function render() {
    const s=states.get(active.id)!;const focused=document.activeElement as HTMLElement|null;const savedFocus=focused?.dataset.group;
    const savedLabel=main.contains(focused)?focused?.getAttribute('aria-label'):null;
    const savedFold=focused?.dataset.fold;const restoreFold=()=>{if(savedFold)[...main.querySelectorAll<HTMLButtonElement>('button[data-fold]')].find(b=>b.dataset.fold===savedFold)?.focus({preventScroll:true});};
    nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===active.id)));
    if(weekly){renderWeekly(s);if(savedFocus){[...main.querySelectorAll<HTMLButtonElement>('button[data-group]')].find(b=>b.dataset.group===savedFocus)?.focus();}
      else if(savedLabel){[...main.querySelectorAll<HTMLElement>('[aria-label]')].find(n=>n.getAttribute('aria-label')===savedLabel)?.focus();}restoreFold();return;}
    const controls=el('div',undefined,'toolbar controls');
    if(!active.frequency){controls.append(select('Chỉ tiêu',[['both','Cả hai'],['flights','Chuyến bay'],['reported_pax','Hành khách']],s.metric,v=>{s.metric=v;render();}));
      controls.append(select('Chiều',[['all','Tổng'],['A','Đến'],['D','Đi'],['each','Hiện cả ba']],s.direction,v=>{s.direction=v;render();}));}
    else controls.append(select('Chiều',[['all','Tổng (Đến + Đi)'],['A','Đến'],['D','Đi']],s.direction,v=>{s.direction=v;render();}));
    const filterFields=active.filters.filter(f=>!['date','month','business_week','iso_week'].includes(f));
    const original=rawRows(active);
    for(const field of filterFields){const options=[...new Map(original.map(r=>[JSON.stringify(r.grain[field]),labelOf(field,r.grain[field],r)])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'vi',{numeric:true}));
      controls.append(select(fields[field],[['','Tất cả'],...options],s.filters[field]??'',v=>{s.filters[field]=v;s.page=0;render();}));}
    if(active.levels.length){const wrap=el('label','Tìm tên (không đổi tổng)');const input=el('input');input.type='search';input.value=s.search;input.setAttribute('aria-label','Tìm tên (không đổi tổng)');
      input.addEventListener('input',()=>{const start=input.selectionStart;s.search=input.value;s.page=0;render();const next=main.querySelector<HTMLInputElement>('input[type=search]')!;next.focus();next.setSelectionRange(start,start);});wrap.append(input);controls.append(wrap);
      if(!active.frequency)controls.append(select('Sắp xếp',[['name','Tên'],['flights','Chuyến bay'],['reported_pax','Hành khách']],s.sort,v=>{s.sort=v;s.order=v==='name'?'asc':'desc';render();}));
      controls.append(select('Thứ tự',[['asc','Tăng dần'],['desc','Giảm dần']],s.order,v=>{s.order=v;render();}));
    }
    controls.append(button('Đặt lại',resetTab),button('In bảng đang xem',()=>window.print()));
    const options=pairOptions(active);
    const context=el('p',`${active.label} · ${active.frequency?'Tần suất':s.metric==='both'?'Chuyến bay và Hành khách':metricNames[s.metric as keyof typeof metricNames]} · ${s.direction==='each'?'Đến / Đi / Tổng':directionNames[s.direction]} · ${Object.entries(s.filters).filter(([,v])=>v).map(([f,v])=>`${fields[f]}: ${labelOf(f,JSON.parse(v))}`).join(' · ')||'Không lọc thêm'}`,'print-context');
    main.replaceChildren(el('h2',active.label),controls,context);showClue();
    if(s.search)main.append(el('p',`Kết quả tìm “${s.search}”; tổng vẫn tính trên toàn bộ phạm vi lọc.`, 'notice'));
    const rows=values(active,s);
    const selected=options;
    const blocks=active.analysis?selected:(active.dataset==='kpi'||active.dataset==='timeline'||active.frequency||active.peaks?[]:selected);
    if(active.dataset==='kpi'){
      const body=tableFrame(main,['Kỳ','Phạm vi',...dims(s).flatMap(d=>metrics(s).map(m=>`${metricNames[m]} ${directionNames[d]}`)),'TB chuyến/ngày']);
      for(const p of ordinary){const tr=el('tr');tr.append(el('th',`${p.label}${p.contains_future?' (có lịch bay tương lai)':''}`,'name'),el('td',range(p)));
        for(const d of dims(s))for(const m of metrics(s))numberCell(tr,measure(rows,p.id,d,active)[m]);numberCell(tr,measure(rows,p.id,s.direction==='each'?'all':s.direction as Direction,active).flights===null?null:measure(rows,p.id,s.direction==='each'?'all':s.direction as Direction,active).flights!/p.calendar_days,true);body.append(tr);}
      for(const pair of selected)for(const direction of dims(s))for(const key of metrics(s)){
        const section=el('section');section.append(el('h3',`${metricNames[key]} ${directionNames[direction]} · ${periods.get(pair.minuend_period)!.label} − ${periods.get(pair.baseline_period)!.label}`));
        const b=tableFrame(section,['Chỉ tiêu','Kỳ tính chênh lệch','Kỳ đối chiếu','Chênh lệch','% thay đổi']);const tr=el('tr');tr.append(el('th','Tổng sản lượng','name'));valueCells(tr,rows,s,active,pair.minuend_period,pair.baseline_period,rows,key,direction);b.append(tr);main.append(section);
      }
    }else if(active.frequency){
      for(const p of ordinary){const section=el('section');section.append(el('h3',`${p.label} · ${range(p)}`),el('p','Lịch định kỳ đạt ít nhất 4 ngày, 4 tuần và mức ổn định 70%. Ngày hoạt động và tỷ lệ không cộng dồn giữa các số hiệu.'));
        const actions=el('div',undefined,'table-tools controls');actions.append(button('Mở toàn bộ',()=>{section.querySelectorAll('details').forEach(d=>{d.open=true;});}),button('Thu gọn',()=>{section.querySelectorAll('details').forEach(d=>{d.open=false;});}));section.append(actions);
        const filtered=rows.filter(r=>r.period===p.id && (s.direction==='all'||r.direction===s.direction));
        const sorted=filtered.filter(r=>!s.search||[r.grain.airline,r.grain.route,r.grain.flight_number].join(' ').toLocaleLowerCase('vi').includes(s.search.toLocaleLowerCase('vi'))).sort((a,b)=>[a.grain.airline,a.grain.route,a.grain.flight_number].join('/').localeCompare([b.grain.airline,b.grain.route,b.grain.flight_number].join('/'),'vi'));
        const appendFrequency=(container:HTMLElement,node:Tree,depth:number)=>{
          const details=el('details'),summary=el('summary',node.label),id=JSON.stringify([p.id,node.id]);
          details.open=!!s.search||(!s.collapsed.has(id)&&(s.depth>depth||s.expanded.has(id)));
          summary.setAttribute('aria-expanded',String(details.open));details.append(summary);
          details.addEventListener('toggle',()=>{summary.setAttribute('aria-expanded',String(details.open));if(details.open){s.expanded.add(id);s.collapsed.delete(id);}else{s.expanded.delete(id);s.collapsed.add(id);}});
          if(node.children.length)for(const child of sortNodes(node.children,s,p.id,active))appendFrequency(details,child,depth+1);
          else {const body=tableFrame(details,['Số hiệu','Chiều','Giờ điển hình','Thứ hoạt động','Ngày hoạt động','Ngày có thể hoạt động','Mức ổn định']);
            for(const r of node.rows){const tr=el('tr');tr.append(el('th',String(r.grain.flight_number),'name'),el('td',directionNames[r.direction]),el('td',r.typical_time),el('td',r.operating_days!.map(d=>d===7?'CN':`T${d+1}`).join(', ')));numberCell(tr,r.occurrence_days!);numberCell(tr,r.eligible_days!);tr.append(el('td',`${fmt(r.consistency_percent)}%`));body.append(tr);}}
          container.append(details);
        };
        for(const node of sortNodes(tree(sorted,active.levels),s,p.id,active))appendFrequency(section,node,0);
        if(!sorted.length)section.append(el('p','Không có lịch định kỳ phù hợp. Đặt lại bộ lọc để xem toàn bộ.'));main.append(section);}
    }else if(blocks.length){
      for(const pair of blocks)for(const direction of dims(s))for(const key of metrics(s)){
        const section=el('section');section.append(el('h3',`${metricNames[key]} ${directionNames[direction]} · ${periods.get(pair.minuend_period)!.label} − ${periods.get(pair.baseline_period)!.label}`));
        section.append(el('p',`${range(periods.get(pair.minuend_period)!)} / ${range(periods.get(pair.baseline_period)!)}`));
        const scoped=rows.filter(r=>r.period===pair.minuend_period||r.period===pair.baseline_period);
        renderTree(section,scoped,active,s,pair.minuend_period,pair.baseline_period,key,direction);main.append(section);
      }
      chart(main,rows,active,s,'current');
    }else if(active.analysis)main.append(el('p','Chọn một cặp tuần để xem so sánh. Nếu mùa chưa có khách được ghi nhận, chưa có cặp tuần Analysis.','notice'));
    else{
      const shown=active.dataset==='timeline'||active.dataset==='hours'?ordinary:[periods.get('current')!];
      for(const p of shown){const section=el('section');section.append(el('h3',`${p.label} · ${range(p)}${p.contains_future?' · Có lịch bay tương lai':''}`));const scoped=rows.filter(r=>r.period===p.id);
        if(active.peaks){for(const direction of dims(s))for(const key of metrics(s)){section.append(el('h3',`Top 5 ${key==='flights'?'chuyến bay':'hành khách'} ${directionNames[direction]} · xếp hạng độc lập`));
          const top=tree(scoped,active.levels).filter(n=>n.rows[0].grain.hour!==null).map(n=>({node:n,value:measure(n.rows,p.id,direction,active)[key]})).filter(n=>n.value!==null).sort((a,b)=>b.value!-a.value!||a.node.label.localeCompare(b.node.label,'vi')).slice(0,5);
          const body=tableFrame(section,['Ngày / Giờ',metricNames[key]]);top.forEach(n=>{const tr=el('tr');tr.append(el('th',n.node.label,'name'));numberCell(tr,n.value);body.append(tr);});if(!top.length)section.append(el('p','Chưa có số liệu để xếp hạng.'));}
        }else{chart(section,scoped,active,s,p.id);
          if(s.direction==='each')for(const direction of dims(s)){const part=el('section');part.append(el('h3',directionNames[direction]));renderTree(part,scoped,active,s,p.id,null,undefined,direction);section.append(part);}
          else renderTree(section,scoped,active,s,p.id,null);}
        main.append(section);
      }
    }
    if(!active.frequency && rows.some(r=>r.unreported_legs===null || (r.unreported_legs??0)>0 || r.flight_coverage!=='complete'))main.append(el('p','Một phần số liệu còn thiếu hoặc chưa được ghi nhận. Hành khách hiển thị là phần đã ghi nhận; chênh lệch để trống khi chưa đủ cơ sở so sánh.','notice'));
    if(savedFocus){const match=[...main.querySelectorAll<HTMLButtonElement>('button[data-group]')].find(b=>b.dataset.group===savedFocus);match?.focus();}
    else if(savedLabel){const match=[...main.querySelectorAll<HTMLElement>('[aria-label]')].find(n=>n.getAttribute('aria-label')===savedLabel);match?.focus();}
    restoreFold();
  }
  // Weekly is a compact comparative report, not a stack of metric/direction panels.
  const weeklyDisclosure=new Set<string>();
  function renderWeekly(s:State) {
    document.body.classList.add('weekly-report');
    const current=periods.get('current')!,previous=periods.get('previous')!,next=periods.get('next')!;
    const direction=s.direction as Direction;
    const signed=(v:number|null,decimal=false)=>v===null?'—':`${v>0?'+':''}${fmt(v,decimal)}`;
    const percentageFormat=new Intl.NumberFormat('vi-VN',{maximumFractionDigits:1});
    const pct=(v:number|null)=>v===null?'—':`${v>0?'+':''}${percentageFormat.format(v*100)}%`;
    const disclosure=(label:string,key:string,controls=false)=>{
      const d=el('details',undefined,controls?'weekly-options controls':'weekly-disclosure');d.open=weeklyDisclosure.has(key);
      d.append(el('summary',label));d.addEventListener('toggle',()=>{if(d.open)weeklyDisclosure.add(key);else weeklyDisclosure.delete(key);});return d;
    };
    const pairNote=(target:HTMLElement,p=current,b=previous)=>target.append(el('p',`${b.id==='current'?'Tuần báo cáo':'Tuần trước'}: ${range(b)} · ${p.id==='next'?'Tuần kế tiếp':'Tuần báo cáo'}: ${range(p)}`,'period-note'));
    const kpi=(period:string,d:Direction)=>resources.get(`${period}/kpi`)!.rows.find(r=>r.direction===d)!;
    const overview=(target:HTMLElement,p:HtmlPeriod,b:HtmlPeriod)=>{
      const section=el('section',undefined,'weekly-summary');pairNote(section,p,b);
      const body=tableFrame(section,['Chỉ tiêu',b.id==='current'?'Tuần báo cáo':'Tuần trước',p.id==='next'?'Tuần kế tiếp':'Tuần báo cáo','Chênh lệch','Thay đổi','Bình quân/ngày']);
      for(const d of ['A','D','all'] as Direction[])for(const key of ['flights','reported_pax'] as const){
        const a=kpi(p.id,d),base=kpi(b.id,d);
        const isFuturePax = p.id==='next' && p.contains_future && key==='reported_pax';
        const change=isFuturePax ? { delta: null, percent: null, provisional: false } : compare(a,base,key);
        const tr=el('tr',undefined,d==='all'?'grand-total':undefined);
        const label=key==='flights'?(d==='all'?'Tổng chuyến':`Chuyến ${d==='A'?'đến':'đi'}`):(d==='all'?'Tổng khách':`Khách ${d==='A'?'đến':'đi'}`);
        tr.dataset.measure=`${d}-${key}`;const th=el('th',label,'name');th.scope='row';tr.append(th);
        const diffCls=change.delta===null?'':change.delta>0?'diff-pos':change.delta<0?'diff-neg':'diff-zero';
        const pctCls=change.percent===null?'':change.percent>0?'diff-pos':change.percent<0?'diff-neg':'diff-zero';
        numberCell(tr,base[key]);numberCell(tr,a[key]);tr.append(el('td',signed(change.delta),`number ${diffCls}`),el('td',pct(change.percent),`number ${pctCls}`));
        numberCell(tr,a[key]===null?null:Math.round(a[key]!/p.calendar_days));body.append(tr);
      }
      section.append(el('p',`Bình quân = sản lượng / ${p.calendar_days} ngày lịch, làm tròn sau khi tính. Ngày thiếu dữ liệu vẫn nằm trong mẫu số.`,'weekly-footnote'));
      if(p.calendar_days!==b.calendar_days)section.append(el('p','Hai kỳ khác số ngày; chênh lệch đang so tổng sản lượng, không phải bình quân/ngày.','weekly-footnote'));
      const a=kpi(p.id,'all'),bMetric=kpi(b.id,'all');const sentences:string[]=[];
      for(const key of ['flights','reported_pax'] as const){
        const isFuturePax = p.id==='next' && p.contains_future && key==='reported_pax';
        const c=isFuturePax ? { delta: null, percent: null, provisional: false } : compare(a,bMetric,key),label=key==='flights'?'Tổng chuyến':'Tổng khách';
        if(c.percent!==null)sentences.push(`${label} ${c.percent===0?'không đổi':`${c.percent>0?'tăng':'giảm'} ${percentageFormat.format(Math.abs(c.percent)*100)}%`} so với ${b.id==='current'?'tuần báo cáo':'tuần trước'}${p.id==='next'?' (theo lịch bay dự kiến)':''}.`);
        else sentences.push(isFuturePax ? 'Tổng khách: tuần kế tiếp có lịch bay tương lai, chưa thực hiện.' : `${label}: chưa đủ cơ sở tính % thay đổi.`);
      }
      section.append(el('p',sentences.join(' '),'weekly-reading'));target.append(section);
    };
    const controls=el('div',undefined,'weekly-tools controls');
    controls.append(button('In bảng đang xem',()=>window.print()));
    main.replaceChildren(el('h2',active.label),controls);showClue();
    if(active.dataset==='kpi'){
      main.append(el('p','Sản lượng trong kỳ · Chuyến đến / Chuyến đi / Tổng sản lượng','print-context'));
      overview(main,current,previous);
      const drill=el('div',undefined,'weekly-drill controls');drill.append(el('span','Xem nhóm ảnh hưởng:'));
      for(const id of ['airline','market','route']){const tab=tabs.find(t=>t.id===id)!;drill.append(button(`Xem ${tab.label.toLocaleLowerCase('vi')}`,()=>{active=tab;render();}));}main.append(drill);
      const upcoming=disclosure('Đối chiếu tuần kế tiếp','overview-next');
      upcoming.append(el('p',next.contains_future?'Có lịch bay tương lai; không xem đây là sản lượng đã thực hiện.':'Số liệu theo phạm vi tuần kế tiếp.','notice'));
      overview(upcoming,next,current);main.append(upcoming);
      if(current.contains_future)main.append(el('p','Kỳ báo cáo còn ngày tương lai; số chuyến bao gồm lịch bay, chưa phải toàn bộ sản lượng thực hiện.','notice'));
      if(['current','previous'].some(p=>kpi(p,'all').pax_status!=='complete'||kpi(p,'all').flight_coverage!=='complete'))main.append(el('p','Một phần số liệu còn thiếu. Khách là số đã ghi nhận; không kết luận tăng/giảm khi chưa đủ dữ liệu so sánh.','notice'));
      return;
    }
    if(active.dataset!=='timeline')controls.prepend(select('Chiều',[['all','Tổng'],['A','Đến'],['D','Đi']],s.direction,v=>{s.direction=v;render();}));
    const filters=disclosure('Bộ lọc và sắp xếp',`${active.id}/options`,true);
    const filterBody=el('div',undefined,'toolbar');
    for(const field of active.filters){const options=[...new Map(rawRows(active).map(r=>[JSON.stringify(r.grain[field]),labelOf(field,r.grain[field],r)])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'vi'));
      filterBody.append(select(fields[field],[['','Tất cả'],...options],s.filters[field]??'',v=>{s.filters[field]=v;s.page=0;render();}));}
    filterBody.append(select('Sắp xếp',[['flights','Tổng chuyến bay giảm dần'],['impact-pax','Ảnh hưởng khách lớn nhất'],['impact-flights','Ảnh hưởng chuyến lớn nhất'],['name','Tên']],s.sort,v=>{s.sort=v;s.page=0;render();}));
    filters.append(filterBody);controls.append(filters,button('Đặt lại',resetTab));
    const search=el('input');search.type='search';search.value=s.search;search.placeholder='Tìm tên';search.setAttribute('aria-label','Tìm tên (không đổi tổng)');
    search.addEventListener('input',()=>{const start=search.selectionStart;s.search=search.value;s.page=0;render();const input=main.querySelector<HTMLInputElement>('input[type=search]')!;input.focus();input.setSelectionRange(start,start);});controls.append(search);
    const activeFilters=Object.entries(s.filters).filter(([,v])=>v).map(([f,v])=>`${fields[f]}: ${labelOf(f,JSON.parse(v))}`).join(' · ');
    main.append(el('p',`${active.label} · ${directionNames[direction]} · ${activeFilters||'Toàn bộ phạm vi đã xuất'}`,'print-context'));
    if(s.search)main.append(el('p',`Tìm “${s.search}” chỉ đổi dòng hiển thị; tổng và nhóm ảnh hưởng vẫn tính toàn bộ phạm vi lọc.`,'weekly-footnote'));
    const allRows=values(active,s),rows=allRows.filter(r=>r.period!=='next');
    if(active.dataset==='timeline'){
      for(const p of [previous,current]){const section=el('section');section.append(el('h3',`${p.id==='current'?'Tuần báo cáo':'Tuần trước'} · ${range(p)}`));
        const body=tableFrame(section,['Ngày','Chuyến đến','Chuyến đi','Tổng chuyến','Khách đến','Khách đi','Tổng khách']);
        for(const node of tree(rows.filter(r=>r.period===p.id),['date'])){const tr=el('tr');tr.append(el('th',node.label,'name'));
          for(const key of ['flights','reported_pax'] as const)for(const d of ['A','D','all'] as Direction[])numberCell(tr,measure(node.rows,p.id,d,active)[key]);body.append(tr);}main.append(section);}
      const future=disclosure('Theo ngày của tuần kế tiếp',`${active.id}/next`);future.append(el('p',`${range(next)}${next.contains_future?' · Có lịch bay tương lai':''}`));
      renderTree(future,allRows.filter(r=>r.period==='next'),active,{...s,sort:'name',metric:'both'},'next',null);main.append(future);return;
    }
    const sorted=(nodes:Tree[],p:string,b:string)=>[...nodes].sort((a,z)=>{
      if(s.sort==='name')return a.label.localeCompare(z.label,'vi',{numeric:true})||a.id.localeCompare(z.id);
      if(s.sort==='flights'){const x=measure(a.rows,p,'all',active).flights,y=measure(z.rows,p,'all',active).flights;return x===null||y===null?x===y?a.label.localeCompare(z.label,'vi'):x===null?1:-1:y-x||a.label.localeCompare(z.label,'vi');}
      const key=s.sort==='impact-flights'?'flights':'reported_pax';
      const score=(n:Tree)=>compare(measure(n.rows,p,direction,active),measure(n.rows,b,direction,active),key).delta;
      const x=score(a),y=score(z);return x===null||y===null?x===y?a.id.localeCompare(z.id):x===null?1:-1:Math.abs(y)-Math.abs(x)||a.label.localeCompare(z.label,'vi');
    });
    const impact=(target:HTMLElement)=>{
      const panel=el('div',undefined,'weekly-impact');
      const nodes=tree(rows,active.levels);
      for(const key of ['flights','reported_pax'] as const){const section=el('section');section.append(el('h3',`Ảnh hưởng ${key==='flights'?'chuyến bay':'hành khách'}`));
        const a=measure(rows,'current',direction,active),b=measure(rows,'previous',direction,active),overall=compare(a,b,key);
        if(overall.delta===null){section.append(el('p','Chưa đủ dữ liệu để xếp hạng ảnh hưởng. Xem các giá trị đã ghi nhận trong bảng.'));panel.append(section);continue;}
        section.append(el('p',`Thay đổi chung: ${signed(overall.delta)} ${key==='flights'?'chuyến':'khách'} (${pct(overall.percent)}).`));
        const scores=nodes.map(n=>({n,delta:compare(measure(n.rows,'current',direction,active),measure(n.rows,'previous',direction,active),key).delta}));
        for(const sign of [-1,1]){const list=el('ul');const top=scores.filter(x=>x.delta!==null&&x.delta*sign>0).sort((x,y)=>sign*(y.delta!-x.delta!)||x.n.label.localeCompare(y.n.label,'vi')).slice(0,3);
          section.append(el('h4',sign<0?'Giảm nhiều nhất':'Tăng nhiều nhất'));for(const item of top){const contribution=b[key]===null||b[key]===0?null:item.delta!/b[key]!*100;
            list.append(el('li',`${item.n.label}: ${signed(item.delta)} ${key==='flights'?'chuyến':'khách'}${contribution===null?'':` · ${signed(contribution,true)} điểm % vào biến động chung`}`));}
          if(!top.length)list.append(el('li','Không có nhóm đủ dữ liệu thuộc chiều biến động này.'));section.append(list);}
        if(scores.some(x=>x.delta===null))section.append(el('p','Nhóm chưa đủ dữ liệu so sánh không được xếp hạng.','weekly-footnote'));
        panel.append(section);}
      target.append(panel);
    };
    const comparisonTable=(target:HTMLElement,source:Row[],p:string,b:string)=>{
      const section=el('section',undefined,'weekly-comparison');pairNote(section,periods.get(p)!,periods.get(b)!);
      const local=folding(JSON.stringify([active.id,p,b]));foldTools(section,local);
      const body=tableFrame(section,['Nhóm',...( ['Chuyến bay','Hành khách'].flatMap(()=>[b==='current'?'Tuần báo cáo':'Tuần trước',p==='next'?'Tuần kế tiếp':'Tuần báo cáo','Chênh lệch','Thay đổi']))]);
      const head=body.parentElement!.querySelector('thead')!,band=el('tr',undefined,'weekly-bands');
      const sortHeader=head.querySelector('th')!;sortHeader.setAttribute('aria-sort',s.sort==='name'?'ascending':'other');sortHeader.setAttribute('aria-label',s.sort==='name'?'Nhóm, sắp theo tên tăng dần':s.sort==='flights'?'Nhóm, sắp theo tổng chuyến bay giảm dần':`Nhóm, sắp theo độ lớn chênh lệch ${s.sort==='impact-flights'?'chuyến bay':'hành khách'}`);
      const name=el('th','Chỉ tiêu','name');name.scope='col';band.append(name);for(const label of ['Chuyến bay','Hành khách']){const th=el('th',label);th.colSpan=4;th.scope='colgroup';band.append(th);}head.prepend(band);
      const cells=(tr:HTMLTableRowElement,items:Row[],d:Direction)=>{for(const key of ['flights','reported_pax'] as const){const a=measure(items,p,d,active),base=measure(items,b,d,active),c=compare(a,base,key);
        const diffCls=c.delta===null?'':c.delta>0?'diff-pos':c.delta<0?'diff-neg':'diff-zero';
        const pctCls=c.percent===null?'':c.percent>0?'diff-pos':c.percent<0?'diff-neg':'diff-zero';
        numberCell(tr,base[key]);numberCell(tr,a[key]);tr.append(el('td',signed(c.delta),`number ${diffCls}`),el('td',pct(c.percent),`number ${pctCls}`));}};
      const grand=el('tr',undefined,'grand-total');grand.append(el('th','Tổng phạm vi đang lọc','name'));cells(grand,source,direction);body.append(grand);
      const nodes=sorted(tree(source,active.levels),p,b).filter(n=>visibleSearch(n,s.search.toLocaleLowerCase('vi'))),page=Math.min(s.page,Math.max(0,Math.ceil(nodes.length/20)-1));
      const append=(node:Tree,depth:number,parentMatch=false)=>{const query=s.search.toLocaleLowerCase('vi');if(!parentMatch&&!visibleSearch(node,query))return;
        const id=JSON.stringify([p,b,node.id]),open=!!s.search||(!local.collapsed.has(id)&&(local.depth>depth||local.expanded.has(id))),tr=el('tr'),th=el('th',undefined,'name');th.scope='row';th.style.paddingInlineStart=`${10+depth*16}px`;
        if(direction==='all'||node.children.length){const toggle=button(`${open?'−':'+'} ${node.label}`,()=>{if(open){local.expanded.delete(id);local.collapsed.add(id);}else{local.expanded.add(id);local.collapsed.delete(id);}render();});toggle.dataset.group=id;toggle.setAttribute('aria-expanded',String(open));th.append(toggle);}else th.textContent=node.label;
        tr.append(th);cells(tr,node.rows,direction);body.append(tr);
        if(open){if(direction==='all')for(const d of ['A','D'] as Direction[]){const child=el('tr',undefined,'weekly-direction'),label=el('th',directionNames[d],'name');label.style.paddingInlineStart=`${28+depth*16}px`;child.append(label);cells(child,node.rows,d);body.append(child);}
          for(const child of sorted(node.children,p,b))append(child,depth+1,parentMatch||!!query&&node.label.toLocaleLowerCase('vi').includes(query));}
      };
      nodes.slice(page*20,(page+1)*20).forEach(n=>append(n,0));
      if(!nodes.length)section.append(el('p','Không có nhóm phù hợp. Xóa tìm kiếm hoặc đặt lại bộ lọc.'));
      if(nodes.length>20){const paging=el('div',undefined,'pagination controls'),prev=button('Trang trước',()=>{s.page=page-1;render();}),nextButton=button('Trang sau',()=>{s.page=page+1;render();});prev.disabled=page===0;nextButton.disabled=(page+1)*20>=nodes.length;
        paging.append(prev,el('span',`Trang ${page+1}/${Math.ceil(nodes.length/20)}`),nextButton);section.append(el('p',`Đang xem ${page*20+1}–${Math.min((page+1)*20,nodes.length)} / ${nodes.length} nhóm; tổng tính toàn bộ phạm vi lọc.`,'weekly-footnote'),paging);}
      target.append(section);
    };
    impact(main);comparisonTable(main,rows,'current','previous');
    main.append(el('p','Ảnh hưởng = chênh lệch của nhóm / tổng tuần trước trong phạm vi lọc. Các góc nhìn hãng, thị trường và chặng không cộng với nhau.','weekly-footnote'));
    const structure=disclosure('Cơ cấu tuần báo cáo',`${active.id}/structure`);chart(structure,rows,active,{...s,metric:'both'},'current');main.append(structure);
    const upcoming=disclosure('Đối chiếu tuần kế tiếp',`${active.id}/next`);upcoming.append(el('p',next.contains_future?'Có lịch bay tương lai; không phải sản lượng đã thực hiện.':'Đối chiếu số liệu tuần kế tiếp.','notice'));
    comparisonTable(upcoming,allRows.filter(r=>r.period!=='previous'),'next','current');main.append(upcoming);
    if(rows.some(r=>r.pax_status!=='complete'||r.flight_coverage!=='complete'))main.append(el('p','Một phần số liệu còn thiếu. Dấu — không phải số 0; chênh lệch khách chỉ tính khi cả hai kỳ đủ dữ liệu.','notice'));
  }
  let detailsState: Map<HTMLDetailsElement, boolean> | null = null;
  window.addEventListener('beforeprint', () => {
    detailsState = new Map();
    document.querySelectorAll<HTMLDetailsElement>('details').forEach(d => {
      detailsState!.set(d, d.open);
      d.open = true;
    });
  });
  window.addEventListener('afterprint', () => {
    if (detailsState) {
      detailsState.forEach((open, d) => { d.open = open; });
      detailsState = null;
    }
  });
  render();
}
