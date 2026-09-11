# Thống kê quy mô mạng bay trên trang báo cáo sản lượng — hướng backend

**Ngày:** 2026-09-11
**Trạng thái:** Kế hoạch thực hiện (chưa code)
**Mục tiêu:** Hiển thị thêm **số chặng bay**, **số hãng hàng không**, **số quốc gia kết nối** trong kỳ đang xét ngay màn hình chính `/reports/traffic`, với **backend là nguồn số liệu duy nhất** (không đếm ở client, không phát sinh request phụ).

## 1. Phạm vi

- Bổ sung một khối `coverage_counts` vào payload overview của cả hai contract (v1 & v2), tính bằng `COUNT(DISTINCT …)` trên đúng tập bản ghi đã lọc của kỳ hiện tại.
- Bổ sung dải thẻ "quy mô mạng bay" (Coverage Scope Strip) trên trang báo cáo, có deep-link cuộn xuống bảng chi tiết tương ứng.
- Không tính lại KPI/Pax; không đổi breakdown hay dimension API; không thêm HTTP request; không suppression cho số đếm thực thể.

## 2. Hiện trạng & ràng buộc (fact-check)

| Nguồn | Vấn đề nếu dùng để đếm ở client |
|---|---|
| `metadata.filter_options` | v1 lấy **toàn hệ thống**; giới hạn `filter_options_limit: 250`; v2 cắt `[1:250]`. Không bám kỳ lọc. |
| `breakdowns` | v1 chỉ trả **Top 10 + nhóm `Khác`**, không phản ánh tổng thực tế. |
| `/dimension` (`total_rows`) | Chính xác nhưng dimension `country` **tính cả dòng `Unknown`**; gọi riêng phát sinh 3 round-trip dễ lệch watermark/read-version (`409`). |

Điểm neo trong code (mốc `main@3cd5a48`, worktree báo cáo `codex/web-traffic-report@28bf969`):

- V1 KPIs: `reporting.get_traffic_report_kpis(...)` — nguồn `reporting.public_traffic_effective`, CTE `scoped`, đã có `quality.unknown_country`.
  `app/supabase/migrations/20260830213000_public_traffic_report_remove_suppression.sql` (định nghĩa dòng 6; CTE `quality` dòng 77–86; block `select jsonb_build_object` dòng 103–143).
- V1 overview: `public.get_public_traffic_report_overview_v1` ghi đè `kpis.current/comparison` từ `reporting.get_traffic_report_pax_presence_v1` (cùng nguồn `public_traffic_effective`) — overview tại `20260830213000_...` dòng 651; helper presence tại `20260830200000_public_traffic_report_aircraft_type_contract.sql` dòng 866.
- V2: `public.get_public_traffic_report_v2(...)` — nguồn `current_rows`, đã có `quality_metric.unknown_country_legs`; `dimension_grouped` đã nhóm `airline/route/country`.
  `app/supabase/migrations/20260831210000_public_traffic_live_aggregate_v2.sql` (CTE `current_rows` dòng 207; `dimension_grouped` dòng ~282; assembly bundle dòng 469–500).
- Client: `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx` — header "Các chỉ số nổi bật", grid 3 `KpiCard` (`lg:grid-cols-3`), dòng ghi chú pax, rồi `insights`. Worktree báo cáo: dòng 305 (header), 310 (grid), 336 (note).
- Bảng chi tiết: `TrafficReportDimensionSection.tsx` — `<section aria-labelledby={`${kind}-title`}>` (dòng 158) và `<h2 id={`${kind}-title`}>` (dòng 162), `kind ∈ {market, airline}`.
- Adapter v2→presentation: `app/src/lib/trafficReportDataAdapter.ts` → `toTrafficReportPresentationBundle()` map `report.*` sang `kpis.*`.
- Validator/type: `trafficReportContract.ts` (`TrafficReportBundle`, `isTrafficReportBundle`), `trafficReportV2Contract.ts` (`TrafficV2ReportParity`, `TrafficV2ApiReportParity`, `isApiReportParity`, `decodeTrafficV2ApiEnvelope`).
- Edge: `app/supabase/functions/traffic-report/index.ts` — overview trả `{ ...bundle, request_hash }`, v2 trả `{ ...bundle, read_version_token }` (không whitelist field).

