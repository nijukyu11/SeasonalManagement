# Kế hoạch triển khai heatmap giờ cao điểm và cao điểm theo thứ trong tuần

**Ngày lập:** 2026-09-04  
**Trạng thái:** Đã triển khai và kiểm thử local ngày 2026-09-04; chưa staging/production deploy  
**Phạm vi:** Public Traffic Report `/reports/traffic` trong `SeasonalManagement-web-traffic-report`  
**Kết quả hiện tại:** source, migration, test và report-only artifact đã hoàn tất; staging/production rollout chờ phê duyệt riêng

## 1. Mục tiêu

1. Giữ biểu đồ tổng quan hiện có ở trước, bổ sung heatmap breakdown ngay bên dưới cho hai nhóm phân tích:
   - giờ cao điểm theo 24 khung giờ;
   - cao điểm theo thứ trong tuần, từ Thứ 2 đến Chủ nhật.
2. Heatmap giờ cao điểm cho phép xem từng Ops Date, gom gọn theo tháng, đổi `Cả hai / Chuyến bay đến / Chuyến bay đi` và `Giờ địa phương / UTC` đồng bộ với biểu đồ phía trên.
3. Heatmap theo thứ trong tuần hiển thị trung bình theo từng tháng, với cột `Thứ 2 → Chủ nhật` và cùng phạm vi chuyến bay với biểu đồ phía trên.
4. Highlight rõ ngày hoặc thứ có sản lượng cao nhất mà không chỉ dựa vào màu.
5. Mọi giá trị trung bình hiển thị dưới dạng số nguyên đã làm tròn; không dùng tổng chuyến của cả tháng thay cho trung bình.
6. Giữ đúng semantics dữ liệu công khai: `0` là số 0 đã xác nhận, còn `—` là thiếu/chưa đủ dữ liệu.
7. Tiếp tục giữ report aggregate-only; không đưa flight identity, record id hoặc raw schedule ra trình duyệt.

## 2. Hiện trạng liên quan

### 2.1. Frontend

- `app/src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx`
  - `PeakHourChart` đang hiển thị biểu đồ 24 giờ, selector A/D/all, Local/UTC, bảng dữ liệu 24 giờ và bảng peak theo tháng.
  - `DayOfWeekChart` đang hiển thị 7 cột Thứ 2–Chủ nhật với trung bình và khoảng thấp nhất–cao nhất của toàn phạm vi.
- `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`
  - truyền `peak_hour`, `peak_hour_monthly` và `day_of_week` từ overview bundle vào hai chart.
- `app/src/lib/trafficReportOperationalHours.ts`
  - đã có thứ tự giờ vận hành Local `05:00 → 04:00 +1` và UTC `22:00 → 21:00 +1`.

### 2.2. Contract/API/database

- `app/src/lib/trafficReportContract.ts` mới có:
  - 24 bucket tổng phạm vi;
  - một peak hour cho từng tháng;
  - aggregate theo thứ trong tuần của toàn phạm vi.
- `reporting.get_traffic_report_breakdowns(...)` chưa trả ma trận Ops Date × giờ.
- `reporting.get_traffic_report_monthly_peaks_v2(...)` hiện trả tổng số chuyến trong bucket peak của tháng; giá trị này không đáp ứng yêu cầu mới là trung bình chuyến/ngày trong khung giờ.
- Overview bundle không nên chứa toàn bộ ma trận 24 × số ngày vì phạm vi báo cáo có thể dài và phần lớn tháng đang ở trạng thái thu gọn.

### 2.3. Ràng buộc worktree

- Repo đang có thay đổi chưa commit liên quan workbook export và các file triển khai khác.
- Khi bắt đầu implementation phải lập inventory/diff trước, chỉ sửa đúng touchpoint của heatmap và không ghi đè phần workbook đang làm dở.

## 3. Quyết định đã chốt

