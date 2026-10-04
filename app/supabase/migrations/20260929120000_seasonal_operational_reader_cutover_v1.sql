-- M10. Additive controlled reader cutover migration.
--
-- Real controlled M10 reader cutover for Report/public canonical,
-- wallboard/dashboard publication, and AI reporting.flight_operations/summary consumers.
--
-- Principles:
-- 1. Opt-in gate (default OFF): legacy readers unchanged until explicit cutover.
-- 2. Refuses unsafe stale projection: checks is_fresh and watermarks under exclusive locks.
-- 3. Fences legacy writers during cutover: BEFORE triggers on base legacy tables.
-- 4. Native writes seen by public consumers: mirrors operational projection into canonical_flight_legs.
-- 5. Strict data-safe reverse: rejects reversal if native operational writes have occurred.
-- 6. Preserves complete existing reader/export contracts: 43 columns, exact types and order.
-- 7. Admin protection: cutover and reverse RPCs restricted to service_role.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- 1. Create cutover state table
create table if not exists reporting.operational_reader_cutover_state (
  singleton boolean primary key default true check (singleton),
  is_cutover boolean not null default false,
  cutover_at timestamp with time zone,
  cutover_by text,
  cutover_source_watermark bigint,
  cutover_operational_revision bigint,
  created_at timestamp with time zone not null default clock_timestamp(),
  updated_at timestamp with time zone not null default clock_timestamp()
);

revoke all on reporting.operational_reader_cutover_state from public, anon, authenticated;
grant select on reporting.operational_reader_cutover_state to authenticated, service_role;

insert into reporting.operational_reader_cutover_state (singleton, is_cutover)
values (true, false)
on conflict (singleton) do nothing;

-- 2. State inspection helper
create or replace function reporting.is_operational_reader_cutover_active_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
  select coalesce(state.is_cutover, false)
  from reporting.operational_reader_cutover_state state
  where state.singleton;
$$;

revoke execute on function reporting.is_operational_reader_cutover_active_v1() from public, anon;
grant execute on function reporting.is_operational_reader_cutover_active_v1() to authenticated, service_role;

-- 3. Programmatically capture legacy reporting.flight_operations and define operational_flight_operations_v1
-- matching the exact column count (37 on real staging/production, 43 on baseline local schema)
do $$
declare
  v_cols int;
  v_def text;
begin
  -- Capture existing legacy view definition if helper does not already exist
  if not exists (select 1 from pg_views where schemaname = 'reporting' and viewname = 'legacy_flight_operations_v1') then
    select pg_get_viewdef('reporting.flight_operations'::regclass, true) into v_def;
    execute 'create or replace view reporting.legacy_flight_operations_v1 as ' || v_def;
    execute 'alter view reporting.legacy_flight_operations_v1 set (security_invoker = true)';
  end if;
  -- Inspect column count
  select count(*) into v_cols
  from pg_attribute
  where attrelid = 'reporting.flight_operations'::regclass
    and attnum > 0 and not attisdropped;

  -- Define operational view matching exact column count
  if v_cols = 37 then
    execute $viewdef$
      create or replace view reporting.operational_flight_operations_v1 as
      select
        coalesce(l.source_season_id, '')::text as season_id,
        coalesce(s.season_code, '')::text as season,
        l.leg_id::text as record_id,
        coalesce(l.source_draft_id, '')::text as flight_series_id,
        l.turnaround_id::text as turnaround_id,
        (case l.side when 'ARR' then 'A' else 'D' end)::text as type,
        l.flight_number::text as flight,
        l.airline::text as airline,
        l.route::text as route,
        coalesce(rc.country, '')::text as country,
        l.aircraft_type::text as aircraft,
        coalesce(ag.ac_group, '')::text as ac_group,
        l.pax::integer as pax,
        (case when l.pax is null then 'missing' when l.pax = 0 then 'zero' else 'available' end)::text as pax_status,
        to_char(l.scheduled_date, 'YYYY-MM-DD')::text as scheduled_date,
        to_char(l.scheduled_time, 'HH24:MI')::text as scheduled_time,
        to_char(l.operational_date, 'YYYY-MM-DD')::text as ops_date,
        to_char(l.operational_date, 'YYYY-MM-DD')::text as operational_date,
        to_char(l.operational_date, 'YYYY-MM')::text as month,
        extract(week from l.operational_date)::integer as iso_week,
        extract(week from l.operational_date)::integer as weeknum,
        to_char(l.operational_date, 'IYYY-"W"IW')::text as isoweek,
        nullif(split_part(l.scheduled_time::text, ':', 1), '')::integer as local_hour,
        case
          when l.scheduled_time is null then null::integer
          else ((nullif(split_part(l.scheduled_time::text, ':', 1), '')::integer + 17) % 24)::integer
        end as utc_hour,
        case
          when l.scheduled_time is null then null::text
          else (lpad(split_part(l.scheduled_time::text, ':', 1), 2, '0') || ':' || case when coalesce(nullif(split_part(l.scheduled_time::text, ':', 2), '')::integer, 0) < 30 then '00' else '30' end)::text
        end as local_bucket_30,
        case
          when l.scheduled_time is null then null::text
          else (lpad(split_part(l.scheduled_time::text, ':', 1), 2, '0') || ':00')::text
        end as local_bucket_60,
        case
          when l.scheduled_time is null then null::text
          else (lpad(((nullif(split_part(l.scheduled_time::text, ':', 1), '')::integer + 17) % 24)::text, 2, '0') || ':' || case when coalesce(nullif(split_part(l.scheduled_time::text, ':', 2), '')::integer, 0) < 30 then '00' else '30' end)::text
        end as utc_bucket_30,
        case
          when l.scheduled_time is null then null::text
          else (lpad(((nullif(split_part(l.scheduled_time::text, ':', 1), '')::integer + 17) % 24)::text, 2, '0') || ':00')::text
        end as utc_bucket_60,
        extract(dow from l.operational_date)::integer as weekday,
        l.status::text as status,
        l.gate::integer as gate,
        l.stand::text as stand,
        l.carousel::integer as carousel,
        case l.source_type
          when 'seasonal_draft' then 'imported'
          when 'seasonal_publish' then 'imported'
          when 'daily_import' then 'imported'
          when 'operational_manual' then 'added'
          else coalesce(l.source_type, 'imported')
        end::text as source_kind,
        l.side::text as source_side,
        coalesce(s.season_code, '')::text as season_code,
        coalesce(s.season_code, '')::text as iata_season_code
      from public.operational_flight_legs l
      left join public.seasons s on s.id = l.source_season_id
      left join public.operational_route_countries rc on upper(rc.route) = upper(l.route)
      left join lateral (
        select coalesce(g.name, gt.group_id) as ac_group
        from public.operational_aircraft_group_types gt
        left join public.operational_aircraft_groups g on g.id = gt.group_id
        where upper(gt.aircraft_type) = upper(l.aircraft_type)
        order by g.name
        limit 1
      ) ag on true
      where l.status = 'active';
    $viewdef$;
  else
    execute $viewdef$
      create or replace view reporting.operational_flight_operations_v1 as
      with leg_base as (
        select
          legs.leg_id,
          legs.source_season_id,
          legs.turnaround_id,
          legs.side,
          legs.flight_number,
          legs.airline,
          legs.route,
          legs.aircraft_type,
          legs.pax,
          legs.scheduled_date,
          legs.scheduled_time,
          legs.operational_date,
          legs.status,
          legs.gate,
          legs.stand,
          legs.carousel,
          legs.source_type,
          (extract(hour from legs.scheduled_time)::integer * 60 + extract(minute from legs.scheduled_time)::integer)::integer as local_mins,
          (((extract(hour from legs.scheduled_time)::integer * 60 + extract(minute from legs.scheduled_time)::integer + 1020) % 1440))::integer as utc_mins,
          case
            when legs.scheduled_date is null or legs.scheduled_time is null then null::timestamp
            else legs.scheduled_date::timestamp + legs.scheduled_time
          end as scheduled_local_ts
        from public.operational_flight_legs legs
        where legs.status = 'active'
      ),
      bucketed_legs as (
        select
          lb.*,
          case when lb.local_mins is null then null::integer else (lb.local_mins / 30)::integer end as loc_b30,
          case when lb.local_mins is null then null::integer else (lb.local_mins / 60)::integer end as loc_b60,
          case when lb.utc_mins is null then null::integer else (lb.utc_mins / 30)::integer end as u_b30,
          case when lb.utc_mins is null then null::integer else (lb.utc_mins / 60)::integer end as u_b60
        from leg_base lb
      )
      select
        b.source_season_id::text as season_id,
        coalesce(s.season_code, '')::text as season,
        b.leg_id::text as record_id,
        null::text as flight_series_id,
        b.turnaround_id::text as turnaround_id,
        (case b.side when 'ARR' then 'A' else 'D' end)::text as type,
        coalesce(b.flight_number, '')::text as flight,
        coalesce(b.airline, '')::text as airline,
        coalesce(b.route, '')::text as route,
        coalesce(rc.country, '')::text as country,
        coalesce(b.aircraft_type, '')::text as aircraft,
        b.pax::integer as pax,
        to_char(b.scheduled_date, 'YYYY-MM-DD')::text as scheduled_date,
        to_char(b.scheduled_time, 'HH24:MI')::text as scheduled_time,
        to_char(b.operational_date, 'YYYY-MM-DD')::text as ops_date,
        to_char(b.operational_date, 'YYYY-MM')::text as month,
        extract(week from b.operational_date)::integer as iso_week,
        case when b.local_mins is null then null::integer else (b.local_mins / 60)::integer end as local_hour,
        case when b.utc_mins is null then null::integer else (b.utc_mins / 60)::integer end as utc_hour,
        extract(dow from b.operational_date)::integer as weekday,
        b.status::text as status,
        b.gate::integer as gate,
        b.stand::text as stand,
        b.carousel::integer as carousel,
        case b.source_type
          when 'seasonal_draft' then 'imported'
          when 'seasonal_publish' then 'imported'
          when 'daily_import' then 'imported'
          when 'operational_manual' then 'added'
          else coalesce(b.source_type, 'imported')
        end::text as source_kind,
        b.side::text as source_side,
        coalesce(s.season_code, '')::text as season_code,
        coalesce(s.season_code, '')::text as iata_season_code,
        to_char(b.operational_date, 'IYYY-"W"IW')::text as isoweek,
        extract(week from b.operational_date)::integer as weeknum,
        b.local_mins as local_minutes,
        b.utc_mins as utc_minutes,
        b.loc_b30 as local_bucket_30_index,
        case
          when b.loc_b30 is null then null::text
          else lpad(((b.loc_b30 * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.loc_b30 * 30) % 60)::text, 2, '0')
            || '-'
            || lpad(((((b.loc_b30 + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.loc_b30 + 1) * 30) % 1440) % 60)::text, 2, '0')
        end as local_bucket_30,
        b.loc_b60 as local_bucket_60_index,
        case
          when b.loc_b60 is null then null::text
          else lpad(((b.loc_b60 * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.loc_b60 * 60) % 60)::text, 2, '0')
            || '-'
            || lpad(((((b.loc_b60 + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.loc_b60 + 1) * 60) % 1440) % 60)::text, 2, '0')
        end as local_bucket_60,
        b.u_b30 as utc_bucket_30_index,
        case
          when b.u_b30 is null then null::text
          else lpad(((b.u_b30 * 30) / 60)::integer::text, 2, '0') || ':' || lpad(((b.u_b30 * 30) % 60)::text, 2, '0')
            || '-'
            || lpad(((((b.u_b30 + 1) * 30) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.u_b30 + 1) * 30) % 1440) % 60)::text, 2, '0')
        end as utc_bucket_30,
        b.u_b60 as utc_bucket_60_index,
        case
          when b.u_b60 is null then null::text
          else lpad(((b.u_b60 * 60) / 60)::integer::text, 2, '0') || ':' || lpad(((b.u_b60 * 60) % 60)::text, 2, '0')
            || '-'
            || lpad(((((b.u_b60 + 1) * 60) % 1440) / 60)::integer::text, 2, '0') || ':' || lpad(((((b.u_b60 + 1) * 60) % 1440) % 60)::text, 2, '0')
        end as utc_bucket_60,
        (
          coalesce(b.pax, 0) = 0
          and b.scheduled_local_ts is not null
          and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_ts + interval '1 day'
        ) as pax_missing_after_1_day,
        case
          when coalesce(b.pax, 0) > 0 then 'reported'::text
          when coalesce(b.pax, 0) = 0
            and b.scheduled_local_ts is not null
            and (now() at time zone 'Asia/Ho_Chi_Minh') >= b.scheduled_local_ts + interval '1 day'
            then 'missing_after_1_day'::text
          else 'planned_zero'::text
        end as pax_status,
        coalesce(ag.name, '') as ac_group
      from bucketed_legs b
      left join public.seasons s on s.id = b.source_season_id
      left join public.operational_route_countries rc on upper(rc.route) = upper(b.route)
      left join lateral (
        select g.name as name
        from public.operational_aircraft_group_types gt
        join public.operational_aircraft_groups g on g.id = gt.group_id
        where upper(gt.aircraft_type) = upper(b.aircraft_type)
        order by g.name
        limit 1
      ) ag on true;
    $viewdef$;
  end if;

  execute 'alter view reporting.operational_flight_operations_v1 set (security_invoker = true)';

  -- 4. Switch reporting.flight_operations conditionally on cutover
  execute $viewdef$
    create or replace view reporting.flight_operations as
    select * from reporting.legacy_flight_operations_v1
    where not reporting.is_operational_reader_cutover_active_v1()
    union all
    select * from reporting.operational_flight_operations_v1
    where reporting.is_operational_reader_cutover_active_v1();
  $viewdef$;

  execute 'alter view reporting.flight_operations set (security_invoker = true)';

  execute 'grant select on reporting.legacy_flight_operations_v1 to authenticated, service_role';
  execute 'grant select on reporting.operational_flight_operations_v1 to authenticated, service_role';
  execute 'grant select on reporting.flight_operations to authenticated, service_role';
  execute 'revoke all on reporting.legacy_flight_operations_v1 from public, anon';
  execute 'revoke all on reporting.operational_flight_operations_v1 from public, anon';
