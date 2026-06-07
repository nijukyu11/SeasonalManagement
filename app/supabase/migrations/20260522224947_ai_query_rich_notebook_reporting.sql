create or replace view reporting.flight_operations as
select
  r.season_id,
  coalesce(r.iata_season_code, s.season_code, '') as season,
  r.record_id,
  r.flight_series_id,
  r.turnaround_id,
  r.type,
  r.flight_number as flight,
  r.airline,
  r.route,
  coalesce(rc.country, '') as country,
  r.aircraft,
  r.pax,
  r.date as scheduled_date,
  r.schedule as scheduled_time,
  coalesce(r.operational_date, r.date) as ops_date,
  to_char(to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'), 'YYYY-MM') as month,
  extract(week from to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'))::integer as iso_week,
  nullif(split_part(r.schedule, ':', 1), '')::integer as local_hour,
  ((nullif(split_part(r.schedule, ':', 1), '')::integer + 17) % 24) as utc_hour,
  extract(dow from to_date(nullif(coalesce(r.operational_date, r.date), ''), 'YYYY-MM-DD'))::integer as weekday,
  r.status,
  r.gate,
  r.stand,
  r.carousel,
  r.source_kind,
  r.source_side,
  s.season_code,
  r.iata_season_code
from public.season_flight_records r
left join public.seasons s on s.id = r.season_id
left join public.operational_route_countries rc on rc.route = r.route
where r.status <> 'deleted';

alter view reporting.flight_operations set (security_invoker = true);
alter view reporting.summary_airline set (security_invoker = true);
alter view reporting.summary_country set (security_invoker = true);
alter view reporting.summary_route set (security_invoker = true);
alter view reporting.summary_month set (security_invoker = true);
alter view reporting.summary_week set (security_invoker = true);
alter view reporting.summary_peak_hour set (security_invoker = true);
alter view reporting.summary_aircraft set (security_invoker = true);
alter view reporting.summary_arr_dep_mix set (security_invoker = true);

grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;