| ID | Quyết định |
|---|---|
| D1 | Mỗi nhóm luôn có biểu đồ tổng quan trước và heatmap breakdown sau. |
| D2 | Heatmap giờ cao điểm dùng từng Ops Date làm hàng, 24 khung giờ làm cột và gom bằng accordion theo tháng. |
| D3 | Trong mỗi tháng có dòng `TB tháng` ở đầu ma trận; từng ô là trung bình chuyến/ngày trong đúng khung giờ, không phải tổng chuyến của tháng. |
| D4 | Các dòng Ops Date phía dưới `TB tháng` hiển thị số chuyến thực tế của ngày/khung giờ đó. |
| D5 | Mọi số trung bình được backend làm tròn số nguyên trước khi trả cho frontend. Frontend không tự tính lại metric backend-owned. |
| D6 | Ngày có tổng chuyến cao nhất trong từng tháng được highlight toàn hàng. Nếu hòa và giá trị lớn hơn 0, highlight tất cả ngày đồng hạng. |
| D7 | Local/UTC chỉ đổi bucket giờ và thứ tự cột; không đổi Ops Date. |
| D8 | Heatmap Mon–Sun dùng hàng là tháng, cột là Thứ 2–Chủ nhật, ô là trung bình số chuyến của thứ đó trong tháng. |
| D9 | Ô cao nhất của từng tháng trong heatmap Mon–Sun được highlight; nếu hòa và lớn hơn 0, highlight tất cả ô đồng hạng. |
| D10 | Cả chart và heatmap dùng cùng scope A/D/all, cùng filter và cùng quy tắc denominator. |
| D11 | Dùng một thang màu tuần tự thống nhất trên toàn phạm vi đang chọn để so sánh được giữa các tháng; giá trị số luôn hiện trong ô. |
| D12 | Heatmap giờ theo tháng được tải khi người dùng mở tháng; breakdown Mon–Sun nhỏ nên có thể trả cùng overview bundle. |
| D13 | Không mở rộng Excel/workbook export trong hạng mục này. |

## 4. Định nghĩa metric và công thức

### 4.1. Ngày hợp lệ cho trung bình

Mỗi Ops Date phải có trạng thái coverage rõ ràng:

- `complete`: được tính vào mẫu số; nếu không có chuyến sau filter thì giá trị là `0`.
- `partial`: vẫn có thể hiển thị dòng thực tế trong heatmap ngày nhưng không được tính vào dòng trung bình đã chứng nhận; UI phải đánh dấu dữ liệu chưa đầy đủ.
- `missing/unpublished`: không tính vào mẫu số và mọi ô hiển thị `—`.

Không dùng `generate_series + coalesce(0)` nếu chưa chứng minh ngày đó là `complete`.

### 4.2. Trung bình giờ theo tháng

Với tháng `m`, bucket giờ `h` và scope `s`:

```text
average_hour_flights(m, h, s)
  = round(
      sum(flights của bucket h trên các Ops Date complete thuộc tháng m và scope s)
      / count(Ops Date complete thuộc tháng m trong phạm vi lọc)
    )
```

Quy tắc:

- khoảng chọn chỉ đi qua một phần tháng thì chỉ dùng phần giao giữa tháng và `from/to`;
- ngày `complete` có 0 chuyến vẫn nằm trong mẫu số;
- nếu mẫu số bằng 0 thì trả `null`, UI hiển thị `—`;
- `round(...)` thực hiện trong SQL/RPC và trả integer;
- A/D/all dùng đúng tập bản ghi của scope đang chọn;
- không hiển thị `sum(flights)` của cả tháng trong ô heatmap hoặc dòng `TB tháng`.

Tóm tắt accordion tháng dùng:

```text
Tháng 8/2026 · TB 153 chuyến/ngày · Cao nhất 18/08: 164 chuyến
```

`TB chuyến/ngày` cũng là `round(sum daily flights / complete_day_count)`, không phải tổng tháng.

### 4.3. Trung bình theo thứ trong tuần của tháng

Với tháng `m`, thứ `d` và scope `s`:

```text
average_weekday_flights(m, d, s)
  = round(
      sum(flights của các Ops Date complete có ISO weekday = d)
      / count(Ops Date complete có ISO weekday = d)
    )
```

- `d = 1..7`, tương ứng Thứ 2 đến Chủ nhật.
- Cell phải kèm `valid_day_count` để tooltip/aria-label giải thích mẫu số.
- Chart 7 cột phía trên phải dùng tổng chuyến chia tổng số ngày hợp lệ của từng thứ trên toàn phạm vi, không lấy trung bình không trọng số của các average theo tháng.

### 4.4. Làm tròn và tie-break