end;
$$;
-- 5. Bounds function: returns operational bounds when cutover is active
do $$
declare
  v_fn text;
begin
  if not exists (select 1 from pg_proc where proname = 'legacy_get_public_traffic_canonical_bounds_v1') then
    select pg_get_functiondef('reporting.get_public_traffic_canonical_bounds_v1'::regproc) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION reporting.get_public_traffic_canonical_bounds_v1', 'FUNCTION reporting.legacy_get_public_traffic_canonical_bounds_v1');
    execute v_fn;
  end if;
end;
$$;

revoke execute on function reporting.legacy_get_public_traffic_canonical_bounds_v1() from public, anon, authenticated;
grant execute on function reporting.legacy_get_public_traffic_canonical_bounds_v1() to service_role;

create or replace function reporting.get_public_traffic_canonical_bounds_v1()
returns table(min_ops_date date, max_ops_date date)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, reporting, extensions, pg_temp
as $$
begin
  if reporting.is_operational_reader_cutover_active_v1() then
    return query
    select min(legs.operational_date), max(legs.operational_date)
    from public.operational_flight_legs legs
    where legs.status = 'active';
  else
    return query
    select * from reporting.legacy_get_public_traffic_canonical_bounds_v1();
  end if;
end;
$$;

alter function reporting.get_public_traffic_canonical_bounds_v1() owner to postgres;
revoke execute on function reporting.get_public_traffic_canonical_bounds_v1() from public, anon, authenticated;
grant execute on function reporting.get_public_traffic_canonical_bounds_v1() to service_role;
-- 6. Refresh functions: worker mirrors operational canonical legs when cutover is active
create or replace function reporting.refresh_operational_canonical_legs_v1()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_min_date date;
  v_max_date date;
  v_watermark bigint;
  v_operational_revision bigint;
  v_observed bigint;
  v_leg_count integer;
  v_quarantine_count integer;
begin
  -- Single-flight lock preserved
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  select coalesce(max(events.server_seq), 0)::bigint into v_watermark
  from public.season_change_events events;
  select revision into v_operational_revision from public.operational_workspace_revision where singleton;

  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_operational_canonical_bounds_v1() bounds;

  if v_min_date is null or v_max_date is null then
    truncate table reporting.operational_canonical_flight_legs;
    truncate table reporting.operational_canonical_flight_legs_quarantine;

    insert into reporting.operational_canonical_flight_legs_state (
      singleton, refreshed_at, source_operational_revision, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
    ) values (true, now(), v_operational_revision, v_watermark, v_watermark, null, null, 0, 0)
    on conflict (singleton) do update
      set refreshed_at = excluded.refreshed_at,
          source_operational_revision = excluded.source_operational_revision,
          source_watermark = excluded.source_watermark,
          observed_watermark = excluded.observed_watermark,
          ops_min_date = excluded.ops_min_date,
          ops_max_date = excluded.ops_max_date,
          leg_count = excluded.leg_count,
          quarantine_count = excluded.quarantine_count;

    if reporting.is_operational_reader_cutover_active_v1() then
      truncate table reporting.canonical_flight_legs;
      truncate table reporting.canonical_flight_legs_quarantine;
    end if;

    return;
  end if;

  create temp table tmp_new_operational_slice on commit drop as
  with raw_candidates as materialized (
    select
      candidates.*,
      coalesce(legs.source_type = 'daily_import', false) as is_daily,
      coalesce(bool_or(legs.source_type = 'daily_import') over (partition by candidates.business_leg_key), false) as has_daily
    from reporting.get_operational_candidate_slice_v1(v_min_date - 1, v_max_date + 1) candidates
    left join public.operational_flight_legs legs
      on legs.leg_id::text = candidates.record_id
  ), eligible_slice as materialized (
    select
      raw.season_id,
      raw.record_id,
      raw.type,
      raw.airline,
      raw.flight_number,
      raw.route,
      raw.aircraft,
      raw.pax,
      raw.scheduled_date,
      raw.scheduled_time,
      raw.effective_route,
      raw.effective_aircraft,
      raw.effective_pax,
      raw.effective_action,
      raw.scheduled_date_value,
      raw.local_minutes,
      raw.authoritative_server_seq,
      raw.ops_date,
      raw.scheduled_local_at,
      raw.business_leg_key
    from raw_candidates raw
    where not raw.has_daily or raw.is_daily
  ), candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from eligible_slice candidates
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

  create temp table tmp_new_operational_legs on commit drop as
  select
    ranked.business_leg_key,
    ranked.ops_date,
    upper(btrim(ranked.type)) as type,
    upper(btrim(ranked.airline)) as airline,
    upper(btrim(ranked.flight_number)) as flight_number,
    coalesce(nullif(upper(btrim(ranked.effective_route)), ''), '') as route,
    coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
    case upper(btrim(coalesce(legs.flight_category, '')))
      when 'J' then 'J'
      else 'C'
    end as flight_category,
    ranked.effective_pax as pax,
    ranked.local_minutes,
    ranked.scheduled_local_at
  from tmp_new_operational_slice ranked
  left join public.operational_flight_legs legs
    on legs.leg_id::text = ranked.record_id
  where ranked.candidate_rank = 1
    and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1));

  create temp table tmp_new_operational_quarantine on commit drop as
  select distinct on (quarantine.business_leg_key)
    quarantine.business_leg_key,
    quarantine.ops_date,
    quarantine.candidate_count
  from (
    select 0 as source_rank, ledger.business_leg_key, ledger.ops_date, ledger.candidate_count
    from public.operational_leg_quarantine ledger
    where ledger.ops_date between v_min_date - 1 and v_max_date + 1

    union all

    select 1 as source_rank, candidates.business_leg_key, candidates.ops_date, candidates.candidate_count
    from tmp_new_operational_slice candidates
    where candidates.candidate_rank = 1
      and candidates.candidate_count > 1
      and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
  ) quarantine
  order by quarantine.business_leg_key, quarantine.source_rank;

  truncate table reporting.operational_canonical_flight_legs;
  insert into reporting.operational_canonical_flight_legs (
    business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
  )
  select * from tmp_new_operational_legs;

  truncate table reporting.operational_canonical_flight_legs_quarantine;
  insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
  select quarantine.ops_date, quarantine.candidate_count
  from tmp_new_operational_quarantine quarantine;

  select count(*)::integer into v_leg_count from reporting.operational_canonical_flight_legs;
  select count(*)::integer into v_quarantine_count from reporting.operational_canonical_flight_legs_quarantine;

  select coalesce(max(events.server_seq), 0)::bigint into v_observed
  from public.season_change_events events;

  insert into reporting.operational_canonical_flight_legs_state (
    singleton, refreshed_at, source_operational_revision, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
  ) values (true, now(), v_operational_revision, v_watermark, v_observed, v_min_date, v_max_date, v_leg_count, v_quarantine_count)
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at,
        source_operational_revision = excluded.source_operational_revision,
        source_watermark = excluded.source_watermark,
        observed_watermark = excluded.observed_watermark,
        ops_min_date = excluded.ops_min_date,
        ops_max_date = excluded.ops_max_date,
        leg_count = excluded.leg_count,
        quarantine_count = excluded.quarantine_count;

  -- When cutover is active, mirror operational canonical projection into public canonical tables
  if reporting.is_operational_reader_cutover_active_v1() then
    truncate table reporting.canonical_flight_legs;
    insert into reporting.canonical_flight_legs (
      business_leg_key, ops_date, type, airline, flight_number,
      route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
    )
    select * from reporting.operational_canonical_flight_legs;

    truncate table reporting.canonical_flight_legs_quarantine;
    insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
    select * from reporting.operational_canonical_flight_legs_quarantine;
  end if;
end;
$function$;

do $$
declare
  v_fn text;
begin
  if not exists (select 1 from pg_proc where proname = 'legacy_refresh_public_traffic_canonical_legs_v1') then
    select pg_get_functiondef('reporting.refresh_public_traffic_canonical_legs_v1'::regproc) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION reporting.refresh_public_traffic_canonical_legs_v1', 'FUNCTION reporting.legacy_refresh_public_traffic_canonical_legs_v1');
    execute v_fn;
  end if;
end;
$$;

revoke execute on function reporting.legacy_refresh_public_traffic_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.legacy_refresh_public_traffic_canonical_legs_v1() to service_role;

create or replace function reporting.refresh_public_traffic_canonical_legs_v1()
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
begin
  -- If cutover is active, delegate directly to the operational projection refresh
  if reporting.is_operational_reader_cutover_active_v1() then
    perform reporting.refresh_operational_canonical_legs_v1();
  else
    perform reporting.legacy_refresh_public_traffic_canonical_legs_v1();
  end if;
end;
$function$;

