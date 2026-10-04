-- M1: Seasonal / Operational separation — additive schema.
--
-- Additive only. This migration creates the planning (draft), operational
-- runtime, daily day-authority and publish-versioning tables. It does not
-- backfill (M2), does not run a shadow projection (M3) and does not flip any
-- writer or reader (M10): the current `public.season_flight_records`,
-- `public.season_modifications` and reporting chain stay authoritative.
--
-- Naming/typing follows the existing chain on purpose:
--   * business identity `side|ops_date|AIRLINE|FLIGHT_NUMBER` joined with
--     `chr(31)` — byte-identical to `reporting.canonical_flight_legs.business_leg_key`
--     (20260822090000_public_traffic_report_v1.sql:112) so planning, operations
--     and reporting share one key space.
--   * typed `date`/`time` columns for the operational runtime, matching
--     `public.daily_schedule_import_batch_legs` (the daily ground-truth source).
--   * `authority_source`/`canonical_checksum`/`committed_*`/`reset_*` vocabulary
--     carried over from `public.schedule_replacement_scopes`, but keyed by
--     `operational_date` only — the new day scope must not depend on a season.

begin;

-- ---------------------------------------------------------------------------
-- 1. Seasonal planning space: drafts hold the effective planned values, no
--    overlay table is needed because edits persist directly on the draft.
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_flight_drafts (
  draft_id text primary key default ('DRF_' || gen_random_uuid()::text),
  season_id text not null references public.seasons(id) on delete cascade,
  link_id text not null default '',
  type text not null check (type in ('A', 'D')),
  airline text not null default '',
  flight_number text not null default '',
  raw_flight_number text not null default '',
  request_status_code text,
  route text not null default '',
  schedule text not null default '' check (schedule = '' or schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  aircraft text not null default '',
  category text not null default '',
  code_shares text,
  int_dom_ind text,
  pax integer,
  gate integer,
  stand text check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$'),
  carousel integer,
  mct text,
  fb text,
  lb text,
  bhs text,
  ghs text,
  date text not null default '',
  scheduled_date text,
  scheduled_time text check (scheduled_time is null or scheduled_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  operational_date text,
  iata_season_code text,
  flight_series_id text,
  day_of_week integer not null default 0 check (day_of_week between 0 and 7),
  action text check (action is null or action in ('modified', 'added', 'deleted')),
  source_row_index integer not null default 0,
  linked_source_row_index integer,
  link_type text check (link_type is null or link_type in ('overnight', 'sameday')),
  pair_anchor_date text,
  linked_draft_id text,
  turnaround_id text,
  source_kind text not null default 'imported' check (source_kind in ('imported', 'manual')),
  source_side text not null default 'ARR' check (source_side in ('ARR', 'DEP')),
  status text not null default 'active' check (status in ('active', 'deleted')),
  source_import_batch_id uuid,
  source_import_staging_row_index integer,
  source_file_hash text,
  superseded_by_batch_id uuid,
  supersedes_draft_id text,
  deletion_reason text,
  lifecycle_changed_at timestamp with time zone,
  lifecycle_changed_by uuid references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint seasonal_flight_drafts_deleted_lifecycle_check
    check ((status = 'deleted') = coalesce(action = 'deleted', false)),
  constraint seasonal_flight_drafts_deleted_reason_check
    check (status = 'active' or (deletion_reason is not null and btrim(deletion_reason) <> '')),
  constraint seasonal_flight_drafts_self_link_check check (linked_draft_id is null or linked_draft_id <> draft_id),
  constraint seasonal_flight_drafts_season_draft_key unique (season_id, draft_id)
);

comment on table public.seasonal_flight_drafts is
  'M1 planning space: seasonal plan rows (imported SSIM and manually planned). Values are the effective planned values; publication copies them into public.operational_flight_legs.';
comment on column public.seasonal_flight_drafts.source_kind is
  'imported = came from a seasonal workbook import, manual = planned by an operator. Legacy season_flight_records.source_kind=seasonal maps to imported during M2 backfill.';
comment on column public.seasonal_flight_drafts.date is
  'Text dates keep the existing export contract (get_seasonal_export_snapshot_v2 emits strings); M6 parses only for validation.';

create index if not exists seasonal_flight_drafts_season_date_idx
  on public.seasonal_flight_drafts (season_id, date);
create index if not exists seasonal_flight_drafts_season_active_idx
  on public.seasonal_flight_drafts (season_id, operational_date)
  where status = 'active';
create index if not exists seasonal_flight_drafts_import_batch_idx
  on public.seasonal_flight_drafts (source_import_batch_id)
  where source_import_batch_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Draft audit / undo log. Mirrors public.season_change_events (same
--    client_id+op_id idempotency contract) and adds before/after state so a
--    draft edit can be reverted without replaying the whole import.
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_draft_events (
  event_id text primary key default (gen_random_uuid())::text,
  season_id text not null references public.seasons(id) on delete restrict,
  client_id text not null,
  op_id text,
  actor_user_id uuid references auth.users(id) on delete set null,
  server_seq bigint not null check (server_seq > 0),
  target_type text not null default 'draft',
  target_id text not null,
  changed_fields text[] not null default array[]::text[],
  before_state jsonb,
  after_state jsonb,
  created_at timestamp with time zone not null default now(),
  constraint seasonal_draft_events_client_op_key unique (client_id, op_id)
);

comment on table public.seasonal_draft_events is
  'M1 append-only draft mutation log: undo/redo and field-level conflict detection for Seasonal/Detailed edits.';

create index if not exists seasonal_draft_events_season_seq_idx
  on public.seasonal_draft_events (season_id, server_seq);
create index if not exists seasonal_draft_events_target_idx
  on public.seasonal_draft_events (target_id, server_seq);

-- ---------------------------------------------------------------------------
-- 3. Publish versioning. Version tag convention [SEASON_CODE]-[DDMMMYY]
--    (W26-27JUN26), with .N suffix when a season publishes twice in one day.
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_publish_versions (
  version_id uuid primary key default gen_random_uuid(),
  season_id text not null references public.seasons(id) on delete restrict,
  season_code text not null,
  version_tag text not null,
  sequence_in_day integer not null default 1 check (sequence_in_day >= 1),
  published_at timestamp with time zone not null default now(),
  published_by uuid not null references auth.users(id) on delete restrict,
  publish_notes text not null default '',
  range_start date not null,
  range_end date not null,
  total_flight_count integer not null default 0 check (total_flight_count >= 0),
  added_count integer not null default 0 check (added_count >= 0),
  modified_count integer not null default 0 check (modified_count >= 0),
  removed_count integer not null default 0 check (removed_count >= 0),
  unchanged_count integer not null default 0 check (unchanged_count >= 0),
  skipped_day_count integer not null default 0 check (skipped_day_count >= 0),
  diff_summary jsonb not null default '{}'::jsonb,
  snapshot_checksum text not null,
  created_at timestamp with time zone not null default now(),
  constraint seasonal_publish_versions_range_check check (range_start <= range_end),
  constraint seasonal_publish_versions_code_check check (season_code = upper(btrim(season_code)) and season_code <> ''),
  constraint seasonal_publish_versions_tag_check
    check (version_tag ~ '^[A-Z0-9]+-[0-9]{2}[A-Z]{3}[0-9]{2}(\.[0-9]+)?$'),
  constraint seasonal_publish_versions_tag_key unique (season_id, version_tag),
  constraint seasonal_publish_versions_version_season_key unique (version_id, season_id)
);

comment on table public.seasonal_publish_versions is
  'M1 publish audit: one row per Publish action with the [SEASON]-[DDMMMYY] tag, range, change counters and the skipped-days count caused by Daily authority.';
comment on column public.seasonal_publish_versions.skipped_day_count is
  'Number of in-range season days not written because a Daily authority scope was still effective (M7.1).';

create index if not exists seasonal_publish_versions_season_time_idx
  on public.seasonal_publish_versions (season_id, published_at desc);

create table if not exists public.seasonal_publish_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique,
  season_id text not null,
  snapshot_payload jsonb not null check (jsonb_typeof(snapshot_payload) = 'object'),
  flight_count integer not null default 0 check (flight_count >= 0),
  checksum text not null,
  created_at timestamp with time zone not null default now(),
  -- Ownership: a snapshot can only describe a version of its own season.
  constraint seasonal_publish_snapshots_version_season_fkey
    foreign key (version_id, season_id)
    references public.seasonal_publish_versions (version_id, season_id)
    on delete cascade
);

comment on table public.seasonal_publish_snapshots is
  'M1 immutable full snapshot of a published season version (recovery + diff base). TOAST handles compression; clients never page a whole season through PostgREST.';

create table if not exists public.seasonal_publish_diff_entries (
  diff_id uuid primary key default gen_random_uuid(),
  version_id uuid not null,
  base_version_id uuid,
  season_id text not null,
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
  constraint seasonal_publish_diff_entries_state_check check (
    (change_type = 'added' and before_state is null and after_state is not null)
    or (change_type = 'removed' and before_state is not null and after_state is null)
    or (change_type = 'modified' and before_state is not null and after_state is not null)
  ),
  constraint seasonal_publish_diff_entries_version_season_fkey
    foreign key (version_id, season_id)
    references public.seasonal_publish_versions (version_id, season_id)
    on delete cascade,
  constraint seasonal_publish_diff_entries_base_season_fkey
    foreign key (base_version_id, season_id)
    references public.seasonal_publish_versions (version_id, season_id)
    on delete restrict,
  constraint seasonal_publish_diff_entries_draft_season_fkey
    foreign key (season_id, source_draft_id)
    references public.seasonal_flight_drafts (season_id, draft_id)
    on delete restrict
);

comment on table public.seasonal_publish_diff_entries is
  'M1 delta changelog between two published versions (added/modified/removed) used by the Diff Viewer and by the publish summary. season_id makes ownership explicit: the compared versions and the referenced draft must all belong to that season.';

create index if not exists seasonal_publish_diff_entries_version_idx
  on public.seasonal_publish_diff_entries (version_id, change_type);

-- Version tag builder: keeps the [SEASON_CODE]-[DDMMMYY] contract in one place.
create or replace function public.seasonal_publish_version_tag(
  p_season_code text,
  p_published_on date,
  p_sequence integer default 1
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select upper(btrim(p_season_code))
    || '-'
    || to_char(p_published_on, 'DDMONYY')
    || case when coalesce(p_sequence, 1) > 1 then '.' || p_sequence::text else '' end
$$;

comment on function public.seasonal_publish_version_tag(text, date, integer) is
  'M1 version tag: [SEASON_CODE]-[DDMMMYY] with .N suffix for the second and later publish of the same day.';

-- ---------------------------------------------------------------------------
-- 4. Operational runtime. One row per operational leg, whatever produced it.
-- ---------------------------------------------------------------------------
create table if not exists public.operational_flight_legs (
  leg_id uuid primary key default gen_random_uuid(),
  leg_key text not null check (btrim(leg_key) <> ''),
  operational_date date not null,
  scheduled_date date not null,
  scheduled_time time without time zone not null,
  side text not null check (side in ('ARR', 'DEP')),
  airline text not null check (btrim(airline) <> ''),
  flight_number text not null check (btrim(flight_number) <> ''),
  raw_flight_number text,
  route text not null default '',
  aircraft_type text not null default 'Unknown',
  flight_category text not null default 'C',
  pax integer,
  code_shares text,
  int_dom_ind text,
  stand text check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$'),
  gate integer check (gate is null or gate > 0),
  carousel integer check (carousel is null or carousel > 0),
  counter_token text,
  mct text,
  fb text,
  lb text,
  bhs text,
  ghs text,
  check_in_start text,
  check_in_end text,
  check_in_allocation_mode text
    check (check_in_allocation_mode is null or check_in_allocation_mode in ('grouped', 'broken')),
  turnaround_id text,
  linked_leg_id uuid references public.operational_flight_legs(leg_id) on delete set null,
  link_type text check (link_type is null or link_type in ('sameday', 'overnight')),
  pair_anchor_date date,
  source_type text not null check (source_type in ('published_seasonal', 'daily_import', 'operational_manual')),
  source_season_id text references public.seasons(id) on delete restrict,
  source_draft_id text,
  source_batch_id uuid references public.daily_schedule_import_batches(batch_id) on delete restrict,
  source_occurrence_key text,
  source_row_number integer,
  published_version_id uuid references public.seasonal_publish_versions(version_id) on delete set null,
  authority_rank smallint generated always as (
    case source_type
      when 'daily_import' then 3
      when 'operational_manual' then 2
      else 1
    end
  ) stored,
  status text not null default 'active' check (status in ('active', 'cancelled', 'deleted')),
  deletion_reason text,
  created_at timestamp with time zone not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamp with time zone not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint operational_flight_legs_business_key_check check (
    leg_key = (case side when 'ARR' then 'A' else 'D' end)
      || chr(31) || operational_date::text
      || chr(31) || upper(btrim(airline))
      || chr(31) || upper(btrim(flight_number))
  ),
  constraint operational_flight_legs_deleted_reason_check
    check (status = 'active' or (deletion_reason is not null and btrim(deletion_reason) <> '')),
  constraint operational_flight_legs_seasonal_lineage_check check (
    source_type <> 'published_seasonal'
    or (source_season_id is not null and source_draft_id is not null)
  ),
  constraint operational_flight_legs_daily_lineage_check check (
    source_type <> 'daily_import'
    or (source_batch_id is not null and source_occurrence_key is not null)
  ),
  constraint operational_flight_legs_published_version_check check (
    (published_version_id is null) = (source_type <> 'published_seasonal')
  ),
  constraint operational_flight_legs_daily_season_check check (
    source_type <> 'daily_import' or source_season_id is null
  ),
  constraint operational_flight_legs_self_link_check check (linked_leg_id is null or linked_leg_id <> leg_id),
  -- Ownership: a published leg always points at a draft of its own season.
  constraint operational_flight_legs_draft_season_fkey
    foreign key (source_season_id, source_draft_id)
    references public.seasonal_flight_drafts (season_id, draft_id)
    on delete restrict
);

comment on table public.operational_flight_legs is
  'M1 operational runtime: one row per operational leg from a seasonal publish, a daily import or an operator manual entry. Publicly readable; every write goes through a security definer RPC (M4+).';
comment on column public.operational_flight_legs.leg_key is
  'Non-unique operational lookup [A|D]|operational_date|AIRLINE|FLIGHT_NUMBER joined with chr(31). Not the reporting business key: report/backfill resolution uses scheduled_date to preserve distinct calendar-day flights within one 05:00 operational day.';
comment on column public.operational_flight_legs.authority_rank is
  'Source classification: daily_import=3, operational_manual=2, published_seasonal=1. Backfill/shadow resolution gives Daily priority per scheduled-date business key, then applies recency within eligible candidates; without Daily, Manual and Seasonal retain the legacy recency rule. Missing/tied recency among competing candidates is quarantined.';
comment on column public.operational_flight_legs.source_draft_id is
  'Stable link to public.seasonal_flight_drafts.draft_id: the same draft keeps its operational leg across publishes (upsert) and is retired when the draft leaves the plan.';
comment on column public.operational_flight_legs.operational_date is
  'Local operational day of the leg. Daily authority is enforced per day in public.operational_day_authority, not by a season filter.';

create index if not exists operational_flight_legs_day_keyset_idx
  on public.operational_flight_legs (operational_date, scheduled_time, leg_id)
  where status = 'active';
create index if not exists operational_flight_legs_key_lookup_idx
  on public.operational_flight_legs (leg_key)
  where status = 'active';
create index if not exists operational_flight_legs_day_rank_idx
  on public.operational_flight_legs (operational_date, authority_rank desc)
  where status = 'active';
create index if not exists operational_flight_legs_season_lineage_idx
  on public.operational_flight_legs (source_season_id)
  where status = 'active' and source_type = 'published_seasonal';
create index if not exists operational_flight_legs_batch_lineage_idx
  on public.operational_flight_legs (source_batch_id)
  where source_type = 'daily_import';

-- Writer-owned invariants (not data-dependent): one active operational leg per
-- draft, and one active leg per staged daily row.
create unique index if not exists operational_flight_legs_seasonal_draft_active_key
  on public.operational_flight_legs (source_season_id, source_draft_id)
  where status = 'active' and source_type = 'published_seasonal';
create unique index if not exists operational_flight_legs_daily_staging_active_key
  on public.operational_flight_legs (source_batch_id, source_occurrence_key)
  where status = 'active' and source_type = 'daily_import';

-- A business key the writer refused to resolve (ambiguous recency, several
-- candidates for one active key) is not allowed to become a leg, but the
-- decision itself must outlive the run that made it: the shadow projection and
-- the report quality numbers after the M10 cutover read it from here. Rebuilt by
-- the writer on every run, so a key that stopped being ambiguous disappears.
create table if not exists public.operational_leg_quarantine (
  business_leg_key text primary key,
  ops_date date not null,
  candidate_count integer not null check (candidate_count > 1),
  source text not null check (btrim(source) <> ''),
  quarantined_at timestamp with time zone not null default now()
);

comment on table public.operational_leg_quarantine is
  'Writer-side record of business keys left unresolved instead of silently ranked: candidate_count is how many candidates the writer saw, source names the path that refused (backfill today, publish/daily commit from M5/M7).';

create index if not exists operational_leg_quarantine_date_idx
  on public.operational_leg_quarantine (ops_date);

-- ---------------------------------------------------------------------------
-- 5. Daily ground-truth authority per operational date (season independent).
-- ---------------------------------------------------------------------------
create table if not exists public.operational_day_authority (
  operational_date date primary key,
  authority_source text not null check (authority_source in ('daily_import')),
  source_batch_id uuid not null references public.daily_schedule_import_batches(batch_id) on delete restrict,
  leg_count integer not null check (leg_count >= 0),
  canonical_checksum text not null check (btrim(canonical_checksum) <> ''),
  authority_revision integer not null default 1 check (authority_revision >= 1),
  committed_at timestamp with time zone not null default now(),
  committed_by uuid not null references auth.users(id) on delete restrict,
  reset_at timestamp with time zone,
  reset_by uuid references auth.users(id) on delete restrict,
  reset_reason text,
  constraint operational_day_authority_reset_check check ((reset_at is null) = (reset_by is null)),
  constraint operational_day_authority_reset_reason_check check (
    reset_at is null or (reset_reason is not null and btrim(reset_reason) <> '')
  )
);

comment on table public.operational_day_authority is
  'M1 daily authority scope: an effective row means the operational day is owned by a Daily import (leg_count may be 0). Seasonal Publish skips every day that still has a row here, whatever its leg count.';
comment on column public.operational_day_authority.authority_revision is
  'Bumped on every commit/reset so a stale preview can be rejected without re-reading legs.';

create table if not exists public.operational_day_authority_events (
  event_id text primary key default (gen_random_uuid())::text,
  operational_date date not null,
  event_type text not null check (event_type in ('commit', 'reset')),
  source_batch_id uuid,
  leg_count integer,
  canonical_checksum text,
  authority_revision integer,
  actor_user_id uuid references auth.users(id) on delete set null,
  reason text,
  created_at timestamp with time zone not null default now(),
  constraint operational_day_authority_events_commit_check check (
    event_type <> 'commit' or (source_batch_id is not null and leg_count is not null and canonical_checksum is not null)
  ),
  constraint operational_day_authority_events_reset_check check (
    event_type <> 'reset' or (reason is not null and btrim(reason) <> '')
  )
);

comment on table public.operational_day_authority_events is
  'M1 append-only audit of daily authority commits and resets (who, when, batch, leg count, checksum, reason).';

create index if not exists operational_day_authority_events_date_idx
  on public.operational_day_authority_events (operational_date, created_at desc);

-- ---------------------------------------------------------------------------
-- 6. RLS + grants. Reads are permission gated; writes exist only inside
--    security definer RPCs (M4/M5/M6/M7), so no insert/update/delete policy
--    is granted here.
-- ---------------------------------------------------------------------------
alter table public.seasonal_flight_drafts enable row level security;
alter table public.seasonal_draft_events enable row level security;
alter table public.operational_flight_legs enable row level security;
alter table public.operational_leg_quarantine enable row level security;
alter table public.operational_day_authority enable row level security;
alter table public.operational_day_authority_events enable row level security;
alter table public.seasonal_publish_versions enable row level security;
alter table public.seasonal_publish_snapshots enable row level security;
alter table public.seasonal_publish_diff_entries enable row level security;

revoke all on public.seasonal_flight_drafts, public.seasonal_draft_events,
  public.operational_flight_legs, public.operational_leg_quarantine,
  public.operational_day_authority,
  public.operational_day_authority_events, public.seasonal_publish_versions,
  public.seasonal_publish_snapshots, public.seasonal_publish_diff_entries
  from public, anon, authenticated;
grant select on public.seasonal_flight_drafts, public.seasonal_draft_events,
  public.operational_flight_legs, public.operational_leg_quarantine,
  public.operational_day_authority,
  public.operational_day_authority_events, public.seasonal_publish_versions,
  public.seasonal_publish_snapshots, public.seasonal_publish_diff_entries
  to authenticated;

drop policy if exists "seasonal flight drafts read" on public.seasonal_flight_drafts;
create policy "seasonal flight drafts read" on public.seasonal_flight_drafts
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

drop policy if exists "seasonal draft events read" on public.seasonal_draft_events;
create policy "seasonal draft events read" on public.seasonal_draft_events
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

drop policy if exists "operational flight legs read" on public.operational_flight_legs;
create policy "operational flight legs read" on public.operational_flight_legs
for select to authenticated using (
  (select public.app_operator_has_permission('daily.read'))
  or (select public.app_operator_has_permission('seasonal.read'))
);

drop policy if exists "operational leg quarantine read" on public.operational_leg_quarantine;
create policy "operational leg quarantine read" on public.operational_leg_quarantine
for select to authenticated using (
  (select public.app_operator_has_permission('daily.read'))
  or (select public.app_operator_has_permission('seasonal.read'))
);

drop policy if exists "operational day authority read" on public.operational_day_authority;
create policy "operational day authority read" on public.operational_day_authority
for select to authenticated using ((select public.app_operator_has_permission('daily.read')));

drop policy if exists "operational day authority events read" on public.operational_day_authority_events;
create policy "operational day authority events read" on public.operational_day_authority_events
for select to authenticated using ((select public.app_operator_has_permission('daily.read')));

drop policy if exists "seasonal publish versions read" on public.seasonal_publish_versions;
create policy "seasonal publish versions read" on public.seasonal_publish_versions
for select to authenticated using (
  (select public.app_operator_has_permission('seasonal.read'))
  or (select public.app_operator_has_permission('daily.read'))
);

drop policy if exists "seasonal publish snapshots read" on public.seasonal_publish_snapshots;
create policy "seasonal publish snapshots read" on public.seasonal_publish_snapshots
for select to authenticated using ((select public.app_operator_has_permission('seasonal.read')));

drop policy if exists "seasonal publish diff entries read" on public.seasonal_publish_diff_entries;
create policy "seasonal publish diff entries read" on public.seasonal_publish_diff_entries
for select to authenticated using (
  (select public.app_operator_has_permission('seasonal.read'))
  or (select public.app_operator_has_permission('daily.read'))
);

revoke all on function public.seasonal_publish_version_tag(text, date, integer) from public, anon;
grant execute on function public.seasonal_publish_version_tag(text, date, integer) to authenticated;

commit;
