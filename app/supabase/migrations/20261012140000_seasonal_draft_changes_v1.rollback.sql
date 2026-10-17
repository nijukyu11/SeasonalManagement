-- ============================================================================
-- Rollback Migration: 20261012140000_seasonal_draft_changes_v1.rollback.sql
-- Description: Safely drops get_seasonal_draft_changes_page_v1.
-- ============================================================================

begin;

drop function if exists public.get_seasonal_draft_changes_page_v1(text, uuid, text, text, integer, text, text, date, date, text, text, text, bigint);
drop function if exists public.get_seasonal_draft_changes_page_v1(text, uuid, text, text, integer, text, text, date, date, text, text);

commit;
