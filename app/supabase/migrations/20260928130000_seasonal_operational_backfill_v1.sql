-- M2: backfill legacy seasonal/daily data into the M1 tables and seed the
-- baseline publish version per season.
--
-- Scope and safety:
--   * Additive and idempotent: every routine upserts by deterministic identity,
--     so a re-run (or a replay after a higher high-water) never duplicates a
--     draft, an operational leg or a day-authority row.
--   * Nothing here flips a writer or a reader. `public.season_flight_records`,
--     `public.season_modifications` and the reporting chain stay authoritative
--     until the M10 gate; this migration only prepares the shadow copy.
--   * Planning and Operations are separated on purpose: drafts receive only the
--     seasonal plan (legacy `source_kind='seasonal'`, with legacy overlays
--     folded in), while daily imports and manual legs become operational rows.
--   * Baseline versions are Planning-only snapshots: a Daily import never ends
--     up inside a season version (its planned rows arrive through the plan).
--   * Operational candidates come from `reporting.get_public_traffic_candidate_slice_v1`
--     with Daily-first eligibility followed by authoritative recency ranking;
--     ambiguous eligible keys are quarantined. Historical differences from
--     the legacy report require an explicitly approved Daily-priority delta.
begin;
set local lock_timeout = '15s';
set local statement_timeout = '600s';

-- ---------------------------------------------------------------------------
-- 1. Run ledger: cutoff, source high-water and outcome of every backfill run.
-- ---------------------------------------------------------------------------
create table if not exists public.seasonal_operational_backfill_runs (
  run_id uuid primary key default gen_random_uuid(),
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  cutoff_at timestamp with time zone not null,
  source_high_water bigint not null default 0,
  replayed_from_high_water bigint,
  published_on date not null,
  published_by uuid references auth.users(id) on delete set null,
  drafts_written integer not null default 0,
  legs_written integer not null default 0,
  authority_rows_written integer not null default 0,
  versions_seeded integer not null default 0,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  notes jsonb not null default '{}'::jsonb
);

comment on table public.seasonal_operational_backfill_runs is
  'M2 backfill ledger: the cutoff moment, the season_change_events high-water the shadow copy is known to match, and per-step row counts. A replay run repeats the same idempotent routines and records the high-water it started from.';
comment on column public.seasonal_operational_backfill_runs.source_high_water is
  'max(season_change_events.server_seq) at cutoff. A replay re-reads the same legacy source, so the shadow copy always reflects the newest events.';

alter table public.seasonal_publish_versions
  add column if not exists backfill_run_id uuid references public.seasonal_operational_backfill_runs(run_id) on delete set null;

comment on column public.seasonal_publish_versions.backfill_run_id is
  'Set only on baseline versions seeded by the M2 backfill; NULL for versions published by an operator.';

alter table public.seasonal_operational_backfill_runs enable row level security;
revoke all on public.seasonal_operational_backfill_runs from public, anon, authenticated;
grant select on public.seasonal_operational_backfill_runs to authenticated;
drop policy if exists "backfill runs read" on public.seasonal_operational_backfill_runs;
create policy "backfill runs read" on public.seasonal_operational_backfill_runs
for select to authenticated using (
  (select public.app_operator_has_permission('seasonal.read'))
  or (select public.app_operator_has_permission('daily.read'))
);

-- ---------------------------------------------------------------------------
-- 2. Legacy record -> leg lineage. Mirrors season_manual_leg_migrations: it
--    makes the backfill idempotent per source row and lets the M10 parity
--    check walk legacy -> runtime both ways.
-- ---------------------------------------------------------------------------
create table if not exists public.operational_leg_backfill_links (
  legacy_season_id text not null,
  legacy_record_id text not null,
  leg_id uuid not null references public.operational_flight_legs(leg_id) on delete cascade,
  run_id uuid references public.seasonal_operational_backfill_runs(run_id) on delete set null,
  authoritative_server_seq bigint,
  linked_at timestamp with time zone not null default now(),
  primary key (legacy_season_id, legacy_record_id)
);
create unique index if not exists operational_leg_backfill_links_leg_id
  on public.operational_leg_backfill_links (leg_id);

comment on table public.operational_leg_backfill_links is
  'M2 lineage: which operational leg replaced which legacy season_flight_records row.';
comment on column public.operational_leg_backfill_links.authoritative_server_seq is
  'Legacy candidate recency captured by backfill/replay; fallback until a native operational event exists, never inferred from import time.';

alter table public.operational_leg_backfill_links enable row level security;
revoke all on public.operational_leg_backfill_links from public, anon, authenticated;
grant select on public.operational_leg_backfill_links to authenticated;
drop policy if exists "operational leg backfill links read" on public.operational_leg_backfill_links;
create policy "operational leg backfill links read" on public.operational_leg_backfill_links
for select to authenticated using (
  (select public.app_operator_has_permission('seasonal.read'))
  or (select public.app_operator_has_permission('daily.read'))
);

-- ---------------------------------------------------------------------------
-- 3. Identity helpers.
-- ---------------------------------------------------------------------------
create or replace function public.seasonal_draft_id_v1(
  p_season_id text,
  p_type text,
  p_scheduled_date date,
  p_airline text,
  p_flight_number text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select
    'DRF_'
    || pg_catalog.upper(pg_catalog.btrim(p_type))
    || '_'
    || p_scheduled_date::text
    || '_'
    || pg_catalog.substr(
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            p_season_id
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_type))
            || chr(31)
            || p_scheduled_date::text
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_airline))
            || chr(31)
            || pg_catalog.upper(pg_catalog.btrim(p_flight_number)),
            'UTF8'
          )
        ),
        'hex'
      ),
      1,
      32
    )
$$;

comment on function public.seasonal_draft_id_v1(text, text, date, text, text) is
  'M2 deterministic draft id: the seasonal_record_id_v2 inputs, so legacy record identity maps 1:1 onto one draft across re-imports.';

-- Legacy date columns are text and may be empty: parse only well-formed values.
create or replace function public.seasonal_backfill_identity_date_v1(
  p_scheduled_date text,
  p_operational_date text,
  p_date text
)
returns date
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when coalesce(p_scheduled_date, '') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then p_scheduled_date::date
    when coalesce(p_operational_date, '') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then p_operational_date::date
    when coalesce(p_date, '') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then p_date::date
  end
$$;

comment on function public.seasonal_backfill_identity_date_v1(text, text, text) is
  'M2 helper: the date value the legacy import used for its content identity (scheduled_date, then operational_date, then date). Returns NULL instead of raising on empty or malformed input.';

