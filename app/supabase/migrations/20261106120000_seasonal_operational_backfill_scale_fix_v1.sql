-- 20261106120000_seasonal_operational_backfill_scale_fix_v1.sql
-- Optimizes backfill_operational_flight_legs_v1 for large-scale datasets (248k+ canonical rows):
-- 1. Explicit ANALYZE on temp staging tables and fresh operational tables inside the backfill transaction
--    to prevent catastrophic nested loop join plans.
-- 2. Predicate refinement on turnaround wiring UPDATE to bypass impossible no-op updates on unlinked legs.
-- 3. Dynamic runtime preimage capture preserving exact pre-migration function definition, owner, and ACL.

begin;
set local lock_timeout = '15s';
set local statement_timeout = '300s';

-- Create preimage table if not present (supports execution right after M2 independent of later migrations)
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

-- Capture runtime preimage of backfill_operational_flight_legs_v1
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
  '20261106120000',
  n.nspname,
  p.proname,
  pg_catalog.oidvectortypes(p.proargtypes),
  pg_catalog.pg_get_functiondef(p.oid),
  r.rolname,
  p.proacl::text
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_roles r on r.oid = p.proowner
where n.nspname = 'public'
  and p.proname = 'backfill_operational_flight_legs_v1'
  and pg_catalog.oidvectortypes(p.proargtypes) = 'uuid'
on conflict (migration_tag, function_schema, function_name, function_signature) do nothing;

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
  analyze backfill_candidates;

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
  analyze backfill_resolved;

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
  analyze backfill_leg_values;

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
  analyze public.operational_flight_legs;
  analyze public.operational_leg_backfill_links;


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

  analyze public.operational_flight_legs;
  analyze public.operational_leg_backfill_links;

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
     and (coalesce(btrim(records.linked_record_id), '') <> '' or legs.linked_leg_id is not null)
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

alter function public.backfill_operational_flight_legs_v1(uuid) owner to postgres;
revoke all on function public.backfill_operational_flight_legs_v1(uuid) from public, anon, authenticated;

commit;
