begin;

do $$
declare
  v_table text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'season_source_rows' and column_name = 'arr_flight_type'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'season_source_rows' and column_name = 'dep_flight_type'
  ) then
    raise exception 'source provenance flight type columns are missing';
  end if;

  foreach v_table in array array[
    'seasons',
    'season_source_rows',
    'season_source_row_days',
    'season_flight_records',
    'season_flight_record_counters',
    'season_flight_record_checkin_windows',
    'season_change_events',
    'season_entity_versions'
  ] loop
    if not pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'SELECT')
      or pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
      or pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
      or pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'DELETE')
    then
      raise exception 'baseline table % is not authenticated SELECT-only', v_table;
    end if;
  end loop;

  foreach v_table in array array[
    'season_modifications',
    'season_modification_counters',
    'season_modification_checkin_windows',
    'season_modification_added_legs',
    'season_mod_history_entries',
    'season_mod_history_changes',
    'season_mod_history_record_changes'
  ] loop
    if not pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'SELECT')
      or not pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
      or not pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
      or not pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'DELETE')
    then
      raise exception 'overlay table % is missing RLS-gated DML grants', v_table;
    end if;
  end loop;

  if pg_catalog.has_table_privilege('authenticated', 'public.season_import_batches', 'SELECT')
    or pg_catalog.has_table_privilege('authenticated', 'public.season_import_batch_rows', 'SELECT')
  then
    raise exception 'client roles can read internal import staging data';
  end if;

  if not pg_catalog.has_function_privilege(
    'authenticated',
    'public.resume_seasonal_import_v2(uuid,integer)',
    'EXECUTE'
  ) then
    raise exception 'authenticated recovery RPC execute grant is missing';
  end if;
end
$$;

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'viewer@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'seasonal@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'detailed@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'daily@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'checkin@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'gate@example.invalid', '', now(), '{}', '{}', now(), now()),
  ('10000000-0000-0000-0000-000000000007', 'authenticated', 'authenticated', 'repair@example.invalid', '', now(), '{}', '{}', now(), now());

insert into public.app_operators (user_id, email, username, display_name)
values
  ('10000000-0000-0000-0000-000000000001', 'viewer@example.invalid', 'quality_viewer', 'Quality Viewer'),
  ('10000000-0000-0000-0000-000000000002', 'seasonal@example.invalid', 'quality_seasonal', 'Quality Seasonal'),
  ('10000000-0000-0000-0000-000000000003', 'detailed@example.invalid', 'quality_detailed', 'Quality Detailed'),
  ('10000000-0000-0000-0000-000000000004', 'daily@example.invalid', 'quality_daily', 'Quality Daily'),
  ('10000000-0000-0000-0000-000000000005', 'checkin@example.invalid', 'quality_checkin', 'Quality Check-in'),
  ('10000000-0000-0000-0000-000000000006', 'gate@example.invalid', 'quality_gate', 'Quality Gate'),
  ('10000000-0000-0000-0000-000000000007', 'repair@example.invalid', 'quality_repair', 'Quality Repair');

insert into public.app_operator_permission_overrides (user_id, permission_key, effect)
select users.user_id, permissions.permission_key, 'allow'
from (
  values
    ('10000000-0000-0000-0000-000000000001'::uuid, null::text),
    ('10000000-0000-0000-0000-000000000002'::uuid, 'seasonal.write'),
    ('10000000-0000-0000-0000-000000000003'::uuid, 'detailed.write'),
    ('10000000-0000-0000-0000-000000000004'::uuid, 'daily.write'),
    ('10000000-0000-0000-0000-000000000005'::uuid, 'checkin.write'),
    ('10000000-0000-0000-0000-000000000006'::uuid, 'gate.write'),
    ('10000000-0000-0000-0000-000000000007'::uuid, 'season.repair')
) users(user_id, write_permission)
cross join lateral (
  values ('seasonal.read'::text), (users.write_permission)
) permissions(permission_key)
where permissions.permission_key is not null;

insert into public.seasons (
  id, season_code, name, file_name, uploaded_at, effective_start,
  effective_end, total_legs, total_source_rows, data_version
)
values
  ('quality-season', 'Q26', 'Quality', '', 0, '', '', 0, 0, 0),
  ('quality-repair-delete', 'Q27', 'Repair Delete', '', 0, '', '', 0, 0, 0);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
