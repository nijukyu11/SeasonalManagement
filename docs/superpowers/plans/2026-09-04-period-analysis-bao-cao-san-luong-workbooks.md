# Kế hoạch thực hiện Workbook Phân tích theo kỳ và BaoCaoSanLuong public

> Ngày lập: 2026-09-04  
> Trạng thái: Sẵn sàng thực hiện theo từng phase; chưa triển khai code trong tài liệu này.  
> Phạm vi code chính: `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report\app`.  
> Kế thừa và thay thế phần `MASTER_OPERATIONS` trong kế hoạch `2026-09-03-workbook-master-monthly-operations-level-2.md`.  
> Không thay đổi semantics riêng của `WEEKLY_DETAIL`; chưa loại bỏ `MONTHLY_OVERVIEW_L2` trong release đầu.

## 1. Kết luận kiến trúc đã chốt

Tách vai trò của Workbook Master thành hai report type độc lập:

1. `PERIOD_ANALYSIS` / `period-analysis-v1`
   - Tên hiển thị: `Phân tích theo kỳ`.
   - Chọn một tháng, nhiều tháng liên tục, mùa, năm hoặc khoảng ngày tùy chỉnh.
   - Có checkbox `So sánh cùng kỳ`.
   - Khi bật checkbox, người dùng chọn một hoặc nhiều năm/mùa có dữ liệu trong CSDL.
   - Không giới hạn cứng số năm; giới hạn vận hành dựa trên kích thước dữ liệu/file và thời gian xử lý, không âm thầm cắt bớt kỳ.
   - Workbook dùng bảng dạng dọc theo kỳ để không phình ngang khi chọn nhiều năm.

2. `BAO_CAO_SAN_LUONG` / `bao-cao-san-luong-v1`
   - Tên hiển thị: `Báo cáo sản lượng`.
   - Tạo `.xlsx` public theo bố cục và cách đọc của template `BaoCaoSanLuong`.
   - Không chứa raw `Table1`, VBA, Power Query, connection, credential hoặc đường dẫn máy cá nhân.
   - Backend canonical tính sẵn toàn bộ số liệu; file không phụ thuộc refresh hay Office Script sau khi tải.

Các report type còn lại:

- `WEEKLY_DETAIL`: giữ nguyên quy tắc kỳ đã chọn + đúng 7 ngày trước + đúng 7 ngày sau.
- `MONTHLY_OVERVIEW_L2`: giữ nguyên trong giai đoạn chuyển tiếp vì có mục đích quản trị tháng riêng.
- `MASTER_OPERATIONS`: giữ code và manifest trong soak window để rollback, nhưng sẽ ẩn khỏi UI sau khi hai report mới đạt nghiệm thu.

## 2. Nguồn sự thật và ranh giới dữ liệu

- Nguồn production vẫn là canonical reporting hiện tại, không đọc dữ liệu từ các workbook mẫu.
- Mọi kỳ trong cùng một lần export phải dùng cùng:
  - `source_watermark`;
  - semantic `data_as_of`;
  - filter hash;
  - report read version.
- Backend sở hữu toàn bộ KPI, A/D/all, Pax, timeline và dimension aggregates. Frontend chỉ gửi lựa chọn và tải artifact.
- `Pax NULL` tiếp tục là thiếu dữ liệu và phải xuất ô trống; `Pax 0` là số 0 thực.
- Không đưa raw flight leg, history, deleted rows, overlay internals hoặc hidden raw sheet vào workbook public.
- Các bộ lọc Airline, Route, Country và múi giờ phải áp dụng giống nhau cho kỳ hiện tại và tất cả kỳ so sánh.
- Năm có dữ liệu được xác định theo coverage chung của canonical source, không theo bộ lọc Airline/Route/Country hiện tại. Vì vậy một hãng không khai thác trong một năm vẫn xuất kết quả 0 thay vì làm biến mất năm đó.

## 3. Baseline hiện tại cần bảo toàn

Worktree `SeasonalManagement-web-traffic-report` hiện đã có pipeline workbook nhưng chưa commit:

