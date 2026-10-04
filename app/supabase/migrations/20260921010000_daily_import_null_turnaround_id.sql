-- Migration: 20260921010000_daily_import_null_turnaround_id.sql
-- Fixes seasonal export blocking issue: daily imported legs mistakenly stored loose_occurrence_key
-- in turnaround_id, causing resolveSeasonalPairs() to consider them broken turnaround pairs.
-- Sets turnaround_id to NULL for all daily rows and updates commit_daily_schedule_import_v1
-- to insert NULL for turnaround_id.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $migration$
declare
  v_def text;
  v_old text;
  v_new text;
  v_updated bigint;
begin
  select pg_catalog.replace(
    pg_get_functiondef('public.commit_daily_schedule_import_v1(uuid,jsonb,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  ) into v_def;

  v_old := '      ''daily'',legs.side,''active'',legs.loose_occurrence_key,legs.batch_id,';
  v_new := '      ''daily'',legs.side,''active'',null,legs.batch_id,';

  if strpos(v_def, v_old) = 0 then
    raise exception 'Preimage mismatch for commit_daily_schedule_import_v1';
  end if;

  v_def := replace(v_def, v_old, v_new);
  execute v_def;

  -- Repair existing records
  update public.season_flight_records
  set turnaround_id = null
  where source_kind = 'daily'
    and turnaround_id is not null;

  get diagnostics v_updated = row_count;
  raise notice 'Updated % daily records with NULL turnaround_id', v_updated;

  if exists (
    select 1 from public.season_flight_records
    where source_kind = 'daily' and turnaround_id is not null
  ) then
    raise exception 'Post-condition failed: daily records with non-null turnaround_id remain';
  end if;
end $migration$;

commit;
