-- Immutable Daily Publication for the public 24/7 annual passenger Dashboard.
-- The publisher consumes traffic-report-v2 metrics at one fixed semantic
-- data-as-of and advances the current pointer only after all checks pass.

create table if not exists reporting.public_dashboard_publications (
  id bigint generated always as identity primary key,
  dashboard_key text not null default 'annual-passenger-kpi',
  year integer not null check (year between 2000 and 2200),
  business_date date not null,
  status text not null check (status in (
    'pending','ready','incomplete','empty','rejected_version','failed'
  )),
  idempotency_key text not null,
  trigger_kind text not null check (trigger_kind in (
    'daily_acceptance','manual_correction','shadow','rehearsal'
  )),
  reason text not null,
  expected_source_watermark bigint not null check (expected_source_watermark >= 0),
  source_watermark bigint,
  source_data_version integer,
  data_as_of timestamptz,
  metrics_contract_version text not null default 'traffic-report-v2',
  row_count bigint,
  due_legs integer,
  reported_legs integer,
  payload jsonb,
  payload_checksum text,
  started_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  error text,
  unique (dashboard_key, year, idempotency_key),
  check (business_date between make_date(year, 1, 1) and make_date(year, 12, 31)),
  check (payload_checksum is null or payload_checksum ~ '^[a-f0-9]{64}$'),
  check (status <> 'ready' or (
    payload is not null and payload_checksum is not null and source_watermark is not null
    and data_as_of is not null and completed_at is not null
  ))
);

create index if not exists public_dashboard_publications_year_date_idx
  on reporting.public_dashboard_publications(dashboard_key, year, business_date desc, id desc);

create table if not exists reporting.public_dashboard_publication_heads (
  dashboard_key text not null,
  year integer not null check (year between 2000 and 2200),
  publication_id bigint not null references reporting.public_dashboard_publications(id),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (dashboard_key, year)
);

revoke all on reporting.public_dashboard_publications from public, anon, authenticated, service_role;
revoke all on reporting.public_dashboard_publication_heads from public, anon, authenticated, service_role;
revoke all on sequence reporting.public_dashboard_publications_id_seq from public, anon, authenticated, service_role;

create or replace function reporting.guard_public_dashboard_publication_immutability_v1()
returns trigger
language plpgsql
set search_path = pg_catalog, reporting, public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dashboard publication ledger rows are immutable' using errcode = '55000';
  end if;
  if old.status <> 'pending' then
    raise exception 'ready/final dashboard publications are immutable' using errcode = '55000';
  end if;
  if new.id <> old.id
    or new.dashboard_key <> old.dashboard_key
    or new.year <> old.year
    or new.business_date <> old.business_date
    or new.idempotency_key <> old.idempotency_key
    or new.trigger_kind <> old.trigger_kind
    or new.reason <> old.reason
    or new.expected_source_watermark <> old.expected_source_watermark
    or new.metrics_contract_version <> old.metrics_contract_version
    or new.started_at <> old.started_at then
    raise exception 'dashboard publication identity is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_public_dashboard_publication_immutability
  on reporting.public_dashboard_publications;
create trigger guard_public_dashboard_publication_immutability
before update or delete on reporting.public_dashboard_publications
for each row execute function reporting.guard_public_dashboard_publication_immutability_v1();

create or replace function reporting.public_dashboard_publication_receipt_v1(
  p_publication_id bigint
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'publication_id', publications.id,
    'dashboard_key', publications.dashboard_key,
    'year', publications.year,
    'business_date', publications.business_date,
    'status', publications.status,
    'source_watermark', publications.source_watermark,
    'expected_source_watermark', publications.expected_source_watermark,
    'source_data_version', publications.source_data_version,
    'data_as_of', publications.data_as_of,
    'metrics_contract_version', publications.metrics_contract_version,
    'row_count', publications.row_count,
    'due_legs', publications.due_legs,
    'reported_legs', publications.reported_legs,
    'payload_checksum', publications.payload_checksum,
    'started_at', publications.started_at,
    'completed_at', publications.completed_at,
    'error', publications.error
  )
  from reporting.public_dashboard_publications publications
  where publications.id = p_publication_id
