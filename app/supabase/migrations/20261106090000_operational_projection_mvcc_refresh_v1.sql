-- 20261106090000_operational_projection_mvcc_refresh_v1.sql
-- Replace whole-row TRUNCATE swaps with transaction-safe MVCC DELETE/INSERT
-- in reporting.refresh_operational_canonical_legs_internal_v1 for all read-facing
-- projection tables and dirty queue scope (including empty branch).
-- Retains operational_workspace_revision FOR SHARE lock for consistent revision read.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- Guarded dynamic replacement with drift rejection and idempotence
do $$
declare
  v_proc_oid oid;
  v_def text;
  v_new_def text;
  v_owner text;
  v_acl text;
begin
  v_proc_oid := 'reporting.refresh_operational_canonical_legs_internal_v1(boolean)'::regprocedure::oid;

  select r.rolname, p.proacl::text
    into v_owner, v_acl
  from pg_proc p
  join pg_roles r on r.oid = p.proowner
  where p.oid = v_proc_oid;

  v_def := pg_get_functiondef(v_proc_oid);

  -- Idempotency check: if already patched with MVCC marker, skip
  if position('-- marker: mvcc_projection_refresh_v1' in v_def) > 0 then
    raise notice 'Migration 20261106090000 already applied; skipping.';
    return;
  end if;

  -- Drift check: verify all 5 expected TRUNCATE statements exist before replacement
  if position('truncate table reporting.operational_canonical_flight_legs;' in v_def) = 0
     or position('truncate table reporting.operational_canonical_flight_legs_quarantine;' in v_def) = 0
     or position('truncate table reporting.canonical_flight_legs;' in v_def) = 0
     or position('truncate table reporting.canonical_flight_legs_quarantine;' in v_def) = 0
     or position('truncate table reporting.operational_projection_dirty_scope_v1;' in v_def) = 0 then
    raise exception 'Drift detected in reporting.refresh_operational_canonical_legs_internal_v1: expected truncate statements not found'
      using errcode = '22000';
  end if;

  -- Verify operational_workspace_revision FOR SHARE lock is preserved
  if position('from public.operational_workspace_revision where singleton for share' in v_def) = 0 then
    raise exception 'Drift detected: operational_workspace_revision FOR SHARE lock missing' using errcode = '22000';
  end if;

  -- Capture deployment preimage for byte-exact rollback preservation without overwriting existing
  insert into reporting.operational_projection_migration_preimages_v1 (
    migration_tag,
    function_schema,
    function_name,
    function_signature,
    function_definition,
    function_owner,
    function_acl
  ) values (
    '20261106090000',
    'reporting',
    'refresh_operational_canonical_legs_internal_v1',
    'boolean',
    v_def,
    v_owner,
    v_acl
  )
  on conflict (migration_tag, function_schema, function_name, function_signature) do nothing;

  -- Perform surgical MVCC replacements (both empty branch and full refresh branch)
  v_new_def := replace(v_def, 'truncate table reporting.operational_canonical_flight_legs;', 'delete from reporting.operational_canonical_flight_legs;');
  v_new_def := replace(v_new_def, 'truncate table reporting.operational_canonical_flight_legs_quarantine;', 'delete from reporting.operational_canonical_flight_legs_quarantine;');
  v_new_def := replace(v_new_def, 'truncate table reporting.canonical_flight_legs;', 'delete from reporting.canonical_flight_legs;');
  v_new_def := replace(v_new_def, 'truncate table reporting.canonical_flight_legs_quarantine;', 'delete from reporting.canonical_flight_legs_quarantine;');
  v_new_def := replace(v_new_def, 'truncate table reporting.operational_projection_dirty_scope_v1;', 'delete from reporting.operational_projection_dirty_scope_v1;');

  -- Append idempotence marker
  v_new_def := replace(v_new_def,
    '-- Decide full vs incremental reconciliation',
    '-- marker: mvcc_projection_refresh_v1' || chr(10) || '  -- Decide full vs incremental reconciliation'
  );

  -- Assert marker insertion worked
  if position('-- marker: mvcc_projection_refresh_v1' in v_new_def) = 0 then
    raise exception 'Sanity assertion failed: marker insertion failed' using errcode = '22000';
  end if;

  -- Assert that no truncate statements remain in the function body
  if position('truncate table' in lower(v_new_def)) > 0 then
    raise exception 'Sanity assertion failed: residual truncate table found in rebuilt function' using errcode = '22000';
  end if;

  -- Execute replacement
  execute v_new_def;
end;
$$;

commit;
