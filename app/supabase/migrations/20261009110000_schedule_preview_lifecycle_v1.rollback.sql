-- Only disposable expired child previews were reclaimed; canonical data and
-- request receipts are never touched. Removing maintenance needs no data drop.
begin;
drop function if exists public.cleanup_expired_schedule_preview_entries_v1();
drop index if exists public.daily_import_uncommitted_expiry_v1;
drop index if exists public.seasonal_draft_import_uncommitted_expiry_v1;
drop index if exists public.seasonal_publish_uncommitted_expiry_v1;
commit;
