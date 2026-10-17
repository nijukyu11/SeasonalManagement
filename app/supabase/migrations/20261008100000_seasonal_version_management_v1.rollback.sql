-- ============================================================================
-- Rollback: 20261008100000_seasonal_version_management_v1.rollback.sql
-- Safely drops version management functions without deleting historical evidence
-- ============================================================================

begin;

drop function if exists public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid);
drop function if exists public.get_seasonal_published_export_snapshot_v1(uuid);
drop function if exists public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer);
drop function if exists public.get_seasonal_published_snapshot_page_v1(uuid, text, integer);
drop function if exists public.seasonal_published_flight_to_draft_json_v1(jsonb, text);

commit;