**Ràng buộc nhánh:** UI/Edge báo cáo đang được build từ worktree `SeasonalManagement-web-traffic-report` (nhánh `codex/web-traffic-report`); lineage migration (gồm `20260831210000_public_traffic_live_aggregate_v2.sql`) chỉ có ở `main`. Xem mục 9.

## 3. Định nghĩa dữ liệu (semantics)

| Trường | Công thức SQL | Ghi chú |
|---|---|---|
| `routes` | `count(distinct route) filter (where route <> '' and route is not null)` | Số chặng có phát sinh chuyến trong kỳ. |
| `airlines` | `count(distinct airline) filter (where airline <> '' and airline is not null)` | Số hãng khai thác thực tế. |
| `countries` | `count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))` | **Loại `Unknown`**. |
| (chú thích) | tái dùng `quality.unknown_country_legs` sẵn có | Tooltip minh bạch khi có chuyến chưa ánh xạ quốc gia. |

Quy tắc:

1. **Bám bộ lọc người dùng**: direction (`A`/`D`), `airline`, `route`, `country` (và `aircraft_group` ở v1). Khi lọc 1 hãng → `airlines = 1`; khi lọc 1 chặng → `routes = 1`.
2. **Cùng nguồn với KPI**: tính từ chính relation sinh ra `kpis.current.flights` (v1: `scoped where period='current'` trên `public_traffic_effective`; v2: `current_rows` trên canonical slice). Không dùng `filter_options`/projection rời.
3. **Kỳ rỗng**: trả `0` cho cả ba, không `null`, không lỗi.
4. **Không suppression**: đây là số đếm thực thể công khai, không phải sản lượng khách cá thể.
5. `Unknown` bị loại khỏi `countries` nhưng số chuyến thuộc `Unknown` vẫn hiển thị qua chú thích.

## 4. Hợp đồng dữ liệu

`app/src/lib/trafficReportContract.ts`:

```ts
export interface TrafficCoverageCounts {
  routes: number;
  airlines: number;
  countries: number;
}
```

Bổ sung `coverage_counts: TrafficCoverageCounts` vào `TrafficReportBundle['kpis']` (cạnh `peak_day`, `pax_coverage`).
Mở rộng `isTrafficReportBundle` để chấp nhận/kiểm tra `coverage_counts` là object 3 số nguyên không âm — **optional trong giai đoạn rollout** (payload cũ chưa có), **bắt buộc sau khi cả hai RPC đã lên production**.

`app/src/lib/trafficReportV2Contract.ts`:

```ts
// TrafficV2ReportParity
coverageCounts: { routes: number; airlines: number; countries: number };

// TrafficV2ApiReportParity
coverage_counts: { routes: number; airlines: number; countries: number };
```

`isApiReportParity` kiểm tra `coverage_counts` là object 3 số nguyên không âm; `decodeTrafficV2ApiEnvelope` map sang `report.coverageCounts`.

`app/src/lib/trafficReportDataAdapter.ts` → `toTrafficReportPresentationBundle`:

```ts
coverage_counts: report.coverageCounts,
```

**Ràng buộc nguồn số (bắt buộc):** `coverage_counts` phải là kết quả `COUNT(DISTINCT …)` tính trong SQL trên **đúng tập bản ghi canonical đã áp bộ lọc** của kỳ hiện tại (v1: `scoped where period='current'`; v2: `current_rows`) và được trả trong cùng một payload. Nghiêm cấm suy ra số liệu từ `metadata.filter_options` (bị chặn `filter_options_limit: 250`) hoặc từ `breakdowns`/`/dimension` đã phân trang/Top-N — cả hai đều **đếm thiếu** ("undercount") ở kỳ lớn hoặc khi có hơn 250 giá trị. Client/validator không được tự tính hay hiệu chỉnh lại ba con số này.

