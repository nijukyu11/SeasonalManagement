-- Public traffic candidates must consume the canonical effective boundary.
-- Reading physical base/history rows here causes the ranking quarantine to
-- suppress valid Daily legs after an atomic replacement.

create or replace view reporting.public_traffic_candidates as
with entity_recency as materialized (
  select events.season_id,events.target_id,max(events.server_seq) as server_seq
  from public.season_change_events events
  where events.target_id is not null
  group by events.season_id,events.target_id
), season_recency as materialized (
  select events.season_id,max(events.server_seq) as server_seq
  from public.season_change_events events
  where events.target_type in ('seasonImport','dailyImport','dailyAuthority')
  group by events.season_id
), parsed as (
  select
    canonical.season_id,canonical.record_id,canonical.type,canonical.airline,
    canonical.flight_number,canonical.route,canonical.aircraft,canonical.pax,
    coalesce(nullif(canonical.scheduled_date,''),nullif(canonical.date,''),'') as scheduled_date,
    coalesce(nullif(canonical.scheduled_time,''),canonical.schedule,'') as scheduled_time,
    canonical.route as effective_route,canonical.aircraft as effective_aircraft,
    canonical.pax as effective_pax,coalesce(canonical.action,'active') as effective_action,
    case when coalesce(nullif(canonical.scheduled_date,''),nullif(canonical.date,''),'')
      ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
      then coalesce(nullif(canonical.scheduled_date,''),nullif(canonical.date,''))::date
      else null::date end as scheduled_date_value,
    case when coalesce(nullif(canonical.scheduled_time,''),canonical.schedule,'')
      ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]'
      then split_part(coalesce(nullif(canonical.scheduled_time,''),canonical.schedule),':',1)::integer*60
        + substring(coalesce(nullif(canonical.scheduled_time,''),canonical.schedule)
          from '^[0-9]{1,2}:([0-9]{2})')::integer
      else null::integer end as local_minutes,
    coalesce(entity_recency.server_seq,season_recency.server_seq) as authoritative_server_seq,
    public.canonical_flight_leg_ops_date_v1(
      canonical.operational_date,canonical.scheduled_date,canonical.date,
      canonical.scheduled_time,canonical.schedule
    ) as ops_date
  from reporting.canonical_effective_flight_legs canonical
  left join entity_recency
    on entity_recency.season_id=canonical.season_id
   and entity_recency.target_id=canonical.record_id
  left join season_recency on season_recency.season_id=canonical.season_id
)
select
  season_id,record_id,type,airline,flight_number,route,aircraft,pax,
  scheduled_date,scheduled_time,effective_route,effective_aircraft,effective_pax,
  effective_action,scheduled_date_value,local_minutes,authoritative_server_seq,
  ops_date,
  case when scheduled_date_value is null or local_minutes is null then null::timestamp
    else scheduled_date_value::timestamp+make_interval(mins=>local_minutes) end as scheduled_local_at,
  upper(btrim(type))||chr(31)||scheduled_date||chr(31)||upper(btrim(airline))
    ||chr(31)||upper(btrim(flight_number)) as business_leg_key
from parsed;

alter view reporting.public_traffic_candidates set (security_invoker=true);
