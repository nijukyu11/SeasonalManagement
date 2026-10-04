-- Supabase's authenticator role loads safeupdate, which rejects UPDATE statements
-- without a WHERE clause even when they target a transaction-local temp table.
--
-- Migration 20260829170000_seasonal_canonical_authority.sql added a temp table
-- update under if v_batch.apply_strategy = 'replace' without a WHERE clause:
--   update pg_temp.seasonal_import_commit_records_v3 incoming
--   set generated_record_id=..., final_record_id=..., is_insert=true, needs_update=false;
-- This migration bounds that update with: where incoming.occurrence_key is not null;

begin;

set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.replace(
    pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;

  v_old := '    update pg_temp.seasonal_import_commit_records_v3 incoming
    set generated_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        final_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        is_insert=true,
        needs_update=false;';

  v_new := '    update pg_temp.seasonal_import_commit_records_v3 incoming
    set generated_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        final_record_id=''SEASONAL_V3_'' || pg_catalog.md5(p_batch_id::text || ''|'' || incoming.occurrence_key),
        is_insert=true,
        needs_update=false
    where incoming.occurrence_key is not null;';

  if position(v_new in v_definition) > 0 then
    -- Already patched
    return;
  end if;

  if position(v_old in v_definition) = 0 then
    raise exception 'Target replace temp update block not found in commit_seasonal_import_v3 definition';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

comment on function public.commit_seasonal_import_v3(uuid, integer, text) is
  'Commits a staged seasonal import batch; bounds replace temp-table updates for safeupdate, and supersedes active seasonal rows and colliding manual Add Flight rows with seasonal_rebuild.';

notify pgrst, 'reload schema';

commit;
