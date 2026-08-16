\set ON_ERROR_STOP on
\if :{?dry_run}
\else
  \set dry_run 1
\endif

-- Required reviewed values. Pass every value with psql -v after comparing the audit output.
\if :{?s26_season_id}
\else
  \echo 'Missing -v s26_season_id=...'
  \quit 2
\endif
\if :{?s26_keep_record_id}
\else
  \echo 'Missing -v s26_keep_record_id=...'
  \quit 2
\endif
\if :{?s26_discard_record_id}
\else
  \echo 'Missing -v s26_discard_record_id=...'
  \quit 2
\endif
\if :{?w25_season_id}
\else
  \echo 'Missing -v w25_season_id=...'
  \quit 2
\endif
\if :{?w25_expected_added_count}
\else
  \echo 'Missing -v w25_expected_added_count=...'
  \quit 2
\endif
\if :{?w25_jx703_record_id}
\else
  \echo 'Missing -v w25_jx703_record_id=...'
  \quit 2
\endif

begin;

create temp table seasonal_repair_parameters on commit drop as
select :'s26_season_id'::text as s26_season_id,
  :'s26_keep_record_id'::text as s26_keep_record_id,
  :'s26_discard_record_id'::text as s26_discard_record_id,
  :'w25_season_id'::text as w25_season_id,
  :'w25_expected_added_count'::integer as w25_expected_added_count,
  :'w25_jx703_record_id'::text as w25_jx703_record_id;

do $$
declare p record;
begin
  select * into p from seasonal_repair_parameters;
  if p.s26_keep_record_id = p.s26_discard_record_id then raise exception 'S26 keep/discard IDs must differ'; end if;
  if (select count(*) from public.season_flight_records where season_id = p.s26_season_id and record_id in (p.s26_keep_record_id, p.s26_discard_record_id)) <> 2 then
    raise exception 'Expected both reviewed S26 records';
  end if;
  if not exists (
    select 1 from public.season_flight_records keep
    join public.season_flight_records discard on discard.season_id = keep.season_id
      and discard.type = keep.type
      and coalesce(discard.scheduled_date, discard.date) = coalesce(keep.scheduled_date, keep.date)
      and discard.airline = keep.airline and discard.flight_number = keep.flight_number
    where keep.season_id = p.s26_season_id and keep.record_id = p.s26_keep_record_id and discard.record_id = p.s26_discard_record_id
  ) then raise exception 'Reviewed S26 IDs are not the same occurrence'; end if;
  if (select count(*) from public.season_flight_records where season_id = p.w25_season_id and source_kind = 'added') <> p.w25_expected_added_count then
    raise exception 'W25 added baseline count changed; rerun audit';
  end if;
  if not exists (select 1 from public.season_flight_records where season_id = p.w25_season_id and record_id = p.w25_jx703_record_id) then
    raise exception 'Reviewed W25 JX703 record is missing';
  end if;
end $$;

create schema if not exists maintenance;
create table if not exists maintenance.seasonal_repair_20260718_records as
  select now() as repair_run_at, r.* from public.season_flight_records r with no data;
create table if not exists maintenance.seasonal_repair_20260718_record_counters as
  select now() as repair_run_at, c.* from public.season_flight_record_counters c with no data;
create table if not exists maintenance.seasonal_repair_20260718_record_windows as
  select now() as repair_run_at, w.* from public.season_flight_record_checkin_windows w with no data;
create table if not exists maintenance.seasonal_repair_20260718_modifications as
  select now() as repair_run_at, m.* from public.season_modifications m with no data;

insert into maintenance.seasonal_repair_20260718_records
select now(), r.* from public.season_flight_records r, seasonal_repair_parameters p
where (r.season_id = p.s26_season_id and r.record_id = p.s26_discard_record_id)
   or r.season_id = p.w25_season_id;
insert into maintenance.seasonal_repair_20260718_record_counters
select now(), c.* from public.season_flight_record_counters c, seasonal_repair_parameters p
where c.record_id = p.s26_discard_record_id;
insert into maintenance.seasonal_repair_20260718_record_windows
select now(), w.* from public.season_flight_record_checkin_windows w, seasonal_repair_parameters p
where w.record_id = p.s26_discard_record_id;
insert into maintenance.seasonal_repair_20260718_modifications
select now(), m.* from public.season_modifications m
where not exists (select 1 from public.season_flight_records r where r.season_id = m.season_id and r.record_id = m.leg_id)
  and not exists (select 1 from public.season_modification_added_legs a where a.season_id = m.season_id and a.leg_id = m.leg_id);

delete from public.season_flight_records r using seasonal_repair_parameters p
where r.season_id = p.s26_season_id and r.record_id = p.s26_discard_record_id;

update public.season_flight_records r set source_kind = 'imported'
from seasonal_repair_parameters p
where r.season_id = p.w25_season_id and r.source_kind = 'added';

update public.season_flight_records r
set link_id = '', linked_record_id = null, link_type = null, pair_anchor_date = null, turnaround_id = null
from seasonal_repair_parameters p
where r.season_id = p.w25_season_id and r.record_id = p.w25_jx703_record_id;

with invalid_groups as (
  select season_id, turnaround_id from public.season_flight_records
  where turnaround_id is not null and status = 'active'
  group by season_id, turnaround_id having count(*) <> 2
), invalid_members as (
  select r.record_id from public.season_flight_records r
  join invalid_groups g on g.season_id = r.season_id and g.turnaround_id = r.turnaround_id
)
update public.season_flight_records r
set link_id = '', linked_record_id = null, link_type = null, pair_anchor_date = null, turnaround_id = null
where r.record_id in (select record_id from invalid_members);

delete from public.season_modifications m
where not exists (select 1 from public.season_flight_records r where r.season_id = m.season_id and r.record_id = m.leg_id)
  and not exists (select 1 from public.season_modification_added_legs a where a.season_id = m.season_id and a.leg_id = m.leg_id);

do $$
begin
  if exists (
    select 1 from public.season_flight_records r where r.status = 'active'
    group by r.season_id, r.type, coalesce(r.scheduled_date, r.date), r.airline, r.flight_number having count(*) > 1
  ) then raise exception 'Blocking duplicate base occurrences remain'; end if;
  if exists (
    select 1 from public.season_flight_records r
    left join public.season_flight_records counterpart on counterpart.season_id = r.season_id and counterpart.record_id = r.linked_record_id
    where r.linked_record_id is not null and (counterpart.record_id is null or counterpart.linked_record_id is distinct from r.record_id)
  ) then raise exception 'Blocking orphan/non-reciprocal links remain'; end if;
  if exists (
    select 1 from public.season_flight_records where turnaround_id is not null and status = 'active'
    group by season_id, turnaround_id having count(*) <> 2
  ) then raise exception 'Blocking turnaround cardinality issues remain'; end if;
end $$;

\if :dry_run
  \echo 'Dry run complete; rolling back.'
  rollback;
\else
  \echo 'Reviewed repair complete; committing.'
  commit;
\endif
