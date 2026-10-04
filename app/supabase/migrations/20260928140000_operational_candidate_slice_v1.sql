-- M3.1 shadow candidate boundary: the operational store re-expressed with the
-- exact column set of reporting.get_public_traffic_candidate_slice_v1 so the
-- shadow projection (M3.2) can reuse the canonical resolution SQL verbatim
-- while the public report keeps reading the legacy chain until gate M10.
--
-- Semantic mapping from public.operational_flight_legs:
--   * business_leg_key is canonical ([A|D]|scheduled_date|AIRLINE|FLIGHT),
--     byte-identical to reporting.canonical_flight_legs.business_leg_key.
--     (storage leg_key uses operational_date; canonical resolution keys on scheduled_date).
--   * ops_date is the stored operational_date: the 05:00-04:59 rule and the
--     effective overlay are already applied by the writer, so this seam only
--     re-projects, never recomputes, them.
--   * effective_* equal the row values (a leg row *is* the effective value) and
--     effective_action is 'active' because only active legs are candidates;
--     pax stays NULL when unknown, exactly as the canonical slice keeps it.
--   * season_id/record_id are lineage (source_season_id, NULL for daily legs)
--     and the operational identity (leg_id) that M4.2+ writes as
--     season_change_events.target_id.
--   * authoritative_server_seq is native entity recency (events targeting this leg),
--     falling back to native day recency (target_type='dailyAuthority' targeting the
--     operational date, emitted by the daily authority writer from M5 on),
--     falling back to historical authoritative recency captured from the legacy source row
--     at M2 backfill (operational_leg_backfill_links.authoritative_server_seq).
--     Ties stay ties: duplicate active legs of one business key must surface as
--     ambiguous instead of being silently resolved by time proximity.

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
