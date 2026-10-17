-- 20261009100000_operational_incremental_projection_v1.sql
-- Operational recency current lookup, durable affected-scope dirty queue,
-- and incremental projection refresh with periodic full reconciliation.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- -----------------------------------------------------------------------------
-- 0. Dedicated private preimage capture table
-- -----------------------------------------------------------------------------
create table if not exists reporting.operational_projection_migration_preimages_v1 (
  migration_tag text not null,
  function_schema text not null,
  function_name text not null,
  function_signature text not null,
  function_definition text not null,
  function_owner text not null,
  function_acl text,
  captured_at timestamp with time zone not null default clock_timestamp(),
  primary key (migration_tag, function_schema, function_name, function_signature)
);

revoke all on reporting.operational_projection_migration_preimages_v1 from public, anon, authenticated;

-- Capture preimages of the three functions modified by this migration
insert into reporting.operational_projection_migration_preimages_v1 (
  migration_tag,
  function_schema,
  function_name,
  function_signature,
  function_definition,
  function_owner,
  function_acl
)
select
  '20261009100000',
  n.nspname,
  p.proname,
  pg_catalog.oidvectortypes(p.proargtypes),
  pg_catalog.pg_get_functiondef(p.oid),
  r.rolname,
  p.proacl::text
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_roles r on r.oid = p.proowner
where n.nspname = 'reporting'
  and p.proname in (
    'get_operational_candidate_slice_v1',
    'refresh_operational_canonical_legs_v1',
    'operational_projection_status_v1'
  )
  and (p.proname <> 'refresh_operational_canonical_legs_v1' or p.pronargs = 0)
on conflict (migration_tag, function_schema, function_name, function_signature) do nothing;

-- -----------------------------------------------------------------------------
-- 1. State Table Enhancement
-- -----------------------------------------------------------------------------
alter table reporting.operational_canonical_flight_legs_state
  add column if not exists last_reconciled_at timestamp with time zone,
  add column if not exists requires_full_reconcile boolean not null default false;

-- -----------------------------------------------------------------------------
-- 2. Durable Affected-Scope Dirty Queue
-- -----------------------------------------------------------------------------
create table if not exists reporting.operational_projection_dirty_scope_v1 (
  enqueue_id bigint generated always as identity primary key,
  ops_date date not null,
  enqueued_at timestamp with time zone not null default clock_timestamp(),
  reason text not null default 'operational_mutation'
);

create index if not exists operational_projection_dirty_scope_ops_date_idx
  on reporting.operational_projection_dirty_scope_v1 (ops_date);

revoke all on reporting.operational_projection_dirty_scope_v1 from public, anon, authenticated;
grant select, insert, delete, truncate on reporting.operational_projection_dirty_scope_v1 to service_role;

-- -----------------------------------------------------------------------------
-- 3. Dedicated Authoritative Recency Lookup Tables
-- -----------------------------------------------------------------------------
create table if not exists reporting.operational_entity_recency_v1 (
  target_id text primary key,
  server_seq bigint not null,
  updated_at timestamp with time zone not null default clock_timestamp()
);

create table if not exists reporting.operational_day_recency_v1 (
  ops_date date primary key,
  server_seq bigint not null,
  updated_at timestamp with time zone not null default clock_timestamp()
);

revoke all on reporting.operational_entity_recency_v1 from public, anon, authenticated;
revoke all on reporting.operational_day_recency_v1 from public, anon, authenticated;
grant select, insert, update on reporting.operational_entity_recency_v1 to service_role;
grant select, insert, update on reporting.operational_day_recency_v1 to service_role;

-- Backfill recency tables from reporting.operational_projection_events_v1
insert into reporting.operational_entity_recency_v1 (target_id, server_seq, updated_at)
select
  events.target_id,
  max(events.server_seq)::bigint,
  clock_timestamp()
from reporting.operational_projection_events_v1 events
group by events.target_id
on conflict (target_id) do update
  set server_seq = greatest(reporting.operational_entity_recency_v1.server_seq, excluded.server_seq),
      updated_at = clock_timestamp();

insert into reporting.operational_day_recency_v1 (ops_date, server_seq, updated_at)
select
  events.target_id::date,
  max(events.server_seq)::bigint,
  clock_timestamp()
from reporting.operational_projection_events_v1 events
where events.target_type = 'dailyAuthority'
  and events.target_id ~ '^\d{4}-\d{2}-\d{2}$'
group by events.target_id::date
on conflict (ops_date) do update
  set server_seq = greatest(reporting.operational_day_recency_v1.server_seq, excluded.server_seq),
      updated_at = clock_timestamp();

