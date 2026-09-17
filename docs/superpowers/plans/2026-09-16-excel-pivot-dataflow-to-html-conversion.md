# Phân tích luồng dữ liệu Pivot Excel và phương án chuyển đổi sang báo cáo HTML kết xuất

**Ngày lập:** 2026-09-16
**Trạng thái:** Đề xuất — chưa sửa code (phiên phân tích, không triển khai)
**Đối tượng đích:** runtime kết xuất HTML trên nhánh `codex/web-traffic-report`
(worktree `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report`),
các file `app/supabase/functions/_shared/trafficHtml*.ts` và RPC
`public.get_public_traffic_html_export_v2` (migration `20260906120000_public_traffic_html_pivot_v2.sql`).

**Vị trí tài liệu (quan trọng):** file này nằm trên nhánh `main` (cùng chỗ với plan 09-13) và **chỉ là kế hoạch**.
Toàn bộ mã nguồn runtime/RPC được tham chiếu ở đây (`app/supabase/functions/_shared/trafficHtml*.ts`,
`app/supabase/migrations/2026090*_public_traffic_html_*.sql`, `app/supabase/tests/...`) **chỉ tồn tại trên nhánh
`codex/web-traffic-report`** — khi triển khai phải mở worktree `SeasonalManagement-web-traffic-report`;
các đường dẫn này không có trên `main`.

**Nguồn bằng chứng (đã trích xuất trực tiếp):**
- 6 workbook trong `docs/report_ref/`: đọc thẳng `xl/pivotCache/pivotCacheDefinition*.xml`,
  `xl/pivotTables/pivotTable*.xml`, `xl/charts/chart*.xml` (ElementTree) và giá trị ô (openpyxl).
- Code runtime + RPC: đọc trực tiếp trong worktree (số dòng tham chiếu ghi kèm).

---

## 0. Kết luận điều hành

1. **5/6 workbook vận hành theo đúng một khuôn luồng dữ liệu:**
   `Data` (bản sao paste từ app) → **pivot cache dùng chung** → **pivot table** (Rows/Columns/Page
   filters) → sheet trình bày → chart. `BaoCaoSanLuong.xlsm` là ngoại lệ: **không có pivot**,
   thuần công thức + 7 chart.
2. **Excel lưu snapshot chết, không lưu truy vấn.** Cùng một cache phục vụ nhiều sheet với page
   filter khác nhau và **giá trị đã render vẫn nằm nguyên trong ô** ⟹ 4 sheet của
   `SanLuongAPR.xlsx` đang phơi 2 mốc thời gian khác nhau (Apr và 26/04–02/05) dù cả 4 pivot đều
   đang để `Ops Date = ALL`. HTML **không được** tái tạo hành vi này.
3. **Excel còn một loại "số 0 giả" nguy hiểm:** `Airline` (Week) tuần 21–22 và `DayFilter` từ
   15/05 có `Count of Flight > 0` nhưng `Sum of Pax = 0` — hành khách về sau chuyến. HTML v2 đã có
   đúng ngữ nghĩa (`reported_legs`, `missing_due_legs`, `pax_status`) nhưng giao diện chưa phơi
   chỉ báo độ phủ ở các bảng chính.
3b. **⚠️ Cột `weeknum` trùng tên nhưng khác ngữ nghĩa giữa các workbook** — `Week!weeknum` là tuần
   nghiệp vụ **T6–T5** (đánh số bằng tuần ISO của ngày Thứ Sáu mở tuần: 2026-03-30 → `13`), còn
   `Week!isoweek` và `Weeknum` của S26/Country là **tuần ISO** (2026-03-30 → `14`); thêm 130 dòng
   `Week!weeknum` sai do kéo công thức. Chi tiết + mẫu ở §1.1; hệ quả: preset phải tách hai trục
   tuần (A1) và cần mục nghiệm thu riêng (D-04).
4. **HTML v2 hiện đã phủ phần lớn chiều phân tích của Excel**: ma trận Chỉ tiêu × trục thời gian
   (Tháng / Toàn kỳ / Tuần ISO / Tuần T6–T5 / Thứ), phân cấp Hãng→Chặng, Thị trường→Chặng→Hãng,
   Chặng→Hãng, Đội tàu (nhóm × loại), 24 khung giờ, Tần suất (● theo thứ + độ ổn định), phân tích
   chênh lệch **có CTG (%)** (`trafficHtmlPivotRuntime.ts:649-653`) — tương đương
   `Analysis_Airline/Country`, `Airline`, `Country`, `Routes`, `Month`, `Frequency`, `30days` của Excel.
5. **Còn 7 khoảng trống dữ liệu/hình thức cần bù** (chi tiết ở §3.3):
   G1 hạt 30 phút, G2 ma trận Ngày × Khung giờ, G3 `Config` = số ghế → Load factor,
   G4 trục Quý và trục "Ngày trong tháng 1..31", G5 chi tiết cấp chuyến
   (`Flight`/`STA-STD`/`Note`/`UTC`/`A/C Type` cấp số hiệu), G6 chart **theo tuần** + preset cặp kỳ
   (chart tháng ARR/DEP + đường Tổng **đã có sẵn**, xem `monthChart`), G7 **dải tổng hợp đầu file**
   (dataset `kpi` đã nằm trong file nhưng chưa được vẽ).
6. **Phương án khuyến nghị:** mở rộng **hợp đồng dữ liệu v3 (nhỏ, có kiểm soát)** + hoàn thiện
   runtime theo mẫu Excel, **không** nhúng lại giá trị tĩnh của workbook, **không** nhúng bảng fact
   thô toàn mùa (vượt ngân sách). Chia 4 gói thi công độc lập A→D ở §4.

---

## 1. Nguồn dữ liệu gốc `Data` và các cột phái sinh

Mọi pivot trong 5 workbook đều trỏ về **một sheet `Data`** (bản sao dán từ app) hoặc **Data Model
(Power Pivot/OLAP)** dựng từ chính các cột đó.

**Cột nguồn (đã kiểm chứng trên `SanLuong_S26.xlsm!Data`, 16 cột, 25.942 dòng):**

| Cột | Ý nghĩa | Kiểm chứng |
| :--- | :--- | :--- |
| `Type` | Chiều bay `A`/`D` (+ item "(Multiple Items)") | sharedItems `<s v="A"/><s v="D"/>` |
| `Flight` | Số hiệu chuyến (vd `Z2822`) | mẫu dòng 1–3 |
| `Config` | **Số ghế cấu hình của chuyến** (180/188/199) | giá trị số, không phải nhãn |
| `STA/STD` | Giờ đến/đi theo giờ địa phương | `2026-03-29 07:35` |
| `Routes` | Chặng (IATA, vd `MNL`, `HKG`) | 67 giá trị |
| `Pax` | Hành khách đã ghi nhận (`0` khi chưa có) | mẫu dòng |
| `Note` | Trạng thái khai thác (`Bags Delivered`, `Departed`, …) | mẫu `Detail1` |
| `Airlines` | Hãng (55 giá trị) | mẫu |
| `Ops Date` | Ngày khai thác (00:00) | mẫu |
| `Country` | Thị trường (21 giá trị) | mẫu |
| `Weeknum` / `weeknum` | **Khác ngữ nghĩa theo từng file** — xem cảnh báo dưới bảng | kiểm chứng **toàn bộ dòng**: S26 25.942/25.942 và Country 37.369/37.369 = tuần ISO; Week `isoweek` 26.610/26.610 = ISO; Week `weeknum` 26.480/26.610 = tuần nghiệp vụ T6–T5 |
| `UTC` | Timestamp UTC thực | `2026-03-29 00:35` |
| `HourUTC` | Giờ UTC 0..23 | khớp `UTC.hour` |
| `A/C Type` | Loại tàu (320, 321, 330, 332, 333, 738, 789, 32N, 32Q, 7M8, E90, AT7, 77W) | pivot `ACType` |
| `DayIdex` | **Ngày trong tháng 1..31** | khớp `Ops Date.day` |
| `Weekday` | Thứ (Sun..Sat) | mẫu |

