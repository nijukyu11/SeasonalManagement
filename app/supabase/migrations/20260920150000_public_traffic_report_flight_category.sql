-- Add flight category breakdown (scheduled code J, charter code C, other)
-- to public.get_public_traffic_report_v2.
-- The category is extracted directly from the canonical season_flight_records
-- row identified by (season_id, record_id) and normalized to J, C, or OTHER.

do $migration$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)');
  v_definition text;

  v_old_select text := $old$      coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
      coalesce(nullif(btrim(aircraft_map.aircraft_group), ''), 'Unknown') as aircraft_group,$old$;

  v_new_select text := $new$      coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
      coalesce(nullif(btrim(aircraft_map.aircraft_group), ''), 'Unknown') as aircraft_group,
      case upper(btrim(coalesce(records.category, '')))
        when 'J' then 'J'
        when 'C' then 'C'
        else 'OTHER'
      end as flight_category,$new$;

  v_old_join text := $old$    from ranked_slice ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join aircraft_map on aircraft_map.aircraft_type = upper(btrim(ranked.effective_aircraft))
    where ranked.candidate_rank = 1$old$;

  v_new_join text := $new$    from ranked_slice ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join aircraft_map on aircraft_map.aircraft_type = upper(btrim(ranked.effective_aircraft))
    left join public.season_flight_records records
      on records.season_id = ranked.season_id and records.record_id = ranked.record_id
    where ranked.candidate_rank = 1$new$;

  v_old_dimensions text := $old$    cross join lateral (values
      ('airline'::text, rows.airline),
      ('route'::text, rows.route),
      ('country'::text, rows.country),
      ('aircraft_group'::text, rows.aircraft_group)
    ) dimensions(dimension, label)$old$;

  v_new_dimensions text := $new$    cross join lateral (values
      ('airline'::text, rows.airline),
      ('route'::text, rows.route),
      ('country'::text, rows.country),
      ('aircraft_group'::text, rows.aircraft_group),
      ('flight_category'::text, rows.flight_category)
    ) dimensions(dimension, label)$new$;

  v_old_breakdowns text := $old$      'breakdowns', jsonb_build_object(
        'aircraft_group', coalesce((select jsonb_agg(jsonb_build_object($old$;

  v_new_breakdowns text := $new$      'breakdowns', jsonb_build_object(
        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
          'key', case label
            when 'J' then 'scheduled'
            when 'C' then 'charter'
            else 'other'
          end,
          'code', label,
          'label', case label
            when 'J' then 'Thường lệ (code J)'
            when 'C' then 'Không thường lệ (code C)'
            else 'Khác'
          end,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by case label when 'J' then 1 when 'C' then 2 else 3 end) from dimension_rows
          where dimension = 'flight_category'), '[]'::jsonb),
        'aircraft_group', coalesce((select jsonb_agg(jsonb_build_object($new$;

begin
  if v_signature is null then
    raise notice 'get_public_traffic_report_v2 is absent; flight_category migration skipped';
    return;
  end if;

  select replace(pg_get_functiondef(v_signature), E'\r\n', E'\n') into v_definition;
  if strpos(v_definition, '''flight_category''') = 0 then
    if strpos(v_definition, v_old_select) = 0
      or strpos(v_definition, v_old_join) = 0
      or strpos(v_definition, v_old_dimensions) = 0
      or strpos(v_definition, v_old_breakdowns) = 0
    then
      raise exception 'unexpected live traffic-report-v2 definition; flight_category migration refused';
    end if;

    v_definition := replace(v_definition, v_old_select, v_new_select);
    v_definition := replace(v_definition, v_old_join, v_new_join);
    v_definition := replace(v_definition, v_old_dimensions, v_new_dimensions);
    v_definition := replace(v_definition, v_old_breakdowns, v_new_breakdowns);
    execute v_definition;
  end if;
end;
$migration$;
