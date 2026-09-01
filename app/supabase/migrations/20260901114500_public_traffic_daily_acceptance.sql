-- Deep acceptance Module for Dashboard Daily Publication coverage.
-- A canonical Daily import event is accepted only when every affected Ops Date
-- still points to the same committed replacement scope, batch and data version.

create unique index if not exists public_traffic_coverage_source_batch_uidx
  on reporting.public_traffic_coverage(source_batch_id)
  where source_batch_id is not null;

create or replace function reporting.accept_public_traffic_coverage_event_v1(
  p_event_server_seq bigint,
  p_reason text,
  p_accepted_by text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_event public.season_change_events%rowtype;
  v_batch_id uuid;
  v_range_start date;
  v_range_end date;
  v_data_version integer;
  v_affected_dates date[];
  v_expected_dates date[];
  v_source_key text;
  v_coverage_id bigint;
  v_season_code text;
begin
  if p_event_server_seq is null or p_event_server_seq < 1 then
    raise exception 'event_server_seq must be a positive integer' using errcode='22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) < 4 or length(p_reason) > 500 then
    raise exception 'reason must contain 4..500 characters' using errcode='22023';
  end if;
  if p_accepted_by is null or length(btrim(p_accepted_by)) < 3 or length(p_accepted_by) > 200 then
    raise exception 'accepted_by must contain 3..200 characters' using errcode='22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public-traffic-coverage:' || p_event_server_seq::text, 0));

  select events.* into v_event
  from public.season_change_events events
  where events.server_seq = p_event_server_seq;
  if not found then
    raise exception 'Daily import acceptance event was not found' using errcode='P0002';
  end if;
  if v_event.target_type <> 'dailyImport'
    or v_event.op_payload->>'kind' <> 'commit_daily_schedule_canonical_v2'
    or v_event.season_id is null then
    raise exception 'event is not a canonical Daily import commit receipt' using errcode='22023';
  end if;

  begin
    v_batch_id := (v_event.op_payload->>'batchId')::uuid;
    v_range_start := (v_event.op_payload->>'rangeStart')::date;
    v_range_end := (v_event.op_payload->>'rangeEnd')::date;
    v_data_version := (v_event.op_payload->>'dataVersion')::integer;
  exception when others then
    raise exception 'Daily import receipt has invalid batch/range/version fields' using errcode='22023';
  end;
  if v_range_start is null or v_range_end is null or v_range_start > v_range_end
    or v_data_version is null or v_data_version < 0
    or coalesce(v_event.op_payload->>'rawChecksum','') = ''
    or coalesce(v_event.op_payload->>'canonicalChecksum','') = '' then
    raise exception 'Daily import receipt is incomplete' using errcode='22023';
  end if;

  select array_agg(values.value::date order by values.value::date)
  into v_affected_dates
  from jsonb_array_elements_text(coalesce(v_event.op_payload->'affectedDates','[]'::jsonb)) values(value);
  select array_agg(days.day::date order by days.day::date)
  into v_expected_dates
  from generate_series(v_range_start, v_range_end, interval '1 day') days(day);
  if v_affected_dates is distinct from v_expected_dates then
    raise exception 'Daily import affectedDates must exactly cover rangeStart..rangeEnd' using errcode='23514';
  end if;

  if exists (
    select 1
    from unnest(v_expected_dates) accepted(ops_date)
    left join public.schedule_replacement_scopes scopes
      on scopes.season_id = v_event.season_id
     and scopes.ops_date = accepted.ops_date
    where scopes.season_id is null
      or scopes.authority_source <> 'daily'
      or scopes.source_batch_id is distinct from v_batch_id
      or scopes.data_version is distinct from v_data_version
      or scopes.reset_at is not null
      or coalesce(scopes.canonical_checksum,'') = ''
  ) then
    raise exception 'Daily import receipt no longer owns every affected Ops Date' using errcode='40001';
  end if;

  select seasons.season_code into v_season_code
  from public.seasons seasons where seasons.id = v_event.season_id;
  v_source_key := 'daily-event:' || p_event_server_seq::text;

  insert into reporting.public_traffic_coverage(
    from_date,to_date,status,season_code,source_batch_id,reason_code,
    certified_at,certified_by
  ) values (
    v_range_start,v_range_end,'complete',v_season_code,v_source_key,btrim(p_reason),
    statement_timestamp(),btrim(p_accepted_by)
  ) on conflict(source_batch_id) where source_batch_id is not null do nothing
  returning id into v_coverage_id;

  if v_coverage_id is null then
    select coverage.id into v_coverage_id
    from reporting.public_traffic_coverage coverage
    where coverage.source_batch_id = v_source_key
      and coverage.from_date = v_range_start
      and coverage.to_date = v_range_end
      and coverage.status = 'complete';
    if v_coverage_id is null then
      raise exception 'Daily import coverage idempotency key conflicts with another certification' using errcode='23505';
    end if;
  end if;

  return jsonb_build_object(
    'status','accepted',
    'coverage_id',v_coverage_id,
    'event_server_seq',p_event_server_seq,
    'season_id',v_event.season_id,
    'season_code',v_season_code,
    'source_batch_id',v_batch_id,
    'from_date',v_range_start,
    'to_date',v_range_end,
    'day_count',cardinality(v_expected_dates),
    'data_version',v_data_version,
    'canonical_checksum',v_event.op_payload->>'canonicalChecksum'
  );
