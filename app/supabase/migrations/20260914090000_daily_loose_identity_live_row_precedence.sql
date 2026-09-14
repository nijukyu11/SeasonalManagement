-- A live canonical row is the current authority for a Daily loose identity; a
-- rebasable terminal row is only the stale lineage of a flight the operator
-- deleted. The first Daily replacement after an operator re-created such a
-- flight must resolve that identity to the live row, instead of blocking the
-- import on two matchable generations or rebasing the stale deletion onto the
-- new generation. Terminal-only lineage keeps its deletion-carry semantics.
-- No stored row is rewritten by this migration; only the stage matcher changes.

do $identity_precedence$
declare
  v_definition text;
  v_occurrences integer;
  v_old text;
  v_new text;
  v_index integer;
begin
  select replace(
      pg_get_functiondef('public.stage_daily_schedule_import_v1(jsonb)'::regprocedure),
      chr(13) || chr(10),
      chr(10)
    )
    into v_definition;

  for v_index in 0..3 loop
    case v_index
      when 0 then
        v_old := $old0$
  v_match_count integer;
  v_matched_record_id text;
$old0$;
        v_new := $new0$
  v_match_count integer;
  v_matched_record_id text;
  v_active_match_count integer;
  v_terminal_key_count integer;
  v_preferred_match_id text;
$new0$;
      when 1 then
        v_old := $old1$
    select count(distinct public.canonical_flight_leg_occurrence_key_v1(
        records.season_id, records.operational_date, records.scheduled_date, records.date,
        records.scheduled_time, records.schedule, records.type, records.airline,
        records.flight_number, records.raw_flight_number, records.route
      )),
      (array_agg(records.record_id order by records.lifecycle_changed_at desc nulls last, records.record_id desc))[1]
      into v_match_count, v_matched_record_id
$old1$;
        v_new := $new1$
    select count(*) filter (where public.is_canonical_flight_leg_active_v1(records.status,records.action)),
      count(distinct case when public.is_canonical_flight_leg_active_v1(records.status,records.action)
        then null else public.canonical_flight_leg_occurrence_key_v1(
          records.season_id, records.operational_date, records.scheduled_date, records.date,
          records.scheduled_time, records.schedule, records.type, records.airline,
          records.flight_number, records.raw_flight_number, records.route
        ) end),
      (array_agg(records.record_id order by public.is_canonical_flight_leg_active_v1(records.status,records.action) desc,
        records.lifecycle_changed_at desc nulls last, records.record_id desc))[1]
      into v_active_match_count, v_terminal_key_count, v_preferred_match_id
$new1$;
      when 2 then
        v_old := $old2$
    if v_match_count > 1 then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
        'severity','blocking','code','DAILY_LOOSE_IDENTITY_COLLISION',
        'message','Multiple active canonical records match the same Daily loose identity',
        'rowNumber',v_leg->'sourceRowNumber','seasonCode',v_leg->>'seasonCode'
      ));
      v_matched_record_id := null;
    end if;
$old2$;
        v_new := $new2$
    if v_active_match_count > 1
      or (v_active_match_count = 0 and v_terminal_key_count > 1)
    then
      v_match_count := 2;
      v_matched_record_id := null;
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object(
        'severity','blocking','code','DAILY_LOOSE_IDENTITY_COLLISION',
        'message','Multiple active canonical records match the same Daily loose identity',
        'rowNumber',v_leg->'sourceRowNumber','seasonCode',v_leg->>'seasonCode'
      ));
    elsif v_active_match_count > 0 or v_terminal_key_count > 0 then
      v_match_count := 1;
      v_matched_record_id := v_preferred_match_id;
    else
      v_match_count := 0;
      v_matched_record_id := null;
    end if;
$new2$;
      when 3 then
        v_old := $old3$
        jsonb_build_object('matchedRecordId',case when v_match_count=1 then v_matched_record_id end,
      'sourceFingerprint',case when v_match_count=1 then public.daily_import_source_fingerprint_v1(v_matched_record_id) end),
$old3$;
        v_new := $new3$
        jsonb_build_object('matchedRecordId',case when v_match_count=1 then v_matched_record_id end,
      'sourceFingerprint',case when v_match_count=1 then public.daily_import_source_fingerprint_v1(v_matched_record_id) end,
      'liveCandidateCount',v_active_match_count,'terminalCandidateCount',v_terminal_key_count),
$new3$;
    end case;

    v_occurrences := (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old);
    -- An earlier hotfix may already carry this rewrite.
    if strpos(v_definition,v_new)>0 then continue; end if;
    if v_occurrences <> 1 then
      raise exception 'stage_daily_schedule_import_v1 identity precedence preimage is ambiguous (%)', v_occurrences;
    end if;
    v_definition := replace(v_definition, v_old, v_new);
  end loop;

  execute v_definition;
end
$identity_precedence$;

comment on function public.stage_daily_schedule_import_v1(jsonb) is
  'Stages an atomic Daily Schedule replacement preview using indexed persisted operational_date matching and live-row identity precedence.';
