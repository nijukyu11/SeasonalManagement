create table if not exists public.daily_schedule_import_batches (
  batch_id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  contract_version smallint not null check (contract_version = 1),
  status text not null check (status in ('validated', 'failed', 'committed', 'cancelled', 'expired')),
  file_name text not null,
  workbook_profile text not null,
  raw_checksum text not null,
  canonical_checksum text not null,
  resource_policy_hash text not null,
  diagnostics jsonb not null default '[]'::jsonb check (jsonb_typeof(diagnostics) = 'array'),
  preview jsonb not null check (jsonb_typeof(preview) = 'object'),
  preview_hash text not null,
  result jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  committed_at timestamptz,
  cancelled_at timestamptz,
  unique (created_by, request_id)
);

create table if not exists public.daily_schedule_import_batch_legs (
  batch_id uuid not null references public.daily_schedule_import_batches(batch_id) on delete cascade,
  occurrence_key text not null,
  loose_occurrence_key text not null,
  effective_record_id text not null,
  season_id text not null references public.seasons(id) on delete restrict,
  season_code text not null,
  operational_date date not null,
  scheduled_date date not null,
  scheduled_time time not null,
  side text not null check (side in ('ARR', 'DEP')),
  source_row_number integer not null check (source_row_number > 0),
  sheet_name text not null,
  flight_number text not null,
  airline text not null,
  route text not null,
  stand text,
  gate integer,
  carousel integer,
  counter_token text,
  raw_resource_tokens jsonb not null default '{}'::jsonb,
  leg_data jsonb not null check (jsonb_typeof(leg_data) = 'object'),
  primary key (batch_id, occurrence_key),
  unique (batch_id, effective_record_id),
  check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$'),
  check (gate is null or gate > 0),
  check (carousel is null or carousel > 0),
  check (btrim(flight_number) <> '' and btrim(airline) <> '' and btrim(route) <> '')
);

create index if not exists daily_schedule_import_batch_legs_season_date_idx
  on public.daily_schedule_import_batch_legs (batch_id, season_id, operational_date);

create table if not exists public.daily_schedule_import_seasons (
  batch_id uuid not null references public.daily_schedule_import_batches(batch_id) on delete cascade,
  season_id text not null references public.seasons(id) on delete restrict,
  season_code text not null,
  expected_data_version integer not null check (expected_data_version >= 0),
  range_start date not null,
  range_end date not null,
  affected_dates date[] not null,
  leg_count integer not null check (leg_count >= 0),
  preview_counts jsonb not null default '{}'::jsonb,
  primary key (batch_id, season_id),
  check (range_start <= range_end),
  check (cardinality(affected_dates) > 0)
);

create table if not exists public.daily_schedule_active_days (
  season_id text not null references public.seasons(id) on delete restrict,
  operational_date date not null,
  batch_id uuid not null references public.daily_schedule_import_batches(batch_id) on delete restrict,
  activated_by uuid not null references auth.users(id) on delete restrict,
  activated_at timestamptz not null default now(),
  primary key (season_id, operational_date)
);

create index if not exists daily_schedule_active_days_batch_idx
  on public.daily_schedule_active_days (batch_id, season_id, operational_date);

alter table public.daily_schedule_import_batches enable row level security;
alter table public.daily_schedule_import_batch_legs enable row level security;
alter table public.daily_schedule_import_seasons enable row level security;
alter table public.daily_schedule_active_days enable row level security;

revoke all on table public.daily_schedule_import_batches, public.daily_schedule_import_batch_legs,
  public.daily_schedule_import_seasons, public.daily_schedule_active_days from public, anon, authenticated;

grant select on table public.daily_schedule_import_batches, public.daily_schedule_import_batch_legs,
  public.daily_schedule_import_seasons, public.daily_schedule_active_days to authenticated;