revoke execute on function reporting.refresh_public_traffic_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.refresh_public_traffic_canonical_legs_v1() to service_role;
-- 7. Accelerated get_public_traffic_report_v2: exact 662-line contract with cutover freshness gate and combined generation watermark
CREATE OR REPLACE FUNCTION public.get_public_traffic_report_v2(
  p_from_date date DEFAULT NULL::date,
  p_to_date date DEFAULT NULL::date,
  p_type text DEFAULT 'all'::text,
  p_airlines text[] DEFAULT ARRAY[]::text[],
  p_routes text[] DEFAULT ARRAY[]::text[],
  p_countries text[] DEFAULT ARRAY[]::text[],
  p_comparison text DEFAULT 'previous'::text,
  p_time_basis text DEFAULT 'local'::text,
  p_expected_watermark bigint DEFAULT NULL::bigint,
  p_contract_version text DEFAULT 'traffic-report-v2'::text,
  p_payload_scope text DEFAULT 'full'::text,
  p_data_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
declare
  v_data_as_of timestamptz := coalesce(p_data_as_of, statement_timestamp());
  v_source_watermark bigint;
  v_data_version integer;
  v_min_date date;
  v_max_date date;
  v_latest_completed date;
  v_from_date date;
  v_to_date date;
  v_comparison_from date;
  v_comparison_to date;
  v_scan_from date;
  v_scan_to date;
  v_day_count integer;
  v_type text := upper(btrim(coalesce(p_type, 'all')));
  v_airlines text[];
  v_routes text[];
  v_countries text[];
  v_normalized_filter jsonb;
  v_filter_hash text;
  v_result jsonb;
begin
  if p_contract_version <> 'traffic-report-v2' then
    raise exception 'unsupported contract_version' using errcode = '22023';
  end if;
  if p_payload_scope not in ('full', 'timeline', 'dimensions') then
    raise exception 'invalid payload_scope' using errcode = '22023';
  end if;
  if v_type not in ('ALL', 'A', 'D') then
    raise exception 'invalid type' using errcode = '22023';
  end if;
  if p_comparison not in ('previous', 'year_ago', 'none') then
    raise exception 'invalid comparison' using errcode = '22023';
  end if;
  if p_time_basis not in ('local', 'utc') then
    raise exception 'invalid time basis' using errcode = '22023';
  end if;
  if (p_from_date is null) <> (p_to_date is null) then
    raise exception 'from_date and to_date must be provided together' using errcode = '22023';
  end if;
  if cardinality(p_airlines) > 24 or cardinality(p_routes) > 24 or cardinality(p_countries) > 24 then
    raise exception 'filter cardinality exceeds 24' using errcode = '54000';
  end if;

  select coalesce(array_agg(value order by value), array[]::text[])
    into v_airlines
  from (select distinct upper(btrim(value)) as value from unnest(p_airlines) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_routes
  from (select distinct upper(btrim(value)) as value from unnest(p_routes) value where btrim(value) <> '') normalized;
  select coalesce(array_agg(value order by value), array[]::text[])
    into v_countries
  from (select distinct btrim(value) as value from unnest(p_countries) value where btrim(value) <> '') normalized;

  -- Cutover-aware watermark and freshness evaluation
  if reporting.is_operational_reader_cutover_active_v1() then
    declare
      v_is_fresh boolean;
      v_proj_source bigint;
      v_proj_curr bigint;
      v_curr_op_rev bigint;
    begin
      select status.is_fresh, status.source_watermark, status.current_watermark
        into v_is_fresh, v_proj_source, v_proj_curr
      from reporting.operational_projection_status_v1() status;

      if not coalesce(v_is_fresh, false) then
        raise exception 'STALE_OPERATIONAL_PROJECTION source=% current=%', v_proj_source, v_proj_curr
          using errcode = '40001';
      end if;

      select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
      -- Monotonic generation invariant: bigint sum of two monotonic non-decreasing counters
      -- (legacy max event server_seq + native operational_workspace_revision).
      -- Both counters are non-negative and non-decreasing; every legacy event or native
      -- operational workspace mutation strictly increases at least one counter while never
      -- moving backwards. This avoids artificial radix assumptions and overflow risks.
      v_source_watermark := coalesce(v_proj_source, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
      v_data_version := coalesce(v_curr_op_rev, 0)::integer;
    end;
  else
    select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
    from public.season_change_events events;
    select coalesce(max(seasons.data_version), 0)::integer into v_data_version
    from public.seasons seasons;
  end if;
  if p_expected_watermark is not null and p_expected_watermark is distinct from v_source_watermark then
    raise exception 'DATA_VERSION_CHANGED expected=% actual=%', p_expected_watermark, v_source_watermark
      using errcode = '40001';
  end if;

  v_latest_completed := ((v_data_as_of at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1;
  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_public_traffic_canonical_bounds_v1() bounds;
  if v_min_date is null or v_max_date is null then
    raise exception 'traffic report has no canonical effective operations' using errcode = 'P0002';
  end if;

  if p_from_date is null then
    v_from_date := greatest(v_min_date, make_date(extract(year from v_latest_completed)::integer, 1, 1));
    v_to_date := least(v_max_date, v_latest_completed);
  else
    v_from_date := p_from_date;
    v_to_date := p_to_date;
  end if;
  if v_from_date > v_to_date then
    raise exception 'from_date must not exceed to_date' using errcode = '22023';
  end if;
  v_day_count := v_to_date - v_from_date + 1;
  if v_day_count > 3660 then
    raise exception 'date range exceeds 3660 days' using errcode = '54000';
  end if;

  if p_comparison = 'previous' then
    v_comparison_to := v_from_date - 1;
    v_comparison_from := v_comparison_to - (v_day_count - 1);
  elsif p_comparison = 'year_ago' then
    v_comparison_from := v_from_date - interval '1 year';
    v_comparison_to := v_to_date - interval '1 year';
  end if;
  v_scan_from := least(v_from_date, coalesce(v_comparison_from, v_from_date));
  v_scan_to := greatest(v_to_date, coalesce(v_comparison_to, v_to_date));

  v_normalized_filter := jsonb_build_object(
    'from', v_from_date,
    'to', v_to_date,
    'type', case v_type when 'ALL' then 'all' else v_type end,
    'airline', to_jsonb(v_airlines),
    'route', to_jsonb(v_routes),
    'country', to_jsonb(v_countries),
    'comp', p_comparison,
    'tz', p_time_basis
  );
  v_filter_hash := encode(extensions.digest(convert_to(v_normalized_filter::text, 'UTF8'), 'sha256'), 'hex');

  with aircraft_map as materialized (
    select distinct on (upper(types.aircraft_type))
      upper(types.aircraft_type) as aircraft_type,
      groups.name as aircraft_group
    from public.operational_aircraft_group_types types
    join public.operational_aircraft_groups groups on groups.id = types.group_id
    order by upper(types.aircraft_type), groups.name
  ), canonical_rows as materialized (
    select
      legs.business_leg_key,
      legs.ops_date,
      legs.type,
      legs.airline,
      legs.flight_number,
      legs.route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      legs.aircraft_type,
      coalesce(nullif(btrim(aircraft_map.aircraft_group), ''), 'Unknown') as aircraft_group,
      legs.flight_category,
      legs.pax,
      legs.local_minutes,
      case when legs.local_minutes is null then null::integer
        else (legs.local_minutes + 1020) % 1440 end as utc_minutes,
      legs.scheduled_local_at,
      case
        when legs.pax is not null
          and legs.ops_date <= v_latest_completed
          and exists (
            select 1
            from reporting.public_traffic_coverage accepted_coverage
            where accepted_coverage.status = 'complete'
              and legs.ops_date between accepted_coverage.from_date and accepted_coverage.to_date
          )
          then true
        else legs.scheduled_local_at + interval '1 day'
          <= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')
      end as is_due
    from reporting.canonical_flight_legs legs
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(legs.route)
    left join aircraft_map on aircraft_map.aircraft_type = legs.aircraft_type
    where legs.ops_date between v_scan_from and v_scan_to
  ), live_rows as materialized (
    select rows.*
    from canonical_rows rows
    where (v_type = 'ALL' or rows.type = v_type)
      and (cardinality(v_airlines) = 0 or rows.airline = any(v_airlines))
      and (cardinality(v_routes) = 0 or rows.route = any(v_routes))
      and (cardinality(v_countries) = 0 or rows.country = any(v_countries))
  ), current_rows as materialized (
    select * from live_rows where ops_date between v_from_date and v_to_date
  ), comparison_rows as materialized (
    select * from live_rows
    where v_comparison_from is not null and ops_date between v_comparison_from and v_comparison_to
  ), current_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      case when count(*) filter (where type = 'A' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'A' and is_due and pax is not null)::bigint end as arrival_reported_pax,
      case when count(*) filter (where type = 'D' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'D' and is_due and pax is not null)::bigint end as departure_reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows
  ), comparison_metric as (
    select count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      case when count(*) filter (where type = 'A' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'A' and is_due and pax is not null)::bigint end as arrival_reported_pax,
      case when count(*) filter (where type = 'D' and is_due and pax is not null) > 0
        then sum(pax) filter (where type = 'D' and is_due and pax is not null)::bigint end as departure_reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from comparison_rows
  ), timeline_grouped as (
    select ops_date,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax,
      count(*) filter (where is_due and pax is not null)::integer as reported_legs,
      count(*) filter (where is_due)::integer as due_legs,
      count(*) filter (where is_due and pax is null)::integer as missing_due_legs,
      count(*) filter (where is_due and pax = 0)::integer as true_zero_reported_legs
    from current_rows group by ops_date
  ), timeline as (
    select spine.ops_date::date as ops_date,
      grouped.flights, grouped.arrivals, grouped.departures, grouped.reported_pax,
      grouped.reported_legs, grouped.due_legs, grouped.missing_due_legs,
      grouped.true_zero_reported_legs,
      coalesce((select ledger.status from reporting.public_traffic_coverage ledger
        where spine.ops_date::date between ledger.from_date and ledger.to_date and ledger.status <> 'excluded'
        order by ledger.certified_at desc nulls last, ledger.id desc limit 1),
        case when grouped.flights > 0 then 'partial' else 'missing' end) as coverage_status
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
    where p_payload_scope in ('full', 'timeline')
  ), current_coverage as (
    select bool_or(coverage_status in ('missing', 'partial')) as incomplete from timeline
  ), dimension_grouped as (
    select dimensions.dimension, dimensions.label,
      count(*)::integer as flights,
      count(*) filter (where rows.type = 'A')::integer as arrivals,
      count(*) filter (where rows.type = 'D')::integer as departures,
      case when count(*) filter (where rows.is_due and rows.pax is not null) > 0
        then sum(rows.pax) filter (where rows.is_due and rows.pax is not null)::bigint end as reported_pax,
      count(*) filter (where rows.is_due and rows.pax is not null)::integer as reported_legs,
      count(*) filter (where rows.is_due)::integer as due_legs,
      count(*) filter (where rows.is_due and rows.pax is null)::integer as missing_due_legs,
      count(*) filter (where rows.is_due and rows.pax = 0)::integer as true_zero_reported_legs
    from current_rows rows
    cross join lateral (values
      ('airline'::text, rows.airline),
      ('route'::text, rows.route),
      ('country'::text, rows.country),
      ('aircraft_group'::text, rows.aircraft_group),
      ('flight_category'::text, rows.flight_category)
    ) dimensions(dimension, label)
    where p_payload_scope in ('full', 'dimensions')
    group by dimensions.dimension, dimensions.label
  ), dimension_totals as (
    select dimension, sum(flights)::numeric as flights,
      sum(reported_pax) filter (where reported_pax is not null)::numeric as reported_pax
    from dimension_grouped group by dimension
  ), dimension_rows as (
    select grouped.*,
      grouped.flights::numeric / nullif(totals.flights, 0) as flight_share,
      grouped.reported_pax::numeric / nullif(totals.reported_pax, 0) as pax_share,
      row_number() over (partition by grouped.dimension order by grouped.flights desc, grouped.label) as row_rank
    from dimension_grouped grouped join dimension_totals totals using (dimension)
  ), filter_options as (
    select
      (coalesce(array_agg(distinct airline order by airline)
        filter (where airline <> ''), array[]::text[]))[1:250] as airlines,
      (coalesce(array_agg(distinct route order by route)
        filter (where route <> ''), array[]::text[]))[1:250] as routes,
      (coalesce(array_agg(distinct country order by country)
        filter (where country <> ''), array[]::text[]))[1:250] as countries
    from canonical_rows
    where p_payload_scope = 'full'
      and ops_date between v_from_date and v_to_date
  ), peak_day as (
    select ops_date, flights
    from timeline_grouped
    where p_payload_scope = 'full'
    order by flights desc, ops_date
    limit 1
  ), quality_metric as (
    select
      count(*) filter (where country = 'Unknown')::integer as unknown_country_legs,
      count(*) filter (where is_due and pax is null)::integer as pax_due_missing_legs
    from current_rows
    where p_payload_scope = 'full'
  ), quarantine_metric as (
    select coalesce(sum(candidate_count), 0)::integer as quarantined_candidates
    from reporting.canonical_flight_legs_quarantine
    where p_payload_scope = 'full'
      and ops_date between v_from_date and v_to_date
  ), daily_operations as (
    select spine.ops_date::date as ops_date,
      extract(isodow from spine.ops_date)::integer as day_index,
      coalesce(grouped.flights, 0)::integer as flights,
      coalesce(grouped.arrivals, 0)::integer as arrivals,
      coalesce(grouped.departures, 0)::integer as departures
    from generate_series(v_from_date, v_to_date, interval '1 day') spine(ops_date)
    left join timeline_grouped grouped on grouped.ops_date = spine.ops_date::date
    where p_payload_scope = 'full'
  ), day_of_week_grouped as (
    select day_index,
      count(*)::integer as calendar_days,
      sum(flights)::integer as total_flights,
      round(avg(flights), 2) as average_flights,
      min(flights)::integer as min_flights,
      max(flights)::integer as max_flights,
      sum(arrivals)::integer as arrivals,
      sum(departures)::integer as departures
    from daily_operations
    group by day_index
  ), day_of_week_rows as (
    select day_index,
      coalesce(grouped.calendar_days, 0)::integer as calendar_days,
      coalesce(grouped.total_flights, 0)::integer as total_flights,
      coalesce(grouped.average_flights, 0)::numeric as average_flights,
      coalesce(grouped.min_flights, 0)::integer as min_flights,
      coalesce(grouped.max_flights, 0)::integer as max_flights,
      coalesce(grouped.arrivals, 0)::integer as arrivals,
      coalesce(grouped.departures, 0)::integer as departures
    from generate_series(1, 7) day_index
    left join day_of_week_grouped grouped using (day_index)
  ), hour_counts as (
    select case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as bucket_index,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures
    from current_rows
    where p_payload_scope = 'full'
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
    group by case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end
  ), flight_occurrences as (
    select
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as bucket_index,
      case when p_time_basis = 'utc' then utc_minutes else local_minutes end as scheduled_minutes,
      type, airline, flight_number, route, ops_date,
      extract(isodow from ops_date)::integer as day_index
    from current_rows
    where p_payload_scope = 'full'
      and flight_number <> ''
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
  ), flight_weekday_stats as (
    select bucket_index, type, airline, flight_number, route, day_index,
      count(distinct ops_date)::integer as occurrence_days,
      (((max(ops_date) - min(ops_date)) / 7) + 1)::integer as eligible_days
    from flight_occurrences
    group by bucket_index, type, airline, flight_number, route, day_index
  ), qualifying_flight_weekdays as (
    select * from flight_weekday_stats
    where occurrence_days >= 4 and eligible_days >= 4
      and occurrence_days::numeric / nullif(eligible_days, 0) >= 0.70
  ), regular_flight_groups as (
    select bucket_index, type, airline, flight_number, route,
      array_agg(day_index order by day_index)::integer[] as operating_days,
      sum(occurrence_days)::integer as occurrence_days,
      sum(eligible_days)::integer as eligible_days,
      round(sum(occurrence_days) * 100.0 / nullif(sum(eligible_days), 0), 0)::integer as consistency_percent
    from qualifying_flight_weekdays
    group by bucket_index, type, airline, flight_number, route
  ), flight_time_counts as (
    select bucket_index, type, airline, flight_number, route, scheduled_minutes,
      count(distinct ops_date)::integer as occurrence_days
    from flight_occurrences
    group by bucket_index, type, airline, flight_number, route, scheduled_minutes
  ), typical_times as (
    select distinct on (bucket_index, type, airline, flight_number, route)
      bucket_index, type, airline, flight_number, route, scheduled_minutes
    from flight_time_counts
    order by bucket_index, type, airline, flight_number, route, occurrence_days desc, scheduled_minutes
  ), regular_flight_json as (
    select groups.bucket_index, groups.type,
      jsonb_agg(jsonb_build_object(
        'airline', groups.airline,
        'flight_number', groups.flight_number,
        'route', groups.route,
        'typical_time', lpad((times.scheduled_minutes / 60)::text, 2, '0') || ':'
          || lpad((times.scheduled_minutes % 60)::text, 2, '0'),
        'operating_days', to_jsonb(groups.operating_days),
        'occurrence_days', groups.occurrence_days,
        'eligible_days', groups.eligible_days,
        'consistency_percent', groups.consistency_percent
      ) order by times.scheduled_minutes, groups.airline, groups.flight_number, groups.route) as rows
    from regular_flight_groups groups
    join typical_times times using (bucket_index, type, airline, flight_number, route)
    group by groups.bucket_index, groups.type
  ), hour_rows as (
    select series.bucket_index,
      coalesce(counts.arrivals, 0)::integer as arrivals,
      coalesce(counts.departures, 0)::integer as departures,
      coalesce(arrivals.rows, '[]'::jsonb) as arrival_regular_flights,
      coalesce(departures.rows, '[]'::jsonb) as departure_regular_flights
    from generate_series(0, 23) series(bucket_index)
    left join hour_counts counts using (bucket_index)
    left join regular_flight_json arrivals
      on arrivals.bucket_index = series.bucket_index and arrivals.type = 'A'
    left join regular_flight_json departures
      on departures.bucket_index = series.bucket_index and departures.type = 'D'
  ), monthly_hour_counts as (
    select date_trunc('month', ops_date)::date as month_start, type,
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end as hour_index,
      count(*)::integer as flights
    from current_rows
    where p_payload_scope = 'full'
      and type in ('A', 'D')
      and case when p_time_basis = 'utc' then utc_minutes else local_minutes end is not null
    group by date_trunc('month', ops_date)::date, type,
      case when p_time_basis = 'utc' then utc_minutes / 60 else local_minutes / 60 end
  ), monthly_hour_ranked as (
    select counts.*,
      row_number() over (partition by month_start, type order by flights desc, hour_index) as row_rank
    from monthly_hour_counts counts
  ), report_months as (
    select generate_series(date_trunc('month', v_from_date::timestamp),
      date_trunc('month', v_to_date::timestamp), interval '1 month')::date as month_start
  ), aircraft_type_grouped as (
    select aircraft_group, aircraft_type,
      count(*)::integer as flights,
      count(*) filter (where type = 'A')::integer as arrivals,
      count(*) filter (where type = 'D')::integer as departures,
      case when count(*) filter (where is_due and pax is not null) > 0
        then sum(pax) filter (where is_due and pax is not null)::bigint end as reported_pax
    from current_rows
    where p_payload_scope = 'full'
    group by aircraft_group, aircraft_type
  ), aircraft_type_totals as (
    select sum(flights)::numeric as flights,
      sum(reported_pax) filter (where reported_pax is not null)::numeric as reported_pax
    from aircraft_type_grouped
  ), coverage_summary as (
    select count(*)::integer as selected_day_count,
      count(*) filter (where coverage_status not in ('missing', 'partial'))::integer as covered_day_count,
      count(*) filter (where coverage_status = 'partial')::integer as partial_day_count,
      count(*) filter (where coverage_status = 'missing')::integer as missing_day_count
    from timeline
    where p_payload_scope = 'full'
  ), coverage_counts as (
    select
      count(distinct route) filter (where route is not null and route <> '')::integer as routes,
      count(distinct airline) filter (where airline is not null and airline <> '')::integer as airlines,
      count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as countries
    from current_rows
    where p_payload_scope = 'full'
  )
  select jsonb_build_object(
    'contract_version', 'traffic-report-v2',
    'data_as_of', v_data_as_of,
    'source_watermark', v_source_watermark,
    'data_version', v_data_version,
    'filter_hash', v_filter_hash,
    'source_mode', 'live',
    'normalized_filter', v_normalized_filter,
    'current', (select jsonb_build_object(
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'arrival_reported_pax', metric.arrival_reported_pax,
      'departure_reported_pax', metric.departure_reported_pax,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero'
        when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 or coverage.incomplete then 'partial'
        else 'complete' end
    ) from current_metric metric cross join current_coverage coverage),
    'comparison', (select jsonb_build_object(
      'from', v_comparison_from, 'to', v_comparison_to,
      'flights', metric.flights, 'arrivals', metric.arrivals, 'departures', metric.departures,
      'reported_pax', metric.reported_pax, 'reported_legs', metric.reported_legs,
      'arrival_reported_pax', metric.arrival_reported_pax,
      'departure_reported_pax', metric.departure_reported_pax,
      'due_legs', metric.due_legs, 'missing_due_legs', metric.missing_due_legs,
      'true_zero_reported_legs', metric.true_zero_reported_legs,
      'status', case when metric.flights = 0 then 'zero' when metric.due_legs = 0 then 'future'
        when metric.missing_due_legs > 0 then 'partial' else 'complete' end
    ) from comparison_metric metric),
    'timeline', coalesce((select jsonb_agg(jsonb_build_object(
      'ops_date', ops_date,
      'flights', case when coverage_status = 'missing' and flights is null then null else coalesce(flights, 0) end,
      'arrivals', case when coverage_status = 'missing' and flights is null then null else coalesce(arrivals, 0) end,
      'departures', case when coverage_status = 'missing' and flights is null then null else coalesce(departures, 0) end,
      'reported_pax', reported_pax,
      'reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(reported_legs, 0) end,
      'due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(due_legs, 0) end,
      'missing_due_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(missing_due_legs, 0) end,
      'true_zero_reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(true_zero_reported_legs, 0) end,
      'completeness', coverage_status,
      'status', case when ops_date > v_latest_completed then 'future'
        when coverage_status = 'missing' then 'missing'
        when coverage_status = 'partial' or missing_due_legs > 0 then 'partial'
        when coalesce(flights, 0) = 0 then 'zero' else 'complete' end
    ) order by ops_date) from timeline), '[]'::jsonb),
    'dimensions', jsonb_build_object(
      'airline', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'airline' and row_rank <= 732), '[]'::jsonb),
      'route', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'route' and row_rank <= 732), '[]'::jsonb),
      'country', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'key', lower(label), 'label', label,
        'flights', flights, 'arrivals', arrivals, 'departures', departures,
        'reported_pax', reported_pax, 'reported_legs', reported_legs, 'due_legs', due_legs,
        'missing_due_legs', missing_due_legs, 'true_zero_reported_legs', true_zero_reported_legs,
        'flight_share', flight_share, 'pax_share', pax_share,
        'status', case when due_legs = 0 then 'future' when missing_due_legs > 0 then 'partial' else 'complete' end
      ) order by row_rank) from dimension_rows where dimension = 'country' and row_rank <= 732), '[]'::jsonb)
    ),
    'report', jsonb_build_object(
      'min_ops_date', v_min_date,
      'max_ops_date', v_max_date,
      'latest_completed_ops_date', least(v_max_date, v_latest_completed),
      'day_count', v_day_count,
      'filter_options', (select jsonb_build_object(
        'airline', to_jsonb(airlines),
        'route', to_jsonb(routes),
        'country', to_jsonb(countries)
      ) from filter_options),
      'coverage', (select jsonb_build_object(
        'selected_day_count', selected_day_count,
        'covered_day_count', covered_day_count,
        'partial_day_count', partial_day_count,
        'missing_day_count', missing_day_count
      ) from coverage_summary),
      'peak_day', (select jsonb_build_object(
        'ops_date', peak_day.ops_date,
        'flights', peak_day.flights,
        'status', case when peak_day.ops_date is null then 'unavailable' else 'available' end
      ) from (select 1) seed left join peak_day on true),
      'pax_coverage', (select jsonb_build_object(
        'reported_legs', metric.reported_legs,
        'due_legs', metric.due_legs,
        'percent', case when metric.due_legs > 0
          then round(metric.reported_legs * 100.0 / metric.due_legs, 1) end,
        'status', case when metric.due_legs > 0 then 'available' else 'unavailable' end
      ) from current_metric metric),
      'coverage_counts', (select jsonb_build_object(
        'routes', coverage.routes,
        'airlines', coverage.airlines,
        'countries', coverage.countries
      ) from coverage_counts coverage),
      'quality', (select jsonb_build_object(
        'unknown_country_legs', quality.unknown_country_legs,
        'pax_due_missing_legs', quality.pax_due_missing_legs,
        'quarantined_duplicate_candidates', quarantine.quarantined_candidates
      ) from quality_metric quality cross join quarantine_metric quarantine),
      'breakdowns', jsonb_build_object(
        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
          'key', case label
            when 'J' then 'scheduled'
            else 'charter'
          end,
          'code', label,
          'label', case label
            when 'J' then 'Thường lệ'
            else 'Không thường lệ'
          end,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by case label when 'J' then 1 else 2 end) from dimension_rows
          where dimension = 'flight_category'), '[]'::jsonb),
        'aircraft_group', coalesce((select jsonb_agg(jsonb_build_object(
          'key', lower(replace(label, ' ', '-')),
          'label', label,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by row_rank) from dimension_rows
          where dimension = 'aircraft_group' and row_rank <= 50), '[]'::jsonb),
        'aircraft_type', coalesce((select jsonb_agg(jsonb_build_object(
          'key', lower(replace(grouped.aircraft_group || '-' || grouped.aircraft_type, ' ', '-')),
          'label', grouped.aircraft_type,
          'aircraft_group_key', lower(replace(grouped.aircraft_group, ' ', '-')),
          'aircraft_group', grouped.aircraft_group,
          'flights', grouped.flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', grouped.reported_pax,
          'share', grouped.flights::numeric / nullif(totals.flights, 0),
          'suppressed', false
        ) order by grouped.flights desc, grouped.aircraft_group, grouped.aircraft_type)
          from aircraft_type_grouped grouped cross join aircraft_type_totals totals), '[]'::jsonb),
        'peak_hour', coalesce((select jsonb_agg(jsonb_build_object(
          'hour_bucket', lpad(bucket_index::text, 2, '0') || ':00',
          'bucket_minutes', 60,
          'time_basis', p_time_basis,
          'arrivals', arrivals,
          'departures', departures,
          'regular_flights', jsonb_build_object(
            'arrivals', arrival_regular_flights,
            'departures', departure_regular_flights
          ),
          'suppressed', false
        ) order by bucket_index) from hour_rows), '[]'::jsonb),
        'peak_hour_monthly', coalesce((select jsonb_agg(jsonb_build_object(
          'month', to_char(months.month_start, 'YYYY-MM'),
          'time_basis', p_time_basis,
          'arrival_hour', case when arrivals.hour_index is null then null
            else lpad(arrivals.hour_index::text, 2, '0') || ':00' end,
          'arrival_flights', arrivals.flights,
          'departure_hour', case when departures.hour_index is null then null
            else lpad(departures.hour_index::text, 2, '0') || ':00' end,
          'departure_flights', departures.flights,
          'arrival_suppressed', false,
          'departure_suppressed', false
        ) order by months.month_start)
          from report_months months
          left join monthly_hour_ranked arrivals
            on arrivals.month_start = months.month_start and arrivals.type = 'A' and arrivals.row_rank = 1
          left join monthly_hour_ranked departures
            on departures.month_start = months.month_start and departures.type = 'D' and departures.row_rank = 1), '[]'::jsonb),
        'day_of_week', coalesce((select jsonb_agg(jsonb_build_object(
          'day_index', day_index,
          'calendar_days', calendar_days,
          'total_flights', total_flights,
          'average_flights', average_flights,
          'min_flights', min_flights,
          'max_flights', max_flights,
          'arrivals', arrivals,
          'departures', departures,
          'suppressed', false
        ) order by day_index) from day_of_week_rows), '[]'::jsonb)
      )
    )
  ) into v_result;

  return v_result;
