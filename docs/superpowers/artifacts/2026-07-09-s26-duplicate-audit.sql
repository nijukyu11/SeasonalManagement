with params as (
  select 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'::text as s26_season_id
),
active_base_rows as (
  select r.*
  from public.season_flight_records r
  cross join params p
  where r.season_id = p.s26_season_id
    and r.status = 'active'
    and not exists (
      select 1
      from public.season_modifications m
      where m.season_id = r.season_id
        and m.leg_id = r.record_id
        and m.action = 'deleted'
    )
),
duplicate_groups as (
  select
    r.date,
    r.airline,
    r.flight_number,
    count(*)::integer as duplicate_count,
    array_agg(r.record_id order by r.record_id) as record_ids,
    jsonb_agg(to_jsonb(r) order by r.record_id) as rows
  from active_base_rows r
  group by r.date, r.airline, r.flight_number
  having count(*) > 1
)
select
  date,
  airline,
  flight_number,
  duplicate_count,
  record_ids,
  rows
from duplicate_groups
order by date, airline, flight_number;
