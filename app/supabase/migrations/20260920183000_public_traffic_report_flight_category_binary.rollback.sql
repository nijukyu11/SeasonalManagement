begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- Rollback binary flight category classification to three-way breakdown (J, C, OTHER)
do $rollback$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)');
  v_definition text;

  v_binary_select text := $binary$      case upper(btrim(coalesce(records.category, '')))
        when 'J' then 'J'
        else 'C'
      end as flight_category,$binary$;

  v_prior_select text := $prior$      case upper(btrim(coalesce(records.category, '')))
        when 'J' then 'J'
        when 'C' then 'C'
        else 'OTHER'
      end as flight_category,$prior$;

  v_binary_breakdowns text := $binary$        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
          'key', case label
            when 'J' then 'scheduled'
            else 'charter'
          end,
          'code', label,
          'label', case label
            when 'J' then 'Thường lệ'
            else 'Không thường lệ'
          end,
          'flights', flights,
          'arrivals', arrivals,
          'departures', departures,
          'reported_pax', reported_pax,
          'share', flight_share,
          'suppressed', false
        ) order by case label when 'J' then 1 else 2 end) from dimension_rows
          where dimension = 'flight_category'), '[]'::jsonb),$binary$;

  v_prior_breakdowns text := $prior$        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
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
          where dimension = 'flight_category'), '[]'::jsonb),$prior$;

begin
  if v_signature is null then
    return;
  end if;

  select replace(pg_get_functiondef(v_signature), E'\r\n', E'\n') into v_definition;
  if strpos(v_definition, '''Thường lệ''') > 0 and strpos(v_definition, '''Thường lệ (code J)''') = 0 then
    if strpos(v_definition, v_binary_select) = 0
      or strpos(v_definition, v_binary_breakdowns) = 0
    then
      raise exception 'unexpected live traffic-report-v2 definition; rollback refused';
    end if;

    v_definition := replace(v_definition, v_binary_select, v_prior_select);
    v_definition := replace(v_definition, v_binary_breakdowns, v_prior_breakdowns);
    execute v_definition;
  end if;
end;
$rollback$;

notify pgrst, 'reload schema';
commit;
