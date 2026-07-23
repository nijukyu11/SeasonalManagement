do $migration$
declare
  function_oid regprocedure := 'public.apply_season_server_mutation_v1(jsonb)'::regprocedure;
  function_definition text;
  old_fragment text := $old$
    perform public.apply_workspace_op_json(v_season_id, v_op_payload);
$old$;
  new_fragment text := $new$
    -- terminal_deleted_overlay_guard_v1: stale operational routes may not resurrect a deleted flight.
    if v_operation_type = 'modification'
      and v_source in ('allocation', 'checkin', 'daily', 'gate')
      and coalesce(v_op_payload->'mod'->>'action', 'modified') = 'modified'
      and exists (
        select 1
        from public.season_modifications existing_modification
        where existing_modification.season_id = v_season_id
          and existing_modification.leg_id = v_op_payload->'mod'->>'legId'
          and existing_modification.action = 'deleted'
      )
    then
      raise exception 'Flight % has been deleted; refresh server data before editing allocations',
        v_op_payload->'mod'->>'legId'
        using errcode = 'P0001';
    end if;

    perform public.apply_workspace_op_json(v_season_id, v_op_payload);
$new$;
begin
  select pg_get_functiondef(function_oid)
  into function_definition;

  if position('terminal_deleted_overlay_guard_v1' in function_definition) > 0 then
    return;
  end if;

  if position(old_fragment in function_definition) = 0 then
    raise exception 'apply_season_server_mutation_v1 did not match the reviewed workspace operation seam';
  end if;

  function_definition := replace(function_definition, old_fragment, new_fragment);

  if position('terminal_deleted_overlay_guard_v1' in function_definition) = 0 then
    raise exception 'Deleted-overlay guard replacement was incomplete';
  end if;

  execute function_definition;
end
$migration$;

notify pgrst, 'reload schema';
