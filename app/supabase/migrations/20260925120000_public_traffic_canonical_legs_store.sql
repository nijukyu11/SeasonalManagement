-- Create and populate canonical flight legs store
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- 1. Create canonical flight legs store
create table if not exists reporting.canonical_flight_legs (
  business_leg_key text primary key,
  ops_date date not null,
  type text not null,
  airline text not null,
  flight_number text not null,
  route text not null,
  aircraft_type text not null,
  flight_category text not null default 'C',
  pax integer,
  local_minutes smallint,
  scheduled_local_at timestamp without time zone
);

create index if not exists idx_canonical_flight_legs_ops_date
  on reporting.canonical_flight_legs (ops_date);

create table if not exists reporting.canonical_flight_legs_quarantine (
  ops_date date not null,
  candidate_count integer not null
);

create index if not exists idx_canonical_flight_legs_quarantine_ops_date
  on reporting.canonical_flight_legs_quarantine (ops_date);

revoke all on table reporting.canonical_flight_legs from public, anon, authenticated;
revoke all on table reporting.canonical_flight_legs_quarantine from public, anon, authenticated;
grant select on table reporting.canonical_flight_legs to service_role;
grant select on table reporting.canonical_flight_legs_quarantine to service_role;

-- 2. Create refresh function
create or replace function reporting.refresh_public_traffic_canonical_legs_v1()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_min_date date;
  v_max_date date;
begin
  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_public_traffic_canonical_bounds_v1() bounds;

  if v_min_date is null or v_max_date is null then
    truncate table reporting.canonical_flight_legs;
    truncate table reporting.canonical_flight_legs_quarantine;
    return;
  end if;

  create temp table tmp_new_canonical_slice on commit drop as
  with candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from reporting.get_public_traffic_candidate_slice_v1(v_min_date - 1, v_max_date + 1) candidates
  ), ranked_slice as (
    select candidates.*,
      count(*) over (partition by candidates.business_leg_key) as candidate_count,
      count(*) filter (where candidates.authoritative_server_seq is null)
        over (partition by candidates.business_leg_key) as missing_recency_count,
      count(*) filter (where candidates.authoritative_server_seq = candidates.max_authoritative_server_seq)
        over (partition by candidates.business_leg_key) as max_recency_count,
      row_number() over (
        partition by candidates.business_leg_key
        order by candidates.authoritative_server_seq desc nulls last, candidates.season_id, candidates.record_id
      ) as candidate_rank
    from candidate_slice candidates
  )
  select * from ranked_slice;

  create temp table tmp_new_canonical_legs on commit drop as
  select
    ranked.business_leg_key,
    ranked.ops_date,
    upper(btrim(ranked.type)) as type,
    upper(btrim(ranked.airline)) as airline,
    upper(btrim(ranked.flight_number)) as flight_number,
    upper(btrim(ranked.effective_route)) as route,
    coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
    case upper(btrim(coalesce(records.category, '')))
      when 'J' then 'J'
      else 'C'
    end as flight_category,
    ranked.effective_pax as pax,
    ranked.local_minutes,
    ranked.scheduled_local_at
  from tmp_new_canonical_slice ranked
  left join public.season_flight_records records
    on records.season_id = ranked.season_id and records.record_id = ranked.record_id
  where ranked.candidate_rank = 1
    and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1))
    and ranked.effective_action is distinct from 'deleted';

  create temp table tmp_new_quarantine on commit drop as
  select ops_date, candidate_count
  from tmp_new_canonical_slice
  where candidate_rank = 1
    and candidate_count > 1
    and (missing_recency_count > 0 or max_recency_count > 1);

  truncate table reporting.canonical_flight_legs;
  insert into reporting.canonical_flight_legs (
    business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
  )
  select * from tmp_new_canonical_legs;

  truncate table reporting.canonical_flight_legs_quarantine;
  insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
  select * from tmp_new_quarantine;
end;
$function$;

revoke execute on function reporting.refresh_public_traffic_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.refresh_public_traffic_canonical_legs_v1() to service_role;

-- 3. Populate tables immediately
select reporting.refresh_public_traffic_canonical_legs_v1();

commit;
