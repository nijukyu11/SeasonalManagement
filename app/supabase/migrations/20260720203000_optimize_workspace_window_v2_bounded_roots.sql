do $migration$
declare
  function_oid regprocedure := 'public.get_season_schedule_allocation_window_v2(text,text,text,text,integer,text,text,smallint,integer,bigint)'::regprocedure;
  function_definition text;
  old_fragment text := $old$
  with root_candidates as materialized (
    select
      coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') as effective_date,
      r.record_id as root_id,
      0::smallint as root_kind
    from public.season_flight_records r
    where r.season_id = p_season_id
      and (p_start_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') >= p_start_date)
      and (p_end_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') <= p_end_date)

    union all

    select
      coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') as effective_date,
      a.leg_id as root_id,
      1::smallint as root_kind
    from public.season_modification_added_legs a
    where a.season_id = p_season_id
      and (p_start_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') >= p_start_date)
      and (p_end_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') <= p_end_date)
  ),
  page_with_sentinel as materialized (
    select roots.*
    from root_candidates roots
    where p_after_root_id is null
       or (roots.effective_date, roots.root_id, roots.root_kind)
          > (p_after_effective_date, p_after_root_id, p_after_root_kind)
    order by roots.effective_date, roots.root_id, roots.root_kind
    limit p_page_size + 1
  ),
$old$;
  new_fragment text := $new$
  with root_candidates as materialized (
    -- bounded_root_candidates_v2: each indexed branch is limited before the bounded merge.
    select roots.*
    from (
      (
        select
          coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') as effective_date,
          r.record_id as root_id,
          0::smallint as root_kind
        from public.season_flight_records r
        where r.season_id = p_season_id
          and (p_start_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') >= p_start_date)
          and (p_end_date is null or coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), '') <= p_end_date)
          and (p_after_root_id is null
            or (
              coalesce(nullif(r.operational_date, ''), nullif(r.scheduled_date, ''), nullif(r.date, ''), ''),
              r.record_id,
              0::smallint
            ) > (p_after_effective_date, p_after_root_id, p_after_root_kind))
        order by effective_date, root_id
        limit p_page_size + 1
      )

      union all

      (
        select
          coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') as effective_date,
          a.leg_id as root_id,
          1::smallint as root_kind
        from public.season_modification_added_legs a
        where a.season_id = p_season_id
          and (p_start_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') >= p_start_date)
          and (p_end_date is null or coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), '') <= p_end_date)
          and (p_after_root_id is null
            or (
              coalesce(nullif(a.operational_date, ''), nullif(a.scheduled_date, ''), nullif(a.date, ''), ''),
              a.leg_id,
              1::smallint
            ) > (p_after_effective_date, p_after_root_id, p_after_root_kind))
        order by effective_date, root_id
        limit p_page_size + 1
      )
    ) roots
    order by roots.effective_date, roots.root_id, roots.root_kind
    limit p_page_size + 1
  ),
  page_with_sentinel as materialized (
    select roots.*
    from root_candidates roots
    order by roots.effective_date, roots.root_id, roots.root_kind
  ),
$new$;
begin
  select pg_get_functiondef(function_oid)
  into function_definition;

  if position('bounded_root_candidates_v2' in function_definition) > 0 then
    return;
  end if;

  if position(old_fragment in function_definition) = 0 then
    raise exception 'Workspace window V2 definition did not match the reviewed unbounded root fragment';
  end if;

  function_definition := replace(function_definition, old_fragment, new_fragment);

  if position('bounded_root_candidates_v2' in function_definition) = 0
     or position(old_fragment in function_definition) > 0 then
    raise exception 'Workspace window V2 bounded-root replacement was incomplete';
  end if;

  execute function_definition;
end
$migration$;

notify pgrst, 'reload schema';
