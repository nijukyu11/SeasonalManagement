-- 20261009100000_operational_incremental_projection_v1.rollback.sql
-- Restores pre-incremental candidate slice, full refresh, and freshness status
-- directly from captured preimages in reporting.operational_projection_migration_preimages_v1.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- 1. Drop scope and recency triggers
drop trigger if exists sync_operational_recency on public.operational_change_events;
drop trigger if exists sync_season_recency on public.season_change_events;
drop trigger if exists dirty_operational_scope_legs on public.operational_flight_legs;
drop trigger if exists dirty_operational_scope_legs_truncate on public.operational_flight_legs;
drop trigger if exists dirty_operational_scope_authority on public.operational_day_authority;
drop trigger if exists dirty_operational_scope_authority_truncate on public.operational_day_authority;
drop trigger if exists dirty_operational_scope_quarantine on public.operational_leg_quarantine;
drop trigger if exists dirty_operational_scope_backfill_links on public.operational_leg_backfill_links;

-- 2. Drop trigger functions
drop function if exists reporting.sync_operational_recency_v1();
drop function if exists reporting.dirty_operational_scope_legs_v1();
drop function if exists reporting.dirty_operational_scope_truncate_v1();
drop function if exists reporting.dirty_operational_scope_authority_v1();
drop function if exists reporting.dirty_operational_scope_quarantine_v1();
drop function if exists reporting.dirty_operational_scope_backfill_links_v1();

-- 3. Drop helper functions and overloads
drop function if exists reporting.operational_projection_reconcile_due_v1();
drop function if exists reporting.refresh_operational_canonical_legs_internal_v1(boolean);
drop function if exists reporting.get_operational_candidate_slice_dates_v1(date[]);
drop function if exists reporting.refresh_operational_canonical_legs_v1(boolean);

-- 4. Drop queue and recency lookup tables
drop table if exists reporting.operational_projection_dirty_scope_v1;
drop table if exists reporting.operational_entity_recency_v1;
drop table if exists reporting.operational_day_recency_v1;

-- 5. Restore captured preimage definitions
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
      where migration_tag = '20261009100000'
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
  end if;
end;
$$;

drop table if exists reporting.operational_projection_migration_preimages_v1;

-- 6. Drop added columns from state table
alter table reporting.operational_canonical_flight_legs_state
  drop column if exists last_reconciled_at,
  drop column if exists requires_full_reconcile;

commit;
