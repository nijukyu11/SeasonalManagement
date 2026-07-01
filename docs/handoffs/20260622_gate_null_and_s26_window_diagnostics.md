# Gate null persistence and S26 server window diagnostics

Context: after the online-first cutover, the frontend now sends gate/check-in edits through `apply_season_server_mutation_v1` and reads allocation windows through `get_season_schedule_allocation_window_v1`.

Run these checks on the self-hosted Supabase database with an authenticated/service-role context.

## 1. Confirm S26 counts and RPC limit behavior

```sql
select id, season_code, name
from public.seasons
where season_code = 'S26' or name ilike '%S26%';
```

Replace `<season_id>` below:

```sql
select count(*) as flight_records
from public.season_flight_records
where season_id = '<season_id>';

select jsonb_array_length(result->'flightRecords') as all_records
from (
  select public.get_season_schedule_allocation_window_v1(
    '<season_id>',
    null,
    null,
    'all',
    100000
  ) as result
) q;

select jsonb_array_length(result->'flightRecords') as gate_window_records
from (
  select public.get_season_schedule_allocation_window_v1(
    '<season_id>',
    '2026-06-22',
    '2026-06-22',
    'gate',
    100000
  ) as result
) q;
```

Expected:

- The first RPC with null dates should be able to return the full S26 record set when `p_limit = 100000`.
- The date-filtered gate RPC should return only the selected operational/date window.
- There should be no hard-coded server cap around 9000/10000 inside the RPC.

## 2. Verify gate null writes persist as an intentional modification

Find the affected record from the screenshot:

```sql
select record_id, flight_number, type, date, scheduled_date, operational_date, schedule, route, gate, stand
from public.season_flight_records
where season_id = '<season_id>'
  and flight_number in ('C65540', 'Z2823')
order by date, schedule, flight_number;
```

After unallocating gate for the `C65540` departure record from the app, check:

```sql
select season_id, leg_id, action, changed_fields, gate, stand, updated_at
from public.season_modifications
where season_id = '<season_id>'
  and leg_id = '<c65540_departure_record_id>';
```

Expected:

- A modification row exists.
- `changed_fields` contains `gate`.
- `gate is null`.

Then verify the server window returns the same modification:

```sql
select result->'modifications' as modifications
from (
  select public.get_season_schedule_allocation_window_v1(
    '<season_id>',
    '2026-06-22',
    '2026-06-22',
    'gate',
    100000
  ) as result
) q;
```

Expected:

- The matching modification JSON includes `changed_fields` containing `gate`.
- Its `gate` field is JSON null.

## 3. Patch if null-field intent is lost

If the modification row is missing, or `changed_fields` does not contain `gate`, update `public.upsert_season_modification_from_json` so it derives `changed_fields` from JSON key presence, not non-null values. The existing pattern should be equivalent to:

```sql
for v_key in select jsonb_object_keys(mod_payload)
loop
  if v_key not in ('legId', 'action') then
    v_changed_fields := array_append(v_changed_fields, v_key);
  end if;
end loop;
```

For scalar nullable fields, store values with `mod_payload->>'field'` / `nullif(..., '')::integer` while relying on `changed_fields` to preserve the difference between "unchanged" and "explicitly cleared".

Also confirm `apply_season_server_mutation_v1` accepts module sources used by the frontend:

- `gate`
- `checkin`
- `daily`
- `detailed`
- `seasonal`

The frontend no longer sends generic `allocation` for gate/check-in edits.