do $$
begin
  begin
    insert into public.season_modifications (season_id, leg_id, action)
    values ('quality-season', 'viewer-direct-overlay', 'modified');
    raise exception 'viewer direct overlay DML was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.season_source_rows (season_id, row_index)
    values ('quality-season', 9001);
    raise exception 'viewer direct baseline DML was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.manage_season_metadata_v2('create', 'viewer-season', '{}'::jsonb);
    raise exception 'viewer created season metadata through RPC';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
insert into public.season_modifications (season_id, leg_id, action)
values ('quality-season', 'seasonal-overlay', 'added');
insert into public.season_modification_added_legs (
  season_id, leg_id, record_id, type, airline, flight_number, raw_flight_number,
  date, source_kind, source_side, status
) values (
  'quality-season', 'seasonal-overlay', 'seasonal-overlay', 'D', 'VN', 'VN101', '101',
  '2026-01-01', 'added', 'DEP', 'active'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
insert into public.season_modifications (season_id, leg_id, action)
values ('quality-season', 'detailed-overlay', 'added');
insert into public.season_modification_added_legs (
  season_id, leg_id, record_id, type, airline, flight_number, raw_flight_number,
  date, source_kind, source_side, status
) values (
  'quality-season', 'detailed-overlay', 'detailed-overlay', 'D', 'VN', 'VN102', '102',
  '2026-01-02', 'added', 'DEP', 'active'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
insert into public.season_modifications (season_id, leg_id, action)
values ('quality-season', 'daily-overlay', 'added');
insert into public.season_modification_added_legs (
  season_id, leg_id, record_id, type, airline, flight_number, raw_flight_number,
  date, source_kind, source_side, status
) values (
  'quality-season', 'daily-overlay', 'daily-overlay', 'D', 'VN', 'VN103', '103',
  '2026-01-03', 'added', 'DEP', 'active'
);
insert into public.season_mod_history_entries (season_id, entry_id, timestamp, description)
values ('quality-season', 'daily-history', 1, 'daily write');
insert into public.season_mod_history_changes (
  entry_id, change_index, leg_id, previous_mod_snapshot, new_mod_snapshot
) values ('daily-history', 0, 'daily-overlay', null, '{"action":"added"}');
select public.manage_season_metadata_v2(
  'create',
  'daily-created-season',
  '{"season_code":"Q28","name":"Q28","uploaded_at":0}'::jsonb
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000005', true);
insert into public.season_modifications (season_id, leg_id, action)
values ('quality-season', 'checkin-overlay', 'modified');
insert into public.season_modification_counters (leg_id, counter_group, item_index, counter_value)
values ('checkin-overlay', '__single__', 0, '24');
insert into public.season_modification_checkin_windows (leg_id, counter_key, window_start, window_end)
values ('checkin-overlay', '24', '08:00', '09:00');
do $$
begin
  begin
    insert into public.season_modification_added_legs (
      season_id, leg_id, record_id, type, source_kind, source_side, status
    ) values ('quality-season', 'checkin-overlay', 'checkin-overlay', 'D', 'added', 'DEP', 'active');
    raise exception 'checkin operator wrote a schedule-only added leg';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000006', true);
insert into public.season_modifications (season_id, leg_id, action, gate, stand)
values ('quality-season', 'gate-overlay', 'modified', 7, 14);
do $$
begin
  begin
    insert into public.season_modification_counters (leg_id, counter_group, item_index, counter_value)
    values ('gate-overlay', '__single__', 0, '25');
    raise exception 'gate operator wrote checkin-only counter data';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.season_modification_added_legs (
      season_id, leg_id, record_id, type, source_kind, source_side, status
    ) values ('quality-season', 'gate-overlay', 'gate-overlay', 'D', 'added', 'DEP', 'active');
    raise exception 'gate operator wrote a schedule-only added leg';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000007', true);
do $$
begin
  begin
    insert into public.season_source_rows (season_id, row_index)
    values ('quality-season', 9007);
    raise exception 'repair permission bypassed baseline REST DML boundary';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.season_modifications (season_id, leg_id, action)
    values ('quality-season', 'repair-direct-overlay', 'modified');
    raise exception 'repair-only operator bypassed overlay permission policy';
  exception when insufficient_privilege then null;
  end;
  perform public.manage_season_metadata_v2(
    'delete',
    'quality-repair-delete',
    '{}'::jsonb
  );
end
$$;
reset role;

rollback;
