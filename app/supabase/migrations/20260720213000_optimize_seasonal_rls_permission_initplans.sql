-- Evaluate stable operator permission checks once per statement instead of once per row.
-- The scalar subqueries become PostgreSQL InitPlans while preserving the existing RBAC result.

do $$
declare
  table_name text;
  read_tables text[] := array[
    'seasons',
    'season_source_rows',
    'season_source_row_days',
    'season_flight_records',
    'season_flight_record_counters',
    'season_flight_record_checkin_windows',
    'season_modifications',
    'season_modification_counters',
    'season_modification_checkin_windows',
    'season_modification_added_legs',
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes',
    'season_change_events',
    'schedule_notification_deliveries',
    'season_entity_versions'
  ];
  overlay_write_tables text[] := array[
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes',
    'season_modification_added_legs'
  ];
  checkin_write_tables text[] := array[
    'season_modification_counters',
    'season_modification_checkin_windows'
  ];
  base_write_expression text :=
    '(select public.app_operator_has_permission(''seasonal.write''))'
    || ' or (select public.app_operator_has_permission(''detailed.write''))'
    || ' or (select public.app_operator_has_permission(''daily.write''))';
  checkin_write_expression text;
  modification_write_expression text;
begin
  checkin_write_expression := base_write_expression
    || ' or (select public.app_operator_has_permission(''checkin.write''))';
  modification_write_expression := checkin_write_expression
    || ' or (select public.app_operator_has_permission(''gate.write''))';

  foreach table_name in array read_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'seasonal baseline read'
    ) then
      execute format(
        'alter policy "seasonal baseline read" on public.%I using ((select public.app_operator_has_permission(''seasonal.read'')))',
        table_name
      );
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'seasonal overlay read'
    ) then
      execute format(
        'alter policy "seasonal overlay read" on public.%I using ((select public.app_operator_has_permission(''seasonal.read'')))',
        table_name
      );
    end if;

    -- Keep older clean-schema deployments efficient until their permission-specific policy cutover.
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'app operators can read'
    ) then
      execute format(
        'alter policy "app operators can read" on public.%I using ((select public.is_app_operator()))',
        table_name
      );
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'app operators can write'
    ) then
      execute format(
        'alter policy "app operators can write" on public.%I using ((select public.is_app_operator())) with check ((select public.is_app_operator()))',
        table_name
      );
    end if;
  end loop;

  foreach table_name in array overlay_write_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'permissioned operational overlay writes'
    ) then
      execute format(
        'alter policy "permissioned operational overlay writes" on public.%I using (%s) with check (%s)',
        table_name,
        base_write_expression,
        base_write_expression
      );
    end if;
  end loop;

  foreach table_name in array checkin_write_tables
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = table_name
        and policyname = 'permissioned operational overlay writes'
    ) then
      execute format(
        'alter policy "permissioned operational overlay writes" on public.%I using (%s) with check (%s)',
        table_name,
        checkin_write_expression,
        checkin_write_expression
      );
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'season_modifications'
      and policyname = 'permissioned operational overlay writes'
  ) then
    execute format(
      'alter policy "permissioned operational overlay writes" on public.season_modifications using (%s) with check (%s)',
      modification_write_expression,
      modification_write_expression
    );
  end if;
end $$;
