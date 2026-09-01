-- Parameterized canonical candidate boundary for live public traffic aggregates.
--
-- The general reporting views intentionally expose the full effective schedule.
-- A bounded public report must not build that entire graph before applying its
-- Ops Date predicate. This internal function pushes the date range into the
-- canonical active store, then applies the same operational overlay and
-- authoritative-recency rules as reporting.public_traffic_candidates.

create or replace function reporting.get_public_traffic_candidate_slice_v1(
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
with base_scope as materialized (
  select
    records.season_id,
    records.record_id,
    records.type,
    records.airline,
    records.flight_number,
    records.route as base_route,
    records.aircraft as base_aircraft,
    records.pax as base_pax,
    records.operational_date,
    coalesce(nullif(records.scheduled_date, ''), nullif(records.date, ''), '') as scheduled_date,
    coalesce(nullif(records.scheduled_time, ''), records.schedule, '') as base_scheduled_time,
    records.action as base_action,
    modifications.action as modification_action,
    coalesce(modifications.changed_fields, array[]::text[]) as changed_fields,
    modifications.schedule as modified_schedule,
    modifications.route as modified_route,
    modifications.aircraft as modified_aircraft,
    modifications.pax as modified_pax
  from public.season_flight_records records
  join public.seasons seasons on seasons.id = records.season_id
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where public.is_canonical_flight_leg_active_v1(records.status, records.action)
    and coalesce(modifications.action, 'modified') <> 'deleted'
    and (
      (
        records.operational_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        and records.operational_date between p_from_date::text and p_to_date::text
      )
      or (
        coalesce(records.operational_date, '') !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        and coalesce(nullif(records.scheduled_date, ''), nullif(records.date, ''), '')
          ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
        and coalesce(nullif(records.scheduled_date, ''), nullif(records.date, ''), '')
          between p_from_date::text and (p_to_date + 1)::text
      )
    )
), effective as (
  select
    base.season_id,
    base.record_id,
    base.type,
    upper(base.airline) as airline,
    base.flight_number,
    upper(case when 'route' = any(base.changed_fields)
      then coalesce(base.modified_route, '') else coalesce(base.base_route, '') end) as route,
    upper(case when 'aircraft' = any(base.changed_fields)
      then coalesce(base.modified_aircraft, '') else coalesce(base.base_aircraft, '') end) as aircraft,
    case when 'pax' = any(base.changed_fields) then base.modified_pax else base.base_pax end as pax,
    base.operational_date,
    base.scheduled_date,
    case when 'schedule' = any(base.changed_fields)
      then coalesce(base.modified_schedule, '') else base.base_scheduled_time end as scheduled_time,
    coalesce(base.modification_action, base.base_action, 'active') as effective_action
  from base_scope base
), parsed as (
  select
    effective.*,
    case when effective.scheduled_date ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
      then effective.scheduled_date::date end as scheduled_date_value,
    case when effective.scheduled_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
      then split_part(effective.scheduled_time, ':', 1)::integer * 60
        + substring(effective.scheduled_time from '^[0-9]{1,2}:([0-9]{2})')::integer
      end as local_minutes,
    public.canonical_flight_leg_ops_date_v1(
      effective.operational_date,
      effective.scheduled_date,
      effective.scheduled_date,
      effective.scheduled_time,
      effective.scheduled_time
    ) as ops_date
  from effective
), bounded as materialized (
  select parsed.*
  from parsed
  where parsed.ops_date between p_from_date and p_to_date
), bounded_stats as materialized (
  select count(*)::bigint as candidate_count from bounded
), entity_recency as materialized (
  select events.season_id, events.target_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  join (select distinct bounded.season_id, bounded.record_id from bounded) selected
    on selected.season_id = events.season_id and selected.record_id = events.target_id
  cross join bounded_stats
  where bounded_stats.candidate_count < 10000
  group by events.season_id, events.target_id

  union all

  select events.season_id, events.target_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  cross join bounded_stats
  where bounded_stats.candidate_count >= 10000
    and events.target_id is not null
  group by events.season_id, events.target_id
), season_recency as materialized (
  select events.season_id, max(events.server_seq)::bigint as server_seq
  from public.season_change_events events
  join (select distinct bounded.season_id from bounded) selected
    on selected.season_id = events.season_id
  where events.target_type in ('seasonImport', 'dailyImport', 'dailyAuthority')
  group by events.season_id
)
select
  bounded.season_id,
  bounded.record_id,
  bounded.type,
  bounded.airline,
  bounded.flight_number,
  bounded.route,
  bounded.aircraft,
  bounded.pax,
  bounded.scheduled_date,
  bounded.scheduled_time,
  bounded.route as effective_route,
  bounded.aircraft as effective_aircraft,
  bounded.pax as effective_pax,
  bounded.effective_action,
  bounded.scheduled_date_value,
  bounded.local_minutes,
  coalesce(entity_recency.server_seq, season_recency.server_seq) as authoritative_server_seq,
  bounded.ops_date,
  case when bounded.scheduled_date_value is null or bounded.local_minutes is null then null::timestamp
    else bounded.scheduled_date_value::timestamp + make_interval(mins => bounded.local_minutes) end
    as scheduled_local_at,
  upper(btrim(bounded.type)) || chr(31) || bounded.scheduled_date || chr(31)
    || upper(btrim(bounded.airline)) || chr(31) || upper(btrim(bounded.flight_number))
    as business_leg_key
from bounded
left join entity_recency
  on entity_recency.season_id = bounded.season_id
 and entity_recency.target_id = bounded.record_id
left join season_recency on season_recency.season_id = bounded.season_id
$$;

alter function reporting.get_public_traffic_candidate_slice_v1(date, date) owner to postgres;
revoke execute on function reporting.get_public_traffic_candidate_slice_v1(date, date)
  from public, anon, authenticated, service_role;

comment on function reporting.get_public_traffic_candidate_slice_v1(date, date)
is 'Internal bounded canonical effective candidate seam for public traffic live aggregates.';

create or replace function reporting.get_public_traffic_canonical_bounds_v1()
returns table(min_ops_date date, max_ops_date date)
language sql
stable
security definer
set search_path = pg_catalog, public, reporting, extensions, pg_temp
as $$
  select
    min(public.canonical_flight_leg_ops_date_v1(
      records.operational_date,
      records.scheduled_date,
      records.date,
      case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
        then modifications.schedule else records.scheduled_time end,
      case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
        then modifications.schedule else records.schedule end
    )),
    max(public.canonical_flight_leg_ops_date_v1(
      records.operational_date,
      records.scheduled_date,
      records.date,
      case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
        then modifications.schedule else records.scheduled_time end,
      case when 'schedule' = any(coalesce(modifications.changed_fields, array[]::text[]))
        then modifications.schedule else records.schedule end
    ))
  from public.season_flight_records records
  join public.seasons seasons on seasons.id = records.season_id
  left join public.season_modifications modifications
    on modifications.season_id = records.season_id
   and modifications.leg_id = records.record_id
  where public.is_canonical_flight_leg_active_v1(records.status, records.action)
    and coalesce(modifications.action, 'modified') <> 'deleted'
$$;

alter function reporting.get_public_traffic_canonical_bounds_v1() owner to postgres;
revoke execute on function reporting.get_public_traffic_canonical_bounds_v1()
  from public, anon, authenticated, service_role;

comment on function reporting.get_public_traffic_canonical_bounds_v1()
is 'Internal canonical active Ops Date bounds for public traffic live aggregates.';