## 5. Backend SQL

Migration mới (additive), đặt sau mốc mới nhất đang triển khai (hiện `20260906011000_active_seasonal_export_snapshot.sql`):
`app/supabase/migrations/20260911120000_public_traffic_report_coverage_counts.sql`.

Cách làm: **copy nguyên thân hàm từ migration gốc rồi chèn phần đếm** (đúng thông lệ `create or replace` đang dùng), giữ nguyên chữ ký, quyền `service_role`, `security definer`, `statement_timeout`, `alter function … owner to postgres`, `revoke/grant` hiện hành.

### 5.1 V2 — `public.get_public_traffic_report_v2`

Thêm CTE (cạnh `quality_metric`, chỉ tính khi `p_payload_scope = 'full'`):

```sql
), coverage_counts as (
  select
    count(distinct route) filter (where route is not null and route <> '')::integer as routes,
    count(distinct airline) filter (where airline is not null and airline <> '')::integer as airlines,
    count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as countries
  from current_rows
  where p_payload_scope = 'full'
)
```

Chèn vào object `'report'` trong bundle:

```sql
'coverage_counts', (
  select jsonb_build_object('routes', routes, 'airlines', airlines, 'countries', countries)
  from coverage_counts
),
```

### 5.2 V1 — `reporting.get_traffic_report_kpis`

Mở rộng CTE `quality` (đang `select … from scoped where period = 'current'`) để tính thêm 3 số đếm trên cùng `scoped`, rồi xuất `coverage_counts` trong `select jsonb_build_object(...)` cạnh `'quality'`:

```sql
-- thêm 3 cột vào CTE quality hiện hành
count(distinct route)   filter (where route   is not null and route   <> '')::integer as distinct_routes,
count(distinct airline) filter (where airline is not null and airline <> '')::integer as distinct_airlines,
count(distinct country) filter (where country is not null and country not in ('', 'Unknown'))::integer as distinct_countries

-- xuất trong select jsonb_build_object(...) cạnh 'quality'
'coverage_counts', jsonb_build_object(
  'routes', quality.distinct_routes,
  'airlines', quality.distinct_airlines,
  'countries', quality.distinct_countries
),
```

(CTE `quality` đã `from scoped where period = 'current'`; `scoped` đã áp đủ `types/airlines/routes/countries/aircraft_groups`).

`get_public_traffic_report_overview_v1` không cần sửa: nó chỉ ghi đè `kpis.current/comparison`, các key khác giữ nguyên từ base.

## 6. Edge function

Không cần sửa. Overview v1 trả thẳng bundle và v2 spread bundle; trường mới tự động đi kèm. Kiểm tra lại không có bước whitelist/reshape field trong `app/supabase/functions/traffic-report/index.ts` nhánh overview.

## 7. UI — Coverage Scope Strip + deep-link

Chèn dải thẻ **giữa header "Các chỉ số nổi bật" và grid 3 `KpiCard`** trong `TrafficReportClient.tsx`:

```
[Các chỉ số nổi bật]                                   [Cập nhật …]
[ 31 ngày ] [ 42 chặng bay ↗ ] [ 18 hãng khai thác ↗ ] [ 9 quốc gia ↗ ]
[Tổng]                   [Chuyến bay đến]              [Chuyến bay đi]
```

