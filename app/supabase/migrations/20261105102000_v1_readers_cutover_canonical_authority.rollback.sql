-- 20261105102000_v1_readers_cutover_canonical_authority.rollback.sql
-- Restores residual V1 readers from live deployment preimages in
-- reporting.operational_projection_migration_preimages_v1.

begin;

do $$
declare
  r record;
  v_sql text;
  v_acl record;
  v_identity text;
  v_role text;
begin
  for r in
    select *
    from reporting.operational_projection_migration_preimages_v1
    where migration_tag = '20261105102000'
    order by function_name
  loop
    -- 1. Execute the exact captured source text
    execute r.function_definition;

    -- 2. Restore owner
    v_identity := format('%I.%I(%s)', r.function_schema, r.function_name, r.function_signature);
    v_sql := format('alter function %s owner to %I', v_identity, r.function_owner);
    execute v_sql;

    -- 3. Restore ACLs if captured
    if r.function_acl is not null and r.function_acl <> '' then
      execute format('revoke all on function %s from public, anon, authenticated, service_role', v_identity);
      for v_acl in
        select
          split_part(split_part(acl_item, '=', 1), '/', 1) as grantee,
          split_part(split_part(acl_item, '=', 2), '/', 1) as privileges
        from unnest(string_to_array(r.function_acl, ',')) as acl_item
      loop
        v_role := case when v_acl.grantee = '' then 'public' else quote_ident(v_acl.grantee) end;
        if v_acl.privileges like '%X%' then
          execute format('grant execute on function %s to %s', v_identity, v_role);
        end if;
      end loop;
    end if;
  end loop;

  -- 4. Delete saved preimages for this migration
  delete from reporting.operational_projection_migration_preimages_v1
  where migration_tag = '20261105102000';
end $$;

drop view if exists reporting.public_traffic_effective_gate_v1 cascade;
drop view if exists reporting.operational_traffic_effective_v1 cascade;

commit;
