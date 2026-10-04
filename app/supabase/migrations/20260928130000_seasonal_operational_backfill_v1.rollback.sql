-- Rollback M2: backfill objects. Run before the M1 rollback (reverse chain order):
-- the M2 tables reference M1 tables, so M1 cannot drop cleanly while they exist.
--
-- Refuses to drop anything while a backfill run is recorded, because that means
-- drafts, operational legs and baseline versions were already written and the
-- M1 rollback guard would refuse anyway.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $guard$
declare
  v_runs bigint;
  v_links bigint;
begin
  if to_regclass('public.seasonal_operational_backfill_runs') is not null then
    execute 'select count(*) from public.seasonal_operational_backfill_runs' into v_runs;
    if v_runs > 0 then
      raise exception 'M2 rollback refused: seasonal_operational_backfill_runs=% backfill run(s) recorded', v_runs;
    end if;
  end if;

  if to_regclass('public.operational_leg_backfill_links') is not null then
    execute 'select count(*) from public.operational_leg_backfill_links' into v_links;
    if v_links > 0 then
      raise exception 'M2 rollback refused: operational_leg_backfill_links=% row(s) recorded', v_links;
    end if;
  end if;
end;
$guard$;

drop function if exists public.run_seasonal_operational_backfill_v1(date, uuid, bigint);
drop function if exists public.backfill_operational_day_authority_v1(uuid);
drop function if exists public.backfill_operational_flight_legs_v1(uuid);
drop function if exists public.seed_seasonal_baseline_versions_v1(uuid, date, uuid);
drop function if exists public.backfill_seasonal_flight_drafts_v1(uuid);
drop function if exists public.seasonal_backfill_identity_date_v1(text, text, text);
drop function if exists public.seasonal_draft_id_v1(text, text, date, text, text);

alter table public.seasonal_publish_versions
  drop column if exists backfill_run_id;

drop table if exists public.operational_leg_backfill_links;
drop table if exists public.seasonal_operational_backfill_runs;

commit;
