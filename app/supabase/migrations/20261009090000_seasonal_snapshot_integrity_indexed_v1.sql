-- ============================================================================
-- Migration: 20261009090000_seasonal_snapshot_integrity_indexed_v1.sql
-- Native seasonal version management:
--   1. Capture function preimages for surgical rollback restoration
--   2. Simplified derived relational storage for published snapshot flights (indexed bounded seek)
--   3. Persistent comparison cache for arbitrary version diffs (keyed by version identities + algorithm)
--   4. Snapshot mutation guards enforcing DB immutability on DELETE/TRUNCATE/UPDATE (idempotent backfill allowed)
--   5. Seek-based published snapshot paging using certified active count (no full JSON hash in STABLE)
--   6. Checksum validation at write/derivation/export/restore boundaries preventing corruption & silent fallback
-- ============================================================================

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 1. Certified active_flight_count column on seasonal_publish_snapshots
-- ---------------------------------------------------------------------------
alter table public.seasonal_publish_snapshots
  add column if not exists active_flight_count integer;

-- ---------------------------------------------------------------------------
-- 2. Derived relational storage for published snapshot flights
--    - Simplified schema: version_id, season_id, draft_id, status, draft_payload
--    - Keyed by (version_id, draft_id)
--    - Strict FK to versions on delete restrict (prevent destructive cascade)
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_published_snapshot_flights (
  snapshot_id uuid not null references public.seasonal_publish_snapshots(snapshot_id) on delete cascade,
  version_id uuid not null,
  season_id text not null,
  draft_id text not null,
  status text not null default 'active',
  draft_payload jsonb not null check (jsonb_typeof(draft_payload) = 'object'),
  created_at timestamp with time zone not null default now(),
  primary key (version_id, draft_id),
  constraint seasonal_published_snapshot_flights_version_season_fkey
    foreign key (version_id, season_id)
    references public.seasonal_publish_versions (version_id, season_id)
    on delete restrict
);

comment on table public.seasonal_published_snapshot_flights is
  'Immutable derived flight rows normalized from canonical publish snapshots. Indexed for seek-based pagination without full JSON unpacking.';

create index if not exists seasonal_published_snapshot_flights_seek_active_idx
  on public.seasonal_published_snapshot_flights (version_id, draft_id)
  where status = 'active';

alter table public.seasonal_published_snapshot_flights enable row level security;

drop policy if exists "seasonal published snapshot flights read" on public.seasonal_published_snapshot_flights;
create policy "seasonal published snapshot flights read" on public.seasonal_published_snapshot_flights
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

revoke all on public.seasonal_published_snapshot_flights from public, anon, authenticated;
grant select on public.seasonal_published_snapshot_flights to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Persistent comparison cache for arbitrary version diff pagination
--    - Header table: seasonal_publish_diff_cache_runs (keyed by season_id, base_version_id, version_id, algorithm)
--    - Entry table: seasonal_publish_diff_cache_entries (indexed seek)
--    - Zero-entry completion marker avoids recalculation for unchanged version diffs
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_publish_diff_cache_runs (
  run_id uuid primary key default gen_random_uuid(),
  season_id text not null,
  base_version_id uuid,
  version_id uuid not null,
  base_checksum text not null,
  target_checksum text not null,
  algorithm_version integer not null default 1,
  entry_count integer default null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  created_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  constraint seasonal_publish_diff_cache_runs_version_fkey
    foreign key (version_id, season_id)
    references public.seasonal_publish_versions (version_id, season_id)
    on delete cascade
);

comment on table public.seasonal_publish_diff_cache_runs is
  'Persistent comparison cache runs keyed by version identities, checksums and algorithm version. Holds completion marker for O(1) empty diffs.';

create unique index if not exists seasonal_publish_diff_cache_runs_key_idx
  on public.seasonal_publish_diff_cache_runs (
    season_id,
    coalesce(base_version_id, '00000000-0000-0000-0000-000000000000'::uuid),
    version_id,
    algorithm_version
  );

create table if not exists public.seasonal_publish_diff_cache_entries (
  run_id uuid not null references public.seasonal_publish_diff_cache_runs(run_id) on delete cascade,
  entry_index bigint not null,
  diff_id uuid not null,
  change_type text not null check (change_type in ('added', 'modified', 'removed')),
  flight_key text not null,
  source_draft_id text,
  operational_date date not null,
  side text not null check (side in ('ARR', 'DEP')),
  airline text not null,
  flight_number text not null,
  before_state jsonb,
  after_state jsonb,
  changed_fields text[] not null default array[]::text[],
  created_at timestamp with time zone not null default now(),
  primary key (run_id, entry_index)
);

create index if not exists seasonal_publish_diff_cache_entries_seek_idx
  on public.seasonal_publish_diff_cache_entries (run_id, entry_index);

alter table public.seasonal_publish_diff_cache_runs enable row level security;
alter table public.seasonal_publish_diff_cache_entries enable row level security;