end;
$function$;

-- 8. Fencing triggers on base legacy writer tables
create or replace function reporting.guard_legacy_writer_during_cutover_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
begin
  if reporting.is_operational_reader_cutover_active_v1() then
    if TG_TABLE_NAME = 'daily_schedule_import_batches' then
      if TG_OP = 'INSERT' then
        if NEW.contract_version = 2 then
          return NEW;
        end if;
      elsif TG_OP = 'UPDATE' then
        if OLD.contract_version = 2 and NEW.contract_version = 2 then
          return NEW;
        end if;
      elsif TG_OP = 'DELETE' then
        if OLD.contract_version = 2 then
          return OLD;
        end if;
      end if;
    end if;

    raise exception 'Legacy writer is fenced: M10 operational reader cutover is active. Operation % on % is rejected.', TG_OP, TG_TABLE_NAME
      using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists guard_legacy_writer_cutover on public.season_flight_records;
create trigger guard_legacy_writer_cutover
before insert or update or delete on public.season_flight_records
for each row execute function reporting.guard_legacy_writer_during_cutover_v1();

drop trigger if exists guard_legacy_writer_cutover on public.season_modifications;
create trigger guard_legacy_writer_cutover
before insert or update or delete on public.season_modifications
for each row execute function reporting.guard_legacy_writer_during_cutover_v1();