- Giá trị average công bố: số nguyên sau `round`.
- Highlight peak day dùng tổng chuyến thực tế trước khi làm tròn.
- Highlight peak weekday dùng average chưa làm tròn để xác định đồng hạng; số hiển thị vẫn là integer.
- Peak hour khi hòa dùng bucket xuất hiện sớm hơn theo thứ tự ngày vận hành:
  - Local: `05:00 → 04:00 +1`;
  - UTC: `22:00 → 21:00 +1`.

## 5. Thiết kế UX chi tiết

### 5.1. Khối giờ cao điểm

Thứ tự:

```text
Tiêu đề + mô tả
Selector Cả hai / Chuyến bay đến / Chuyến bay đi
Selector Giờ địa phương / UTC
Biểu đồ 24 khung giờ hiện tại
Chú thích
Heatmap breakdown theo ngày, gom theo tháng
Bảng dữ liệu 24 giờ và thông tin chuyến thường lệ hiện có
```

Mỗi accordion tháng:

- summary hiển thị tháng, số ngày hợp lệ, trung bình chuyến/ngày và ngày cao nhất;
- mặc định chỉ mở tháng chứa `toDate`; các tháng khác đóng;
- mở tháng mới bắt đầu tải aggregate heatmap của tháng đó;
- cache kết quả theo filter hash + scope + timezone + tháng + `data_as_of`;
- khi đổi scope/timezone/filter, hủy request cũ và không hiển thị dữ liệu stale.

Cấu trúc ma trận:

```text
Ngày / Giờ | 05:00 | 06:00 | ... | 23:00 | 00:00 | ... | 04:00
TB tháng   |   4   |   6   | ... |  11   |   7   | ... |   2
01/08      |   3   |   5   | ... |  10   |   8   | ... |   1
02/08      |   4   |   7   | ... |  12   |   6   | ... |   2
```

Highlight:

- hàng ngày cao nhất tháng có viền nhấn + badge chữ `Cao nhất tháng` tại cột ngày;
- không dùng màu đỏ đơn độc để truyền đạt peak;
- nếu toàn bộ ngày hợp lệ đều 0 thì không gắn badge peak, summary ghi `Không có chuyến`.

Responsive/accessibility:

- dùng table semantic với `<th scope="col">` và `<th scope="row">`;
- sticky header và sticky cột ngày;
- wrapper `overflow-x-auto`, có cue “Vuốt ngang để xem đủ 24 khung giờ” trên mobile;
- không biến mọi cell thành một tab stop; vùng scroll nhận focus, cell có text/`aria-label` đầy đủ;
- summary có touch target tối thiểu 44px và trạng thái expanded được native `<details>` công bố;
- loading/error/empty state nằm ngay trong tháng đang mở, có nút `Thử lại` khi lỗi.

### 5.2. Khối cao điểm theo thứ trong tuần

Đổi nhãn section để tránh hiểu là một ngày calendar cụ thể:

- eyebrow: `Mẫu khai thác theo tuần`;
- title: `Cao điểm theo thứ trong tuần`;
- mô tả: trung bình chuyến của Thứ 2–Chủ nhật trong phạm vi đã chọn.

Thứ tự:

```text
Tiêu đề + selector Cả hai / Chuyến bay đến / Chuyến bay đi
Biểu đồ 7 cột Thứ 2–Chủ nhật
Chú thích min–max và trung bình
Heatmap breakdown trung bình theo tháng
```

Heatmap:

```text
Tháng   | Thứ 2 | Thứ 3 | Thứ 4 | Thứ 5 | Thứ 6 | Thứ 7 | Chủ nhật
08/2026 |  145  |  148  |  151  |  150  |  158  |  162  |    156
09/2026 |  151  |  153  |  155  |  154  |  161  |  166  |    160
```

- mỗi cell là average đã làm tròn, không phải tổng chuyến;
- cell peak của mỗi tháng có viền + marker chữ/symbol có giải thích trong legend;
- tooltip/aria-label: `Tháng 8/2026, Thứ 7, trung bình 162 chuyến từ 5 ngày hợp lệ`;
- partial/missing không đổi thành 0; có marker `Chưa đủ dữ liệu` khi coverage không đạt;
- bảng chỉ có 7 cột dữ liệu nên hiển thị toàn bộ, không dùng accordion theo tháng trừ khi phạm vi vượt quá 24 tháng;
- nếu vượt 24 tháng, nhóm theo năm để tránh danh sách quá dài.

### 5.3. Thang màu

