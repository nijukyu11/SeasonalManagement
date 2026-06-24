# Handoff Backend: Dashboard Reporting Database Migration

Ngày lập: 2026-06-23

## Lý do

Dashboard mới thêm cấu hình `Dashboard Alerts` và reporting layer cho hai view `Vận hành ca trực` / `So sánh sản lượng`.

Runtime hiện tại đã có fallback ở frontend để Daily / Check-in / Gate không còn bị chặn khi DB chưa có cột mới. Tuy nhiên backend vẫn cần migrate DB để:

- Lưu được ngưỡng Dashboard Alerts trong `operational_settings`.
- Cấp dữ liệu chuẩn cho AI Workspace qua Supabase reporting/RPC, không dùng context dashboard local.
- Tạo reporting view đã áp dụng effective records: imported + added legs, modified fields, deleted exclusion.
- Hỗ trợ weeknum/isoweek, local/UTC bucket 30/60 phút, A/C group, pax status.

## Migration cần chạy

Áp dụng migration:

```text
app/supabase/migrations/20260623090000_effective_dashboard_reporting.sql
```

Khuyến nghị chạy nguyên migration qua pipeline backend/Supabase migration chính thức. Không nên chỉ copy một phần nếu mục tiêu là dashboard/AI đầy đủ.

## Hotfix tối thiểu nếu cần khôi phục lỗi load ngay

Nếu cần xử lý ngay lỗi:

```text
load operational settings: column operational_settings.dashboard_arrival_bucket_flights does not exist
```

Backend có thể chạy trước đoạn tối thiểu này:

```sql
alter table public.operational_settings
  add column if not exists dashboard_arrival_bucket_flights integer,
  add column if not exists dashboard_departure_bucket_flights integer,
  add column if not exists dashboard_ad_gap_flights integer,
  add column if not exists dashboard_ctg_abs_pct numeric,
  add column if not exists dashboard_pax_coverage_min_pct numeric;
```

Sau đó vẫn cần apply full migration để dashboard/AI reporting hoạt động đúng.

## Nội dung chính của full migration

1. Tạo schema và index phục vụ reporting:

```sql
create schema if not exists reporting;

create index if not exists season_modifications_reporting_idx
  on public.season_modifications (season_id, leg_id, action);

create index if not exists season_modification_added_legs_reporting_idx
  on public.season_modification_added_legs (season_id, leg_id, status, type);

create index if not exists operational_aircraft_group_types_aircraft_type_idx
  on public.operational_aircraft_group_types (aircraft_type);
```

2. Thêm Dashboard Alert columns vào `public.operational_settings`:

```sql
dashboard_arrival_bucket_flights integer
dashboard_departure_bucket_flights integer
dashboard_ad_gap_flights integer
dashboard_ctg_abs_pct numeric
dashboard_pax_coverage_min_pct numeric
```

3. Tạo reporting views:

```text
reporting.effective_flight_operations
reporting.flight_operations
reporting.summary_airline
reporting.summary_country
reporting.summary_route
reporting.summary_month
reporting.summary_week
reporting.summary_peak_hour
reporting.summary_aircraft
reporting.summary_arr_dep_mix
```

4. Tạo RPC cho AI/reporting:

```text
reporting.query_aggregated(jsonb, text[], text[], text, text, integer)
public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer)
public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer)
```

5. Quyền truy cập:

```sql
alter view reporting.effective_flight_operations set (security_invoker = true);
alter view reporting.flight_operations set (security_invoker = true);
alter view reporting.summary_airline set (security_invoker = true);
alter view reporting.summary_country set (security_invoker = true);
alter view reporting.summary_route set (security_invoker = true);
alter view reporting.summary_month set (security_invoker = true);
alter view reporting.summary_week set (security_invoker = true);
alter view reporting.summary_peak_hour set (security_invoker = true);
alter view reporting.summary_aircraft set (security_invoker = true);
alter view reporting.summary_arr_dep_mix set (security_invoker = true);

grant usage on schema reporting to authenticated;
grant select on all tables in schema reporting to authenticated;

revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) from anon;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from PUBLIC;
revoke execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) from anon;

grant execute on function reporting.query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_aggregated(jsonb, text[], text[], text, text, integer) to authenticated;
grant execute on function public.dashboard_ai_query_rows(text, jsonb, text[], text, text, integer) to authenticated;
```

