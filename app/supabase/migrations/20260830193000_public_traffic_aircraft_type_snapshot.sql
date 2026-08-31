-- The canonical application owns the physical public traffic snapshot. Build
-- both the aircraft-type projection and an independently populated rollback MV
-- beside the live relation. Drop the canonical OID without CASCADE and rename
-- the stage atomically so prepared plans cannot keep reading the old snapshot.

do $migration$
declare
  v_current regclass := to_regclass('reporting.public_traffic_effective');
  v_has_aircraft_type boolean;
  v_current_rows bigint;
  v_stage_rows bigint;
  v_rollback_rows bigint;
begin
  if v_current is null then
    raise exception 'reporting.public_traffic_effective must exist before aircraft-type snapshot migration';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_attribute attributes
    where attributes.attrelid = v_current
      and attributes.attname = 'aircraft_type'
      and attributes.attnum > 0
      and not attributes.attisdropped
  ) into v_has_aircraft_type;

  if v_has_aircraft_type then
    return;
  end if;

  if to_regclass('reporting.public_traffic_effective_aircraft_stage') is not null then
    raise exception 'reporting.public_traffic_effective_aircraft_stage already exists; inspect the interrupted rollout before retrying';
  end if;
  if to_regclass('reporting.public_traffic_effective_pre_aircraft_type') is not null then
    raise exception 'reporting.public_traffic_effective_pre_aircraft_type already exists while the live snapshot lacks aircraft_type';
  end if;

  -- Two independently populated MVs plus indexes are built while the old
  -- snapshot remains readable. Bound the operation without inheriting a short
  -- interactive-session timeout.
  perform set_config('statement_timeout', '10min', true);

  select count(*)::bigint into v_current_rows
  from reporting.public_traffic_effective;

  -- This is the prior 16-column definition, not a SELECT from the live MV.
  -- Therefore it remains independently refreshable after the old canonical OID
  -- is dropped during cutover.
  execute $ddl$
    create materialized view reporting.public_traffic_effective_pre_aircraft_type as
    select
      ranked.business_leg_key,
      ranked.ops_date,
      ranked.type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.effective_route)) as route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown') as aircraft_group,
      ranked.local_minutes,
      (ranked.local_minutes + 1020) % 1440 as utc_minutes,
      ranked.scheduled_local_at,
      ranked.effective_pax as pax,
      case when ranked.effective_pax is not null then 'reported' else 'unknown' end as pax_status,
      ranked.authoritative_server_seq,
      statement_timestamp() as snapshot_refreshed_at,
      (select max(events.server_seq)::bigint from public.season_change_events events) as snapshot_source_watermark,
      (select coalesce(sum(quarantine.candidate_count), 0)::integer
        from reporting.public_traffic_duplicate_quarantine quarantine) as snapshot_quarantined_candidate_count
    from reporting.public_traffic_ranked_candidates ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join lateral (
      select aircraft_groups.name as ac_group
      from public.operational_aircraft_group_types aircraft_types
      join public.operational_aircraft_groups aircraft_groups
        on aircraft_groups.id = aircraft_types.group_id
      where upper(aircraft_types.aircraft_type) = upper(ranked.effective_aircraft)
      order by aircraft_groups.name
      limit 1
    ) groups on true
    where ranked.candidate_rank = 1
      and not (
        ranked.candidate_count > 1
        and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1)
      )
      and ranked.effective_action is distinct from 'deleted'
  $ddl$;

  execute 'alter materialized view reporting.public_traffic_effective_pre_aircraft_type owner to postgres';
  execute 'revoke all on reporting.public_traffic_effective_pre_aircraft_type from public, anon, authenticated, service_role';
  execute 'create unique index public_traffic_effective_pre_ac_business_leg_idx on reporting.public_traffic_effective_pre_aircraft_type (business_leg_key)';
  execute 'create index public_traffic_effective_pre_ac_ops_date_idx on reporting.public_traffic_effective_pre_aircraft_type (ops_date)';
  execute 'create index public_traffic_effective_pre_ac_airline_ops_idx on reporting.public_traffic_effective_pre_aircraft_type (airline, ops_date)';
  execute 'create index public_traffic_effective_pre_ac_route_ops_idx on reporting.public_traffic_effective_pre_aircraft_type (route, ops_date)';
  execute 'create index public_traffic_effective_pre_ac_country_ops_idx on reporting.public_traffic_effective_pre_aircraft_type (country, ops_date)';
  execute 'create index public_traffic_effective_pre_ac_aircraft_group_ops_idx on reporting.public_traffic_effective_pre_aircraft_type (aircraft_group, ops_date)';
  execute 'analyze reporting.public_traffic_effective_pre_aircraft_type';

  execute $ddl$
    create materialized view reporting.public_traffic_effective_aircraft_stage as
    select
      ranked.business_leg_key,
      ranked.ops_date,
      ranked.type,
      upper(btrim(ranked.airline)) as airline,
      upper(btrim(ranked.effective_route)) as route,
      coalesce(nullif(btrim(countries.country), ''), 'Unknown') as country,
      coalesce(nullif(btrim(groups.ac_group), ''), 'Unknown') as aircraft_group,
      coalesce(nullif(upper(btrim(ranked.effective_aircraft)), ''), 'Unknown') as aircraft_type,
      ranked.local_minutes,
      (ranked.local_minutes + 1020) % 1440 as utc_minutes,
      ranked.scheduled_local_at,
      ranked.effective_pax as pax,
      case when ranked.effective_pax is not null then 'reported' else 'unknown' end as pax_status,
      ranked.authoritative_server_seq,
      statement_timestamp() as snapshot_refreshed_at,
      (select max(events.server_seq)::bigint from public.season_change_events events) as snapshot_source_watermark,
      (select coalesce(sum(quarantine.candidate_count), 0)::integer
        from reporting.public_traffic_duplicate_quarantine quarantine) as snapshot_quarantined_candidate_count
    from reporting.public_traffic_ranked_candidates ranked
    left join public.operational_route_countries countries
      on upper(countries.route) = upper(ranked.effective_route)
    left join lateral (
      select aircraft_groups.name as ac_group
      from public.operational_aircraft_group_types aircraft_types
      join public.operational_aircraft_groups aircraft_groups
        on aircraft_groups.id = aircraft_types.group_id
      where upper(aircraft_types.aircraft_type) = upper(ranked.effective_aircraft)
      order by aircraft_groups.name
      limit 1
    ) groups on true
    where ranked.candidate_rank = 1
      and not (
        ranked.candidate_count > 1
        and (ranked.missing_recency_count > 0 or ranked.max_recency_count > 1)
      )
      and ranked.effective_action is distinct from 'deleted'
  $ddl$;

  execute 'alter materialized view reporting.public_traffic_effective_aircraft_stage owner to postgres';
  execute 'revoke all on reporting.public_traffic_effective_aircraft_stage from public, anon, authenticated, service_role';
  execute 'create unique index public_traffic_effective_stage_business_leg_idx on reporting.public_traffic_effective_aircraft_stage (business_leg_key)';
  execute 'create index public_traffic_effective_stage_ops_date_idx on reporting.public_traffic_effective_aircraft_stage (ops_date)';
  execute 'create index public_traffic_effective_stage_airline_ops_idx on reporting.public_traffic_effective_aircraft_stage (airline, ops_date)';
  execute 'create index public_traffic_effective_stage_route_ops_idx on reporting.public_traffic_effective_aircraft_stage (route, ops_date)';
  execute 'create index public_traffic_effective_stage_country_ops_idx on reporting.public_traffic_effective_aircraft_stage (country, ops_date)';
  execute 'create index public_traffic_effective_stage_aircraft_group_ops_idx on reporting.public_traffic_effective_aircraft_stage (aircraft_group, ops_date)';
  execute 'create index public_traffic_effective_stage_aircraft_type_ops_idx on reporting.public_traffic_effective_aircraft_stage (aircraft_type, ops_date)';
  execute 'analyze reporting.public_traffic_effective_aircraft_stage';

  select count(*)::bigint into v_stage_rows
  from reporting.public_traffic_effective_aircraft_stage;
  select count(*)::bigint into v_rollback_rows
  from reporting.public_traffic_effective_pre_aircraft_type;
  if v_current_rows > 0 and v_stage_rows = 0 then
    raise exception 'aircraft-type snapshot stage is unexpectedly empty while the current snapshot has % rows', v_current_rows;
  end if;
  if v_current_rows > 0 and v_rollback_rows = 0 then
    raise exception 'rollback snapshot is unexpectedly empty while the current snapshot has % rows', v_current_rows;
  end if;

  -- All objects are prepared before this short ACCESS EXCLUSIVE lock window.
  -- Abort instead of queuing report requests behind a busy relation.
  perform set_config('lock_timeout', '5s', true);
  execute 'drop materialized view reporting.public_traffic_effective';
  execute 'alter materialized view reporting.public_traffic_effective_aircraft_stage rename to public_traffic_effective';

  execute 'alter index reporting.public_traffic_effective_stage_business_leg_idx rename to public_traffic_effective_business_leg_idx';
  execute 'alter index reporting.public_traffic_effective_stage_ops_date_idx rename to public_traffic_effective_ops_date_idx';
  execute 'alter index reporting.public_traffic_effective_stage_airline_ops_idx rename to public_traffic_effective_airline_ops_idx';
  execute 'alter index reporting.public_traffic_effective_stage_route_ops_idx rename to public_traffic_effective_route_ops_idx';
  execute 'alter index reporting.public_traffic_effective_stage_country_ops_idx rename to public_traffic_effective_country_ops_idx';
  execute 'alter index reporting.public_traffic_effective_stage_aircraft_group_ops_idx rename to public_traffic_effective_aircraft_group_ops_idx';
  execute 'alter index reporting.public_traffic_effective_stage_aircraft_type_ops_idx rename to public_traffic_effective_aircraft_type_ops_idx';

  if to_regclass('reporting.public_traffic_projection_state') is not null then
    update reporting.public_traffic_projection_state state
    set status = case
        when snapshot.row_count = 0 then 'empty'
        when snapshot.snapshot_watermark is not distinct from source.source_watermark then 'fresh'
        else 'stale'
      end,
      source_data_version = (select max(seasons.data_version) from public.seasons seasons),
      source_watermark = snapshot.snapshot_watermark,
      refreshed_at = snapshot.refreshed_at,
      snapshot_rows = snapshot.row_count,
      error = case
        when snapshot.row_count = 0 then null
        when snapshot.snapshot_watermark is not distinct from source.source_watermark then null
        else 'Source advanced while the aircraft-type snapshot was being built; controlled refresh is required'
      end
    from (
      select count(*)::bigint as row_count,
        max(snapshot_source_watermark) as snapshot_watermark,
        max(snapshot_refreshed_at) as refreshed_at
      from reporting.public_traffic_effective
    ) snapshot
    cross join (
      select max(server_seq)::bigint as source_watermark
      from public.season_change_events
    ) source
    where state.projection_name = 'public_traffic_effective';
  end if;

  execute $comment$
    comment on materialized view reporting.public_traffic_effective_pre_aircraft_type
      is 'Populated 16-column rollback projection retained for the aircraft-type snapshot cutover.'
  $comment$;
end;
$migration$;

comment on materialized view reporting.public_traffic_effective
  is 'Canonical public traffic snapshot, including actual aircraft type captured atomically at refresh time.';
