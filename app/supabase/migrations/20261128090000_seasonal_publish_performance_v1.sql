-- 20261128090000_seasonal_publish_performance_v1.sql
-- Seasonal publish preview/commit must finish inside each function's own
-- statement_timeout (preview 30s, commit 45s; PostgREST applies it per request)
-- with the full operational store (~250k active legs).
--
-- 1. seasonal_publish_operations_v1: the operational key-collision probe ran a
--    per-draft subplan over each day's active legs (~17.5k probes for W26).
--    It is now a set-based join; the resulting draft set is unchanged.
-- 2. seasonal_publish_effective_targets_v1: exposes the operation `issue`
--    and materializes the per-row field diff, which was re-evaluated for
--    every downstream reference.
-- 3. preview_seasonal_publish_v1 reads diagnostics and blocked status from the
--    targets it already computed instead of recomputing operations 3 times.
-- 4. commit_seasonal_publish_v1 computes operations once for its issue check
--    and locks (still before targets are built), instead of 4 times.
--
-- Function preimages (definition, owner, ACL) are captured for the rollback.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '120s';

create table if not exists reporting.operational_projection_migration_preimages_v1 (
  migration_tag text not null,
  function_schema text not null,
  function_name text not null,
  function_signature text not null,
  function_definition text not null,
  function_owner text not null,
  function_acl text,
  captured_at timestamp with time zone not null default clock_timestamp(),
  primary key (migration_tag, function_schema, function_name, function_signature)
);
revoke all on reporting.operational_projection_migration_preimages_v1 from public, anon, authenticated;

insert into reporting.operational_projection_migration_preimages_v1 (
  migration_tag, function_schema, function_name, function_signature,
  function_definition, function_owner, function_acl
)
select '20261128090000', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes),
  pg_catalog.pg_get_functiondef(p.oid), r.rolname, p.proacl::text
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_roles r on r.oid = p.proowner
where n.nspname = 'public'
  and p.proname in ('seasonal_publish_operations_v1', 'seasonal_publish_effective_targets_v1',
    'preview_seasonal_publish_v1', 'commit_seasonal_publish_v1')
on conflict (migration_tag, function_schema, function_name, function_signature) do nothing;

-- Replaces p_count occurrences exactly; any other count means the preimage drifted.
create or replace function pg_temp.replace_exact_20261128(p_def text, p_old text, p_new text, p_count integer, p_label text)
returns text language plpgsql as $$
begin
  if (length(p_def) - length(replace(p_def, p_old, ''))) / length(p_old) <> p_count then
    raise exception 'Migration anchor drift: % (expected % occurrence(s))', p_label, p_count;
  end if;
  return replace(p_def, p_old, p_new);
end;
$$;

do $migration$
declare
  v_def text;
  v_owner text;
  v_acl text;
  v_identity constant text := 'public.seasonal_publish_effective_targets_v1(text)';
  v_grant record;
