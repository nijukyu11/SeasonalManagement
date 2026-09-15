-- Operator deletes arrive as overlay rows, but the canonical store is the
-- authority every import, export and duplicate check reads. This migration
-- makes the workspace op seam canonical: a 'deleted' modification marks the
-- base leg deleted with reason overlay_deleted (exactly what
-- save_canonical_season_modification_v1 and the seasonal rebase do), a
-- non-delete modification restores the rebasable terminal row (exactly what
-- remove_canonical_season_modification_v1 does), and dropping the overlay is
-- the same Undo. Rows left live behind an existing deleted overlay are
-- repaired so a deleted flight stops counting as an active canonical record
-- and stops colliding with a live re-created flight.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

do $overlay_authority$
declare
  v_definition text;
begin
  select replace(
      pg_get_functiondef('public.apply_workspace_op_json(text,jsonb)'::regprocedure),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;

  -- A hotfix may already carry this rewrite.
  if position('canonical_overlay_authority_v1' in v_definition) > 0 then
    return;
  end if;

  if position($anchor$  elsif op_type = 'modification' then
    perform public.upsert_season_modification_from_json(p_season_id, op->'mod');
  elsif op_type = 'modificationDelete' then
    delete from public.season_modifications where leg_id = op->>'legId';
$anchor$ in v_definition) = 0 then
    raise exception 'apply_workspace_op_json overlay dispatch preimage changed';
  end if;

  v_definition := replace(v_definition,
$anchor$  elsif op_type = 'modification' then
    perform public.upsert_season_modification_from_json(p_season_id, op->'mod');
  elsif op_type = 'modificationDelete' then
    delete from public.season_modifications where leg_id = op->>'legId';
$anchor$,
$body$  elsif op_type = 'modification' then
    -- canonical_overlay_authority_v1: the operator delete is the canonical
    -- delete, not a hidden overlay on a live row; the operator undo restores
    -- the rebasable terminal row the overlay produced.
    if coalesce(op->'mod'->>'action', 'modified') = 'deleted' then
      update public.season_flight_records records
      set status = 'deleted',
          action = 'deleted',
          deletion_reason = 'overlay_deleted',
          lifecycle_changed_at = now(),
          lifecycle_changed_by = auth.uid()
      where records.season_id = p_season_id
        and records.record_id = op->'mod'->>'legId'
        and public.is_canonical_flight_leg_active_v1(records.status, records.action);
    else
      update public.season_flight_records records
      set status = 'active',
          action = case when records.source_kind = 'manual' then 'added' else null end,
          deletion_reason = null,
          lifecycle_changed_at = now(),
          lifecycle_changed_by = auth.uid()
      where records.season_id = p_season_id
        and records.record_id = op->'mod'->>'legId'
        and public.is_rebasable_terminal_flight_leg_v1(records);
    end if;
    perform public.upsert_season_modification_from_json(p_season_id, op->'mod');
  elsif op_type = 'modificationDelete' then
    -- canonical_overlay_authority_v1: dropping the overlay is the canonical
    -- Undo of an added flight and the canonical restore of a deleted one.
    update public.season_flight_records records
    set status = 'deleted',
        action = 'deleted',
        deletion_reason = 'manual_undo',
        lifecycle_changed_at = now(),
        lifecycle_changed_by = auth.uid()
    where records.season_id = p_season_id
      and records.record_id = op->>'legId'
      and records.source_kind = 'manual'
      and public.is_canonical_flight_leg_active_v1(records.status, records.action)
      and exists (
        select 1
        from public.season_modifications mods
        where mods.season_id = records.season_id
          and mods.leg_id = records.record_id
          and mods.action = 'added'
      );
    update public.season_flight_records records
    set status = 'active',
        action = case when records.source_kind = 'manual' then 'added' else null end,
        deletion_reason = null,
        lifecycle_changed_at = now(),
        lifecycle_changed_by = auth.uid()
    where records.season_id = p_season_id
      and records.record_id = op->>'legId'
      and public.is_rebasable_terminal_flight_leg_v1(records);
    delete from public.season_modifications where leg_id = op->>'legId';
$body$);

  if position('canonical_overlay_authority_v1' in v_definition) = 0 then
    raise exception 'canonical overlay authority replacement was incomplete';
  end if;

  execute v_definition;
end
$overlay_authority$;

-- Repair pre-existing overlay deletes: the base row stayed active, so the
-- deleted flight was still a matchable canonical record.
update public.season_flight_records records
set status = 'deleted',
    action = 'deleted',
    deletion_reason = 'overlay_deleted',
    lifecycle_changed_at = now()
from public.season_modifications mods
where mods.season_id = records.season_id
  and mods.leg_id = records.record_id
  and mods.action = 'deleted'
  and public.is_canonical_flight_leg_active_v1(records.status, records.action);

comment on function public.apply_workspace_op_json(text,jsonb) is
  'Applies one persisted workspace operation; operator deletes and undos are canonicalized onto season_flight_records.';

notify pgrst, 'reload schema';
commit;