- Dữ liệu pill: `bundle.metadata.day_count`; `bundle.kpis.coverage_counts.routes/airlines/countries`.
- Component gọn, thuần hiển thị (có thể tách file `TrafficReportCoverageStrip.tsx` hoặc inline). Style theo phần tử hiện có: `rounded-xl border border-slate-200 bg-slate-50/80`, số `font-bold text-slate-900 tabular-nums`.
- **Deep-link**: pill chặng/quốc gia → `updateViewState({ marketDimension: 'route' | 'country' })` rồi cuộn tới anchor ổn định `#market-section`; pill hãng → `#airline-section`. Hai anchor được đặt trên `<div id="market-section" className="scroll-mt-24">` / `<div id="airline-section" className="scroll-mt-24">` bao ngoài `TrafficReportDimensionSection` (wrapper không bị remount khi đổi dimension, khác với `key` bên trong component) — offset 96px bù thanh lọc `sticky top-0` cao tối thiểu 72px.
- **Tooltip** (`title` hoặc `aria-label`): định nghĩa "chặng/hãng/quốc gia có phát sinh chuyến trong kỳ theo bộ lọc hiện tại"; nếu `bundle.quality.unknown_country_legs > 0` thêm chú thích "Có N chuyến thuộc chặng chưa ánh xạ quốc gia".
- **Fallback**: `coverage_counts` vắng (payload cũ) → ẩn cả dải, không render `NaN`/`undefined`.

## 8. Kiểm thử

| Kiểm tra | Nội dung |
|---|---|
| SQL PGlite (`app/supabase/tests/public_traffic_report_v1_pglite.mjs`) | Fixture nhiều airline/route/country + vài chuyến `Unknown`; assert `coverage_counts` theo bộ lọc: mặc định, lọc 1 hãng (`airlines=1`), lọc 1 chặng (`routes=1`), direction `A`/`D`, `country=Unknown` bị loại khỏi `countries`, kỳ rỗng = 0. |
| Contract v1 (`app/src/lib/trafficReportContract.test.ts`) | Bundle có `coverage_counts` hợp lệ qua `isTrafficReportBundle`; payload thiếu (rollout) vẫn chấp nhận nếu để optional. |
| Contract v2 (`app/src/lib/trafficReportV2Contract.test.ts`) | Envelope có `coverage_counts` decode đúng; giá trị âm/thiếu/sai kiểu bị từ chối. |
| Adapter (`app/src/lib/trafficReportDataAdapter.test.ts`) | `report.coverageCounts` → `kpis.coverage_counts` giữ nguyên giá trị. |
| Edge contract (`app/scripts/traffic-report-edge-contract.test.mjs`) | Overview trả `coverage_counts`; đối soát bằng tổng số nhóm dimension trong cùng payload (routes/airlines) và `countries` = số nhóm country trừ `Unknown`; khớp `unknown_country_legs`. |
| Source test presentation (`TrafficReportPresentation.source.test.ts`) | Kiểm tra test có ràng buộc theo text/field mới không; cập nhật nếu cần. |
| Build | `npm run test:traffic-report-contract`, `npx tsc --noEmit --pretty false`, `npm run build:traffic-report` (chạy trong `app/`). |
| Browser smoke | Mở `/reports/traffic`: dải hiển thị đúng; đổi filter (hãng/chặng/hướng/ngày) số cập nhật theo; click pill cuộn đúng bảng và đổi đúng tab Chặng/Quốc gia; mobile 375px không tràn. |

Fixtures là dữ liệu minh hoạ; không dùng số liệu fixture để kết luận khai thác thật.

## 9. Thứ tự triển khai & rollback

Thay đổi **additive** ở cả hai phía nên tương thích ngược: frontend cũ bỏ qua key lạ, frontend mới chịu được payload cũ.

1. **SQL trước**: tạo migration, apply trên clone/pglite → staging; kiểm tra quyền `service_role`, reload PostgREST schema cache; gọi thử `/api/report/v1/overview` và `/api/report/v2/overview` xác nhận `coverage_counts`.
2. **Contract/adapter/UI sau**: cập nhật types + validator + adapter + strip, chạy test/build, deploy static release theo runbook (`docs/runbooks/public-traffic-report-deploy.md`).
3. **Rollback**: chuyển symlink `current` về release trước; migration additive không cần revert (key thừa bị frontend cũ bỏ qua). Không downgrade riêng validator/Edge.

