\pset pager off
\set ON_ERROR_STOP on

-- Read-only Seasonal import/export integrity audit. This file performs no writes.
begin transaction read only;

select 'baseline_counts' as audit_section;
select s.id as season_id, s.season_code, r.source_kind, r.status, count(*) as record_count
from public.seasons s
join public.season_flight_records r on r.season_id = s.id
group by s.id, s.season_code, r.source_kind, r.status
order by s.season_code, r.source_kind, r.status;

select 'effective_counts' as audit_section;
with effective as (
  select r.season_id, r.record_id as leg_id, r.type, coalesce(r.scheduled_date, r.date) as flight_date,
    r.airline, r.flight_number, r.source_kind
  from public.season_flight_records r
  left join public.season_modifications m on m.season_id = r.season_id and m.leg_id = r.record_id
  where r.status = 'active' and coalesce(m.action, '') <> 'deleted'
  union all
  select a.season_id, a.leg_id, a.type, coalesce(a.scheduled_date, a.date), a.airline, a.flight_number, 'added'
  from public.season_modification_added_legs a
  join public.season_modifications m on m.season_id = a.season_id and m.leg_id = a.leg_id and m.action = 'added'
)
select s.id as season_id, s.season_code, e.source_kind, count(*) as effective_count
from effective e join public.seasons s on s.id = e.season_id
group by s.id, s.season_code, e.source_kind
order by s.season_code, e.source_kind;

select 'duplicate_base_occurrences' as audit_section;
select s.id as season_id, s.season_code, r.type, coalesce(r.scheduled_date, r.date) as flight_date,
  r.airline, r.flight_number, array_agg(r.record_id order by r.record_id) as record_ids, count(*) as duplicate_count
from public.season_flight_records r join public.seasons s on s.id = r.season_id
where r.status = 'active'
group by s.id, s.season_code, r.type, coalesce(r.scheduled_date, r.date), r.airline, r.flight_number
having count(*) > 1
order by s.season_code, flight_date, r.airline, r.flight_number, r.type;

select 'duplicate_effective_occurrences' as audit_section;
with effective as (
  select r.season_id, r.record_id as leg_id, r.type, coalesce(r.scheduled_date, r.date) as flight_date, r.airline, r.flight_number
  from public.season_flight_records r
  left join public.season_modifications m on m.season_id = r.season_id and m.leg_id = r.record_id
  where r.status = 'active' and coalesce(m.action, '') <> 'deleted'
  union all
  select a.season_id, a.leg_id, a.type, coalesce(a.scheduled_date, a.date), a.airline, a.flight_number
  from public.season_modification_added_legs a
  join public.season_modifications m on m.season_id = a.season_id and m.leg_id = a.leg_id and m.action = 'added'
)
select s.id as season_id, s.season_code, e.type, e.flight_date, e.airline, e.flight_number,
  array_agg(e.leg_id order by e.leg_id) as leg_ids, count(*) as duplicate_count
from effective e join public.seasons s on s.id = e.season_id
group by s.id, s.season_code, e.type, e.flight_date, e.airline, e.flight_number
having count(*) > 1
order by s.season_code, e.flight_date, e.airline, e.flight_number, e.type;

select 'orphan_or_nonreciprocal_links' as audit_section;
select s.id as season_id, s.season_code, r.record_id, r.type, coalesce(r.scheduled_date, r.date) as flight_date,
  r.airline, r.flight_number, r.linked_record_id, counterpart.linked_record_id as counterpart_points_to,
  case when counterpart.record_id is null then 'orphan' else 'non-reciprocal' end as issue
from public.season_flight_records r
join public.seasons s on s.id = r.season_id
left join public.season_flight_records counterpart on counterpart.season_id = r.season_id and counterpart.record_id = r.linked_record_id
where r.linked_record_id is not null
  and (counterpart.record_id is null or counterpart.linked_record_id is distinct from r.record_id)
order by s.season_code, flight_date, r.airline, r.flight_number;

select 'invalid_turnaround_cardinality' as audit_section;
select s.id as season_id, s.season_code, r.turnaround_id,
  array_agg(r.record_id order by r.record_id) as record_ids,
  string_agg(r.airline || r.flight_number || '/' || coalesce(r.scheduled_date, r.date), ', ' order by r.record_id) as flights,
  count(*) as member_count
from public.season_flight_records r join public.seasons s on s.id = r.season_id
where r.status = 'active' and r.turnaround_id is not null
group by s.id, s.season_code, r.turnaround_id
having count(*) <> 2
order by s.season_code, r.turnaround_id;

select 'orphan_modifications' as audit_section;
select s.id as season_id, s.season_code, m.leg_id, m.action
from public.season_modifications m join public.seasons s on s.id = m.season_id
left join public.season_flight_records r on r.season_id = m.season_id and r.record_id = m.leg_id
left join public.season_modification_added_legs a on a.season_id = m.season_id and a.leg_id = m.leg_id
where r.record_id is null and a.leg_id is null
order by s.season_code, m.leg_id;

select 'base_and_added_id_collision' as audit_section;
select s.id as season_id, s.season_code, r.record_id, r.airline || r.flight_number as base_flight,
  a.airline || a.flight_number as added_flight, coalesce(r.scheduled_date, r.date) as base_date,
  coalesce(a.scheduled_date, a.date) as added_date
from public.season_flight_records r
join public.season_modification_added_legs a on a.season_id = r.season_id and a.leg_id = r.record_id
join public.seasons s on s.id = r.season_id
order by s.season_code, r.record_id;

select 'non_normalized_flight_numbers' as audit_section;
select s.id as season_id, s.season_code, r.record_id, r.type, coalesce(r.scheduled_date, r.date) as flight_date,
  r.airline, r.flight_number, normalized.flight_number as expected_flight_number
from public.season_flight_records r
join public.seasons s on s.id = r.season_id
cross join lateral public.normalize_seasonal_flight_number_v2(r.airline, r.flight_number) normalized
where r.status = 'active' and r.flight_number is distinct from normalized.flight_number
order by s.season_code, flight_date, r.airline, r.flight_number;

select 'source_row_counts' as audit_section;
select s.id as season_id, s.season_code, count(sr.row_index) as source_row_count,
  count(distinct r.source_row_index) filter (where r.record_id is not null) as source_rows_with_occurrences
from public.seasons s
left join public.season_source_rows sr on sr.season_id = s.id
left join public.season_flight_records r on r.season_id = sr.season_id and r.source_row_index = sr.row_index and r.source_kind = 'imported'
group by s.id, s.season_code
order by s.season_code;

select 'source_rows_without_occurrences' as audit_section;
select s.id as season_id, s.season_code, sr.row_index,
  sr.airline, sr.effective, sr.discontinue, sr.arr_flight, sr.dep_flight, count(r.record_id) as generated_count
from public.season_source_rows sr
join public.seasons s on s.id = sr.season_id
left join public.season_flight_records r on r.season_id = sr.season_id and r.source_row_index = sr.row_index and r.source_kind = 'imported'
group by s.id, s.season_code, sr.row_index, sr.airline, sr.effective, sr.discontinue, sr.arr_flight, sr.dep_flight
having count(r.record_id) = 0
order by s.season_code, sr.row_index;

rollback;