-- -----------------------------------------------------------------------------
-- 4. Triggers to Keep Recency Tables in Sync with Events
-- -----------------------------------------------------------------------------
create or replace function reporting.sync_operational_recency_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
begin
  if new.target_id is not null and new.server_seq is not null then
    insert into reporting.operational_entity_recency_v1 (target_id, server_seq, updated_at)
    values (new.target_id, new.server_seq, clock_timestamp())
    on conflict (target_id) do update
      set server_seq = greatest(reporting.operational_entity_recency_v1.server_seq, excluded.server_seq),
          updated_at = clock_timestamp();

    if new.target_type = 'dailyAuthority' and new.target_id ~ '^\d{4}-\d{2}-\d{2}$' then
      insert into reporting.operational_day_recency_v1 (ops_date, server_seq, updated_at)
      values (new.target_id::date, new.server_seq, clock_timestamp())
      on conflict (ops_date) do update
        set server_seq = greatest(reporting.operational_day_recency_v1.server_seq, excluded.server_seq),
            updated_at = clock_timestamp();

      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.target_id::date, 'daily_authority_event');
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_operational_recency on public.operational_change_events;
create trigger sync_operational_recency
  after insert on public.operational_change_events
  for each row execute function reporting.sync_operational_recency_v1();

drop trigger if exists sync_season_recency on public.season_change_events;
create trigger sync_season_recency
  after insert on public.season_change_events
  for each row execute function reporting.sync_operational_recency_v1();

-- -----------------------------------------------------------------------------
-- 5. Triggers for Durable Dirty Scope on Operational Mutations
-- -----------------------------------------------------------------------------
create or replace function reporting.dirty_operational_scope_legs_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
declare
  v_cp record;
begin
  if tg_op = 'INSERT' then
    if new.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.operational_date, 'leg_insert');
    end if;
    if new.scheduled_date is not null and new.scheduled_date <> new.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.scheduled_date, 'leg_insert_scheduled');
    end if;

    if new.linked_leg_id is not null then
      for v_cp in
        select operational_date, scheduled_date
        from public.operational_flight_legs
        where leg_id = new.linked_leg_id
      loop
        if v_cp.operational_date is not null then
          insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
          values (v_cp.operational_date, 'counterpart_insert');
        end if;
        if v_cp.scheduled_date is not null and v_cp.scheduled_date <> v_cp.operational_date then
          insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
          values (v_cp.scheduled_date, 'counterpart_insert_scheduled');
        end if;
      end loop;
    end if;

    return new;
  elsif tg_op = 'UPDATE' then
    if old.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.operational_date, 'leg_update_old');
    end if;
    if old.scheduled_date is not null and old.scheduled_date <> old.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.scheduled_date, 'leg_update_old_scheduled');
    end if;
    if new.operational_date is not null and new.operational_date <> old.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.operational_date, 'leg_update_new');
    end if;
    if new.scheduled_date is not null and new.scheduled_date <> old.scheduled_date and new.scheduled_date <> new.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.scheduled_date, 'leg_update_new_scheduled');
    end if;

    if old.linked_leg_id is not null then
      for v_cp in
        select operational_date, scheduled_date
        from public.operational_flight_legs
        where leg_id = old.linked_leg_id
      loop
        if v_cp.operational_date is not null then
          insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
          values (v_cp.operational_date, 'counterpart_update_old');
        end if;
      end loop;
    end if;
    if new.linked_leg_id is not null and (old.linked_leg_id is null or new.linked_leg_id <> old.linked_leg_id) then
      for v_cp in
        select operational_date, scheduled_date
        from public.operational_flight_legs
        where leg_id = new.linked_leg_id
      loop
        if v_cp.operational_date is not null then
          insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
          values (v_cp.operational_date, 'counterpart_update_new');
        end if;
      end loop;
    end if;

    -- Also check reverse links pointing to this leg
    for v_cp in
      select operational_date, scheduled_date
      from public.operational_flight_legs
      where linked_leg_id = old.leg_id
    loop
      if v_cp.operational_date is not null then
        insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
        values (v_cp.operational_date, 'reverse_counterpart_update');
      end if;
    end loop;

    return new;
  elsif tg_op = 'DELETE' then
    if old.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.operational_date, 'leg_delete');
    end if;
    if old.scheduled_date is not null and old.scheduled_date <> old.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.scheduled_date, 'leg_delete_scheduled');
    end if;

    if old.linked_leg_id is not null then
      for v_cp in
        select operational_date, scheduled_date
        from public.operational_flight_legs
        where leg_id = old.linked_leg_id
      loop
        if v_cp.operational_date is not null then
          insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
          values (v_cp.operational_date, 'counterpart_delete');
        end if;
      end loop;
    end if;

    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists dirty_operational_scope_legs on public.operational_flight_legs;
create trigger dirty_operational_scope_legs
  after insert or update or delete on public.operational_flight_legs
  for each row execute function reporting.dirty_operational_scope_legs_v1();

create or replace function reporting.dirty_operational_scope_truncate_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
begin
  update reporting.operational_canonical_flight_legs_state
  set requires_full_reconcile = true
  where singleton;
  return null;
