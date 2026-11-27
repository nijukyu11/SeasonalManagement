-- 20261106110000_operational_projection_optimistic_prepare_v1.sql
-- Optimistic prepare pattern for reporting.refresh_operational_canonical_legs_internal_v1:
-- 1. Remove early operational_workspace_revision FOR SHARE lock to eliminate reader-blocked contention.
-- 2. Compute candidate slices and prepare temporary tables concurrently with operational mutations.
-- 3. Execute speculative projection DELETE/INSERT writes completely UNLOCKED from workspace revision lock.
-- 4. Late invariant check: acquire FOR SHARE on operational_workspace_revision only at the very end
--    before marking state fresh and clearing dirty queue; held until caller transaction ends.
-- 5. On detected revision/watermark change (concurrent mutation committed), roll back ALL speculative
--    projection writes via nested PL/pgSQL subtransaction (SQLSTATE PZ001 caught only around the inner block),
--    preserving prior projection, state, and dirty scope without rolling back the caller transaction.
-- 6. Preserve transaction-level advisory lock pg_advisory_xact_lock to serialize refresh runners.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- Capture deployment preimage for byte-exact rollback preservation
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
grant select, insert, update, delete on reporting.operational_projection_migration_preimages_v1 to service_role;

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
  '20261106110000',
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
  and p.proname = 'refresh_operational_canonical_legs_internal_v1'
on conflict (migration_tag, function_schema, function_name, function_signature)
do nothing;