## PostgREST schema cache

Sau khi thêm cột/view/function, nếu app vẫn báo kiểu:

```text
PGRST204 / column ... does not exist / schema cache
PGRST202 / function ... not found in schema cache
```

Backend cần reload PostgREST schema cache. Supabase troubleshooting hiện khuyến nghị chạy:

```sql
select pg_notification_queue_usage();
```

Nếu môi trường đang dùng cơ chế notify chuẩn của PostgREST, có thể chạy thêm:

```sql
notify pgrst, 'reload schema';
```

Sau đó thử lại request từ app.

## Verify sau khi chạy migration

Chạy các query sau trên Supabase SQL Editor hoặc backend console.

### 1. Kiểm tra columns Dashboard Alerts

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'operational_settings'
  and column_name in (
    'dashboard_arrival_bucket_flights',
    'dashboard_departure_bucket_flights',
    'dashboard_ad_gap_flights',
    'dashboard_ctg_abs_pct',
    'dashboard_pax_coverage_min_pct'
  )
order by column_name;
```

Kỳ vọng: trả đủ 5 rows.

### 2. Kiểm tra reporting views

```sql
select table_schema, table_name
from information_schema.views
where table_schema = 'reporting'
  and table_name in (
    'effective_flight_operations',
    'flight_operations',
    'summary_airline',
    'summary_country',
    'summary_route',
    'summary_month',
    'summary_week',
    'summary_peak_hour',
    'summary_aircraft',
    'summary_arr_dep_mix'
  )
order by table_name;
```

Kỳ vọng: trả đủ các view trên.

### 3. Kiểm tra data contract chính

```sql
select
  ops_date,
  operational_date,
  type,
  airline,
  route,
  aircraft,
  ac_group,
  pax_status,
  weeknum,
  isoweek,
  local_bucket_30,
  local_bucket_60,
  utc_bucket_30,
  utc_bucket_60
from reporting.flight_operations
limit 10;
```

Kỳ vọng: query chạy được, không cần có dữ liệu nếu DB đang rỗng.

### 4. Kiểm tra aggregate RPC không group

```sql
select reporting.query_aggregated(
  '{}'::jsonb,
  array[]::text[],
  array['flights']::text[],
  'flights',
  'desc',
  24
) as result;
```

Kỳ vọng:

- `rows` có 1 aggregate row.
- `rowCount` = 1.
- `truncated` = false.

### 5. Kiểm tra wrapper RPC cho app/AI

```sql
select public.dashboard_ai_query_aggregated(
  '{}'::jsonb,
  array['airline']::text[],
  array['flights', 'pax']::text[],
  'flights',
  'desc',
  10
) as result;
```

Kỳ vọng: query chạy được với authenticated role qua app.

## Verify từ app sau backend deploy

1. Reload Daily.
   - Không còn `Load Failed`.
   - Không còn lỗi `dashboard_arrival_bucket_flights does not exist`.

2. Reload Check-in.
   - Operational settings load được.

3. Reload Gate.
   - Operational settings load được.

4. Vào Settings -> Dashboard Alerts.
   - Nhập một ngưỡng bất kỳ, Save.
   - Reload page, giá trị vẫn còn.

5. Vào Dashboard -> Vận hành ca trực.
   - Các alert theo setting có thể đọc ngưỡng mới.

6. Vào Dashboard -> AI Workspace.
   - Query/reporting request không cần local SQLite/dashboard context.

## Ghi chú triển khai

- Frontend đã có fallback compatibility: khi DB chưa có Dashboard Alert columns, app vẫn load base operational settings và set alert thresholds là `null`.
- Fallback chỉ để giữ vận hành không bị chặn; không thay thế migration.
- Supabase thay đổi default grants/Data API exposure trong năm 2026, nên backend cần giữ explicit `grant usage/select/execute` như migration đã khai báo.
- Nếu chạy migration qua SQL Editor thay vì pipeline, nên lưu lại migration history theo quy trình backend để tránh lệch schema giữa environments.

