-- Repeated Daily imports preserve terminal overlays by copying the overlay onto
-- each new canonical record. Historical deleted rows for the same exact atomic
-- occurrence must therefore count as one match, while genuinely different
-- occurrences sharing a loose airline/flight/date identity remain blocking.

do $daily_overlay_lineage_match$
declare
  v_definition text;
  v_old text := E'select count(*), min(records.record_id)\n      into v_match_count, v_matched_record_id\n    ';
  v_new text := E'select count(distinct public.canonical_flight_leg_occurrence_key_v1(\n        records.season_id, records.operational_date, records.scheduled_date, records.date,\n        records.scheduled_time, records.schedule, records.type, records.airline,\n        records.flight_number, records.raw_flight_number, records.route\n      )),\n      (array_agg(records.record_id order by records.lifecycle_changed_at desc nulls last, records.record_id desc))[1]\n      into v_match_count, v_matched_record_id\n    ';
begin
  select pg_get_functiondef('public.stage_daily_schedule_import_v1(jsonb)'::regprocedure)
    into v_definition;

  if position(v_new in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'stage_daily_schedule_import_v1 match selector no longer has the expected preimage';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$daily_overlay_lineage_match$;

