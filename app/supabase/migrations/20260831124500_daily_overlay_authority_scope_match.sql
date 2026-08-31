-- A Daily replacement can inherit a terminal Seasonal overlay on its first
-- import. Subsequent imports must match the tombstone carried by the currently
-- authoritative Daily batch, not the superseded Seasonal tombstone as well.

do $daily_overlay_authority_scope_match$
declare
  v_definition text;
  v_old text := $old$
          and not exists (
            select 1 from public.schedule_replacement_scopes reset_scope
            where reset_scope.season_id=records.season_id
              and reset_scope.source_batch_id=records.source_import_batch_id
              and reset_scope.reset_at is not null
          )
$old$;
  v_new text := $new$
          and not exists (
            select 1 from public.schedule_replacement_scopes reset_scope
            where reset_scope.season_id=records.season_id
              and reset_scope.source_batch_id=records.source_import_batch_id
              and reset_scope.reset_at is not null
          )
          and (
            exists (
              select 1 from public.schedule_replacement_scopes active_scope
              where active_scope.season_id=records.season_id
                and active_scope.ops_date=public.canonical_flight_leg_ops_date_v1(
                  records.operational_date, records.scheduled_date, records.date,
                  records.scheduled_time, records.schedule
                )
                and active_scope.reset_at is null
                and active_scope.source_batch_id=records.source_import_batch_id
            )
            or (
              records.source_import_batch_id is null
              and not exists (
                select 1 from public.schedule_replacement_scopes active_scope
                where active_scope.season_id=records.season_id
                  and active_scope.ops_date=public.canonical_flight_leg_ops_date_v1(
                    records.operational_date, records.scheduled_date, records.date,
                    records.scheduled_time, records.schedule
                  )
                  and active_scope.reset_at is null
              )
            )
          )
$new$;
begin
  select pg_get_functiondef('public.stage_daily_schedule_import_v1(jsonb)'::regprocedure)
    into v_definition;

  if position(v_new in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'stage_daily_schedule_import_v1 overlay selector no longer has the expected preimage';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$daily_overlay_authority_scope_match$;