end;
$$;

drop trigger if exists dirty_operational_scope_legs_truncate on public.operational_flight_legs;
create trigger dirty_operational_scope_legs_truncate
  after truncate on public.operational_flight_legs
  for each statement execute function reporting.dirty_operational_scope_truncate_v1();

create or replace function reporting.dirty_operational_scope_authority_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
begin
  if tg_op = 'INSERT' then
    if new.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.operational_date, 'authority_insert');
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.operational_date, 'authority_update_old');
    end if;
    if new.operational_date is not null and new.operational_date <> old.operational_date then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (new.operational_date, 'authority_update_new');
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.operational_date is not null then
      insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
      values (old.operational_date, 'authority_delete');
    end if;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists dirty_operational_scope_authority on public.operational_day_authority;
create trigger dirty_operational_scope_authority
  after insert or update or delete on public.operational_day_authority
  for each row execute function reporting.dirty_operational_scope_authority_v1();

drop trigger if exists dirty_operational_scope_authority_truncate on public.operational_day_authority;
create trigger dirty_operational_scope_authority_truncate
  after truncate on public.operational_day_authority
  for each statement execute function reporting.dirty_operational_scope_truncate_v1();

create or replace function reporting.dirty_operational_scope_quarantine_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.ops_date is not null then
    insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
    values (new.ops_date, 'quarantine_mutation');
  elsif tg_op in ('UPDATE', 'DELETE') and old.ops_date is not null then
    insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
    values (old.ops_date, 'quarantine_mutation');
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists dirty_operational_scope_quarantine on public.operational_leg_quarantine;
create trigger dirty_operational_scope_quarantine
  after insert or update or delete on public.operational_leg_quarantine
  for each row execute function reporting.dirty_operational_scope_quarantine_v1();

create or replace function reporting.dirty_operational_scope_backfill_links_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
declare
  v_leg_id uuid;
  v_ops_date date;
begin
  v_leg_id := coalesce(new.leg_id, old.leg_id);
  select operational_date into v_ops_date
  from public.operational_flight_legs
  where leg_id = v_leg_id;

  if v_ops_date is not null then
    insert into reporting.operational_projection_dirty_scope_v1 (ops_date, reason)
    values (v_ops_date, 'backfill_link_mutation');
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists dirty_operational_scope_backfill_links on public.operational_leg_backfill_links;
create trigger dirty_operational_scope_backfill_links
  after insert or update or delete on public.operational_leg_backfill_links
  for each row execute function reporting.dirty_operational_scope_backfill_links_v1();

-- -----------------------------------------------------------------------------
-- 6. Updated Candidate Slice Using Direct Recency Lookups
-- -----------------------------------------------------------------------------
create or replace function reporting.get_operational_candidate_slice_v1(
  p_from_date date,
  p_to_date date
) returns table (
  season_id text,
  record_id text,
  type text,
  airline text,
  flight_number text,
  route text,
  aircraft text,
  pax integer,
  scheduled_date text,
  scheduled_time text,
  effective_route text,
  effective_aircraft text,
  effective_pax integer,
  effective_action text,
  scheduled_date_value date,
  local_minutes integer,
  authoritative_server_seq bigint,
  ops_date date,
  scheduled_local_at timestamp without time zone,
  business_leg_key text
)
language sql
stable
security invoker
set search_path = pg_catalog, reporting, public, pg_temp
as $$
with bounded as materialized (
  select
    legs.leg_id,
    legs.leg_key,
    legs.operational_date,
    legs.scheduled_date,
    legs.scheduled_time,
    legs.side,
    legs.airline,
    legs.flight_number,
    legs.route,
    legs.aircraft_type,
    legs.pax,
    legs.source_season_id,
    links.authoritative_server_seq as backfill_server_seq
  from public.operational_flight_legs legs
  left join public.operational_leg_backfill_links links
    on links.leg_id = legs.leg_id
  where legs.status = 'active'
    and legs.operational_date between p_from_date and p_to_date
)
select
  bounded.source_season_id,
  bounded.leg_id::text,
  case bounded.side when 'ARR' then 'A' else 'D' end,
  upper(btrim(bounded.airline)),
  upper(btrim(bounded.flight_number)),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  bounded.scheduled_date::text,
  to_char(bounded.scheduled_time, 'HH24:MI'),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  'active',
  bounded.scheduled_date,
  extract(hour from bounded.scheduled_time)::integer * 60
    + extract(minute from bounded.scheduled_time)::integer,
  coalesce(entity_recency.server_seq, day_recency.server_seq, bounded.backfill_server_seq),
  bounded.operational_date,
  bounded.scheduled_date + bounded.scheduled_time,
  (case bounded.side when 'ARR' then 'A' else 'D' end) || chr(31)
    || bounded.scheduled_date::text || chr(31)
    || upper(btrim(bounded.airline)) || chr(31)
    || upper(btrim(bounded.flight_number))
