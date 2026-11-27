-- 20261008110000_operational_reporting_correction_v1.rollback.sql
-- Rollback for native Pax correction and candidate selector cutover integration.

begin;

drop trigger if exists capture_operational_pax_correction on public.operational_change_events;
drop trigger if exists operational_capture_zzz_pax_correction on public.operational_change_events;
drop function if exists reporting.capture_operational_pax_correction_v1();

do $$
declare
  r record;
  v_sql text;
  v_acl record;
  v_identity text;
  v_role text;
  v_fn text;
begin
  -- 1. Restore from dynamic preimage table when present (restores definition, owner, and exact ACL)
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'reporting' and table_name = 'operational_projection_migration_preimages_v1'
  ) and exists (
    select 1 from reporting.operational_projection_migration_preimages_v1
    where migration_tag = '20261008110000'
  ) then
    for r in
      select function_schema, function_name, function_signature, function_definition, function_owner, function_acl
      from reporting.operational_projection_migration_preimages_v1
      where migration_tag = '20261008110000'
      order by function_name
    loop
      -- Execute the exact captured source text
      execute r.function_definition;

      -- Restore owner
      v_sql := format('alter function %I.%I(%s) owner to %I', r.function_schema, r.function_name, r.function_signature, r.function_owner);
      execute v_sql;

      -- Restore ACL dynamically
      v_identity := format('%I.%I(%s)', r.function_schema, r.function_name, r.function_signature);
      for v_acl in
        select distinct a.grantee
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = v_identity::regprocedure
      loop
        v_role := case when v_acl.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(v_acl.grantee)) end;
        execute format('revoke all on function %s from %s', v_identity, v_role);
      end loop;
      for v_acl in
        select a.* from pg_roles owner_role
        cross join lateral aclexplode(coalesce(r.function_acl::aclitem[], acldefault('f', owner_role.oid))) a
        where owner_role.rolname = r.function_owner
      loop
        v_role := case when v_acl.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(v_acl.grantee)) end;
        execute format('grant %s on function %s to %s%s', v_acl.privilege_type, v_identity, v_role,
          case when v_acl.is_grantable then ' with grant option' else '' end);
      end loop;
    end loop;

    delete from reporting.operational_projection_migration_preimages_v1
    where migration_tag = '20261008110000';
  elsif exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_correction_candidate_v1') then
    -- Fallback for environments without captured preimages
    select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'reporting' and p.proname = 'legacy_select_public_dashboard_correction_candidate_v1'
    limit 1;
    if v_fn is not null then
      v_fn := regexp_replace(
        v_fn,
        'FUNCTION\s+([a-zA-Z_0-9]+\.)?legacy_select_public_dashboard_correction_candidate_v1\(',
        'FUNCTION reporting.select_public_dashboard_correction_candidate_v1(',
        'i'
      );
      execute v_fn;
    end if;
  end if;

  -- Always clean up legacy helper function if it was created
  if exists (select 1 from pg_proc where proname = 'legacy_select_public_dashboard_correction_candidate_v1') then
    drop function reporting.legacy_select_public_dashboard_correction_candidate_v1(timestamptz);
  end if;
end;
$$;

commit;
