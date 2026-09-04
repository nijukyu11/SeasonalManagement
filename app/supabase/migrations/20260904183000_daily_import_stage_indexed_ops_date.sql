-- Keep Daily import staging below the authenticated statement timeout by using
-- the persisted/indexed canonical Ops Date for loose-identity matching.

do $migration$
declare
  v_definition text;
  v_rewritten text;
  v_occurrences integer;
  v_old text := $old$
      and public.canonical_flight_leg_ops_date_v1(records.operational_date,
        records.scheduled_date,records.date,records.scheduled_time,records.schedule)
        =(v_leg->>'operationalDate')::date
$old$;
  v_new text := $new$
      and records.operational_date=v_leg->>'operationalDate'
$new$;
begin
  select replace(
      pg_get_functiondef('public.stage_daily_schedule_import_v1(jsonb)'::regprocedure),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;

  v_occurrences := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
  if v_occurrences = 0 then
    raise exception 'stage_daily_schedule_import_v1 Ops Date lookup no longer has the expected preimage';
  end if;
  if v_occurrences <> 1 then
    raise exception 'stage_daily_schedule_import_v1 Ops Date lookup preimage is ambiguous';
  end if;

  v_rewritten := replace(v_definition, v_old, v_new);
  execute v_rewritten;
end
$migration$;

comment on function public.stage_daily_schedule_import_v1(jsonb) is
  'Stages an atomic Daily Schedule replacement preview using indexed persisted operational_date matching.';