- dùng 5 mức màu tuần tự từ slate/blue nhạt đến blue đậm, dựa trên token hiện có của report;
- scale tính trên toàn bộ dữ liệu hợp lệ trong phạm vi đang xem để các tháng so sánh được với nhau;
- text tự đổi sáng/tối theo mức nền để đạt contrast;
- cell luôn có số hoặc `—`; màu không phải phương tiện duy nhất;
- peak dùng viền/badge riêng, không đồng nhất “màu đậm nhất” với “peak” vì có thể có tie hoặc dữ liệu partial.

## 6. Contract dữ liệu đề xuất

### 6.1. Endpoint heatmap giờ theo tháng

Thêm endpoint aggregate riêng, ví dụ:

```text
GET /api/report/v1/peak-hour-heatmap
  ?from=2026-08-01
  &to=2026-08-31
  &type=all
  &tz=local
  &airline=...
  &route=...
  &country=...
```

Response đề xuất:

```ts
interface TrafficPeakHourHeatmapResponse {
  contract_version: 'traffic-report-v1';
  request_hash: string;
  data_as_of: string;
  source_watermark: number | 'unknown';
  metadata: {
    from: string;
    to: string;
    type: 'all' | 'A' | 'D';
    time_basis: 'local' | 'utc';
    bucket_minutes: 60;
    selected_day_count: number;
    complete_day_count: number;
    partial_day_count: number;
    missing_day_count: number;
    average_daily_flights: number | null;
  };
  monthly_average: Array<{
    hour_bucket: string;
    average_flights: number | null;
  }>;
  days: Array<{
    ops_date: string;
    completeness: 'complete' | 'partial' | 'missing';
    flights: number | null;
    is_month_peak: boolean;
    buckets: Array<{
      hour_bucket: string;
      flights: number | null;
    }>;
  }>;
}
```

Contract không chứa `record_id`, `flight_number`, `business_leg_key`, raw STA/STD hoặc danh sách chuyến.

### 6.2. Breakdown Mon–Sun theo tháng

Mở rộng `breakdowns` của overview bằng trường optional để tương thích rollout:

```ts
interface TrafficMonthlyDayOfWeekRow {
  month: string;
  day_index: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  selected_day_count: number;
  complete_day_count: number;
  average_flights: number | null;
  average_arrivals: number | null;
  average_departures: number | null;
  status: 'complete' | 'partial' | 'missing';
}

breakdowns: {
  day_of_week: TrafficDayOfWeekRow[];
  day_of_week_monthly?: TrafficMonthlyDayOfWeekRow[];
}
```

Để chart phía trên dùng cùng công thức, bổ sung vào `TrafficDayOfWeekRow`:

- `complete_day_count`;
- `average_arrivals`;
- `average_departures`;
- `status`.

Các field mới để optional trong bước tương thích; UI cũ tiếp tục render khi backend chưa rollout.

## 7. Database/RPC plan

### 7.1. Migration mới

- Tạo migration mới theo timestamp tại `app/supabase/migrations/`; không sửa lại migration lịch sử.
- Tạo helper nội bộ cho heatmap giờ theo ngày/tháng và helper monthly weekday.
- Nguồn duy nhất: `reporting.public_traffic_effective` + coverage/publication ledger hiện có.
- Áp đủ filter types/airline/route/country/aircraft group giống overview.
- Dùng `local_minutes` hoặc `utc_minutes`; bucket 60 phút.
- Trả aggregate đã xếp thứ tự theo operational day.
- Mọi helper `reporting.*` bị revoke khỏi `public`, `anon`, `authenticated`, `service_role`.
- Chỉ public wrapper cần thiết được grant cho `service_role`; browser vẫn đi qua Edge.
- Migration phải apply được hai lần trong PGlite rehearsal.

### 7.2. Tính toán backend-owned

SQL chịu trách nhiệm:

- coverage classification;
- denominator của average;
- `round` về integer;
- daily peak và tie;
- monthly weekday peak và tie;
- status complete/partial/missing;
- request hash/data version pinning.

Frontend chỉ chọn đúng field theo scope và render; không cộng/chia lại số backend trả về.

### 7.3. Performance budget

- RPC heatmap giờ chỉ nhận tối đa phạm vi giao với một tháng trong mỗi request.
- Tối đa khoảng `31 × 24 = 744` cell/tháng/scope.
- Index/plan phải giữ filter trên `ops_date` làm điều kiện đầu tiên.
- Mục tiêu P95 nội bộ cho một tháng: dưới 300ms trên snapshot đã refresh.
- Không truy vấn row-level nhiều lần theo từng ngày; dùng một aggregate query theo tháng.

