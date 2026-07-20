do $migration$
declare
  function_oid regprocedure := 'public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)'::regprocedure;
  function_definition text;
  old_base text := $old$
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id,
              0::smallint
            ) > (p_after_effective_date, p_after_root_id, p_after_root_kind))
$old$;
  new_base text := $new$
          -- cursor_index_range_v2: start at the two-column index key, then filter root-kind equality.
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id
            ) >= (p_after_effective_date, p_after_root_id))
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id
            ) <> (p_after_effective_date, p_after_root_id)
            or 0::smallint > p_after_root_kind)
$new$;
  old_added text := $old$
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id,
              1::smallint
            ) > (p_after_effective_date, p_after_root_id, p_after_root_kind))
$old$;
  new_added text := $new$
          -- cursor_index_range_v2: start at the two-column index key, then filter root-kind equality.
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id
            ) >= (p_after_effective_date, p_after_root_id))
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id
            ) <> (p_after_effective_date, p_after_root_id)
            or 1::smallint > p_after_root_kind)
$new$;
begin
  select pg_get_functiondef(function_oid)
  into function_definition;

  if position('cursor_index_range_v2' in function_definition) > 0 then
    return;
  end if;

  if position(old_base in function_definition) = 0
     or position(old_added in function_definition) = 0 then
    raise exception 'Workspace window V2 definition did not match the reviewed cursor predicates';
  end if;

  function_definition := replace(function_definition, old_base, new_base);
  function_definition := replace(function_definition, old_added, new_added);

  if position('cursor_index_range_v2' in function_definition) = 0
     or position(old_base in function_definition) > 0
     or position(old_added in function_definition) > 0 then
    raise exception 'Workspace window V2 cursor-range replacement was incomplete';
  end if;

  execute function_definition;
end
$migration$;

notify pgrst, 'reload schema';
