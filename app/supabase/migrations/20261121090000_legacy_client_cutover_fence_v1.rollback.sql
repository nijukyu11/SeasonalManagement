-- Rollback: restore the original legacy workspace entry points under their names.
begin;
set local lock_timeout = '5s';

do $$
declare
  v_spec record;
begin
  for v_spec in
    select * from (values
      ('get_season_workspace_snapshot', 'text, integer'),
      ('get_season_change_event_page', 'text, bigint, bigint, integer'),
      ('get_season_schedule_allocation_window_v2', 'text, text, text, text, integer, text, text, smallint, integer, bigint'),
      ('sync_season_workspace', 'text, integer, jsonb'),
      ('sync_season_workspace_v2', 'text, text, bigint, jsonb')
    ) as specs(name, identity_args)
  loop
    if to_regprocedure(format('public.%I(%s)', 'legacy_precutover_' || v_spec.name, v_spec.identity_args)) is null then
      continue;
    end if;
    execute format('drop function if exists public.%I(%s)', v_spec.name, v_spec.identity_args);
    execute format('alter function public.%I(%s) rename to %I',
      'legacy_precutover_' || v_spec.name, v_spec.identity_args, v_spec.name);
  end loop;
end;
$$;

drop function if exists public.assert_legacy_workspace_client_allowed_v1();

commit;