revoke all on function public.seasonal_draft_id_v1(text, text, date, text, text) from public, anon;
revoke all on function public.seasonal_backfill_identity_date_v1(text, text, text) from public, anon;
grant execute on function public.seasonal_draft_id_v1(text, text, date, text, text) to authenticated;
grant execute on function public.seasonal_backfill_identity_date_v1(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Planning backfill: legacy seasonal records (+ folded overlays) -> drafts.
--    Daily imports and manual legs are deliberately left out.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_seasonal_flight_drafts_v1(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '900s'
as $function$
declare
  v_written integer := 0;
  v_retired integer := 0;
  v_removed integer := 0;
  v_ambiguous_draft_id text;
  v_ambiguous_active integer;
begin
  -- Deterministic lifecycle source selection guard:
  -- a draft identity with more than one base active row is genuinely ambiguous
  -- and fails clearly rather than arbitrarily choosing one. Identities whose
  -- rows are all terminal resolve to the most recent lifecycle change: every
  -- candidate yields a deleted draft, so only the audit lineage is chosen.
  select
    d.draft_id,
    count(*) filter (where d.status = 'active' and coalesce(d.action, '') <> 'deleted')::integer as active_count
  into
    v_ambiguous_draft_id,
    v_ambiguous_active
  from (
    select
      public.seasonal_draft_id_v1(
        records.season_id,
        records.type,
        public.seasonal_backfill_identity_date_v1(records.scheduled_date, records.operational_date, records.date),
        records.airline,
        records.flight_number
      ) as draft_id,
      records.status,
      records.action
    from public.season_flight_records records
    where records.source_kind = 'seasonal'
  ) d
  group by d.draft_id
  having count(*) filter (where d.status = 'active' and coalesce(d.action, '') <> 'deleted') > 1
  limit 1;

  if v_ambiguous_draft_id is not null then
    raise exception 'Ambiguous seasonal flight draft %: multiple base active source rows found (%)',
      v_ambiguous_draft_id, v_ambiguous_active
      using errcode = '22023';
  end if;

  drop table if exists backfill_chosen_seasonal_sources;
  create temp table backfill_chosen_seasonal_sources on commit drop as
  with scoped as (
    select
      records.*,
      public.seasonal_draft_id_v1(
        records.season_id,
        records.type,
        public.seasonal_backfill_identity_date_v1(records.scheduled_date, records.operational_date, records.date),
        records.airline,
        records.flight_number
      ) as draft_id,
      (records.status = 'active' and coalesce(records.action, '') <> 'deleted') as is_base_active
    from public.season_flight_records records
    where records.source_kind = 'seasonal'
  )
  select distinct on (draft_id)
    scoped.*
  from scoped
  where draft_id is not null
  order by draft_id, case when is_base_active then 0 else 1 end,
    lifecycle_changed_at desc nulls last, record_id desc;

  create index on backfill_chosen_seasonal_sources (draft_id);
  create index on backfill_chosen_seasonal_sources (record_id);

  with plan as (
    select
      modifications.action as overlay_action,
      coalesce(modifications.changed_fields, array[]::text[]) as changed_fields,
      modifications.route as overlay_route,
      modifications.schedule as overlay_schedule,
      modifications.aircraft as overlay_aircraft,
      modifications.pax as overlay_pax,
      modifications.gate as overlay_gate,
      modifications.stand as overlay_stand,
      modifications.carousel as overlay_carousel,
      modifications.code_shares as overlay_code_shares,
      modifications.mct as overlay_mct,
      modifications.fb as overlay_fb,
      modifications.lb as overlay_lb,
      modifications.bhs as overlay_bhs,
      modifications.ghs as overlay_ghs,
      -- planning.stand only accepts [1-9][0-9]*[A-Z]?: keep the value when it
      -- already fits the contract, otherwise store NULL instead of failing.
      case
        when btrim(coalesce(
          case
            when 'stand' = any(coalesce(modifications.changed_fields, array[]::text[]))
              and modifications.action = 'modified'
            then modifications.stand
            else records.stand
          end
        , '')) ~ '^[1-9][0-9]*[A-Z]?$'
        then btrim(
          case
            when 'stand' = any(coalesce(modifications.changed_fields, array[]::text[]))
              and modifications.action = 'modified'
            then modifications.stand
            else records.stand
          end
        )
      end as stand_effective,
      case
        when modifications.action = 'deleted' or records.status = 'deleted' then 'deleted'
        else coalesce(modifications.action, records.action, 'added')
      end as action_effective,
      nullif(
        public.seasonal_draft_id_v1(
          linked.season_id,
          linked.type,
          public.seasonal_backfill_identity_date_v1(linked.scheduled_date, linked.operational_date, linked.date),
          linked.airline,
          linked.flight_number
        ),
        records.draft_id
      ) as linked_draft_id,
      nullif(
        public.seasonal_draft_id_v1(
          prior.season_id,
          prior.type,
          public.seasonal_backfill_identity_date_v1(prior.scheduled_date, prior.operational_date, prior.date),
          prior.airline,
          prior.flight_number
        ),
        records.draft_id
      ) as supersedes_draft_id,
      records.*
    from backfill_chosen_seasonal_sources records
    left join public.season_modifications modifications on modifications.leg_id = records.record_id
    left join public.season_flight_records linked on linked.record_id = records.linked_record_id
    left join public.season_flight_records prior on prior.record_id = records.supersedes_record_id
  )
  insert into public.seasonal_flight_drafts (
    draft_id, season_id, link_id, type, airline, flight_number, raw_flight_number, request_status_code,
    route, schedule, aircraft, category, code_shares, int_dom_ind, pax, gate, stand, carousel,
    mct, fb, lb, bhs, ghs,
    date, scheduled_date, scheduled_time, operational_date, iata_season_code, flight_series_id, day_of_week,
    action, source_row_index, linked_source_row_index, link_type, pair_anchor_date, linked_draft_id, turnaround_id,
    source_kind, source_side, status,
    source_import_batch_id, source_import_staging_row_index, source_file_hash, superseded_by_batch_id,
    supersedes_draft_id, deletion_reason, lifecycle_changed_at, lifecycle_changed_by, updated_at
  )
  select
    plan.draft_id, plan.season_id, plan.link_id, plan.type, plan.airline, plan.flight_number,
    plan.raw_flight_number, plan.request_status_code,
    case when 'route' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_route, plan.route) else plan.route end,
    case when 'schedule' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_schedule, plan.schedule) else plan.schedule end,
    case when 'aircraft' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_aircraft, plan.aircraft) else plan.aircraft end,
    plan.category,
    case when 'code_shares' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then plan.overlay_code_shares else plan.code_shares end,
    plan.int_dom_ind,
    case when 'pax' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_pax, plan.pax) else plan.pax end,
    case when 'gate' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_gate, plan.gate) else plan.gate end,
    plan.stand_effective,
    case when 'carousel' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_carousel, plan.carousel) else plan.carousel end,
    case when 'mct' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_mct, plan.mct) else plan.mct end,
    case when 'fb' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_fb, plan.fb) else plan.fb end,
    case when 'lb' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_lb, plan.lb) else plan.lb end,
    case when 'bhs' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_bhs, plan.bhs) else plan.bhs end,
    case when 'ghs' = any(plan.changed_fields) and plan.overlay_action = 'modified'
      then coalesce(plan.overlay_ghs, plan.ghs) else plan.ghs end,
    plan.date, plan.scheduled_date, plan.scheduled_time, plan.operational_date, plan.iata_season_code,
    plan.flight_series_id, plan.day_of_week,
    plan.action_effective,
    plan.source_row_index, plan.linked_source_row_index, plan.link_type, plan.pair_anchor_date,
    plan.linked_draft_id, plan.turnaround_id,
    'imported', plan.source_side,
    case when plan.action_effective = 'deleted' then 'deleted' else 'active' end,
    plan.source_import_batch_id, plan.source_import_staging_row_index, plan.source_file_hash,
    plan.superseded_by_batch_id, plan.supersedes_draft_id,
    case when plan.action_effective = 'deleted' then coalesce(plan.deletion_reason, 'legacy-deleted') else plan.deletion_reason end,
    plan.lifecycle_changed_at, plan.lifecycle_changed_by, now()
  from plan
  on conflict (draft_id) do update set
    season_id = excluded.season_id,
    link_id = excluded.link_id,
    type = excluded.type,
    airline = excluded.airline,
    flight_number = excluded.flight_number,
    raw_flight_number = excluded.raw_flight_number,
    request_status_code = excluded.request_status_code,
    route = excluded.route,
    schedule = excluded.schedule,
    aircraft = excluded.aircraft,
    category = excluded.category,
    code_shares = excluded.code_shares,
    int_dom_ind = excluded.int_dom_ind,
    pax = excluded.pax,
    gate = excluded.gate,
    stand = excluded.stand,
    carousel = excluded.carousel,
    mct = excluded.mct,
    fb = excluded.fb,
    lb = excluded.lb,
    bhs = excluded.bhs,
    ghs = excluded.ghs,
    date = excluded.date,
    scheduled_date = excluded.scheduled_date,
    scheduled_time = excluded.scheduled_time,
    operational_date = excluded.operational_date,
    iata_season_code = excluded.iata_season_code,
    flight_series_id = excluded.flight_series_id,
    day_of_week = excluded.day_of_week,
    action = excluded.action,
    source_row_index = excluded.source_row_index,
    linked_source_row_index = excluded.linked_source_row_index,
    link_type = excluded.link_type,
    pair_anchor_date = excluded.pair_anchor_date,
    linked_draft_id = excluded.linked_draft_id,
    turnaround_id = excluded.turnaround_id,
    source_kind = excluded.source_kind,
    source_side = excluded.source_side,
    status = excluded.status,
    source_import_batch_id = excluded.source_import_batch_id,
    source_import_staging_row_index = excluded.source_import_staging_row_index,
    source_file_hash = excluded.source_file_hash,
    superseded_by_batch_id = excluded.superseded_by_batch_id,
    supersedes_draft_id = excluded.supersedes_draft_id,
    deletion_reason = excluded.deletion_reason,
    lifecycle_changed_at = excluded.lifecycle_changed_at,
    lifecycle_changed_by = excluded.lifecycle_changed_by,
    updated_at = excluded.updated_at;

  get diagnostics v_written = row_count;

  -- Legacy overlays are folded into the draft, so their history must survive as
  -- draft events. The op_id carries a digest of the folded state and the
  -- changed_fields, so a replay that finds an unchanged overlay dedupes while a
  -- post-snapshot edit appends a new event instead of silently keeping the old
  -- before/after pair.
  insert into public.seasonal_draft_events (
    season_id, client_id, op_id, actor_user_id, server_seq, target_type, target_id,
    changed_fields, before_state, after_state, created_at
  )
  select
    records.season_id,
    'legacy-backfill',
    'overlay:' || modifications.leg_id || ':' || substr(md5(
      folded.overlay_state::text || '|' || coalesce(modifications.changed_fields::text, '')
    ), 1, 12),
    null,
    coalesce((
      select max(events.server_seq) from public.seasonal_draft_events events where events.season_id = records.season_id
    ), 0) + row_number() over (partition by records.season_id order by modifications.leg_id),
    'draft',
    records.draft_id,
    modifications.changed_fields,
    folded.overlay_state,
    jsonb_build_object('action', modifications.action, 'source', 'season_modifications'),
    now()
  from public.season_modifications modifications
  join backfill_chosen_seasonal_sources records on records.record_id = modifications.leg_id
  cross join lateral (
    select jsonb_strip_nulls(jsonb_build_object(
      'schedule', modifications.schedule,
      'pax', modifications.pax,
      'gate', modifications.gate,
      'stand', modifications.stand,
      'carousel', modifications.carousel,
      'route', modifications.route,
      'aircraft', modifications.aircraft
    )) as overlay_state
  ) folded
  on conflict (client_id, op_id) do nothing;

  -- Mirror the legacy row set: a plan row that no longer exists in
  -- season_flight_records cannot stay behind in the shadow copy. A draft a
  -- runtime leg still references is marked deleted instead of removed, so the
  -- leg keeps a valid lineage target.
  with legacy_drafts as (
    select records.draft_id
    from backfill_chosen_seasonal_sources records
  )
  update public.seasonal_flight_drafts drafts
     set status = 'deleted',
         action = 'deleted',
         deletion_reason = coalesce(drafts.deletion_reason, 'legacy-source-removed'),
         lifecycle_changed_at = now(),
         updated_at = now()
   where drafts.source_kind = 'imported'
     and drafts.status = 'active'
     and not exists (
       select 1 from legacy_drafts legacy
       where legacy.draft_id = drafts.draft_id
     )
     and exists (
       select 1 from public.operational_flight_legs legs
       where legs.source_season_id = drafts.season_id and legs.source_draft_id = drafts.draft_id
     );

  get diagnostics v_retired = row_count;

  with legacy_drafts as (
    select records.draft_id
    from backfill_chosen_seasonal_sources records
  )
  delete from public.seasonal_flight_drafts drafts
   where drafts.source_kind = 'imported'
     and not exists (
       select 1 from legacy_drafts legacy
       where legacy.draft_id = drafts.draft_id
     )
     and not exists (
       select 1 from public.operational_flight_legs legs
       where legs.source_season_id = drafts.season_id and legs.source_draft_id = drafts.draft_id
     );

  get diagnostics v_removed = row_count;
  drop table if exists backfill_chosen_seasonal_sources;

  update public.seasonal_operational_backfill_runs
     set drafts_written = v_written,
         notes = notes || jsonb_build_object(
           'draftsRetired', v_retired,
           'draftsRemoved', v_removed
         )
   where run_id = p_run_id;

  return jsonb_build_object(
    'written', v_written,
    'retired', v_retired,
    'removed', v_removed
  );