from bounded
left join reporting.operational_entity_recency_v1 entity_recency
  on entity_recency.target_id = bounded.leg_id::text
left join reporting.operational_day_recency_v1 day_recency
  on day_recency.ops_date = bounded.operational_date
$$;

alter function reporting.get_operational_candidate_slice_v1(date, date) owner to postgres;
revoke execute on function reporting.get_operational_candidate_slice_v1(date, date)
  from public, anon, authenticated, service_role;

-- Overload for discrete array of dirty operational dates
create or replace function reporting.get_operational_candidate_slice_dates_v1(
  p_dates date[]
) returns table (
  season_id text,
  record_id text,
  type text,
  airline text,
  flight_number text,
  route text,
  aircraft text,
  pax integer,
  scheduled_date text,
  scheduled_time text,
  effective_route text,
  effective_aircraft text,
  effective_pax integer,
  effective_action text,
  scheduled_date_value date,
  local_minutes integer,
  authoritative_server_seq bigint,
  ops_date date,
  scheduled_local_at timestamp without time zone,
  business_leg_key text
)
language sql
stable
security invoker
set search_path = pg_catalog, reporting, public, pg_temp
as $$
with bounded as materialized (
  select
    legs.leg_id,
    legs.leg_key,
    legs.operational_date,
    legs.scheduled_date,
    legs.scheduled_time,
    legs.side,
    legs.airline,
    legs.flight_number,
    legs.route,
    legs.aircraft_type,
    legs.pax,
    legs.source_season_id,
    links.authoritative_server_seq as backfill_server_seq
  from public.operational_flight_legs legs
  left join public.operational_leg_backfill_links links
    on links.leg_id = legs.leg_id
  where legs.status = 'active'
    and legs.operational_date = any(p_dates)
)
select
  bounded.source_season_id,
  bounded.leg_id::text,
  case bounded.side when 'ARR' then 'A' else 'D' end,
  upper(btrim(bounded.airline)),
  upper(btrim(bounded.flight_number)),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  bounded.scheduled_date::text,
  to_char(bounded.scheduled_time, 'HH24:MI'),
  upper(bounded.route),
  upper(bounded.aircraft_type),
  bounded.pax,
  'active',
  bounded.scheduled_date,
  extract(hour from bounded.scheduled_time)::integer * 60
    + extract(minute from bounded.scheduled_time)::integer,
  coalesce(entity_recency.server_seq, day_recency.server_seq, bounded.backfill_server_seq),
  bounded.operational_date,
  bounded.scheduled_date + bounded.scheduled_time,
  (case bounded.side when 'ARR' then 'A' else 'D' end) || chr(31)
    || bounded.scheduled_date::text || chr(31)
    || upper(btrim(bounded.airline)) || chr(31)
    || upper(btrim(bounded.flight_number))
from bounded
left join reporting.operational_entity_recency_v1 entity_recency
  on entity_recency.target_id = bounded.leg_id::text
left join reporting.operational_day_recency_v1 day_recency
  on day_recency.ops_date = bounded.operational_date
$$;