**Cột phái sinh xuất hiện thêm ở một số cache:** `isoweek` (**khác** `weeknum` ở file Week — xem cảnh báo dưới),
`Days/Months/Years (Ops Date)`, `Days/Months/Years (UTC)`, `HourUTC2` (nhãn khung 30 phút dùng làm
trục cột của `PeakHour`), `Config2` (lớp tàu `Tàu nhỏ`/`Tàu to`), `Quarters (Ops Date)` (chỉ có
trong `SanLuong_Country_2026.xlsx`). Bản `- Copy` của S26 có thêm `HourUTC2` và bộ `(UTC)`.

### 1.1 ⚠️ Cùng tên cột `weeknum` nhưng khác ngữ nghĩa giữa các workbook

Kiểm chứng toàn bộ dòng (openpyxl đọc `Data`, đối chiếu `date.isocalendar()` và ranh giới T6–T5):

| File | Cột | Ngữ nghĩa | Khớp |
| :--- | :--- | :--- | :--- |
| `SanLuong_Week_S26.xlsx` | `weeknum` | **Tuần nghiệp vụ T6–T5**, đánh số bằng *số tuần ISO của ngày Thứ Sáu mở tuần* | 26.480/26.610 (99,51%) |
| `SanLuong_Week_S26.xlsx` | `isoweek` | **Tuần ISO** (Thứ Hai → Chủ nhật) của chính ngày | 26.610/26.610 (100%) |
| `SanLuong_S26.xlsm` (+ bản `- Copy`) | `Weeknum` | **Tuần ISO** của chính ngày | 25.942/25.942 (100%) |
| `SanLuong_Country_2026.xlsx` | `Weeknum` | **Tuần ISO** của chính ngày | 37.369/37.369 (100%) |

Mẫu chốt — Thứ Hai **2026-03-30**: `Week!weeknum = 13` nhưng `Week!isoweek = 14` và `S26!Weeknum = 14`.
Mẫu ranh giới — **2026-04-01** (Thứ Tư): tuần T6–T5 = 13, ISO = 14; **2026-05-07** (Thứ Năm): 18 so với 19.

Thêm 130/26.610 dòng (0,49%) của `Week!weeknum` **sai hẳn**: toàn bộ rơi vào 2026-06-09 (90 dòng) và
2026-06-10 (40 dòng) mang giá trị `52` trong khi `isoweek = 24` — lỗi kéo công thức khi lập bảng,
không phải quy luật tuần. Củng cố nguyên tắc ở §4/D3: Excel chỉ để đối chiếu công thức, không phải nguồn sự thật.

**Ánh xạ sang HTML:** `isoweek` (Week) và `Weeknum` (S26/Country) → trục `iso_week`;
`weeknum` của file Week → trục `business_week`. Lưu ý HTML biểu diễn trục tuần bằng **ngày mở tuần**
(`iso_week` = Thứ Hai, `business_week` = Thứ Sáu — SQL `20260906120000_public_traffic_html_pivot_v2.sql:216-218`),
còn Excel biểu diễn bằng **số tuần**; khi đối chiếu phải quy đổi, không so trực tiếp 13 với `2026-03-30`.

**Ghi chú dữ liệu:** `Pax = 0` là **dữ liệu hợp lệ** theo cách hiểu của Excel nhưng trong thực tế
phần lớn là "chưa nhập khách" (tuần 21–22 của file Week có chuyến mà khách = 0). Vì vậy khi chuyển
sang HTML phải dùng ngữ nghĩa *coverage* của v2, tuyệt đối không copy số 0.

---

## 2. Luồng dữ liệu chi tiết từng workbook

Sơ đồ chung:

```
Data (paste từ app) ─┬─> Pivot Cache worksheet (sharedItems: danh mục giá trị)
                     └─> Data Model / OLAP cache (Measures: Count of Flight, Count of Flight 2)
                                   │
                                   ▼
                     Pivot Table (rowFields / colFields / pageFields / dataFields)
                                   │  giá trị render được LƯU VÀO Ô (snapshot)
                                   ▼
                        Sheet trình bày ──> Chart (bar/line trên chính pivot đó)
```

### 2.1 `SanLuong_Week_S26.xlsx` — bộ pivot tuần (12 sheet, 4 cache, 8 pivot, 1 chart, 3 ListObject)