- Endpoint: `/api/report/v1/workbook-export`.
- Client contract: `app/src/lib/trafficWorkbookExportContract.ts`.
- Dialog: `app/src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx`.
- Model/normalization: `app/supabase/functions/_shared/trafficWorkbookCore.ts`.
- OOXML renderer: `app/supabase/functions/_shared/trafficWorkbookRenderer.ts`.
- Edge orchestration: `app/supabase/functions/traffic-report/index.ts`.
- Tests: `app/src/lib/trafficWorkbookExport.test.ts` và `app/scripts/traffic-report-edge-contract.test.mjs`.
- Manifests hiện có: `master-v1`, `monthly-l2-v1`, `weekly-detail-v1`.
- Global feature flag hiện có:
  - frontend: `NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED`;
  - backend: `TRAFFIC_WORKBOOK_EXPORT_ENABLED`.

Khi triển khai phải mở rộng các file hiện có, không tạo một đường export thứ hai có semantics khác.

## 4. Contract kỳ báo cáo

### 4.1. Period mode mới

Mở rộng `TrafficWorkbookPeriodMode` và `WorkbookPeriodMode`:

```ts
type WorkbookPeriodMode =
  | 'month'
  | 'month_range'
  | 'season'
  | 'year'
  | 'custom';
```

Mọi preset cuối cùng đều phải normalize thành `from` và `to` theo `Ops Date`, inclusive.

| Mode | Input authority | Quy tắc resolve |
|---|---|---|
| `month` | `month=YYYY-MM` | Ngày đầu đến ngày cuối tháng |
| `month_range` | `month_from`, `month_to` | Ngày đầu tháng đầu đến ngày cuối tháng cuối; chỉ nhận dải liên tục |
| `season` | `season_code=S26/W26` | Ranh giới IATA theo hàm season hiện tại |
| `year` | `year=YYYY` | `01/01` đến `31/12` |
| `custom` | `from`, `to` | Dùng trực tiếp sau validation |

Các preset vẫn gửi `from/to` đã resolve để audit. Backend phải tính lại và từ chối nếu preset không khớp `from/to`.

### 4.2. Chọn năm so sánh

Thay comparison cố định `year_ago` bằng danh sách năm:

```ts
interface WorkbookComparisonSelection {
  enabled: boolean;
  years: number[];
}

interface NormalizedWorkbookComparisonPeriod {
  id: string;
  comparisonYear: number;
  label: string;
  from: string;
  to: string;
  calendarDays: number;
  availability: 'complete' | 'partial';
}
```

Query canonical dùng lặp tham số:

```text
comparison_year=2025&comparison_year=2024&comparison_year=2023
```

Quy tắc normalization:

- Parse số nguyên bốn chữ số, loại trùng, sắp xếp giảm dần.
- Không đặt giới hạn số lượng năm trong business contract.
- Từ chối năm trùng với kỳ hiện tại hoặc không nằm trong catalog có dữ liệu.
- Canonical query và request hash không phụ thuộc thứ tự click trên UI.
- Không nhận arbitrary comparison `from/to` từ client; backend tự resolve từ năm đã chọn.

### 4.3. Thuật toán cùng kỳ

- `month`: giữ nguyên tháng, thay năm.
- `month_range`: giữ nguyên tháng bắt đầu/kết thúc và độ phủ qua năm; `comparisonYear` là năm của ngày bắt đầu.
- `year`: năm được chọn trở thành toàn bộ năm so sánh.
- `season`: giữ prefix `S` hoặc `W`, thay year của mã mùa; ví dụ `S26 → S25`, `W26 → W24` khi người dùng chọn 2024.
- `custom`: dịch cả hai mốc theo chênh lệch giữa năm bắt đầu hiện tại và `comparisonYear`.
- Nếu ngày 29/02 không tồn tại ở năm đích, clamp về ngày cuối tháng 02.
- Kỳ đi qua hai năm phải hiển thị đủ hai năm và exact `from/to`, không chỉ một nhãn năm.
- Mỗi kỳ phải ghi `calendarDays`; không giấu khác biệt số ngày do năm nhuận.

### 4.4. Period catalog từ CSDL

Thêm endpoint read-only:

```text
GET /api/report/v1/workbook-period-options
```

Input gồm report type, period mode, preset identifiers và normalized `from/to`. Output:

```json
{
  "data_as_of": "2026-09-04",
  "source_watermark": 123,
  "current": { "from": "2026-04-01", "to": "2026-06-30" },
  "comparison_periods": [
    {
      "comparison_year": 2025,
      "label": "2025 · 01/04/2025–30/06/2025",
      "from": "2025-04-01",
      "to": "2025-06-30",
      "calendar_days": 91,
      "ops_dates_with_data": 91,
      "availability": "complete"
    }
  ]
}
```

