-- M4.1: additive, season-independent read surface. Existing callers stay on v2.
begin;

create table public.operational_workspace_revision (
  singleton boolean primary key default true check (singleton),
  epoch uuid not null default gen_random_uuid(),
  revision bigint not null default 0 check (revision >= 0)
);
insert into public.operational_workspace_revision (singleton) values (true);
revoke all on public.operational_workspace_revision from public, anon, authenticated;

-- Transactional counter, not a sequence: rollback cannot invalidate a page and
-- a later transaction cannot publish a lower revision after an earlier page.
create function public.bump_operational_workspace_revision_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.operational_workspace_revision set revision = revision + 1 where singleton;
  return null;
end;
$$;
revoke all on function public.bump_operational_workspace_revision_v1() from public, anon, authenticated;
create trigger operational_workspace_revision_legs
  after insert or update or delete or truncate on public.operational_flight_legs
  for each statement execute function public.bump_operational_workspace_revision_v1();
create trigger operational_workspace_revision_authority
  after insert or update or delete or truncate on public.operational_day_authority
  for each statement execute function public.bump_operational_workspace_revision_v1();

-- Resource catalog edits invalidate the same page snapshot as leg edits.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'operational_checkin_counters','operational_checkin_counter_groups',
    'operational_checkin_counter_group_members','operational_checkin_counter_locks',
    'operational_checkin_counter_lock_members','operational_gate_resources',
    'operational_gate_groups','operational_gate_group_members',
    'operational_gate_locks','operational_gate_lock_members','operational_stand_gate_mappings'
  ] loop
    execute format('create trigger operational_workspace_revision_catalog after insert or update or delete or truncate on public.%I for each statement execute function public.bump_operational_workspace_revision_v1()', v_table);
  end loop;
end;
$$;

create function public.get_operational_schedule_allocation_window_v1(
  p_start_date date,
  p_end_date date,
  p_resource_type text default 'all',
  p_page_size integer default 500,
  p_after_operational_date date default null,
  p_after_scheduled_time time without time zone default null,
  p_after_leg_id uuid default null,
  p_expected_snapshot text default null
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
set statement_timeout = '8s'
as $$
declare
  v_revision bigint;
  v_token text;
  v_epoch uuid;
  v_result jsonb;
  v_resources jsonb := '{}'::jsonb;
  v_table text;
  v_rows jsonb;
begin
  if public.app_operator_has_permission('daily.read') is not true then
    raise exception 'Missing required permission: daily.read' using errcode = '42501';
  end if;
  if p_start_date is null or p_end_date is null or not isfinite(p_start_date)
     or not isfinite(p_end_date) or p_end_date < p_start_date or p_end_date - p_start_date > 365 then
    raise exception 'A finite date range of at most 366 days is required' using errcode = '22023';
  end if;
  if p_page_size is null or p_page_size not between 1 and 1000 then
    raise exception 'Page size must be between 1 and 1000' using errcode = '22023';
  end if;
  if p_resource_type is null or p_resource_type not in ('all','schedule','gate','checkin','stand','counter','carousel') then
    raise exception 'Unsupported resource type' using errcode = '22023';
  end if;
  if num_nonnulls(p_after_operational_date, p_after_scheduled_time, p_after_leg_id) not in (0, 3)
     or (p_after_leg_id is not null and p_expected_snapshot is null)
     or (p_after_operational_date is not null and p_after_operational_date not between p_start_date and p_end_date) then
    raise exception 'A complete cursor and its snapshot revision are required' using errcode = '22023';
  end if;
  select revision, epoch into strict v_revision, v_epoch from public.operational_workspace_revision where singleton;
  v_token := md5(jsonb_build_array(v_epoch, v_revision::text, p_start_date, p_end_date, p_resource_type)::text);
  if p_expected_snapshot is not null and p_expected_snapshot <> v_token then
    return jsonb_build_object('status','snapshot_changed','snapshot',jsonb_build_object('revision',v_revision::text,'token',v_token));
  end if;
  if p_resource_type in ('all','gate','checkin','counter','stand') then
    foreach v_table in array array[
      'operational_checkin_counters','operational_checkin_counter_groups',
      'operational_checkin_counter_group_members','operational_checkin_counter_locks',
      'operational_checkin_counter_lock_members','operational_gate_resources',
      'operational_gate_groups','operational_gate_group_members',
      'operational_gate_locks','operational_gate_lock_members','operational_stand_gate_mappings'
    ] loop
      if p_resource_type = 'all'
         or (p_resource_type = 'gate' and v_table like 'operational_gate_%')
         or (p_resource_type in ('gate','stand') and v_table = 'operational_stand_gate_mappings')
         or (p_resource_type in ('checkin','counter') and v_table like 'operational_checkin_%') then
        execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)), ''[]''::jsonb) from public.%I r',v_table) into v_rows;
        v_resources := v_resources || jsonb_build_object(v_table,v_rows);
      end if;
    end loop;
  end if;

  -- STABLE uses the calling statement snapshot for both revision and rows.
  -- Keep one indexed range, bounded to page size + one sentinel.
  with candidates as materialized (
    select l.* from public.operational_flight_legs l
    where l.status = 'active' and l.operational_date between p_start_date and p_end_date
      and (p_after_leg_id is null or (l.operational_date,l.scheduled_time,l.leg_id)
        > (p_after_operational_date,p_after_scheduled_time,p_after_leg_id))
    order by l.operational_date,l.scheduled_time,l.leg_id limit p_page_size + 1
  ), page as materialized (
    select * from candidates order by operational_date,scheduled_time,leg_id limit p_page_size
  ), last_row as (
    select * from page order by operational_date desc,scheduled_time desc,leg_id desc limit 1
  )
  select jsonb_build_object(
    'status','ok','startDate',p_start_date,'endDate',p_end_date,'resourceType',p_resource_type,
    'snapshot',jsonb_build_object('revision',v_revision::text,'token',v_token),
    'resources',v_resources,
    'page',jsonb_build_object('returnedCount',(select count(*) from page),
      'hasMore',(select count(*) > p_page_size from candidates),
      'nextCursor',case when (select count(*) > p_page_size from candidates) then
        (select jsonb_build_object('operationalDate',operational_date,'scheduledTime',scheduled_time,'legId',leg_id) from last_row)
        else null end),
    'legs',coalesce((select jsonb_agg(to_jsonb(p) order by operational_date,scheduled_time,leg_id) from page p),'[]'::jsonb),
    'linkedLegs',coalesce((select jsonb_agg(to_jsonb(l) order by l.leg_id) from public.operational_flight_legs l
      where l.status='active' and l.leg_id in (select linked_leg_id from page)
        and l.leg_id not in (select leg_id from page)),'[]'::jsonb),
    'authorityDays',coalesce((select jsonb_agg(to_jsonb(a) order by operational_date)
      from public.operational_day_authority a where a.operational_date between p_start_date and p_end_date and a.reset_at is null),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_operational_schedule_allocation_window_v1(date,date,text,integer,date,time,uuid,text) from public, anon;
grant execute on function public.get_operational_schedule_allocation_window_v1(date,date,text,integer,date,time,uuid,text) to authenticated;
commit;