alter function reporting.get_operational_candidate_slice_dates_v1(date[]) owner to postgres;
revoke execute on function reporting.get_operational_candidate_slice_dates_v1(date[])
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Internal Incremental Refresh and Periodic Full Reconciliation
-- -----------------------------------------------------------------------------
create or replace function reporting.refresh_operational_canonical_legs_internal_v1(
  p_force_full boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
declare
  v_min_date date;
  v_max_date date;
  v_watermark bigint;
  v_operational_revision bigint;
  v_observed bigint;
  v_observed_revision bigint;
  v_leg_count integer;
  v_quarantine_count integer;
  v_state reporting.operational_canonical_flight_legs_state%rowtype;
  v_is_full boolean;
  v_cutover boolean;
  v_dirty_dates date[];
  v_expanded_dates date[];
  v_delta_legs integer;
  v_delta_quarantine integer;
  v_old_legs integer;
  v_old_quarantine integer;
begin
  -- Concurrency locks
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));
  perform 1 from public.operational_workspace_revision where singleton for share;

  select * into v_state
  from reporting.operational_canonical_flight_legs_state
  where singleton;

  select coalesce(max(events.server_seq), 0)::bigint into v_watermark
  from public.season_change_events events;

  select revision into v_operational_revision
  from public.operational_workspace_revision
  where singleton;

  v_cutover := reporting.is_operational_reader_cutover_active_v1();

  -- Decide full vs incremental reconciliation
  v_is_full := p_force_full
    or v_state.singleton is null
    or v_state.refreshed_at is null
    or v_state.last_reconciled_at is null
    or v_state.requires_full_reconcile
    or (v_watermark > coalesce(v_state.source_watermark, 0))
    or (v_state.last_reconciled_at < now() - interval '1 hour');

  if v_is_full then
    -- FULL RECONCILIATION
    select bounds.min_ops_date, bounds.max_ops_date
      into v_min_date, v_max_date
    from reporting.get_operational_canonical_bounds_v1() bounds;

    if v_min_date is null or v_max_date is null then
      truncate table reporting.operational_canonical_flight_legs;
      truncate table reporting.operational_canonical_flight_legs_quarantine;

      if v_cutover then
        truncate table reporting.canonical_flight_legs;
        truncate table reporting.canonical_flight_legs_quarantine;
      end if;

      truncate table reporting.operational_projection_dirty_scope_v1;

      insert into reporting.operational_canonical_flight_legs_state (
        singleton, refreshed_at, last_reconciled_at, requires_full_reconcile,
        source_operational_revision, source_watermark, observed_watermark,
        ops_min_date, ops_max_date, leg_count, quarantine_count
      ) values (
        true, now(), now(), false,
        v_operational_revision, v_watermark, v_watermark,
        null, null, 0, 0
      )
      on conflict (singleton) do update
        set refreshed_at = excluded.refreshed_at,
            last_reconciled_at = excluded.last_reconciled_at,
            requires_full_reconcile = false,
            source_operational_revision = excluded.source_operational_revision,
            source_watermark = excluded.source_watermark,
            observed_watermark = excluded.observed_watermark,
            ops_min_date = excluded.ops_min_date,
            ops_max_date = excluded.ops_max_date,
            leg_count = excluded.leg_count,
            quarantine_count = excluded.quarantine_count;
      return;
    end if;

    create temp table tmp_new_operational_slice on commit drop as
    with raw_candidates as materialized (
      select
        candidates.*,
        coalesce(legs.source_type = 'daily_import', false) as is_daily,
        coalesce(bool_or(legs.source_type = 'daily_import') over (partition by candidates.business_leg_key), false) as has_daily
      from reporting.get_operational_candidate_slice_v1(v_min_date - 1, v_max_date + 1) candidates
      left join public.operational_flight_legs legs
        on legs.leg_id::text = candidates.record_id
    ), eligible_slice as materialized (
      select
        raw.season_id, raw.record_id, raw.type, raw.airline, raw.flight_number,
        raw.route, raw.aircraft, raw.pax, raw.scheduled_date, raw.scheduled_time,
        raw.effective_route, raw.effective_aircraft, raw.effective_pax, raw.effective_action,
        raw.scheduled_date_value, raw.local_minutes, raw.authoritative_server_seq,
        raw.ops_date, raw.scheduled_local_at, raw.business_leg_key
      from raw_candidates raw
      where not raw.has_daily or raw.is_daily
    ), candidate_slice as materialized (
      select candidates.*,
        max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
      from eligible_slice candidates
    ), ranked_slice as (
      select candidates.*,
        count(*) over (partition by candidates.business_leg_key) as candidate_count,
        count(*) filter (where candidates.authoritative_server_seq is null)
          over (partition by candidates.business_leg_key) as missing_recency_count,
        count(*) filter (where candidates.authoritative_server_seq = candidates.max_authoritative_server_seq)
          over (partition by candidates.business_leg_key) as max_recency_count,
        row_number() over (
          partition by candidates.business_leg_key
          order by candidates.authoritative_server_seq desc nulls last, candidates.season_id, candidates.record_id
        ) as candidate_rank
      from candidate_slice candidates
    )
    select * from ranked_slice;

    create temp table tmp_new_operational_legs on commit drop as
    select
      ranked.business_leg_key,
      ranked.ops_date,
      upper(btrim(ranked.type)) as type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.flight_number)) as flight_number,
      coalesce(nullif(upper(btrim(ranked.effective_route)), ''), '') as route,
      coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
      case upper(btrim(coalesce(legs.flight_category, '')))
        when 'J' then 'J'
        else 'C'
      end as flight_category,
      ranked.effective_pax as pax,
      ranked.local_minutes,
      ranked.scheduled_local_at
    from tmp_new_operational_slice ranked
    left join public.operational_flight_legs legs
      on legs.leg_id::text = ranked.record_id
    where ranked.candidate_rank = 1
      and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1));

    create temp table tmp_new_operational_quarantine on commit drop as
    select distinct on (quarantine.business_leg_key)
      quarantine.business_leg_key,
      quarantine.ops_date,
      quarantine.candidate_count
    from (
      select 0 as source_rank, ledger.business_leg_key, ledger.ops_date, ledger.candidate_count
      from public.operational_leg_quarantine ledger
      where ledger.ops_date between v_min_date - 1 and v_max_date + 1

      union all

      select 1 as source_rank, candidates.business_leg_key, candidates.ops_date, candidates.candidate_count
      from tmp_new_operational_slice candidates
      where candidates.candidate_rank = 1
        and candidates.candidate_count > 1
        and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
    ) quarantine
    order by quarantine.business_leg_key, quarantine.source_rank;

    truncate table reporting.operational_canonical_flight_legs;
    insert into reporting.operational_canonical_flight_legs (
      business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
      flight_category, pax, local_minutes, scheduled_local_at
    )
    select * from tmp_new_operational_legs;

    truncate table reporting.operational_canonical_flight_legs_quarantine;
    insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
    select quarantine.ops_date, quarantine.candidate_count
    from tmp_new_operational_quarantine quarantine;

    if v_cutover then
      truncate table reporting.canonical_flight_legs;
      insert into reporting.canonical_flight_legs (
        business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
        flight_category, pax, local_minutes, scheduled_local_at
      )
      select * from reporting.operational_canonical_flight_legs;

      truncate table reporting.canonical_flight_legs_quarantine;
      insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
      select quarantine.ops_date, quarantine.candidate_count
      from reporting.operational_canonical_flight_legs_quarantine quarantine;
    end if;

    select count(*)::integer into v_leg_count from reporting.operational_canonical_flight_legs;
    select count(*)::integer into v_quarantine_count from reporting.operational_canonical_flight_legs_quarantine;

    truncate table reporting.operational_projection_dirty_scope_v1;

    select coalesce(max(events.server_seq), 0)::bigint into v_observed
    from public.season_change_events events;
    select revision into v_observed_revision
    from public.operational_workspace_revision
    where singleton;

    insert into reporting.operational_canonical_flight_legs_state (
      singleton, refreshed_at, last_reconciled_at, requires_full_reconcile,
      source_operational_revision, source_watermark, observed_watermark,
      ops_min_date, ops_max_date, leg_count, quarantine_count
    ) values (
      true, now(), now(), false,
      v_operational_revision, v_watermark,
      case when v_observed_revision > v_operational_revision then greatest(v_observed, v_watermark + 1) else v_observed end,
      v_min_date, v_max_date, v_leg_count, v_quarantine_count
    )
    on conflict (singleton) do update
      set refreshed_at = excluded.refreshed_at,
          last_reconciled_at = excluded.last_reconciled_at,
          requires_full_reconcile = false,
          source_operational_revision = excluded.source_operational_revision,
          source_watermark = excluded.source_watermark,
          observed_watermark = excluded.observed_watermark,
          ops_min_date = excluded.ops_min_date,
          ops_max_date = excluded.ops_max_date,
          leg_count = excluded.leg_count,
          quarantine_count = excluded.quarantine_count;

    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- INCREMENTAL RECONCILIATION
  -- ---------------------------------------------------------------------------
  create temp table tmp_claimed_dirty on commit drop as
  select enqueue_id, ops_date
  from reporting.operational_projection_dirty_scope_v1;

  if not exists (select 1 from tmp_claimed_dirty) then
    -- Queue is empty and state is fresh: fast-path exit
    return;
  end if;

  select array_agg(distinct ops_date) into v_dirty_dates
  from tmp_claimed_dirty;

  -- Expand dirty dates to cover:
  -- 1) Any operational date sharing scheduled dates with dirty dates (handles 05:00 cut-off shifts)
  -- 2) Any operational date where a prior winner for the affected scheduled business keys existed
  select coalesce(array_agg(distinct d), '{}'::date[]) into v_expanded_dates
  from (
    select unnest(v_dirty_dates) as d
    union
    select distinct legs.operational_date as d
    from public.operational_flight_legs legs
    where legs.scheduled_date in (
      select distinct scheduled_date
      from public.operational_flight_legs
      where operational_date = any(v_dirty_dates)
    )
    union
    select distinct proj.ops_date as d
    from reporting.operational_canonical_flight_legs proj
    where proj.scheduled_local_at::date in (
      select distinct scheduled_date
      from public.operational_flight_legs
      where operational_date = any(v_dirty_dates)
    )
  ) expanded;

  if v_expanded_dates is null or cardinality(v_expanded_dates) = 0 then
    delete from reporting.operational_projection_dirty_scope_v1
    where enqueue_id in (select enqueue_id from tmp_claimed_dirty);
    return;
  end if;

  -- Candidate slice for expanded dirty dates
  create temp table tmp_inc_slice on commit drop as
  with raw_candidates as materialized (
    select
      candidates.*,
      coalesce(legs.source_type = 'daily_import', false) as is_daily,
      coalesce(bool_or(legs.source_type = 'daily_import') over (partition by candidates.business_leg_key), false) as has_daily
    from reporting.get_operational_candidate_slice_dates_v1(v_expanded_dates) candidates
    left join public.operational_flight_legs legs
      on legs.leg_id::text = candidates.record_id
  ), eligible_slice as materialized (
    select
      raw.season_id, raw.record_id, raw.type, raw.airline, raw.flight_number,
      raw.route, raw.aircraft, raw.pax, raw.scheduled_date, raw.scheduled_time,
      raw.effective_route, raw.effective_aircraft, raw.effective_pax, raw.effective_action,
      raw.scheduled_date_value, raw.local_minutes, raw.authoritative_server_seq,
      raw.ops_date, raw.scheduled_local_at, raw.business_leg_key
    from raw_candidates raw
    where not raw.has_daily or raw.is_daily
  ), candidate_slice as materialized (
    select candidates.*,
      max(candidates.authoritative_server_seq) over (partition by candidates.business_leg_key) as max_authoritative_server_seq
    from eligible_slice candidates
  ), ranked_slice as (
    select candidates.*,
      count(*) over (partition by candidates.business_leg_key) as candidate_count,
      count(*) filter (where candidates.authoritative_server_seq is null)
        over (partition by candidates.business_leg_key) as missing_recency_count,
      count(*) filter (where candidates.authoritative_server_seq = candidates.max_authoritative_server_seq)
        over (partition by candidates.business_leg_key) as max_recency_count,
      row_number() over (
        partition by candidates.business_leg_key
        order by candidates.authoritative_server_seq desc nulls last, candidates.season_id, candidates.record_id
      ) as candidate_rank
    from candidate_slice candidates
  )
  select * from ranked_slice;

  create temp table tmp_inc_legs on commit drop as
  select
    ranked.business_leg_key,
    ranked.ops_date,
    upper(btrim(ranked.type)) as type,
    upper(btrim(ranked.airline)) as airline,
    upper(btrim(ranked.flight_number)) as flight_number,
    coalesce(nullif(upper(btrim(ranked.effective_route)), ''), '') as route,
    coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
    case upper(btrim(coalesce(legs.flight_category, '')))
      when 'J' then 'J'
      else 'C'
    end as flight_category,
    ranked.effective_pax as pax,
    ranked.local_minutes,
    ranked.scheduled_local_at
  from tmp_inc_slice ranked
  left join public.operational_flight_legs legs
    on legs.leg_id::text = ranked.record_id
  where ranked.candidate_rank = 1
    and not (ranked.candidate_count > 1 and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1));

  create temp table tmp_inc_quarantine on commit drop as
  select distinct on (quarantine.business_leg_key)
    quarantine.business_leg_key,
    quarantine.ops_date,
    quarantine.candidate_count
  from (
    select 0 as source_rank, ledger.business_leg_key, ledger.ops_date, ledger.candidate_count
    from public.operational_leg_quarantine ledger
    where ledger.ops_date = any(v_expanded_dates)

    union all

    select 1 as source_rank, candidates.business_leg_key, candidates.ops_date, candidates.candidate_count
    from tmp_inc_slice candidates
    where candidates.candidate_rank = 1
      and candidates.candidate_count > 1
      and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
  ) quarantine
  order by quarantine.business_leg_key, quarantine.source_rank;

  -- Count rows being replaced for delta calculation
  select count(*)::integer into v_old_legs
  from reporting.operational_canonical_flight_legs
  where ops_date = any(v_expanded_dates);

  select count(*)::integer into v_old_quarantine
  from reporting.operational_canonical_flight_legs_quarantine
  where ops_date = any(v_expanded_dates);

  select count(*)::integer into v_delta_legs from tmp_inc_legs;
  select count(*)::integer into v_delta_quarantine from tmp_inc_quarantine;

  -- Delete replaced scope from operational projection
  delete from reporting.operational_canonical_flight_legs
  where ops_date = any(v_expanded_dates);

  delete from reporting.operational_canonical_flight_legs_quarantine
  where ops_date = any(v_expanded_dates);

  -- Insert newly resolved legs and quarantine
  insert into reporting.operational_canonical_flight_legs (
    business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
    flight_category, pax, local_minutes, scheduled_local_at
  )
  select * from tmp_inc_legs;

  insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
  select quarantine.ops_date, quarantine.candidate_count
  from tmp_inc_quarantine quarantine;

  -- Mirror to public canonical tables if cutover is active
  if v_cutover then
    delete from reporting.canonical_flight_legs
    where ops_date = any(v_expanded_dates);

    delete from reporting.canonical_flight_legs_quarantine
    where ops_date = any(v_expanded_dates);

    insert into reporting.canonical_flight_legs (
      business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
      flight_category, pax, local_minutes, scheduled_local_at
    )
    select * from tmp_inc_legs;

    insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
    select quarantine.ops_date, quarantine.candidate_count
    from tmp_inc_quarantine quarantine;
  end if;

  -- Delete claimed dirty rows
  delete from reporting.operational_projection_dirty_scope_v1
  where enqueue_id in (select enqueue_id from tmp_claimed_dirty);

  -- Determine bounds efficiently
  select min(ops_date), max(ops_date)
  into v_min_date, v_max_date
  from reporting.operational_canonical_flight_legs;

  v_leg_count := greatest(0, coalesce(v_state.leg_count, 0) - v_old_legs + v_delta_legs);
  v_quarantine_count := greatest(0, coalesce(v_state.quarantine_count, 0) - v_old_quarantine + v_delta_quarantine);

  select coalesce(max(events.server_seq), 0)::bigint into v_observed
  from public.season_change_events events;
  select revision into v_observed_revision
  from public.operational_workspace_revision
  where singleton;

  insert into reporting.operational_canonical_flight_legs_state (
    singleton, refreshed_at, last_reconciled_at, requires_full_reconcile,
    source_operational_revision, source_watermark, observed_watermark,
    ops_min_date, ops_max_date, leg_count, quarantine_count
  ) values (
    true, now(), coalesce(v_state.last_reconciled_at, now()), false,
    v_operational_revision, v_watermark,
    case when v_observed_revision > v_operational_revision then greatest(v_observed, v_watermark + 1) else v_observed end,
    v_min_date, v_max_date, v_leg_count, v_quarantine_count
  )
  on conflict (singleton) do update
    set refreshed_at = excluded.refreshed_at,
        source_operational_revision = excluded.source_operational_revision,
        source_watermark = excluded.source_watermark,
        observed_watermark = excluded.observed_watermark,
        ops_min_date = excluded.ops_min_date,
        ops_max_date = excluded.ops_max_date,
        leg_count = excluded.leg_count,
        quarantine_count = excluded.quarantine_count;