Thêm RPC service-role-only trong migration:

`app/supabase/migrations/20260904120000_public_traffic_workbook_period_availability.sql`

RPC nhận danh sách candidate range đã được server resolve và trả số ngày có dữ liệu/coverage trong một truy vấn. Yêu cầu bảo mật:

- `SECURITY DEFINER` với `search_path` cố định.
- Revoke `public`, `anon`, `authenticated`.
- Chỉ grant `service_role`.
- Chỉ trả aggregate availability, không trả row-level data.
- Không nhận tên table, SQL fragment hoặc arbitrary sort từ client.

Candidate năm được sinh từ min/max `Ops Date` của canonical source. Chỉ những range có ít nhất một ngày dữ liệu mới xuất hiện trên UI; range thiếu một phần vẫn xuất hiện với nhãn `Thiếu dữ liệu`.

## 5. Report-neutral multi-period model

Thay các field cố định `current`, `previous`, `yearAgo` trong nhánh `PERIOD_ANALYSIS` bằng danh sách snapshot:

```ts
interface WorkbookPeriodSnapshot {
  id: string;
  role: 'current' | 'comparison';
  label: string;
  comparisonYear: number | null;
  from: string;
  to: string;
  calendarDays: number;
  metrics: WorkbookMetricSet;
  timelineDaily: WorkbookTimelineRow[];
  airlines: WorkbookDimensionMetricRow[];
  countries: WorkbookDimensionMetricRow[];
  routes: WorkbookDimensionMetricRow[];
  aircraftGroups: WorkbookDimensionMetricRow[];
  aircraftTypes: WorkbookDimensionMetricRow[];
  coverage: WorkbookCoverage;
}
```

`WorkbookReportModel` cho report mới chứa:

```ts
periods: WorkbookPeriodSnapshot[]; // current trước, comparisons giảm dần theo năm
```

Không tiếp tục thêm `yearAgo2`, `yearAgo3` hoặc cột động theo năm vào model.

Edge orchestration:

1. Fetch kỳ hiện tại và chụp `expectedVersion`, `dataAsOf`, watermark.
2. Resolve, validate toàn bộ năm đã chọn.
3. Fetch overview/dimensions của từng kỳ với concurrency giới hạn, đề xuất 3 kỳ đồng thời.
4. Mỗi response phải khớp read version và `dataAsOf` của kỳ hiện tại.
5. Nếu một kỳ lỗi hoặc version thay đổi, hủy toàn bộ export; không trả workbook thiếu kỳ.
6. Không âm thầm truncate timeline, dimension hoặc danh sách năm.
7. Resource budget được kiểm soát bằng tổng số aggregate rows, thời gian và kích thước artifact. Khi vượt budget trả lỗi `WORKBOOK_RESOURCE_BUDGET_EXCEEDED` kèm thông báo thu hẹp bộ lọc/kỳ; không dùng lỗi này như giới hạn số năm cố định.

## 6. Workbook `PERIOD_ANALYSIS`

### 6.1. Manifest

Thêm:

`app/report-templates/period-analysis/v1/manifest.json`

Danh sách sheet cố định:

1. `Tổng quan`
2. `Theo thời gian`
3. `Chi tiết Airline`
4. `Chi tiết Country`
5. `Chi tiết Route`
6. `AC Group`
7. `AC Type`
8. `Kiểm soát dữ liệu`

`data_classification`: `public-aggregate-only`.

Forbidden parts:

- raw leg/history/deleted row;
- hidden raw sheet;
- external link/connection/query;
- macro/VBA;
- credential/local path.

### 6.2. Sheet `Tổng quan`

Mỗi kỳ là một dòng:

- Loại kỳ: `Hiện tại` hoặc `So sánh`.
- Nhãn kỳ và năm so sánh.
- Từ ngày, đến ngày, số ngày.
- ARR, DEP, tổng chuyến.
- Pax đã báo cáo.
- Bình quân chuyến/ngày.
- Pax coverage và trạng thái dữ liệu.
- Chênh lệch tuyệt đối và % so với kỳ hiện tại.

Kỳ hiện tại có delta trống. Mẫu số 0/null phải cho delta % trống và ghi lý do trong trạng thái, không tạo `#DIV/0!`.

### 6.3. Sheet `Theo thời gian`

Dùng bảng dọc, một dòng cho một `Ops Date` của một kỳ:

