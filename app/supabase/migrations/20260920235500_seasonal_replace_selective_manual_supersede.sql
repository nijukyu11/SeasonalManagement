-- Seasonal Replace: Selective Manual Supersession & Merge-Only Manual Collision Guard
--
-- 1. stage_seasonal_import_v3:
-- Manual occurrence collisions (manual-occurrence-collision) must only block in merge mode.
-- In replace mode (Season Repair / Replace All), the incoming seasonal file is the new canonical schedule:
-- manual occurrences that collide with the incoming file are superseded by commit_seasonal_import_v3,
-- while non-colliding manual Add Flight rows remain active.
-- Daily occurrence collisions (daily-occurrence-collision) continue to block in both merge and replace.
--
-- 2. commit_seasonal_import_v3:
-- When apply_strategy = 'replace', soft-delete both active seasonal rows AND active manual rows
-- whose occurrence key collides with incoming records, marking them with deletion_reason = 'seasonal_rebuild'.
-- Non-colliding manual rows (and daily authority rows) remain active.

begin;

set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $patch_stage$
declare
  v_definition text;
  v_target text;
  v_replacement text;
begin
  select pg_catalog.replace(
    pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;

  v_target := '  join authority_occurrences authority' || chr(10) ||
              '    on authority.occurrence_key = incoming.occurrence_key' || chr(10) ||
              '  where incoming.batch_id = v_batch.batch_id;';

  v_replacement := '  join authority_occurrences authority' || chr(10) ||
                   '    on authority.occurrence_key = incoming.occurrence_key' || chr(10) ||
                   '  where incoming.batch_id = v_batch.batch_id' || chr(10) ||
                   '    and (v_strategy = ''merge'' or authority.source_kind <> ''manual'');';

  if position(v_target in v_definition) = 0 then
    -- Check if already patched
    if position(v_replacement in v_definition) > 0 then
      return;
    end if;
    raise exception 'target anchor not found in stage_seasonal_import_v3 definition';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_target, v_replacement);
  execute v_definition;
end;
$patch_stage$;

do $patch_commit$
declare
  v_definition text;
  v_old_replace text;
  v_new_replace text;
begin
  select pg_catalog.replace(
    pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),
    chr(13) || chr(10),
    chr(10)
  ) into v_definition;

  v_old_replace := '  if v_batch.apply_strategy = ''replace'' then
    update public.season_flight_records records
    set status=''deleted'',action=''deleted'',deletion_reason=''seasonal_rebuild'',
        lifecycle_changed_at=pg_catalog.now(),lifecycle_changed_by=auth.uid()
    where records.season_id=v_target_season_id
      and records.source_kind=''seasonal''
      and public.is_canonical_flight_leg_active_v1(records.status,records.action);
  end if;';

  v_new_replace := '  if v_batch.apply_strategy = ''replace'' then
    update public.season_flight_records records
    set status=''deleted'',action=''deleted'',deletion_reason=''seasonal_rebuild'',
        lifecycle_changed_at=pg_catalog.now(),lifecycle_changed_by=auth.uid()
    where records.season_id=v_target_season_id
      and (
        records.source_kind = ''seasonal''
        or (
          records.source_kind = ''manual''
          and exists (
            select 1
            from pg_temp.seasonal_import_commit_records_v3 incoming
            where incoming.occurrence_key = v_target_season_id
              || ''|''
              || coalesce(nullif(records.scheduled_date, ''''), records.date)
              || ''|''
              || pg_catalog.upper(pg_catalog.btrim(records.airline))
              || ''|''
              || (
                select normalized.flight_number
                from public.normalize_seasonal_flight_number_v2(
                  records.airline,
                  coalesce(nullif(records.flight_number, ''''), records.raw_flight_number)
                ) normalized
              )
          )
        )
      )
      and public.is_canonical_flight_leg_active_v1(records.status,records.action);
  end if;';

  if position(v_old_replace in v_definition) = 0 then
    -- Check if already patched
    if position(v_new_replace in v_definition) > 0 then
      return;
    end if;
    raise exception 'old replace block not found in commit_seasonal_import_v3 definition';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old_replace, v_new_replace);
  execute v_definition;
end;
$patch_commit$;

comment on function public.stage_seasonal_import_v3(jsonb) is
  'Stages and validates a seasonal import batch; guards against daily collisions in merge/replace and manual collisions in merge.';

comment on function public.commit_seasonal_import_v3(uuid, integer, text) is
  'Commits a staged seasonal import batch; on replace, supersedes active seasonal rows and colliding manual Add Flight rows with seasonal_rebuild.';

notify pgrst, 'reload schema';

commit;