begin
  -- 1. Set-based operational key-collision probe.
  v_def := replace(pg_get_functiondef('public.seasonal_publish_operations_v1(text)'::regprocedure), chr(13), '');
  v_def := pg_temp.replace_exact_20261128(v_def, $old$ ), colliding_drafts as materialized (
   select d.draft_id
   from eligible d
   left join seeds s on s.source_draft_id=d.draft_id and s.status='active'
   where exists (
     select 1 from duplicate_keys k
     where k.op_day=d.op_day and k.type=d.type
       and k.airline=upper(btrim(d.airline)) and k.flight_number=upper(btrim(d.flight_number))
   )
   or exists (
     select 1 from active_operational ao
     where ao.operational_date=d.op_day
       and ao.type=d.type
       and ao.airline=upper(btrim(d.airline))
       and ao.flight_number=upper(btrim(d.flight_number))
       and ao.leg_id is distinct from s.leg_id
       and ao.leg_id not in (select leg_id from retiring_legs)
       and ao.leg_id not in (select leg_id from rekeying_legs)
   )
 ), $old$, $new$ ), colliding_drafts as materialized (
   select d.draft_id
   from eligible d
   join duplicate_keys k
     on k.op_day=d.op_day and k.type=d.type
    and k.airline=upper(btrim(d.airline)) and k.flight_number=upper(btrim(d.flight_number))
   union
   -- An active leg is the active seed of d exactly when d owns it:
   -- operational_flight_legs_seasonal_draft_active_key allows one active
   -- published leg per (season, draft), and seeds rank active legs first.
   select d.draft_id
   from eligible d
   join active_operational ao
     on ao.operational_date=d.op_day
    and ao.type=d.type
    and ao.airline=upper(btrim(d.airline))
    and ao.flight_number=upper(btrim(d.flight_number))
   where not coalesce(ao.source_season_id=p_season_id and ao.source_type='published_seasonal'
       and ao.source_draft_id=d.draft_id, false)
     and not exists (select 1 from retiring_legs r where r.leg_id=ao.leg_id)
     and not exists (select 1 from rekeying_legs r where r.leg_id=ao.leg_id)
 ), $new$, 1, 'operations collision block');
  execute v_def;

  -- 2. Targets expose `issue` and evaluate the field diff once per row.
  select replace(pg_get_functiondef(p.oid), chr(13), ''), pg_get_userbyid(p.proowner), p.proacl::text
    into v_def, v_owner, v_acl
  from pg_proc p where p.oid = v_identity::regprocedure;
  v_def := pg_temp.replace_exact_20261128(v_def,
    'has_operational_edit boolean, target_data jsonb)',
    'has_operational_edit boolean, target_data jsonb, issue text)', 1, 'targets return type');
  v_def := pg_temp.replace_exact_20261128(v_def, $old$
    end as target_data
  from evaluated e
$old$, $new$
    end as target_data,
    e.issue
  from evaluated e
$new$, 1, 'targets final select');
  v_def := pg_temp.replace_exact_20261128(v_def, $old$
  evaluated as (
    select s.*,$old$, $new$
  evaluated as materialized (
    select s.*,$new$, 1, 'targets evaluated CTE');

  drop function public.seasonal_publish_effective_targets_v1(text);
  execute v_def;
  execute format('alter function %s owner to %I', v_identity, v_owner);
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
    cross join lateral aclexplode(coalesce(v_acl::aclitem[], acldefault('f', o.oid))) a
    where o.rolname = v_owner
  loop
    execute format('grant %s on function %s to %s%s', v_grant.privilege_type, v_identity,
      case when v_grant.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(v_grant.grantee)) end,
      case when v_grant.is_grantable then ' with grant option' else '' end);
  end loop;

  -- 3. Preview reuses the targets it already materialized.
  v_def := replace(pg_get_functiondef('public.preview_seasonal_publish_v1(text,uuid,date)'::regprocedure), chr(13), '');
  v_def := pg_temp.replace_exact_20261128(v_def,
    'public.seasonal_publish_operations_v1(p_season_id)', 'pg_temp.preview_targets', 3, 'preview operation recomputations');
  execute v_def;

  -- 4. Commit computes operations once for the issue check and locks.
  v_def := replace(pg_get_functiondef('public.commit_seasonal_publish_v1(text,uuid,text,text,boolean)'::regprocedure), chr(13), '');
  v_def := pg_temp.replace_exact_20261128(v_def,
    $old$ if exists(select 1 from public.seasonal_publish_operations_v1(p_season_id) where issue is not null) then$old$,
    $new$ drop table if exists pg_temp.commit_operations;
 create temporary table commit_operations on commit drop as
  select * from public.seasonal_publish_operations_v1(p_season_id);
 if exists(select 1 from pg_temp.commit_operations where issue is not null) then$new$, 1, 'commit issue check');
  v_def := pg_temp.replace_exact_20261128(v_def,
    'public.seasonal_publish_operations_v1(p_season_id) x on x.leg_id=l.leg_id',
    'pg_temp.commit_operations x on x.leg_id=l.leg_id', 2, 'commit lock joins');
  v_def := pg_temp.replace_exact_20261128(v_def,
    'select operational_date as op_day from public.seasonal_publish_operations_v1(p_season_id)',
    'select operational_date as op_day from pg_temp.commit_operations', 1, 'commit lock days');
  execute v_def;
end;
$migration$;

drop function pg_temp.replace_exact_20261128(text, text, text, integer, text);

notify pgrst, 'reload schema';
commit;
