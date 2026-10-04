-- M4.1 read-only cutback: retains all legs, authority, and resource data.
begin;
do $$
begin
  if to_regclass('public.operational_mutation_receipts') is not null then
    raise exception 'Rollback M4 mutations before the operational window revision';
  end if;
end;
$$;
drop function public.get_operational_schedule_allocation_window_v1(date,date,text,integer,date,time,uuid,text);
drop trigger operational_workspace_revision_legs on public.operational_flight_legs;
drop trigger operational_workspace_revision_authority on public.operational_day_authority;
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
    execute format('drop trigger operational_workspace_revision_catalog on public.%I',v_table);
  end loop;
end;
$$;
drop function public.bump_operational_workspace_revision_v1();
-- Derived invalidation counter only; no business data or receipts live here.
drop table public.operational_workspace_revision;
commit;
