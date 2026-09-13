import type { Direction, HtmlEnvelope, HtmlMetric, HtmlRow, Dataset } from './trafficHtmlReportContract.ts';
import type { sumHtmlMetrics, compareHtmlMetrics } from './trafficHtmlReportContract.ts';

// Embedded verbatim in a self-contained offline file. Keep all runtime dependencies
// in this function or in the explicit helpers; never fetch additional periods here.
export function mountTrafficHtmlMonthly(data:HtmlEnvelope,helpers:{sum:typeof sumHtmlMetrics;compare:typeof compareHtmlMetrics;pivot?:(tab?:string,search?:string)=>void;syncState?:{summaryTab?:string;lastTab?:string;lastSearch?:string;fromMode?:string}}) {
  type Metric='flights'|'reported_pax';
  type Row=HtmlRow&{period:string};
  type Group={id:string;label:string;rows:Row[];children:Group[]};
  type State={direction:Direction;baseline:string;search:string;sort:string;page:number;filters:Record<string,string>;expanded:Set<string>};
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,cls?:string)=>{
    const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;
  };
  const fmt=(n:number|null,decimals=0)=>n===null?'—':new Intl.NumberFormat('vi-VN',{maximumFractionDigits:decimals}).format(n);
  const signed=(n:number|null)=>n===null?'—':`${n>0?'+':''}${fmt(n,1)}`;
  const pct=(n:number|null)=>n===null?'—':`${signed(n*100)}%`;
  const date=(v:string)=>`${v.slice(8,10)}/${v.slice(5,7)}/${v.slice(0,4)}`;
  const month=(id:string)=>{const p=periods.get(id);return p?`T${Number(p.from.slice(5,7))}/${p.from.slice(0,4)}`:'Chưa chọn';};
  const names={flights:'Chuyến bay',reported_pax:'Hành khách'},units={flights:'chuyến',reported_pax:'khách'},directions={all:'Tổng',A:'Đến',D:'Đi'};
  const fields:Record<string,string>={airline:'Hãng hàng không',country:'Quốc gia',route:'Chặng bay',group_id:'Nhóm tàu bay',type:'Loại tàu bay'};
  const label=(value:unknown)=>value===null||value===''?'Chưa xác định':String(value);
  const periods=new Map(data.periods.map(p=>[p.id,p]));
  const ordered=['previous_year_ago','year_ago','previous','current'].filter(id=>periods.has(id));
  const baselines=['previous','year_ago'].filter(id=>periods.has(id));
  const current=periods.get('current')!;
  const resources=new Map(data.resources.map(r=>[`${r.period_id}/${r.dataset}`,r]));
  const raw=(dataset:Dataset):Row[]=>data.resources.filter(r=>r.dataset===dataset).flatMap(r=>r.rows.map(row=>({...row,period:r.period_id})));
  const measure=(rows:Row[],period:string,direction:Direction):HtmlMetric=>helpers.sum(rows.filter(r=>r.period===period&&(direction==='all'||r.direction===direction)),resources.get(`${period}/kpi`)!.rows.find(r=>r.direction===direction)!.flight_coverage);
  const kpi=(id:string,d:Direction)=>resources.get(`${id}/kpi`)!.rows.find(r=>r.direction===d)!;
  const change=(rows:Row[],a:string,b:string,key:Metric,d:Direction)=>helpers.compare(measure(rows,a,d),measure(rows,b,d),key);
  const valid=(m:HtmlMetric,key:Metric)=>m[key]!==null&&m.flight_coverage==='complete'&&(key==='flights'||m.unreported_legs===0);
  const button=(text:string,action:()=>void)=>{const n=el('button',text);n.type='button';n.onclick=action;return n;};
  const select=(text:string,options:Array<[string,string]>,value:string,action:(v:string)=>void)=>{
    const wrap=el('label',text),n=el('select');n.setAttribute('aria-label',text);
    for(const [v,t] of options){const o=el('option',t);o.value=v;n.append(o);}n.value=value;n.onchange=()=>action(n.value);wrap.append(n);return wrap;
  };
  const section=(title:string,cls?:string)=>{const n=el('section',undefined,cls);n.append(el('h3',title));return n;};
  const disclosure=(title:string)=>{const n=el('details',undefined,'monthly-disclosure');n.append(el('summary',title));return n;};
  const table=(target:HTMLElement,headers:string[],cls='')=>{
    const wrap=el('div',undefined,`table-scroll ${cls}`);wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',target.querySelector('h2,h3,summary')?.textContent??'Bảng so sánh tháng');
    const t=el('table'),head=el('thead'),tr=el('tr'),body=el('tbody');
    headers.forEach((text,i)=>{const th=el('th',text,i===0?'name':'');th.scope='col';tr.append(th);});head.append(tr);t.append(head,body);wrap.append(t);target.append(wrap);return body;
  };
  const number=(tr:HTMLTableRowElement,n:number|null)=>tr.append(el('td',fmt(n),'number'));
  function tree(rows:Row[],levels:string[],path:unknown[]=[]):Group[]{
    if(!levels.length)return [];
    const map=new Map<string,Row[]>(),field=levels[0];
    for(const row of rows){const id=JSON.stringify(row.grain[field]),group=map.get(id)??[];group.push(row);map.set(id,group);}
    return [...map].map(([key,group])=>{const next=[...path,field,JSON.parse(key)];return {id:JSON.stringify(next),label:label(field==='group_id'?group[0].grain.group:JSON.parse(key)),rows:group,children:tree(group,levels.slice(1),next)};});
  }
  const tabs=[
    {id:'overview',title:'Tóm tắt tháng',dataset:'kpi' as Dataset,levels:[] as string[]},
    {id:'airline',title:'Hãng hàng không',dataset:'market' as Dataset,levels:['airline','route']},
    {id:'market',title:'Thị trường',dataset:'market' as Dataset,levels:['country','route','airline']},
    {id:'route',title:'Chặng bay',dataset:'market' as Dataset,levels:['route','airline']},
    {id:'peaks',title:'Ngày và giờ cao điểm',dataset:'timeline' as Dataset,levels:[] as string[]},
    {id:'aircraft',title:'Tàu bay',dataset:'aircraft' as Dataset,levels:['group_id','type']},
    {id:'frequency',title:'Tần suất',dataset:'frequency' as Dataset,levels:[] as string[]},
  ];
  const defaults=():State=>({direction:'all',baseline:baselines[0]??'',search:'',sort:'flights',page:0,filters:{},expanded:new Set()});
  const states=new Map(tabs.map(t=>[t.id,defaults()]));let active=tabs[0];
  const syncMap: Record<string, string> = {
    country: 'market', days: 'peaks', airline: 'airline', route: 'route',
    aircraft: 'aircraft', frequency: 'frequency', hours: 'peaks'
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
  const root=document.getElementById('report')!,header=el('header'),nav=el('nav',undefined,'tabs controls'),main=el('main');main.id='main';main.tabIndex=-1;
  document.body.classList.add('monthly-report');
  header.append(el('h1',`Tổng quan khai thác tháng ${Number(current.from.slice(5,7))}/${current.from.slice(0,4)}`),el('p',`${date(current.from)} – ${date(current.to)} · ${data.normalized_request.time_basis==='utc'?'Giờ UTC':'Giờ địa phương'}`));
  const fixed=[['Hãng',data.normalized_request.airlines],['Chặng',data.normalized_request.routes],['Quốc gia',data.normalized_request.countries]] as const;
  const fixedText=fixed.filter(([,v])=>v.length).map(([k,v])=>`${k}: ${v.join(', ')}`).join(' · ');
  if(fixedText)header.append(el('p',`Phạm vi đã xuất: ${fixedText}`));
  header.append(el('p',`${current.contains_future?'Tháng có lịch bay tương lai; số chuyến không phải toàn bộ đã thực hiện. ':''}Hành khách là số đã ghi nhận. Dấu — là chưa đủ dữ liệu, không phải số 0.`,'notice'));
  nav.setAttribute('aria-label','Các phần báo cáo tháng');for(const tab of tabs){const b=button(tab.title,()=>{active=tab;render();});b.dataset.tab=tab.id;nav.append(b);}
  const showClue=()=>{
    if(helpers.syncState?.fromMode === 'pivot') {
      const clueBanner = el('aside', undefined, 'summary-clue-banner controls');
      clueBanner.setAttribute('role', 'status');clueBanner.setAttribute('aria-live', 'polite');
      const icon = el('span', '📊', 'clue-icon');
      const msg = el('span', undefined, 'clue-text');
      msg.innerHTML = `Chế độ <strong>Báo cáo tổng quan chuẩn</strong>: Đang xem góc nhìn <strong>[${active.title}]</strong>.`;
      const closeBtn = el('button', '✕', 'clue-close');closeBtn.type = 'button';closeBtn.title = 'Đóng thông báo';
      closeBtn.onclick = () => { if(helpers.syncState) helpers.syncState.fromMode = ''; clueBanner.remove(); };
      clueBanner.append(icon, msg, closeBtn);
      main.prepend(clueBanner);
    }
  };
  root.replaceChildren(header,nav,main);

  function metricCells(tr:HTMLTableRowElement,get:(p:string)=>HtmlMetric,key:Metric,averages=false){
    for(const id of ordered){const m=get(id),td=el('td',fmt(m[key]),`number ${id==='current'?'monthly-current':''}`);
      if(averages)td.append(el('small',`TB/ngày: ${m[key]===null?'—':fmt(m[key]!/periods.get(id)!.calendar_days)}`));
      if(key==='reported_pax'&&m.pax_status==='partial')td.append(el('small','Chưa đủ khách'));
      tr.append(td);
    }
    for(const id of baselines){
      const c=helpers.compare(get('current'),get(id),key);
      const diffCls=c.delta===null?'':c.delta>0?'diff-pos':c.delta<0?'diff-neg':'diff-zero';
      const pctCls=c.percent===null?'':c.percent>0?'diff-pos':c.percent<0?'diff-neg':'diff-zero';
      const td=el('td',signed(c.delta),`number ${diffCls}`);
      td.append(el('small',pct(c.percent),pctCls));
      tr.append(td);
    }
  }
  const headers=(grouped=false)=>[grouped?'Nhóm':'Chỉ tiêu',...(grouped?['Sản lượng']:[]),...ordered.map(month),...baselines.map(id=>`So ${month(id)} · Δ / %`)];
  const narrative=(get:(p:string)=>HtmlMetric,key:Metric)=>{
    const value=get('current')[key];let text=`${names[key]}: ${fmt(value)} ${units[key]}; bình quân ${value===null?'—':fmt(value/current.calendar_days)} ${units[key]}/ngày.`;
    for(const b of baselines){const c=helpers.compare(get('current'),get(b),key);text+=c.delta===null?` Chưa đủ dữ liệu so với ${month(b)}.`:` So ${month(b)}: ${signed(c.delta)} ${units[key]} (${pct(c.percent)}).`;}
    return text;
  };
  function yearTrend(get:(p:string)=>HtmlMetric,key:Metric){
    if(!periods.has('previous_year_ago'))return '';
    const now=helpers.compare(get('current'),get('previous'),key),prior=helpers.compare(get('year_ago'),get('previous_year_ago'),key);
    if(now.percent===null||prior.percent===null)return `${names[key]}: chưa đủ cơ sở đối chiếu mức biến động tháng giữa hai năm.`;
    return `${names[key]}: ${month('previous_year_ago')} → ${month('year_ago')} ${pct(prior.percent)}; ${month('previous')} → ${month('current')} ${pct(now.percent)}; chênh lệch ${signed((now.percent-prior.percent)*100)} điểm %.`;
  }
  function impact(target:HTMLElement,rows:Row[],levels:string[],s:State,compact=false){
    const box=el('div',undefined,'monthly-impact'),groups=tree(rows,levels);
    for(const key of ['flights','reported_pax'] as Metric[]){
      const part=section(`Ảnh hưởng ${names[key].toLowerCase()}`);
      if(!s.baseline){part.append(el('p','Chọn kỳ đối chiếu khi xuất báo cáo để phân tích biến động.'));box.append(part);continue;}
      const base=measure(rows,s.baseline,s.direction),overall=change(rows,'current',s.baseline,key,s.direction);
      if(overall.delta===null){part.append(el('p','Chưa đủ dữ liệu để xếp hạng ảnh hưởng.'));box.append(part);continue;}
      part.append(el('p',`So ${month(s.baseline)}: ${signed(overall.delta)} ${units[key]} (${pct(overall.percent)}).`));
      const scores=groups.map(g=>({g,delta:change(g.rows,'current',s.baseline,key,s.direction).delta}));
      for(const sign of [-1,1]){const list=el('ul'),top=scores.filter(x=>x.delta!==null&&x.delta*sign>0).sort((x,y)=>sign*(y.delta!-x.delta!)||x.g.label.localeCompare(y.g.label,'vi')).slice(0,compact?1:3);
        part.append(el('h4',sign<0?'Giảm nhiều nhất':'Tăng nhiều nhất'));
        for(const {g,delta} of top)list.append(el('li',`${g.label}: ${signed(delta)} ${units[key]}${!compact&&base[key]!==null&&base[key]!==0?` · ${signed(delta!/base[key]!*100)} điểm % vào biến động chung`:''}`));
        if(!top.length)list.append(el('li','Không có nhóm đủ dữ liệu thuộc chiều biến động này.'));part.append(list);
      }
      if(scores.some(x=>x.delta===null))part.append(el('p','Nhóm chưa đủ dữ liệu không được xếp hạng.','monthly-footnote'));
      box.append(part);
    }
    target.append(box);
  }
  function overview(s:State){
    const report=section('I. Sản lượng chuyến bay và hành khách','monthly-overview'),body=table(report,headers(),'monthly-matrix');
    for(const d of ['A','D','all'] as Direction[])for(const key of ['flights','reported_pax'] as Metric[]){
      const tr=el('tr',undefined,d==='all'?'grand-total':'');tr.dataset.measure=`${d}-${key}`;const th=el('th',d==='all'?`Tổng ${names[key].toLowerCase()}`:`${names[key]} ${directions[d].toLowerCase()}`,'name');th.scope='row';tr.append(th);metricCells(tr,p=>kpi(p,d),key,true);body.append(tr);
    }
    report.append(el('p','Bình quân lấy tổng từng tháng chia số ngày lịch của chính tháng đó. Chênh lệch = tháng báo cáo − tháng đối chiếu; tỷ lệ dùng tháng đối chiếu làm mẫu số.','monthly-footnote'));main.append(report);
    const reading=section('Nhận xét từ số liệu','monthly-reading');
    for(const key of ['flights','reported_pax'] as Metric[]){reading.append(el('p',narrative(p=>kpi(p,'all'),key)));const trend=yearTrend(p=>kpi(p,'all'),key);if(trend)reading.append(el('p',trend));}main.append(reading);
    const draft=disclosure('Nội dung dùng cho báo cáo Word'),copy=el('textarea');copy.readOnly=true;copy.rows=9;copy.setAttribute('aria-label','Nhận xét để sao chép');
    copy.value=[current.contains_future?'Số chuyến theo lịch khai thác; tháng có ngày tương lai.':'Số liệu khai thác theo phạm vi tháng báo cáo.',...(['A','D','all'] as Direction[]).flatMap(d=>(['flights','reported_pax'] as Metric[]).map(k=>`${directions[d]} — ${narrative(p=>kpi(p,d),k)}`)),...(['flights','reported_pax'] as Metric[]).map(k=>yearTrend(p=>kpi(p,'all'),k))].filter(Boolean).join('\n');
    draft.append(el('p','Chọn văn bản rồi sao chép. Nhận xét mô tả số liệu, không tự kết luận nguyên nhân tăng/giảm.'),copy,button('Chọn văn bản',()=>{copy.focus();copy.select();}));main.append(draft);
    const highlights=section('Điểm ảnh hưởng chính');highlights.append(el('p',`Tổng Đến + Đi · ${s.baseline?`so ${month(s.baseline)}`:'chưa chọn kỳ đối chiếu'}. Mỗi góc nhìn là một cách phân tích cùng tổng, không cộng ba góc nhìn với nhau.`,'monthly-footnote'));
    const cards=el('div',undefined,'monthly-highlights');
    for(const [field,title] of [['airline','Hãng hàng không'],['country','Thị trường'],['route','Chặng bay']]){const part=section(title),rows=raw('market'),groups=tree(rows,[field]);
      for(const key of ['flights','reported_pax'] as Metric[]){part.append(el('h4',names[key]));
        if(!s.baseline||change(rows,'current',s.baseline,key,'all').delta===null){part.append(el('p','Chưa đủ dữ liệu so sánh.'));continue;}
        const scores=groups.map(g=>({label:g.label,delta:change(g.rows,'current',s.baseline,key,'all').delta}));
        for(const sign of [-1,1]){const top=scores.filter(x=>x.delta!==null&&x.delta*sign>0).sort((a,b)=>sign*(b.delta!-a.delta!))[0];
          part.append(el('p',top?`${sign<0?'Giảm':'Tăng'} nhiều nhất: ${top.label} ${signed(top.delta)} ${units[key]}.`:`Không có nhóm đủ dữ liệu ${sign<0?'giảm':'tăng'}.`));}}
      const target=tabs.find(t=>t.levels[0]===field)!,link=button('Xem chi tiết',()=>{active=target;states.set(active.id,{...defaults(),baseline:s.baseline});render();main.focus();});link.className='controls';part.append(link);cards.append(part);
    }highlights.append(cards);main.append(highlights);
  }
  function groupTable(rows:Row[],s:State){
    const container=section(`So sánh ${active.title.toLowerCase()} · ${directions[s.direction]}`,'monthly-groups'),body=table(container,headers(true),'monthly-matrix');
    const actions=el('div',undefined,'table-tools controls');actions.setAttribute('role','group');actions.setAttribute('aria-label',`Công cụ bảng ${active.title}`);
    actions.append(button('Mở toàn bộ',()=>{const expand=(groups:Group[])=>{for(const g of groups){s.expanded.add(g.id);expand(g.children);}};expand(tree(rows,active.levels));render();}),
      button('Thu gọn nhóm',()=>{s.expanded.clear();render();}));
    actions.querySelectorAll('button').forEach(b=>b.setAttribute('aria-label',b.textContent!));
    container.querySelector('.table-scroll')!.before(actions);
    body.parentElement!.querySelector('thead th')!.setAttribute('aria-sort',s.sort==='name'?'ascending':'other');
    const sort=(groups:Group[])=>[...groups].sort((a,b)=>{
      if(s.sort==='name')return a.label.localeCompare(b.label,'vi',{numeric:true});
      const key:Metric=s.sort.endsWith('pax')?'reported_pax':'flights';
      const score=(g:Group)=>s.sort.startsWith('impact')?(s.baseline?change(g.rows,'current',s.baseline,key,s.direction).delta:null):measure(g.rows,'current',s.sort==='flights'?'all':s.direction)[key];
      let x=score(a),y=score(b);if(x===null||y===null)return x===y?a.id.localeCompare(b.id):x===null?1:-1;
      if(s.sort.startsWith('impact')){x=Math.abs(x);y=Math.abs(y);}return y-x||a.label.localeCompare(b.label,'vi');
    });
    const appendRows=(text:string,items:Row[],d:Direction,depth:number,cls:string,group?:Group)=>{
      for(const key of ['flights','reported_pax'] as Metric[]){const tr=el('tr',undefined,cls);tr.dataset.measure=key;
        if(key==='flights'){const th=el('th',undefined,'name');th.rowSpan=2;th.scope='rowgroup';th.style.paddingInlineStart=`${10+depth*16}px`;
          if(group){const open=s.expanded.has(group.id),toggle=button(`${open?'−':'+'} ${text}`,()=>{if(open)s.expanded.delete(group.id);else s.expanded.add(group.id);render();});toggle.dataset.group=group.id;toggle.setAttribute('aria-expanded',String(open));th.append(toggle);}else th.textContent=text;tr.append(th);}
        const metric=el('th',names[key],'monthly-metric');metric.scope='row';tr.append(metric);metricCells(tr,p=>measure(items,p,d),key);body.append(tr);
      }
    };
    appendRows('Tổng phạm vi đang lọc',rows,s.direction,0,'grand-total');
    const query=s.search.trim().toLocaleLowerCase('vi'),matches=(g:Group):boolean=>g.label.toLocaleLowerCase('vi').includes(query)||g.children.some(matches);
    const groups=sort(tree(rows,active.levels)).filter(g=>!query||matches(g)),page=Math.min(s.page,Math.max(0,Math.ceil(groups.length/20)-1));
    function append(g:Group,depth:number,parentMatch=false){
      if(query&&!parentMatch&&!matches(g))return;
      appendRows(g.label,g.rows,s.direction,depth,'monthly-group',g);
      if(s.expanded.has(g.id)){
        if(s.direction==='all')for(const d of ['A','D'] as Direction[])appendRows(directions[d],g.rows,d,depth+1,'monthly-direction');
        if(periods.has('previous_year_ago')){const tr=el('tr',undefined,'monthly-trend'),td=el('td');td.colSpan=headers(true).length;
          for(const key of ['flights','reported_pax'] as Metric[])td.append(el('p',yearTrend(p=>measure(g.rows,p,s.direction),key)));tr.append(td);body.append(tr);}
        for(const child of sort(g.children))append(child,depth+1,parentMatch||!!query&&g.label.toLocaleLowerCase('vi').includes(query));
      }
    }
    groups.slice(page*20,(page+1)*20).forEach(g=>append(g,0));
    if(!groups.length)container.append(el('p','Không có nhóm phù hợp. Xóa tìm kiếm hoặc đặt lại bộ lọc.'));
    container.append(el('p',`Đang xem ${groups.length?page*20+1:0}–${Math.min((page+1)*20,groups.length)} / ${groups.length} nhóm. Tìm kiếm và phân trang không thay đổi tổng hoặc xếp hạng ảnh hưởng.`,'monthly-footnote'));
    if(groups.length>20){const paging=el('div',undefined,'pagination controls'),prev=button('Trang trước',()=>{s.page=page-1;render();}),next=button('Trang sau',()=>{s.page=page+1;render();});prev.disabled=page===0;next.disabled=(page+1)*20>=groups.length;paging.append(prev,el('span',`Trang ${page+1}/${Math.ceil(groups.length/20)}`),next);container.append(paging);}
    main.append(container);
  }
  function svg(tag:string,attrs:Record<string,string>,text?:string){const n=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);if(text)n.textContent=text;return n;}
  function shares(rows:Row[],s:State){
    const block=disclosure('Cơ cấu chuyến bay và hành khách · tháng báo cáo / cùng kỳ'),charts=el('div',undefined,'charts'),groups=tree(rows,active.levels);
    const colors=['#1e3a8a','#2563eb','#075985','#0369a1','#0e7490','#115e59','#047857','#3f6212','#854d0e','#9a3412','#991b1b','#9f1239','#86198f','#6b21a8','#3730a3','#164e63','#166534','#713f12','#7c2d12','#334155'];
    // A group keeps its color across current/year-ago charts, even if its rank changes.
    const colorMaps=new Map<Metric,Map<string,string>>();
    for(const key of ['flights','reported_pax'] as Metric[]){
      const ids=[...new Set(['current','year_ago'].filter(p=>periods.has(p)).flatMap(id=>groups.map(g=>({id:g.id,value:measure(g.rows,id,s.direction)[key]})).filter(p=>p.value!==null&&p.value>0).sort((a,b)=>b.value!-a.value!||a.id.localeCompare(b.id)).slice(0,10).map(p=>p.id)))].sort();
      colorMaps.set(key,new Map(ids.map((id,i)=>[id,colors[i]])));
    }
    for(const key of ['flights','reported_pax'] as Metric[])for(const id of ['current','year_ago'].filter(p=>periods.has(p))){
      const fig=el('figure');fig.append(el('figcaption',`${names[key]} ${directions[s.direction]} · ${month(id)}`));
      const total=measure(rows,id,s.direction);
      if(!valid(total,key)||total[key]===0){fig.append(el('p','Chưa đủ dữ liệu hoặc tổng bằng 0 để tính tỷ trọng.'));charts.append(fig);continue;}
      const points=groups.map(g=>({id:g.id,label:g.label,value:measure(g.rows,id,s.direction)[key]})).filter((p):p is {id:string;label:string;value:number}=>p.value!==null&&p.value>0).sort((a,b)=>b.value-a.value||a.label.localeCompare(b.label,'vi'));
      const top=points.slice(0,10);if(points.length>10)top.push({id:'other',label:'Khác',value:points.slice(10).reduce((sum,p)=>sum+p.value,0)});
      const graph=svg('svg',{viewBox:'0 0 240 240',role:'img','aria-label':`Tỷ trọng ${names[key].toLowerCase()} ${month(id)}; Top 10 và Khác. Giá trị trong chú giải.`});let offset=0;
      const list=el('ol');top.forEach(p=>{const color=colorMaps.get(key)!.get(p.id)??'#64748b',value=p.value/total[key]!*100,c=svg('circle',{cx:'120',cy:'120',r:'85',fill:'none',stroke:color,'stroke-width':'36',pathLength:'100','stroke-dasharray':`${value} ${100-value}`,'stroke-dashoffset':String(-offset),transform:'rotate(-90 120 120)'});offset+=value;c.append(svg('title',{},`${p.label}: ${fmt(p.value)} (${fmt(value,1)}%)`));graph.append(c);
        const li=el('li'),swatch=el('span',undefined,'monthly-swatch');swatch.style.backgroundColor=color;swatch.setAttribute('aria-hidden','true');li.append(swatch,document.createTextNode(`${p.label}: ${fmt(p.value)} (${fmt(value,1)}%)`));list.append(li);});
      graph.append(svg('text',{x:'120',y:'125','text-anchor':'middle'},fmt(total[key])));fig.append(graph,list);charts.append(fig);
    }
    block.append(charts);main.append(block);
  }
  function peaks(s:State){
    main.append(el('p',`${month('current')} · ${directions[s.direction]}. Ngày cao điểm và giờ cao điểm xếp hạng riêng cho chuyến bay, hành khách. Giờ là bình quân/ngày, chưa tự gộp thành dải giờ.`,'print-context'));
    for(const [dataset,field,title] of [['timeline','date','Ngày cao điểm'],['hours','hour','Giờ cao điểm']] as const){
      const rows=raw(dataset).filter(r=>r.period==='current'),groups=tree(rows,[field]),box=el('div',undefined,'monthly-impact');
      const display=(g:Group)=>field==='date'?`${new Intl.DateTimeFormat('vi-VN',{weekday:'short',timeZone:'UTC'}).format(new Date(String(g.rows[0].grain.date)))} ${date(String(g.rows[0].grain.date))}`:`${String(g.rows[0].grain.hour).padStart(2,'0')}:00–${String((Number(g.rows[0].grain.hour)+1)%24).padStart(2,'0')}:00`;
      for(const key of ['flights','reported_pax'] as Metric[]){const part=section(`${title} · ${names[key].toLowerCase()}`);box.append(part);
        if(!valid(measure(rows,'current',s.direction),key)){part.append(el('p','Chưa đủ dữ liệu cả tháng để xếp hạng. Xem phần đã ghi nhận trong bảng chi tiết.'));continue;}
        const top=groups.filter(g=>g.rows[0].grain[field]!==null).map(g=>({g,value:measure(g.rows,'current',s.direction)[key]})).filter((p):p is {g:Group;value:number}=>p.value!==null&&p.value>0).sort((a,b)=>b.value-a.value||a.g.id.localeCompare(b.g.id)).slice(0,5);
        const body=table(part,[field==='date'?'Ngày':'Khung giờ',names[key],field==='date'?'So bình quân tháng':'Bình quân/ngày']);
        for(const p of top){const tr=el('tr');tr.append(el('th',display(p.g),'name'));number(tr,p.value);tr.append(el('td',field==='date'?signed(p.value-measure(rows,'current',s.direction)[key]!/current.calendar_days):fmt(p.value/current.calendar_days,1),'number'));body.append(tr);}
        if(!top.length)part.append(el('p','Không có ngày/giờ có sản lượng dương để xếp hạng.'));
      }
      main.append(box);
      const detail=disclosure(field==='date'?'Chi tiết từng ngày':'Chi tiết 24 giờ và giờ chưa xác định'),body=table(detail,[field==='date'?'Ngày':'Khung giờ','Chuyến bay','Hành khách',...(field==='hour'?['Chuyến/ngày','Khách/ngày']:[])]);
      // Match the public dashboard's operational order; timezone never changes Ops Date.
      const hourStart=data.normalized_request.time_basis==='utc'?22:5;
      const order=(g:Group)=>field==='hour'?(g.rows[0].grain.hour===null?24:(Number(g.rows[0].grain.hour)-hourStart+24)%24):String(g.rows[0].grain.date);
      for(const g of [...groups].sort((a,b)=>String(order(a)).localeCompare(String(order(b)),'en',{numeric:true}))){const m=measure(g.rows,'current',s.direction),tr=el('tr');tr.append(el('th',g.rows[0].grain[field]===null?'Chưa xác định':display(g),'name'));number(tr,m.flights);number(tr,m.reported_pax);if(field==='hour'){tr.append(el('td',m.flights===null?'—':fmt(m.flights/current.calendar_days,1),'number'),el('td',m.reported_pax===null?'—':fmt(m.reported_pax/current.calendar_days,1),'number'));}body.append(tr);}main.append(detail);
    }
  }
  function frequency(s:State){
    main.append(el('p','Chỉ gồm lịch định kỳ đạt ít nhất 4 ngày, 4 tuần và mức ổn định 70%. Không phải danh sách toàn bộ chuyến bay sớm hoặc chuyến không thường lệ.','notice'));
    for(const id of ordered){const part=section(month(id)),rows=raw('frequency').filter(r=>r.period===id&&(s.direction==='all'||r.direction===s.direction)),body=table(part,['Hãng / Chặng','Số hiệu','Chiều','Giờ điển hình','Thứ hoạt động']);
      for(const r of rows){const tr=el('tr');tr.append(el('th',`${label(r.grain.airline)} / ${label(r.grain.route)}`,'name'),el('td',label(r.grain.flight_number)),el('td',directions[r.direction]),el('td',r.typical_time),el('td',r.operating_days!.map(d=>d===7?'CN':`T${d+1}`).join(', ')));body.append(tr);}if(!rows.length)part.append(el('p','Không có lịch định kỳ phù hợp trong tháng.'));main.append(part);}
  }
  function render(){
    const focused=document.activeElement as HTMLElement|null,saved=focused?.dataset.group,savedLabel=main.contains(focused)?focused?.getAttribute('aria-label'):null;
    const restoreFocus=()=>{
      if(saved)main.querySelectorAll<HTMLButtonElement>('button[data-group]').forEach(b=>{if(b.dataset.group===saved)b.focus();});
      else if(savedLabel)main.querySelectorAll<HTMLElement>('[aria-label]').forEach(n=>{if(n.getAttribute('aria-label')===savedLabel)n.focus({preventScroll:true});});
    };
    const s=states.get(active.id)!;main.replaceChildren(el('h2',active.title));showClue();nav.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===active.id)));
    const tools=el('div',undefined,'monthly-tools controls');tools.append(button('In phần đang xem',()=>window.print()));
    if(active.id!=='overview')tools.append(select('Chiều',[['all','Tổng Đến + Đi'],['A','Đến'],['D','Đi']],s.direction,v=>{s.direction=v as Direction;render();}));
    if(active.levels.length||active.id==='overview')if(baselines.length)tools.append(select('Phân tích ảnh hưởng so với',baselines.map(id=>[id,month(id)]),s.baseline,v=>{s.baseline=v;render();}));
    main.append(tools);
    if(active.id==='overview'){overview(s);restoreFocus();return;}
    if(active.id==='peaks'){peaks(s);restoreFocus();return;}
    if(active.id==='frequency'){frequency(s);restoreFocus();return;}
    const allRows=raw(active.dataset),rows=allRows.filter(r=>Object.entries(s.filters).every(([field,v])=>!v||JSON.stringify(r.grain[field])===v));
    const searchLabel=el('label','Tìm nhóm'),search=el('input');search.type='search';search.value=s.search;search.setAttribute('aria-label','Tìm nhóm');search.oninput=()=>{s.search=search.value;s.page=0;render();};searchLabel.append(search);tools.append(searchLabel);
    const options=el('details',undefined,'monthly-options');options.append(el('summary','Bộ lọc và sắp xếp'));const filters=el('div',undefined,'toolbar');
    options.open=Object.values(s.filters).some(Boolean)||s.sort!=='flights';
    for(const field of active.levels){const values=[...new Set(allRows.map(r=>JSON.stringify(r.grain[field])))].sort();filters.append(select(fields[field],[['','Tất cả'],...values.map((v):[string,string]=>[v,label(field==='group_id'?allRows.find(r=>JSON.stringify(r.grain[field])===v)?.grain.group:JSON.parse(v))])],s.filters[field]??'',v=>{s.filters[field]=v;s.page=0;s.expanded.clear();render();}));}
    filters.append(select('Sắp xếp',[['impact-flights','Ảnh hưởng chuyến bay'],['impact-pax','Ảnh hưởng hành khách'],['flights','Số chuyến tháng báo cáo'],['pax','Số khách tháng báo cáo'],['name','Tên']],s.sort,v=>{s.sort=v;s.page=0;render();}));
    filters.append(button('Đặt lại',()=>{states.set(active.id,defaults());render();}));options.append(filters);tools.append(options);
    main.append(el('p',`${directions[s.direction]} · ${Object.entries(s.filters).filter(([,v])=>v).map(([f,v])=>`${fields[f]}: ${label(JSON.parse(v))}`).join(' · ')||'Không lọc thêm'} · Chênh lệch là tháng báo cáo trừ tháng đối chiếu.`,'print-context'));
    impact(main,rows,active.levels,s);groupTable(rows,s);shares(rows,s);
    main.append(el('p','Ảnh hưởng tính theo chênh lệch của nhóm trên tổng tháng đối chiếu trong phạm vi lọc. Hãng, thị trường và chặng là các góc nhìn của cùng sản lượng, không cộng với nhau. Nhóm vắng mặt không tự được kết luận là mới hoặc ngừng khai thác.','monthly-footnote'));
    if(rows.some(r=>r.pax_status!=='complete'||r.flight_coverage!=='complete'))main.append(el('p','Một phần số liệu chưa đầy đủ. Không tính chênh lệch hành khách khi một trong hai kỳ còn thiếu dữ liệu.','notice'));
    restoreFocus();
  }
  render();
}
