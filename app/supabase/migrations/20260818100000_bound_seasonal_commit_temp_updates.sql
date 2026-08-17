-- Supabase's authenticator role loads safeupdate, which rejects UPDATE statements
-- without a WHERE clause even when they target a transaction-local temp table.

do $migration$
declare
  v_signature regprocedure := 'public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure;
  v_definition text;
  v_before text;
  v_turnaround_bounded_pattern constant text :=
    'end[[:space:]]+where incoming\.final_record_id is not null;[[:space:]]+update[[:space:]]+pg_temp\.seasonal_import_commit_records_v3[[:space:]]+incoming[[:space:]]+set[[:space:]]+resolved_link_id';
  v_turnaround_unbounded_pattern constant text :=
    'end;([[:space:]]+update[[:space:]]+pg_temp\.seasonal_import_commit_records_v3[[:space:]]+incoming[[:space:]]+set[[:space:]]+resolved_link_id)';
  v_link_bounded_pattern constant text :=
    'set[[:space:]]+resolved_link_id[[:space:]]*=[[:space:]]*coalesce\([[:space:]]*incoming\.resolved_turnaround_id,[[:space:]]*incoming\.final_record_id[[:space:]]*\)[[:space:]]+where incoming\.final_record_id is not null;';
  v_link_unbounded_pattern constant text :=
    'set[[:space:]]+resolved_link_id[[:space:]]*=[[:space:]]*coalesce\([[:space:]]*incoming\.resolved_turnaround_id,[[:space:]]*incoming\.final_record_id[[:space:]]*\);';
begin
  select pg_catalog.pg_get_functiondef(v_signature::oid)
  into strict v_definition;

  if v_definition !~ v_turnaround_bounded_pattern then
    v_before := v_definition;
    v_definition := pg_catalog.regexp_replace(
      v_definition,
      v_turnaround_unbounded_pattern,
      E'end\n  where incoming.final_record_id is not null;\\1'
    );

    if v_definition = v_before then
      raise exception 'Unexpected commit_seasonal_import_v3 turnaround update definition';
    end if;
  end if;

  if v_definition !~ v_link_bounded_pattern then
    v_before := v_definition;
    v_definition := pg_catalog.regexp_replace(
      v_definition,
      v_link_unbounded_pattern,
      E'set resolved_link_id = coalesce(\n    incoming.resolved_turnaround_id,\n    incoming.final_record_id\n  )\n  where incoming.final_record_id is not null;'
    );

    if v_definition = v_before then
      raise exception 'Unexpected commit_seasonal_import_v3 link update definition';
    end if;
  end if;

  execute v_definition;
end;
$migration$;

revoke execute on function public.commit_seasonal_import_v3(uuid, integer, text)
  from public, anon;
grant execute on function public.commit_seasonal_import_v3(uuid, integer, text)
  to authenticated;
