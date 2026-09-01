-- Correct the already deployed Daily Publication publisher without changing its
-- public signature, ownership, grants, or immutable ledger schema.
--
-- The timeline payload intentionally omits report.coverage. Its completeness
-- field carries source coverage independently from the combined UI status,
-- which may also be partial because Pax is missing. The publisher reads that
-- lightweight Interface and applies Pax coverage as a separate quality rule.

do $migration$
declare
  v_metrics_signature regprocedure :=
    'public.get_public_traffic_report_v2(date,date,text,text[],text[],text[],text,text,bigint,text,text,timestamptz)'::regprocedure;
  v_signature regprocedure :=
    'public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text)'::regprocedure;
  v_metrics_definition text;
  v_metrics_old text := $metrics_old$      'true_zero_reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(true_zero_reported_legs, 0) end,
      'status', case when ops_date > v_latest_completed then 'future'$metrics_old$;
  v_metrics_new text := $metrics_new$      'true_zero_reported_legs', case when coverage_status = 'missing' and flights is null then null else coalesce(true_zero_reported_legs, 0) end,
      'completeness', coverage_status,
      'status', case when ops_date > v_latest_completed then 'future'$metrics_new$;
  v_definition text;
  v_old text := $old$    v_missing_days := coalesce((v_metrics #>> '{report,coverage,missing_day_count}')::integer, 0);
    v_partial_days := coalesce((v_metrics #>> '{report,coverage,partial_day_count}')::integer, 0);$old$;
  v_new text := $new$    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) as timeline(
      completeness text
    );$new$;
begin
  select pg_get_functiondef(v_metrics_signature) into v_metrics_definition;
  if strpos(v_metrics_definition, v_metrics_new) = 0 then
    if strpos(v_metrics_definition, v_metrics_old) = 0 then
      raise exception 'unexpected live traffic metrics definition; timeline completeness patch refused';
    end if;
    execute replace(v_metrics_definition, v_metrics_old, v_metrics_new);
  end if;

  select pg_get_functiondef(v_signature) into v_definition;

  if strpos(v_definition, v_new) > 0 then
    return;
  end if;
  if strpos(v_definition, v_old) = 0 then
    raise exception 'unexpected Daily Publication publisher definition; timeline quality patch refused';
  end if;

  execute replace(v_definition, v_old, v_new);

  select pg_get_functiondef(v_signature) into v_definition;
  if strpos(v_definition, v_new) = 0 then
    raise exception 'Daily Publication timeline quality patch did not take effect';
  end if;
  select pg_get_functiondef(v_metrics_signature) into v_metrics_definition;
  if strpos(v_metrics_definition, v_metrics_new) = 0 then
    raise exception 'Live traffic timeline completeness patch did not take effect';
  end if;
end;
$migration$;

comment on function public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text) is
  'Creates an immutable Dashboard publication from fixed-as-of canonical live metrics, validates timeline source coverage/Pax completeness and atomically advances the current pointer only when ready.';