## 8. Edge/API plan

Trong `app/supabase/functions/traffic-report/index.ts`:

1. Thêm endpoint allowlist `peak-hour-heatmap`.
2. Dùng cùng parser/canonical query/filter limits của report hiện tại.
3. Giới hạn request heatmap tối đa một tháng sau khi intersect với global range.
4. Gọi public aggregate wrapper bằng service role.
5. Validate response shape trước khi trả.
6. Cache theo canonical query + `data_as_of`/watermark; Local và UTC là hai cache key khác nhau.
7. Giữ CORS/same-origin, rate limit và header cache hiện hành.
8. Lỗi trả thông điệp nghiệp vụ; không lộ SQL/RPC/raw config.

## 9. Frontend plan

### 9.1. Contract/helper

- Thêm types và validators trong `trafficReportContract.ts`.
- Thêm URL builder cho endpoint heatmap.
- Mở rộng helper operational hours nếu cần để dùng một thứ tự bucket chung giữa chart và heatmap.
- Không tạo helper average ở frontend.

### 9.2. Component

Tách component để `TrafficReportAdvancedCharts.tsx` không tiếp tục phình lớn:

- `TrafficPeakHourHeatmap.tsx`
  - accordion tháng;
  - fetch/abort/cache theo tháng;
  - render dòng `TB tháng` và các Ops Date;
  - highlight peak day;
  - loading/error/empty state cục bộ.
- `TrafficMonthlyDayOfWeekHeatmap.tsx`
  - render ma trận tháng × Mon–Sun;
  - scope A/D/all;
  - highlight peak weekday;
  - tooltip/aria-label coverage.

`PeakHourChart` và `DayOfWeekChart` giữ chart chính, truyền state scope/timezone xuống breakdown tương ứng để chart và bảng không lệch nhau.

### 9.3. State và lifecycle

- Heatmap giờ chỉ fetch tháng đang mở.
- Cache in-memory theo canonical key trong vòng đời trang.
- Khi filter, scope hoặc timezone đổi:
  - abort request đang chạy;
  - bỏ active tooltip;
  - không tái sử dụng response khác key;
  - tháng gần `toDate` trở thành tháng mặc định mở.
- Nếu backend chưa có field monthly weekday trong giai đoạn rollout, ẩn breakdown mới nhưng giữ chart cũ hoạt động.

## 10. Test plan

### 10.1. Contract/unit

- Validator chấp nhận payload hợp lệ và từ chối:
  - sai Ops Date/hour bucket;
  - average không phải integer/null;
  - thiếu đủ 24 bucket;
  - day index ngoài 1–7;
  - raw flight identity xuất hiện trong payload.
- Test thứ tự Local/UTC.
- Test tie peak theo operational order.
- Test A/D/all trả đúng số.

### 10.2. PGlite/database

Fixture phải bao phủ:

- hai tháng và đủ Mon–Sun;
- ngày complete có chuyến;
- ngày complete zero;
- ngày partial;
- ngày missing;
- nhiều ngày đồng peak;
- bucket hòa peak trước/sau nửa đêm;
- Local/UTC dịch đúng bucket nhưng giữ Ops Date;
- range chỉ lấy một phần tháng;
- filter airline/route/country;
- average có phần thập phân và được làm tròn integer.

Assertions chính:

- tổng bucket ngày bằng daily total cho ngày complete/observed;
- `TB tháng` dùng average chứ không dùng sum;
- zero complete nằm trong denominator;
- missing/partial không bị biến thành zero chứng nhận;
- weekday average dùng đúng số lần xuất hiện của từng thứ;
- apply migration hai lần không lỗi;
- service role chỉ gọi public wrapper, không đọc snapshot/helper trực tiếp.

### 10.3. UI/source tests

- chart xuất hiện trước heatmap trong DOM.
- monthly average row xuất hiện trước daily rows.
- tất cả average hiển thị integer.
- highlight peak có badge/text, không chỉ màu.
- scope/timezone thay đổi cả chart và breakdown.
- loading/error/empty/retry nằm trong đúng accordion.
- mobile cue, scroll region, sticky header/first column và focus ring tồn tại.
- không có mojibake trong nhãn tiếng Việt.

