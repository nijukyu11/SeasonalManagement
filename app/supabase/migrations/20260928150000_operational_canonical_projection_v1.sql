-- M3.2 shadow projection: reporting.operational_canonical_flight_legs.
--
-- Same shape, same resolution and same quarantine contract as
-- reporting.canonical_flight_legs, but resolved from the operational store via
-- reporting.get_operational_candidate_slice_v1. The public report keeps reading
-- the canonical table until gate M10: this migration only adds a parallel
-- projection plus the freshness bookkeeping M3.4 needs.
--
-- Freshness: every operational writer must emit a public.season_change_events
-- row in the same transaction as its mutation (M4.2 entity events, M5.2 a
-- dailyAuthority event per affected operational date). The refresh stores the
-- event high-water it observed after re-projecting, and
-- reporting.operational_projection_status_v1() is fresh only while that stored
-- watermark is not older than the newest event. A refresh that reads an older
-- snapshot than the stored watermark would be a lie, so the watermark is taken
-- after the projection is written; the remaining race (a writer that commits its
-- leg after our slice read but whose event already existed) is closed by the
-- M5/M7 publish/commit paths re-checking authority under locks.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

create table if not exists reporting.operational_canonical_flight_legs (
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

create index if not exists idx_operational_canonical_flight_legs_ops_date
  on reporting.operational_canonical_flight_legs (ops_date);

create table if not exists reporting.operational_canonical_flight_legs_quarantine (
  ops_date date not null,
  candidate_count integer not null
);

create index if not exists idx_operational_canonical_flight_legs_quarantine_ops_date
  on reporting.operational_canonical_flight_legs_quarantine (ops_date);

create table if not exists reporting.operational_canonical_flight_legs_state (
  singleton boolean primary key default true check (singleton),
  refreshed_at timestamp with time zone not null,
  source_watermark bigint not null,
  observed_watermark bigint not null,
  ops_min_date date,
  ops_max_date date,
  leg_count integer not null,
  quarantine_count integer not null
);

comment on table reporting.operational_canonical_flight_legs is
  'M3.2 shadow projection of public.operational_flight_legs: byte-compatible with reporting.canonical_flight_legs so the M10 cutover can point the public report at either store.';
comment on table reporting.operational_canonical_flight_legs_state is
  'M3.4 freshness bookkeeping. source_watermark is the event high-water observed BEFORE the source was read: because a writer commits its leg and its event in one transaction, every event visible at that point is reflected in these rows, so the claim is sound (it may under-claim, never over-claim). observed_watermark is the high-water seen after the rows were written; a difference means a writer committed mid-refresh, which leaves the projection stale until the next run.';

revoke all on table reporting.operational_canonical_flight_legs from public, anon, authenticated;
revoke all on table reporting.operational_canonical_flight_legs_quarantine from public, anon, authenticated;
revoke all on table reporting.operational_canonical_flight_legs_state from public, anon, authenticated;
grant select on table reporting.operational_canonical_flight_legs to service_role;
grant select on table reporting.operational_canonical_flight_legs_quarantine to service_role;
grant select on table reporting.operational_canonical_flight_legs_state to service_role;

create or replace function reporting.get_operational_canonical_bounds_v1()
returns table(min_ops_date date, max_ops_date date)
language sql
stable
security definer
set search_path = pg_catalog, public, reporting, extensions, pg_temp
as $$
  select min(legs.operational_date), max(legs.operational_date)
  from public.operational_flight_legs legs
  where legs.status = 'active'
$$;

alter function reporting.get_operational_canonical_bounds_v1() owner to postgres;
revoke execute on function reporting.get_operational_canonical_bounds_v1()
  from public, anon, authenticated, service_role;

comment on function reporting.get_operational_canonical_bounds_v1()
is 'Internal active Ops Date bounds of the operational store; the shadow refresh expands them by one day on both sides, exactly like the canonical bounds.';

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

revoke execute on function reporting.refresh_operational_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.refresh_operational_canonical_legs_v1() to service_role;

comment on function reporting.refresh_operational_canonical_legs_v1()
is 'M3.2 full shadow refresh: same ranking, dedup and quarantine rules as reporting.refresh_public_traffic_canonical_legs_v1, resolved from the operational store, then records the event high-water it reached.';

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

commit;
