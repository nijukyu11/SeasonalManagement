-- Legacy desktop-client fence after the M10 operational reader cutover.
--
-- M10 fences legacy *writers* with BEFORE triggers, but the legacy workspace
-- *readers* keep returning season_flight_records/season_modifications, which
-- stop changing at cutover. A desktop build with the V1 flags OFF would show
-- frozen schedules, Pax and resources without any warning.
--
-- Rule: while the cutover gate is active, every legacy workspace reader/sync
-- entry point fails closed with 55000 CLIENT_UPGRADE_REQUIRED. Every season has
-- a Planning draft workspace (seasonal_draft_workspace_season_insert), and the
-- V1 desktop client never calls these entry points, so only outdated builds hit
-- the fence. Reversing the cutover restores the legacy reads.
--
-- Each entry point keeps its exact name, signature, defaults and EXECUTE ACL
-- as a thin wrapper over the renamed, unchanged original body.
begin;
set local lock_timeout = '5s';

create or replace function public.assert_legacy_workspace_client_allowed_v1()
returns void
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
begin
  if reporting.is_operational_reader_cutover_active_v1() then
    raise exception 'CLIENT_UPGRADE_REQUIRED: Lịch bay đã chuyển sang Kế hoạch/Vận hành mới. Phiên bản ứng dụng này chỉ đọc được dữ liệu cũ đã đóng băng; vui lòng cập nhật ứng dụng lên phiên bản mới nhất rồi mở lại.'
      using errcode = '55000', hint = 'legacy_workspace_client_fenced';
  end if;
end;
$$;
revoke all on function public.assert_legacy_workspace_client_allowed_v1() from public, anon;
grant execute on function public.assert_legacy_workspace_client_allowed_v1() to authenticated, service_role;

do $$
declare
  v_spec record;
  v_original regprocedure;
  v_wrapper regprocedure;
  v_acl record;
begin
  for v_spec in
    select * from (values
      ('get_season_workspace_snapshot', 'text, integer',
       'p_season_id text, p_mod_history_limit integer default 50',
       'p_season_id, p_mod_history_limit'),
      ('get_season_change_event_page', 'text, bigint, bigint, integer',
       'p_season_id text, p_after_seq bigint, p_through_seq bigint, p_limit integer default 200',
       'p_season_id, p_after_seq, p_through_seq, p_limit'),
      ('get_season_schedule_allocation_window_v2', 'text, text, text, text, integer, text, text, smallint, integer, bigint',
       'p_season_id text, p_start_date text default null, p_end_date text default null, p_resource_type text default ''all'', p_page_size integer default 500, p_after_effective_date text default null, p_after_root_id text default null, p_after_root_kind smallint default null, p_expected_data_version integer default null, p_expected_server_high_water bigint default null',
       'p_season_id, p_start_date, p_end_date, p_resource_type, p_page_size, p_after_effective_date, p_after_root_id, p_after_root_kind, p_expected_data_version, p_expected_server_high_water'),
      ('sync_season_workspace', 'text, integer, jsonb',
       'p_season_id text, p_base_version integer, p_pending_ops jsonb',
       'p_season_id, p_base_version, p_pending_ops'),
      ('sync_season_workspace_v2', 'text, text, bigint, jsonb',
       'p_season_id text, p_client_id text, p_base_server_seq bigint, p_pending_events jsonb',
       'p_season_id, p_client_id, p_base_server_seq, p_pending_events')
    ) as specs(name, identity_args, declared_args, call_args)
  loop
    v_original := format('public.%I(%s)', v_spec.name, v_spec.identity_args)::regprocedure;
    if pg_catalog.pg_get_function_result(v_original) <> 'jsonb' then
      raise exception 'legacy client fence expects % to return jsonb', v_original using errcode = '42P13';
    end if;

    execute format('alter function %s rename to %I', v_original, 'legacy_precutover_' || v_spec.name);
    execute format($fn$
      create function public.%1$I(%2$s)
      returns jsonb
      language plpgsql
      security invoker
      set search_path = pg_catalog, public
      as $body$
      begin
        perform public.assert_legacy_workspace_client_allowed_v1();
        return public.%3$I(%4$s);
      end;
      $body$
    $fn$, v_spec.name, v_spec.declared_args, 'legacy_precutover_' || v_spec.name, v_spec.call_args);

    v_wrapper := format('public.%I(%s)', v_spec.name, v_spec.identity_args)::regprocedure;
    v_original := format('public.%I(%s)', 'legacy_precutover_' || v_spec.name, v_spec.identity_args)::regprocedure;
    -- Defaults are part of the PostgREST contract: fail the migration on any drift.
    if pg_catalog.pg_get_function_arguments(v_wrapper) <> pg_catalog.pg_get_function_arguments(v_original) then
      raise exception 'legacy client fence changed the argument contract of %: % <> %', v_spec.name,
        pg_catalog.pg_get_function_arguments(v_wrapper), pg_catalog.pg_get_function_arguments(v_original)
        using errcode = '42P13';
    end if;

    -- Mirror the original EXECUTE grantees exactly (PUBLIC only if the original had it).
    execute format('revoke all on function %s from public', v_wrapper);
    for v_acl in
      select case when acl.grantee = 0 then 'public' else quote_ident(roles.rolname) end as grantee
      from pg_catalog.pg_proc proc
      cross join lateral pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) acl
      left join pg_catalog.pg_roles roles on roles.oid = acl.grantee
      where proc.oid = v_original and acl.privilege_type = 'EXECUTE'
    loop
      execute format('grant execute on function %s to %s', v_wrapper, v_acl.grantee);
    end loop;
  end loop;
end;
$$;

comment on function public.assert_legacy_workspace_client_allowed_v1() is
  'Fails closed for legacy workspace readers/sync after the M10 operational reader cutover.';

commit;
