import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSupabasePGlite } from './pglite_test_support.mjs';
import { normalizeHtmlRequest } from '../functions/_shared/trafficHtmlReportContract.ts';

export async function createHtmlTestDatabase() {
  const db = await createSupabasePGlite();
  await db.exec(`
    create schema reporting;
    create table public.seasons (id text,data_version integer);
    insert into public.seasons values ('test',1);
    create table public.season_change_events(server_seq bigint);
    insert into public.season_change_events values (9007199254740993);
    create table public.operational_route_countries(route text primary key,country text);
    create table public.operational_aircraft_groups(id text primary key,name text);
    create table public.operational_aircraft_group_types(group_id text,aircraft_type text);
    create table reporting.public_traffic_coverage(id bigint generated always as identity,from_date date,to_date date,status text,certified_at timestamptz);
    create table reporting.html_fixture_candidates(
      business_leg_key text,authoritative_server_seq bigint,season_id text,record_id text,
      ops_date date,type text,airline text,flight_number text,effective_route text,effective_aircraft text,
      effective_pax integer,local_minutes integer,scheduled_local_at timestamp,effective_action text
    );
    create function reporting.get_public_traffic_candidate_slice_v1(p_from_date date,p_to_date date)
    returns setof reporting.html_fixture_candidates language sql stable as $$
      select * from reporting.html_fixture_candidates where ops_date between p_from_date and p_to_date
    $$;
    create function reporting.get_public_traffic_canonical_bounds_v1()
    returns table(min_ops_date date,max_ops_date date) language sql stable as $$
      select date '2024-01-01',date '2027-12-31'
    $$;
    insert into public.operational_route_countries values ('ICN','Korea'),('NRT','Japan');
    insert into public.operational_aircraft_groups values ('nb','Narrowbody');
    insert into public.operational_aircraft_group_types values ('nb','A320');
    insert into reporting.public_traffic_coverage(from_date,to_date,status,certified_at)
    values ('2024-01-01','2027-12-31','complete','2026-09-05T00:00:00Z');
    insert into reporting.html_fixture_candidates values
      ('arr',1,'test','arr','2026-09-01','A','VN','VN1','ICN','A320',100,600,'2026-09-01 10:00','active'),
      ('dep',1,'test','dep','2026-09-01','D','VN','VN2','ICN','A320',0,660,'2026-09-01 11:00','active'),
      ('missing',1,'test','missing','2026-09-02','D','VJ','VJ1','NRT','A320',null,720,'2026-09-02 12:00','active'),
      ('unknown',1,'test','unknown','2026-09-03','A','ZZ','ZZ1','???',null,50,null,null,'active'),
      ('prior',1,'test','prior','2026-08-30','A','TW','TW1','ICN','A320',30,600,'2026-08-30 10:00','active'),
      ('future',1,'test','future','2026-09-08','A','NEW','NEW1','NRT','A320',null,600,'2026-09-08 10:00','active'),
      ('terminal',1,'test','old','2026-09-01','A','OLD','OLD1','ICN','A320',900,600,'2026-09-01 10:00','active'),
      ('terminal',2,'test','new','2026-09-01','A','OLD','OLD1','ICN','A320',900,600,'2026-09-01 10:00','deleted'),
      ('ambiguous',2,'test','dup1','2026-09-01','A','DUP','DUP1','ICN','A320',900,600,'2026-09-01 10:00','active'),
      ('ambiguous',2,'test','dup2','2026-09-01','A','DUP','DUP1','ICN','A320',900,600,'2026-09-01 10:00','active');
  `);
  const migration = await readFile(new URL('../migrations/20260905180000_public_traffic_html_export.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const pivotMigration=await readFile(new URL('../migrations/20260906120000_public_traffic_html_pivot_v2.sql',import.meta.url),'utf8');
  await db.exec(pivotMigration);
  await db.exec(pivotMigration);
  return db;
}
export async function htmlFixture(db, query = 'report_type=WEEKLY_DETAIL&html_template=weekly-detail-v1&period_mode=custom&from=2026-09-01&to=2026-09-04', asOf = '2026-09-05T00:00:00Z') {
  const request = normalizeHtmlRequest(new URL(`https://report.test/?${query}`));
  const result = await db.query('select public.get_public_traffic_html_export_v2($1::jsonb,null,$2::timestamptz) result', [JSON.stringify(request),asOf]);
  return { request, data: result.rows[0].result };
}

async function run() {
  const db = await createHtmlTestDatabase();
  try {
    const { data } = await htmlFixture(db);
    assert.equal(data.source_watermark,'9007199254740993');
    const resource = (kind) => data.resources.find(r => r.dataset===kind && r.period_id==='current');
    const all = resource('kpi').rows.find(r=>r.direction==='all');
    // Execute the captured live V2 definition against the same isolated canonical
    // fixture. This does not connect to or alter production.
    await db.exec('create schema extensions; create extension pgcrypto with schema extensions');
    await db.exec(await readFile(new URL('./fixtures/public_traffic_live_v2_reference_20260905.sql',import.meta.url),'utf8'));
    for (const direction of ['all','A','D']) {
      const v2=(await db.query("select public.get_public_traffic_report_v2(p_from_date=>'2026-09-01',p_to_date=>'2026-09-04',p_type=>$1,p_comparison=>'none',p_data_as_of=>'2026-09-05T00:00:00Z') result",[direction])).rows[0].result;
      const metric=resource('kpi').rows.find(r=>r.direction===direction);
      for(const key of ['flights','reported_pax','reported_legs','due_legs','missing_due_legs','true_zero_reported_legs']) assert.equal(metric[key],v2.current[key],`V2 parity ${direction}/${key}`);
      for(const day of v2.timeline) {
        const rows=resource('timeline').rows.filter(r=>r.grain.date===day.ops_date && (direction==='all'||r.direction===direction));
        assert.equal(rows.reduce((total,r)=>total+r.flights,0),day.flights,`V2 daily flights ${direction}/${day.ops_date}`);
        assert.equal(rows.some(r=>r.reported_pax!==null)?rows.reduce((total,r)=>total+(r.reported_pax??0),0):null,day.reported_pax,`V2 daily Pax ${direction}/${day.ops_date}`);
      }
    }
    assert.equal(all.flights,4); // deleted and ambiguous canonical candidates never counted
    assert.equal(all.reported_pax,150); // accepted completed date reports known Pax even when scheduled time is missing
    assert.equal(all.reported_legs,3);
    assert.equal(all.unreported_legs,1);
    assert.equal(resource('kpi').rows.find(r=>r.direction==='D').reported_pax,0);
    assert.equal(resource('timeline').rows.length,8);
    assert.equal(resource('market').rows.length,4);
    assert.equal(resource('aircraft').rows.reduce((a,r)=>a+r.flights,0),4);
    assert.equal(resource('hours').rows.reduce((a,r)=>a+r.flights,0),4);
    assert.ok(resource('hours').rows.some(r=>r.grain.hour===null));
    assert.equal(data.periods.find(p=>p.id==='previous').calendar_days,7);
    assert.equal(data.periods.find(p=>p.id==='current').calendar_days,4);
    assert.equal(data.periods.find(p=>p.id==='next').calendar_days,7);
    assert.deepEqual(data.comparison_pairs.map(p=>[p.minuend_period,p.baseline_period]),[['current','previous'],['next','current']]);
    assert.equal(data.resources.find(r=>r.period_id==='next' && r.dataset==='kpi').rows.find(r=>r.direction==='A').reported_pax,null);
    const { data: leap } = await htmlFixture(db,'report_type=MONTHLY_OVERVIEW_L2&html_template=period-analysis-v1&period_mode=month&month=2024-03&from=2024-03-01&to=2024-03-31&comparison=previous');
    assert.equal(leap.periods.find(p=>p.id==='previous').calendar_days,29);
    const { data: winter } = await htmlFixture(db,'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=season&season_code=W26&from=2026-10-25&to=2027-03-27&comparison_year=2025');
    assert.equal(winter.periods.find(p=>p.role==='comparison').from,'2025-10-26');
    assert.equal(winter.periods.find(p=>p.role==='comparison').to,'2026-03-28');
    const { data: bao } = await htmlFixture(db,'report_type=BAO_CAO_SAN_LUONG&html_template=bao-cao-san-luong-v1&period_mode=season&season_code=S26&from=2026-03-29&to=2026-10-24');
    assert.equal(bao.periods.filter(p=>p.role==='analysis-week').length,4);
    assert.equal(bao.comparison_pairs.length,3);
    assert.deepEqual(bao.periods.filter(p=>p.role==='analysis-week').map(p=>[p.from,p.to]),[
      ['2026-08-21','2026-08-27'],['2026-08-28','2026-09-03'],['2026-09-04','2026-09-10'],['2026-09-11','2026-09-17']]);
    const filtered=(await htmlFixture(db,'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-09-01&to=2026-09-04&airline=VN&route=ICN&country=Korea&tz=utc')).data;
    assert.equal(filtered.resources.find(r=>r.period_id==='current'&&r.dataset==='kpi').rows.find(r=>r.direction==='all').flights,2);
    assert.deepEqual(filtered.resources.find(r=>r.period_id==='current'&&r.dataset==='hours').rows.filter(r=>r.flights>0).map(r=>r.grain.hour).sort(),[3,4]);
    await db.exec(`insert into reporting.html_fixture_candidates
      select 'regular-'||n,1,'test','regular-'||n,date '2026-08-03'+n*7,'A','REG','REG1','NRT','A320',10,600,timestamp '2026-08-03 10:00'+n*interval '7 days','active' from generate_series(0,3) n;`);
    const regular=(await htmlFixture(db,'report_type=PERIOD_ANALYSIS&html_template=period-analysis-v1&period_mode=custom&from=2026-08-01&to=2026-08-31')).data.resources.find(r=>r.dataset==='frequency').rows;
    assert.equal(regular.length,1);
    assert.deepEqual([regular[0].occurrence_days,regular[0].eligible_days,regular[0].operating_days,regular[0].typical_time],[4,4,[1],'10:00']);
    // Display names are not identities: two aircraft groups named alike stay separate.
    await db.exec(`insert into public.operational_aircraft_groups values ('second-nb','Narrowbody');
      insert into public.operational_aircraft_group_types values ('second-nb','B737');
      update reporting.html_fixture_candidates set effective_aircraft='B737' where record_id='dep';`);
    const aircraft=(await htmlFixture(db)).data.resources.find(r=>r.period_id==='current'&&r.dataset==='aircraft').rows;
    assert.equal(new Set(aircraft.filter(r=>r.grain.group==='Narrowbody').map(r=>r.grain.group_id)).size,2);
    // Accepted completed Ops Date: known Pax is reportable before T+24, but not before 05:00 cutoff.
    await db.exec("insert into reporting.html_fixture_candidates values ('early',1,'test','early','2026-09-04','A','VN','VN9','ICN','A320',70,1380,'2026-09-04 23:00','active')");
    const before = (await htmlFixture(db,undefined,'2026-09-04T21:59:00Z')).data;
    const after = (await htmlFixture(db,undefined,'2026-09-04T22:00:00Z')).data;
    const pax = d=>d.resources.find(r=>r.period_id==='current' && r.dataset==='kpi').rows.find(r=>r.direction==='all').reported_pax;
    assert.equal(pax(before),150); assert.equal(pax(after),220);
    await db.exec("delete from reporting.public_traffic_coverage");
    const missing = (await htmlFixture(db)).data.resources.find(r=>r.period_id==='current' && r.dataset==='timeline').rows;
    assert.equal(missing.find(r=>r.grain.date==='2026-09-03' && r.direction==='D').flights,null);
    assert.equal(missing.find(r=>r.grain.date==='2026-09-03' && r.direction==='D').reported_pax,null);
    const permission = await db.query("select has_function_privilege('anon','public.get_public_traffic_html_export_v1(jsonb,bigint,timestamptz)','execute') anon, has_function_privilege('service_role','public.get_public_traffic_html_export_v1(jsonb,bigint,timestamptz)','execute') server");
    assert.deepEqual(permission.rows[0],{anon:false,server:true});
    const { request } = await htmlFixture(db);
    await assert.rejects(db.query('select public.get_public_traffic_html_export_v2($1::jsonb,1,null)',[JSON.stringify(request)]),/DATA_VERSION_CHANGED/);
    console.log(JSON.stringify({suite:'public-traffic-html-export',status:'passed'}));
  } finally { await db.close(); }
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/public_traffic_html_export_pglite.mjs')) {
  try { await run(); } catch(error) { console.error({ message:error.message, detail:error.detail, where:error.where, position:error.position }); process.exit(1); }
}
