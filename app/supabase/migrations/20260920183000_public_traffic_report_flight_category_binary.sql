begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- Align flight category breakdown to binary classification:
-- 1. 'scheduled' -> 'Thường lệ' (code J)
-- 2. 'charter' -> 'Không thường lệ' (includes code C and all other flights)
-- Removes '(code J)' and '(code C)' suffixes from labels.

do $migration$
declare
  v_signature regprocedure :=
    to_regprocedure('public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)');
  v_definition text;

  v_old_select text := $old$      case upper(btrim(coalesce(records.category, '')))
        when 'J' then 'J'
        when 'C' then 'C'
        else 'OTHER'
      end as flight_category,$old$;

  v_new_select text := $new$      case upper(btrim(coalesce(records.category, '')))
        when 'J' then 'J'
        else 'C'
      end as flight_category,$new$;

  v_old_breakdowns text := $old$        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
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
          where dimension = 'flight_category'), '[]'::jsonb),$old$;

  v_new_breakdowns text := $new$        'flight_category', coalesce((select jsonb_agg(jsonb_build_object(
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
          where dimension = 'flight_category'), '[]'::jsonb),$new$;

begin
  if v_signature is null then
    raise notice 'get_public_traffic_report_v2 is absent; binary flight_category migration skipped';
    return;
  end if;

  select replace(pg_get_functiondef(v_signature), E'\r\n', E'\n') into v_definition;
  if strpos(v_definition, '''Thường lệ (code J)''') > 0 then
    if strpos(v_definition, v_old_select) = 0
      or strpos(v_definition, v_old_breakdowns) = 0
    then
      raise exception 'unexpected live traffic-report-v2 definition; binary flight_category migration refused';
    end if;

    v_definition := replace(v_definition, v_old_select, v_new_select);
    v_definition := replace(v_definition, v_old_breakdowns, v_new_breakdowns);
    execute v_definition;
  end if;
end;
$migration$;
notify pgrst, 'reload schema';
commit;