end;
$function$;

comment on function public.backfill_seasonal_flight_drafts_v1(uuid) is
  'M2 planning backfill: seasonal records of every lifecycle with their legacy overlays folded per changed_fields. Idempotent by seasonal_draft_id_v1; a replay also mirrors the legacy row set (drafts whose source row disappeared are removed, or marked deleted while a leg still references them) and appends one event per distinct folded overlay state.';

-- ---------------------------------------------------------------------------
-- 5. Baseline publish version per season that has drafts: Planning-only snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.seed_seasonal_baseline_versions_v1(
  p_run_id uuid,
  p_published_on date,
  p_published_by uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '900s'
as $function$
declare
  v_written integer := 0;
  v_season record;
  v_payload jsonb;
  v_checksum text;
  v_version_id uuid;
  v_sequence integer;
begin
  if p_published_by is null then
    raise exception 'a baseline version must record the operator who ran the backfill (p_published_by)';
  end if;

  for v_season in
    select
      seasons.id,
      seasons.season_code,
      seasons.effective_start,
      seasons.effective_end,
      count(drafts.draft_id)::integer as draft_count,
      count(drafts.draft_id) filter (where drafts.status = 'active')::integer as active_count
    from public.seasons seasons
    join public.seasonal_flight_drafts drafts on drafts.season_id = seasons.id
    where not exists (
      select 1 from public.seasonal_publish_versions versions
      where versions.season_id = seasons.id and versions.backfill_run_id is not null
    )
    group by seasons.id, seasons.season_code, seasons.effective_start, seasons.effective_end
    order by seasons.id
  loop
    select jsonb_build_object(
      'seasonId', v_season.id,
      'seasonCode', v_season.season_code,
      'scope', 'planning',
      'counts', jsonb_build_object(
        'total', v_season.draft_count,
        'active', v_season.active_count,
        'deleted', v_season.draft_count - v_season.active_count
      ),
      'flights', coalesce(jsonb_agg(jsonb_build_object(
        'draftId', drafts.draft_id,
        'type', drafts.type,
        'airline', drafts.airline,
        'flightNumber', drafts.flight_number,
        'rawFlightNumber', drafts.raw_flight_number,
        'route', drafts.route,
        'schedule', drafts.schedule,
        'aircraft', drafts.aircraft,
        'category', drafts.category,
        'pax', drafts.pax,
        'gate', drafts.gate,
        'stand', drafts.stand,
        'carousel', drafts.carousel,
        'date', drafts.date,
        'scheduledDate', drafts.scheduled_date,
        'scheduledTime', drafts.scheduled_time,
        'sourceSide', drafts.source_side,
        'sourceRowIndex', drafts.source_row_index,
        'status', drafts.status,
        'action', drafts.action
      ) order by drafts.date, drafts.type, drafts.scheduled_time, drafts.airline, drafts.flight_number), '[]'::jsonb)
    )
      into v_payload
    from public.seasonal_flight_drafts drafts
    where drafts.season_id = v_season.id;

    v_checksum := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex'
    );

    select coalesce(count(*), 0) + 1 into v_sequence
    from public.seasonal_publish_versions versions
    where versions.season_id = v_season.id;

    insert into public.seasonal_publish_versions (
      season_id, season_code, version_tag, sequence_in_day, published_at, published_by, publish_notes,
      range_start, range_end, total_flight_count, added_count, modified_count, removed_count, unchanged_count,
      skipped_day_count, diff_summary, snapshot_checksum, backfill_run_id
    ) values (
      v_season.id,
      v_season.season_code,
      public.seasonal_publish_version_tag(v_season.season_code, p_published_on, v_sequence),
      v_sequence,
      now(),
      p_published_by,
      'M2 baseline backfill: planning snapshot without daily operational data',
      coalesce(
        public.seasonal_backfill_identity_date_v1(v_season.effective_start, null, null),
        p_published_on
      ),
      coalesce(
        public.seasonal_backfill_identity_date_v1(v_season.effective_end, null, null),
        p_published_on
      ),
      v_season.active_count,
      v_season.active_count,
      0,
      0,
      0,
      0,
      jsonb_build_object('scope', 'planning', 'baseline', true),
      v_checksum,
      p_run_id
    )
    returning version_id into v_version_id;

    insert into public.seasonal_publish_snapshots (version_id, season_id, snapshot_payload, flight_count, checksum)
    values (v_version_id, v_season.id, v_payload, v_season.active_count, v_checksum);

    v_written := v_written + 1;
  end loop;

  update public.seasonal_operational_backfill_runs
     set versions_seeded = v_written
   where run_id = p_run_id;

  return v_written;