$$;

create or replace function public.publish_public_dashboard_daily_v1(
  p_year integer,
  p_business_date date,
  p_expected_watermark bigint,
  p_idempotency_key text,
  p_trigger_kind text default 'daily_acceptance',
  p_reason text default 'Daily data accepted'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, extensions, pg_temp
set statement_timeout = '60s'
as $$
declare
  v_publication_id bigint;
  v_existing_id bigint;
  v_source_watermark bigint;
  v_after_watermark bigint;
  v_data_as_of timestamptz := statement_timestamp();
  v_metrics jsonb;
  v_target bigint;
  v_reported_pax bigint;
  v_arrival_reported_pax bigint;
  v_departure_reported_pax bigint;
  v_flights integer;
  v_reported_legs integer;
  v_due_legs integer;
  v_missing_due_legs integer;
  v_true_zero_reported_legs integer;
  v_source_data_version integer;
  v_coverage numeric;
  v_elapsed_days integer;
  v_remaining_days integer;
  v_days_in_year integer;
  v_data_ready boolean;
  v_completion numeric;
  v_average numeric;
  v_forecast bigint;
  v_forecast_pct numeric;
  v_required_today bigint;
  v_status text := 'unknown';
  v_publication_status text;
  v_monthly jsonb := '[]'::jsonb;
  v_payload jsonb;
  v_checksum text;
  v_missing_days integer;
  v_partial_days integer;
begin
  if p_year is null or p_year not between 2000 and 2200 then
    raise exception 'year must be between 2000 and 2200' using errcode = '22023';
  end if;
  if p_business_date is null
    or p_business_date < make_date(p_year, 1, 1)
    or p_business_date > make_date(p_year, 12, 31) then
    raise exception 'business_date must belong to year' using errcode = '22023';
  end if;
  if p_business_date >= (v_data_as_of at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'business_date must be a completed Ops Date' using errcode = '22023';
  end if;
  if p_expected_watermark is null or p_expected_watermark < 0 then
    raise exception 'expected watermark must be a non-negative integer' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) < 8
    or length(p_idempotency_key) > 200 then
    raise exception 'idempotency_key must contain 8..200 characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('daily_acceptance','manual_correction','shadow','rehearsal') then
    raise exception 'invalid trigger_kind' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 4 or length(p_reason) > 500 then
    raise exception 'reason must contain 4..500 characters' using errcode = '22023';
  end if;

  select publications.id into v_existing_id
  from reporting.public_dashboard_publications publications
  where publications.dashboard_key = 'annual-passenger-kpi'
    and publications.year = p_year
    and publications.idempotency_key = btrim(p_idempotency_key);
  if v_existing_id is not null then
    return reporting.public_dashboard_publication_receipt_v1(v_existing_id);
  end if;

  insert into reporting.public_dashboard_publications(
    dashboard_key, year, business_date, status, idempotency_key, trigger_kind,
    reason, expected_source_watermark, data_as_of
  ) values (
    'annual-passenger-kpi', p_year, p_business_date, 'pending', btrim(p_idempotency_key),
    p_trigger_kind, btrim(p_reason), p_expected_watermark, v_data_as_of
  ) on conflict (dashboard_key, year, idempotency_key) do nothing
  returning id into v_publication_id;

  if v_publication_id is null then
    select publications.id into v_existing_id
    from reporting.public_dashboard_publications publications
    where publications.dashboard_key = 'annual-passenger-kpi'
      and publications.year = p_year
      and publications.idempotency_key = btrim(p_idempotency_key);
    return reporting.public_dashboard_publication_receipt_v1(v_existing_id);
  end if;

  begin
    select coalesce(max(events.server_seq), 0)::bigint into v_source_watermark
    from public.season_change_events events;
    if v_source_watermark is distinct from p_expected_watermark then
      update reporting.public_dashboard_publications set
        status = 'rejected_version', source_watermark = v_source_watermark,
        completed_at = statement_timestamp(), error = 'source watermark changed before publication'
      where id = v_publication_id;
      return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
    end if;

    v_metrics := public.get_public_traffic_report_v2(
      make_date(p_year, 1, 1), p_business_date, 'all', array[]::text[], array[]::text[],
      array[]::text[], 'none', 'local', p_expected_watermark, 'traffic-report-v2',
      'timeline', v_data_as_of
    );

    select coalesce(max(events.server_seq), 0)::bigint into v_after_watermark
    from public.season_change_events events;
    if v_after_watermark is distinct from p_expected_watermark then
      update reporting.public_dashboard_publications set
        status = 'rejected_version', source_watermark = v_after_watermark,
        completed_at = statement_timestamp(), error = 'source watermark changed during publication'
      where id = v_publication_id;
      return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
    end if;

    v_reported_pax := (v_metrics #>> '{current,reported_pax}')::bigint;
    v_arrival_reported_pax := (v_metrics #>> '{current,arrival_reported_pax}')::bigint;
    v_departure_reported_pax := (v_metrics #>> '{current,departure_reported_pax}')::bigint;
    v_flights := coalesce((v_metrics #>> '{current,flights}')::integer, 0);
    v_reported_legs := coalesce((v_metrics #>> '{current,reported_legs}')::integer, 0);
    v_due_legs := coalesce((v_metrics #>> '{current,due_legs}')::integer, 0);
    v_missing_due_legs := coalesce((v_metrics #>> '{current,missing_due_legs}')::integer, 0);
    v_true_zero_reported_legs := coalesce((v_metrics #>> '{current,true_zero_reported_legs}')::integer, 0);
    v_source_data_version := (v_metrics ->> 'data_version')::integer;
    select
      count(*) filter (where timeline.completeness = 'missing')::integer,
      count(*) filter (where timeline.completeness = 'partial')::integer
    into v_missing_days, v_partial_days
    from jsonb_to_recordset(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) as timeline(
      completeness text
    );
    v_coverage := case when v_due_legs > 0
      then round(v_reported_legs * 100.0 / v_due_legs, 2) end;

    select target_reported_pax into v_target
    from reporting.annual_passenger_kpis where year = p_year;

    v_elapsed_days := p_business_date - make_date(p_year, 1, 1) + 1;
    v_remaining_days := make_date(p_year, 12, 31) - p_business_date;
    v_days_in_year := make_date(p_year, 12, 31) - make_date(p_year, 1, 1) + 1;
    v_data_ready := v_target is not null
      and v_reported_pax is not null
      and v_due_legs > 0
      and v_due_legs = v_flights
      and v_reported_legs > 0
      and v_coverage >= 99.5
      and v_elapsed_days >= 28;

    select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(months.month_start, 'YYYY-MM'),
      'reported_pax', case when months.due_legs > 0
          and round(months.reported_legs * 100.0 / months.due_legs, 2) >= 99.5
        then months.reported_pax end,
      'reported_legs', months.reported_legs,
      'due_legs', months.due_legs,
      'pax_coverage_pct', case when months.due_legs > 0
        then round(months.reported_legs * 100.0 / months.due_legs, 2) end
    ) order by months.month_start), '[]'::jsonb)
    into v_monthly
    from (
      select date_trunc('month', timeline.ops_date)::date as month_start,
        coalesce(sum(timeline.reported_pax) filter (where timeline.reported_legs > 0), 0)::bigint as reported_pax,
        coalesce(sum(timeline.reported_legs), 0)::integer as reported_legs,
        coalesce(sum(timeline.due_legs), 0)::integer as due_legs
      from jsonb_to_recordset(v_metrics -> 'timeline') as timeline(
        ops_date date, reported_pax bigint, reported_legs integer, due_legs integer
      )
      group by date_trunc('month', timeline.ops_date)::date
    ) months;

    if v_data_ready then
      v_completion := round(v_reported_pax * 100.0 / v_target, 2);
      v_average := round(v_reported_pax::numeric / v_elapsed_days, 1);
      v_forecast := round(v_average * v_days_in_year)::bigint;
      v_forecast_pct := round(v_forecast * 100.0 / v_target, 2);
      if v_reported_pax < v_target and v_remaining_days > 0 then
        v_required_today := ceil((v_target - v_reported_pax)::numeric / v_remaining_days)::bigint;
      end if;
      v_status := case
        when v_reported_pax > v_target then 'exceeded'
        when v_reported_pax = v_target then 'achieved'
        when p_business_date = make_date(p_year, 12, 31) then 'not_achieved'
        when v_forecast_pct > 102 then 'ahead'
        when v_forecast_pct >= 98 then 'on_track'
        else 'at_risk'
      end;
    end if;

    v_publication_status := case
      when jsonb_array_length(coalesce(v_metrics -> 'timeline', '[]'::jsonb)) = 0 then 'empty'
      when v_missing_days > 0 or v_partial_days > 0
        or v_due_legs <> v_flights
        or (v_due_legs > 0 and coalesce(v_coverage, 0) < 99.5) then 'incomplete'
      else 'ready'
    end;

    v_payload := jsonb_build_object(
      'contract_version', 'annual-passenger-publication-v1',
      'year', p_year,
      'period_state', case when p_business_date = make_date(p_year, 12, 31) then 'past' else 'current' end,
      'period_from', make_date(p_year, 1, 1),
      'period_to', p_business_date,
      'target_reported_pax', v_target,
      'kpi_updated_at', (select updated_at from reporting.annual_passenger_kpis where year = p_year),
      'reported_pax', case when v_reported_legs > 0 then v_reported_pax end,
      'arrival_reported_pax', case when v_reported_legs > 0 then v_arrival_reported_pax end,
      'departure_reported_pax', case when v_reported_legs > 0 then v_departure_reported_pax end,
      'reported_legs', v_reported_legs,
      'due_legs', v_due_legs,
      'not_due_legs', greatest(v_flights - v_due_legs, 0),
      'missing_due_legs', v_missing_due_legs,
      'true_zero_reported_legs', v_true_zero_reported_legs,
      'pax_coverage_pct', v_coverage,
      'data_ready', v_data_ready,
      'elapsed_days', v_elapsed_days,
      'remaining_days', v_remaining_days,
      'average_reported_pax_per_day', case when v_data_ready then v_average end,
      'required_reported_pax_today', case when v_data_ready then v_required_today end,
      'completion_pct', case when v_data_ready then v_completion end,
      'forecast_reported_pax', case when v_data_ready and p_business_date < make_date(p_year, 12, 31) then v_forecast end,
      'forecast_pct', case when v_data_ready and p_business_date < make_date(p_year, 12, 31) then v_forecast_pct end,
      'status', v_status,
      'monthly', v_monthly,
      'publication', jsonb_build_object(
        'publication_id', v_publication_id,
        'business_date', p_business_date,
        'published_at', statement_timestamp(),
        'data_as_of', v_data_as_of,
        'source_watermark', v_source_watermark,
        'source_data_version', v_source_data_version,
        'metrics_contract_version', 'traffic-report-v2',
        'freshness', case when v_publication_status = 'ready' then 'fresh' else v_publication_status end
      )
    );
    v_checksum := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

    update reporting.public_dashboard_publications set
      status = v_publication_status,
      source_watermark = v_source_watermark,
      source_data_version = v_source_data_version,
      data_as_of = v_data_as_of,
      row_count = v_flights,
      due_legs = v_due_legs,
      reported_legs = v_reported_legs,
      payload = v_payload,
      payload_checksum = v_checksum,
      completed_at = statement_timestamp(),
      error = case when v_publication_status = 'incomplete'
        then 'daily maturity, coverage, or Pax completeness validation failed'
        when v_publication_status = 'empty' then 'publication payload is empty' end
    where id = v_publication_id;

    if v_publication_status = 'ready' then
      insert into reporting.public_dashboard_publication_heads(
        dashboard_key, year, publication_id, updated_at
      ) values ('annual-passenger-kpi', p_year, v_publication_id, statement_timestamp())
      on conflict (dashboard_key, year) do update set
        publication_id = excluded.publication_id,
        updated_at = excluded.updated_at
      where public_dashboard_publication_heads.publication_id < excluded.publication_id;
    end if;
  exception when others then
    update reporting.public_dashboard_publications set
      status = 'failed', source_watermark = coalesce(v_after_watermark, v_source_watermark),
      completed_at = statement_timestamp(), error = left(sqlerrm, 500)
    where id = v_publication_id;
  end;

  return reporting.public_dashboard_publication_receipt_v1(v_publication_id);
end;
$$;

create or replace function public.get_public_dashboard_publication_v1(
  p_year integer
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
  select publications.payload || jsonb_build_object(
    'publication', (publications.payload -> 'publication') || jsonb_build_object(
      'payload_checksum', publications.payload_checksum,
      'latest_attempt_status', latest.status,
      'latest_attempt_business_date', latest.business_date,
      'latest_attempt_completed_at', latest.completed_at,
      'freshness', case
        when latest.id is distinct from publications.id then 'stale'
        else 'fresh'
      end
    )
  )
  from reporting.public_dashboard_publication_heads heads
  join reporting.public_dashboard_publications publications
    on publications.id = heads.publication_id and publications.status = 'ready'
  left join lateral (
    select attempts.id, attempts.status, attempts.business_date, attempts.completed_at
    from reporting.public_dashboard_publications attempts
    where attempts.dashboard_key = heads.dashboard_key and attempts.year = heads.year
    order by attempts.id desc limit 1
  ) latest on true
  where heads.dashboard_key = 'annual-passenger-kpi' and heads.year = p_year
$$;

create or replace function public.get_public_dashboard_publication_version_v1(
  p_year integer
) returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, reporting, public, pg_temp
set statement_timeout = '2s'
as $$
  select jsonb_build_object(
    'contract_version', 'annual-passenger-publication-version-v1',
    'year', p_year,
    'publication_id', ready.id,
    'business_date', ready.business_date,
    'published_at', ready.completed_at,
    'data_as_of', ready.data_as_of,
    'source_watermark', ready.source_watermark,
    'metrics_contract_version', ready.metrics_contract_version,
    'payload_checksum', ready.payload_checksum,
    'latest_attempt_status', latest.status,
    'latest_attempt_business_date', latest.business_date,
    'latest_attempt_completed_at', latest.completed_at,
    'freshness', case when ready.id is null then 'missing'
      when latest.id is distinct from ready.id then 'stale' else 'fresh' end
  )
  from (select 1) seed
  left join reporting.public_dashboard_publication_heads heads
    on heads.dashboard_key = 'annual-passenger-kpi' and heads.year = p_year
  left join reporting.public_dashboard_publications ready
    on ready.id = heads.publication_id and ready.status = 'ready'
  left join lateral (
    select attempts.id, attempts.status, attempts.business_date, attempts.completed_at
    from reporting.public_dashboard_publications attempts
    where attempts.dashboard_key = 'annual-passenger-kpi' and attempts.year = p_year
    order by attempts.id desc limit 1
  ) latest on true
$$;

alter table reporting.public_dashboard_publications owner to postgres;
alter table reporting.public_dashboard_publication_heads owner to postgres;
alter function reporting.guard_public_dashboard_publication_immutability_v1() owner to postgres;
alter function reporting.public_dashboard_publication_receipt_v1(bigint) owner to postgres;
alter function public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text) owner to postgres;
alter function public.get_public_dashboard_publication_v1(integer) owner to postgres;
alter function public.get_public_dashboard_publication_version_v1(integer) owner to postgres;

revoke execute on function reporting.guard_public_dashboard_publication_immutability_v1() from public, anon, authenticated, service_role;
revoke execute on function reporting.public_dashboard_publication_receipt_v1(bigint) from public, anon, authenticated, service_role;
revoke execute on function public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text) from public, anon, authenticated;
revoke execute on function public.get_public_dashboard_publication_v1(integer) from public, anon, authenticated;
revoke execute on function public.get_public_dashboard_publication_version_v1(integer) from public, anon, authenticated;

grant execute on function public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text) to service_role;
grant execute on function public.get_public_dashboard_publication_v1(integer) to service_role;
grant execute on function public.get_public_dashboard_publication_version_v1(integer) to service_role;

comment on table reporting.public_dashboard_publications is
  'Immutable Daily Publication ledger for the public annual passenger wallboard.';
comment on function public.publish_public_dashboard_daily_v1(integer,date,bigint,text,text,text) is
  'Publishes one fixed-as-of annual Dashboard payload and advances the head only when ready.';
