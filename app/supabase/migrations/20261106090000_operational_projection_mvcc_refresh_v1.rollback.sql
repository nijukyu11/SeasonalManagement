-- 20261106090000_operational_projection_mvcc_refresh_v1.rollback.sql
-- Restores reporting.refresh_operational_canonical_legs_internal_v1(boolean)
-- directly from captured preimages in reporting.operational_projection_migration_preimages_v1.

begin;
set local lock_timeout = '15s';

do $$
declare
  r record;
  v_sql text;
  v_acl record;
  v_identity text;
  v_role text;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'reporting' and table_name = 'operational_projection_migration_preimages_v1'
  ) then
    for r in
      select function_schema, function_name, function_signature, function_definition, function_owner, function_acl
      from reporting.operational_projection_migration_preimages_v1
      where migration_tag = '20261106090000'
      order by function_name
    loop
      -- Execute the exact captured source text
      execute r.function_definition;

      -- Restore owner
      v_sql := format('alter function %I.%I(%s) owner to %I', r.function_schema, r.function_name, r.function_signature, r.function_owner);
      execute v_sql;

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
    where migration_tag = '20261106090000';
  end if;
end;
$$;

commit;
