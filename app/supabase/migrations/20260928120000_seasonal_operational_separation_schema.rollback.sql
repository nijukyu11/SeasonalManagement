-- Rollback M1: Seasonal / Operational separation schema.
--
-- Refuses to drop the new tables while they still hold rows, so a rollback is
-- never a silent data loss once M2 (backfill) or later milestones have run.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $guard$
declare
  v_tables text[] := array[
    'seasonal_flight_drafts',
    'seasonal_draft_events',
    'operational_flight_legs',
    'operational_day_authority',
    'operational_day_authority_events',
    'seasonal_publish_versions',
    'seasonal_publish_snapshots',
    'seasonal_publish_diff_entries'
  ];
  v_name text;
  v_count bigint;
  v_populated text := '';
begin
  foreach v_name in array v_tables loop
    if to_regclass(format('public.%I', v_name)) is null then
      continue;
    end if;
    execute format('select count(*) from public.%I', v_name) into v_count;
    if v_count > 0 then
      v_populated := v_populated
        || case when v_populated = '' then '' else ', ' end
        || v_name || '=' || v_count::text;
    end if;
  end loop;

  if v_populated <> '' then
    raise exception 'M1 rollback refused: % still hold rows', v_populated;
  end if;
end;
$guard$;

drop table if exists public.seasonal_publish_diff_entries;
drop table if exists public.seasonal_publish_snapshots;
drop table if exists public.operational_leg_quarantine;
drop table if exists public.operational_flight_legs;
drop table if exists public.seasonal_publish_versions;
drop table if exists public.operational_day_authority_events;
drop table if exists public.operational_day_authority;
drop table if exists public.seasonal_draft_events;
drop table if exists public.seasonal_flight_drafts;
drop function if exists public.seasonal_publish_version_tag(text, date, integer);

commit;