### 10.4. Build/browser QA

- `npm run test:traffic-report-contract`.
- targeted ESLint và `tsc --noEmit`.
- `npm run build:traffic-report`.
- Browser QA tại 375px, 768px, 1440px:
  - mở/đóng tháng;
  - cuộn ngang 24 giờ;
  - Local ↔ UTC;
  - A/D/all;
  - filter nhiều tháng và partial month;
  - keyboard navigation và reduced motion;
  - không có console/network error.

## 11. Trình tự triển khai đề xuất

### Phase 0 — Chốt baseline

1. Ghi nhận `git status`, diff và test baseline của repo đang dirty.
2. Xác định owner của các thay đổi workbook; không sửa/format lan sang các file đó.
3. Chụp contract/API hiện tại cho một range mẫu Local/UTC.

### Phase 1 — Contract và test đỏ

1. Viết type/validator/URL-builder tests.
2. Viết PGlite fixture và assertions cho công thức average/coverage/tie.
3. Viết source tests cho thứ tự chart → heatmap và accessibility.

### Phase 2 — SQL/RPC

1. Thêm migration mới.
2. Implement heatmap giờ một tháng và monthly weekday aggregates.
3. Revoke/grant đúng boundary.
4. Chạy migration hai lần và kiểm tra query plan/resource budget.

### Phase 3 — Edge/API

1. Thêm endpoint heatmap giờ.
2. Mở rộng overview breakdown cho monthly weekday.
3. Bổ sung cache/version/error contract.
4. Chạy Edge contract/isolation tests.

### Phase 4 — UI

1. Tạo hai component heatmap.
2. Nối scope/timezone với chart hiện tại.
3. Thêm highlight, legend, sticky table và states.
4. Kiểm tra mobile/a11y/UTF-8.

### Phase 5 — Verification và release candidate

1. Chạy full report contract, PGlite, isolation, lint, typecheck và build.
2. Tạo report-only artifact; ghi hash và file count.
3. Chưa deploy production nếu chưa có authorization riêng.

### Phase 6 — Staging/production khi được phê duyệt

1. Schema backup và clone rehearsal hai lần.
2. Apply migration bằng account được phê duyệt.
3. Refresh snapshot và xác minh watermark/data-as-of.
4. Deploy staging, browser acceptance Local/UTC/A/D/all.
5. Switch production symlink/release.
6. Xác minh API/cache/UI/public URL và quyền truy cập.
7. Giữ release trước để rollback.

## 12. Rollback

- UI: feature flag hoặc optional contract field cho phép ẩn hai heatmap và quay lại chart cũ.
- API: endpoint mới có thể ngừng route mà không ảnh hưởng overview hiện có.
- Database: migration rollback chỉ remove wrapper/helper mới sau khi UI/API đã quay về bản cũ; không drop snapshot/canonical views.
- Release: switch lại symlink release trước và purge đúng cache route mới.
- Sau rollback phải kiểm tra:
  - chart 24 giờ cũ;
  - chart Mon–Sun cũ;
  - overview API;
  - Excel/workbook export không bị ảnh hưởng;
  - internal helper vẫn không callable bởi anon/authenticated/service role.

## 13. Definition of Done

Hạng mục chỉ được coi là hoàn tất khi:

- giờ cao điểm hiển thị chart trước và daily heatmap theo tháng sau;
- mỗi tháng có dòng `TB tháng`, từng bucket là average chuyến/ngày đã làm tròn integer;
- daily rows giữ số thực tế và highlight mọi ngày đồng peak trong tháng;
- Local/UTC và A/D/all đồng bộ giữa chart và heatmap;
- cao điểm theo thứ hiển thị chart Mon–Sun trước và heatmap average theo tháng sau;
- chart và heatmap dùng cùng denominator, không có average-of-averages sai trọng số;
- complete zero là `0`, missing là `—`, partial được ghi rõ và không giả thành complete zero;
- payload công khai chỉ có aggregate, không lộ raw flight identity;
- tests contract/PGlite/isolation/UI/typecheck/build đều pass;
- browser QA mobile/desktop không vỡ layout, keyboard và screen reader đọc được;
- artifact, migration receipt, data version, cache và rollback evidence đầy đủ;
- production chỉ được cập nhật sau authorization riêng và kiểm chứng trực tiếp trên URL công khai.