- `PeriodId`, `Kỳ`, `Năm so sánh`.
- `Ops Date`, thứ trong tuần, ngày thứ N trong kỳ.
- ARR, DEP, tổng chuyến, Pax.
- Reported legs, due legs, coverage, completeness, Pax status.

Không ghép ngày bằng vị trí dòng để tính delta vì năm nhuận và weekday shift có thể khác nhau.

### 6.4. Các sheet dimension

Mỗi sheet dùng cùng một schema dọc:

- `PeriodId`, `Kỳ`, `Năm so sánh`, `Từ ngày`, `Đến ngày`.
- Key và nhãn dimension.
- ARR, DEP, tổng chuyến, Pax.
- Flight share, Pax share, reported/due legs, coverage, status.
- Delta và delta % so với cùng key ở kỳ hiện tại.

Key không tồn tại trong một kỳ phải được outer-join và xuất 0 nếu kỳ đó có dữ liệu hoàn chỉnh; chỉ để trống khi metric không thể kết luận do coverage/missing.

`AC Group` và `AC Type` tách thành hai sheet, không gộp lại thành một sheet `Tàu bay`.

### 6.5. Sheet `Kiểm soát dữ liệu`

Gồm metadata chung và một bảng cho từng kỳ:

- exact range và số ngày;
- request id/hash;
- template/renderer/metrics contract versions;
- `data_as_of`, watermark và projection status;
- A + D = all;
- tổng dimension so với KPI;
- unknown country;
- Pax due/missing;
- duplicate candidates quarantine;
- số dòng từng sheet;
- artifact status `FINAL` hoặc `DRAFT/PARTIAL`.

## 7. Giao diện `Phân tích theo kỳ`

Trong `TrafficWorkbookExportDialog.tsx`:

1. Thêm card `Phân tích theo kỳ`.
2. Khi chọn report này, hiển thị các mode:
   - `Một tháng`;
   - `Nhiều tháng`;
   - `Cả mùa`;
   - `Cả năm`;
   - `Khoảng ngày`.
3. Luôn hiển thị exact `Ops Date` đã resolve.
4. Checkbox `So sánh cùng kỳ` mặc định tắt.
5. Khi bật:
   - fetch `workbook-period-options`;
   - hiển thị multi-select checkbox theo năm/mùa;
   - có `Chọn tất cả` và `Bỏ chọn tất cả`;
   - năm mới nhất trước;
   - mỗi option hiển thị exact range và badge `Đủ dữ liệu`/`Thiếu dữ liệu`.
6. Nếu thay đổi mode hoặc primary range, xóa những năm không còn hợp lệ và tải lại catalog.
7. Không cho submit khi checkbox bật nhưng chưa chọn năm.
8. Loading, empty, partial và error state phải có text rõ ràng; không chỉ thay màu.
9. Điều khiển dùng keyboard được, focus visible, label/fieldset đúng, vùng danh sách dài có scroll độc lập trên mobile.

Các filter hiện tại của public report vẫn được giữ trong request. Dialog phải hiển thị tóm tắt khi có filter đang áp dụng để người dùng không xuất nhầm phạm vi.

## 8. Workbook `BAO_CAO_SAN_LUONG`

### 8.1. Phạm vi v1

- V1 chỉ nhận `period_mode=season` để giữ đúng mục đích của template và tránh biến nó thành một workbook linh hoạt thứ hai.
- UI chọn mùa và hiển thị exact `from/to`.
- Không có multi-year comparison trong report này.
- Nếu sau nghiệm thu cần custom range, phát hành `bao-cao-san-luong-v2`; không mở rộng âm thầm v1.

### 8.2. Reference và fingerprint

Reference read-only:

`C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report\docs\report_ref\BaoCaoSanLuong.xlsm`

Fingerprint hiện tại:

```text
E22F9B202524EC584C837B618744331E309593B228EFEB22585A4122C3B89672
```

Reference hiện có các sheet:

- `Table1`;
- `TOTAL`;
- `APR`–`OCT`;
- `Analysis_Airline`;
- `Analysis_Country`.

File hiện có VBA và data connection. Office Scripts không nằm trong `.xlsm`, vì vậy trước khi code adapter phải lưu bản nguồn hiện hành của cả hai Office Script làm test fixture/read-only reference.

### 8.3. Public template đã sanitize

Thêm thư mục:

`app/report-templates/bao-cao-san-luong/v1/`

