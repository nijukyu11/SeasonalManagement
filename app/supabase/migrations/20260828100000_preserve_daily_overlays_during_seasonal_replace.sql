create or replace function public.preserve_daily_overlay_during_seasonal_replace_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_bulk_season_id text := nullif(pg_catalog.current_setting('app.seasonal_import_v3_bulk_season_id', true), '');
begin
  if v_bulk_season_id is null or old.season_id is distinct from v_bulk_season_id then
    return old;
  end if;

  if tg_table_name = 'season_modifications' then
    if exists (
      select 1
      from public.daily_schedule_active_days active
      join public.daily_schedule_import_batch_legs legs
        on legs.batch_id=active.batch_id and legs.season_id=active.season_id and legs.operational_date=active.operational_date
      where active.season_id=old.season_id and legs.effective_record_id=old.leg_id
    ) then return null; end if;
  elsif tg_table_name = 'season_mod_history_entries' then
    if exists (
      select 1
      from public.season_mod_history_changes changes
      join public.daily_schedule_import_batch_legs legs on legs.effective_record_id=changes.leg_id
      join public.daily_schedule_active_days active
        on active.batch_id=legs.batch_id and active.season_id=legs.season_id and active.operational_date=legs.operational_date
      where changes.entry_id=old.entry_id and active.season_id=old.season_id
    ) then return null; end if;
  elsif tg_table_name = 'season_entity_versions' then
    if exists (
      select 1
      from public.daily_schedule_active_days active
      join public.daily_schedule_import_batch_legs legs
        on legs.batch_id=active.batch_id and legs.season_id=active.season_id and legs.operational_date=active.operational_date
      where active.season_id=old.season_id and legs.effective_record_id=old.target_id
    ) then return null; end if;
  end if;

  return old;
end;
$$;

revoke all on function public.preserve_daily_overlay_during_seasonal_replace_v1() from public;

drop trigger if exists preserve_daily_overlay_on_seasonal_replace_v1 on public.season_modifications;
create trigger preserve_daily_overlay_on_seasonal_replace_v1
before delete on public.season_modifications
for each row execute function public.preserve_daily_overlay_during_seasonal_replace_v1();

drop trigger if exists preserve_daily_history_on_seasonal_replace_v1 on public.season_mod_history_entries;
create trigger preserve_daily_history_on_seasonal_replace_v1
before delete on public.season_mod_history_entries
for each row execute function public.preserve_daily_overlay_during_seasonal_replace_v1();

drop trigger if exists preserve_daily_entity_version_on_seasonal_replace_v1 on public.season_entity_versions;
create trigger preserve_daily_entity_version_on_seasonal_replace_v1
before delete on public.season_entity_versions
for each row execute function public.preserve_daily_overlay_during_seasonal_replace_v1();