drop policy if exists "daily import batches read" on public.daily_schedule_import_batches;
create policy "daily import batches read" on public.daily_schedule_import_batches
for select to authenticated using (
  public.app_operator_has_permission('daily.read')
  and (status='committed' or created_by=auth.uid())
);
drop policy if exists "daily import legs read" on public.daily_schedule_import_batch_legs;
create policy "daily import legs read" on public.daily_schedule_import_batch_legs
for select to authenticated using (
  public.app_operator_has_permission('daily.read')
  and exists (
    select 1 from public.daily_schedule_import_batches batches
    where batches.batch_id=daily_schedule_import_batch_legs.batch_id
      and (batches.status='committed' or batches.created_by=auth.uid())
  )
);
drop policy if exists "daily import seasons read" on public.daily_schedule_import_seasons;
create policy "daily import seasons read" on public.daily_schedule_import_seasons
for select to authenticated using (
  public.app_operator_has_permission('daily.read')
  and exists (
    select 1 from public.daily_schedule_import_batches batches
    where batches.batch_id=daily_schedule_import_seasons.batch_id
      and (batches.status='committed' or batches.created_by=auth.uid())
  )
);
drop policy if exists "daily active days read" on public.daily_schedule_active_days;
create policy "daily active days read" on public.daily_schedule_active_days
for select to authenticated using (public.app_operator_has_permission('daily.read'));

create or replace function public.daily_schedule_import_v1_response(p_batch_id uuid)
returns jsonb
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  select pg_catalog.jsonb_build_object(
    'batchId', batches.batch_id,
    'requestId', batches.request_id,
    'status', batches.status,
    'preview', batches.preview,
    'previewHash', batches.preview_hash,
    'diagnostics', batches.diagnostics,
    'expiresAt', batches.expires_at,
    'result', batches.result
  )
  from public.daily_schedule_import_batches batches
  where batches.batch_id = p_batch_id
    and batches.created_by = auth.uid()
$$;