**Ràng buộc nhánh — quyết định thực tế:**

- Bản triển khai được đặt trên `main` (worktree `C:/Users/tuan/Documents/SeasonalManagement`), vì đây là nơi có lineage migration live-v2 (`20260831210000_public_traffic_live_aggregate_v2.sql`), toàn bộ PGlite/Edge contract test và adapter v2. Nhánh báo cáo `codex/web-traffic-report` đang **sau `main` ~28 commit** (chỉ hơn 1 commit html pivot), nên viết UI/contract ở đó sẽ phân mảnh tính năng và không kiểm thử được end-to-end.
- Hệ quả: trước khi phát hành production cho báo cáo, **merge `main` vào `codex/web-traffic-report`** (hoặc merge ngược lại) để nhánh deploy có cả migration `20260911120000_...`, contract/adapter và UI mới. Kiểm tra `git log codex/web-traffic-report..main` trước khi merge để xử lý điểm lệch `trafficReportContract.ts`/`TrafficReportClient.tsx`.
- Migration vẫn phải được apply theo runbook `docs/runbooks/public-traffic-report-deploy.md` (thứ tự timestamp, sau `20260902150000_public_dashboard_pax_correction.sql`), **trước khi** phát hành static release có UI mới.

## 10. Ngoài phạm vi & rủi ro

- Không đổi `/dimension`, breakdown, export Excel/HTML, dashboard, workbook.
- Không thêm request, không cache riêng, không tính ở client.
- Rủi ro: `country` có thể là `NULL`/`''`/`'Unknown'` → công thức phải loại cả ba; nếu bỏ sót sẽ đếm thừa.
- Rủi ro: v1 vẫn đang được public API trả trên production (theo `docs/current-implementation-status.md`) → **phải cập nhật cả `get_traffic_report_kpis` (v1)**, không chỉ v2.
- Rủi ro: branch divergence giữa `main` và `codex/web-traffic-report` → xử lý theo mục 9, không tự ý merge toàn nhánh.

## Kết quả thực hiện — 2026-09-11

Đã triển khai local trên `main` (chưa commit, chưa apply DB, chưa deploy production).

### Thay đổi

- `app/supabase/migrations/20260911120000_public_traffic_report_coverage_counts.sql` (mới): patch in-place `public.get_public_traffic_report_v2` và `reporting.get_traffic_report_kpis` bằng `pg_get_functiondef` + guard `to_regprocedure`, giữ nguyên chữ ký/quyền; idempotent (bỏ qua khi `coverage_counts` đã tồn tại, báo lỗi rõ nếu anchor lạ).
- Contract v1 (`trafficReportContract.ts`): `TrafficCoverageCounts`, `kpis.coverage_counts?`, mở rộng `isTrafficReportBundle`.
- Contract v2 (`trafficReportV2Contract.ts`): `TrafficV2ReportParity.coverageCounts?`, `TrafficV2ApiReportParity.coverage_counts?`, validate trong `isApiReportParity`, map trong `decodeTrafficV2ApiEnvelope`.
- Adapter (`trafficReportDataAdapter.ts`): `report.coverageCounts → kpis.coverage_counts`.
- UI (`TrafficReportClient.tsx`): `CoverageScopeStrip` (`N ngày · N chặng bay · N hãng khai thác · N quốc gia`) đặt giữa header KPI và grid 3 thẻ; deep-link `#market-section`/`#airline-section` với `scroll-mt-24`; helper `scrollToSection` tôn trọng `prefers-reduced-motion` (`auto` khi reduced, `smooth` khi thường); ẩn dải khi payload chưa có field.
- Tests: PGlite assert counts v1/v2, lọc 1 chặng, loại `Unknown`; contract v1/v2 reject giá trị âm/phân số; adapter mapping.