drop policy if exists "seasonal publish diff cache runs read" on public.seasonal_publish_diff_cache_runs;
create policy "seasonal publish diff cache runs read" on public.seasonal_publish_diff_cache_runs
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

drop policy if exists "seasonal publish diff cache entries read" on public.seasonal_publish_diff_cache_entries;
create policy "seasonal publish diff cache entries read" on public.seasonal_publish_diff_cache_entries
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

revoke all on public.seasonal_publish_diff_cache_runs, public.seasonal_publish_diff_cache_entries from public, anon, authenticated;
grant select on public.seasonal_publish_diff_cache_runs, public.seasonal_publish_diff_cache_entries to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Internal trusted derivation function (write boundary validation)
-- ---------------------------------------------------------------------------
create or replace function public.internal_derive_seasonal_published_snapshot_flights_v1(
  p_snapshot_id uuid,
  p_version_id uuid,
  p_season_id text,
  p_snapshot_payload jsonb,
  p_checksum text
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_inserted integer := 0;
  v_calc_checksum text;
begin
  -- Validate canonical checksum at derivation write boundary
  v_calc_checksum := encode(sha256(convert_to(p_snapshot_payload::text, 'UTF8')), 'hex');
  if p_checksum is distinct from v_calc_checksum then
    raise exception 'Published snapshot payload checksum mismatch at derivation boundary' using errcode = '55000';
  end if;

  with inserted as (
    insert into public.seasonal_published_snapshot_flights (
      snapshot_id, version_id, season_id, draft_id, status, draft_payload
    )
    select
      p_snapshot_id,
      p_version_id,
      p_season_id,
      norm->>'draft_id',
      coalesce(norm->>'status', 'active'),
      norm
    from jsonb_array_elements(coalesce(p_snapshot_payload->'flights', '[]'::jsonb)) f
    cross join lateral public.seasonal_published_flight_to_draft_json_v1(f, p_season_id) norm
    where norm->>'draft_id' is not null
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$$;

revoke all on function public.internal_derive_seasonal_published_snapshot_flights_v1(uuid, uuid, text, jsonb, text) from public, anon, authenticated;

-- Derivation trigger on seasonal_publish_snapshots (after insert)
create or replace function public.seasonal_publish_snapshots_derive_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.internal_derive_seasonal_published_snapshot_flights_v1(
    new.snapshot_id, new.version_id, new.season_id, new.snapshot_payload, new.checksum
  );
  return new;
end;
$$;

revoke all on function public.seasonal_publish_snapshots_derive_trigger_v1() from public, anon, authenticated;

drop trigger if exists seasonal_publish_snapshots_derive_trigger on public.seasonal_publish_snapshots;
create trigger seasonal_publish_snapshots_derive_trigger
after insert on public.seasonal_publish_snapshots
for each row
execute function public.seasonal_publish_snapshots_derive_trigger_v1();

-- ---------------------------------------------------------------------------
-- 5. Immutability guards on parent & derived tables
-- ---------------------------------------------------------------------------

-- Before insert certification on seasonal_publish_snapshots
create or replace function public.seasonal_publish_snapshots_certify_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_active integer;
  v_calc_checksum text;
begin
  -- Validate canonical checksum at insert time
  v_calc_checksum := encode(sha256(convert_to(new.snapshot_payload::text, 'UTF8')), 'hex');
  if new.checksum is null or btrim(new.checksum) = '' then
    new.checksum := v_calc_checksum;
  elsif new.checksum is distinct from v_calc_checksum then
    raise exception 'Published snapshot payload checksum mismatch at insert boundary' using errcode = '55000';
  end if;

  -- Certify exact active flight count
  v_active := (new.snapshot_payload#>>'{counts,active}')::integer;
  if v_active is null then
    select count(*)::integer into v_active
    from jsonb_array_elements(coalesce(new.snapshot_payload->'flights', '[]'::jsonb)) f
    where coalesce(f->>'status', 'active') = 'active';
  end if;
  new.active_flight_count := v_active;

  return new;
end;
$$;

revoke all on function public.seasonal_publish_snapshots_certify_v1() from public, anon, authenticated;

drop trigger if exists seasonal_publish_snapshots_certify_trigger on public.seasonal_publish_snapshots;
create trigger seasonal_publish_snapshots_certify_trigger
before insert on public.seasonal_publish_snapshots
for each row
execute function public.seasonal_publish_snapshots_certify_v1();

-- Guard on seasonal_publish_snapshots:
-- Prohibits TRUNCATE;
-- Prohibits DELETE by non-admin roles (permission denied);
-- Allows idempotent UPDATE only if ALL invariant fields are identical;
create or replace function public.seasonal_publish_snapshots_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op in ('TRUNCATE', 'DELETE') then
    raise exception 'Published snapshots are immutable and cannot be deleted or truncated' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if new.snapshot_id = old.snapshot_id
       and new.version_id = old.version_id
       and new.season_id = old.season_id
       and new.flight_count = old.flight_count
       and new.checksum = old.checksum
       and new.snapshot_payload = old.snapshot_payload
       and (new.active_flight_count is not distinct from old.active_flight_count or old.active_flight_count is null) then
      return new;
    end if;

    raise exception 'Published snapshots are immutable: payload, checksum, or identifiers cannot be altered' using errcode = '22023';
  end if;

  return old;
end;
$$;

revoke all on function public.seasonal_publish_snapshots_guard_v1() from public, anon, authenticated;

drop trigger if exists seasonal_publish_snapshots_guard_trigger on public.seasonal_publish_snapshots;
create trigger seasonal_publish_snapshots_guard_trigger
before update or delete on public.seasonal_publish_snapshots
for each row
execute function public.seasonal_publish_snapshots_guard_v1();

drop trigger if exists seasonal_publish_snapshots_truncate_guard on public.seasonal_publish_snapshots;
create trigger seasonal_publish_snapshots_truncate_guard
before truncate on public.seasonal_publish_snapshots
for each statement execute function public.seasonal_publish_snapshots_guard_v1();

-- Guard on seasonal_published_snapshot_flights:
create or replace function public.seasonal_published_snapshot_flights_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op in ('TRUNCATE', 'DELETE') then
    raise exception 'Published snapshot flights are immutable and cannot be deleted or truncated' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if new.* is not distinct from old.* then
      return new;
    end if;
    raise exception 'Published snapshot flights are immutable and cannot be modified' using errcode = '22023';
  end if;

  return old;
end;
$$;

revoke all on function public.seasonal_published_snapshot_flights_guard_v1() from public, anon, authenticated;

drop trigger if exists seasonal_published_snapshot_flights_guard_trigger on public.seasonal_published_snapshot_flights;
create trigger seasonal_published_snapshot_flights_guard_trigger
before update or delete on public.seasonal_published_snapshot_flights
for each row
execute function public.seasonal_published_snapshot_flights_guard_v1();

drop trigger if exists seasonal_published_snapshot_flights_truncate_guard on public.seasonal_published_snapshot_flights;
create trigger seasonal_published_snapshot_flights_truncate_guard
before truncate on public.seasonal_published_snapshot_flights
for each statement execute function public.seasonal_published_snapshot_flights_guard_v1();

-- Guard on seasonal_publish_versions:
create or replace function public.seasonal_publish_versions_guard_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op in ('TRUNCATE', 'DELETE') then
    raise exception 'Published versions are immutable and cannot be deleted or truncated' using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if new.version_id = old.version_id
       and new.season_id = old.season_id
       and new.season_code = old.season_code
       and new.version_tag = old.version_tag
       and new.total_flight_count = old.total_flight_count
       and new.snapshot_checksum = old.snapshot_checksum
       and new.publish_sequence is not distinct from old.publish_sequence
       and new.range_start is not distinct from old.range_start
       and new.range_end is not distinct from old.range_end then
      return new;
    end if;
    raise exception 'Published versions are immutable: published metadata cannot be altered' using errcode = '22023';
  end if;

  return old;
end;
$$;

revoke all on function public.seasonal_publish_versions_guard_v1() from public, anon, authenticated;

drop trigger if exists seasonal_publish_versions_guard_trigger on public.seasonal_publish_versions;
create trigger seasonal_publish_versions_guard_trigger
before update or delete on public.seasonal_publish_versions
for each row
execute function public.seasonal_publish_versions_guard_v1();

drop trigger if exists seasonal_publish_versions_truncate_guard on public.seasonal_publish_versions;
create trigger seasonal_publish_versions_truncate_guard
before truncate on public.seasonal_publish_versions
for each statement execute function public.seasonal_publish_versions_guard_v1();

-- ---------------------------------------------------------------------------
-- 6. Backfill existing published snapshots into relational derived storage
-- ---------------------------------------------------------------------------
do $$
declare
  v_snap public.seasonal_publish_snapshots%rowtype;
  v_active integer;
begin
  for v_snap in select * from public.seasonal_publish_snapshots order by created_at loop
    v_active := (v_snap.snapshot_payload#>>'{counts,active}')::integer;
    if v_active is null then
      select count(*)::integer into v_active
      from jsonb_array_elements(coalesce(v_snap.snapshot_payload->'flights', '[]'::jsonb)) f
      where coalesce(f->>'status', 'active') = 'active';
    end if;

    update public.seasonal_publish_snapshots
    set active_flight_count = v_active
    where snapshot_id = v_snap.snapshot_id;

    if not exists (select 1 from public.seasonal_published_snapshot_flights where version_id = v_snap.version_id limit 1) then
      perform public.internal_derive_seasonal_published_snapshot_flights_v1(
        v_snap.snapshot_id, v_snap.version_id, v_snap.season_id, v_snap.snapshot_payload, v_snap.checksum
      );
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Upgraded get_seasonal_published_snapshot_page_v1
--    - Pure STABLE read: seek index on seasonal_published_snapshot_flights
--    - Reads certified active count in O(1) without JSON unpack/hash
--    - No write/self-healing inside STABLE function
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'get_seasonal_published_snapshot_page_v1')
     and not exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_published_snapshot_page_v1') then
    select pg_get_functiondef('public.get_seasonal_published_snapshot_page_v1(uuid, text, integer)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.get_seasonal_published_snapshot_page_v1', 'FUNCTION public.preimage_get_seasonal_published_snapshot_page_v1');
    execute v_fn;
    revoke all on function public.preimage_get_seasonal_published_snapshot_page_v1(uuid, text, integer) from public, anon, authenticated;
  end if;
end;
$$;

create or replace function public.get_seasonal_published_snapshot_page_v1(
  p_version_id uuid,
  p_after_draft_id text default null,
  p_page_size integer default 200
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version public.seasonal_publish_versions%rowtype;
  v_snapshot public.seasonal_publish_snapshots%rowtype;
  v_result jsonb;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  if p_page_size is null or p_page_size not between 1 and 1000 then
    raise exception 'Invalid page size' using errcode = '22023';
  end if;

  select * into v_version
  from public.seasonal_publish_versions
  where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  select * into v_snapshot
  from public.seasonal_publish_snapshots
  where version_id = p_version_id;
  if not found then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  with candidates as materialized (
    select draft_payload, draft_id
    from public.seasonal_published_snapshot_flights
    where version_id = p_version_id
      and status = 'active'
      and (p_after_draft_id is null or draft_id > p_after_draft_id)
    order by draft_id
    limit p_page_size + 1
  ), page as (
    select draft_payload, draft_id
    from candidates
    order by draft_id
    limit p_page_size
  )
  select jsonb_build_object(
    'versionId', v_version.version_id,
    'seasonId', v_version.season_id,
    'seasonCode', v_version.season_code,
    'checksum', v_snapshot.checksum,
    'totalCount', coalesce(v_snapshot.active_flight_count, (v_snapshot.snapshot_payload#>>'{counts,active}')::integer, v_snapshot.flight_count, 0),
    'flights', coalesce((select jsonb_agg(draft_payload order by draft_id) from page), '[]'::jsonb),
    'hasMore', (select count(*) from candidates) > p_page_size,
    'nextDraftId', (select max(draft_id) from page)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Upgraded get_seasonal_version_comparison_page_v1
--    - Persistent comparison cache keyed by (season_id, base_version_id, version_id, algorithm)
--    - Singleflight advisory lock preventing redundant concurrent diff computation
--    - Empty diff completion marker for O(1) unchanged diff paging
--    - Explicit read-only mode dynamic computation without fake success
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if exists (select 1 from pg_proc where proname = 'get_seasonal_version_comparison_page_v1')
     and not exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_version_comparison_page_v1') then
    select pg_get_functiondef('public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer)'::regprocedure) into v_fn;
    v_fn := replace(v_fn, 'FUNCTION public.get_seasonal_version_comparison_page_v1', 'FUNCTION public.preimage_get_seasonal_version_comparison_page_v1');
    execute v_fn;
    revoke all on function public.preimage_get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) from public, anon, authenticated;
  end if;
end;
$$;

create or replace function public.get_seasonal_version_comparison_page_v1(
  p_base_version_id uuid,
  p_version_id uuid,
  p_after_index bigint default 0,
  p_page_size integer default 100
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_base_version public.seasonal_publish_versions%rowtype;
  v_version public.seasonal_publish_versions%rowtype;
  v_base_snapshot public.seasonal_publish_snapshots%rowtype;
  v_snapshot public.seasonal_publish_snapshots%rowtype;
  v_cache_run public.seasonal_publish_diff_cache_runs%rowtype;
  v_result jsonb;
  v_matches_stored boolean := false;
  v_run_id uuid;
  v_entry_count integer := 0;
begin
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  if p_page_size is null or p_page_size not between 1 and 500 or p_after_index is null or p_after_index < 0 then
    raise exception 'Invalid diff page' using errcode = '22023';
  end if;

  if p_version_id is null then
    raise exception 'Version ID required' using errcode = '22023';
  end if;

  select * into v_version from public.seasonal_publish_versions where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  select * into v_snapshot from public.seasonal_publish_snapshots where version_id = p_version_id;
  if not found then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  if p_base_version_id is not null then
    select * into v_base_version from public.seasonal_publish_versions where version_id = p_base_version_id;
    if not found then
      raise exception 'Base version not found' using errcode = 'P0002';
    end if;

    if v_base_version.season_id <> v_version.season_id then
      raise exception 'Cannot compare versions across different seasons' using errcode = '22023';
    end if;

    select * into v_base_snapshot from public.seasonal_publish_snapshots where version_id = p_base_version_id;
    if not found then
      raise exception 'Base snapshot not found' using errcode = 'P0002';
    end if;
  end if;

  -- Fast path 1: if exact pair exists in pre-calculated diff entries
  select exists (
    select 1
    from public.seasonal_publish_diff_entries
    where version_id = p_version_id
      and (base_version_id is not distinct from p_base_version_id)
  ) into v_matches_stored;

  if v_matches_stored then
    with candidates as materialized (
      select *
      from public.seasonal_publish_diff_entries
      where version_id = p_version_id
        and (base_version_id is not distinct from p_base_version_id)
        and entry_index > p_after_index
      order by entry_index
      limit p_page_size + 1
    ), page as (
      select *
      from candidates
      order by entry_index
      limit p_page_size
    )
    select jsonb_build_object(
      'entries', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('entry_index', p.entry_index::text) order by p.entry_index) from page p), '[]'::jsonb),
      'hasMore', (select count(*) > p_page_size from candidates),
      'nextIndex', (select max(p.entry_index)::text from page p)
    ) into v_result;

    return v_result;
  end if;

  -- Fast path 2: Check persistent comparison cache run
  select * into v_cache_run
  from public.seasonal_publish_diff_cache_runs
  where season_id = v_version.season_id
    and (base_version_id is not distinct from p_base_version_id)
    and version_id = p_version_id
    and algorithm_version = 1
    and status = 'completed';

  if found then
    if v_cache_run.entry_count = 0 then
      return jsonb_build_object('entries', '[]'::jsonb, 'hasMore', false, 'nextIndex', null);
    end if;

    with candidates as materialized (
      select *
      from public.seasonal_publish_diff_cache_entries
      where run_id = v_cache_run.run_id
        and entry_index > p_after_index
      order by entry_index
      limit p_page_size + 1
    ), page as (
      select *
      from candidates
      order by entry_index
      limit p_page_size
    )
    select jsonb_build_object(
      'entries', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'diff_id', p.diff_id::text,
            'version_id', p_version_id::text,
            'base_version_id', case when p_base_version_id is not null then p_base_version_id::text else null end,
            'season_id', v_version.season_id,
            'change_type', p.change_type,
            'flight_key', p.flight_key,
            'source_draft_id', p.source_draft_id,
            'operational_date', p.operational_date::text,
            'side', p.side,
            'airline', p.airline,
            'flight_number', p.flight_number,
            'before_state', p.before_state,
            'after_state', p.after_state,
            'changed_fields', to_jsonb(p.changed_fields),
            'created_at', p.created_at,
            'entry_index', p.entry_index::text
          ) order by p.entry_index
        ) from page p
      ), '[]'::jsonb),
      'hasMore', (select count(*) > p_page_size from candidates),
      'nextIndex', (select max(p.entry_index)::text from page p)
    ) into v_result;

    return v_result;
  end if;

  -- Handle explicit read-only transactions without attempting cache write
  if current_setting('transaction_read_only', true) = 'on' then
    with raw_diff as materialized (
      select *
      from public.seasonal_planning_diff_v1(
        coalesce(v_base_snapshot.snapshot_payload, '{}'::jsonb),
        v_snapshot.snapshot_payload
      )
      where change_type in ('added', 'modified', 'removed')
    ), ordered_diff as (
      select
        row_number() over (order by operational_date, side, flight_number, source_draft_id) as entry_index,
        gen_random_uuid() as diff_id,
        p_version_id as version_id,
        p_base_version_id as base_version_id,
        v_version.season_id as season_id,
        change_type,
        flight_key,
        source_draft_id,
        operational_date,
        side,
        airline,
        flight_number,
        before_state,
        after_state,
        changed_fields
      from raw_diff
    ), candidates as materialized (
      select *
      from ordered_diff
      where entry_index > p_after_index
      order by entry_index
      limit p_page_size + 1
    ), page as (
      select *
      from candidates
      order by entry_index
      limit p_page_size
    )
    select jsonb_build_object(
      'entries', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('entry_index', p.entry_index::text) order by p.entry_index) from page p), '[]'::jsonb),
      'hasMore', (select count(*) > p_page_size from candidates),
      'nextIndex', (select max(p.entry_index)::text from page p)
    ) into v_result;

    return v_result;
  end if;

  -- Singleflight lock for computing and storing comparison cache
  perform pg_advisory_xact_lock(hashtextextended('diff-cache:' || v_version.season_id || ':' || coalesce(p_base_version_id::text, 'none') || ':' || p_version_id::text, 0));

  -- Clean up any incomplete run from an aborted transaction if one exists
  delete from public.seasonal_publish_diff_cache_runs
  where season_id = v_version.season_id
    and (base_version_id is not distinct from p_base_version_id)
    and version_id = p_version_id
    and algorithm_version = 1
    and status = 'in_progress';

  -- Re-check completed cache run after obtaining lock
  select * into v_cache_run
  from public.seasonal_publish_diff_cache_runs
  where season_id = v_version.season_id
    and (base_version_id is not distinct from p_base_version_id)
    and version_id = p_version_id
    and algorithm_version = 1
    and status = 'completed';
  if found then
    if v_cache_run.entry_count = 0 then
      return jsonb_build_object('entries', '[]'::jsonb, 'hasMore', false, 'nextIndex', null);
    end if;

    with candidates as materialized (
      select *
      from public.seasonal_publish_diff_cache_entries
      where run_id = v_cache_run.run_id
        and entry_index > p_after_index
      order by entry_index
      limit p_page_size + 1
    ), page as (
      select *
      from candidates
      order by entry_index
      limit p_page_size
    )
    select jsonb_build_object(
      'entries', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'diff_id', p.diff_id::text,
            'version_id', p_version_id::text,
            'base_version_id', case when p_base_version_id is not null then p_base_version_id::text else null end,
            'season_id', v_version.season_id,
            'change_type', p.change_type,
            'flight_key', p.flight_key,
            'source_draft_id', p.source_draft_id,
            'operational_date', p.operational_date::text,
            'side', p.side,
            'airline', p.airline,
            'flight_number', p.flight_number,
            'before_state', p.before_state,
            'after_state', p.after_state,
            'changed_fields', to_jsonb(p.changed_fields),
            'created_at', p.created_at,
            'entry_index', p.entry_index::text
          ) order by p.entry_index
        ) from page p
      ), '[]'::jsonb),
      'hasMore', (select count(*) > p_page_size from candidates),
      'nextIndex', (select max(p.entry_index)::text from page p)
    ) into v_result;

    return v_result;
  end if;

  -- Validate checksums before computing diff
  if v_snapshot.checksum is distinct from encode(sha256(convert_to(v_snapshot.snapshot_payload::text, 'UTF8')), 'hex') then
    raise exception 'Published snapshot checksum mismatch: canonical payload corrupted' using errcode = '55000';
  end if;

  if p_base_version_id is not null and v_base_snapshot.checksum is distinct from encode(sha256(convert_to(v_base_snapshot.snapshot_payload::text, 'UTF8')), 'hex') then
    raise exception 'Base published snapshot checksum mismatch: canonical payload corrupted' using errcode = '55000';
  end if;

  -- Compute and cache diff run atomically:
  -- Insert incomplete parent run first under advisory lock so FK on entries succeeds
  v_run_id := gen_random_uuid();

  insert into public.seasonal_publish_diff_cache_runs (
    run_id, season_id, base_version_id, version_id, base_checksum, target_checksum, algorithm_version, status
  ) values (
    v_run_id, v_version.season_id, p_base_version_id, p_version_id,
    coalesce(v_base_snapshot.checksum, 'NONE'), v_snapshot.checksum, 1, 'in_progress'
  );

  with raw_diff as materialized (
    select *
    from public.seasonal_planning_diff_v1(
      coalesce(v_base_snapshot.snapshot_payload, '{}'::jsonb),
      v_snapshot.snapshot_payload
    )
    where change_type in ('added', 'modified', 'removed')
  ), inserted_entries as (
    insert into public.seasonal_publish_diff_cache_entries (
      run_id, entry_index, diff_id, change_type, flight_key, source_draft_id,
      operational_date, side, airline, flight_number, before_state, after_state, changed_fields
    )
    select
      v_run_id,
      row_number() over (order by operational_date, side, flight_number, source_draft_id) as entry_index,
      gen_random_uuid() as diff_id,
      change_type,
      flight_key,
      source_draft_id,
      operational_date,
      side,
      airline,
      flight_number,
      before_state,
      after_state,
      changed_fields
    from raw_diff
    returning 1
  )
  select count(*)::integer into v_entry_count from inserted_entries;

  update public.seasonal_publish_diff_cache_runs
  set status = 'completed',
      entry_count = v_entry_count,
      completed_at = now()
  where run_id = v_run_id;

  if v_entry_count = 0 then
    return jsonb_build_object('entries', '[]'::jsonb, 'hasMore', false, 'nextIndex', null);
  end if;

  with candidates as materialized (
    select *
    from public.seasonal_publish_diff_cache_entries
    where run_id = v_run_id
      and entry_index > p_after_index
    order by entry_index
    limit p_page_size + 1
  ), page as (
    select *
    from candidates
    order by entry_index
    limit p_page_size
  )
  select jsonb_build_object(
    'entries', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'diff_id', p.diff_id::text,
          'version_id', p_version_id::text,
          'base_version_id', case when p_base_version_id is not null then p_base_version_id::text else null end,
          'season_id', v_version.season_id,
          'change_type', p.change_type,
          'flight_key', p.flight_key,
          'source_draft_id', p.source_draft_id,
          'operational_date', p.operational_date::text,
          'side', p.side,
          'airline', p.airline,
          'flight_number', p.flight_number,
          'before_state', p.before_state,
          'after_state', p.after_state,
          'changed_fields', to_jsonb(p.changed_fields),
          'created_at', p.created_at,
          'entry_index', p.entry_index::text
        ) order by p.entry_index
      ) from page p
    ), '[]'::jsonb),
    'hasMore', (select count(*) > p_page_size from candidates),
    'nextIndex', (select max(p.entry_index)::text from page p)
  ) into v_result;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Surgical substitution for get_seasonal_published_export_snapshot_v1