Gồm:

- `manifest.json`;
- `BaoCaoSanLuong-public-v1.xlsx`;
- `cell-map.json` hoặc mapping tương đương cho các vùng renderer quản lý.

Build-time compiler tạo asset dùng được trong Edge từ bản `.xlsx` đã sanitize; runtime không đọc file từ đường dẫn OneDrive hay `docs/report_ref`.

Sanitization bắt buộc:

- đổi sang `.xlsx` macro-free;
- bỏ `Table1` raw source sheet;
- bỏ `vbaProject.bin` và quan hệ/content type liên quan;
- bỏ Power Query, connection, query table, Data Mashup và external link;
- bỏ credential, connection string và local path;
- bỏ stale `calcChain.xml`, bật full recalculation khi cần;
- giữ style, theme, column width, row height, merged cell, print area và visual structure của các report sheet;
- không dùng hidden sheet như cơ chế bảo mật.

Sau compile, scan toàn bộ ZIP part names và XML text để chứng minh không còn `vbaProject`, `externalLink`, `connections`, `queryTable`, `DataMashup`, `C:\Users\` hoặc URI nguồn cá nhân.

### 8.4. Sheet output v1

1. `TOTAL`
   - Một dòng/ngày trong toàn mùa.
   - ARR, DEP, total flights, Pax và coverage.

2. `WEEKLY`
   - Tuần nghiệp vụ Thứ Sáu–Thứ Năm.
   - Ghi rõ `WeekFrom`/`WeekTo`, không chỉ số tuần.
   - Tuần biên mùa có thể partial và phải ghi trạng thái.

3. Sheet tháng
   - Mùa hè: `APR`–`OCT` để khớp template hiện tại.
   - Mùa đông: `NOV`, `DEC`, `JAN`, `FEB`, `MAR`.
   - Ngày biên đầu mùa chưa có sheet tháng riêng vẫn phải xuất trong `TOTAL` và `WEEKLY`.
   - Mỗi sheet chỉ nhận ngày thuộc exact season range.

4. `Analysis_Airline`
   - Giữ layout/thuật ngữ của template.
   - Tái tạo kết quả của Office Script bằng backend aggregates.

5. `Analysis_Country`
   - Giữ layout/thuật ngữ của template.
   - Dùng tuần nghiệp vụ Thứ Sáu–Thứ Năm.

6. `Kiểm soát dữ liệu`
   - Metadata, reconciliation, coverage, source watermark và checksum receipt.
   - Đặt cuối workbook để không làm thay đổi luồng đọc chính của template.

Reference hiện chưa có sheet `WEEKLY` dù phân tích Office Script cho thấy script tạo/cập nhật sheet này. Phase 0 phải chạy characterization từ hai script hiện hành và chốt manifest trước khi tạo golden artifact. Không được tự suy diễn cell layout `WEEKLY` chỉ từ tên sheet.

### 8.5. Quy tắc tính toán

- Server tính và ghi values; workbook không cần chạy macro, query hay Office Script.
- Công thức Excel chỉ được giữ nếu tham chiếu các aggregate sheet public trong cùng file và vượt qua formula-error scan.
- Mọi tổng số phải reconcile với canonical KPI của cùng exact range.
- Logic `Analysis_Airline`/`Analysis_Country` phải có characterization test so với output của hai Office Script trên cùng fixture.
- Script cũ dùng fixed column index không được chuyển thẳng sang code mới; mapping phải theo field/header contract.

## 9. Feature flags và khả năng rollback

Giữ global flag hiện tại và thêm allowlist report type:

```text
NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES
TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES
```

Quy tắc:

- Nếu allowlist chưa cấu hình, chỉ các report type legacy hiện tại được phép chạy để tương thích ngược.
- Frontend chỉ hiển thị card nằm trong public allowlist.
- Backend luôn kiểm tra server allowlist; không tin frontend.
- Staging bật lần lượt `PERIOD_ANALYSIS`, sau đó `BAO_CAO_SAN_LUONG`.
- Khi nghiệm thu xong, bỏ `MASTER_OPERATIONS` khỏi allowlist nhưng chưa xóa code/manifest.
- Rollback chỉ cần khôi phục allowlist và redeploy; không rollback dữ liệu vì export là read-only.

## 10. File/module dự kiến tác động

### Modify

- `app/src/lib/trafficWorkbookExportContract.ts`
- `app/src/lib/trafficWorkbookExport.test.ts`
- `app/src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportPresentation.source.test.ts`
- `app/supabase/functions/_shared/trafficWorkbookCore.ts`
- `app/supabase/functions/_shared/trafficWorkbookRenderer.ts`
- `app/supabase/functions/traffic-report/index.ts`
- `app/scripts/traffic-report-edge-contract.test.mjs`
- `app/scripts/generate-traffic-workbook-fixtures.ts`
- `app/scripts/build-traffic-report-only.mjs`
- `app/report-templates/source-reference-fingerprints.json`
- `app/package.json`
- `app/package-lock.json` nếu script/build command thay đổi dependency metadata
- `docs/runbooks/public-traffic-report-deploy.md`

### Add

- `app/report-templates/period-analysis/v1/manifest.json`
- `app/report-templates/bao-cao-san-luong/v1/manifest.json`
- `app/report-templates/bao-cao-san-luong/v1/BaoCaoSanLuong-public-v1.xlsx`
- `app/report-templates/bao-cao-san-luong/v1/cell-map.json`
- `app/scripts/compile-traffic-workbook-templates.mjs`
- `app/supabase/functions/_shared/trafficWorkbookTemplates.generated.ts`
- `app/supabase/migrations/20260904120000_public_traffic_workbook_period_availability.sql`
- `app/supabase/tests/public_traffic_workbook_period_availability_pglite.mjs`

Tên asset/generated file có thể điều chỉnh theo convention build hiện tại, nhưng chỉ được có một nguồn template versioned và một compiler xác định; không copy binary/base64 thủ công ở nhiều nơi.

## 11. Trình tự triển khai

### Phase 0 — Baseline và characterization

1. Xác nhận `git status`, không đè các thay đổi workbook export hiện có.
2. Chạy baseline:
   - `npm run test:traffic-report-contract`;
   - `npm run build:traffic-report`.
3. Kiểm tra lại fingerprint của `BaoCaoSanLuong.xlsm`.
4. Thu thập source hiện hành của hai Office Script; lưu làm reference fixture, không dùng làm runtime.
5. Chạy script trên một bản copy dữ liệu kiểm thử và chụp:
   - sheet order;
   - used range/header;
   - vùng do từng script ghi;
   - quy tắc tạo `WEEKLY`;
   - output `Analysis_Airline` và `Analysis_Country`.

**Gate 0:** baseline xanh; manifest thực tế của template và hai script được chốt; không sửa reference gốc.

### Phase 1 — Period contract và catalog

1. Viết tests thất bại cho năm, nhiều tháng, nhiều comparison years, leap day và cross-year.
2. Mở rộng client/server period types và canonical query.
3. Thêm hàm resolve comparison range dùng chung về test vectors giữa client và server.
4. Thêm migration/RPC availability và PGlite tests.
5. Thêm endpoint `workbook-period-options` và Edge contract tests.

**Gate 1:** client/server resolve cùng exact range; catalog chỉ trả năm có dữ liệu; không có direct RPC grant cho public roles.

### Phase 2 — Multi-period fetch và report model

1. Tạo `WorkbookPeriodSnapshot`.
2. Refactor orchestration từ `previous/yearAgo` cố định sang `periods[]` cho `PERIOD_ANALYSIS`.
3. Giữ adapter tương thích cho `MASTER_OPERATIONS`, `MONTHLY_OVERVIEW_L2`, `WEEKLY_DETAIL` để tránh regression.
4. Fetch comparisons theo bounded concurrency và pin cùng version.
5. Thêm resource-budget error và test không silent truncation.

**Gate 2:** fixture có ít nhất 12 năm so sánh được xử lý đầy đủ; thay đổi version giữa chừng trả 409 và không trả artifact.

### Phase 3 — Renderer `PERIOD_ANALYSIS`

1. Thêm manifest versioned.
2. Viết sheet builders cho 8 sheet.
3. Chuyển KPI/dimension sang long-form rows.
4. Thêm reconciliation và metadata receipt cho từng kỳ.
5. Tạo golden artifact với:
   - không comparison;
   - một năm;
   - nhiều năm gồm leap year;
   - mùa đông đi qua hai năm.

**Gate 3:** sheet/header/order đúng manifest; totals khớp; số năm không làm tăng số cột; không có forbidden OOXML parts.

### Phase 4 — UI chọn kỳ và năm

1. Thêm card report và các period controls.
2. Thêm fetch lifecycle cho catalog.
3. Thêm multi-select, chọn tất cả, badge coverage và exact range preview.
4. Giữ focus, keyboard, mobile scroll, loading/error/empty states.
5. Thêm source tests và interaction tests cho reset selection khi primary range đổi.

**Gate 4:** người dùng không thể xuất năm ngoài catalog; request phản ánh đúng tất cả năm được chọn; dialog hoạt động bằng keyboard và mobile viewport.

### Phase 5 — Sanitize/compile template `BaoCaoSanLuong`

1. Tạo compiler từ reference fingerprint đã pin.
2. Loại bỏ raw source/VBA/query/connection/external parts.
3. Giữ và kiểm tra visual style/print settings của report sheets.
4. Tạo manifest/cell map và generated Edge asset.
5. Thêm negative tests khi fingerprint drift hoặc forbidden part còn tồn tại.

**Gate 5:** compiled `.xlsx` không có raw data/macro/connection/local path; fingerprint và manifest deterministic.

### Phase 6 — Renderer `BAO_CAO_SAN_LUONG`

1. Thêm report type và season-only contract.
2. Clone compiled public template và chỉ patch các vùng allowlisted.
3. Tạo `TOTAL`, `WEEKLY`, month sheets, Airline/Country analyses và control sheet.
4. So sánh kết quả với characterization fixture của Office Scripts.
5. Tạo golden artifact cho ít nhất một mùa hè và một mùa đông.

**Gate 6:** số liệu/cell ranges khớp oracle đã duyệt; Excel mở không repair/security warning; output không cần refresh.

### Phase 7 — Regression, staging và rollout

1. Chạy toàn bộ contract/build suite.
2. Render visual toàn bộ sheet của golden artifacts và review ở normal zoom.
3. Mở file bằng Excel Desktop thật:
   - không repair prompt;
   - không macro/security warning;
   - không external-link prompt;
   - dates/numbers/percent đúng type;
   - print preview không cắt tiêu đề/bảng chính.
4. Deploy staging với allowlist chỉ bật `PERIOD_ANALYSIS`.
5. Soak và đối chiếu số liệu; sau đó bật `BAO_CAO_SAN_LUONG`.
6. Sau nghiệm thu, bỏ `MASTER_OPERATIONS` khỏi UI allowlist.
7. Giữ legacy code/manifest tối thiểu một release để rollback.

**Gate 7:** staging receipts, API headers, artifact SHA, visual/desktop acceptance và rollback rehearsal đều pass.

## 12. Test matrix bắt buộc

### Date và comparison

- Một tháng 28/29/30/31 ngày.
- Nhiều tháng cùng năm và qua năm.
- Năm thường/năm nhuận.
- `Sxx` và `Wxx` qua năm.
- Custom range bắt đầu/kết thúc 29/02.
- Không comparison, một comparison, nhiều comparison, chọn tất cả.
- Ít nhất 12 comparison years để chứng minh không có hard limit 3.
- Duplicate/unsorted years canonicalize về cùng request hash.
- Năm không có dữ liệu bị từ chối.
- Năm partial được phép và gắn trạng thái.

### Data correctness

- A + D = all cho từng kỳ.
- Tổng Airline/Country/Route/AC khớp KPI theo contract.
- Filter giống nhau cho tất cả kỳ.
- Missing dimension được outer-join đúng.
- `Pax NULL` trống; `Pax 0` bằng 0.
- Current/comparison dùng cùng watermark và `data_as_of`.
- Không recompute backend-owned metrics ở frontend.

### Workbook structure

- Sheet order/name/header khớp manifest.
- Dates là typed date; count/percent có number format đúng.
- Freeze panes, autofilter/table, column width và print area hợp lý.
- Không có formula error.
- Không có raw/hidden data sheet, macro, connection, external link, credential hoặc local path.
- Artifact checksum header khớp file tải về.

### BaoCaoSanLuong parity

- `TOTAL` theo exact season range.
- `WEEKLY` đúng Thứ Sáu–Thứ Năm và boundary partial.
- S season có đúng `APR`–`OCT`; W season có đúng `NOV`–`MAR`.
- `Analysis_Airline` và `Analysis_Country` khớp characterization fixture.
- File mở trong Excel Desktop không repair/refresh/security prompt.

### UX/accessibility

- Không hiển thị năm so sánh khi checkbox tắt.
- Loading/empty/error/partial states có text.
- `Chọn tất cả` không mất lựa chọn hợp lệ.
- Đổi primary period loại bỏ selection không còn hợp lệ.
- Keyboard, focus trap, Escape, mobile viewport và screen-reader labels pass.

## 13. Verification commands dự kiến

Chạy từ `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report\app`:

```powershell
npm run test:traffic-report-contract
npm run build:traffic-report
npm run lint
```

Các kiểm tra hẹp trong lúc TDD:

```powershell
node --experimental-strip-types --test src/lib/trafficWorkbookExport.test.ts
node scripts/traffic-report-edge-contract.test.mjs
node supabase/tests/public_traffic_workbook_period_availability_pglite.mjs
```

Golden artifact verification:

- inspect workbook/sheet/table/formula;
- scan `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`;
- render và review tất cả sheet;
- unzip/scan forbidden OOXML parts/strings;
- mở bằng Excel Desktop thật và lưu acceptance receipt.

## 14. Rollout và rollback

### Rollout

1. Mặc định hai report mới tắt.
2. Deploy migration/RPC trước; kiểm tra privileges và aggregate payload.
3. Deploy Edge với server allowlist chưa bật report mới.
4. Deploy frontend.
5. Bật `PERIOD_ANALYSIS` trên staging, sau đó production canary.
6. Bật `BAO_CAO_SAN_LUONG` sau desktop acceptance.
7. Quan sát latency, lỗi resource budget, artifact size và 409 version-changed.
8. Sau soak, ẩn `MASTER_OPERATIONS` bằng allowlist.

### Rollback

- Xóa report mới khỏi frontend/server allowlist.
- Giữ endpoint legacy, `WEEKLY_DETAIL` và `MONTHLY_OVERVIEW_L2` hoạt động.
- Không cần hoàn tác production data vì các thay đổi là read-only RPC/renderer.
- Migration rollback chỉ revoke/drop function availability mới nếu thật sự cần; không sửa canonical data/view.
- Giữ compiled template version cũ để tái bật nhanh nếu renderer release mới lỗi.

## 15. Definition of Done

### `PERIOD_ANALYSIS`

- Chọn được tháng, dải tháng liên tục, mùa, năm và custom range.
- Chọn được bất kỳ số năm/mùa có dữ liệu mà không có hard limit số lượng.
- Workbook luôn có đúng 8 sheet và dùng long-form period rows.
- Tất cả kỳ dùng cùng read version, watermark, `data_as_of` và filters.
- Số liệu, delta, coverage, Pax null và reconciliation đúng contract.

### `BAO_CAO_SAN_LUONG`

- Output `.xlsx` giữ visual/semantic layout đã duyệt của template.
- Có `TOTAL`, `WEEKLY`, month sheets, `Analysis_Airline`, `Analysis_Country` và control sheet theo manifest.
- Kết quả chính khớp Office Script characterization fixture.
- Không có raw data, macro, query, connection, external link, credential hoặc local path.
- Mở bằng Excel Desktop không repair, refresh hoặc security prompt.

### Vận hành

- Full contract tests, SQL tests, build, lint, golden artifacts và visual verification pass.
- Staging và production canary có receipt gồm request id/hash, artifact SHA, watermark và `data_as_of`.
- Rollback bằng allowlist đã được diễn tập.
- `MASTER_OPERATIONS` chỉ bị ẩn sau khi hai report mới được nghiệm thu; chưa xóa code trong cùng release.

## 16. Điểm cần người thực hiện lưu ý

- Reference `BaoCaoSanLuong.xlsm` và Office Script chỉ là oracle về layout/logic; canonical backend mới là nguồn số liệu production.
- Không dùng `XLSX.read() → write()` để round-trip template phức tạp rồi giả định mọi style/relationship được bảo toàn.
- Không bật refresh-on-open trong public `.xlsx`; connection cũ có thể ghi đè dữ liệu đã render.
- Không tạo cột mới cho mỗi năm so sánh.
- Không giới hạn năm bằng UI constant 3/5/10; nếu artifact quá lớn phải trả lỗi resource budget minh bạch.
- Không thay `Pax NULL` bằng 0, kể cả trong delta và biểu đồ.
- Không sửa hoặc xóa hai artifact root không liên quan trong sibling worktree:
  - `kpi-missing-pax-2026-through-2026-08-30.csv`;
  - `traffic-report-ui-20260830T1530Z.tar.gz`.
