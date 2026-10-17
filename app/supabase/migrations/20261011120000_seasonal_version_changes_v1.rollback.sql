-- ============================================================================
-- Rollback Migration: 20261011120000_seasonal_version_changes_v1.rollback.sql
-- Safely drops get_seasonal_version_changes_page_v1 and its internal normalization helper.
-- ============================================================================

begin;

drop function if exists public.get_seasonal_version_changes_page_v1(uuid, uuid, text, text, integer, text, text, date, date, text, text);
drop function if exists public.internal_seasonal_normalize_business_state_v1(jsonb);

commit;