end;
$function$;

comment on function public.seed_seasonal_baseline_versions_v1(uuid, date, uuid) is
  'M2 baseline version + snapshot per season with planning drafts. The payload is planning-only and timestamp-free, so its checksum is stable across replays.';

-- ---------------------------------------------------------------------------
-- 6. Operations backfill from the canonical candidate slice, with Daily-first
--    eligibility and recency resolution within the eligible sources.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_operational_flight_legs_v1(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, reporting, extensions, pg_temp
set statement_timeout = '900s'
as $function$
declare
  v_bounds record;
  v_written integer := 0;
  v_updated integer := 0;
  v_retired integer := 0;
  v_quarantined integer := 0;
  v_quarantine_keys jsonb := '[]'::jsonb;
begin
  select bounds.min_ops_date, bounds.max_ops_date
    into v_bounds
  from reporting.get_public_traffic_canonical_bounds_v1() bounds;

  if v_bounds.min_ops_date is null then
    update public.seasonal_operational_backfill_runs
       set legs_written = 0,
           notes = notes || jsonb_build_object('legsSkipped', 'no canonical ops date bounds')
     where run_id = p_run_id;
    return jsonb_build_object('written', 0, 'updated', 0, 'retired', 0, 'quarantined', 0);
  end if;

  create temp table backfill_candidates on commit drop as
  with raw_slice as materialized (
    select
      candidates.*,
      coalesce(records.source_kind = 'daily', false) as is_daily,
      coalesce(
        bool_or(records.source_kind = 'daily') over (partition by candidates.business_leg_key),
        false
      ) as has_daily
    from reporting.get_public_traffic_candidate_slice_v1(
      v_bounds.min_ops_date - 1,
      v_bounds.max_ops_date + 1
    ) candidates
    left join public.season_flight_records records
      on records.season_id = candidates.season_id
     and records.record_id = candidates.record_id
  ), eligible_slice as materialized (
    select
      slice.season_id,
      slice.record_id,
      slice.type,
      slice.airline,
      slice.flight_number,
      slice.route,
      slice.aircraft,
      slice.pax,
      slice.scheduled_date,
      slice.scheduled_time,
      slice.effective_route,
      slice.effective_aircraft,
      slice.effective_pax,
      slice.effective_action,
      slice.scheduled_date_value,
      slice.local_minutes,
      slice.authoritative_server_seq,
      slice.ops_date,
      slice.scheduled_local_at,
      slice.business_leg_key
    from raw_slice slice
    where not slice.has_daily or slice.is_daily
  ), recency as materialized (
    select eligible.*,
           max(eligible.authoritative_server_seq) over (partition by eligible.business_leg_key) as max_authoritative_server_seq
    from eligible_slice eligible
  )
  select
    recency.*,
    count(*) over (partition by recency.business_leg_key) as candidate_count,
    count(*) filter (where recency.authoritative_server_seq is null)
      over (partition by recency.business_leg_key) as missing_recency_count,
    count(*) filter (where recency.authoritative_server_seq = recency.max_authoritative_server_seq)
      over (partition by recency.business_leg_key) as max_recency_count,
    row_number() over (
      partition by recency.business_leg_key
      order by recency.authoritative_server_seq desc nulls last, recency.season_id, recency.record_id
    ) as candidate_rank
  from recency;

  create index on backfill_candidates (business_leg_key);
  create index on backfill_candidates (season_id, record_id);

  -- The source's own resolution: every legacy record the slice resolves right
  -- now, linked or not. A replay reconciles against this set in both
  -- directions, so drift is updated and a lost resolution retires the leg.
  create temp table backfill_resolved on commit drop as
  select candidates.*
  from backfill_candidates candidates
  where candidates.candidate_rank = 1
    and not (
      candidates.candidate_count > 1
      and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
    )
    and candidates.effective_action is distinct from 'deleted';

  create index on backfill_resolved (season_id, record_id);

  -- One row of fully resolved leg values per legacy record: the same mapping the
  -- first run inserted, reused by the insert path and by the reconcile update.
  create temp table backfill_leg_values on commit drop as
  with staged_daily as (
    select legs.batch_id, legs.matched_record_id as record_id, legs.occurrence_key,
           legs.source_row_number, legs.counter_token, legs.gate, legs.stand, legs.carousel
    from public.daily_schedule_import_batch_legs legs
    where legs.matched_record_id is not null
    union all
    select legs.batch_id, legs.canonical_record_id as record_id, legs.occurrence_key,
           legs.source_row_number, legs.counter_token, legs.gate, legs.stand, legs.carousel
    from public.daily_schedule_import_batch_legs legs
    where legs.canonical_record_id is not null
      and legs.canonical_record_id is distinct from legs.matched_record_id
  ), baseline as (
    -- The baseline version is the one this season already got from any backfill
    -- run: a replay must not create a second baseline nor lose the lineage.
    select distinct on (versions.season_id) versions.season_id, versions.version_id
    from public.seasonal_publish_versions versions
    where versions.backfill_run_id is not null
    order by versions.season_id, versions.published_at, versions.version_id
  ), enriched as (
    select
      gen_random_uuid() as leg_id,
      resolved.season_id,
      resolved.record_id,
      resolved.type,
      resolved.flight_number,
      resolved.airline,
      resolved.effective_route,
      resolved.effective_aircraft,
      resolved.effective_pax,
      resolved.ops_date,
      resolved.scheduled_date_value,
      resolved.scheduled_time,
      resolved.authoritative_server_seq,
      records.source_kind,
      records.raw_flight_number,
      records.category,
      records.code_shares,
      records.int_dom_ind,
      records.mct, records.fb, records.lb, records.bhs, records.ghs,
      records.turnaround_id, records.link_type, records.pair_anchor_date,
      records.source_import_batch_id, records.source_import_staging_row_index,
      case when 'gate' = any(coalesce(overlay.changed_fields, array[]::text[])) and overlay.action = 'modified'
        then coalesce(overlay.gate, records.gate) else records.gate end as gate,
      case when 'stand' = any(coalesce(overlay.changed_fields, array[]::text[])) and overlay.action = 'modified'
        then coalesce(overlay.stand, records.stand) else records.stand end as stand,
      case when 'carousel' = any(coalesce(overlay.changed_fields, array[]::text[])) and overlay.action = 'modified'
        then coalesce(overlay.carousel, records.carousel) else records.carousel end as carousel,
      coalesce(staged.counter_token, overlay.check_in_allocation_mode) as counter_token,
      staged.occurrence_key as daily_occurrence_key,
      overlay.check_in_start, overlay.check_in_end, overlay.check_in_allocation_mode,
      baseline.version_id,
      public.seasonal_draft_id_v1(
        resolved.season_id,
        resolved.type,
        public.seasonal_backfill_identity_date_v1(records.scheduled_date, records.operational_date, records.date),
        resolved.airline,
        resolved.flight_number
      ) as draft_id
    from backfill_resolved resolved
    join public.season_flight_records records
      on records.season_id = resolved.season_id and records.record_id = resolved.record_id
    left join public.season_modifications overlay
      on overlay.season_id = resolved.season_id and overlay.leg_id = resolved.record_id
    left join staged_daily staged
      on staged.batch_id = records.source_import_batch_id
     and staged.record_id = records.record_id
    left join baseline on baseline.season_id = resolved.season_id
    order by resolved.season_id, resolved.record_id
  )
  select * from enriched;

  create index on backfill_leg_values (season_id, record_id);

  with inserted as (
    insert into public.operational_flight_legs (
      leg_id, leg_key, operational_date, scheduled_date, scheduled_time, side, airline, flight_number, raw_flight_number,
      route, aircraft_type, flight_category, pax, code_shares, int_dom_ind,
      stand, gate, carousel, counter_token, mct, fb, lb, bhs, ghs,
      check_in_start, check_in_end, check_in_allocation_mode,
      turnaround_id, link_type, pair_anchor_date,
      source_type, source_season_id, source_draft_id, source_batch_id, source_occurrence_key, source_row_number,
      published_version_id, status, created_at, updated_at
    )
    select
      values_.leg_id,
      values_.type || chr(31) || values_.ops_date::text || chr(31)
        || upper(btrim(values_.airline)) || chr(31) || upper(btrim(values_.flight_number)),
      values_.ops_date,
      coalesce(values_.scheduled_date_value, values_.ops_date),
      case
        when coalesce(values_.scheduled_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then values_.scheduled_time::time
        else time '00:00'
      end,
      case when upper(btrim(values_.type)) = 'A' then 'ARR' else 'DEP' end,
      upper(btrim(values_.airline)),
      upper(btrim(values_.flight_number)),
      values_.raw_flight_number,
      coalesce(nullif(btrim(values_.effective_route), ''), 'Unknown'),
      coalesce(nullif(btrim(values_.effective_aircraft), ''), 'Unknown'),
      case when upper(btrim(coalesce(values_.category, ''))) = 'J' then 'J' else 'C' end,
      values_.effective_pax,
      values_.code_shares,
      values_.int_dom_ind,
      case when btrim(coalesce(values_.stand, '')) ~ '^[1-9][0-9]*[A-Z]?$' then btrim(values_.stand) end,
      values_.gate,
      values_.carousel,
      values_.counter_token,
      values_.mct, values_.fb, values_.lb, values_.bhs, values_.ghs,
      values_.check_in_start, values_.check_in_end, values_.check_in_allocation_mode,
      values_.turnaround_id, values_.link_type,
      public.seasonal_backfill_identity_date_v1(values_.pair_anchor_date, null, null),
      case values_.source_kind
        when 'daily' then 'daily_import'
        when 'manual' then 'operational_manual'
        else 'published_seasonal'
      end,
      case when values_.source_kind = 'seasonal' then values_.season_id end,
      case when values_.source_kind = 'seasonal' then values_.draft_id end,
      case when values_.source_kind = 'daily' then values_.source_import_batch_id end,
      case when values_.source_kind = 'daily' then coalesce(values_.daily_occurrence_key, values_.record_id) end,
      case when values_.source_kind = 'daily' then values_.source_import_staging_row_index end,
      case when values_.source_kind = 'seasonal' then values_.version_id end,
      'active',
      now(),
      now()
    from backfill_leg_values values_
    where not exists (
      select 1 from public.operational_leg_backfill_links links
      where links.legacy_season_id = values_.season_id and links.legacy_record_id = values_.record_id
    )
    returning leg_id
  )
  insert into public.operational_leg_backfill_links (legacy_season_id, legacy_record_id, leg_id, run_id, authoritative_server_seq)
  select values_.season_id, values_.record_id, values_.leg_id, p_run_id, values_.authoritative_server_seq
  from backfill_leg_values values_
  join inserted on inserted.leg_id = values_.leg_id
  on conflict (legacy_season_id, legacy_record_id) do nothing;

  update public.operational_leg_backfill_links links
     set authoritative_server_seq = values_.authoritative_server_seq
    from backfill_leg_values values_
   where links.legacy_season_id = values_.season_id
     and links.legacy_record_id = values_.record_id
     and links.authoritative_server_seq is distinct from values_.authoritative_server_seq;

  -- Reconcile pass: an already linked leg must follow the source. Without this a
  -- post-snapshot overlay edit (pax, schedule, resources) or a refreshed daily
  -- batch would stay stale in the shadow copy, and a leg that lost the
  -- resolution would stay active next to its winner because the insert path
  -- only ever adds rows.
  update public.operational_flight_legs legs
     set leg_key = values_.type || chr(31) || values_.ops_date::text || chr(31)
           || upper(btrim(values_.airline)) || chr(31) || upper(btrim(values_.flight_number)),
         operational_date = values_.ops_date,
         scheduled_date = coalesce(values_.scheduled_date_value, values_.ops_date),
         scheduled_time = case
           when coalesce(values_.scheduled_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then values_.scheduled_time::time
           else time '00:00'
         end,
         side = case when upper(btrim(values_.type)) = 'A' then 'ARR' else 'DEP' end,
         airline = upper(btrim(values_.airline)),
         flight_number = upper(btrim(values_.flight_number)),
         raw_flight_number = values_.raw_flight_number,
         route = coalesce(nullif(btrim(values_.effective_route), ''), 'Unknown'),
         aircraft_type = coalesce(nullif(btrim(values_.effective_aircraft), ''), 'Unknown'),
         flight_category = case when upper(btrim(coalesce(values_.category, ''))) = 'J' then 'J' else 'C' end,
         pax = values_.effective_pax,
         code_shares = values_.code_shares,
         int_dom_ind = values_.int_dom_ind,
         stand = case when btrim(coalesce(values_.stand, '')) ~ '^[1-9][0-9]*[A-Z]?$' then btrim(values_.stand) end,
         gate = values_.gate,
         carousel = values_.carousel,
         counter_token = values_.counter_token,
         mct = values_.mct, fb = values_.fb, lb = values_.lb, bhs = values_.bhs, ghs = values_.ghs,
         check_in_start = values_.check_in_start,
         check_in_end = values_.check_in_end,
         check_in_allocation_mode = values_.check_in_allocation_mode,
         turnaround_id = values_.turnaround_id,
         link_type = values_.link_type,
         pair_anchor_date = public.seasonal_backfill_identity_date_v1(values_.pair_anchor_date, null, null),
         source_type = case values_.source_kind
           when 'daily' then 'daily_import'
           when 'manual' then 'operational_manual'
           else 'published_seasonal'
         end,
         source_season_id = case when values_.source_kind = 'seasonal' then values_.season_id end,
         source_draft_id = case when values_.source_kind = 'seasonal' then values_.draft_id end,
         source_batch_id = case when values_.source_kind = 'daily' then values_.source_import_batch_id end,
         source_occurrence_key = case when values_.source_kind = 'daily'
           then coalesce(values_.daily_occurrence_key, values_.record_id) end,
         source_row_number = case when values_.source_kind = 'daily'
           then values_.source_import_staging_row_index end,
         published_version_id = case when values_.source_kind = 'seasonal' then values_.version_id end,
         status = 'active',
         deletion_reason = null,
         updated_at = now()
    from backfill_leg_values values_
    join public.operational_leg_backfill_links links
      on links.legacy_season_id = values_.season_id and links.legacy_record_id = values_.record_id
   where legs.leg_id = links.leg_id
     and (
       legs.leg_key, legs.operational_date, legs.scheduled_date, legs.scheduled_time, legs.side, legs.airline,
       legs.flight_number, legs.raw_flight_number, legs.route, legs.aircraft_type, legs.flight_category, legs.pax,
       legs.code_shares, legs.int_dom_ind, legs.stand, legs.gate, legs.carousel, legs.counter_token,
       legs.mct, legs.fb, legs.lb, legs.bhs, legs.ghs,
       legs.check_in_start, legs.check_in_end, legs.check_in_allocation_mode,
       legs.turnaround_id, legs.link_type, legs.pair_anchor_date,
       legs.source_type, legs.source_season_id, legs.source_draft_id, legs.source_batch_id,
       legs.source_occurrence_key, legs.source_row_number, legs.published_version_id,
       legs.status, legs.deletion_reason
     ) is distinct from (
       values_.type || chr(31) || values_.ops_date::text || chr(31)
         || upper(btrim(values_.airline)) || chr(31) || upper(btrim(values_.flight_number)),
       values_.ops_date,
       coalesce(values_.scheduled_date_value, values_.ops_date),
       case
         when coalesce(values_.scheduled_time, '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then values_.scheduled_time::time
         else time '00:00'
       end,
       case when upper(btrim(values_.type)) = 'A' then 'ARR' else 'DEP' end,
       upper(btrim(values_.airline)),
       upper(btrim(values_.flight_number)),
       values_.raw_flight_number,
       coalesce(nullif(btrim(values_.effective_route), ''), 'Unknown'),
       coalesce(nullif(btrim(values_.effective_aircraft), ''), 'Unknown'),
       case when upper(btrim(coalesce(values_.category, ''))) = 'J' then 'J' else 'C' end,
       values_.effective_pax,
       values_.code_shares,
       values_.int_dom_ind,
       case when btrim(coalesce(values_.stand, '')) ~ '^[1-9][0-9]*[A-Z]?$' then btrim(values_.stand) end,
       values_.gate,
       values_.carousel,
       values_.counter_token,
       values_.mct, values_.fb, values_.lb, values_.bhs, values_.ghs,
       values_.check_in_start, values_.check_in_end, values_.check_in_allocation_mode,
       values_.turnaround_id, values_.link_type,
       public.seasonal_backfill_identity_date_v1(values_.pair_anchor_date, null, null),
       case values_.source_kind
         when 'daily' then 'daily_import'
         when 'manual' then 'operational_manual'
         else 'published_seasonal'
       end,
       case when values_.source_kind = 'seasonal' then values_.season_id end,
       case when values_.source_kind = 'seasonal' then values_.draft_id end,
       case when values_.source_kind = 'daily' then values_.source_import_batch_id end,
       case when values_.source_kind = 'daily' then coalesce(values_.daily_occurrence_key, values_.record_id) end,
       case when values_.source_kind = 'daily' then values_.source_import_staging_row_index end,
       case when values_.source_kind = 'seasonal' then values_.version_id end,
       'active',
       null::text
     );

  get diagnostics v_updated = row_count;

  -- A leg whose legacy record is no longer resolved (plan row deleted, daily
  -- batch replaced, key became ambiguous) is retired instead of lingering as a
  -- second active row for the same business key.
  update public.operational_flight_legs legs
     set status = 'deleted',
         deletion_reason = coalesce(legs.deletion_reason, 'backfill-source-removed'),
         linked_leg_id = null,
         updated_at = now()
    from public.operational_leg_backfill_links links
   where legs.leg_id = links.leg_id
     and legs.status = 'active'
     and not exists (
       select 1 from backfill_leg_values values_
       where values_.season_id = links.legacy_season_id and values_.record_id = links.legacy_record_id
     );

  get diagnostics v_retired = row_count;

  -- A leg can only be paired with an active partner: drop the pairing that a
  -- retirement just invalidated before the wiring pass below.
  update public.operational_flight_legs legs
     set linked_leg_id = null,
         updated_at = now()
   where legs.linked_leg_id is not null
     and exists (
       select 1 from public.operational_flight_legs counterpart
       where counterpart.leg_id = legs.linked_leg_id
         and counterpart.status <> 'active'
     );

  -- Turnaround wiring is recomputed from the legacy linked_record_id on every
  -- run instead of only being added: the source can also *remove* a pairing
  -- between two legs that stay active, and the runtime must follow (NULL when
  -- the source has no partner or the partner leg is not active).
  update public.operational_flight_legs legs
     set linked_leg_id = counterpart_leg.leg_id,
         updated_at = now()
    from public.operational_leg_backfill_links own
    join public.season_flight_records records
      on records.season_id = own.legacy_season_id and records.record_id = own.legacy_record_id
    left join public.operational_leg_backfill_links counterpart
      on counterpart.legacy_season_id = records.season_id
     and counterpart.legacy_record_id = records.linked_record_id
    left join public.operational_flight_legs counterpart_leg
      on counterpart_leg.leg_id = counterpart.leg_id and counterpart_leg.status = 'active'
   where legs.leg_id = own.leg_id
     and legs.status = 'active'
     and legs.linked_leg_id is distinct from counterpart_leg.leg_id;

  -- legs_written counts the legs this run created: a replay inserts none because
  -- every legacy record already has a lineage link.
  select count(*)::integer into v_written
  from public.operational_leg_backfill_links links
  where links.run_id = p_run_id;

  -- The refusal itself has to outlive the run: the shadow projection reports the
  -- same quality numbers as the canonical store after the M10 cutover, so the
  -- ledger is rebuilt from this run's resolution instead of only summarised in
  -- notes. A key that stopped being ambiguous disappears again.
  delete from public.operational_leg_quarantine where source = 'backfill';

  insert into public.operational_leg_quarantine (business_leg_key, ops_date, candidate_count, source)
  select candidates.business_leg_key, candidates.ops_date, candidates.candidate_count, 'backfill'
  from backfill_candidates candidates
  where candidates.candidate_rank = 1
    and candidates.candidate_count > 1
    and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
  on conflict (business_leg_key) do update
    set ops_date = excluded.ops_date,
        candidate_count = excluded.candidate_count,
        source = excluded.source,
        quarantined_at = now();

  select count(*)::integer into v_quarantined
  from backfill_candidates candidates
  where candidates.candidate_rank = 1
    and candidates.candidate_count > 1
    and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1);

  select coalesce(jsonb_agg(quarantined.business_leg_key), '[]'::jsonb)
    into v_quarantine_keys
  from (
    select candidates.business_leg_key
    from backfill_candidates candidates
    where candidates.candidate_rank = 1
      and candidates.candidate_count > 1
      and (candidates.missing_recency_count > 0 or candidates.max_recency_count > 1)
    order by candidates.business_leg_key
    limit 20
  ) quarantined;

  update public.seasonal_operational_backfill_runs
     set legs_written = v_written,
         notes = notes || jsonb_build_object(
           'legsUpdated', v_updated,
           'legsRetired', v_retired,
           'legsQuarantined', v_quarantined,
           'quarantinedBusinessKeys', v_quarantine_keys
         )
   where run_id = p_run_id;

  return jsonb_build_object(
    'written', v_written,
    'updated', v_updated,
    'retired', v_retired,
    'quarantined', v_quarantined,
    'quarantinedBusinessKeys', v_quarantine_keys
  );
end;
$function$;

comment on function public.backfill_operational_flight_legs_v1(uuid) is
  'M2 operations backfill from reporting.get_public_traffic_candidate_slice_v1 with Daily priority and canonical recency ranking within priority (ambiguous keys quarantined). Seasonal rows become published_seasonal carrying their baseline version, daily rows keep batch/occurrence lineage, manual rows stay operational_manual. A replay reconciles in both directions: linked legs whose source drifted are updated (reactivated when the source returned), and legs whose legacy record is no longer resolved are retired as deleted so the winner is not shadowed by a stale active row.';

-- ---------------------------------------------------------------------------
-- 7. Daily day-authority backfill from schedule_replacement_scopes.
-- ---------------------------------------------------------------------------
create or replace function public.backfill_operational_day_authority_v1(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '900s'
as $function$
declare
  v_written integer;
begin
  with ranked as (
    select scopes.*,
           row_number() over (
             partition by scopes.ops_date
             order by scopes.committed_at desc, scopes.data_version desc, scopes.season_id
           ) as rank
    from public.schedule_replacement_scopes scopes
  ), chosen as (
    select * from ranked where rank = 1
  ), upserted as (
    insert into public.operational_day_authority (
      operational_date, authority_source, source_batch_id, leg_count, canonical_checksum,
      authority_revision, committed_at, committed_by, reset_at, reset_by, reset_reason
    )
    select
      chosen.ops_date, 'daily_import', chosen.source_batch_id, chosen.expected_leg_count,
      chosen.canonical_checksum, 1, chosen.committed_at, chosen.committed_by,
      chosen.reset_at, chosen.reset_by, chosen.reset_reason
    from chosen
    on conflict (operational_date) do update set
      source_batch_id = excluded.source_batch_id,
      leg_count = excluded.leg_count,
      canonical_checksum = excluded.canonical_checksum,
      authority_revision = public.operational_day_authority.authority_revision + case
        when (public.operational_day_authority.source_batch_id,
              public.operational_day_authority.leg_count,
              public.operational_day_authority.canonical_checksum,
              public.operational_day_authority.reset_at)
             is distinct from (excluded.source_batch_id, excluded.leg_count, excluded.canonical_checksum, excluded.reset_at)
          then 1 else 0 end,
      reset_at = excluded.reset_at,
      reset_by = excluded.reset_by,
      reset_reason = excluded.reset_reason
    returning operational_date, source_batch_id, leg_count, canonical_checksum, authority_revision,
              reset_at, reset_reason, committed_by
  )
  select count(*)::integer into v_written from upserted;

  -- Audit trail: one commit event per distinct batch/checksum, one reset event per distinct reset.
  insert into public.operational_day_authority_events (
    operational_date, event_type, source_batch_id, leg_count, canonical_checksum, authority_revision, actor_user_id, reason
  )
  select authority.operational_date, 'commit', authority.source_batch_id, authority.leg_count,
         authority.canonical_checksum, authority.authority_revision, authority.committed_by, null
  from public.operational_day_authority authority
  where not exists (
    select 1 from public.operational_day_authority_events events
    where events.operational_date = authority.operational_date
      and events.event_type = 'commit'
      and events.source_batch_id = authority.source_batch_id
      and events.canonical_checksum = authority.canonical_checksum
  );

  insert into public.operational_day_authority_events (
    operational_date, event_type, source_batch_id, leg_count, canonical_checksum, authority_revision, actor_user_id, reason
  )
  select authority.operational_date, 'reset', authority.source_batch_id, authority.leg_count,
         authority.canonical_checksum, authority.authority_revision, authority.reset_by,
         coalesce(authority.reset_reason, 'legacy reset')
  from public.operational_day_authority authority
  where authority.reset_at is not null
    and not exists (
      select 1 from public.operational_day_authority_events events
      where events.operational_date = authority.operational_date
        and events.event_type = 'reset'
        and events.reason = coalesce(authority.reset_reason, 'legacy reset')
    );

  update public.seasonal_operational_backfill_runs
     set authority_rows_written = v_written
   where run_id = p_run_id;

  return v_written;
end;
$function$;

comment on function public.backfill_operational_day_authority_v1(uuid) is
  'M2 day-authority backfill from schedule_replacement_scopes: latest scope per ops date, keeping zero-leg days, the reset state and one audit event per commit/reset. Idempotent, so a replay only bumps the revision when the scope changed.';

-- ---------------------------------------------------------------------------
-- 8. Orchestrator: one run = cutoff + high-water + all four steps.
-- ---------------------------------------------------------------------------
create or replace function public.run_seasonal_operational_backfill_v1(
  p_published_on date,
  p_published_by uuid,
  p_replayed_from_high_water bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '1800s'
as $function$
declare
  v_run_id uuid;
  v_cutoff timestamp with time zone := statement_timestamp();
  v_high_water bigint;
  v_drafts jsonb;
  v_versions integer;
  v_legs jsonb;
  v_authority integer;
begin
  if not (
    public.app_operator_has_permission('seasonal.write')
    or public.app_operator_has_permission('daily.write')
    or public.app_operator_has_permission('season.repair')
  ) then
    raise exception 'backfill requires seasonal.write, daily.write or season.repair' using errcode = '42501';
  end if;

  select coalesce(max(events.server_seq), 0) into v_high_water from public.season_change_events events;

  insert into public.seasonal_operational_backfill_runs (
    cutoff_at, source_high_water, replayed_from_high_water, published_on, published_by, status
  ) values (
    v_cutoff, v_high_water, p_replayed_from_high_water, p_published_on, p_published_by, 'running'
  ) returning run_id into v_run_id;

  begin
    v_drafts := public.backfill_seasonal_flight_drafts_v1(v_run_id);
    v_versions := public.seed_seasonal_baseline_versions_v1(v_run_id, p_published_on, p_published_by);
    v_legs := public.backfill_operational_flight_legs_v1(v_run_id);
    v_authority := public.backfill_operational_day_authority_v1(v_run_id);

    update public.seasonal_operational_backfill_runs
       set status = 'completed',
           completed_at = now(),
           drafts_written = (v_drafts->>'written')::integer,
           versions_seeded = v_versions,
           legs_written = (v_legs->>'written')::integer,
           authority_rows_written = v_authority
     where run_id = v_run_id;
  exception when others then
    update public.seasonal_operational_backfill_runs
       set status = 'failed',
           completed_at = now(),
           notes = notes || jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate)
     where run_id = v_run_id;
    raise;
  end;

  -- Shadow readers are woken in the same transaction as the write, exactly like
  -- the Daily dashboard wake: the M3.4 projection runner listens on this channel
  -- and the timer is only the fallback for a notification that never arrives.
  perform pg_notify(
    'operational_projection_wake',
    jsonb_build_object('source', 'seasonal-operational-backfill-v1', 'runId', v_run_id, 'highWater', v_high_water)::text
  );

  return jsonb_build_object(
    'runId', v_run_id,
    'cutoffAt', v_cutoff,
    'sourceHighWater', v_high_water,
    'drafts', v_drafts,
    'versions', v_versions,
    'legs', v_legs,
    'authorityDays', v_authority
  );
end;
$function$;

comment on function public.run_seasonal_operational_backfill_v1(date, uuid, bigint) is
  'M2 orchestrator: records the cutoff and the season_change_events high-water, then runs drafts -> baseline versions -> operational legs -> day authority. Safe to re-run: every step upserts by deterministic identity and reconciles the shadow copy with the current source in both directions (drifted rows are updated, vanished sources are retired or removed).';

revoke all on function public.backfill_seasonal_flight_drafts_v1(uuid) from public, anon, authenticated;
revoke all on function public.seed_seasonal_baseline_versions_v1(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.backfill_operational_flight_legs_v1(uuid) from public, anon, authenticated;
revoke all on function public.backfill_operational_day_authority_v1(uuid) from public, anon, authenticated;
revoke all on function public.run_seasonal_operational_backfill_v1(date, uuid, bigint) from public, anon, authenticated;
grant execute on function public.run_seasonal_operational_backfill_v1(date, uuid, bigint) to authenticated;

commit;
