-- Reclaim expired native staging children, never request/status/receipt parents.
-- Explicit privileged maintenance only; no deployment or automatic retention.
begin;
set local lock_timeout = '15s';

create index if not exists daily_import_uncommitted_expiry_v1
  on public.daily_schedule_import_batches(expires_at, batch_id)
  where contract_version=2 and status<>'committed';
create index if not exists seasonal_draft_import_uncommitted_expiry_v1
  on public.season_import_batches(expires_at, batch_id)
  where contract_version=4 and status<>'committed';
create index if not exists seasonal_publish_uncommitted_expiry_v1
  on public.seasonal_publish_previews(expires_at, preview_id)
  where status<>'committed';

create or replace function public.cleanup_expired_schedule_preview_entries_v1()
returns jsonb
language plpgsql security definer
set search_path=pg_catalog,public
set statement_timeout='30s'
as $$
declare
  v_daily bigint;
  v_draft bigint;
  v_publish bigint;
  v_impact bigint;
begin
  -- Committers lock these same parents. SKIP LOCKED never steals an in-flight
  -- commit; retaining parents also keeps original request hashes and status.
  with expired as materialized (
    select b.batch_id from public.daily_schedule_import_batches b
    where b.contract_version=2 and b.status<>'committed' and b.expires_at<=now()
      and exists(select 1 from public.operational_daily_import_legs l where l.batch_id=b.batch_id)
    order by b.expires_at,b.batch_id limit 100 for update of b skip locked
  ), deleted as (
    delete from public.operational_daily_import_legs l using expired e
    where l.batch_id=e.batch_id returning 1
  ) select count(*) into v_daily from deleted;

  with expired as materialized (
    select b.batch_id from public.season_import_batches b
    where b.contract_version=4 and b.status<>'committed' and b.expires_at<=now()
      and exists(select 1 from public.seasonal_draft_import_entries e where e.batch_id=b.batch_id)
    order by b.expires_at,b.batch_id limit 100 for update of b skip locked
  ), deleted as (
    delete from public.seasonal_draft_import_entries d using expired e
    where d.batch_id=e.batch_id returning 1
  ) select count(*) into v_draft from deleted;

  with expired as materialized (
    select p.preview_id from public.seasonal_publish_previews p
    where p.status<>'committed' and p.expires_at<=now()
      and (exists(select 1 from public.seasonal_publish_preview_entries e where e.preview_id=p.preview_id)
        or exists(select 1 from public.seasonal_publish_operational_impact_entries e where e.preview_id=p.preview_id))
    order by p.expires_at,p.preview_id limit 100 for update of p skip locked
  ), deleted_diff as (
    delete from public.seasonal_publish_preview_entries d using expired e
    where d.preview_id=e.preview_id returning 1
  ), deleted_impact as (
    delete from public.seasonal_publish_operational_impact_entries d using expired e
    where d.preview_id=e.preview_id returning 1
  ) select (select count(*) from deleted_diff),(select count(*) from deleted_impact)
    into v_publish,v_impact;

  return jsonb_build_object('dailyLegs',v_daily,'draftEntries',v_draft,
    'publishEntries',v_publish,'operationalImpactEntries',v_impact);
end;
$$;
revoke all on function public.cleanup_expired_schedule_preview_entries_v1() from public,anon,authenticated;
grant execute on function public.cleanup_expired_schedule_preview_entries_v1() to service_role;
comment on function public.cleanup_expired_schedule_preview_entries_v1()
is 'Explicit privileged cleanup: at most 100 expired uncommitted parents per subsystem per call. Retains request payloads, parent previews, hashes, statuses, committed children and all lineage/history/receipts.';
commit;
