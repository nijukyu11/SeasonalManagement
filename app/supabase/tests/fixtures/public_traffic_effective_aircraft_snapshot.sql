-- Test-only mirror of the postcondition owned by the canonical application
-- migration 20260830193000_public_traffic_aircraft_type_snapshot.sql. The
-- report repository consumes this physical column but does not own its DDL.
create materialized view reporting.public_traffic_effective_aircraft_fixture as
select
  ranked.business_leg_key,
  ranked.ops_date,
  ranked.type,
  upper(btrim(ranked.airline)) as airline,
  upper(btrim(ranked.effective_route)) as route,
  coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
  coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown') as aircraft_group,
  coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
  ranked.local_minutes,
  (ranked.local_minutes + 1020) % 1440 as utc_minutes,
  ranked.scheduled_local_at,
  ranked.effective_pax as pax,
  case when ranked.effective_pax is not null then 'reported' else 'unknown' end as pax_status,
  ranked.authoritative_server_seq,
  statement_timestamp() as snapshot_refreshed_at,
  (select max(events.server_seq)::bigint from public.season_change_events events) as snapshot_source_watermark,
  (select coalesce(sum(quarantine.candidate_count), 0)::integer
    from reporting.public_traffic_duplicate_quarantine quarantine) as snapshot_quarantined_candidate_count
from reporting.public_traffic_ranked_candidates ranked
left join public.operational_route_countries countries
  on upper(countries.route) = upper(ranked.effective_route)
left join lateral (
  select aircraft_groups.name as ac_group
  from public.operational_aircraft_group_types aircraft_types
  join public.operational_aircraft_groups aircraft_groups
    on aircraft_groups.id = aircraft_types.group_id
  where upper(aircraft_types.aircraft_type) = upper(ranked.effective_aircraft)
  order by aircraft_groups.name
  limit 1
) groups on true
where ranked.candidate_rank = 1
  and not (
    ranked.candidate_count > 1
    and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1)
  )
  and ranked.effective_action is distinct from 'deleted';

alter materialized view reporting.public_traffic_effective
  rename to public_traffic_effective_pre_aircraft_fixture;
alter materialized view reporting.public_traffic_effective_aircraft_fixture
  rename to public_traffic_effective;
revoke all on reporting.public_traffic_effective
  from public, anon, authenticated, service_role;
