-- S26 duplicate flight-record repair.
-- Dry-run safety: this script ends with ROLLBACK. After reviewing both result
-- sets, replace the final ROLLBACK with COMMIT to apply the repair.

begin;

create schema if not exists maintenance;

create table if not exists maintenance.s26_duplicate_flight_records_backup_20260709 as
select
  r.season_id,
  r.record_id,
  r.link_id,
  r.type,
  r.airline,
  r.flight_number,
  r.raw_flight_number,
  r.request_status_code,
  r.route,
  r.schedule,
  r.aircraft,
  r.category,
  r.code_shares,
  r.int_dom_ind,
  r.pax,
  r.gate,
  r.stand,
  r.carousel,
  r.mct,
  r.fb,
  r.lb,
  r.bhs,
  r.ghs,
  r.date,
  r.scheduled_date,
  r.scheduled_time,
  r.operational_date,
  r.iata_season_code,
  r.flight_series_id,
  r.day_of_week,
  r.action,
  r.source_row_index,
  r.linked_source_row_index,
  r.link_type,
  r.pair_anchor_date,
  r.linked_record_id,
  r.source_kind,
  r.source_side,
  r.status,
  r.turnaround_id,
  transaction_timestamp()::timestamptz as backed_up_at
from public.season_flight_records r
where false;

create temporary table s26_duplicate_repair_target_ids (
  record_id text primary key
) on commit drop;

insert into s26_duplicate_repair_target_ids (record_id)
values
  ('F_NEW_1780654155050_bl6lzj_1'),
  ('F_NEW_1780654322186_li75di_1'),
  ('F_NEW_1780654155050_bl6lzj_2'),
  ('F_NEW_1780654322186_li75di_2'),
  ('F_NEW_1780654155050_bl6lzj_4'),
  ('F_NEW_1780654322186_li75di_4'),
  ('F_NEW_1780654155050_bl6lzj_5'),
  ('F_NEW_1780654322186_li75di_5'),
  ('F_NEW_1780796888039_giomqg_2');

create temporary table s26_duplicate_repair_target_records on commit drop as
select r.*
from public.season_flight_records r
join s26_duplicate_repair_target_ids t on t.record_id = r.record_id
where r.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6';

do $$
declare
  v_target_count integer;
  v_added_count integer;
begin
  select count(*)::integer
  into v_target_count
  from s26_duplicate_repair_target_records;

  if v_target_count <> 9 then
    raise exception 'Expected exactly 9 S26 duplicate target rows in season_flight_records, found %. Aborting.', v_target_count;
  end if;

  select count(*)::integer
  into v_added_count
  from s26_duplicate_repair_target_records
  where source_kind = 'added';

  if v_added_count <> 9 then
    raise exception 'Expected all 9 S26 duplicate target rows to have source_kind = ''added'', found %. Aborting.', v_added_count;
  end if;
end $$;

create temporary table s26_duplicate_repair_counts (
  metric text primary key,
  row_count integer not null
) on commit drop;

with inserted_backup_rows as (
  insert into maintenance.s26_duplicate_flight_records_backup_20260709 (
    season_id,
    record_id,
    link_id,
    type,
    airline,
    flight_number,
    raw_flight_number,
    request_status_code,
    route,
    schedule,
    aircraft,
    category,
    code_shares,
    int_dom_ind,
    pax,
    gate,
    stand,
    carousel,
    mct,
    fb,
    lb,
    bhs,
    ghs,
    date,
    scheduled_date,
    scheduled_time,
    operational_date,
    iata_season_code,
    flight_series_id,
    day_of_week,
    action,
    source_row_index,
    linked_source_row_index,
    link_type,
    pair_anchor_date,
    linked_record_id,
    source_kind,
    source_side,
    status,
    turnaround_id,
    backed_up_at
  )
  select
    r.season_id,
    r.record_id,
    r.link_id,
    r.type,
    r.airline,
    r.flight_number,
    r.raw_flight_number,
    r.request_status_code,
    r.route,
    r.schedule,
    r.aircraft,
    r.category,
    r.code_shares,
    r.int_dom_ind,
    r.pax,
    r.gate,
    r.stand,
    r.carousel,
    r.mct,
    r.fb,
    r.lb,
    r.bhs,
    r.ghs,
    r.date,
    r.scheduled_date,
    r.scheduled_time,
    r.operational_date,
    r.iata_season_code,
    r.flight_series_id,
    r.day_of_week,
    r.action,
    r.source_row_index,
    r.linked_source_row_index,
    r.link_type,
    r.pair_anchor_date,
    r.linked_record_id,
    r.source_kind,
    r.source_side,
    r.status,
    r.turnaround_id,
    transaction_timestamp()::timestamptz as backed_up_at
  from s26_duplicate_repair_target_records r
  returning record_id
)
insert into s26_duplicate_repair_counts (metric, row_count)
select 'backed_up_records', count(*)::integer
from inserted_backup_rows;

with deleted_counter_rows as (
  delete from public.season_flight_record_counters c
  using s26_duplicate_repair_target_records t
  where c.record_id = t.record_id
  returning c.record_id
)
insert into s26_duplicate_repair_counts (metric, row_count)
select 'deleted_counter_rows', count(*)::integer
from deleted_counter_rows;

with deleted_window_rows as (
  delete from public.season_flight_record_checkin_windows w
  using s26_duplicate_repair_target_records t
  where w.record_id = t.record_id
  returning w.record_id
)
insert into s26_duplicate_repair_counts (metric, row_count)
select 'deleted_window_rows', count(*)::integer
from deleted_window_rows;

with deleted_records as (
  delete from public.season_flight_records r
  using s26_duplicate_repair_target_records t
  where r.record_id = t.record_id
    and r.season_id = 'season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6'
    and r.source_kind = 'added'
  returning r.record_id
)
insert into s26_duplicate_repair_counts (metric, row_count)
select 'deleted_records', count(*)::integer
from deleted_records;

select
  max(row_count) filter (where metric = 'backed_up_records') as backed_up_records,
  max(row_count) filter (where metric = 'deleted_counter_rows') as deleted_counter_rows,
  max(row_count) filter (where metric = 'deleted_window_rows') as deleted_window_rows,
  max(row_count) filter (where metric = 'deleted_records') as deleted_records
from s26_duplicate_repair_counts;

-- Remaining duplicate groups after deletion inside the transaction.
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
    array_agg(r.record_id order by r.record_id) as record_ids
  from active_base_rows r
  group by r.date, r.airline, r.flight_number
  having count(*) > 1
)
select
  date,
  airline,
  flight_number,
  duplicate_count,
  record_ids
from duplicate_groups
order by date, airline, flight_number;

rollback;
-- commit;
