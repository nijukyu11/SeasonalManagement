-- Seasonal Import V3 RPCs (stage & commit) process full seasons with >25,000 occurrences.
-- Role authenticator in Supabase has statement_timeout = 8s by default.
-- Large commits (such as W26 with 26,000 occurrences) take ~20-25s and get canceled
-- by Postgres with SQLSTATE 57014 (canceling statement due to statement timeout).
-- This migration configures function-level statement_timeout = '180s' on both RPCs.

alter function public.stage_seasonal_import_v3(jsonb) set statement_timeout = '180s';
alter function public.commit_seasonal_import_v3(uuid, integer, text) set statement_timeout = '180s';

notify pgrst, 'reload schema';
