-- Refuse to discard operational allocations, receipts or audit evidence.
begin;
do $$
declare v_table text;
begin
  if to_regclass('public.operational_daily_import_stages') is not null then
    raise exception 'Rollback M5 Daily import before M4 mutations' using errcode='55000';
  end if;
  foreach v_table in array array['operational_leg_counters','operational_leg_checkin_windows','operational_mutation_receipts','operational_change_events'] loop
    if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=v_table) then
      declare v_exists boolean; begin
        execute format('select exists(select 1 from public.%I)',v_table) into v_exists;
        if v_exists then raise exception 'M4 rollback refused: % still holds rows',v_table; end if;
      end;
    end if;
  end loop;
end;
$$;
create or replace function public.run_seasonal_operational_backfill_v1(
  p_published_on date,
  p_published_by uuid,
  p_replayed_from_high_water bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '1800s'
as $function$
declare
  v_run_id uuid;
  v_cutoff timestamp with time zone := statement_timestamp();
  v_high_water bigint;
  v_drafts jsonb;
  v_versions integer;
  v_legs jsonb;
  v_authority integer;
begin
  if not (
    public.app_operator_has_permission('seasonal.write')
    or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('season.repair')
  ) then
    raise exception 'backfill requires seasonal.write, daily.write or season.repair' using errcode = '42501';
  end if;

  select coalesce(max(events.server_seq), 0) into v_high_water from public.season_change_events events;

  insert into public.seasonal_operational_backfill_runs (
    cutoff_at, source_high_water, replayed_from_high_water, published_on, published_by, status
  ) values (
    v_cutoff, v_high_water, p_replayed_from_high_water, p_published_on, p_published_by, 'running'
  ) returning run_id into v_run_id;

  begin
    v_drafts := public.backfill_seasonal_flight_drafts_v1(v_run_id);
    v_versions := public.seed_seasonal_baseline_versions_v1(v_run_id, p_published_on, p_published_by);
    v_legs := public.backfill_operational_flight_legs_v1(v_run_id);
    v_authority := public.backfill_operational_day_authority_v1(v_run_id);

    update public.seasonal_operational_backfill_runs
       set status = 'completed',
           completed_at = now(),
           drafts_written = (v_drafts->>'written')::integer,
           versions_seeded = v_versions,
           legs_written = (v_legs->>'written')::integer,
           authority_rows_written = v_authority
     where run_id = v_run_id;
  exception when others then
    update public.seasonal_operational_backfill_runs
       set status = 'failed',
           completed_at = now(),
           notes = notes || jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate)
     where run_id = v_run_id;
    raise;
  end;

  -- Shadow readers are woken in the same transaction as the write, exactly like
  -- the Daily dashboard wake: the M3.4 projection runner listens on this channel
  -- and the timer is only the fallback for a notification that never arrives.
  perform pg_notify(
    'operational_projection_wake',
    jsonb_build_object('source', 'seasonal-operational-backfill-v1', 'runId', v_run_id, 'highWater', v_high_water)::text
  );

  return jsonb_build_object(
    'runId', v_run_id,
    'cutoffAt', v_cutoff,
    'sourceHighWater', v_high_water,
    'drafts', v_drafts,
    'versions', v_versions,
    'legs', v_legs,
    'authorityDays', v_authority
  );
end;
$function$;


