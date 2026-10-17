-- ============================================================================
-- Rollback: 20261009090000_seasonal_snapshot_integrity_indexed_v1.rollback.sql
-- Safely restores version management functions from captured preimages.
-- Drops derived snapshot flight rows and diff cache without mutating
-- published canonical snapshots or historical evidence.
-- ============================================================================

begin;

-- 1. Restore functions from preimages
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'preimage_restore_seasonal_published_draft_v1') then
    select pg_get_functiondef('public.preimage_restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.preimage_restore_seasonal_published_draft_v1', 'FUNCTION public.restore_seasonal_published_draft_v1');
    execute v_fn;
    drop function public.preimage_restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid);
  end if;

  if exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_published_export_snapshot_v1') then
    select pg_get_functiondef('public.preimage_get_seasonal_published_export_snapshot_v1(uuid)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.preimage_get_seasonal_published_export_snapshot_v1', 'FUNCTION public.get_seasonal_published_export_snapshot_v1');
    execute v_fn;
    drop function public.preimage_get_seasonal_published_export_snapshot_v1(uuid);
  end if;

  if exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_version_comparison_page_v1') then
    select pg_get_functiondef('public.preimage_get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.preimage_get_seasonal_version_comparison_page_v1', 'FUNCTION public.get_seasonal_version_comparison_page_v1');
    execute v_fn;
    drop function public.preimage_get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer);
  end if;

  if exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_published_snapshot_page_v1') then
    select pg_get_functiondef('public.preimage_get_seasonal_published_snapshot_page_v1(uuid, text, integer)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.preimage_get_seasonal_published_snapshot_page_v1', 'FUNCTION public.get_seasonal_published_snapshot_page_v1');
    execute v_fn;
    drop function public.preimage_get_seasonal_published_snapshot_page_v1(uuid, text, integer);
  end if;
end;
$$;

-- 2. Drop triggers and immutability guards
drop trigger if exists seasonal_publish_snapshots_guard_trigger on public.seasonal_publish_snapshots;
drop trigger if exists seasonal_published_snapshot_flights_guard_trigger on public.seasonal_published_snapshot_flights;
drop trigger if exists seasonal_publish_versions_guard_trigger on public.seasonal_publish_versions;
drop trigger if exists seasonal_publish_snapshots_truncate_guard on public.seasonal_publish_snapshots;
drop trigger if exists seasonal_published_snapshot_flights_truncate_guard on public.seasonal_published_snapshot_flights;
drop trigger if exists seasonal_publish_versions_truncate_guard on public.seasonal_publish_versions;
drop trigger if exists seasonal_publish_snapshots_certify_trigger on public.seasonal_publish_snapshots;
drop trigger if exists seasonal_publish_snapshots_derive_trigger on public.seasonal_publish_snapshots;

drop function if exists public.seasonal_publish_snapshots_guard_v1();
drop function if exists public.seasonal_published_snapshot_flights_guard_v1();
drop function if exists public.seasonal_publish_versions_guard_v1();
drop function if exists public.seasonal_publish_snapshots_certify_v1();
drop function if exists public.seasonal_publish_snapshots_derive_trigger_v1();
drop function if exists public.internal_derive_seasonal_published_snapshot_flights_v1(uuid, uuid, text, jsonb, text);

-- 3. Drop derived tables and cache
drop table if exists public.seasonal_publish_diff_cache_entries cascade;
drop table if exists public.seasonal_publish_diff_cache_runs cascade;
drop table if exists public.seasonal_published_snapshot_flights cascade;

alter table public.seasonal_publish_snapshots drop column if exists active_flight_count;

-- 4. Re-grant original permissions on restored functions
revoke all on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) from public, anon;
grant execute on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) to authenticated;

revoke all on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) from public, anon;
grant execute on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) to authenticated;

revoke all on function public.get_seasonal_published_export_snapshot_v1(uuid) from public, anon;
grant execute on function public.get_seasonal_published_export_snapshot_v1(uuid) to authenticated;

revoke all on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) to authenticated;

commit;