--    - Verifies canonical checksum before normalization
--    - Reads active flights from indexed seasonal_published_snapshot_flights
--    - Maintains all 25 export columns and relational counters/windows
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_anchor_export text;
begin
  select pg_get_functiondef('public.get_seasonal_published_export_snapshot_v1(uuid)'::regprocedure) into v_def;

  if not exists (select 1 from pg_proc where proname = 'preimage_get_seasonal_published_export_snapshot_v1') then
    execute replace(v_def, 'FUNCTION public.get_seasonal_published_export_snapshot_v1', 'FUNCTION public.preimage_get_seasonal_published_export_snapshot_v1');
    revoke all on function public.preimage_get_seasonal_published_export_snapshot_v1(uuid) from public, anon, authenticated;
  end if;

  v_anchor_export :=
'  select * into v_snapshot' || E'\n' ||
'  from public.seasonal_publish_snapshots' || E'\n' ||
'  where version_id = p_version_id;' || E'\n' ||
'  if not found then' || E'\n' ||
'    raise exception ''Snapshot not found'' using errcode = ''P0002'';' || E'\n' ||
'  end if;' || E'\n' ||
E'\n' ||
'  with normalized_flights as (' || E'\n' ||
'    select public.seasonal_published_flight_to_draft_json_v1(f, v_version.season_id) as draft_row' || E'\n' ||
'    from jsonb_array_elements(coalesce(v_snapshot.snapshot_payload->''flights'', ''[]''::jsonb)) f' || E'\n' ||
'  ), active_flights as materialized (' || E'\n' ||
'    select' || E'\n' ||
'      draft_row->>''draft_id'' as draft_id,' || E'\n' ||
'      draft_row->''counters'' as counters,' || E'\n' ||
'      draft_row->''checkin_windows'' as checkin_windows,' || E'\n' ||
'      (draft_row - array[''draft_id'', ''counters'', ''checkin_windows'']) || jsonb_build_object(' || E'\n' ||
'        ''record_id'', draft_row->>''draft_id'',' || E'\n' ||
'        ''linked_record_id'', draft_row->>''linked_draft_id''' || E'\n' ||
'      ) as export_record' || E'\n' ||
'    from normalized_flights' || E'\n' ||
'    where draft_row->>''status'' = ''active''' || E'\n' ||
'  )';

  if strpos(v_def, v_anchor_export) = 0 then
    raise exception 'get_seasonal_published_export_snapshot_v1 anchor preimage changed';
  end if;

  v_def := replace(v_def, v_anchor_export,
'  select * into v_snapshot' || E'\n' ||
'  from public.seasonal_publish_snapshots' || E'\n' ||
'  where version_id = p_version_id;' || E'\n' ||
'  if not found then' || E'\n' ||
'    raise exception ''Snapshot not found'' using errcode = ''P0002'';' || E'\n' ||
'  end if;' || E'\n' ||
E'\n' ||
'  -- Verify canonical checksum before normalization (no fallback)' || E'\n' ||
'  if v_snapshot.checksum is distinct from encode(sha256(convert_to(v_snapshot.snapshot_payload::text, ''UTF8'')), ''hex'') then' || E'\n' ||
'    raise exception ''Published snapshot checksum mismatch: canonical payload corrupted'' using errcode = ''55000'';' || E'\n' ||
'  end if;' || E'\n' ||
E'\n' ||
'  with active_flights as materialized (' || E'\n' ||
'    select' || E'\n' ||
'      sf.draft_id,' || E'\n' ||
'      sf.draft_payload->''counters'' as counters,' || E'\n' ||
'      sf.draft_payload->''checkin_windows'' as checkin_windows,' || E'\n' ||
'      (sf.draft_payload - array[''draft_id'', ''counters'', ''checkin_windows'']) || jsonb_build_object(' || E'\n' ||
'        ''record_id'', sf.draft_id,' || E'\n' ||
'        ''linked_record_id'', sf.draft_payload->>''linked_draft_id''' || E'\n' ||
'      ) as export_record' || E'\n' ||
'    from public.seasonal_published_snapshot_flights sf' || E'\n' ||
'    where sf.version_id = p_version_id' || E'\n' ||
'      and sf.status = ''active''' || E'\n' ||
'  )'
  );

  execute v_def;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Surgical substitution for restore_seasonal_published_draft_v1