create or replace function reporting.refresh_operational_canonical_legs_internal_v1(
  p_force_full boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'reporting', 'public', 'extensions', 'pg_temp'
as $function$
-- marker: optimistic_projection_refresh_v1
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
  -- 1. Refresh runner concurrency serialization: transaction-level advisory lock
  -- Serializes concurrent refresh executions while NEVER blocking operational mutations.
  perform pg_advisory_xact_lock(hashtext('reporting.operational_canonical_flight_legs'));

  -- 2. Read baseline state and monotonic revision/watermarks WITHOUT taking early FOR SHARE lock.
  -- This eliminates mutator lock contention during the long candidate preparation phase.
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
    -- An elapsed maintenance interval alone must not starve a known dirty slice.
    -- Incremental publication leaves last_reconciled_at unchanged: the runner
    -- still owes a full reconcile, and attempts it when the queue is empty.
    or (v_state.last_reconciled_at < now() - interval '1 hour'
        and not exists (select 1 from reporting.operational_projection_dirty_scope_v1));

  if v_is_full then
    -- ---------------------------------------------------------------------------
    -- FULL RECONCILIATION BRANCH
    -- ---------------------------------------------------------------------------
    select bounds.min_ops_date, bounds.max_ops_date
      into v_min_date, v_max_date
    from reporting.get_operational_canonical_bounds_v1() bounds;

    if v_min_date is null or v_max_date is null then
      -- Empty store sub-branch: wrapped in speculative subtransaction
      begin
        delete from reporting.operational_canonical_flight_legs;
        delete from reporting.operational_canonical_flight_legs_quarantine;

        if v_cutover then
          delete from reporting.canonical_flight_legs;
          delete from reporting.canonical_flight_legs_quarantine;
        end if;

        -- Late invariant check
        perform 1 from public.operational_workspace_revision where singleton for share;
        select revision into v_observed_revision from public.operational_workspace_revision where singleton;
        select coalesce(max(events.server_seq), 0)::bigint into v_observed from public.season_change_events events;

        if v_observed_revision <> v_operational_revision or v_observed > v_watermark then
          raise exception using errcode = 'PZ001', message = 'STALE_OPTIMISTIC_PROJECTION_ROLLBACK';
        end if;

        delete from reporting.operational_projection_dirty_scope_v1;

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

      exception
        when sqlstate 'PZ001' then
          return;
      end;
      return;
    end if;

    -- Concurrently prepare candidate slices in session temporary tables without revision lock
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

    -- Speculative publication subtransaction:
    -- Publication writes execute completely UNLOCKED from operational_workspace_revision.
    -- If a mutation committed during preparation or writing, all speculative writes are rolled back
    -- without rolling back the caller transaction.
    begin
      delete from reporting.operational_canonical_flight_legs;
      insert into reporting.operational_canonical_flight_legs (
        business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
        flight_category, pax, local_minutes, scheduled_local_at
      )
      select * from tmp_new_operational_legs;

      delete from reporting.operational_canonical_flight_legs_quarantine;
      insert into reporting.operational_canonical_flight_legs_quarantine (ops_date, candidate_count)
      select quarantine.ops_date, quarantine.candidate_count
      from tmp_new_operational_quarantine quarantine;

      if v_cutover then
        delete from reporting.canonical_flight_legs;
        insert into reporting.canonical_flight_legs (
          business_leg_key, ops_date, type, airline, flight_number, route, aircraft_type,
          flight_category, pax, local_minutes, scheduled_local_at
        )
        select * from reporting.operational_canonical_flight_legs;

        delete from reporting.canonical_flight_legs_quarantine;
        insert into reporting.canonical_flight_legs_quarantine (ops_date, candidate_count)
        select quarantine.ops_date, quarantine.candidate_count
        from reporting.operational_canonical_flight_legs_quarantine quarantine;
      end if;

      select count(*)::integer into v_leg_count from reporting.operational_canonical_flight_legs;
      select count(*)::integer into v_quarantine_count from reporting.operational_canonical_flight_legs_quarantine;

      -- Late invariant check: acquire FOR SHARE on operational_workspace_revision.
      perform 1 from public.operational_workspace_revision where singleton for share;
      select revision into v_observed_revision from public.operational_workspace_revision where singleton;
      select coalesce(max(events.server_seq), 0)::bigint into v_observed from public.season_change_events events;

      if v_observed_revision <> v_operational_revision or v_observed > v_watermark then
        -- Invariant violated: roll back all speculative writes via subtransaction rollback
        raise exception using errcode = 'PZ001', message = 'STALE_OPTIMISTIC_PROJECTION_ROLLBACK';
      end if;

      -- If invariant holds: commit projection writes, clean dirty queue, and update state
      delete from reporting.operational_projection_dirty_scope_v1;

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

    exception
      when sqlstate 'PZ001' then
        -- All speculative deletes and inserts on projection tables are cleanly rolled back.
        -- Prior projection and state are completely preserved.
        return;
    end;

    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- INCREMENTAL RECONCILIATION BRANCH
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
    -- Late check before deleting empty claimed dirty rows
    perform 1 from public.operational_workspace_revision where singleton for share;
    select revision into v_observed_revision from public.operational_workspace_revision where singleton;
    select coalesce(max(events.server_seq), 0)::bigint into v_observed from public.season_change_events events;

    if v_observed_revision <> v_operational_revision or v_observed > v_watermark then
      return;
    end if;

    delete from reporting.operational_projection_dirty_scope_v1
    where enqueue_id in (select enqueue_id from tmp_claimed_dirty);
    return;
  end if;

  -- Candidate slice for expanded dirty dates prepared in temporary tables
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

  -- Speculative incremental publication subtransaction
  begin
    -- Delete replaced scope from operational projection under subtransaction
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

    select min(ops_date), max(ops_date)
    into v_min_date, v_max_date
    from reporting.operational_canonical_flight_legs;

    v_leg_count := greatest(0, coalesce(v_state.leg_count, 0) - v_old_legs + v_delta_legs);
    v_quarantine_count := greatest(0, coalesce(v_state.quarantine_count, 0) - v_old_quarantine + v_delta_quarantine);

    -- Late invariant check: acquire FOR SHARE on operational_workspace_revision.
    perform 1 from public.operational_workspace_revision where singleton for share;
    select revision into v_observed_revision from public.operational_workspace_revision where singleton;
    select coalesce(max(events.server_seq), 0)::bigint into v_observed from public.season_change_events events;

    if v_observed_revision <> v_operational_revision or v_observed > v_watermark then
      -- Invariant violated: roll back all speculative writes via subtransaction rollback
      raise exception using errcode = 'PZ001', message = 'STALE_OPTIMISTIC_PROJECTION_ROLLBACK';
    end if;

    -- If invariant holds: commit incremental delta, clean dirty queue, and update state
    delete from reporting.operational_projection_dirty_scope_v1
    where enqueue_id in (select enqueue_id from tmp_claimed_dirty);

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

  exception
    when sqlstate 'PZ001' then
      -- Speculative delta rolled back; prior projection, state, and dirty queue preserved
      return;
  end;
end;
$function$;

alter function reporting.refresh_operational_canonical_legs_internal_v1(boolean) owner to postgres;
revoke all on function reporting.refresh_operational_canonical_legs_internal_v1(boolean) from public, anon, authenticated;
grant execute on function reporting.refresh_operational_canonical_legs_internal_v1(boolean) to service_role;

commit;