end;
$function$;

-- Preserve public 0-argument signature exactly
create or replace function reporting.refresh_operational_canonical_legs_v1()
returns void
language sql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $$
  select reporting.refresh_operational_canonical_legs_internal_v1(false);
$$;

revoke execute on function reporting.refresh_operational_canonical_legs_v1() from public, anon, authenticated;
grant execute on function reporting.refresh_operational_canonical_legs_v1() to service_role;

-- Overload for forced full reconciliation
create or replace function reporting.refresh_operational_canonical_legs_v1(
  p_force_full boolean
)
returns void
language sql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $$
  select reporting.refresh_operational_canonical_legs_internal_v1(p_force_full);
$$;

revoke execute on function reporting.refresh_operational_canonical_legs_v1(boolean) from public, anon, authenticated;
grant execute on function reporting.refresh_operational_canonical_legs_v1(boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 8. Updated Freshness and Periodic Reconcile Status Function
-- -----------------------------------------------------------------------------
create or replace function reporting.operational_projection_status_v1()
returns table (
  is_fresh boolean,
  refreshed_at timestamp with time zone,
  source_watermark bigint,
  observed_watermark bigint,
  current_watermark bigint,
  leg_count integer,
  quarantine_count integer,
  ops_min_date date,
  ops_max_date date
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
  with dirty as (
    select count(*)::bigint as pending_count
    from reporting.operational_projection_dirty_scope_v1
  ), live_watermarks as (
    select coalesce(max(events.server_seq), 0)::bigint as current_watermark
    from public.season_change_events events
  ), live_rev as (
    select revision as current_revision
    from public.operational_workspace_revision
    where singleton
  )
  select
    coalesce(
      state.source_watermark >= watermarks.current_watermark
      and state.source_operational_revision = rev.current_revision
      and dirty.pending_count = 0
      and not state.requires_full_reconcile,
      false
    ) as is_fresh,
    state.refreshed_at,
    state.source_watermark,
    state.observed_watermark,
    watermarks.current_watermark,
    state.leg_count,
    state.quarantine_count,
    state.ops_min_date,
    state.ops_max_date
  from (select true as singleton) s
  cross join live_watermarks watermarks
  cross join live_rev rev
  cross join dirty
  left join reporting.operational_canonical_flight_legs_state state on state.singleton
$$;

alter function reporting.operational_projection_status_v1() owner to postgres;
revoke execute on function reporting.operational_projection_status_v1() from public, anon, authenticated;
grant execute on function reporting.operational_projection_status_v1() to service_role;

comment on function reporting.operational_projection_status_v1()
is 'Operational projection freshness status.';

create or replace function reporting.operational_projection_reconcile_due_v1()
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'pg_temp'
as $$
  select coalesce(
    state.requires_full_reconcile
    or state.last_reconciled_at is null
    or state.last_reconciled_at < now() - interval '1 hour',
    false
  )
  from (select true as singleton) s
  left join reporting.operational_canonical_flight_legs_state state on state.singleton
$$;

alter function reporting.operational_projection_reconcile_due_v1() owner to postgres;
revoke execute on function reporting.operational_projection_reconcile_due_v1() from public, anon, authenticated;
grant execute on function reporting.operational_projection_reconcile_due_v1() to service_role;

comment on function reporting.operational_projection_reconcile_due_v1()
is 'Checks whether full periodic reconciliation is required.';

commit;