--     - Verifies canonical checksum before normalization
--     - Stages flights from indexed seasonal_published_snapshot_flights
--     - Preserves all 240+ lines of untouched restore logic
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_anchor_declare text;
  v_anchor_staging text;
begin
  select pg_get_functiondef('public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid)'::regprocedure) into v_def;

  if not exists (select 1 from pg_proc where proname = 'preimage_restore_seasonal_published_draft_v1') then
    execute replace(v_def, 'FUNCTION public.restore_seasonal_published_draft_v1', 'FUNCTION public.preimage_restore_seasonal_published_draft_v1');
    revoke all on function public.preimage_restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) from public, anon, authenticated;
  end if;

  v_anchor_declare := '  v_snapshot jsonb;' || E'\n' || '  v_receipt public.seasonal_draft_mutation_receipts%rowtype;';
  if strpos(v_def, v_anchor_declare) = 0 then
    raise exception 'restore_seasonal_published_draft_v1 declare anchor preimage changed';
  end if;
  v_def := replace(v_def, v_anchor_declare,
    '  v_snapshot jsonb;' || E'\n' ||
    '  v_snapshot_record public.seasonal_publish_snapshots%rowtype;' || E'\n' ||
    '  v_receipt public.seasonal_draft_mutation_receipts%rowtype;'
  );

  v_anchor_staging :=