### Kiểm chứng đã chạy

| Kiểm tra | Kết quả |
|---|---|
| `node supabase/tests/public_traffic_report_v1_pglite.mjs` | pass; migration cài 2 lần (idempotent) |
| `npm run test:traffic-report-contract` | pass toàn bộ: contract v1/v2, adapter, PGlite, Edge contract, isolation, dashboard runner |
| `npx tsc --noEmit --pretty false` | pass |
| `npm run build:traffic-report` | pass, 52 file |
| Browser smoke (`/reports/traffic`, mock v1, 1440px) | dải hiển thị `31 ngày / 4 chặng bay / 4 hãng khai thác / 2 quốc gia`; click pill quốc gia đổi `market_dimension=country` và cuộn tới `market-section` (`scrollY 1674`); click pill hãng cuộn tới `airline-section` (`airlineTop 96px` = `scroll-mt-24`); tooltip nêu 76 chuyến chưa ánh xạ quốc gia |

Headless Chrome không chạy animation `behavior:'smooth'` (giữ `scrollY 0`), nên đã kiểm chứng nhánh `prefers-reduced-motion: reduce` (emulate qua DevTools) → helper dùng `behavior:'auto'` và cuộn đúng anchor; nhánh `smooth` giữ nguyên cho người dùng thường. Không sửa code để lách test.

### Phát hành production — 2026-09-11

- Đã commit `a19161c` (feature) và `3bf5a76` (receipt DB) trên `main`.
- Đã apply migration `20260911120000_public_traffic_report_coverage_counts.sql` lên **production DB** (transaction + `notify pgrst, 'reload schema'`); verify: v1 `/api/report/v1/overview` → `kpis.coverage_counts`, v2 `/api/report/v2/overview` → `report.coverage_counts`, cùng `{routes: 19, airlines: 32, countries: 11}` cho 2026-09-01; `quality.unknown_country_legs = 2`.
- **Đính chính mục 9 (nguồn artifact):** kiểm tra release production `20260908T075606Z-report-cleanup` cho thấy client chứa marker chỉ có ở `main` (`Tải Excel`, `Nguồn snapshot · watermark`) và **không** có marker của nhánh báo cáo (0/3 marker) → static release production được build từ `main`, không phải `codex/web-traffic-report`. Vì vậy không cần merge sang nhánh báo cáo; deploy trực tiếp từ `main` mới đúng nguồn và không hồi quy chức năng.
- Build `app/out-report` tại `main@3bf5a76`: 52 file; `reports/traffic.html` sha256 `5d95c43aa354a462b3a217bf408cc0e57b80d8ec3d7c1e2a7fa57ce8c24026d8`.
- Staging: release `20260911T154845Z-coverage-counts` (carry-forward nội dung `current` + overlay artifact để giữ chunk cũ cho HTML đã cache), `staging-current` trỏ tới đó; nginx `127.0.0.1:8781` + Quick Tunnel `https://mating-mon-and-regards.trycloudflare.com`.
- Kiểm chứng staging (browser thật 1440px): dải `253 ngày · 46 chặng bay · 45 hãng khai thác · 17 quốc gia`; pill quốc gia đổi `market_dimension=country`; deep-link cuộn anchor `marketTop = airlineTop = 96px` (reduced-motion); `/reports/traffic/dashboard` render bình thường, không lỗi; mobile 375px `overflow = 0`; API v1 2026-09-01 → `{routes:19, airlines:32, countries:11}`.
- Người dùng chấp nhận staging. Publish: `current → releases/20260911T154845Z-coverage-counts`; `nginx -t` + reload; smoke `127.0.0.1:8780` (`/healthz`, `/reports/traffic`, `/reports/traffic.txt`, `/reports/traffic/dashboard`) = 200; chunk dải `124rhujwo84ir.js` = 200; API v1 `coverage_counts` OK.
- Public verify `https://report.ahtops.xyz/reports/traffic`: dải hiển thị `46 chặng bay / 45 hãng khai thác / 17 quốc gia`; nút `Tải Excel toàn báo cáo` vẫn còn (không hồi quy export cũ); `cf-cache-status: DYNAMIC`; dashboard public không lỗi.
- Không ảnh hưởng app gốc: artifact chỉ chứa route báo cáo (`build:traffic-report` fail-closed nếu xuất hiện route/marker desktop), nginx public chỉ phục vụ `/srv/seasonal-traffic-report`; `app/out` (desktop/Tauri) và Supabase API không đổi.
- Rollback: `ln -sfn releases/20260908T075606Z-report-cleanup current` + `systemctl reload nginx` (release cũ còn nguyên trên server). Migration additive nên không cần revert.
- Quick Tunnel staging đã dừng; `staging-current` giữ nguyên, không ảnh hưởng production.

