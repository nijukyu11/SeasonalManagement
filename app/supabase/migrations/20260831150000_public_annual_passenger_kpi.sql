-- Annual passenger KPI dashboard. This stays aggregate-only and consumes the
-- already protected public traffic projection; no row-level report data is
-- exposed to anon/authenticated roles.

create table if not exists reporting.annual_passenger_kpis (
  year integer primary key check (year between 2000 and 2200),
  target_reported_pax bigint not null check (target_reported_pax > 0),
  updated_at timestamptz not null default statement_timestamp()
);

revoke all on reporting.annual_passenger_kpis from public, anon, authenticated, service_role;

insert into reporting.annual_passenger_kpis(year, target_reported_pax)
values (2026, 7500000)
on conflict (year) do nothing;

create or replace function public.get_public_annual_passenger_kpi_config_v1(
  p_year integer default null
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'year', kpis.year,
      'target_reported_pax', kpis.target_reported_pax,
      'updated_at', kpis.updated_at
    ) order by kpis.year), '[]'::jsonb)
  )
  from reporting.annual_passenger_kpis kpis
  where p_year is null or kpis.year = p_year
$$;

create or replace function public.upsert_annual_passenger_kpi_v1(
  p_year integer,
  p_target_reported_pax bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
declare
  v_row reporting.annual_passenger_kpis%rowtype;
begin
  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;
  if p_target_reported_pax is null or p_target_reported_pax <= 0 then
    raise exception 'target_reported_pax must be greater than zero' using errcode = '22023';
  end if;

  insert into reporting.annual_passenger_kpis(year, target_reported_pax, updated_at)
  values (p_year, p_target_reported_pax, statement_timestamp())
  on conflict (year) do update set
    target_reported_pax = excluded.target_reported_pax,
    updated_at = excluded.updated_at
  returning * into v_row;

  return jsonb_build_object(
    'year', v_row.year,
    'target_reported_pax', v_row.target_reported_pax,
    'updated_at', v_row.updated_at
  );
end;
$$;

create or replace function public.get_public_annual_passenger_kpi_version_v1(
  p_year integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
declare
  v_kpi reporting.annual_passenger_kpis%rowtype;
  v_projection reporting.public_traffic_projection_state%rowtype;
begin
  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;

  select * into v_kpi
  from reporting.annual_passenger_kpis
  where year = p_year;

  select * into v_projection
  from reporting.public_traffic_projection_state
  where projection_name = 'public_traffic_effective';

  -- This is intentionally the published projection version, not the live
  -- source watermark. A committed import becomes visible only after the
  -- projection refresh succeeds and updates this state row.
  return jsonb_build_object(
    'year', p_year,
    'target_reported_pax', v_kpi.target_reported_pax,
    'kpi_updated_at', v_kpi.updated_at,
    'projection_status', coalesce(v_projection.status, 'stale'),
    'source_data_version', v_projection.source_data_version,
    'source_watermark', v_projection.source_watermark,
    'refreshed_at', v_projection.refreshed_at
  );
end;
$$;

create or replace function public.get_public_annual_passenger_kpi_v1(
  p_year integer,
  p_today date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '7s'
as $$
declare
  v_today date := coalesce(p_today, (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_year_start date;
  v_year_end date;
  v_period_end date;
  v_period_state text;
  v_kpi reporting.annual_passenger_kpis%rowtype;
  v_projection jsonb;
  v_target bigint;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_due_legs integer := 0;
  v_reported_legs integer := 0;
  v_arrival_reported_legs integer := 0;
  v_departure_reported_legs integer := 0;
  v_elapsed_days integer := 0;
  v_remaining_days integer := 0;
  v_days_in_year integer;
  v_coverage numeric;
  v_data_ready boolean := false;
  v_completion numeric;
  v_average numeric;
  v_forecast bigint;
  v_forecast_pct numeric;
  v_required_today bigint;
  v_status text := 'unknown';
  v_monthly jsonb := '[]'::jsonb;
begin
  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;

  v_year_start := make_date(p_year, 1, 1);
  v_year_end := make_date(p_year, 12, 31);
  v_days_in_year := v_year_end - v_year_start + 1;
  v_period_state := case
    when p_year < extract(year from v_today)::integer then 'past'
    when p_year > extract(year from v_today)::integer then 'future'
    else 'current'
  end;
  v_period_end := case v_period_state
    when 'past' then v_year_end
    when 'current' then v_today - 1
    else null
  end;

  select * into v_kpi
  from reporting.annual_passenger_kpis
  where year = p_year;
  v_target := v_kpi.target_reported_pax;
  v_projection := public.get_public_annual_passenger_kpi_version_v1(p_year);

  if v_period_state <> 'future' and v_period_end >= v_year_start then
    select
      count(*)::integer,
      count(*) filter (where pax is not null)::integer,
      count(*) filter (where type = 'A' and pax is not null)::integer,
      count(*) filter (where type = 'D' and pax is not null)::integer,
      sum(pax) filter (where pax is not null)::bigint,
      sum(pax) filter (where type = 'A' and pax is not null)::bigint,
      sum(pax) filter (where type = 'D' and pax is not null)::bigint
    into v_due_legs, v_reported_legs, v_arrival_reported_legs,
      v_departure_reported_legs, v_reported_pax,
      v_arrival_reported_pax, v_departure_reported_pax
    from reporting.public_traffic_effective
    where ops_date between v_year_start and v_period_end
      and type in ('A', 'D');

    v_elapsed_days := v_period_end - v_year_start + 1;
    v_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) end;
    v_data_ready := v_target is not null
      and v_reported_pax is not null
      and v_due_legs > 0
      and v_reported_legs > 0
      and v_coverage >= 99.5
      and (v_period_state = 'past' or v_elapsed_days >= 28);

    select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(months.month_start, 'YYYY-MM'),
      'reported_pax', case when coalesce(months.due_legs, 0) > 0
          and round(months.reported_legs * 100.0 / months.due_legs, 2) >= 99.5
        then months.reported_pax end,
      'reported_legs', coalesce(months.reported_legs, 0),
      'due_legs', coalesce(months.due_legs, 0),
      'pax_coverage_pct', case when coalesce(months.due_legs, 0) > 0
        then round(months.reported_legs * 100.0 / months.due_legs, 2) end
    ) order by months.month_start), '[]'::jsonb)
    into v_monthly
    from (
      select series.month_start,
        count(effective.business_leg_key)::integer as due_legs,
        count(effective.business_leg_key) filter (where effective.pax is not null)::integer as reported_legs,
        sum(effective.pax) filter (where effective.pax is not null)::bigint as reported_pax
      from generate_series(v_year_start, date_trunc('month', v_period_end)::date, interval '1 month') series(month_start)
      left join reporting.public_traffic_effective effective
        on effective.ops_date >= series.month_start
       and effective.ops_date < series.month_start + interval '1 month'
       and effective.ops_date <= v_period_end
       and effective.type in ('A', 'D')
      group by series.month_start
    ) months;
  end if;

  if v_period_state = 'current' then
    v_remaining_days := v_year_end - v_today + 1;
  end if;

  if v_data_ready then
    v_completion := round(v_reported_pax * 100.0 / v_target, 2);
    v_average := round(v_reported_pax::numeric / v_elapsed_days, 1);
    if v_period_state = 'current' then
      v_forecast := round(v_average * v_days_in_year)::bigint;
      v_forecast_pct := round(v_forecast * 100.0 / v_target, 2);
      if v_reported_pax < v_target then
        v_required_today := ceil((v_target - v_reported_pax)::numeric / v_remaining_days)::bigint;
      end if;
    end if;

    v_status := case
      when v_reported_pax > v_target then 'exceeded'
      when v_reported_pax = v_target then 'achieved'
      when v_period_state = 'past' then 'not_achieved'
      when v_forecast_pct > 102 then 'ahead'
      when v_forecast_pct >= 98 then 'on_track'
      else 'at_risk'
    end;
  elsif v_period_state = 'future' then
    v_status := 'not_started';
  end if;

  return jsonb_build_object(
    'contract_version', 'annual-passenger-kpi-v1',
    'year', p_year,
    'period_state', v_period_state,
    'period_from', v_year_start,
    'period_to', v_period_end,
    'target_reported_pax', v_target,
    'kpi_updated_at', v_kpi.updated_at,
    'reported_pax', case when v_reported_legs > 0 then v_reported_pax end,
    'arrival_reported_pax', case when v_arrival_reported_legs > 0 then v_arrival_reported_pax end,
    'departure_reported_pax', case when v_departure_reported_legs > 0 then v_departure_reported_pax end,
    'reported_legs', v_reported_legs,
    'due_legs', v_due_legs,
    'pax_coverage_pct', v_coverage,
    'data_ready', v_data_ready,
    'elapsed_days', v_elapsed_days,
    'remaining_days', case when v_period_state = 'current' then v_remaining_days end,
    'average_reported_pax_per_day', case when v_data_ready then v_average end,
    'required_reported_pax_today', case when v_data_ready then v_required_today end,
    'completion_pct', case when v_data_ready then v_completion end,
    'forecast_reported_pax', case when v_data_ready and v_period_state = 'current' then v_forecast end,
    'forecast_pct', case when v_data_ready and v_period_state = 'current' then v_forecast_pct end,
    'status', v_status,
    'monthly', v_monthly,
    'projection', v_projection
  );
end;
$$;

alter function public.get_public_annual_passenger_kpi_config_v1(integer) owner to postgres;
alter function public.upsert_annual_passenger_kpi_v1(integer, bigint) owner to postgres;
alter function public.get_public_annual_passenger_kpi_version_v1(integer) owner to postgres;
alter function public.get_public_annual_passenger_kpi_v1(integer, date) owner to postgres;

revoke execute on function public.get_public_annual_passenger_kpi_config_v1(integer) from public, anon, authenticated;
revoke execute on function public.upsert_annual_passenger_kpi_v1(integer, bigint) from public, anon, authenticated;
revoke execute on function public.get_public_annual_passenger_kpi_version_v1(integer) from public, anon, authenticated;
revoke execute on function public.get_public_annual_passenger_kpi_v1(integer, date) from public, anon, authenticated;

grant execute on function public.get_public_annual_passenger_kpi_config_v1(integer) to service_role;
grant execute on function public.upsert_annual_passenger_kpi_v1(integer, bigint) to service_role;
grant execute on function public.get_public_annual_passenger_kpi_version_v1(integer) to service_role;
grant execute on function public.get_public_annual_passenger_kpi_v1(integer, date) to service_role;