drop trigger if exists guard_legacy_writer_cutover on public.season_modification_added_legs;
create trigger guard_legacy_writer_cutover
before insert or update or delete on public.season_modification_added_legs
for each row execute function reporting.guard_legacy_writer_during_cutover_v1();

drop trigger if exists guard_legacy_writer_cutover on public.schedule_replacement_scopes;
create trigger guard_legacy_writer_cutover
before insert or update or delete on public.schedule_replacement_scopes
for each row execute function reporting.guard_legacy_writer_during_cutover_v1();

drop trigger if exists guard_legacy_writer_cutover on public.daily_schedule_import_batches;
create trigger guard_legacy_writer_cutover
before insert or update or delete on public.daily_schedule_import_batches
for each row execute function reporting.guard_legacy_writer_during_cutover_v1();

-- 9. Cutover execution RPC (service_role only, under exclusive table locks)
create or replace function reporting.cutover_operational_readers_v1(
  p_operator text default 'system'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_is_fresh boolean;
  v_source_watermark bigint;
  v_current_watermark bigint;
  v_current_rev bigint;
  v_result jsonb;
begin
  set local lock_timeout = '15s';

  -- 1. Lock global operational workspace revision row and table first (same order as native RPCs)
  select revision into v_current_rev
  from public.operational_workspace_revision
  where singleton
  for update;
  lock table public.operational_workspace_revision in exclusive mode;

  -- 2. Lock all legacy writer tables in deterministic order (records before events)
  lock table public.season_flight_records in exclusive mode;
  lock table public.season_modifications in exclusive mode;
  lock table public.season_modification_added_legs in exclusive mode;
  lock table public.schedule_replacement_scopes in exclusive mode;
  lock table public.daily_schedule_import_batches in exclusive mode;
  lock table public.season_change_events in exclusive mode;

  -- 3. Lock native operational tables
  lock table public.operational_flight_legs in exclusive mode;

  -- 4. Advisory projection lock FIRST before projection-state/canonical table locks to prevent deadlocks with worker
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  -- 5. Lock projection state and canonical tables
  lock table reporting.operational_canonical_flight_legs_state in exclusive mode;
  lock table reporting.canonical_flight_legs in exclusive mode;
  lock table reporting.canonical_flight_legs_quarantine in exclusive mode;
  lock table reporting.operational_reader_cutover_state in exclusive mode;
  if (select is_cutover from reporting.operational_reader_cutover_state where singleton) then
    return jsonb_build_object(
      'status', 'already_cutover',
      'cutover_at', (select cutover_at from reporting.operational_reader_cutover_state where singleton)
    );
  end if;

  -- 2. Validate operational projection freshness under lock
  select status.is_fresh, status.source_watermark, status.current_watermark
    into v_is_fresh, v_source_watermark, v_current_watermark
  from reporting.operational_projection_status_v1() status;

  if not coalesce(v_is_fresh, false) then
    raise exception 'Cannot cut over: operational projection is stale (source_watermark=%, current_watermark=%). Run refresh before cutover.',
      v_source_watermark, v_current_watermark
      using errcode = '55000';
  end if;

  -- 3. Mirror operational canonical projection into public canonical tables
  truncate table reporting.canonical_flight_legs;
  insert into reporting.canonical_flight_legs (
    business_leg_key, ops_date, type, airline, flight_number,
    route, aircraft_type, flight_category, pax, local_minutes, scheduled_local_at
  )
  select * from reporting.operational_canonical_flight_legs;

  truncate table reporting.canonical_flight_legs_quarantine;
  insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
  select * from reporting.operational_canonical_flight_legs_quarantine;

  -- 4. Record cutover state and current operational workspace revision
  select revision into v_current_rev from public.operational_workspace_revision where singleton;

  update reporting.operational_reader_cutover_state
  set is_cutover = true,
      cutover_at = clock_timestamp(),
      cutover_by = coalesce(p_operator, 'system'),
      cutover_source_watermark = v_source_watermark,
      cutover_operational_revision = v_current_rev,
      updated_at = clock_timestamp()
  where singleton;

  v_result := jsonb_build_object(
    'status', 'cutover_success',
    'cutover_at', clock_timestamp(),
    'source_watermark', v_source_watermark,
    'operational_revision', v_current_rev,
    'operator', coalesce(p_operator, 'system')
  );

  return v_result;
end;
$$;

revoke execute on function reporting.cutover_operational_readers_v1(text) from public, anon, authenticated;
grant execute on function reporting.cutover_operational_readers_v1(text) to service_role;

-- 10. Strict data-safe reverse RPC (service_role only, no blind force override)
create or replace function reporting.reverse_operational_readers_v1(
  p_reason text,
  p_operator text default 'system'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_cutover_rev bigint;
  v_curr_rev bigint;
  v_result jsonb;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Reversal reason must be provided' using errcode = '22023';
  end if;
  set local lock_timeout = '15s';

  -- 1. Lock global operational workspace revision row and table first (same order as native RPCs)
  select revision into v_curr_rev
  from public.operational_workspace_revision
  where singleton
  for update;
  lock table public.operational_workspace_revision in exclusive mode;

  -- 2. Lock all legacy writer tables in deterministic order (records before events)
  lock table public.season_flight_records in exclusive mode;
  lock table public.season_modifications in exclusive mode;
  lock table public.season_modification_added_legs in exclusive mode;
  lock table public.schedule_replacement_scopes in exclusive mode;
  lock table public.daily_schedule_import_batches in exclusive mode;
  lock table public.season_change_events in exclusive mode;

  -- 3. Lock native operational tables
  lock table public.operational_flight_legs in exclusive mode;

  -- 4. Advisory projection lock FIRST before projection-state/canonical table locks
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  -- 5. Lock projection state and canonical tables
  lock table reporting.operational_canonical_flight_legs_state in exclusive mode;
  lock table reporting.canonical_flight_legs in exclusive mode;
  lock table reporting.canonical_flight_legs_quarantine in exclusive mode;
  lock table reporting.operational_reader_cutover_state in exclusive mode;
  if not (select is_cutover from reporting.operational_reader_cutover_state where singleton) then
    return jsonb_build_object('status', 'not_cutover');
  end if;

  -- Verify data safety: refuse if native operational mutations occurred post-cutover
  select cutover_operational_revision into v_cutover_rev
  from reporting.operational_reader_cutover_state where singleton;

  select revision into v_curr_rev from public.operational_workspace_revision where singleton;

  if v_cutover_rev is not null and v_curr_rev > v_cutover_rev then
    raise exception 'Cannot reverse cutover: operational mutations have occurred since cutover (cutover revision %, current revision %). Reversal would destroy operational data.',
      v_cutover_rev, v_curr_rev
      using errcode = '55000';
  end if;
  -- Revert cutover state
  update reporting.operational_reader_cutover_state
  set is_cutover = false,
      cutover_at = null,
      cutover_by = null,
      cutover_source_watermark = null,
      cutover_operational_revision = null,
      updated_at = clock_timestamp()
  where singleton;

  -- Re-populate canonical flight legs from legacy store
  perform reporting.refresh_public_traffic_canonical_legs_v1();

  v_result := jsonb_build_object(
    'status', 'reversed',
    'reversed_at', clock_timestamp(),
    'reason', p_reason,
    'operator', coalesce(p_operator, 'system')
  );

  return v_result;
end;
$$;

revoke execute on function reporting.reverse_operational_readers_v1(text, text) from public, anon, authenticated;
grant execute on function reporting.reverse_operational_readers_v1(text, text) to service_role;

-- 11. Wallboard & Annual Passenger KPI Cutover Integration
-- 11.1 Capture M5 Daily V2 commit into reporting.public_traffic_coverage
create or replace function reporting.capture_operational_daily_acceptance_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_source_key text;
begin
  if new.target_type = 'dailyAuthority' and new.changed_fields = array['daily_import'] then
    v_source_key := 'daily-v2:' || new.operational_date::text || ':' || coalesce(new.request_id::text, new.server_seq::text);
    insert into reporting.public_traffic_coverage(
      from_date, to_date, status, season_code, source_batch_id, reason_code, certified_at, certified_by
    ) values (
      new.operational_date, new.operational_date, 'complete', '', v_source_key,
      'daily-v2-import-commit', statement_timestamp(), coalesce(new.actor_id::text, 'daily-v2-import-commit')
    ) on conflict (source_batch_id) where source_batch_id is not null do nothing;

    perform pg_notify('public_dashboard_daily_wake', 'daily-v2-import-committed');
  end if;
  return new;
end;
$$;

revoke all on function reporting.capture_operational_daily_acceptance_v1() from public, anon, authenticated, service_role;

drop trigger if exists capture_operational_daily_acceptance on public.operational_change_events;
create trigger capture_operational_daily_acceptance
after insert on public.operational_change_events
for each row
when (new.target_type = 'dailyAuthority' and new.changed_fields = array['daily_import'])
execute function reporting.capture_operational_daily_acceptance_v1();
-- 11.1 Capture legacy helper definitions for KPI, candidate selector, and publisher functions
do $$
declare
  v_fn text;
begin
  if not exists (select 1 from pg_proc where proname = 'legacy_get_public_annual_passenger_kpi_version_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_public_annual_passenger_kpi_version_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?get_public_annual_passenger_kpi_version_v1\(', 'FUNCTION reporting.legacy_get_public_annual_passenger_kpi_version_v1(', 'i');
      execute v_fn;
    end if;
  end if;

  if not exists (select 1 from pg_proc where proname = 'legacy_get_public_annual_passenger_kpi_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_public_annual_passenger_kpi_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?get_public_annual_passenger_kpi_v1\(', 'FUNCTION reporting.legacy_get_public_annual_passenger_kpi_v1(', 'i');
      execute v_fn;
    end if;
  end if;

  if not exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_candidate_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'select_public_dashboard_candidate_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?select_public_dashboard_candidate_v1\(', 'FUNCTION reporting.legacy_select_public_dashboard_candidate_v1(', 'i');
      execute v_fn;
    end if;
  end if;

  if not exists (select 1 from pg_proc where proname = 'legacy_publish_public_dashboard_daily_v1') then
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'publish_public_dashboard_daily_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(v_fn, 'FUNCTION\s+([a-zA-Z_0-9]+\.)?publish_public_dashboard_daily_v1\(', 'FUNCTION reporting.legacy_publish_public_dashboard_daily_v1(', 'i');
      execute v_fn;
    end if;
  end if;
end;
$$;

-- 11.2 get_public_annual_passenger_kpi_version_v1 with operational freshness under cutover
create or replace function public.get_public_annual_passenger_kpi_version_v1(
  p_year integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
declare
  v_kpi reporting.annual_passenger_kpis%rowtype;
  v_op_status record;
  v_curr_op_rev bigint;
begin
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_get_public_annual_passenger_kpi_version_v1(p_year);
  end if;

  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;

  select * into v_kpi
  from reporting.annual_passenger_kpis
  where year = p_year;

  select * into v_op_status from reporting.operational_projection_status_v1();
  select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
  return jsonb_build_object(
    'year', p_year,
    'target_reported_pax', v_kpi.target_reported_pax,
    'kpi_updated_at', v_kpi.updated_at,
    'projection_status', case when coalesce(v_op_status.is_fresh, false) then 'fresh' else 'stale' end,
    'source_data_version', coalesce(v_curr_op_rev, 0)::integer,
    'source_watermark', coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint,
    'refreshed_at', v_op_status.refreshed_at
  );
end;
$$;

revoke execute on function public.get_public_annual_passenger_kpi_version_v1(integer) from public, anon, authenticated;
grant execute on function public.get_public_annual_passenger_kpi_version_v1(integer) to service_role;

-- 11.3 get_public_annual_passenger_kpi_v1 with canonical store under cutover
create or replace function public.get_public_annual_passenger_kpi_v1(
  p_year integer,
  p_today date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_today date := coalesce(p_today, (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_year_start date;
  v_year_end date;
  v_period_end date;
  v_period_state text;
  v_kpi reporting.annual_passenger_kpis%rowtype;
  v_projection jsonb;
  v_target bigint;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_due_legs integer := 0;
  v_reported_legs integer := 0;
  v_arrival_reported_legs integer := 0;
  v_departure_reported_legs integer := 0;
  v_elapsed_days integer := 0;
  v_remaining_days integer := 0;
  v_days_in_year integer;
  v_coverage numeric;
  v_data_ready boolean := false;
  v_completion numeric;
  v_average numeric;
  v_forecast bigint;
  v_forecast_pct numeric;
  v_required_today bigint;
  v_status text := 'unknown';
  v_monthly jsonb := '[]'::jsonb;
begin
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_get_public_annual_passenger_kpi_v1(p_year, p_today);
  end if;

  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;

  v_year_start := make_date(p_year, 1, 1);
  v_year_end := make_date(p_year, 12, 31);
  v_days_in_year := v_year_end - v_year_start + 1;
  v_period_state := case
    when p_year < extract(year from v_today)::integer then 'past'
    when p_year > extract(year from v_today)::integer then 'future'
    else 'current'
  end;
  v_period_end := case v_period_state
    when 'past' then v_year_end
    when 'current' then v_today - 1
    else null
  end;

  select * into v_kpi
  from reporting.annual_passenger_kpis
  where year = p_year;
  v_target := v_kpi.target_reported_pax;
  v_projection := public.get_public_annual_passenger_kpi_version_v1(p_year);

  if v_period_state <> 'future' and v_period_end >= v_year_start then
      select
        count(*)::integer,
        count(*) filter (where pax is not null)::integer,
        count(*) filter (where type = 'A' and pax is not null)::integer,
        count(*) filter (where type = 'D' and pax is not null)::integer,
        sum(pax) filter (where pax is not null)::bigint,
        sum(pax) filter (where type = 'A' and pax is not null)::bigint,
        sum(pax) filter (where type = 'D' and pax is not null)::bigint
      into v_due_legs, v_reported_legs, v_arrival_reported_legs,
        v_departure_reported_legs, v_reported_pax,
        v_arrival_reported_pax, v_departure_reported_pax
      from reporting.canonical_flight_legs
      where ops_date between v_year_start and v_period_end
        and type in ('A', 'D');

      select coalesce(jsonb_agg(jsonb_build_object(
        'month', to_char(months.month_start, 'YYYY-MM'),
        'reported_pax', case when coalesce(months.due_legs, 0) > 0
            and round(months.reported_legs * 100.0 / months.due_legs, 2) >= 99.5
          then months.reported_pax end,
        'reported_legs', coalesce(months.reported_legs, 0),
        'due_legs', coalesce(months.due_legs, 0),
        'pax_coverage_pct', case when coalesce(months.due_legs, 0) > 0
          then round(months.reported_legs * 100.0 / months.due_legs, 2) end
      ) order by months.month_start), '[]'::jsonb)
      into v_monthly
      from (
        select series.month_start,
          count(effective.business_leg_key)::integer as due_legs,
          count(effective.business_leg_key) filter (where effective.pax is not null)::integer as reported_legs,
          sum(effective.pax) filter (where effective.pax is not null)::bigint as reported_pax
        from generate_series(v_year_start, date_trunc('month', v_period_end)::date, interval '1 month') series(month_start)
        left join reporting.canonical_flight_legs effective
          on effective.ops_date >= series.month_start
         and effective.ops_date < series.month_start + interval '1 month'
         and effective.ops_date <= v_period_end
         and effective.type in ('A', 'D')
        group by series.month_start
      ) months;

    v_elapsed_days := v_period_end - v_year_start + 1;
    v_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) end;
    v_data_ready := v_target is not null
      and v_reported_pax is not null
      and v_due_legs > 0
      and v_reported_legs > 0
      and v_coverage >= 99.5
      and (v_period_state = 'past' or v_elapsed_days >= 28);
  end if;

  if v_period_state = 'current' then
    v_remaining_days := v_year_end - v_today + 1;
  end if;

  if v_data_ready then
    v_completion := round(v_reported_pax * 100.0 / v_target, 2);
    v_average := round(v_reported_pax::numeric / v_elapsed_days, 1);
    if v_period_state = 'current' then
      v_forecast := round(v_average * v_days_in_year)::bigint;
      v_forecast_pct := round(v_forecast * 100.0 / v_target, 2);
      if v_reported_pax < v_target then
        v_required_today := ceil((v_target - v_reported_pax)::numeric / v_remaining_days)::bigint;
      end if;
    end if;

    v_status := case
      when v_reported_pax > v_target then 'exceeded'
      when v_reported_pax = v_target then 'achieved'
      when v_period_state = 'past' then 'not_achieved'
      when v_forecast_pct > 102 then 'ahead'
      when v_forecast_pct >= 98 then 'on_track'
      else 'at_risk'
    end;
  elsif v_period_state = 'future' then
    v_status := 'not_started';
  end if;

  return jsonb_build_object(
    'contract_version', 'annual-passenger-kpi-v1',
    'year', p_year,
    'period_state', v_period_state,
    'period_from', v_year_start,
    'period_to', v_period_end,
    'target_reported_pax', v_target,
    'kpi_updated_at', v_kpi.updated_at,
    'reported_pax', case when v_reported_legs > 0 then v_reported_pax end,
    'arrival_reported_pax', case when v_arrival_reported_legs > 0 then v_arrival_reported_pax end,
    'departure_reported_pax', case when v_departure_reported_legs > 0 then v_departure_reported_pax end,
    'reported_legs', v_reported_legs,
    'due_legs', v_due_legs,
    'pax_coverage_pct', v_coverage,
    'data_ready', v_data_ready,
    'elapsed_days', v_elapsed_days,
    'remaining_days', case when v_period_state = 'current' then v_remaining_days end,
    'average_reported_pax_per_day', case when v_data_ready then v_average end,
    'required_reported_pax_today', case when v_data_ready then v_required_today end,
    'completion_pct', case when v_data_ready then v_completion end,
    'forecast_reported_pax', case when v_data_ready and v_period_state = 'current' then v_forecast end,
    'forecast_pct', case when v_data_ready and v_period_state = 'current' then v_forecast_pct end,
    'status', v_status,
    'monthly', v_monthly,
    'projection', v_projection
  );
end;
$$;

revoke execute on function public.get_public_annual_passenger_kpi_v1(integer, date) from public, anon, authenticated;
grant execute on function public.get_public_annual_passenger_kpi_v1(integer, date) to service_role;

-- 11.4 select_public_dashboard_candidate_v1 under cutover
create or replace function reporting.select_public_dashboard_candidate_v1(
  p_now timestamptz default statement_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_latest_completed date := ((p_now at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1;
  v_year integer := extract(year from v_latest_completed)::integer;
  v_year_start date := make_date(v_year,1,1);
  v_first_gap date;
  v_candidate date;
  v_source_watermark bigint;
  v_data_version integer;
  v_projection_status text;
  v_projection_watermark bigint;
  v_projection_data_version integer;
  v_projection_refreshed_at timestamptz;
  v_head_id bigint;
  v_head_business_date date;
  v_head_watermark bigint;
  v_metrics jsonb;
  v_timeline_days integer;
  v_missing_days integer;
  v_partial_days integer;
  v_flights integer;
  v_due_legs integer;
  v_reported_legs integer;
  v_missing_due_legs integer;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_target bigint;
  v_pax_coverage numeric;
  v_elapsed_days integer;
  v_status text;
  v_eligible boolean := false;
  v_reason text;
  v_op_status record;
  v_curr_op_rev bigint;
begin
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_select_public_dashboard_candidate_v1(p_now);
  end if;

  if p_now is null then
    raise exception 'candidate as-of must not be null' using errcode='22004';
  end if;

  select * into v_op_status from reporting.operational_projection_status_v1();
  select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
  v_source_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
  v_data_version := coalesce(v_curr_op_rev, 0)::integer;
  v_projection_status := case when coalesce(v_op_status.is_fresh, false) then 'fresh' else 'stale' end;
  v_projection_watermark := v_source_watermark;
  v_projection_data_version := v_data_version;
  v_projection_refreshed_at := v_op_status.refreshed_at;
  select heads.publication_id,publications.business_date,publications.source_watermark
    into v_head_id,v_head_business_date,v_head_watermark
  from reporting.public_dashboard_publication_heads heads
  join reporting.public_dashboard_publications publications on publications.id=heads.publication_id
  where heads.dashboard_key='annual-passenger-kpi' and heads.year=v_year;

  select min(days.day::date) into v_first_gap
  from generate_series(v_year_start,v_latest_completed,interval '1 day') days(day)
  where not exists (
    select 1 from reporting.public_traffic_coverage coverage
    where coverage.status='complete' and days.day::date between coverage.from_date and coverage.to_date
  );
  v_candidate := case when v_first_gap is null then v_latest_completed else v_first_gap - 1 end;
  if v_candidate < v_year_start then v_candidate := null; end if;

  if v_projection_status is distinct from 'fresh'
    or v_projection_watermark is distinct from v_source_watermark then
    v_status := 'projection_stale';
    v_reason := 'projection status, watermark, or data version is not current';
  elsif v_candidate is null then
    v_status := 'coverage_gap';
    v_reason := 'canonical complete coverage does not reach the first Ops Date of the year';
  elsif v_head_business_date > v_candidate then
    v_status := 'head_ahead';
    v_reason := 'current publication head is newer than the eligible coverage date';
  elsif v_head_business_date = v_candidate and v_head_watermark = v_source_watermark then
    v_status := 'already_current';
    v_reason := 'current publication already matches Business Date and source watermark';
  else
    v_metrics := public.get_public_traffic_report_v2(
      v_year_start, v_candidate, 'all', array[]::text[], array[]::text[], array[]::text[],
      'none', 'local', v_source_watermark, 'traffic-report-v2', 'timeline', p_now
    );
    v_timeline_days := jsonb_array_length(coalesce(v_metrics->'timeline','[]'::jsonb));
    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics->'timeline','[]'::jsonb)) timeline(completeness text);
    v_flights := coalesce((v_metrics#>>'{current,flights}')::integer,0);
    v_due_legs := coalesce((v_metrics#>>'{current,due_legs}')::integer,0);
    v_reported_legs := coalesce((v_metrics#>>'{current,reported_legs}')::integer,0);
    v_missing_due_legs := coalesce((v_metrics#>>'{current,missing_due_legs}')::integer,0);
    v_reported_pax := (v_metrics#>>'{current,reported_pax}')::bigint;
    v_arrival_reported_pax := (v_metrics#>>'{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics#>>'{current,departure_reported_pax}')::bigint;
    v_pax_coverage := case when v_due_legs > 0 then round(v_reported_legs * 100.0 / v_due_legs, 2) end;
    select target_reported_pax into v_target from reporting.annual_passenger_kpis where year=v_year;
    v_elapsed_days := v_candidate - v_year_start + 1;
    v_eligible := v_timeline_days > 0
      and coalesce(v_missing_days,0) = 0
      and coalesce(v_partial_days,0) = 0
      and v_due_legs = v_flights
      and (v_due_legs = 0 or (v_reported_legs > 0 and coalesce(v_pax_coverage,0) >= 99.5))
      and (
        (v_reported_legs = 0 and v_reported_pax is null and v_arrival_reported_pax is null and v_departure_reported_pax is null)
        or v_reported_pax = coalesce(v_arrival_reported_pax,0) + coalesce(v_departure_reported_pax,0)
      );
    v_status := case when v_timeline_days = 0 then 'empty'
      when v_eligible then 'ready' else 'maturity_incomplete' end;
    v_reason := case when v_eligible
      then 'contiguous complete coverage reaches candidate date with valid maturity and Pax totals'
      when v_timeline_days = 0 then 'timeline is empty for candidate range'
      when coalesce(v_missing_days,0) > 0 or coalesce(v_partial_days,0) > 0 then 'timeline has missing or partial days'
      when v_due_legs <> v_flights then 'flight count does not match due legs'
      when v_due_legs > 0 and coalesce(v_pax_coverage,0) < 99.5 then 'Pax coverage is below 99.5%'
      else 'A+D Pax sum does not match total reported Pax' end;
  end if;

  return jsonb_build_object(
    'eligible', v_eligible, 'status', v_status, 'reason', v_reason,
    'business_date', v_candidate, 'latest_completed_ops_date', v_latest_completed, 'year', v_year,
    'source_watermark', v_source_watermark, 'data_version', v_data_version, 'data_as_of', p_now,
    'projection_status', v_projection_status, 'projection_watermark', v_projection_watermark,
    'projection_data_version', v_projection_data_version, 'projection_refreshed_at', v_projection_refreshed_at,
    'head_publication_id', v_head_id, 'head_business_date', v_head_business_date, 'head_source_watermark', v_head_watermark,
    'timeline_days', v_timeline_days, 'flights', v_flights, 'due_legs', v_due_legs,
    'reported_legs', v_reported_legs, 'missing_due_legs', v_missing_due_legs,
    'reported_pax', v_reported_pax, 'arrival_reported_pax', v_arrival_reported_pax,
    'departure_reported_pax', v_departure_reported_pax, 'pax_coverage_pct', v_pax_coverage,
    'idempotency_key', case when v_candidate is null then null else
      'annual-kpi:' || v_year::text || ':' || v_candidate::text || ':' || v_source_watermark::text end
  );
end;
$$;

revoke execute on function reporting.select_public_dashboard_candidate_v1(timestamptz) from public, anon, authenticated, service_role;
grant execute on function reporting.select_public_dashboard_candidate_v1(timestamptz) to service_role;

-- 11.5 apply_public_dashboard_rolling_forecast_v2
create or replace function reporting.apply_public_dashboard_rolling_forecast_v2(
  p_payload jsonb,
  p_metrics jsonb,
  p_year integer,
  p_business_date date
) returns jsonb
language plpgsql
immutable
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_year_start date := make_date(p_year, 1, 1);
  v_year_end date := make_date(p_year, 12, 31);
  v_window_target_days constant integer := 30;
  v_minimum_window_days constant integer := 7;
  v_window_from date := greatest(v_year_start, p_business_date - (v_window_target_days - 1));
  v_window_days integer;
  v_selected_days integer;
  v_missing_days integer;
  v_partial_days integer;
  v_window_flights integer;
  v_window_due_legs integer;
  v_window_reported_legs integer;
  v_window_missing_due_legs integer;
  v_window_reported_pax bigint;
  v_window_coverage numeric;
  v_window_average numeric;
  v_reported_pax bigint := (p_payload ->> 'reported_pax')::bigint;
  v_target bigint := (p_payload ->> 'target_reported_pax')::bigint;
  v_remaining_days integer := greatest(v_year_end - p_business_date, 0);
  v_forecast_ready boolean;
  v_forecast bigint;
  v_forecast_pct numeric;
  v_status text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'dashboard payload must be a JSON object' using errcode = '22023';
  end if;
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then
    raise exception 'traffic metrics must be a JSON object' using errcode = '22023';
  end if;
  if p_year is null or p_year not between 2000 and 2200
    or p_business_date is null
    or p_business_date < v_year_start
    or p_business_date > v_year_end then
    raise exception 'invalid KPI year or Business Date' using errcode = '22023';
  end if;

  v_window_days := p_business_date - v_window_from + 1;

  select
    count(*)::integer,
    count(*) filter (where timeline.completeness = 'missing')::integer,
    count(*) filter (where timeline.completeness = 'partial')::integer,
    coalesce(sum(timeline.flights), 0)::integer,
    coalesce(sum(timeline.due_legs), 0)::integer,
    coalesce(sum(timeline.reported_legs), 0)::integer,
    coalesce(sum(timeline.missing_due_legs), 0)::integer,
    (sum(timeline.reported_pax) filter (where timeline.reported_legs > 0))::bigint
  into
    v_selected_days,
    v_missing_days,
    v_partial_days,
    v_window_flights,
    v_window_due_legs,
    v_window_reported_legs,
    v_window_missing_due_legs,
    v_window_reported_pax
  from jsonb_to_recordset(coalesce(p_metrics -> 'timeline', '[]'::jsonb)) as timeline(
    ops_date date,
    completeness text,
    flights integer,
    reported_pax bigint,
    reported_legs integer,
    due_legs integer,
    missing_due_legs integer
  )
  where timeline.ops_date between v_window_from and p_business_date;

  v_window_coverage := case when v_window_due_legs > 0
    then round(v_window_reported_legs * 100.0 / v_window_due_legs, 2) end;
  v_forecast_ready := coalesce((p_payload ->> 'data_ready')::boolean, false)
    and v_window_days >= v_minimum_window_days
    and v_selected_days = v_window_days
    and v_missing_days = 0
    and v_partial_days = 0
    and v_window_due_legs > 0
    and v_window_due_legs = v_window_flights
    and v_window_reported_legs > 0
    and v_window_reported_pax is not null
    and v_window_coverage >= 99.5;

  if v_forecast_ready then
    v_window_average := round(v_window_reported_pax::numeric / v_window_days, 1);
    v_forecast := v_reported_pax
      + round(v_window_reported_pax::numeric / v_window_days * v_remaining_days)::bigint;
    v_forecast_pct := case when v_target > 0
      then round(v_forecast * 100.0 / v_target, 2) end;
  end if;

  v_status := case
    when v_reported_pax > v_target then 'exceeded'
    when v_reported_pax = v_target then 'achieved'
    when p_business_date = v_year_end then 'not_achieved'
    when not v_forecast_ready then 'unknown'
    when v_forecast_pct > 102 then 'ahead'
    when v_forecast_pct >= 98 then 'on_track'
    else 'at_risk'
  end;

  return p_payload || jsonb_build_object(
    'contract_version', 'annual-passenger-publication-v2',
    'forecast_method', 'rolling_completed_ops_dates_30',
    'forecast_data_ready', v_forecast_ready,
    'forecast_window_target_days', v_window_target_days,
    'forecast_window_days', v_window_days,
    'forecast_window_from', v_window_from,
    'forecast_window_to', p_business_date,
    'forecast_window_reported_pax', v_window_reported_pax,
    'forecast_window_reported_legs', v_window_reported_legs,
    'forecast_window_due_legs', v_window_due_legs,
    'forecast_window_missing_due_legs', v_window_missing_due_legs,
    'forecast_window_pax_coverage_pct', v_window_coverage,
    'forecast_average_reported_pax_per_day', case when v_forecast_ready then v_window_average end,
    'forecast_reported_pax', case
      when v_forecast_ready and p_business_date < v_year_end then v_forecast end,
    'forecast_pct', case
      when v_forecast_ready and p_business_date < v_year_end then v_forecast_pct end,
    'status', v_status
  );
end;
$function$;

-- 11.5 publish_public_dashboard_daily_v1 under cutover
create or replace function public.publish_public_dashboard_daily_v1(
  p_year integer,
  p_business_date date,
  p_expected_watermark bigint,
  p_idempotency_key text,
  p_trigger_kind text default 'daily_acceptance',
  p_reason text default 'Daily data accepted'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, extensions, pg_temp
set statement_timeout = '45s'
as $$
declare
  v_publication_id bigint;
  v_existing_id bigint;
  v_data_as_of timestamptz := statement_timestamp();
  v_source_watermark bigint;
  v_after_watermark bigint;
  v_source_data_version integer;
  v_metrics jsonb;
  v_target bigint;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_flights integer;
  v_reported_legs integer;
  v_due_legs integer;
  v_missing_due_legs integer;
  v_true_zero_reported_legs integer;
  v_missing_days integer;
  v_partial_days integer;
  v_elapsed_days integer;
  v_remaining_days integer;
  v_days_in_year integer;
  v_coverage numeric;
  v_data_ready boolean := false;
  v_completion numeric;
  v_average numeric;
  v_forecast bigint;
  v_forecast_pct numeric;
  v_required_today bigint;
  v_status text := 'unknown';
  v_monthly jsonb;
  v_publication_status text := 'failed';
  v_payload jsonb;
  v_checksum text;
  v_op_status record;
  v_curr_op_rev bigint;
begin
  if not reporting.is_operational_reader_cutover_active_v1() then
    return reporting.legacy_publish_public_dashboard_daily_v1(
      p_year,
      p_business_date,
      p_expected_watermark,
      p_idempotency_key,
      p_trigger_kind,
      p_reason
    );
  end if;
  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;
  if p_business_date is null or extract(year from p_business_date)::integer <> p_year then
    raise exception 'business_date must belong to the publication year' using errcode = '22023';
  end if;
  if p_business_date > ((v_data_as_of at time zone 'Asia/Ho_Chi_Minh') - interval '5 hours')::date - 1 then
    raise exception 'business_date must be a completed Ops Date' using errcode = '22023';
  end if;
  if p_expected_watermark is null or p_expected_watermark < 0 then
    raise exception 'expected watermark must be a non-negative integer' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
    or length(p_idempotency_key) > 200 then
    raise exception 'idempotency_key must contain 8..200 characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('daily_acceptance','manual_correction','shadow','rehearsal') then
    raise exception 'invalid trigger_kind' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 4 or length(p_reason) > 500 then
    raise exception 'reason must contain 4..500 characters' using errcode = '22023';
  end if;

  select publications.id into v_existing_id
  from reporting.public_dashboard_publications publications
  where publications.dashboard_key = 'annual-passenger-kpi'
    and publications.year = p_year
    and publications.idempotency_key = btrim(p_idempotency_key);
  if v_existing_id is not null then
    return reporting.public_dashboard_publication_receipt_v1(v_existing_id);
  end if;

  insert into reporting.public_dashboard_publications(
    dashboard_key, year, business_date, status, idempotency_key, trigger_kind,
    reason, expected_source_watermark, data_as_of
  ) values (
    'annual-passenger-kpi', p_year, p_business_date, 'pending', btrim(p_idempotency_key),
    p_trigger_kind, btrim(p_reason), p_expected_watermark, v_data_as_of
  ) on conflict (dashboard_key, year, idempotency_key) do nothing
  returning id into v_publication_id;

  if v_publication_id is null then
    select publications.id into v_existing_id
    from reporting.public_dashboard_publications publications
    where publications.dashboard_key = 'annual-passenger-kpi'
      and publications.year = p_year
      and publications.idempotency_key = btrim(p_idempotency_key);
    return reporting.public_dashboard_publication_receipt_v1(v_existing_id);
  end if;

  begin
    if reporting.is_operational_reader_cutover_active_v1() then
      select * into v_op_status from reporting.operational_projection_status_v1();
      select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
      v_source_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
    else
      select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
      from public.season_change_events events;
    end if;

    if v_source_watermark is distinct from p_expected_watermark then
      update reporting.public_dashboard_publications set
        status = 'rejected_version', source_watermark = v_source_watermark,
        completed_at = statement_timestamp(), error = 'source watermark changed before publication'
      where id = v_publication_id;
      return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
    end if;

    v_metrics := public.get_public_traffic_report_v2(
      make_date(p_year, 1, 1), p_business_date, 'all', array[]::text[], array[]::text[],
      array[]::text[], 'none', 'local', p_expected_watermark, 'traffic-report-v2',
      'timeline', v_data_as_of
    );

    if reporting.is_operational_reader_cutover_active_v1() then
      select * into v_op_status from reporting.operational_projection_status_v1();
      select revision into v_curr_op_rev from public.operational_workspace_revision where singleton;
      v_after_watermark := coalesce(v_op_status.source_watermark, 0)::bigint + coalesce(v_curr_op_rev, 0)::bigint;
    else
      select coalesce(max(events.server_seq), 0)::bigint into v_after_watermark
      from public.season_change_events events;
    end if;

    if v_after_watermark is distinct from p_expected_watermark then
      update reporting.public_dashboard_publications set
        status = 'rejected_version', source_watermark = v_after_watermark,
        completed_at = statement_timestamp(), error = 'source watermark changed during publication'
      where id = v_publication_id;
      return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
    end if;

    v_reported_pax := (v_metrics #>> '{current,reported_pax}')::bigint;
    v_arrival_reported_pax := (v_metrics #>> '{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics #>> '{current,departure_reported_pax}')::bigint;
    v_flights := coalesce((v_metrics #>> '{current,flights}')::integer, 0);
    v_reported_legs := coalesce((v_metrics #>> '{current,reported_legs}')::integer, 0);
    v_due_legs := coalesce((v_metrics #>> '{current,due_legs}')::integer, 0);
    v_missing_due_legs := coalesce((v_metrics #>> '{current,missing_due_legs}')::integer, 0);
    v_true_zero_reported_legs := coalesce((v_metrics #>> '{current,true_zero_reported_legs}')::integer, 0);
    v_source_data_version := (v_metrics ->> 'data_version')::integer;
    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) as timeline(
      completeness text
    );

    select target_reported_pax into v_target
    from reporting.annual_passenger_kpis
    where year = p_year;

    v_days_in_year := make_date(p_year, 12, 31) - make_date(p_year, 1, 1) + 1;
    v_elapsed_days := p_business_date - make_date(p_year, 1, 1) + 1;
    v_remaining_days := make_date(p_year, 12, 31) - p_business_date;
    v_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) end;
    v_data_ready := v_target is not null
      and v_reported_pax is not null
      and v_due_legs > 0
      and v_reported_legs > 0
      and v_coverage >= 99.5
      and v_elapsed_days >= 28;

    select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(months.month_start, 'YYYY-MM'),
      'reported_pax', case when months.due_legs > 0
          and round(months.reported_legs * 100.0 / months.due_legs, 2) >= 99.5
        then months.reported_pax end,
      'reported_legs', months.reported_legs,
      'due_legs', months.due_legs,
      'pax_coverage_pct', case when months.due_legs > 0
        then round(months.reported_legs * 100.0 / months.due_legs, 2) end
    ) order by months.month_start), '[]'::jsonb)
    into v_monthly
    from (
      select date_trunc('month', timeline.ops_date)::date as month_start,
        coalesce(sum(timeline.reported_pax) filter (where timeline.reported_legs > 0), 0)::bigint as reported_pax,
        coalesce(sum(timeline.reported_legs), 0)::integer as reported_legs,
        coalesce(sum(timeline.due_legs), 0)::integer as due_legs
      from jsonb_to_recordset(v_metrics -> 'timeline') as timeline(
        ops_date date, reported_pax bigint, reported_legs integer, due_legs integer
      )
      group by date_trunc('month', timeline.ops_date)::date
    ) months;

    if v_data_ready then
      v_completion := round(v_reported_pax * 100.0 / v_target, 2);
      v_average := round(v_reported_pax::numeric / v_elapsed_days, 1);
      v_forecast := round(v_average * v_days_in_year)::bigint;
      v_forecast_pct := round(v_forecast * 100.0 / v_target, 2);
      if v_reported_pax < v_target and v_remaining_days > 0 then
        v_required_today := ceil((v_target - v_reported_pax)::numeric / v_remaining_days)::bigint;
      end if;
      v_status := case
        when v_reported_pax > v_target then 'exceeded'
        when v_reported_pax = v_target then 'achieved'
        when p_business_date = make_date(p_year, 12, 31) then 'not_achieved'
        when v_forecast_pct > 102 then 'ahead'
        when v_forecast_pct >= 98 then 'on_track'
        else 'at_risk'
      end;
    end if;

    v_publication_status := case
      when jsonb_array_length(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) = 0 then 'empty'
      when v_missing_days > 0 or v_partial_days > 0
        or v_due_legs <> v_flights
        or (v_due_legs > 0 and coalesce(v_coverage, 0) < 99.5) then 'incomplete'
      else 'ready'
    end;

    v_payload := jsonb_build_object(
      'contract_version', 'annual-passenger-publication-v1',
      'year', p_year,
      'period_state', case when p_business_date = make_date(p_year, 12, 31) then 'past' else 'current' end,
      'period_from', make_date(p_year, 1, 1),
      'period_to', p_business_date,
      'target_reported_pax', v_target,
      'kpi_updated_at', (select updated_at from reporting.annual_passenger_kpis where year = p_year),
      'reported_pax', case when v_reported_legs > 0 then v_reported_pax end,
      'arrival_reported_pax', case when v_reported_legs > 0 then v_arrival_reported_pax end,
      'departure_reported_pax', case when v_reported_legs > 0 then v_departure_reported_pax end,
      'reported_legs', v_reported_legs,
      'due_legs', v_due_legs,
      'not_due_legs', greatest(v_flights - v_due_legs, 0),
      'missing_due_legs', v_missing_due_legs,
      'true_zero_reported_legs', v_true_zero_reported_legs,
      'pax_coverage_pct', v_coverage,
      'data_ready', v_data_ready,
      'elapsed_days', v_elapsed_days,
      'remaining_days', v_remaining_days,
      'average_reported_pax_per_day', case when v_data_ready then v_average end,
      'required_reported_pax_today', case when v_data_ready then v_required_today end,
      'completion_pct', case when v_data_ready then v_completion end,
      'forecast_reported_pax', case when v_data_ready and p_business_date < make_date(p_year, 12, 31) then v_forecast end,
      'forecast_pct', case when v_data_ready and p_business_date < make_date(p_year, 12, 31) then v_forecast_pct end,
      'status', v_status,
      'monthly', v_monthly,
      'publication', jsonb_build_object(
        'publication_id', v_publication_id,
        'business_date', p_business_date,
        'published_at', statement_timestamp(),
        'data_as_of', v_data_as_of,
        'source_watermark', v_source_watermark,
        'source_data_version', v_source_data_version,
        'metrics_contract_version', 'traffic-report-v2',
        'freshness', case when v_publication_status = 'ready' then 'fresh' else v_publication_status end
      )
    );
    v_payload := reporting.apply_public_dashboard_rolling_forecast_v2(v_payload, v_metrics, p_year, p_business_date);
    v_checksum := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

    update reporting.public_dashboard_publications set
      status = v_publication_status,
      source_watermark = v_source_watermark,
      source_data_version = v_source_data_version,
      data_as_of = v_data_as_of,
      row_count = v_flights,
      due_legs = v_due_legs,
      reported_legs = v_reported_legs,
      payload = v_payload,
      payload_checksum = v_checksum,
      completed_at = statement_timestamp(),
      error = case when v_publication_status = 'incomplete'
        then 'daily maturity, coverage, or Pax completeness validation failed'
        when v_publication_status = 'empty' then 'publication payload is empty' end
    where id = v_publication_id;

    if v_publication_status = 'ready' then
      insert into reporting.public_dashboard_publication_heads(
        dashboard_key, year, publication_id, updated_at
      ) values ('annual-passenger-kpi', p_year, v_publication_id, statement_timestamp())
      on conflict (dashboard_key, year) do update set
        publication_id = excluded.publication_id,
        updated_at = excluded.updated_at
      where public_dashboard_publication_heads.publication_id < excluded.publication_id;
    end if;
  exception when others then
    update reporting.public_dashboard_publications set
      status = 'failed', source_watermark = coalesce(v_after_watermark, v_source_watermark),
      completed_at = statement_timestamp(), error = left(sqlerrm, 500)
    where id = v_publication_id;
  end;

  return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
end;
$$;

revoke execute on function public.publish_public_dashboard_daily_v1(integer, date, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.publish_public_dashboard_daily_v1(integer, date, bigint, text, text, text) to service_role;

commit;