### Rollback và đính chính nguồn artifact — 2026-09-11 (sau phản hồi người dùng)

Người dùng xác nhận bản publish **sai nguồn so với production**. Đã rollback và xác minh lại lineage:

- **Rollback**: `current → releases/20260908T075606Z-report-cleanup`; `nginx -t` + reload. `reports/traffic.html` sha256 `496ceca18e3b6abdcddbeaa02cea7b09506cf4e148259335efc11cb4a88ec932` khớp **nguyên trạng trước publish**. DOM public: không còn `hãng khai thác`, `/reports/traffic` + `/reports/traffic/dashboard` = 200.
- **Production thật build từ worktree báo cáo `codex/web-traffic-report`, không phải `main`.** Bằng chứng DOM/release: có `Xuất báo cáo`, `Breakdown giờ cao điểm theo ngày`, và các component chỉ có ở worktree báo cáo (`TrafficPeakHourHeatmap.tsx`, `TrafficMonthlyDayOfWeekHeatmap.tsx`, `TrafficDimensionShareDonut.tsx`, `TrafficTrendTable.tsx`, `TrafficWorkbookExportDialog.tsx`); `main` thiếu toàn bộ các file/chuỗi này (`Xuất báo cáo` = 0, `Breakdown giờ cao điểm theo ngày` = 0).
- **Đối chiếu chunk build lại từ worktree báo cáo** (`npm run build:traffic-report`, 50 file): 8/9 chunk được `reports/traffic.html` tham chiếu trùng hash với release production, cùng `turbopack-0poq0sp4_jait.js`; khác duy nhất một chunk `0~n7df-.p5b20.js` (production) ↔ `00nlqgfimhxxe.js` (worktree), cùng ~142 KB lệch 152 byte, cùng chứa `Xuất báo cáo` + `Breakdown giờ cao điểm theo ngày` → worktree báo cáo là đúng lineage, bản production xấp xỉ trạng thái worktree.
- **Nguyên nhân sai lầm trước đó**: kết luận "production build từ `main`" dựa trên `grep` marker trong thư mục release — nhưng thư mục release tích luỹ nhiều buildId dir/chunk cũ (4 buildId dir, 29 chunk), nên marker trong chunk **không được tham chiếu** bị tính nhầm. Kiểm tra đúng phải dựa trên DOM render và tập chunk được HTML tham chiếu.
- **Hệ quả**: mục §9 ban đầu đúng — UI/contract phải port sang worktree báo cáo rồi build/deploy từ đó. Feature `coverage_counts` hiện **chưa** có trên production; SQL vẫn đã apply production DB (additive, frontend cũ bỏ qua key lạ).
- Trạng thái: production đang chạy `20260908T075606Z-report-cleanup`; `staging-current` trỏ release dải thẻ (không ảnh hưởng production) — sẽ được thay khi build lại từ worktree báo cáo.