create or replace function public.get_operational_schedule_allocation_window_v1(
  p_start_date date,
  p_end_date date,
  p_resource_type text default 'all',
  p_page_size integer default 500,
  p_after_operational_date date default null,
  p_after_scheduled_time time without time zone default null,
  p_after_leg_id uuid default null,
  p_expected_snapshot text default null
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_revision bigint;
  v_token text;
  v_epoch uuid;
  v_result jsonb;
  v_resources jsonb := '{}'::jsonb;
  v_table text;
  v_rows jsonb;
begin
  if public.app_operator_has_permission('daily.read') is not true then
    raise exception 'Missing required permission: daily.read' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or not isfinite(p_start_date)
     or not isfinite(p_end_date) or p_end_date < p_start_date or p_end_date - p_start_date > 365 then
    raise exception 'A finite date range of at most 366 days is required' using errcode = '22023';
  end if;
  if p_page_size is null or p_page_size not between 1 and 1000 then
    raise exception 'Page size must be between 1 and 1000' using errcode = '22023';
  end if;
  if p_resource_type is null or p_resource_type not in ('all','schedule','gate','checkin','stand','counter','carousel') then
    raise exception 'Unsupported resource type' using errcode = '22023';
  end if;
  if num_nonnulls(p_after_operational_date, p_after_scheduled_time, p_after_leg_id) not in (0, 3)
     or (p_after_leg_id is not null and p_expected_snapshot is null)
     or (p_after_operational_date is not null and p_after_operational_date not between p_start_date and p_end_date) then
    raise exception 'A complete cursor and its snapshot revision are required' using errcode = '22023';
  end if;
  select revision, epoch into strict v_revision, v_epoch from public.operational_workspace_revision where singleton;
  v_token := md5(jsonb_build_array(v_epoch, v_revision::text, p_start_date, p_end_date, p_resource_type)::text);
  if p_expected_snapshot is not null and p_expected_snapshot <> v_token then
    return jsonb_build_object('status','snapshot_changed','snapshot',jsonb_build_object('revision',v_revision::text,'token',v_token));
  end if;
  if p_resource_type in ('all','gate','checkin','counter','stand') then
    foreach v_table in array array[
      'operational_checkin_counters','operational_checkin_counter_groups',
      'operational_checkin_counter_group_members','operational_checkin_counter_locks',
      'operational_checkin_counter_lock_members','operational_gate_resources',
      'operational_gate_groups','operational_gate_group_members',
      'operational_gate_locks','operational_gate_lock_members','operational_stand_gate_mappings'
    ] loop
      if p_resource_type = 'all'
         or (p_resource_type = 'gate' and v_table like 'operational_gate_%')
         or (p_resource_type in ('gate','stand') and v_table = 'operational_stand_gate_mappings')
         or (p_resource_type in ('checkin','counter') and v_table like 'operational_checkin_%') then
        execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)), ''[]''::jsonb) from public.%I r',v_table) into v_rows;
        v_resources := v_resources || jsonb_build_object(v_table,v_rows);
      end if;
    end loop;
  end if;

  -- STABLE uses the calling statement snapshot for both revision and rows.
  -- Keep one indexed range, bounded to page size + one sentinel.
  with candidates as materialized (
    select l.* from public.operational_flight_legs l
    where l.status = 'active' and l.operational_date between p_start_date and p_end_date
      and (p_after_leg_id is null or (l.operational_date,l.scheduled_time,l.leg_id)
        > (p_after_operational_date,p_after_scheduled_time,p_after_leg_id))
    order by l.operational_date,l.scheduled_time,l.leg_id limit p_page_size + 1
  ), page as materialized (
    select * from candidates order by operational_date,scheduled_time,leg_id limit p_page_size
  ), last_row as (
    select * from page order by operational_date desc,scheduled_time desc,leg_id desc limit 1
  )
  select jsonb_build_object(
    'status','ok','startDate',p_start_date,'endDate',p_end_date,'resourceType',p_resource_type,
    'snapshot',jsonb_build_object('revision',v_revision::text,'token',v_token),
    'resources',v_resources,
    'page',jsonb_build_object('returnedCount',(select count(*) from page),
      'hasMore',(select count(*) > p_page_size from candidates),
      'nextCursor',case when (select count(*) > p_page_size from candidates) then
        (select jsonb_build_object('operationalDate',operational_date,'scheduledTime',scheduled_time,'legId',leg_id) from last_row)
        else null end),
    'legs',coalesce((select jsonb_agg(to_jsonb(p) order by operational_date,scheduled_time,leg_id) from page p),'[]'::jsonb),
    'linkedLegs',coalesce((select jsonb_agg(to_jsonb(l) order by l.leg_id) from public.operational_flight_legs l
      where l.status='active' and l.leg_id in (select linked_leg_id from page)
        and l.leg_id not in (select leg_id from page)),'[]'::jsonb),
    'authorityDays',coalesce((select jsonb_agg(to_jsonb(a) order by operational_date)
      from public.operational_day_authority a where a.operational_date between p_start_date and p_end_date and a.reset_at is null),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_operational_schedule_allocation_window_v1(date,date,text,integer,date,time,uuid,text) from public, anon;
grant execute on function public.get_operational_schedule_allocation_window_v1(date,date,text,integer,date,time,uuid,text) to authenticated;

create or replace function reporting.get_operational_candidate_slice_v1(
  p_from_date date,
  p_to_date date
) returns table (
  season_id text,
  record_id text,
  type text,
  airline text,
  flight_number text,
  route text,
  aircraft text,
  pax integer,
  scheduled_date text,
  scheduled_time text,
  effective_route text,
  effective_aircraft text,
  effective_pax integer,
  effective_action text,
  scheduled_date_value date,
  local_minutes integer,
  authoritative_server_seq bigint,
  ops_date date,
  scheduled_local_at timestamp without time zone,
  business_leg_key text
)
language sql
stable
security invoker
set search_path = pg_catalog, reporting, public, pg_temp
as $$
with bounded as materialized (
  select
    legs.leg_id,
    legs.leg_key,
    legs.operational_date,
    legs.scheduled_date,
    legs.scheduled_time,
    legs.side,
    legs.airline,
    legs.flight_number,
    legs.route,
    legs.aircraft_type,
    legs.pax,
    legs.source_season_id,
    links.authoritative_server_seq as backfill_server_seq
  from public.operational_flight_legs legs
  left join public.operational_leg_backfill_links links
    on links.leg_id = legs.leg_id
  where legs.status = 'active'
    and legs.operational_date between p_from_date and p_to_date
), bounded_stats as materialized (
  select count(*)::bigint as candidate_count from bounded
), entity_recency as materialized (
  select events.target_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  join (select distinct bounded.leg_id::text as target_id from bounded) selected
    on selected.target_id = events.target_id
  cross join bounded_stats
  where bounded_stats.candidate_count < 10000
  group by events.target_id

  union all

  select events.target_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  cross join bounded_stats
  where bounded_stats.candidate_count >= 10000
  group by events.target_id
), day_recency as materialized (
  select events.target_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  where events.target_type = 'dailyAuthority'
    and events.target_id in (select distinct bounded.operational_date::text from bounded)
  group by events.target_id
)
select
  bounded.source_season_id,
  bounded.leg_id::text,
  case bounded.side when 'ARR' then 'A' else 'D' end,
  upper(btrim(bounded.airline)),
  upper(btrim(bounded.flight_number)),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  bounded.scheduled_date::text,
  to_char(bounded.scheduled_time, 'HH24:MI'),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  'active',
  bounded.scheduled_date,
  extract(hour from bounded.scheduled_time)::integer * 60
    + extract(minute from bounded.scheduled_time)::integer,
  coalesce(entity_recency.server_seq, day_recency.server_seq, bounded.backfill_server_seq),
  bounded.operational_date,
  bounded.scheduled_date + bounded.scheduled_time,
  (case bounded.side when 'ARR' then 'A' else 'D' end) || chr(31)
    || bounded.scheduled_date::text || chr(31)
    || upper(btrim(bounded.airline)) || chr(31)
    || upper(btrim(bounded.flight_number))
from bounded
left join entity_recency on entity_recency.target_id = bounded.leg_id::text
left join day_recency on day_recency.target_id = bounded.operational_date::text
$$;

alter function reporting.get_operational_candidate_slice_v1(date, date) owner to postgres;
revoke execute on function reporting.get_operational_candidate_slice_v1(date, date)
  from public, anon, authenticated, service_role;

comment on function reporting.get_operational_candidate_slice_v1(date, date)
is 'Internal bounded candidate seam over public.operational_flight_legs, carrying backfill authoritative recency as fallback behind native entity/day recency, column-compatible with reporting.get_public_traffic_candidate_slice_v1 so the shadow projection can reuse the canonical resolution.';

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
  v_observed bigint;
  v_leg_count integer;
  v_quarantine_count integer;
begin
  -- One refresh at a time: two concurrent runs would interleave truncate and
  -- insert on the same tables and could publish one run's rows under another
  -- run's watermark.
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  select bounds.min_ops_date, bounds.max_ops_date
    into v_min_date, v_max_date
  from reporting.get_operational_canonical_bounds_v1() bounds;

  -- The claim is taken before anything is read or written: every writer event
  -- visible here belongs to a transaction that also committed its leg, so those
  -- legs are visible to every later read in this transaction.
  select coalesce(max(events.server_seq), 0)::bigint into v_watermark
  from public.season_change_events events;

  if v_min_date is null or v_max_date is null then
    truncate table reporting.operational_canonical_flight_legs;
    truncate table reporting.operational_canonical_flight_legs_quarantine;

    insert into reporting.operational_canonical_flight_legs_state (
      singleton, refreshed_at, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
    ) values (true, now(), v_watermark, v_watermark, null, null, 0, 0)
    on conflict (singleton) do update
      set refreshed_at = excluded.refreshed_at,
          source_watermark = excluded.source_watermark,
          observed_watermark = excluded.observed_watermark,
          ops_min_date = excluded.ops_min_date,
          ops_max_date = excluded.ops_max_date,
          leg_count = excluded.leg_count,
          quarantine_count = excluded.quarantine_count;
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

  -- Quarantine: the writer-side ledger first (a key the backfill/publish path
  -- refused is the honest reason the report cannot count it), then any key the
  -- operational store itself still holds twice (a writer bug the projection must
  -- not silently rank away).
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

  -- Reported, never claimed: a writer that committed while the rows were being
  -- written shows up here and leaves the projection stale (is_fresh compares
  -- source_watermark, not this value, against the current high-water).
  select coalesce(max(events.server_seq), 0)::bigint into v_observed
  from public.season_change_events events;

  insert into reporting.operational_canonical_flight_legs_state (
    singleton, refreshed_at, source_watermark, observed_watermark, ops_min_date, ops_max_date, leg_count, quarantine_count
  ) values (true, now(), v_watermark, v_observed, v_min_date, v_max_date, v_leg_count, v_quarantine_count)
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at,
        source_watermark = excluded.source_watermark,
        observed_watermark = excluded.observed_watermark,
        ops_min_date = excluded.ops_min_date,
        ops_max_date = excluded.ops_max_date,
        leg_count = excluded.leg_count,
        quarantine_count = excluded.quarantine_count;
end;
$function$;


create or replace function reporting.operational_projection_status_v1()
returns table (
  is_fresh boolean,
  refreshed_at timestamp with time zone,
  source_watermark bigint,
  observed_watermark bigint,
  current_watermark bigint,
  leg_count integer,
  quarantine_count integer,
  ops_min_date date,
  ops_max_date date
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
  select
    coalesce(state.source_watermark >= watermarks.current_watermark, false) as is_fresh,
    state.refreshed_at,
    state.source_watermark,
    state.observed_watermark,
    watermarks.current_watermark,
    state.leg_count,
    state.quarantine_count,
    state.ops_min_date,
    state.ops_max_date
  from (select true as singleton) singleton
  cross join (
    select coalesce(max(events.server_seq), 0)::bigint as current_watermark
    from public.season_change_events events
  ) watermarks
  left join reporting.operational_canonical_flight_legs_state state on state.singleton
$$;

alter function reporting.operational_projection_status_v1() owner to postgres;
revoke execute on function reporting.operational_projection_status_v1() from public, anon, authenticated;
grant execute on function reporting.operational_projection_status_v1() to service_role;

comment on function reporting.operational_projection_status_v1()
is 'M3.4 freshness gate: is_fresh is false when no refresh has run or when the newest writer event is newer than the watermark the projection claimed. observed_watermark above source_watermark means the last refresh raced a writer and should simply run again.';


alter table reporting.operational_canonical_flight_legs_state drop column source_operational_revision;
drop view reporting.operational_projection_events_v1;
drop function public.apply_operational_resource_changes_v1(uuid,bigint,jsonb);
drop function public.backfill_operational_resources_v1();
drop table public.operational_leg_counters;
drop table public.operational_leg_checkin_windows;
drop table public.operational_mutation_receipts;
drop table public.operational_change_events;
commit;