end;
$$;

create or replace function public.accept_public_traffic_coverage_event_v1(
  p_event_server_seq bigint,
  p_expected_watermark bigint,
  p_reason text,
  p_accepted_by text
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
declare
  v_watermark bigint;
begin
  select coalesce(max(events.server_seq),0)::bigint into v_watermark
  from public.season_change_events events;
  if p_expected_watermark is null or v_watermark is distinct from p_expected_watermark then
    raise exception 'source watermark changed before Daily coverage acceptance'
      using errcode='40001', detail='expected=' || coalesce(p_expected_watermark::text,'NULL') || ',actual=' || v_watermark::text;
  end if;
  return reporting.accept_public_traffic_coverage_event_v1(
    p_event_server_seq,p_reason,p_accepted_by
  ) || jsonb_build_object('source_watermark',v_watermark);
end;
$$;

create or replace function reporting.capture_public_traffic_daily_acceptance_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, reporting, public, pg_temp
as $$
begin
  perform reporting.accept_public_traffic_coverage_event_v1(
    new.server_seq,
    'canonical-daily-import-commit',
    coalesce(new.actor_user_id::text,'daily-import-commit')
  );
  return new;
end;
$$;

drop trigger if exists capture_public_traffic_daily_acceptance on public.season_change_events;
create trigger capture_public_traffic_daily_acceptance
after insert on public.season_change_events
for each row
when (
  new.target_type = 'dailyImport'
  and new.op_payload->>'kind' = 'commit_daily_schedule_canonical_v2'
)
execute function reporting.capture_public_traffic_daily_acceptance_v1();

alter function reporting.accept_public_traffic_coverage_event_v1(bigint,text,text) owner to postgres;
alter function public.accept_public_traffic_coverage_event_v1(bigint,bigint,text,text) owner to postgres;
alter function reporting.capture_public_traffic_daily_acceptance_v1() owner to postgres;

revoke execute on function reporting.accept_public_traffic_coverage_event_v1(bigint,text,text) from public,anon,authenticated,service_role;
revoke execute on function reporting.capture_public_traffic_daily_acceptance_v1() from public,anon,authenticated,service_role;
revoke execute on function public.accept_public_traffic_coverage_event_v1(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.accept_public_traffic_coverage_event_v1(bigint,bigint,text,text) to service_role;

comment on function public.accept_public_traffic_coverage_event_v1(bigint,bigint,text,text) is
  'Accepts a reconciled canonical Daily import receipt as source coverage at an expected watermark; idempotent and service-role only.';