| Sheet | Nguồn | Trục dòng | Trục cột | Page filter | Chỉ tiêu | Số liệu chốt |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Airline` | cache 11 cột `Data!A1:K26611` | Hãng → Chặng | Năm → `weeknum` **(T6–T5)** → ΣVALUES | `Type = D` | Count of Flight, Sum of Pax | VJ 409 chuyến, 53.500 khách (tuần 13–22) |
| `Country` | như trên | Thị trường → Chặng | Năm → `weeknum` **(T6–T5)** → ΣVALUES | `Type = D` | như trên | — |
| `Routes` | như trên | Chặng → Hãng | Năm → `weeknum` **(T6–T5)** → ΣVALUES | `Type = ALL` | như trên | — |
| `PeakHour` | cache 11 cột | Hãng | (không) | `Type = A` | Count of Flight | **Tên sheet gây nhầm** — thực chất là bảng đếm đến theo hãng, không có khung giờ |
| `Chart` | cache 12 cột `Data!A1:L26611` | Năm → `weeknum` **(T6–T5)** | (không) | `Type = ALL` | Count of Flight | Tổng 26.610 = `recordCount` của cache; nuôi `chart1` (bar, 1 series) |
| `DayFilter` | cache 17 cột (đã thêm `weekday`,`isoweek`,`Days/Months/Years`) | `Type` → ΣVALUES | `Ops Date` (ngày) | không | Chuyến + Khách | Ma trận ngày × (A/D/Total); **Pax = 0 từ 15/05 dù chuyến vẫn có** |
| `Sheet6` | **OLAP** `Table1` | Hãng → Chặng → `weekday` | Năm (2026) → Tháng → `isoweek` **(ISO)** | `Type = ALL` | `[Measures].[Count of Flight]` | Bản "tuần cả mùa" đúng nghĩa; cột trong file trộn Mar/Apr (2 tháng) |
| `Sheet2` | cache 17 cột | Chặng → `Months (Ops Date)` | `weekday` | `Country = ALL` | Count of Flight | Tương đương tab "Chặng × Thứ" của HTML |
| `Detail1`, `Detail2` | danh sách chi tiết (không pivot) | 14 cột: Type, Flight, Config, STA/STD, Routes, Pax, Note, Airlines, Ops Date, Country, UTC, weeknum | | | | Drill-down cấp **số hiệu chuyến** có `Note` (`Bags Delivered`/`Departed`) |

### 2.2 `SanLuong_S26.xlsm` (18 sheet, 7 cache — 2 OLAP + 5 worksheet, 12 pivot, 2 chart)
(bản `SanLuong_S26 - Copy.xlsm` có cấu trúc y hệt, dữ liệu nhiều hơn: **29.775** vs 25.942 dòng)

| Pivot / sheet | Nguồn | Trục dòng | Trục cột | Page | Chỉ tiêu | Ý nghĩa nghiệp vụ |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `Airline` | `Data!A1:M25943` | Hãng → Chặng | Tháng → ΣVALUES | `Type = ALL` | Chuyến, Khách | Ma trận hãng × tháng |
| `Country` | `Data!A1:J25943` | Thị trường → Chặng → Hãng | Tháng → ΣVALUES | `Type = ALL` | Chuyến, Khách | Ma trận thị trường 3 cấp × tháng |
| `Country_ChiTiet` | `Data!A1:J25943` | Thị trường → Chặng → Hãng | Năm → Tháng | không | Chuyến | Bản chi tiết (không khách) |
| `Routes` | `Data!A1:J25943` | Chặng → Hãng | Tháng → ΣVALUES | `Type`, `Country = ALL` | Chuyến, Khách | Ma trận chặng × tháng |
| `Frequency` | **OLAP** `Table1` | Hãng → Chặng | Năm → `Weeknum` **(ISO)** | `Type`, `Month = ALL` | `[Measures].[Count of Flight]` | Tần suất (chuyến) theo tuần |
| `Month` | `Data!A1:N25943` | Tháng → `Ops Date` | `Type` | `Years (UTC) = ALL` | Chuyến | Lưới ngày × chiều |
| `PeakHour` | cache 21 cột | Tháng → Ngày | `HourUTC2` → `HourUTC` | `Type = D`, `Airlines = ALL` | Chuyến | **Ma trận Ngày × (30 phút → giờ)** |
| `Per30min` | **OLAP** `Table1 1` | Tháng → Ngày | `Hour30min` (44 slot) | `Type = ALL` | `[Measures].[Count of Flight 2]` | Hạt **30 phút** cho từng ngày |
| `30days` | cache 19 cột | Hãng → `Flight` | `DayIdex` (1..31) | `Type`, `Months = ALL` | Chuyến | Lịch bay định kỳ theo ngày trong tháng |
| `ACType` | cache 19 cột | Hãng → `Flight` | `A/C Type` | `Type = ALL` | Chuyến | Loại tàu theo số hiệu |
| `Config` | cache 19 cột | Hãng → `Weekday` | `Config2` (Tàu nhỏ/Tàu to) × `Config` (số ghế) | `Type = ALL` | Chuyến | Cơ cấu ghế theo thứ |
| `Sheet3` | cache 19 cột | Tháng | `Weekday` | không | Chuyến | Tổng hợp nhỏ |
| `Chi tiết1` | danh sách chi tiết | 14 cột như `Detail1` + `A/C Type` | | | | Drill-down cấp chuyến |
| `Change Log` | nhật ký | `Timestamp, Action, Details, Sheet Name, User` | | | | "Cập nhật S26 mới nhất" — chứng cứ con người cập nhật tay |

### 2.3 `SanLuong_Country_2026.xlsx` — ma trận năm (2 sheet, 1 cache 37.369 dòng/18 cột, 1 pivot)

`Sheet3`: Thị trường → Chặng → Hãng × tháng `Jan..Oct` + `Grand Total`.
Ví dụ chốt: `Korea / ICN / TW = 1.228 chuyến`. Cache có `Quarters (Ops Date)` và `Weekday`,
`HourUTC`, `A/C Type` nhưng pivot chỉ dùng tháng. Đây là nguồn "chi tiết cấp hãng theo thị trường"
đầy đủ nhất trong các mẫu.

### 2.4 `SanLuongAPR.xlsx` — minh chứng cho "so sánh 2 kỳ" (5 sheet, 1 cache 7.118 dòng, 4 pivot)

| Sheet | Trục dòng | Trục cột | Page | Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| `CountryApr` | Thị trường | ΣVALUES × `Type` | `Ops Date = ALL` | Số đang phơi: **tháng 4** (VJ: 193 A + 187 D = 380 chuyến, 70.844 khách) |
| `AirlineApr` | Hãng | ΣVALUES × `Type` | `Ops Date = ALL` | cùng mốc tháng 4 |
| `Country26apr-2may` | Thị trường | ΣVALUES × `Type` | `Ops Date = ALL` | Số đang phơi: **26/04–02/05** (VJ: 95 chuyến) |
| `Airline_26apr-2may` | Hãng | ΣVALUES × `Type` | `Ops Date = ALL` | cùng mốc 26/04–02/05 |

Cả 4 pivot cùng trỏ 1 cache; chênh lệch số liệu **không đến từ page filter hiện tại** mà từ snapshot
đã render trước đó ⟹ đúng bài toán `comparison_pairs` mà HTML v2 đang giải.

### 2.5 `BaoCaoSanLuong.xlsm` — khuôn mẫu trực tiếp của template `bao-cao-san-luong-v1`
(11 sheet, **0 pivot/cache**, 2 ListObject, 7 chart)

- `TOTAL` (221 dòng): `Month | Ops Date | Day (=TEXT(...,"dddd")) | Flight ARR/DEP | Total Flight |
  Pax ARR/DEP | Total Pax` **+ khối `WEEKLY` bên phải**: `From | To | Flight ARR/DEP/Total |
  Pax ARR/DEP/Total` (cửa sổ 7 ngày trượt, `=K3+7`), kèm dòng `Mar Total` (SUM theo tháng).
- `APR..OCT`: một sheet/tháng cùng khuôn ngày + chart `barChart + lineChart` 3 series.
- `Analysis_Airline` / `Analysis_Country` (123/…)`: `Airline | Tuần trước nữa | Tuần trước |
  Difference | % Difference | **CTG (%)**` — ví dụ `VJ: 89 → 96, +7, +7.87%, CTG 0.85%`.
- `Table1` + `Table1` khác: bảng dữ liệu nguồn của các sheet trên.

⟹ Đây chính là khuôn: tab `TOTAL` = `daily() + weeklyTable()`, tab tháng = `daily(month) + monthChart()`,
2 tab Analysis = `analysis()` với CTG — **đã có trong runtime**, chỉ còn thiếu preset/định dạng chart.

---

## 3. Đối chiếu với kết xuất HTML v2 hiện hành

### 3.1 Pipeline hiện tại (đã xác minh trong worktree)

```
DB (quan hệ/MV trong schema reporting, snapshot 1 statement)
      │  RPC STABLE: reporting.traffic_html_period_data_v2(request, period)  → resources[] theo dataset
      ▼
public.get_public_traffic_html_export_v2(p_request, …)   -- chốt watermark + data_version, trần 250k dòng
      ▼
GET /traffic-report/v2/html-export  (traffic-report/index.ts:904-923)
      │  normalizeHtmlRequest → validateHtmlEnvelope (bất biến số học) → renderTrafficHtmlReport
      ▼
1 file HTML tự chứa: JSON nhúng (report-data) + runtime pivot + CSS inline
   CSP: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'
   Ngân sách: HTML_MAX_BYTES = 25 MiB, HTML_MAX_ROWS = 250.000, calendar_days ≤ 125.000
```

Dataset v2: `kpi | timeline(date) | market(country,route,airline) | market_daily(date,country,route,airline) |
aircraft(group_id,group,type) | hours(hour) | frequency(hour,airline,route,flight_number)`.
Metric: `flights, reported_pax, reported_legs, due_legs, missing_due_legs, true_zero_reported_legs,
unreported_legs, flight_coverage, pax_status` + `operating_days/occurrence_days/eligible_days/
consistency_percent/typical_time` cho `frequency`.

### 3.2 Bảng đối chiếu Excel → HTML

