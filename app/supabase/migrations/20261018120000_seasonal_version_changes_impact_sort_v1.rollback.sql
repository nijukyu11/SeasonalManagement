-- Rollback: 20261018120000_seasonal_version_changes_impact_sort_v1.sql
-- Restores get_seasonal_version_changes_page_v1 exactly as defined by
-- 20261011120000_seasonal_version_changes_v1.sql (chronological group ordering).

begin;

create or replace function public.get_seasonal_version_changes_page_v1(
  p_version_id uuid,
  p_base_version_id uuid default null,
  p_view text default 'groups',
  p_after_cursor text default null,
  p_page_size integer default 50,
  p_change_type text default 'all',
  p_search text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_field text default 'all',
  p_group_key text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_version public.seasonal_publish_versions%rowtype;
  v_snapshot public.seasonal_publish_snapshots%rowtype;
  v_base_version public.seasonal_publish_versions%rowtype;
  v_base_snapshot public.seasonal_publish_snapshots%rowtype;
  v_base_version_id uuid;
  v_is_same_version boolean := false;
  v_matches_stored boolean := false;
  v_cache_completed boolean := false;
  v_run_id uuid;
  v_view text;
  v_change_type text;
  v_field text;
  v_after_cursor_seq bigint := 0;
  v_base_version_meta jsonb := null;
  v_version_meta jsonb;
  v_result jsonb;
begin
  -- 1. Security check
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  -- 2. Parameter validation
  if p_version_id is null then
    raise exception 'Version ID required' using errcode = '22023';
  end if;

  if p_page_size is null or p_page_size not between 1 and 500 then
    raise exception 'Invalid diff page size' using errcode = '22023';
  end if;

  v_view := coalesce(nullif(btrim(p_view), ''), 'groups');
  if v_view not in ('groups', 'days') then
    raise exception 'Invalid view: must be groups or days' using errcode = '22023';
  end if;

  v_change_type := coalesce(nullif(btrim(p_change_type), ''), 'all');
  if v_change_type not in ('all', 'added', 'removed', 'modified') then
    raise exception 'Invalid change_type' using errcode = '22023';
  end if;

  v_field := coalesce(nullif(btrim(p_field), ''), 'all');
  if v_field not in ('all', 'time', 'route', 'aircraft', 'other') then
    raise exception 'Invalid field filter' using errcode = '22023';
  end if;

  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'p_date_from must not exceed p_date_to' using errcode = '22023';
  end if;

  if p_after_cursor is not null and p_after_cursor ~ '^\d+$' then
    v_after_cursor_seq := p_after_cursor::bigint;
  else
    v_after_cursor_seq := 0;
  end if;

  -- 3. Version resolution & validation
  select * into v_version from public.seasonal_publish_versions where version_id = p_version_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;

  select * into v_snapshot from public.seasonal_publish_snapshots where version_id = p_version_id;
  if not found then
    raise exception 'Snapshot not found' using errcode = 'P0002';
  end if;

  v_version_meta := jsonb_build_object(
    'versionId', v_version.version_id::text,
    'versionTag', v_version.version_tag,
    'publishedAt', v_version.published_at,
    'notes', coalesce(v_version.publish_notes, '')
  );

  -- Resolve base prior version using publish_sequence if not explicitly provided
  if p_base_version_id is null then
    select version_id into v_base_version_id
    from public.seasonal_publish_versions
    where season_id = v_version.season_id
      and publish_sequence < v_version.publish_sequence
    order by publish_sequence desc
    limit 1;

    if v_base_version_id is not null then
      select * into v_base_version from public.seasonal_publish_versions where version_id = v_base_version_id;
      select * into v_base_snapshot from public.seasonal_publish_snapshots where version_id = v_base_version_id;
    end if;
  else
    if p_base_version_id = p_version_id then
      v_is_same_version := true;
      v_base_version_id := p_base_version_id;
      v_base_version := v_version;
      v_base_snapshot := v_snapshot;
    else
      select * into v_base_version from public.seasonal_publish_versions where version_id = p_base_version_id;
      if not found then
        raise exception 'Base version not found' using errcode = 'P0002';
      end if;

      if v_base_version.season_id <> v_version.season_id then
        raise exception 'Cannot compare versions across different seasons' using errcode = '22023';
      end if;

      v_base_version_id := p_base_version_id;
      select * into v_base_snapshot from public.seasonal_publish_snapshots where version_id = v_base_version_id;
      if not found then
        raise exception 'Base snapshot not found' using errcode = 'P0002';
      end if;
    end if;
  end if;

  if v_base_version.version_id is not null then
    v_base_version_meta := jsonb_build_object(
      'versionId', v_base_version.version_id::text,
      'versionTag', v_base_version.version_tag,
      'publishedAt', v_base_version.published_at,
      'notes', coalesce(v_base_version.publish_notes, '')
    );
  else
    v_base_version_meta := null;
  end if;

  -- 4. Fast path: Explicit same version yields zero changes
  if v_is_same_version then
    return jsonb_build_object(
      'entries', '[]'::jsonb,
      'hasMore', false,
      'nextCursor', null,
      'summary', jsonb_build_object(
        'added', 0,
        'removed', 0,
        'modified', 0,
        'unchanged', coalesce(v_version.total_flight_count, 0),
        'totalChanges', 0
      ),
      'totalRows', 0,
      'filteredOccurrenceCount', 0,
      'baseVersion', v_base_version_meta,
      'version', v_version_meta
    );
  end if;

  -- 5. Prepare comparison cache using existing comparison RPC (single-sourced, no duplicated code)
  select exists (
    select 1
    from public.seasonal_publish_diff_entries
    where version_id = p_version_id
      and (base_version_id is not distinct from v_base_version_id)
  ) into v_matches_stored;

  if not v_matches_stored then
    select exists (
      select 1
      from public.seasonal_publish_diff_cache_runs
      where season_id = v_version.season_id
        and (base_version_id is not distinct from v_base_version_id)
        and version_id = p_version_id
        and algorithm_version = 1
        and status = 'completed'
    ) into v_cache_completed;

    if not v_cache_completed then
      -- Reuse existing comparison RPC to initialize cache run & entries atomically
      perform public.get_seasonal_version_comparison_page_v1(v_base_version_id, p_version_id, 0, 1);
    end if;

    select run_id into v_run_id
    from public.seasonal_publish_diff_cache_runs
    where season_id = v_version.season_id
      and (base_version_id is not distinct from v_base_version_id)
      and version_id = p_version_id
      and algorithm_version = 1
      and status = 'completed';
  end if;

  -- 6. Single factored materialized CTE pipeline with unified presentation union (no temp tables/DDL)
  with raw_stream as materialized (
    select
      diff_id, entry_index, change_type, flight_key, source_draft_id,
      operational_date, side, airline, flight_number, before_state, after_state, changed_fields
    from public.seasonal_publish_diff_entries
    where v_matches_stored
      and version_id = p_version_id
      and (base_version_id is not distinct from v_base_version_id)

    union all

    select
      diff_id, entry_index, change_type, flight_key, source_draft_id,
      operational_date, side, airline, flight_number, before_state, after_state, changed_fields
    from public.seasonal_publish_diff_cache_entries
    where not v_matches_stored
      and v_run_id is not null
      and run_id = v_run_id

    union all

    select
      gen_random_uuid() as diff_id,
      row_number() over (order by operational_date, side, flight_number, source_draft_id) as entry_index,
      change_type, flight_key, source_draft_id,
      operational_date, side, airline, flight_number, before_state, after_state, changed_fields
    from public.seasonal_planning_diff_v1(
      coalesce(v_base_snapshot.snapshot_payload, '{}'::jsonb),
      v_snapshot.snapshot_payload
    )
    where not v_matches_stored
      and v_run_id is null
      and change_type in ('added', 'modified', 'removed')
  ),
  pair_summary as (
    select
      coalesce(count(*) filter (where change_type = 'added'), 0)::integer as full_added,
      coalesce(count(*) filter (where change_type = 'removed'), 0)::integer as full_removed,
      coalesce(count(*) filter (where change_type = 'modified'), 0)::integer as full_modified
    from raw_stream
  ),
  normalized as (
    select
      s.*,
      public.internal_seasonal_normalize_business_state_v1(s.before_state) as norm_before,
      public.internal_seasonal_normalize_business_state_v1(s.after_state) as norm_after,
      coalesce(nullif(s.before_state->>'scheduledDate', ''), nullif(s.before_state->>'scheduled_date', ''), nullif(s.before_state->>'date', ''), nullif(s.before_state->>'operationalDate', ''), nullif(s.before_state->>'operational_date', '')) as b_date,
      coalesce(nullif(s.after_state->>'scheduledDate', ''), nullif(s.after_state->>'scheduled_date', ''), nullif(s.after_state->>'date', ''), nullif(s.after_state->>'operationalDate', ''), nullif(s.after_state->>'operational_date', '')) as a_date
    from raw_stream s
  ),
  annotated as (
    select
      n.*,
      case
        when n.change_type = 'modified' and n.b_date is distinct from n.a_date and n.b_date is not null and n.a_date is not null
        then n.b_date || '->' || n.a_date
        else null
      end as date_shift,
      n.change_type || ':' || upper(btrim(coalesce(n.airline, ''))) || ':' || upper(btrim(coalesce(n.flight_number, ''))) || ':' || coalesce(n.side, '') || ':' ||
        md5(
          jsonb_build_object(
            'b', n.norm_before,
            'a', n.norm_after,
            'ds', case
              when n.change_type = 'modified' and n.b_date is distinct from n.a_date and n.b_date is not null and n.a_date is not null
              then n.b_date || '->' || n.a_date
              else null
            end
          )::text
        ) as group_key,
      -- Real business value difference testing
      (
        (n.norm_before->'schedule' is distinct from n.norm_after->'schedule')
        or (n.change_type = 'modified' and n.b_date is distinct from n.a_date and n.b_date is not null and n.a_date is not null)
        or (n.change_type in ('added', 'removed') and coalesce(n.norm_after->'schedule', n.norm_before->'schedule') is not null)
      ) as diff_time,
      (
        (n.norm_before->'route' is distinct from n.norm_after->'route')
        or (n.change_type in ('added', 'removed') and coalesce(n.norm_after->'route', n.norm_before->'route') is not null)
      ) as diff_route,
      (
        (n.norm_before->'aircraft' is distinct from n.norm_after->'aircraft')
        or (n.change_type in ('added', 'removed') and coalesce(n.norm_after->'aircraft', n.norm_before->'aircraft') is not null)
      ) as diff_aircraft,
      (
        (n.norm_before->'airline' is distinct from n.norm_after->'airline')
        or (n.norm_before->'flight_number' is distinct from n.norm_after->'flight_number')
        or (n.norm_before->'type' is distinct from n.norm_after->'type')
        or (n.norm_before->'category' is distinct from n.norm_after->'category')
        or (n.norm_before->'flight_type' is distinct from n.norm_after->'flight_type')
        or (n.norm_before->'int_dom_ind' is distinct from n.norm_after->'int_dom_ind')
        or (n.norm_before->'pax' is distinct from n.norm_after->'pax')
        or (n.norm_before->'gate' is distinct from n.norm_after->'gate')
        or (n.norm_before->'stand' is distinct from n.norm_after->'stand')
        or (n.norm_before->'carousel' is distinct from n.norm_after->'carousel')
        or (n.norm_before->'link_type' is distinct from n.norm_after->'link_type')
        or (n.norm_before->'code_shares' is distinct from n.norm_after->'code_shares')
        or (n.norm_before->'counters' is distinct from n.norm_after->'counters')
        or (n.norm_before->'checkin_windows' is distinct from n.norm_after->'checkin_windows')
        or (n.change_type in ('added', 'removed') and (
          coalesce(n.norm_after->'airline', n.norm_before->'airline') is not null or
          coalesce(n.norm_after->'flight_number', n.norm_before->'flight_number') is not null or
          coalesce(n.norm_after->'pax', n.norm_before->'pax') is not null or
          coalesce(n.norm_after->'gate', n.norm_before->'gate') is not null or
          coalesce(n.norm_after->'stand', n.norm_before->'stand') is not null or
          coalesce(n.norm_after->'carousel', n.norm_before->'carousel') is not null or
          coalesce(n.norm_after->'counters', n.norm_before->'counters') is not null or
          coalesce(n.norm_after->'checkin_windows', n.norm_before->'checkin_windows') is not null
        ))
      ) as diff_other
    from normalized n
  ),
  filtered as (
    select a.*
    from annotated a
    where (v_change_type = 'all' or a.change_type = v_change_type)
      and (p_date_from is null or a.operational_date >= p_date_from)
      and (p_date_to is null or a.operational_date <= p_date_to)
      and (p_group_key is null or btrim(p_group_key) = '' or a.group_key = btrim(p_group_key))
      and (
        p_search is null or btrim(p_search) = ''
        or a.airline ilike '%' || btrim(p_search) || '%'
        or a.flight_number ilike '%' || btrim(p_search) || '%'
        or coalesce(a.before_state->>'route', '') ilike '%' || btrim(p_search) || '%'
        or coalesce(a.after_state->>'route', '') ilike '%' || btrim(p_search) || '%'
        or a.flight_key ilike '%' || btrim(p_search) || '%'
      )
      and (
        v_field = 'all'
        or (v_field = 'time' and a.diff_time)
        or (v_field = 'route' and a.diff_route)
        or (v_field = 'aircraft' and a.diff_aircraft)
        or (v_field = 'other' and a.diff_other)
      )
  ),
  grouped_aggregates as (
    select
      g.group_key,
      g.change_type,
      g.side,
      g.airline,
      g.flight_number,
      min(g.operational_date) as operational_date,
      count(*)::integer as occurrence_count,
      array_agg(distinct g.operational_date::text order by g.operational_date::text) as dates
    from filtered g
    where v_view = 'groups'
    group by g.group_key, g.change_type, g.side, g.airline, g.flight_number
  ),
  group_representatives as (
    select distinct on (g.group_key)
      g.group_key,
      g.diff_id,
      g.flight_key,
      g.source_draft_id,
      g.before_state,
      g.after_state,
      g.changed_fields
    from filtered g
    where v_view = 'groups'
    order by g.group_key, g.operational_date, g.entry_index
  ),
  grouped_rows as (
    select
      a.group_key,
      a.change_type,
      a.side,
      a.airline,
      a.flight_number,
      a.operational_date,
      a.occurrence_count,
      a.dates,
      r.flight_key,
      r.source_draft_id,
      r.diff_id,
      r.before_state,
      r.after_state,
      r.changed_fields
    from grouped_aggregates a
    join group_representatives r using (group_key)
  ),
  view_rows as (
    select
      group_key, change_type, side, airline, flight_number, operational_date,
      occurrence_count, dates, flight_key, source_draft_id, diff_id,
      before_state, after_state, changed_fields
    from grouped_rows

    union all

    select
      d.group_key,
      d.change_type,
      d.side,
      d.airline,
      d.flight_number,
      d.operational_date,
      1::integer as occurrence_count,
      array[d.operational_date::text] as dates,
      d.flight_key,
      d.source_draft_id,
      d.diff_id,
      d.before_state,
      d.after_state,
      d.changed_fields
    from filtered d
    where v_view = 'days'
  ),
  ordered_rows as (
    select
      row_number() over (
        order by
          operational_date asc,
          side asc,
          airline asc,
          flight_number asc,
          change_type asc,
          group_key asc,
          source_draft_id asc
      ) as seq,
      *
    from view_rows
  ),
  totals as (
    select
      count(*)::integer as total_rows,
      coalesce(sum(occurrence_count), 0)::integer as total_occurrences
    from ordered_rows
  ),
  paged_slice as (
    select *
    from ordered_rows
    where seq > v_after_cursor_seq
    order by seq
    limit p_page_size + 1
  ),
  page as (
    select *
    from paged_slice
    order by seq
    limit p_page_size
  )
  select jsonb_build_object(
    'entries', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'group_key', p.group_key,
            'dates', to_jsonb(p.dates),
            'occurrence_count', p.occurrence_count,
            'diff_id', p.diff_id::text,
            'entry_index', p.seq::text,
            'version_id', p_version_id::text,
            'base_version_id', case when v_base_version_id is not null then v_base_version_id::text else null end,
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
            'changed_fields', to_jsonb(coalesce(p.changed_fields, array[]::text[]))
          )
          order by p.seq
        )
        from page p
      ),
      '[]'::jsonb
    ),
    'hasMore', ((select count(*) from paged_slice) > p_page_size),
    'nextCursor', (
      select case
        when (select count(*) from paged_slice) > p_page_size
        then max(p.seq)::text
        else null
      end
      from page p
    ),
    'summary', (
      select jsonb_build_object(
        'added', s.full_added,
        'removed', s.full_removed,
        'modified', s.full_modified,
        'unchanged', greatest(0, coalesce(v_version.total_flight_count, 0) - s.full_added - s.full_modified),
        'totalChanges', s.full_added + s.full_removed + s.full_modified
      )
      from pair_summary s
    ),
    'totalRows', coalesce((select total_rows from totals), 0),
    'filteredOccurrenceCount', coalesce((select total_occurrences from totals), 0),
    'baseVersion', v_base_version_meta,
    'version', v_version_meta
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_seasonal_version_changes_page_v1(uuid, uuid, text, text, integer, text, text, date, date, text, text) from public, anon, authenticated;
grant execute on function public.get_seasonal_version_changes_page_v1(uuid, uuid, text, text, integer, text, text, date, date, text, text) to authenticated;

commit;
