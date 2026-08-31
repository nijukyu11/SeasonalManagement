-- Canonical Pax semantics: zero is a reported value; only NULL means that the
-- leg has no reported passenger figure. Patch the three aggregate functions
-- that expose Pax coverage while preserving their current signatures and all
-- operational-v2 logic.

do $$
declare
  v_function regprocedure;
  v_definition text;
  v_patched text;
begin
  foreach v_function in array array[
    'reporting.get_traffic_report_kpis(date,date,jsonb,text,timestamptz)'::regprocedure,
    'reporting.get_traffic_report_timeline_v2(date,date,date,date,text,date,integer,jsonb,timestamptz)'::regprocedure,
    'public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz)'::regprocedure
  ] loop
    select pg_get_functiondef(v_function) into v_definition;
    v_patched := replace(v_definition,
      'pax_status = ''reported''',
      'pax is not null');
    v_patched := replace(v_patched,
      'pax_status <> ''reported''',
      'pax is null');

    if v_patched is distinct from v_definition then
      execute v_patched;
    end if;

    select pg_get_functiondef(v_function) into v_definition;
    if v_definition like '%pax_status = ''reported''%'
      or v_definition like '%pax_status <> ''reported''%' then
      raise exception 'Pax presence contract was not applied to %', v_function;
    end if;
  end loop;
end;
$$;

comment on function reporting.get_traffic_report_kpis(date,date,jsonb,text,timestamptz)
  is 'Public traffic KPIs. Pax zero is reported; only Pax NULL is missing.';
comment on function reporting.get_traffic_report_timeline_v2(date,date,date,date,text,date,integer,jsonb,timestamptz)
  is 'Public daily traffic timeline. Pax zero is reported; only Pax NULL is missing.';
comment on function public.get_public_traffic_report_dimension_v2(date,date,text,text[],text[],text[],text[],text,integer,integer,timestamptz)
  is 'Public dimension aggregate. Pax zero is reported; only Pax NULL is missing.';