create or replace function public.stage_daily_schedule_import_v1(p_import jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request_id uuid;
  v_existing public.daily_schedule_import_batches%rowtype;
  v_batch_id uuid := gen_random_uuid();
  v_diagnostics jsonb := coalesce(p_import->'diagnostics', '[]'::jsonb);
  v_preview jsonb;
  v_preview_hash text;
  v_status text;
  v_target jsonb;
  v_leg jsonb;
  v_season public.seasons%rowtype;
  v_dates date[];
  v_expected_dates date[];
  v_actual_dates date[];
  v_leg_count integer;
  v_before_count integer;
  v_hidden_baseline_count integer;
  v_effective_record_id text;
  v_match_count integer;
begin
  if auth.uid() is null then
    raise exception 'A signed-in operator is required for Daily import V1' using errcode = '42501';
  end if;
  if not public.app_operator_has_permission('daily.write') then
    raise exception 'Missing required permission: daily.write' using errcode = '42501';
  end if;
  if p_import is null or jsonb_typeof(p_import) <> 'object' or p_import->>'contractVersion' <> '1' then
    raise exception 'Daily import contractVersion must be 1' using errcode = '22023';
  end if;
  if jsonb_typeof(p_import->'legs') is distinct from 'array'
    or jsonb_typeof(p_import->'seasons') is distinct from 'array'
    or jsonb_typeof(v_diagnostics) is distinct from 'array'
  then
    raise exception 'Daily import legs, seasons, and diagnostics must be arrays' using errcode = '22023';
  end if;
  begin
    v_request_id := nullif(btrim(p_import->>'requestId'), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Daily import requestId must be a UUID' using errcode = '22023';
  end;
  if v_request_id is null then
    raise exception 'Daily import requestId is required' using errcode = '22023';
  end if;

  select batches.* into v_existing
  from public.daily_schedule_import_batches batches
  where batches.created_by = auth.uid() and batches.request_id = v_request_id
  for update;
  if found then
    if v_existing.raw_checksum is distinct from p_import->>'rawChecksum'
      or v_existing.canonical_checksum is distinct from p_import->>'canonicalChecksum'
      or v_existing.resource_policy_hash is distinct from p_import->>'resourcePolicyHash'
    then
      raise exception 'Daily import requestId was reused with a different payload' using errcode = '23505';
    end if;
    return public.daily_schedule_import_v1_response(v_existing.batch_id);
  end if;

  if jsonb_array_length(p_import->'legs') = 0 then
    v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_EMPTY','message','No canonical legs were provided'));
  end if;

  insert into public.daily_schedule_import_batches (
    batch_id, request_id, contract_version, status, file_name, workbook_profile,
    raw_checksum, canonical_checksum, resource_policy_hash, diagnostics, preview, preview_hash, created_by
  ) values (
    v_batch_id, v_request_id, 1, 'failed', coalesce(p_import->>'fileName',''), coalesce(p_import->>'workbookProfile','unknown'),
    coalesce(p_import->>'rawChecksum',''), coalesce(p_import->>'canonicalChecksum',''), coalesce(p_import->>'resourcePolicyHash',''),
    v_diagnostics, '{}'::jsonb, 'pending', auth.uid()
  );

  for v_target in select value from jsonb_array_elements(p_import->'seasons')
  loop
    select seasons.* into v_season from public.seasons seasons
    where seasons.id = v_target->>'seasonId' for share;
    if not found or upper(btrim(v_season.season_code)) is distinct from upper(btrim(v_target->>'seasonCode')) then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_SEASON_MISMATCH','message','Target season does not exist or code does not match','seasonCode',v_target->>'seasonCode'));
      continue;
    end if;
    select coalesce(array_agg(value::date order by value::date), '{}'::date[]) into v_dates
    from jsonb_array_elements_text(v_target->'affectedDates');
    select coalesce(array_agg(day::date order by day::date), '{}'::date[]) into v_expected_dates
    from generate_series(
      (v_target->>'rangeStart')::date,
      (v_target->>'rangeEnd')::date,
      interval '1 day'
    ) as generated(day);
    select count(*), coalesce(array_agg(distinct (leg->>'operationalDate')::date order by (leg->>'operationalDate')::date), '{}'::date[])
      into v_leg_count, v_actual_dates
    from jsonb_array_elements(p_import->'legs') as staged(leg)
    where upper(staged.leg->>'seasonCode') = upper(v_season.season_code);
    if v_leg_count is distinct from coalesce((v_target->>'legCount')::integer, -1)
      or v_actual_dates is distinct from v_dates
      or v_dates[1] is distinct from (v_target->>'rangeStart')::date
      or v_dates[cardinality(v_dates)] is distinct from (v_target->>'rangeEnd')::date
    then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_RANGE_MISMATCH','message','Canonical legs and affected date contract do not match','seasonCode',v_season.season_code));
    end if;
    if v_dates is distinct from v_expected_dates then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_COVERAGE_GAP','message','Every Ops Date between rangeStart and rangeEnd must be present','seasonCode',v_season.season_code));
    end if;
    if v_season.data_version is distinct from (v_target->>'expectedDataVersion')::integer then
      raise exception 'Stale Daily import stage for season %: expected %, current %', v_season.id, v_target->>'expectedDataVersion', v_season.data_version using errcode = '40001';
    end if;
    select count(*) into v_before_count
    from (
      select records.record_id
      from public.season_flight_records records
      where records.season_id = v_season.id
        and coalesce(nullif(records.operational_date,''), records.date)::date = any(v_dates)
        and records.status is distinct from 'deleted'
        and not exists (
          select 1 from public.daily_schedule_active_days active
          where active.season_id=records.season_id
            and active.operational_date=coalesce(nullif(records.operational_date,''),records.date)::date
        )
      union all
      select prior.effective_record_id
      from public.daily_schedule_active_days active
      join public.daily_schedule_import_batch_legs prior
        on prior.batch_id=active.batch_id
       and prior.season_id=active.season_id
       and prior.operational_date=active.operational_date
      where active.season_id=v_season.id and active.operational_date=any(v_dates)
    ) current_effective;
    select count(*) into v_hidden_baseline_count
    from public.season_flight_records records
    where records.season_id = v_season.id
      and coalesce(nullif(records.operational_date,''), records.date)::date = any(v_dates)
      and records.status is distinct from 'deleted';
    insert into public.daily_schedule_import_seasons (
      batch_id, season_id, season_code, expected_data_version, range_start, range_end, affected_dates, leg_count, preview_counts
    ) values (
      v_batch_id, v_season.id, upper(v_season.season_code), (v_target->>'expectedDataVersion')::integer,
      (v_target->>'rangeStart')::date, (v_target->>'rangeEnd')::date, v_dates, v_leg_count,
      jsonb_build_object('beforeCount',v_before_count,'afterCount',v_leg_count,'hiddenBaselineCount',v_hidden_baseline_count,'insertedCount',v_leg_count)
    );
  end loop;

  for v_leg in select value from jsonb_array_elements(p_import->'legs')
  loop
    select seasons.* into v_season from public.seasons seasons
    where upper(seasons.season_code) = upper(v_leg->>'seasonCode') limit 1;
    if not found then continue; end if;
    select count(distinct candidates.record_id), min(candidates.record_id)
      into v_match_count, v_effective_record_id
    from (
      select records.record_id
      from public.season_flight_records records
      where records.season_id=v_season.id
        and coalesce(nullif(records.operational_date,''),records.date)::date=(v_leg->>'operationalDate')::date
        and records.type=case when v_leg->>'side'='DEP' then 'D' else 'A' end
        and upper(records.airline)=upper(v_leg->>'airline')
        and upper(records.flight_number)=upper(v_leg->>'flightNumber')
        and records.status is distinct from 'deleted'
      union all
      select prior.effective_record_id
      from public.daily_schedule_active_days active
      join public.daily_schedule_import_batch_legs prior
        on prior.batch_id=active.batch_id and prior.season_id=active.season_id and prior.operational_date=active.operational_date
      where active.season_id=v_season.id
        and active.operational_date=(v_leg->>'operationalDate')::date
        and prior.loose_occurrence_key=v_leg->>'looseOccurrenceKey'
    ) candidates;
    if v_match_count > 1 then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_LOOSE_IDENTITY_COLLISION','message','Multiple existing records match the same Daily identity','rowNumber',v_leg->'sourceRowNumber','seasonCode',v_leg->>'seasonCode'));
    end if;
    if v_match_count <> 1 then
      v_effective_record_id := 'DAILY_V1_' || md5(v_leg->>'occurrenceKey');
    end if;
    begin
      insert into public.daily_schedule_import_batch_legs (
        batch_id, occurrence_key, loose_occurrence_key, effective_record_id, season_id, season_code, operational_date,
        scheduled_date, scheduled_time, side, source_row_number, sheet_name, flight_number, airline, route,
        stand, gate, carousel, counter_token, raw_resource_tokens, leg_data
      ) values (
        v_batch_id, v_leg->>'occurrenceKey', v_leg->>'looseOccurrenceKey', v_effective_record_id, v_season.id, upper(v_season.season_code),
        (v_leg->>'operationalDate')::date, (v_leg->>'scheduledDate')::date, (v_leg->>'scheduledTime')::time,
        v_leg->>'side', (v_leg->>'sourceRowNumber')::integer, v_leg->>'sheetName', v_leg->>'flightNumber',
        v_leg->>'airline', v_leg->>'route', nullif(upper(btrim(v_leg#>>'{resources,stand}')),''),
        nullif(v_leg#>>'{resources,gate}','')::integer, nullif(v_leg#>>'{resources,carousel}','')::integer,
        nullif(v_leg#>>'{resources,counter}',''), coalesce(v_leg->'rawResourceTokens','{}'::jsonb), v_leg
      );
    exception when unique_violation or check_violation or invalid_text_representation then
      v_diagnostics := v_diagnostics || jsonb_build_array(jsonb_build_object('severity','blocking','code','DAILY_INVALID_LEG','message',SQLERRM,'rowNumber',v_leg->'sourceRowNumber','seasonCode',v_leg->>'seasonCode'));
    end;
  end loop;

  update public.daily_schedule_import_seasons targets
  set preview_counts = targets.preview_counts || jsonb_build_object(
    'matchedCount', (select count(*) from public.daily_schedule_import_batch_legs legs where legs.batch_id=targets.batch_id and legs.season_id=targets.season_id and legs.effective_record_id not like 'DAILY_V1_%'),
    'insertedCount', (select count(*) from public.daily_schedule_import_batch_legs legs where legs.batch_id=targets.batch_id and legs.season_id=targets.season_id and legs.effective_record_id like 'DAILY_V1_%'),
    'preservedAllocationCount', (select count(*) from public.daily_schedule_import_batch_legs legs where legs.batch_id=targets.batch_id and legs.season_id=targets.season_id and exists (select 1 from public.season_modifications mods where mods.season_id=targets.season_id and mods.leg_id=legs.effective_record_id))
  )
  where targets.batch_id=v_batch_id;

  select jsonb_build_object(
    'valid', jsonb_array_length(v_diagnostics) = 0,
    'fileName', p_import->>'fileName',
    'workbookProfile', p_import->>'workbookProfile',
    'rawChecksum', p_import->>'rawChecksum',
    'canonicalChecksum', p_import->>'canonicalChecksum',
    'resourcePolicyHash', p_import->>'resourcePolicyHash',
    'sourceRowCount', (select count(distinct source_row_number) from public.daily_schedule_import_batch_legs where batch_id = v_batch_id),
    'legCount', (select count(*) from public.daily_schedule_import_batch_legs where batch_id = v_batch_id),
    'seasons', coalesce((select jsonb_agg(jsonb_build_object(
      'seasonId', season_id, 'seasonCode', season_code, 'expectedDataVersion', expected_data_version,
      'rangeStart', range_start, 'rangeEnd', range_end, 'affectedDates', affected_dates, 'counts', preview_counts
    ) order by season_id) from public.daily_schedule_import_seasons where batch_id = v_batch_id), '[]'::jsonb)
  ) into v_preview;
  v_preview_hash := encode(pg_catalog.sha256(convert_to(v_preview::text, 'UTF8')), 'hex');
  v_status := case when jsonb_array_length(v_diagnostics) = 0 then 'validated' else 'failed' end;
  update public.daily_schedule_import_batches set status=v_status, diagnostics=v_diagnostics, preview=v_preview, preview_hash=v_preview_hash where batch_id=v_batch_id;
  return public.daily_schedule_import_v1_response(v_batch_id);
end;
$$;

create or replace function public.get_daily_schedule_import_v1_status(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'A signed-in operator is required' using errcode='42501'; end if;
  if not exists (select 1 from public.daily_schedule_import_batches where request_id=p_request_id and created_by=auth.uid()) then
    raise exception 'Daily import batch is not available to the current operator' using errcode='42501';
  end if;
  update public.daily_schedule_import_batches set status='expired'
  where request_id=p_request_id and created_by=auth.uid() and status='validated' and expires_at <= now();
  return public.daily_schedule_import_v1_response((select batch_id from public.daily_schedule_import_batches where request_id=p_request_id and created_by=auth.uid()));
end;
$$;

create or replace function public.cancel_daily_schedule_import_v1(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'A signed-in operator is required' using errcode='42501'; end if;
  update public.daily_schedule_import_batches set status='cancelled', cancelled_at=now()
  where batch_id=p_batch_id and created_by=auth.uid() and status in ('validated','failed');
  if not found then raise exception 'Daily import batch cannot be cancelled' using errcode='22023'; end if;
  return public.daily_schedule_import_v1_response(p_batch_id);
end;
$$;

create or replace function public.commit_daily_schedule_import_v1(p_batch_id uuid, p_expected_versions jsonb, p_preview_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_batch public.daily_schedule_import_batches%rowtype;
  v_target public.daily_schedule_import_seasons%rowtype;
  v_season public.seasons%rowtype;
  v_next_version integer;
  v_server_high_water bigint := 0;
  v_seq bigint;
  v_receipts jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if auth.uid() is null then raise exception 'A signed-in operator is required for Daily import commit' using errcode='42501'; end if;
  if not public.app_operator_has_permission('daily.write') then raise exception 'Missing required permission: daily.write' using errcode='42501'; end if;
  select * into v_batch from public.daily_schedule_import_batches
  where batch_id=p_batch_id and created_by=auth.uid() for update;
  if not found then raise exception 'Daily import batch is not available to the current operator' using errcode='42501'; end if;
  if v_batch.status='committed' then return v_batch.result; end if;
  if v_batch.status<>'validated' or v_batch.expires_at<=now() then raise exception 'Daily import batch is not valid for commit' using errcode='22023'; end if;
  if v_batch.preview_hash is distinct from btrim(p_preview_hash) then raise exception 'Daily import previewHash changed' using errcode='40001'; end if;

  for v_target in select * from public.daily_schedule_import_seasons where batch_id=p_batch_id order by season_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_target.season_id,0));
    select * into v_season from public.seasons where id=v_target.season_id for update;
    if not found or v_season.data_version is distinct from v_target.expected_data_version
      or coalesce((p_expected_versions->>v_target.season_id)::integer,-1) is distinct from v_target.expected_data_version
    then
      raise exception 'Stale Daily import version for season %', v_target.season_id using errcode='40001';
    end if;
  end loop;

  for v_target in select * from public.daily_schedule_import_seasons where batch_id=p_batch_id order by season_id
  loop
    insert into public.daily_schedule_active_days (season_id, operational_date, batch_id, activated_by, activated_at)
    select v_target.season_id, dates, p_batch_id, auth.uid(), now() from unnest(v_target.affected_dates) dates
    on conflict (season_id, operational_date) do update set batch_id=excluded.batch_id, activated_by=excluded.activated_by, activated_at=excluded.activated_at;
    v_next_version := v_target.expected_data_version + 1;
    update public.seasons set data_version=v_next_version, last_synced_at=floor(extract(epoch from clock_timestamp())*1000)::bigint
    where id=v_target.season_id and data_version=v_target.expected_data_version;
    if not found then raise exception 'Season % changed during Daily import commit',v_target.season_id using errcode='40001'; end if;
    insert into public.season_change_events(event_id,season_id,client_id,op_id,actor_user_id,target_type,target_id,changed_fields,op_payload)
    values('daily-import-v1:'||p_batch_id::text||':'||v_target.season_id,v_target.season_id,'daily-import-v1',p_batch_id::text,auth.uid(),'dailyImport',v_target.season_id,array['dailySnapshot','seasonMetadata'],jsonb_build_object('kind','commit_daily_schedule_import_v1','batchId',p_batch_id,'previewHash',v_batch.preview_hash,'rangeStart',v_target.range_start,'rangeEnd',v_target.range_end,'affectedDates',v_target.affected_dates,'counts',v_target.preview_counts,'dataVersion',v_next_version,'rawChecksum',v_batch.raw_checksum,'canonicalChecksum',v_batch.canonical_checksum,'resourcePolicyHash',v_batch.resource_policy_hash))
    returning server_seq into v_seq;
    v_server_high_water := greatest(v_server_high_water,v_seq);
    v_receipts := v_receipts || jsonb_build_array(jsonb_build_object('seasonId',v_target.season_id,'seasonCode',v_target.season_code,'dataVersion',v_next_version,'serverHighWater',v_seq));
  end loop;
  v_result := jsonb_build_object('batchId',p_batch_id,'requestId',v_batch.request_id,'status','committed','previewHash',v_batch.preview_hash,'seasons',v_receipts,'serverHighWater',v_server_high_water,'rawChecksum',v_batch.raw_checksum,'canonicalChecksum',v_batch.canonical_checksum);
  update public.daily_schedule_import_batches set status='committed',result=v_result,committed_at=now() where batch_id=p_batch_id and status='validated';
  if not found then raise exception 'Daily import batch changed before receipt was persisted' using errcode='40001'; end if;
  return v_result;
end;
$$;

create or replace view public.daily_schedule_effective_legs_v1 as
select
  active.season_id,
  active.operational_date,
  legs.occurrence_key as record_id,
  legs.side,
  legs.flight_number,
  legs.airline,
  legs.route,
  legs.scheduled_date,
  legs.scheduled_time,
  legs.stand,
  legs.gate,
  legs.carousel,
  legs.counter_token,
  legs.leg_data,
  'daily'::text as schedule_source,
  active.batch_id as source_batch_id
from public.daily_schedule_active_days active
join public.daily_schedule_import_batch_legs legs
  on legs.batch_id=active.batch_id and legs.season_id=active.season_id and legs.operational_date=active.operational_date
union all
select
  records.season_id,
  coalesce(nullif(records.operational_date,''),records.date)::date,
  records.record_id,
  case when records.type='D' then 'DEP' else 'ARR' end,
  records.flight_number,
  records.airline,
  records.route,
  coalesce(nullif(records.scheduled_date,''),records.date)::date,
  coalesce(nullif(records.scheduled_time,''),records.schedule)::time,
  records.stand::text,
  records.gate,
  records.carousel,
  null::text,
  to_jsonb(records),
  'seasonal'::text,
  null::uuid
from public.season_flight_records records
where records.status is distinct from 'deleted'
  and not exists (
    select 1 from public.daily_schedule_active_days active
    where active.season_id=records.season_id
      and active.operational_date=coalesce(nullif(records.operational_date,''),records.date)::date
  );

create or replace view public.daily_schedule_effective_records_v1 as
select records.*
from public.season_flight_records records
where not exists (
  select 1 from public.daily_schedule_active_days active
  where active.season_id=records.season_id
    and active.operational_date=coalesce(nullif(records.operational_date,''),records.date)::date
)
union all
select
  legs.season_id,
  legs.effective_record_id,
  legs.loose_occurrence_key,
  case when legs.side='DEP' then 'D' else 'A' end,
  legs.airline,
  legs.flight_number,
  coalesce(legs.leg_data->>'rawFlightNumber',legs.flight_number),
  legs.leg_data->>'requestStatusCode',
  legs.route,
  to_char(legs.scheduled_time,'HH24:MI'),
  coalesce(legs.leg_data->>'aircraft',''),
  coalesce(legs.leg_data->>'category','J'),
  legs.leg_data#>>'{resources,codeShares}',
  legs.leg_data->>'intDomInd',
  nullif(legs.leg_data#>>'{resources,pax}','')::integer,
  legs.gate,
  legs.stand,
  legs.carousel,
  legs.leg_data#>>'{resources,mct}',
  legs.leg_data#>>'{resources,fb}',
  legs.leg_data#>>'{resources,lb}',
  legs.leg_data#>>'{resources,bhs}',
  legs.leg_data#>>'{resources,ghs}',
  legs.scheduled_date::text,
  legs.scheduled_date::text,
  to_char(legs.scheduled_time,'HH24:MI'),
  legs.operational_date::text,
  legs.season_code,
  null::text,
  extract(dow from legs.scheduled_date)::integer,
  null::text,
  legs.source_row_number,
  null::integer,
  null::text,
  null::text,
  null::text,
  'imported'::text,
  legs.side,
  'active'::text,
  legs.loose_occurrence_key,
  legs.batch_id,
  legs.source_row_number
from public.daily_schedule_active_days active
join public.daily_schedule_import_batch_legs legs
  on legs.batch_id=active.batch_id and legs.season_id=active.season_id and legs.operational_date=active.operational_date;

create or replace view public.daily_schedule_effective_record_counters_v1 as
select counters.*
from public.season_flight_record_counters counters
join public.season_flight_records records on records.record_id=counters.record_id
where not exists (
  select 1 from public.daily_schedule_active_days active
  where active.season_id=records.season_id
    and active.operational_date=coalesce(nullif(records.operational_date,''),records.date)::date
)
union all
select
  legs.effective_record_id,
  '__single__'::text,
  tokens.ordinality::integer - 1,
  btrim(tokens.token)
from public.daily_schedule_active_days active
join public.daily_schedule_import_batch_legs legs
  on legs.batch_id=active.batch_id and legs.season_id=active.season_id and legs.operational_date=active.operational_date
cross join lateral unnest(string_to_array(legs.counter_token,',')) with ordinality as tokens(token,ordinality)
where legs.counter_token is not null and btrim(tokens.token)<>'';

alter view public.daily_schedule_effective_legs_v1 set (security_invoker = true);
alter view public.daily_schedule_effective_records_v1 set (security_invoker = true);
alter view public.daily_schedule_effective_record_counters_v1 set (security_invoker = true);

do $$
declare
  v_definition text;
  v_updated text;
begin
  select pg_catalog.pg_get_functiondef('public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)'::regprocedure)
    into v_definition;
  v_updated := replace(v_definition, 'public.season_flight_records', 'public.daily_schedule_effective_records_v1');
  v_updated := replace(v_updated, 'public.season_flight_record_counters', 'public.daily_schedule_effective_record_counters_v1');
  v_updated := replace(v_updated, 'season_flight_records r', 'daily_schedule_effective_records_v1 r');
  v_updated := replace(v_updated, 'season_flight_record_counters c', 'daily_schedule_effective_record_counters_v1 c');
  if v_updated=v_definition then
    raise exception 'Could not attach Daily active snapshot to workspace window V2';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  if to_regclass('reporting.effective_flight_operations') is null then
    raise exception 'reporting.effective_flight_operations is required for Daily active snapshot integration';
  end if;
  select pg_catalog.pg_get_viewdef('reporting.effective_flight_operations'::regclass, true)
    into v_definition;
  v_updated := replace(v_definition, 'public.season_flight_records', 'public.daily_schedule_effective_records_v1');
  v_updated := replace(v_updated, 'season_flight_records r', 'daily_schedule_effective_records_v1 r');
  if v_updated=v_definition then
    raise exception 'Could not attach Daily active snapshot to reporting.effective_flight_operations';
  end if;
  execute 'create or replace view reporting.effective_flight_operations as ' || v_updated;
  execute 'alter view reporting.effective_flight_operations set (security_invoker = true)';
end;
$$;

revoke all on function public.daily_schedule_import_v1_response(uuid) from public, anon, authenticated;
revoke execute on function public.stage_daily_schedule_import_v1(jsonb), public.get_daily_schedule_import_v1_status(uuid),
  public.cancel_daily_schedule_import_v1(uuid), public.commit_daily_schedule_import_v1(uuid,jsonb,text) from public, anon;
grant execute on function public.stage_daily_schedule_import_v1(jsonb), public.get_daily_schedule_import_v1_status(uuid),
  public.cancel_daily_schedule_import_v1(uuid), public.commit_daily_schedule_import_v1(uuid,jsonb,text) to authenticated;
revoke all on public.daily_schedule_effective_legs_v1, public.daily_schedule_effective_records_v1,
  public.daily_schedule_effective_record_counters_v1 from public, anon;
grant select on public.daily_schedule_effective_legs_v1, public.daily_schedule_effective_records_v1,
  public.daily_schedule_effective_record_counters_v1 to authenticated;
