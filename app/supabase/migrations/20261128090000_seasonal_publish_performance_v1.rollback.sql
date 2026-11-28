-- 20261128090000_seasonal_publish_performance_v1.rollback.sql
-- Restores the four publish functions byte-exactly (definition, owner, ACL)
-- from the preimages captured by the forward migration.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

do $rollback$
declare
  r record;
  v_identity text;
  v_grant record;
begin
  if (select count(*) from reporting.operational_projection_migration_preimages_v1
      where migration_tag = '20261128090000') <> 4 then
    raise exception 'Preimages for 20261128090000 are missing';
  end if;

  -- The forward migration changed this function's return type.
  drop function public.seasonal_publish_effective_targets_v1(text);

  for r in
    select function_schema, function_name, function_signature, function_definition, function_owner, function_acl
    from reporting.operational_projection_migration_preimages_v1
    where migration_tag = '20261128090000'
    order by function_name
  loop
    execute r.function_definition;
    v_identity := format('%I.%I(%s)', r.function_schema, r.function_name, r.function_signature);
    execute format('alter function %s owner to %I', v_identity, r.function_owner);
    for v_grant in
      select distinct a.grantee from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = v_identity::regprocedure
    loop
      execute format('revoke all on function %s from %s', v_identity,
        case when v_grant.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(v_grant.grantee)) end);
    end loop;
    for v_grant in
      select a.* from pg_roles o
      cross join lateral aclexplode(coalesce(r.function_acl::aclitem[], acldefault('f', o.oid))) a
      where o.rolname = r.function_owner
    loop
      execute format('grant %s on function %s to %s%s', v_grant.privilege_type, v_identity,
        case when v_grant.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(v_grant.grantee)) end,
        case when v_grant.is_grantable then ' with grant option' else '' end);
    end loop;
  end loop;

  delete from reporting.operational_projection_migration_preimages_v1
  where migration_tag = '20261128090000';
end;
$rollback$;

notify pgrst, 'reload schema';
commit;