'  -- Retrieve snapshot' || E'\n' ||
'  select snapshot_payload into v_snapshot' || E'\n' ||
'  from public.seasonal_publish_snapshots' || E'\n' ||
'  where version_id = p_version_id;' || E'\n' ||
'  if not found or v_snapshot is null then' || E'\n' ||
'    raise exception ''Snapshot not found'' using errcode = ''P0002'';' || E'\n' ||
'  end if;' || E'\n' ||
E'\n' ||
'  -- Stage unpacked snapshot flights using canonical helper and jsonb_populate_record' || E'\n' ||
'  drop table if exists pg_temp.restored_snapshot_flights;' || E'\n' ||
'  create temporary table pg_temp.restored_snapshot_flights on commit drop as' || E'\n' ||
'  select d.*' || E'\n' ||
'  from jsonb_array_elements(coalesce(v_snapshot->''flights'', ''[]''::jsonb)) f' || E'\n' ||
'  cross join lateral jsonb_populate_record(' || E'\n' ||
'    null::public.seasonal_flight_drafts,' || E'\n' ||
'    public.seasonal_published_flight_to_draft_json_v1(f, p_season_id)' || E'\n' ||
'  ) d;';

  if strpos(v_def, v_anchor_staging) = 0 then
    raise exception 'restore_seasonal_published_draft_v1 staging anchor preimage changed';
  end if;

  v_def := replace(v_def, v_anchor_staging,
'  -- Retrieve snapshot and verify canonical checksum before normalization' || E'\n' ||
'  select * into v_snapshot_record' || E'\n' ||
'  from public.seasonal_publish_snapshots' || E'\n' ||
'  where version_id = p_version_id;' || E'\n' ||
'  if not found or v_snapshot_record.snapshot_payload is null then' || E'\n' ||
'    raise exception ''Snapshot not found'' using errcode = ''P0002'';' || E'\n' ||
'  end if;' || E'\n' ||
E'\n' ||
'  if v_snapshot_record.checksum is distinct from encode(sha256(convert_to(v_snapshot_record.snapshot_payload::text, ''UTF8'')), ''hex'') then' || E'\n' ||
'    raise exception ''Published snapshot checksum mismatch: canonical payload corrupted'' using errcode = ''55000'';' || E'\n' ||
'  end if;' || E'\n' ||
'  v_snapshot := v_snapshot_record.snapshot_payload;' || E'\n' ||
E'\n' ||
'  -- Stage unpacked snapshot flights from relational derived storage' || E'\n' ||
'  drop table if exists pg_temp.restored_snapshot_flights;' || E'\n' ||
'  create temporary table pg_temp.restored_snapshot_flights on commit drop as' || E'\n' ||
'  select d.*' || E'\n' ||
'  from public.seasonal_published_snapshot_flights sf' || E'\n' ||
'  cross join lateral jsonb_populate_record(' || E'\n' ||
'    null::public.seasonal_flight_drafts,' || E'\n' ||
'    sf.draft_payload' || E'\n' ||
'  ) d' || E'\n' ||
'  where sf.version_id = p_version_id;'
  );

  execute v_def;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Permissions and grants
-- ---------------------------------------------------------------------------
revoke all on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) from public, anon;
grant execute on function public.get_seasonal_published_snapshot_page_v1(uuid, text, integer) to authenticated;

revoke all on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) from public, anon;
grant execute on function public.get_seasonal_version_comparison_page_v1(uuid, uuid, bigint, integer) to authenticated;

revoke all on function public.get_seasonal_published_export_snapshot_v1(uuid) from public, anon;
grant execute on function public.get_seasonal_published_export_snapshot_v1(uuid) to authenticated;

revoke all on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) from public, anon;
grant execute on function public.restore_seasonal_published_draft_v1(text, uuid, uuid, bigint, uuid) to authenticated;

commit;
