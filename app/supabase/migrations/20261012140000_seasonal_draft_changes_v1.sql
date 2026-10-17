-- ============================================================================
-- Migration: 20261012140000_seasonal_draft_changes_v1.sql
-- Description: Authoritative read-only Draft comparison RPC for Planning Dashboard.
-- Reuses seasonal_planning_snapshot_v1 and seasonal_planning_diff_v1 with the exact
-- unified presentation and grouping pipeline from seasonal_version_changes_v1.
-- ============================================================================

begin;

create or replace function public.get_seasonal_draft_changes_page_v1(
  p_season_id text,
  p_base_version_id uuid default null,
  p_view text default 'groups',
  p_after_cursor text default null,
  p_page_size integer default 50,
  p_change_type text default 'all',
  p_search text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_field text default 'all',
  p_group_key text default null,
  p_expected_epoch text default null,
  p_expected_revision bigint default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_season public.seasons%rowtype;
  v_workspace public.seasonal_draft_workspace%rowtype;
  v_base_version public.seasonal_publish_versions%rowtype;
  v_base_snapshot public.seasonal_publish_snapshots%rowtype;
  v_base_version_id uuid;
  v_draft_snapshot jsonb;
  v_view text;
  v_change_type text;
  v_field text;
  v_after_cursor_seq bigint := 0;
  v_base_version_meta jsonb := null;
  v_draft_meta jsonb;
  v_result jsonb;
begin
  -- 1. Security check
  if auth.uid() is null or public.app_operator_has_permission('seasonal.read') is not true then
    raise exception 'seasonal.read permission required' using errcode = '42501';
  end if;

  -- 2. Parameter validation
  if p_season_id is null or btrim(p_season_id) = '' then
    raise exception 'Season ID required' using errcode = '22023';
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

  -- 3. Season & Draft workspace resolution
  select * into v_season from public.seasons where id = p_season_id;
  if not found then
    raise exception 'Season not found' using errcode = 'P0002';
  end if;

  select * into v_workspace from public.seasonal_draft_workspace where season_id = p_season_id;
  if not found then
    raise exception 'Draft workspace not found for season %', p_season_id using errcode = 'P0002';
  end if;

  -- Epoch / Revision Fence Check:
  if p_expected_epoch is not null and btrim(p_expected_epoch) <> '' then
    if v_workspace.epoch::text <> btrim(p_expected_epoch) then
      raise exception 'snapshot_changed: draft epoch conflict (expected %, current %)', p_expected_epoch, v_workspace.epoch::text using errcode = '40001';
    end if;
  end if;

  if p_expected_revision is not null then
    if v_workspace.revision <> p_expected_revision then
      raise exception 'snapshot_changed: draft revision conflict (expected %, current %)', p_expected_revision, v_workspace.revision using errcode = '40001';
    end if;
  end if;

  v_draft_meta := jsonb_build_object(
    'versionId', 'draft',
    'versionTag', 'Draft',
    'epoch', v_workspace.epoch::text,
    'revision', v_workspace.revision::text,
    'publishedAt', null,
    'notes', 'Bản kế hoạch hiện tại (Draft)'
  );
  -- Resolve base prior version: if p_base_version_id is null, find latest published version
  if p_base_version_id is null then
    select version_id into v_base_version_id
    from public.seasonal_publish_versions
    where season_id = p_season_id
    order by publish_sequence desc
    limit 1;

    if v_base_version_id is not null then
      select * into v_base_version from public.seasonal_publish_versions where version_id = v_base_version_id;
      select * into v_base_snapshot from public.seasonal_publish_snapshots where version_id = v_base_version_id;
    end if;
  else
    select * into v_base_version from public.seasonal_publish_versions where version_id = p_base_version_id;
    if not found then
      raise exception 'Base version not found' using errcode = 'P0002';
    end if;

    if v_base_version.season_id <> p_season_id then
      raise exception 'Cannot compare versions across different seasons' using errcode = '22023';
    end if;

    v_base_version_id := p_base_version_id;
    select * into v_base_snapshot from public.seasonal_publish_snapshots where version_id = v_base_version_id;
    if not found then
      raise exception 'Base snapshot not found' using errcode = 'P0002';
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

  -- 4. Build live draft snapshot payload (pure read, no side effect)
  v_draft_snapshot := public.seasonal_planning_snapshot_v1(p_season_id);

  -- 5. Execute authoritative single factored CTE pipeline reusing normalization & presentation
  with raw_stream as materialized (
    select
      gen_random_uuid() as diff_id,
      row_number() over (order by operational_date, side, flight_number, source_draft_id) as entry_index,
      change_type, flight_key, source_draft_id,
      operational_date, side, airline, flight_number, before_state, after_state, changed_fields
    from public.seasonal_planning_diff_v1(
      coalesce(v_base_snapshot.snapshot_payload, '{}'::jsonb),
      v_draft_snapshot
    )
  ),
  pair_summary as (
    select
      coalesce(count(*) filter (where change_type = 'added'), 0)::integer as full_added,
      coalesce(count(*) filter (where change_type = 'removed'), 0)::integer as full_removed,
      coalesce(count(*) filter (where change_type = 'modified'), 0)::integer as full_modified,
      coalesce(count(*) filter (where change_type = 'unchanged'), 0)::integer as full_unchanged
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
    where s.change_type in ('added', 'modified', 'removed')
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
      r.diff_id,
      r.flight_key,
      r.source_draft_id,
      r.before_state,
      r.after_state,
      r.changed_fields
    from grouped_aggregates a
    join group_representatives r using (group_key)
  ),
  day_rows as (
    select
      f.group_key,
      f.change_type,
      f.side,
      f.airline,
      f.flight_number,
      f.operational_date,
      1::integer as occurrence_count,
      array[f.operational_date::text] as dates,
      f.diff_id,
      f.flight_key,
      f.source_draft_id,
      f.before_state,
      f.after_state,
      f.changed_fields
    from filtered f
    where v_view = 'days'
  ),
  ordered_rows as (
    select
      row_number() over (
        order by
          u.operational_date asc,
          u.airline asc,
          u.flight_number asc,
          u.side asc,
          u.group_key asc,
          u.source_draft_id asc
      ) as seq_idx,
      u.*
    from (
      select * from grouped_rows
      union all
      select * from day_rows
    ) u
  ),
  totals as (
    select
      coalesce(max(seq_idx), 0)::integer as total_rows,
      coalesce(sum(occurrence_count), 0)::integer as total_occurrences
    from ordered_rows
  ),
  paged_slice as (
    select o.*
    from ordered_rows o
    where o.seq_idx > v_after_cursor_seq
    order by o.seq_idx asc
    limit p_page_size + 1
  )
  select jsonb_build_object(
    'entries', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'diff_id', p.diff_id::text,
            'entry_index', p.seq_idx::text,
            'version_id', 'draft',
            'base_version_id', case when v_base_version_id is not null then v_base_version_id::text else null end,
            'season_id', p_season_id,
            'change_type', p.change_type,
            'flight_key', p.flight_key,
            'source_draft_id', p.source_draft_id,
            'operational_date', p.operational_date::text,
            'side', p.side,
            'airline', p.airline,
            'flight_number', p.flight_number,
            'before_state', p.before_state,
            'after_state', p.after_state,
            'changed_fields', to_jsonb(coalesce(p.changed_fields, array[]::text[])),
            'group_key', p.group_key,
            'dates', to_jsonb(p.dates),
            'occurrence_count', p.occurrence_count
          )
          order by p.seq_idx asc
        )
        from (
          select * from paged_slice limit p_page_size
        ) p
      ),
      '[]'::jsonb
    ),
    'hasMore', (select count(*) > p_page_size from paged_slice),
    'nextCursor', (
      select case
        when count(*) > p_page_size then
          (select seq_idx::text from paged_slice limit p_page_size offset p_page_size - 1)
        else null
      end
      from paged_slice
    ),
    'summary', (
      select jsonb_build_object(
        'added', s.full_added,
        'removed', s.full_removed,
        'modified', s.full_modified,
        'unchanged', s.full_unchanged,
        'totalChanges', s.full_added + s.full_removed + s.full_modified
      )
      from pair_summary s
    ),
    'totalRows', (select total_rows from totals),
    'filteredOccurrenceCount', (select total_occurrences from totals),
    'draftEpoch', v_workspace.epoch::text,
    'draftRevision', v_workspace.revision::text,
    'baseVersionId', case when v_base_version_id is not null then v_base_version_id::text else null end,
    'baseVersion', v_base_version_meta,
    'version', v_draft_meta
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_seasonal_draft_changes_page_v1(text, uuid, text, text, integer, text, text, date, date, text, text, text, bigint) from public, anon;
grant execute on function public.get_seasonal_draft_changes_page_v1(text, uuid, text, text, integer, text, text, date, date, text, text, text, bigint) to authenticated;

commit;