| Mẫu Excel | Nội dung | HTML v2 tương ứng | Trạng thái |
| :--- | :--- | :--- | :--- |
| Week `Airline`/`Country`/`Routes` | Hãng/Thị trường/Chặng × Tuần, Chuyến + Khách, chiều A/D | Tab `airline`/`market`/`route` + trục cột `business_week` (parity `weeknum` T6–T5) hoặc `iso_week` (parity `isoweek`) + bộ chọn Chiều | **Đủ** (thiếu preset 1-click; phải tách 2 trục tuần — A1/D-04) |
| Week `Chart` | Đếm chuyến theo tuần | Tab `time`/`total` + biểu đồ line | Đủ số liệu; **chưa có chart theo tuần** (G6 — chart tháng dạng cột+đường đã có ở `monthChart`) |
| Week `DayFilter` | Ma trận Ngày × (A/D/Total × Chuyến/Khách) | Tab `days`/`time` (dataset `timeline`) + bảng tuần A/D/Total | **Đủ** |
| Week `Sheet6` | Hãng→Chặng→Thứ × Năm→Tháng→Tuần (OLAP) | Pivot builder 3 cấp + trục `iso_week` (parity `isoweek`) | **Thiếu trục Quý** (G4) |
| Week `Sheet2` | Chặng × Tháng, cột Thứ | Trục cột `weekday` | **Đủ** |
| Week `Detail1/2` | Danh sách chuyến chi tiết | Flyout drill-down (`market_daily`) | **Thiếu cấp số hiệu** (G5) |
| S26 `Airline`/`Country`/`Routes`/`Country_ChiTiet` | 2–3 cấp × Tháng | Tab `airline`/`market`/`route`, trục `month` | **Đủ** |
| S26 `Month` | Tháng→Ngày × Chiều | Tab `days` | **Đủ** |
| S26 `Frequency` | Hãng→Chặng × Tuần | Tab `frequency` (● thứ, ngày hoạt động, ổn định) | **Đủ** (khác hình thức) |
| S26 `30days` | Hãng→Số hiệu × Ngày 1..31 | Tab `frequency` (ngày hoạt động/có thể) | **Thiếu trục ngày-tháng** (G4) |
| S26 `ACType` | Hãng→Số hiệu × Loại tàu | Tab `aircraft` (nhóm × loại) | Đủ ở mức tổng hợp, **thiếu cấp số hiệu** (G5) |
| S26 `Config` | Hãng→Thứ × Lớp ghế/Mã ghế | — | **Thiếu hoàn toàn** (G3) |
| S26 `PeakHour` | Tháng→Ngày × (30'→Giờ) | Tab `hours` (24 giờ, tổng hợp kỳ) | **Thiếu ma trận Ngày × Khung** (G2) |
| S26 `Per30min` | Tháng→Ngày × 48 slot 30' | — | **Thiếu hạt 30'** (G1) |
| Country `Sheet3` | Thị trường→Chặng→Hãng × Tháng 1..10 | Tab `market` + trục `month` | **Đủ** |
| APR các sheet | Hãng/Thị trường × Values × Chiều, 2 mốc kỳ | `comparison_pairs` + trục `month` | **Đủ mô hình**, thiếu preset cặp kỳ (G6/A1) |
| Bao `TOTAL`, `APR..OCT`, `Analysis_*` | Lưới ngày + khối tuần; Δ/%Δ/**CTG%** | Tab `TOTAL`, tab tháng, `analysis-airline`/`analysis-country` (có CTG, `trafficHtmlPivotRuntime.ts:649`) | **Đủ** |
| Mọi file | `Change Log` (nhật ký cập nhật tay) | `source_watermark`, `data_as_of`, `snapshot_scope` trong envelope | Tương đương (nguồn tự động) |

### 3.3 Sáu khoảng trống và hướng xử lý

| ID | Khoảng trống | Bằng chứng | Hướng xử lý đề xuất |
| :--- | :--- | :--- | :--- |
| **G1** | Hạt **30 phút** | `S26!Per30min` cột `Hour30min` 44–48 slot; `HourUTC2` trong `Data` | Thêm trường `slot` (`HH:MM`) vào dataset `hours` (xem B1) |
| **G2** | Ma trận **Ngày × Khung giờ** | `S26!PeakHour` `A4:Z217` (Tháng→Ngày × HourUTC2→HourUTC) | Dataset `hours` thêm `date` khi kỳ ≤ 35 ngày + view heatmap mới (C1) |
| **G3** | **Config = số ghế** → Load factor | `Config` pivot; `Config` trong `Data` là số (180/188/199) | Dataset `config` + metric dẫn xuất `load_factor` (B2) |
| **G4** | Trục **Quý** và trục **Ngày trong tháng 1..31** | `Quarters (Ops Date)` trong cache Country; `DayIdex` trong `30days` | Thêm `quarter` vào `calendar`; thêm lựa chọn trục cột `quarter`, `day_index` (B3, C2) |
| **G5** | **Chi tiết cấp chuyến** (số hiệu, STA/STD, Note, loại tàu, số ghế) | `Detail1/Detail2`, `Chi tiết1` (14 cột) | Dataset `flight_detail` giới hạn ngân sách, chỉ cho kỳ ≤ 7 ngày / `WEEKLY_DETAIL` (B4) |
| **G6** | **Chart theo tuần** (mẫu `Week!Chart`, 1 series) và **preset cặp kỳ** (4 sheet của APR) | 7 chart `barChart+lineChart` của Bao = cột ARR/DEP + đường Tổng — **parity đã đạt** nhờ `monthChart` (`trafficHtmlPivotRuntime.ts:615-631`, dùng ở `:824-825`); 4 sheet cặp kỳ của APR | Thêm chart cột theo trục tuần + preset cặp kỳ (A1, C4) |
| **G7** | **Dải tổng hợp đầu file** (tổng chuyến/khách/độ phủ kỳ đang xét) | Header hiện chỉ có tiêu đề, kỳ, phạm vi lọc, chú thích `—`/`*` và badge "Mốc chốt dữ liệu hoàn tất" (`trafficHtmlPivotRuntime.ts:120-125`); dataset `kpi` **đã nằm trong file** (3 dòng A/D/all, kiểm tra ở `trafficHtmlReportModel.ts:143-145`) nhưng không được vẽ | Vẽ dải KPI từ dataset `kpi` có sẵn — thuần runtime, không đổi hợp đồng (A4) |

---

## 4. Phương án chuyển đổi

### 4.0 Ba phương án và lựa chọn

| Phương án | Cách làm | Ưu | Nhược | Kết luận |
| :--- | :--- | :--- | :--- | :--- |
| **PA1 — Mở rộng hợp đồng v3 + runtime parity** (khuyến nghị) | Bổ sung 4 dataset/trường nhỏ, tính lại từ canonical, thêm view/trục/chart | Giữ nguyên nguyên tắc "số luôn sống"; kiểm chứng được bằng PGlite + Playwright; không phình file | Cần migration + bump `HTML_DATA_VERSION` | **Chọn** |
| PA2 — "Nhúng lại bảng Excel" | Convert từng sheet Excel thành bảng HTML tĩnh | Nhanh, đúng hình dạng mẫu | Dữ liệu chết, không lọc được, sai lệch theo thời gian, không đáp ứng 1 kỳ động | Loại |
| PA3 — Pivot hoàn toàn client-side trên bảng fact thô | Nhúng toàn bộ fact (chuyến) vào HTML | Linh hoạt tối đa | Vượt 25 MiB cho mùa đầy đủ; thời gian tải lớn; rủi ro lộ dữ liệu chi tiết | Loại (chỉ dùng cho kỳ ngắn — xem B4) |

### Gói A — Preset bố cục "mẫu Excel" (không thay đổi hợp đồng dữ liệu)

- **A1. Bổ sung preset 1-click** vào menu đã có (`trafficHtmlPivotRuntime.ts:869-878` hiện có 4 preset),
  **tách riêng hai cách đếm tuần** (xem §1.1):
  `airline_bw` (Hãng→Chặng × **Tuần T6–T5** = `business_week` — parity `Week!Airline/Country/Routes/Chart` dùng `weeknum`),
  `airline_iw` (Hãng→Chặng × **Tuần ISO** = `iso_week` — parity `Week!Sheet6` dùng `isoweek` và `S26!Frequency` dùng `Weeknum`),
  `market_week` (Thị trường × Tuần — kèm lựa chọn T6–T5/ISO),
  `route_weekday` (Chặng × Thứ — bản đầy đủ của `Week!Sheet2`), `month_day` (Tháng→Ngày × Toàn kỳ),
  `airline_route_dir` (Chặng × Chiều — đã có `route_dir`, giữ nguyên).
  Nhãn trục tuần phải in kèm **ranh giới** ("T6 27/03 → T5 02/04" hoặc "T2 30/03 → CN 05/04") vì cùng một
  chuyến có thể nằm ở hai "tuần" khác nhau tùy cách đếm.
- **A2. Tab mặc định phản chiếu workbook**: `WEEKLY_DETAIL` mở `airline/country/route`; `BAO_CAO_SAN_LUONG`
  giữ `TOTAL/tháng/Analysis` (đang đúng); `PERIOD_ANALYSIS`/`MASTER_OPERATIONS` mở `route/days` và
  cho phép bật `Tuần cả mùa` (tương đương `Week!Sheet6`).
- **A3. Nhãn đối chiếu**: chú thích dưới mỗi bảng ghi tên sheet Excel tương ứng khi tồn tại
  ("tương đương sheet `Country_ChiTiet`") để người đọc quen Excel định vị nhanh.
- **A4. Dải tổng hợp đầu file (G7)**: 3–5 thẻ ngay dưới header lấy từ dataset `kpi` + `timeline` đã có trong file
  (Tổng chuyến · Khách đã ghi nhận · Độ phủ khách `reported_legs/due_legs` · Ngày có chuyến `X/Y` · tuỳ chọn
  quy mô `N hãng · M chặng · K thị trường`), mỗi thẻ có dòng phụ A/D/Total, kèm nhãn "đã ghi nhận" khi
  `unreported_legs ≠ 0`. Dữ liệu dựng bằng **một hàm thuần `htmlKpiCards(data)` trong contract**, nhúng vào cả
  3 runtime qua `helpers` (`sum`/`compare` sẵn có); **không đổi hợp đồng dữ liệu**.
- **Phạm vi mã:** `trafficHtmlPivotRuntime.ts` (mảng `tabs`, `presets`, `labels`, `columns()`),
  `trafficHtmlReportContract.ts` (`htmlKpiCards`), `trafficHtmlReportRenderer.ts` (nhúng helper),
  `trafficHtmlReportRuntime.ts` + `trafficHtmlMonthlyRuntime.ts` (vẽ dải KPI), `trafficHtmlPivotStyles.ts`.

### Gói B — Hợp đồng dữ liệu v3 (bổ sung nhỏ, có ngân sách)

- **B1 `hours` + `slot`**: thêm trường `slot: string | null` (`"00:00"`, `"00:30"`, … 48 giá trị).
  Khi chỉ tổng hợp theo giờ (kỳ dài) `slot = null` như hiện nay; khi kỳ ≤ 35 ngày trả thêm `date`
  để dựng ma trận Ngày × Slot (ngân sách xấu nhất 35 × 48 × 2 = 3.360 dòng/kỳ — nằm rất xa trần 250k).
- **B2 dataset `config`**: grain `airline`, `weekday`, `config_class` (`Tàu nhỏ`/`Tàu to`/Khác),
  `config_seats` (số ghế); chỉ tiêu `flights`, `reported_pax`, `reported_legs`, …;
  metric dẫn xuất `load_factor = reported_pax / (Σ config_seats × flights)` **chỉ hiển thị khi
  `unreported_legs = 0`** (tôn trọng ngữ nghĩa coverage; Excel đang tính LF trên cả chuyến chưa có khách).
- **B3 `calendar` + `quarter`**: thêm `quarter` (`2026-Q3`) để trục cột "Quý" hoạt động như
  `Quarters (Ops Date)` của mẫu Country.
- **B4 dataset `flight_detail`**: grain `date`, `airline`, `route`, `flight_number` (chiều nằm ở `direction`),
  trường phụ `typical_time` (STA/STD), `aircraft_type`, `config_seats`, `note`, kèm metric hiện có.
  **Không thêm tham số request mới**: chỉ trả cho `WEEKLY_DETAIL` (hoặc kỳ `current` ≤ 7 ngày) — đúng phạm vi mẫu
  `Week!Detail1/Detail2`; vượt 40.000 dòng trả `complete:false` để UI báo "phạm vi quá lớn" (cơ chế `complete`
  đã có trong `HtmlResource`). Không dùng tham số `detail=1` vì whitelist `WORKBOOK_QUERY_KEYS`
  (`trafficWorkbookCore.ts:278`) là của chung với `workbook-export` — thêm tham số sẽ đụng mọi endpoint workbook.
- **B5 Phiên bản hóa**: bump `HTML_DATA_VERSION` → `traffic-html-data-v3`; endpoint gọi RPC v3.
  File HTML cũ **tự chứa** (JSON + runtime + CSS inline) nên không phụ thuộc endpoint; RPC v2 **vẫn nằm nguyên
  trong DB** (không drop) cho mọi caller đang ghim v2. `normalizeHtmlRequest` từ chối tham số `contract_version`
  khác giá trị hiện hành (thay vì âm thầm chấp nhận).
- **Phạm vi mã:** migration mới `app/supabase/migrations/2026xxxx_public_traffic_html_export_v3.sql`
  (bản sao có kiểm soát của `traffic_html_period_data_v2`), `trafficHtmlReportContract.ts`
  (`Dataset`, `HtmlRow`, `HTML_DATA_VERSION`), `trafficHtmlReportModel.ts` (`FIELDS`, `validateHtmlEnvelope`),
  `traffic-report/index.ts`.

### Gói C — Runtime parity (UI)

- **C1 View "Ngày × Khung giờ"**: heatmap ngày (dòng) × 48 slot 30' (cột) cho `Per30min`, tái dùng
  thang màu `hot-1..hot-5` đã có trong `renderHoursView` (`trafficHtmlPivotRuntime.ts:663-720`, lớp màu ở `:693-694`).
- **C2 Trục cột mới**: thêm `quarter` và `day_index` vào menu "Trục cột" của pivot builder
  (`trafficHtmlPivotRuntime.ts:884-897`); `day_index` dựng cột 1..31 như `30days`.
- **C3 Chỉ báo độ phủ**: cột "Ngày có khách / Ngày có chuyến", "Chuyến chưa có khách" ở bảng ngày và
  dòng tổng; **hiển thị `—` thay cho `0`** khi `reported_pax = null` (chống tái hiện lỗi 0 giả của Excel).
- **C4 Biểu đồ**: giữ nguyên `monthChart` (đã parity 3 series ARR/DEP/Tổng như 7 chart của Bao), chỉ bổ sung
  **chart cột theo trục tuần** (khuôn `Week!Chart`, 1 series chuyến) và **chart cặp kỳ** khi chọn preset so sánh;
  tuỳ chọn thêm đường theo *chỉ tiêu khác* (Pax khi cột là chuyến) — **không có trong mẫu**, ghi rõ là bổ sung ngoài parity.
  Vẫn SVG thuần, không thư viện ngoài.
- **C5 (tuỳ chọn) Sổ tay dữ liệu**: panel nhỏ hiển thị `data_as_of`, `source_watermark`, `filter_hash`
  và tình trạng coverage — thay thế vai trò của `Change Log` trong Excel.

### Gói D — Kiểm chứng parity

- **D1 PGlite (bắt buộc)**: mở rộng `app/supabase/tests/public_traffic_html_export_pglite.mjs` với các
  bất biến mới: `slot ∈ {00:00..23:30}`, `date` chỉ xuất hiện khi kỳ ≤ 35 ngày, `day_index ∈ 1..31`,
  `quarter` nhất quán với `date`, `config_seats > 0` khi có `config_class`, tổng `flights` theo `slot`
  bằng tổng theo `hour` khi gộp cặp slot.
- **D2 Playwright headless (theo bộ đã có)**: thời gian chuyển tab < 15 ms với tab đã cache,
  `window.scrollY` không đổi, toolbar parity, heatmap render, 5 preset mới, in/CSV vẫn đúng.
- **D3 Đối chiếu số học với mẫu (chỉ để kiểm tra công thức, KHÔNG dùng làm nguồn sự thật)**:
  ví dụ `SanLuongAPR.xlsx!AirlineApr`: VJ = 193 (A) + 187 (D) = 380 chuyến; khách 35.392 + 35.452
  = 70.844 ⟹ chạy cùng kỳ Apr 2026 trên canonical phải ra cùng con số nếu dữ liệu chưa đổi; nếu khác
  thì kết luận là *dữ liệu canonical đã thay đổi sau khi file Excel được chốt*, không phải lỗi runtime.

---

## 5. Tracker nghiệm thu

| ID | Hạng mục | Tiêu chí nghiệm thu | Minh chứng |
| :--- | :--- | :--- | :--- |
| A-01 | 5 preset bố cục mới | Bấm 1 lần ra đúng bố cục Hãng/Thị trường × Tuần, Chặng × Thứ, Tháng × Ngày | Ảnh chụp Playwright 3 file mẫu |
| A-02 | Tab mặc định theo report_type | Mở file không cần thao tác đã thấy đúng tab gốc của workbook | So sánh thứ tự tab với mẫu |
| A-03 | Nhãn đối chiếu sheet | Mỗi tab có chú thích tên sheet Excel tương ứng | Kiểm tra text trong DOM |
| A-04 | Dải tổng hợp đầu file | Thẻ tổng chuyến/khách/độ phủ khớp dòng Grand Total của bảng chính; ghi rõ "đã ghi nhận" khi thiếu khách | So khớp DOM với `kpi` + ảnh chụp |
| B-01 | `hours.slot` | Có đủ 48 giá trị slot; tổng theo slot khớp tổng theo giờ | PGlite + so khớp runtime |
| B-02 | `config` + `load_factor` | LF chỉ hiện khi `unreported_legs = 0`; LF của một kỳ đóng băng khớp tính tay | Test PGlite + 1 kỳ đối chiếu |
| B-03 | `calendar.quarter` | Trục Quý hiển thị và khớp tổng tháng | PGlite |
| B-04 | `flight_detail` theo ngân sách | `WEEKLY_DETAIL` (hoặc kỳ ≤ 7 ngày) có dataset; kỳ dài không trả; vượt 40.000 dòng thì `complete:false` | PGlite |
| B-05 | Tương thích ngược | File HTML cũ (v2) vẫn tải và chạy; endpoint từ chối `contract_version` lạ | Test edge `traffic-html-edge.test.mjs` |
| C-01 | Heatmap Ngày × Slot | 48 cột, màu bậc thang, Grand Total đúng | Playwright |
| C-02 | Trục Quý / Ngày-trong-tháng | Chọn trục ra bảng đúng như mẫu `Sheet6`/`30days` | Playwright |
| C-03 | Không còn "0 giả" | Ô Pax thiếu hiển thị `—` + nhãn coverage | Kiểm tra DOM |
| C-04 | Chart tuần + tháng | Chart tháng giữ đúng 3 series ARR/DEP/Tổng; chart tuần mới vẽ đúng tỷ lệ; in ra đủ, không vi phạm CSP | Playwright + `@media print` |
| D-01 | PGlite bất biến mới | Test pass 100% | Log suite |
| D-02 | Playwright UX | Chuyển tab < 15 ms, scroll delta = 0 | Log đo |
| D-03 | Đối chiếu số | Chênh lệch được giải thích bằng `data_as_of`/watermark | Biên bản đối chiếu |
| D-04 | Ngữ nghĩa trục tuần | Preset T6–T5 cho `business_week` = Thứ Sáu mở tuần; preset ISO cho `iso_week` = Thứ Hai; quy đổi đúng ở 2 mẫu: 2026-03-30 (`weeknum` 13 ↔ `business_week` 2026-03-27 vs `isoweek` 14 ↔ `iso_week` 2026-03-30) và 2026-04-01 (13 vs 14); tập chuyến của hai trục khác nhau đúng như Excel | Ảnh chụp 2 preset + bảng quy đổi |

---

## 6. Rủi ro và quyết định thiết kế

| Rủi ro | Mức | Giảm thiểu |
| :--- | :--- | :--- |
| Phình file HTML khi thêm `slot`/`date` | Trung bình | Chỉ trả `date` khi kỳ ≤ 35 ngày; giữ trần 25 MiB/250k dòng; đo lại kích thước 3 file mẫu |
| `load_factor` sai khi thiếu khách | Cao | Bắt buộc `unreported_legs = 0` mới hiển thị; hiển thị riêng `Khách/Chuyến` như hiện tại |
| Vỡ lịch sử file đã xuất | Cao | Bump `HTML_DATA_VERSION`; file HTML tự chứa (không gọi endpoint khi mở); giữ nguyên RPC v2 trong DB, không sửa hành vi v2 |
| Sai lệch số với kỳ vọng "mẫu Excel" | Trung bình | Quy ước rõ: canonical là nguồn sự thật; chênh lệch phải giải thích bằng watermark |
| Trôi múi giờ `Ops Date` vs `UTC` | Trung bình | `time_basis` đã có trong request; `hour`/`slot` gắn nhãn giờ địa phương/UTC ở tiêu đề bảng |
| Cột `weeknum` trùng tên nhưng khác ngữ nghĩa giữa các workbook (Week = T6–T5 đánh số theo ISO của Thứ Sáu; S26/Country = ISO của ngày) | Cao | Ánh xạ theo từng file (§1.1); tách preset T6–T5/ISO (A1); nhãn trục in kèm ngày mở–kết tuần; kiểm bằng 2 mẫu ngày (D-04) |
| Excel có dòng khóa tuần sai (130 dòng `weeknum = 52` cho 09–10/06/2026) | Thấp | Không dùng Excel làm nguồn; mọi số lấy từ canonical, Excel chỉ đối chiếu công thức (D3) |
| CSP/lỗi offline | Thấp | Giữ CSP hiện tại, không CDN, SVG inline |

---

## 7. Phụ lục A — Số liệu bằng chứng

| File | Sheets | Pivot caches | Pivot tables | ListObjects | Charts | Nguồn dữ liệu |
| :--- | ---: | :--- | ---: | ---: | ---: | :--- |
| `SanLuong_Week_S26.xlsx` | 12 | 4 (3 worksheet trên `Data`, 1 OLAP `Table1`) | 8 | 3 | 1 | `Data!A1:K26611` (11 cột, 26.610), `A1:L26611` (12 cột), cache 17 cột |
| `SanLuong_S26.xlsm` | 18 | 7 (5 worksheet trên `Data`, 2 OLAP `Table1`/`Table1 1`) | 12 | 2 | 2 | `Data!A1:J..N25943` (25.942) |
| `SanLuong_S26 - Copy.xlsm` | 18 | 7 | 12 | 2 | 2 | cùng khuôn, 29.775 dòng |
| `SanLuong_Country_2026.xlsx` | 2 | 1 (worksheet, 18 cột) | 1 | 1 | 0 | 37.369 dòng (có `Quarters (Ops Date)`) |
| `SanLuongAPR.xlsx` | 5 | 1 (worksheet, 12 cột) | 4 | 1 | 0 | 7.118 dòng (~ Apr 1 – May 31) |
| `BaoCaoSanLuong.xlsm` | 11 | 0 | 0 | 2 | 7 | công thức + bảng phụ |

## 8. Phụ lục B — Ánh xạ cột Excel ↔ hợp đồng HTML

| Cột Excel | v2 hiện có | v3 đề xuất |
| :--- | :--- | :--- |
| `Type` | `direction` (A/D/all) | giữ nguyên |
| `Airlines` / `Routes` / `Country` | `grain.airline` / `route` / `country` | giữ nguyên |
| `Ops Date` | `grain.date`, `timeline`, `calendar` | giữ nguyên |
| `Pax` | `reported_pax` + `reported_legs` (phân biệt thiếu/0) | giữ nguyên |
| `Weeknum` | `iso_week` + `business_week` (đã có) | **map theo từng file**: `Week!weeknum` → `business_week`; `Week!isoweek`, `S26`/`Country!Weeknum` → `iso_week` (xem §1.1) |
| `Weekday` | trục `weekday` | giữ nguyên |
| `HourUTC` | `hours.hour` | + `hours.slot` (30') và `hours.date` (kỳ ngắn) |
| `A/C Type` | `aircraft.type` (tổng hợp) | + `flight_detail.aircraft_type` (cấp số hiệu) |
| `Config` (số ghế) | *(thiếu)* | `config.config_seats` → `load_factor` |
| `Config2` (Tàu nhỏ/to) | *(thiếu)* | `config.config_class` |
| `Flight`, `STA/STD`, `Note` | *(thiếu)* | `flight_detail.flight_number`, `typical_time`, `note` |
| `DayIdex` | *(thiếu)* | trục cột `day_index` |
| `Quarters (Ops Date)` | *(thiếu)* | `calendar.quarter` |
| `Change Log` | `data_as_of`, `source_watermark` | giữ nguyên (nguồn tự động) |

---

## 9. Phụ lục C — Cấu trúc file sau chỉnh sửa (blueprint thi công)

Đường dẫn tính từ worktree `SeasonalManagement-web-traffic-report`; số dòng là **vị trí hiện tại** để chèn.

| # | File | Loại | Gói | Thay đổi cốt lõi |
| --: | :--- | :--- | :--- | :--- |
| 1 | `app/supabase/migrations/20260916120000_public_traffic_html_v3.sql` | **mới** | B | bản sao có kiểm soát của v2: 3 grain mới, `quarter`, `reported_seats` |
| 2 | `app/supabase/tests/public_traffic_html_export_pglite.mjs` | sửa | B, D | fixture ghế/note + áp migration v3 ×2 + khối bất biến mới |
| 3 | `app/supabase/functions/_shared/trafficHtmlReportContract.ts` | sửa | B | version v3, `Dataset` +2, `HtmlRow` +4 trường, `calendar.quarter`, `htmlKpiCards()` |
| 4 | `app/supabase/functions/_shared/trafficHtmlReportModel.ts` | sửa | B | `DATASETS`/`FIELDS` + 2 dataset và `hours.date`, các `ensure` mới |
| 5 | `app/supabase/functions/_shared/trafficHtmlPivotRuntime.ts` | sửa | A, C | dải KPI, 6 preset, 2 trục tuần, tab heatmap/LF/chi tiết, chart tuần |
| 6 | `app/supabase/functions/_shared/trafficHtmlPivotStyles.ts` | sửa | A, C | 5 khối CSS mới ở cuối template |
| 7 | `app/supabase/functions/_shared/trafficHtmlReportRenderer.ts` | sửa | A | nhúng `helpers.kpiCards` vào runtime string |
| 8 | `.../_shared/trafficHtmlReportRuntime.ts`, `.../_shared/trafficHtmlMonthlyRuntime.ts` | sửa | A | vẽ dải KPI trong header (2 mount còn lại) |
| 9 | `app/supabase/functions/traffic-report/index.ts` | sửa | B | RPC `_v2` → `_v3` (1 dòng trong `handleHtmlExport`) |
| 10 | `app/scripts/traffic-html-edge.test.mjs` | sửa | B, D | URL RPC v3 + ca từ chối `contract_version` lạ |
| 11 | `app/scripts/test-traffic-html-offline.mjs` | sửa | D | artifact + assertion Playwright mới |
| 12 | `app/scripts/validate-traffic-html-release.mjs` | sửa | D | đối chiếu bổ sung `reported_seats` / LF |

**Không đụng tới:** `trafficWorkbookCore.ts` (whitelist tham số dùng chung — lý do B4 không thêm `detail=1`),
`trafficWorkbookRenderer.ts`, các migration v1/v2, `deploy/traffic-report/*`.

### 9.1 Migration v3 (file mới, khuôn sao chép v2)

```
-- (1) reporting.traffic_html_period_data_v3(r jsonb, p jsonb, p_as_of timestamptz)
--     CTE giữ nguyên thứ tự v2: params → operations → grouped → calendar → coverage
--                               → cells → positions → enriched → measures → datasets
--     • calendar: + to_char(d::date,'YYYY"-Q"Q') AS quarter        (dòng ~144-150)
--     • positions: + ('hours-slot', {hour,slot,date}) chỉ khi (p->>'calendar_days')::int <= 35
--                  + ('config', {airline,weekday,config_class})    (dòng ~170-173)
--                  + ('flight_detail', {date,airline,route,flight_number}) theo tiền đề B4
--     • measures/enriched: 7 metric giữ nguyên; riêng 'config' cộng thêm reported_seats
--     • datasets: 3 resource mới; flight_detail kèm aircraft_type/config_seats/note/typical_time
--     • output: 'calendar' kèm quarter (dòng ~216-218)
-- (2) public.get_public_traffic_html_export_v3(p_request, p_expected_watermark, p_data_as_of)
--     sao chép v2 (dòng ~221-258): chốt watermark + data_version + trần 250k dòng / 25 MiB
--     + guard HTML_PERIOD_UNAVAILABLE; flight_detail vượt 40.000 dòng → resource complete=false (không raise)
-- (3) quyền như v2 (dòng ~261-268): owner postgres; revoke all …; grant execute … to service_role
-- v2 KHÔNG bị sửa, KHÔNG drop
```

### 9.2 `trafficHtmlReportContract.ts` (sau chỉnh sửa)

```
HTML_DATA_VERSION = 'traffic-html-data-v3'            // dòng 2 đổi giá trị
Dataset = … | 'config' | 'flight_detail'              // dòng ~28
HtmlRow  += reported_seats?: number|null              // Σ ghế của các leg đã ghi nhận khách (dataset config)
            config_class?:  string|null               // 'Tàu nhỏ' | 'Tàu to' (khi không nằm trong grain)
            aircraft_type?: string|null               // flight_detail
            note?:          string|null               // flight_detail (Bags Delivered / Departed …)
HtmlCalendarDay += quarter: string                    // '2026-Q3'
normalizeHtmlRequest: + từ chối contract_version ≠ HTML_DATA_VERSION (giữ nguyên các kiểm tra khác)
export function htmlKpiCards(data: HtmlEnvelope): Array<{label:string;value:string;hint:string;tones:'plain'|'warn'}>
  // thuần, không DOM; dùng kpi + timeline + market rows; nhúng vào runtime bằng toString() như sum/compare
```

### 9.3 `trafficHtmlReportModel.ts` (sau chỉnh sửa)

```
DATASETS = [kpi, timeline, market, market_daily, aircraft, hours, frequency, config, flight_detail]   // dòng 4
FIELDS   = { …, hours: ['hour','date'], config: ['airline','weekday','config_class'],
             flight_detail: ['date','airline','route','flight_number'] }                              // dòng 5
validateMetric: giữ nguyên (7 metric + coverage + pax_status)
validateHtmlEnvelope: thêm ensure (đặt trong vòng lặp resource, cạnh dòng 117-125)
  • config: reported_seats là số nguyên ≥ 0; có config_class ⇒ reported_seats > 0
  • hours: slot khớp ^([01]\d|2[0-3]):(00|30)$; date chỉ tồn tại khi period.calendar_days ≤ 35
  • flight_detail: row_count ≤ 40.000 hoặc complete=false; có note/aircraft_type ⇒ metric còn nguyên
  • calendar: quarter khớp date (to_char) — chống SQL trả sai quý
expectedPeriods / assert quyền: giữ nguyên
```

### 9.4 `trafficHtmlPivotRuntime.ts` (sau chỉnh sửa — theo mốc dòng hiện tại)

| Mốc | Nội dung hiện tại | Việc làm |
| :--- | :--- | :--- |
| 17-57 | helpers (`fmt`, `date`, `range`, `name`, `el`, `select`…) | + `slotLabel`, `quarterLabel`, `weekKey(t)` cho `business_week`/`iso_week` |
| 59-76 | `tabs` (bao/tuần/thường) | + `{id:'peak-grid'}` (heatmap Ngày × Slot), `+ {id:'config'}` (LF), `+ {id:'detail'}` — mỗi tab chỉ hiện khi dataset tương ứng có mặt |
| 118-126 | header (tiêu đề, kỳ, phạm vi, chú thích, badge mốc chốt) | + `kpiBand()` gọi `helpers.kpiCards(data)` → `<section class="pivot-kpi-band">` |
| 192-235 | `showDrilldown()` (flyout) | ưu tiên rows `flight_detail` khi có; fallback `market_daily` như hiện tại |
| 370-405 | `columns()` | + nhánh `s.time==='quarter'`, `s.time==='day_index'` (1..31); nhánh tuần đọc `s.weekAxis` |
| 615-631 | `monthChart()` (có `svg()` cục bộ) | hoist `svg()` lên scope mount; + `weekChart()` (cột theo tuần, khuôn `Week!Chart`) |
| 663-720 | `renderHoursView()` | + 2 dòng phụ 00/30 khi có `slot` |
| mới | — | `renderSlotGrid(s)`: ngày × 48 slot, tái dùng `.heatmap-cell.hot-1..hot-5` |
| mới | — | `renderConfigView(s)`: LF = `reported_pax/reported_seats` **chỉ khi** `unreported_legs===0`, kèm cột Khách/Chuyến |
| 798-853 | `renderContent()` dispatch | + 3 nhánh tab mới |
| 855-982 | `controls()` (metric/chiều/trục/cấp/nhóm/lọc/sắp xếp) | + select `weekAxis` (T6–T5 ↔ ISO, nhãn kèm ngày mở–kết tuần); presets 6 mục |

### 9.5-9.9 Các file còn lại

- **`trafficHtmlPivotStyles.ts`**: thêm cuối template `\``: `.pivot-kpi-band`, `.pivot-kpi`, `.pivot-kpi-value`,
  `.slot-grid` (dùng lại `.heatmap-cell`), `.week-chart`, `.pivot-coverage-chip` + luật `@media print` cho dải KPI
  (ẩn ở bản in ngắn, giữ ở bản in đầy đủ theo `pivot-print-pages`).
- **`trafficHtmlReportRenderer.ts`**: trong `helpers` của runtime string (dòng ~25-35) thêm
  `kpiCards:(${htmlKpiCards.toString()})`; kiểu helpers ở 3 mount thêm `kpiCards: typeof htmlKpiCards`.
- **`traffic-report/index.ts`**: `handleHtmlExport` (dòng ~904) `postgrestRpc('get_public_traffic_html_export_v2',…)`
  → `…_v3`; giữ nguyên mọi nhánh lỗi, header, tên file.
- **`public_traffic_html_export_pglite.mjs`**: `createHtmlTestDatabase()` thêm cột ghế/loại tàu/note vào fixture
  `reporting.html_fixture_candidates` và áp migration v3 hai lần sau v2; `run()` thêm khối assert mới
  (slot/date/quarter/seats>0/LF guard/detail budget) **trước** assert `permission` + `DATA_VERSION_CHANGED`.
- **`traffic-html-edge.test.mjs`**: dòng 25 đổi URL RPC mong đợi sang `…_v3`; thêm ca `?contract_version=traffic-html-data-v2` → 400.
- **`test-traffic-html-offline.mjs`**: thêm artifact cho `BAO_CAO_SAN_LUONG` + `WEEKLY_DETAIL`, assert DOM cho
  dải KPI, 6 preset, 2 trục tuần, tab heatmap, cột LF; đo `open_ms`/`bytes` như cũ.
- **`validate-traffic-html-release.mjs`**: đối chiếu thêm `reported_seats`/LF với kỳ đóng băng.

### 9.10 Cấu trúc file HTML kết xuất (sau chỉnh sửa)

```
<!doctype html><html lang="vi">
  <head> CSP default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'
         <title>{Báo cáo tuần|Báo cáo sản lượng|Tổng quan khai thác tháng|…}</title>
         <style> css + detailsCss + weeklyCss [+ monthlyStyles] + pivotStyles (+ khối KPI/heatmap/chart mới) </style>
  <body> skip-link → #report → noscript
         <script id="report-data" type="application/json"> {envelope v3} </script>
         <script> runtime: helpers{sum,compare,kpiCards,summary,pivot} + mount thường/tháng + mountTrafficHtmlPivot </script>

envelope: contract_version='traffic-html-data-v3' · source_watermark · data_version · data_as_of · snapshot_scope
          · normalized_request · request_hash · periods · comparison_pairs · calendar (kèm quarter) · resources[]

DOM sau render — header: h1 · kỳ + múi giờ · phạm vi lọc · chú thích —/* · badge "Mốc chốt dữ liệu hoàn tất"
          · DẢI KPI (mới) · nav tabs · main → mỗi tab một section

tabs sau chỉnh sửa (tab mới chỉ xuất hiện khi dataset tương ứng có trong envelope):
  BAO_CAO_SAN_LUONG : TOTAL | {JAN..OCT} | Analysis_Airline | Analysis_Country | Tuần cả mùa
                      | Khung giờ cao điểm | Cơ cấu đội tàu | Tần suất khai thác | + LF theo lớp ghế
  các loại còn lại  : Hãng hàng không | Thị trường | Chặng bay | Theo ngày | Khung giờ cao điểm
                      | Cơ cấu đội tàu | Tần suất khai thác | + Ngày × Khung giờ | + LF theo lớp ghế
                      | + Chi tiết chuyến (kỳ ≤ 7 ngày)
```
