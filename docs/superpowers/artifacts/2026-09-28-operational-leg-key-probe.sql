\pset pager off
select version() as pg_version \gset
select :'pg_version' as pg_version;
select 'active_legs' as metric, count(*)::text as value from public.season_flight_records where status='active'
union all select 'dup_day_side_airline_flight_time', count(*)::text from (
  select 1 from public.season_flight_records where status='active'
  group by operational_date, source_side, upper(airline), upper(flight_number), scheduled_time having count(*) > 1) d
union all select 'dup_day_side_airline_flight_notime', count(*)::text from (
  select 1 from public.season_flight_records where status='active'
  group by operational_date, source_side, upper(airline), upper(flight_number) having count(*) > 1) d
union all select 'dup_effective_legs', count(*)::text from (
  select 1 from reporting.canonical_effective_flight_legs
  group by operational_date, type, upper(airline), upper(flight_number) having count(*) > 1) d
union all select 'daily_scope_days', count(*)::text from public.daily_schedule_active_days
union all select 'replacement_scope_rows', count(*)::text from public.schedule_replacement_scopes
union all select 'season_flight_records_total', count(*)::text from public.season_flight_records;
select operational_date, source_side, upper(airline) as airline, upper(flight_number) as flight_number, scheduled_time, count(*) as legs
from public.season_flight_records where status='active'
group by 1,2,3,4,5 having count(*) > 1 order by 6 desc, 1 limit 12;
