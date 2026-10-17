# Kế hoạch nâng cấp xu hướng, Top 10 và mẫu khai thác theo tuần của Public Traffic Report

**Ngày lập:** 2026-09-05  
**Trạng thái:** Đã triển khai production và nghiệm thu ngày 2026-09-05  
**Trang mục tiêu:** Public Traffic Report `/reports/traffic`  
**Codebase thực hiện:** `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report`  
**Codebase đồng bộ/đối chiếu:** `C:\Users\tuan\Documents\SeasonalManagement`  
**Kế hoạch liên quan:** `SeasonalManagement-web-traffic-report/docs/superpowers/plans/2026-09-04-public-traffic-report-peak-heatmap-breakdowns.md`

## 1. Mục tiêu

1. Tự động gom biểu đồ xu hướng theo tháng khi khoảng chọn đi qua hơn 3 tháng lịch, nhưng vẫn giữ biểu đồ theo ngày cho phạm vi ngắn.
2. Bảng xu hướng luôn gom theo tháng và cho phép mở từng tháng để xem chi tiết theo ngày.
3. Đổi hai khối phân tích thành `Top 10 chặng bay` và `Top 10 Quốc gia`.
4. Mỗi khối Top 10 có hai biểu đồ tròn độc lập:
   - tỷ trọng số chuyến;
   - tỷ trọng sản lượng khách đã ghi nhận.
5. Mỗi biểu đồ hiển thị Top 10 theo đúng metric của nó; phần còn lại được gộp thành `Khác`.
6. Bảng chặng bay và quốc gia cố định 20 dòng/trang, vẫn có phân trang và xuất toàn bộ dữ liệu.
7. Mở rộng `Mẫu khai thác theo tuần` hết chiều ngang và sửa lệch contract V2 làm chế độ Chuyến bay đến/đi hoặc breakdown theo tháng hiển thị sai.
8. Giữ Report đồng bộ dữ liệu với production dashboard, không đưa thông tin kỹ thuật vào giao diện báo cáo.

## 2. Kết quả nghiên cứu hiện trạng

### 2.1. Xu hướng

- `TrafficReportTrend.tsx` hiện dựng trực tiếp toàn bộ điểm theo ngày.
- Chiều rộng mỗi cột được chia theo tổng số ngày; khoảng dài làm cột và nhãn quá dày.
- Insight hiện luôn dùng ngôn ngữ `Ngày nhiều chuyến nhất` và `Ngày đông khách nhất`.
- Bảng dữ liệu hiện là một danh sách ngày phẳng, chưa gom theo tháng và chưa tải chi tiết theo nhu cầu.

### 2.2. Chặng bay và quốc gia

- `TrafficReportDimensionSection.tsx` hiện tải 50 dòng/trang.
- Phần Top 10 lấy 10 dòng đầu nhưng hiển thị bằng hai thanh tỷ trọng, chưa phải biểu đồ tròn.
- Tiêu đề hiện còn hậu tố `theo số chuyến`.
- API dimension V2 đã có số chuyến, sản lượng khách, `flight_share` và `pax_share`, nhưng chưa có một contract riêng trả Top 10 cộng với `Khác`.

Kết quả kiểm tra production cho phạm vi `2026-01-01 → 2026-09-04`:

- Route có 46 nhóm; Top 10 theo số chuyến chiếm khoảng 85,63%, `Khác` khoảng 14,37%.
- Country có 18 nhóm; Top 10 theo số chuyến chiếm khoảng 97,58%, `Khác` khoảng 2,42%.
- Contract hiện tại đủ dữ liệu để chứng minh biểu đồ `Top 10 + Khác` khả thi, nhưng phần `Khác` vẫn nên được backend tính và trả rõ ràng.

### 2.3. Mẫu khai thác theo tuần

Kiểm tra trực tiếp production ngày 2026-09-05 xác nhận:

- V1 và V2 đều trả đủ 7 thứ, cùng tổng chuyến, chuyến đến và chuyến đi.
- V2 chỉ trả `average/min/max` cho tổng chuyến; chưa trả các trường tương ứng cho chuyến đến và chuyến đi.
- V1 đã có `average_arrivals`, `min_arrivals`, `max_arrivals`, `average_departures`, `min_departures`, `max_departures` và `complete_day_count`.
- V1 đã có `day_of_week_monthly`; V2 chưa có trường này.
- `DayOfWeekChart` hiện đọc các field đến/đi từ V2 rồi dùng giá trị mặc định `0` khi field bị thiếu. Đây là nguyên nhân chế độ Chuyến bay đến/đi có thể hiển thị sai thành 0.
- `toTrafficReportPresentationBundle` chưa ánh xạ breakdown thứ-theo-tháng từ V2.
- Card tuần hiện nằm trong `xl:grid-cols-2` cùng card đội tàu, nên chỉ chiếm nửa chiều ngang ở màn hình lớn.

### 2.4. Đồng bộ dashboard

- Tại thời điểm kiểm tra, Report V2 và production dashboard cùng `source_watermark = 50198`.
- Tổng dữ liệu theo thứ của V1/V2 khớp; lỗi hiện tại là lệch hình dạng contract và cách trình bày, không phải lệch nguồn dữ liệu lõi.
- Dashboard publication vẫn phụ thuộc aggregate V2. Migration mới phải tương thích ngược và không được làm gián đoạn quy trình publication.

### 2.5. Worktree

- Worktree report đang có nhiều thay đổi chưa commit, bao gồm heatmap, workbook export, V2 adapter và dashboard.
- Migration `20260904120000_public_traffic_peak_heatmaps.sql` đã tồn tại và chức năng tương ứng đã xuất hiện trên production V1.
- Không sửa lại migration lịch sử này. Phần parity V2 phải đi bằng migration mới có timestamp sau.

## 3. Quyết định đã chốt

| ID | Quyết định |
|---|---|
| D1 | Biểu đồ xu hướng dùng ngày khi phạm vi giao với tối đa 3 tháng lịch; dùng tháng khi giao với từ 4 tháng lịch trở lên. |
| D2 | Số tháng được tính theo số bucket `YYYY-MM` khác nhau mà khoảng chọn đi qua, không dùng phép chia số ngày cho 30. |
| D3 | Bảng xu hướng luôn gom theo tháng, kể cả khi biểu đồ đang hiển thị theo ngày. |
| D4 | Dòng tháng là tổng trong phần giao giữa tháng và khoảng chọn; tháng đầu/cuối không đủ tháng phải có nhãn `Một phần`. |
| D5 | Chi tiết ngày chỉ tải khi người dùng mở tháng và phải dùng cùng phiên bản dữ liệu với phần tổng quan. |
| D6 | Tiêu đề dùng đúng `Top 10 chặng bay` và `Top 10 Quốc gia`, không thêm `theo số chuyến`. |
| D7 | Mỗi dimension có hai donut: `Tỷ trọng số chuyến` và `Tỷ trọng sản lượng khách`. |
| D8 | Hai Top 10 được xếp hạng độc lập. Một chặng/quốc gia có thể thuộc Top 10 khách nhưng không thuộc Top 10 chuyến và ngược lại. |
| D9 | Mỗi donut có tối đa 11 lát: Top 10 cộng `Khác`; `Khác` dùng màu trung tính. |
| D10 | Bảng dimension dùng 20 dòng/trang, giữ phân trang và export toàn bộ dữ liệu. |
| D11 | Mẫu khai thác theo tuần chiếm toàn bộ chiều ngang và dùng đúng metric A/D/all do backend sở hữu. |
| D12 | Dữ liệu thiếu là `—`; không chuyển field thiếu hoặc Pax NULL thành `0`. |
| D13 | Report và Dashboard đồng bộ theo canonical source/version; không yêu cầu hai giao diện dùng chung endpoint hoặc cùng chiến lược cache. |
| D14 | Không hiển thị watermark, contract version, source mode, request hash, cache state hoặc tên bảng/RPC trên báo cáo công khai. |
| D15 | Hạng mục này không thay đổi định dạng workbook export; chỉ chạy regression để bảo đảm workbook không bị ảnh hưởng. |

## 4. Phạm vi và ngoài phạm vi

### 4.1. Trong phạm vi

- Monthly aggregation cho biểu đồ và bảng xu hướng.
- Drill-down tháng → ngày.
- Hai donut tỷ trọng cho route và country.
- Page size 20 cho bảng route/country.
- Sửa V2 parity cho day-of-week và monthly weekday heatmap.
- Bố cục full-width cho mẫu khai thác theo tuần.
- Contract, SQL/RPC, Edge API, adapter, frontend, test, staging và production verification.
- Ẩn metadata kỹ thuật khỏi giao diện báo cáo công khai nếu bản đang phát hành còn hiển thị.

### 4.2. Ngoài phạm vi

- Không thêm row-level flight data vào API công khai.
- Không thay đổi logic Dashboard Operational Mode trong ứng dụng desktop.
- Không thay đổi công thức Annual Passenger KPI, forecast hoặc KPI target.
- Không thay đổi nội dung/format các workbook đã triển khai.
- Không thiết kế lại toàn bộ trang Report.
- Không deploy production nếu chưa có phê duyệt triển khai riêng.

## 5. Định nghĩa metric

### 5.1. Tổng hợp xu hướng theo tháng

Với tháng `m` và scope `s`:

```text
monthly_flights(m, s)   = sum(daily_flights)
monthly_arrivals(m)     = sum(daily_arrivals)
monthly_departures(m)   = sum(daily_departures)
monthly_reported_pax(m) = sum(Pax của các leg đã báo cáo)
```

Quy tắc Pax:

- Nếu không có leg nào đã báo cáo Pax trong bucket tháng thì `reported_pax = null` và UI hiển thị `—`.
- Nếu có leg báo cáo giá trị 0 thì đó là số 0 hợp lệ.
- Không dùng `coalesce(Pax, 0)` trước khi xác định coverage.
- Tổng tháng phải kèm coverage/status đủ để UI phân biệt đầy đủ, một phần, thiếu và tương lai.

Quy tắc tháng một phần:

- Bucket đầu và cuối chỉ lấy giao giữa tháng và `from/to`.
- Dòng summary hiển thị `Tháng 01/2026 · Một phần` khi phạm vi không bao phủ toàn tháng hoặc coverage chưa đầy đủ.
- Không so sánh một tháng một phần với tháng đầy đủ mà không có nhãn cảnh báo nghiệp vụ.

### 5.2. Top 10 số chuyến

```text
Top 10 = 10 dimension rows có flights lớn nhất
Khác   = total_flights - sum(flights của Top 10)
share  = value / total_flights
```

Tie-break ổn định: `flights DESC`, sau đó `label ASC` theo locale tiếng Việt.

### 5.3. Top 10 sản lượng khách

```text
Top 10 = 10 dimension rows có reported_pax lớn nhất trong dữ liệu đã ghi nhận
Khác   = total_reported_pax - sum(reported_pax của Top 10)
share  = value / total_reported_pax
```

Quy tắc:

- Nhóm `reported_pax = null` không được đổi thành 0 để tham gia xếp hạng.
- Nếu toàn phạm vi chưa có Pax đã ghi nhận, donut hiển thị empty state, không dựng vòng tròn 0%.
- Chú thích nghiệp vụ dùng câu ngắn: `Tính trên dữ liệu hành khách đã ghi nhận.`
- Không đưa coverage ratio, watermark hoặc thuật ngữ kỹ thuật vào legend chính; coverage chi tiết chỉ ở tooltip/bảng khi có ích cho người dùng nghiệp vụ.

### 5.4. Mẫu khai thác theo tuần

Với mỗi ISO weekday `d = 1..7`:

```text
average_flights(d)    = average daily flights trên các ngày complete có weekday d
average_arrivals(d)   = average daily arrivals trên các ngày complete có weekday d
average_departures(d) = average daily departures trên các ngày complete có weekday d
```

- `min/max` dùng cùng tập ngày complete với average.
- Ngày complete có 0 chuyến vẫn tham gia mẫu số.
- Ngày partial/missing không được chứng nhận thành 0.
- `arrivals + departures = flights` phải đúng ở trường total có thể cộng.

## 6. Thiết kế UX mục tiêu

### 6.1. Biểu đồ xu hướng

Chế độ tự động:

```text
1–3 tháng lịch  -> Cột chuyến + đường khách theo ngày
4+ tháng lịch   -> Cột chuyến + đường khách theo tháng
```

- Eyebrow hoặc subtitle ghi rõ `Theo ngày` hoặc `Theo tháng` bằng ngôn ngữ nghiệp vụ.
- Tooltip theo tháng hiển thị tháng, tổng chuyến, tổng khách đã ghi nhận và trạng thái `Một phần` nếu có.
- Insight đổi theo granularity:
  - ngày: `Ngày nhiều chuyến nhất`, `Ngày đông khách nhất`;
  - tháng: `Tháng nhiều chuyến nhất`, `Tháng đông khách nhất`.
- Pax null tạo khoảng trống/empty marker trên đường, không nối về 0.
- Không thêm animation trang trí; chuyển granularity chỉ dùng state transition ngắn hoặc không animation.

### 6.2. Bảng xu hướng tháng → ngày

Mỗi dòng tháng gồm:

- Tháng;
- số ngày được chọn;
- tổng chuyến;
- tổng khách đã ghi nhận;
- nhãn `Đầy đủ`, `Một phần`, `Thiếu dữ liệu` hoặc `Chưa đến kỳ` khi cần.

Hành vi mở rộng:

- dùng disclosure/accordion có `aria-expanded` và thao tác bàn phím;
- mặc định chỉ mở tháng chứa ngày kết thúc của phạm vi;
- tải daily rows khi mở lần đầu;
- cache theo filter + tháng + phiên bản dữ liệu;
- abort request cũ khi đổi filter hoặc đóng/mở nhanh;
- lỗi chỉ hiển thị trong tháng đang mở, kèm `Thử lại`;
- không render trước hàng trăm daily rows.

### 6.3. Hai donut của mỗi dimension

Desktop:

```text
Top 10 chặng bay
[Tỷ trọng số chuyến] [Tỷ trọng sản lượng khách]
[Bảng dữ liệu 20 dòng/trang]

Top 10 Quốc gia
[Tỷ trọng số chuyến] [Tỷ trọng sản lượng khách]
[Bảng dữ liệu 20 dòng/trang]
```

Mobile:

- hai donut xếp dọc;
- legend nằm dưới biểu đồ, không ép nhãn vào lát nhỏ;
- bảng cuộn ngang trong vùng có focus.

Mỗi donut:

- tối đa 10 màu category hiện có cộng màu slate cho `Khác`;
- legend có nhãn, giá trị tuyệt đối và phần trăm;
- hover/focus trên lát hoặc legend làm nổi cùng category;
- screen reader nhận được danh sách Top 10 và `Khác`;
- màu không phải phương tiện duy nhất để phân biệt dữ liệu;
- center label nêu tổng số chuyến hoặc tổng khách đã ghi nhận.

### 6.4. Bảng route/country

- Page size cố định 20.
- Giữ sort nghiệp vụ hiện có nếu còn cần; đổi sort reset về trang 1.
- Giữ `Trang trước`, `Trang sau`, số nhóm và số trang.
- Export lấy toàn bộ dữ liệu sau filter, không chỉ 20 dòng đang thấy.
- Cột giữ tối thiểu: nhóm, số chuyến, tỷ trọng chuyến, sản lượng khách, tỷ trọng khách.

### 6.5. Mẫu khai thác theo tuần

- Đưa `DayOfWeekChart` ra khỏi lưới hai cột hoặc đặt `xl:col-span-2` trong một grid có cấu trúc hoàn chỉnh.
- Card tuần chiếm 100% chiều rộng nội dung ở desktop và mobile.
- Fleet Mix chuyển xuống hàng riêng; không để card tuần full-width nhưng Fleet Mix bị treo nửa hàng.
- Chart luôn dựng đủ 7 cột Thứ 2 → Chủ nhật theo một weekday spine đã normalize.
- Nếu metric của scope A/D/all là null, hiển thị `—` và không dựng cột; không dùng `?? 0` cho dữ liệu thiếu.
- Heatmap tháng dùng cùng scope với chart và cùng denominator backend.

### 6.6. Nội dung kỹ thuật

Không hiển thị trên trang công khai:

- `Nguồn live/snapshot`;
- watermark/data version;
- contract version;
- request/filter hash;
- cache HIT/MISS;
- tên bảng, view, RPC hoặc thông báo lỗi SQL.

Các thông tin này tiếp tục tồn tại trong response headers, structured logs, test receipt và runbook để vận hành/đối soát.

## 7. Contract/API mục tiêu

### 7.1. Timeline theo tháng và drill-down ngày

Mở rộng endpoint V2 theo hướng additive:

```text
GET /api/report/v2/timeline
  ?from=...
  &to=...
  &granularity=month
  &expected_watermark=...
  &read_version=...
```

Chi tiết một tháng:

```text
GET /api/report/v2/timeline
  ?from=<global from>
  &to=<global to>
  &granularity=day
  &month=2026-08
  &expected_watermark=...
  &read_version=...
```

`month` là projection parameter nằm trong khoảng filter gốc, không thay `from/to` và không tạo filter hash khác với overview đã pin.

Response tháng đề xuất:

```ts
interface TrafficMonthlyTimelinePoint {
  month: string;
  from: string;
  to: string;
  selected_day_count: number;
  complete_day_count: number;
  partial_day_count: number;
  missing_day_count: number;
  flights: number | null;
  arrivals: number | null;
  departures: number | null;
  reported_pax: number | null;
  reported_legs: number;
  due_legs: number;
  status: 'complete' | 'partial' | 'missing' | 'future' | 'zero';
}
```

Yêu cầu:

- aggregation thực hiện trong SQL/RPC;
- Edge chỉ validate, paginate và định hình response;
- request ngày của tháng phải kiểm tra tháng giao với filter gốc;
- mọi response phụ phải giữ cùng `source_watermark`, `data_as_of`, `filter_hash` và `read_version_token`.

### 7.2. Dimension share cho donut

Thêm resource aggregate riêng để không làm contract bảng trở nên mơ hồ:

```text
GET /api/report/v2/dimension-share
  ?dimension=route|country
  &metric=flights|reported_pax
  &limit=10
  &from=...
  &to=...
  &type=...
  &airline=...
  &route=...
  &country=...
  &expected_watermark=...
  &read_version=...
```

Response đề xuất:

```ts
interface TrafficDimensionShareResponse {
  contract_version: 'traffic-report-v2';
  dimension: 'route' | 'country';
  metric: 'flights' | 'reported_pax';
  limit: 10;
  total_value: number | null;
  top_rows: Array<{
    key: string;
    label: string;
    value: number;
    share: number;
  }>;
  other: {
    label: 'Khác';
    value: number;
    share: number;
  } | null;
}
```

Invariant:

- `top_rows.length <= 10`;
- `other.value >= 0`;
- tổng share của Top 10 cộng `Khác` bằng 1 trong sai số làm tròn cho phép khi `total_value > 0`;
- `reported_pax = null` không được ép thành 0 để xếp hạng;
- chỉ trả aggregate, không trả flight identity hoặc row-level keys.

### 7.3. Dimension table

- Giữ endpoint V2 dimension hiện có.
- Frontend đổi `page_size` từ 50 thành 20.
- Edge tiếp tục validate page size, sort, version pinning và total rows.
- Export endpoint giữ toàn bộ rows.

### 7.4. V2 weekday parity

Mở rộng `TrafficV2ReportParity.breakdowns` bằng:

```ts
day_of_week: Array<{
  day_index: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  calendar_days: number;
  complete_day_count: number;
  total_flights: number | null;
  average_flights: number | null;
  min_flights: number | null;
  max_flights: number | null;
  arrivals: number | null;
  average_arrivals: number | null;
  min_arrivals: number | null;
  max_arrivals: number | null;
  departures: number | null;
  average_departures: number | null;
  min_departures: number | null;
  max_departures: number | null;
  status: 'complete' | 'partial' | 'missing';
}>;

day_of_week_monthly: TrafficMonthlyDayOfWeekRow[];
```

- Adapter phải ánh xạ cả hai field vào presentation bundle.
- Validator phải kiểm tra đủ 7 `day_index` duy nhất, đúng thứ tự và giá trị không âm/null hợp lệ.
- Không chỉ kiểm tra `length === 7`.

## 8. Database/RPC plan

1. Tạo migration mới sau `20260904120000_public_traffic_peak_heatmaps.sql`; không sửa migration đã chạy production.
2. Mở rộng hoặc thay thế an toàn `get_public_traffic_report_v2(...)` để:
   - dùng coverage-aware weekday aggregate đã có trong migration heatmap;
   - trả đầy đủ A/D/all statistics;
   - trả `day_of_week_monthly`;
   - cung cấp monthly timeline aggregate;
   - cung cấp Top-N dimension share và `Khác` theo metric.
3. Nguồn dữ liệu duy nhất vẫn là canonical/public aggregate hiện hành.
4. Không dùng row-level data trong public wrapper.
5. Revoke helper nội bộ khỏi `anon`, `authenticated` và browser-facing roles.
6. Chỉ Edge service role được execute public aggregate wrapper cần thiết.
7. Migration phải apply được hai lần trong PGlite rehearsal.
8. Dashboard publication RPC phải tiếp tục chạy với payload V2 mở rộng.
9. Không drop function signature cũ trước khi toàn bộ caller mới đã sẵn sàng; ưu tiên `create or replace` tương thích.

## 9. Edge/API plan

Trong `app/supabase/functions/traffic-report/index.ts`:

1. Thêm `granularity` và `month` vào canonical request parser của timeline.
2. Thêm endpoint allowlist `dimension-share`.
3. Validate:
   - `granularity ∈ {day, month}`;
   - `month` có định dạng `YYYY-MM` và giao với range gốc;
   - `dimension ∈ {route, country}`;
   - `metric ∈ {flights, reported_pax}`;
   - `limit = 10` cho public UI.
4. Dùng cùng read-version verification của overview/timeline/dimension hiện tại.
5. Cache key gồm canonical filter, granularity/month hoặc dimension/metric, watermark và data-as-of.
6. Lỗi version mismatch buộc client tải lại overview thay vì ghép dữ liệu của hai phiên bản.
7. Không lộ SQL error, RPC name hoặc secret trong response công khai.
8. Giữ `Cache-Control: no-store` cho export; aggregate read dùng cache policy ngắn hiện hành.

## 10. Frontend plan theo file

### 10.1. Contract và adapter

Các file:

- `app/src/lib/trafficReportContract.ts`
- `app/src/lib/trafficReportV2Contract.ts`
- `app/src/lib/trafficReportDataAdapter.ts`
- các file test tương ứng.

Công việc:

1. Thêm type/validator/build URL cho monthly timeline và dimension share.
2. Mở rộng V2 weekday contract bằng A/D statistics, coverage và monthly rows.
3. Ánh xạ `day_of_week_monthly` vào presentation bundle.
4. Không recompute KPI, average, share hoặc `Khác` trong adapter.
5. Giữ backward-compatible parsing trong thời gian schema và frontend rollout lệch nhau; feature mới chỉ render khi payload đạt contract đầy đủ.

### 10.2. Xu hướng

Các file:

- `app/src/app/(public-report)/reports/traffic/TrafficReportTrend.tsx`
- đề xuất tách `TrafficTrendTable.tsx` nếu component tiếp tục lớn.

Công việc:

1. Thêm helper xác định số tháng lịch bị giao bởi range.
2. Chọn day/month granularity tự động.
3. Render chart từ daily hoặc monthly contract tương ứng.
4. Đổi label, tooltip và insight theo granularity.
5. Tạo monthly grouped table và disclosure chi tiết ngày.
6. Lazy fetch/cache/abort daily detail theo tháng.
7. Giữ Pax null là gap/`—`.
8. Không hiển thị thông tin kỹ thuật của version trong UI.

### 10.3. Donut Top 10

Các file:

- `app/src/app/(public-report)/reports/traffic/TrafficReportDimensionSection.tsx`
- đề xuất thêm `TrafficDimensionShareDonut.tsx` để tái sử dụng cho route/country và flights/Pax.

Công việc:

1. Tải song song hai aggregate share: flights và reported Pax.
2. Không dùng chung Top 10 của flights cho donut Pax.
3. Render Top 10 + `Khác` theo payload backend.
4. Thêm legend, tooltip/focus, center total và empty/error/loading state riêng cho từng donut.
5. Đổi title đúng wording đã chốt.
6. Đổi table fetch page size 50 → 20 và reset page khi filter/sort/version đổi.
7. Giữ export toàn bộ.

### 10.4. Mẫu khai thác theo tuần

Các file:

- `app/src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficMonthlyDayOfWeekHeatmap.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`

Công việc:

1. Loại bỏ fallback null → 0 đối với average/min/max thiếu.
2. Normalize weekday spine 1–7 trước khi render.
3. Dùng A/D/all fields đã được backend trả đầy đủ.
4. Truyền `day_of_week_monthly` từ V2 adapter vào heatmap.
5. Mở rộng card tuần 100% chiều ngang; bố trí Fleet Mix ở hàng riêng.
6. Giữ selector A/D/all đồng bộ giữa chart, bảng và heatmap.

### 10.5. Technical copy cleanup

Trong `TrafficReportClient.tsx` và các component report:

- bỏ dòng công khai dạng `Nguồn live/snapshot · watermark ...` nếu còn tồn tại;
- chuyển chi tiết này sang development logging/test receipt;
- thông báo lỗi công khai chỉ dùng ngôn ngữ nghiệp vụ, ví dụ `Dữ liệu đang được cập nhật, vui lòng thử lại`.

## 11. Test plan

### 11.1. Contract/unit

Test bắt buộc:

- range chạm đúng 1, 2, 3 tháng → daily;
- range chạm 4 tháng → monthly;
- range 31/01 → 01/04 chạm 4 tháng và phải monthly;
- monthly point giữ Pax null khi không có reported leg;
- partial first/last month có status đúng;
- drill-down month không đổi filter hash/read version;
- dimension share xếp hạng flights và Pax độc lập;
- fixture có nhóm Top 10 khách nhưng không thuộc Top 10 chuyến;
- `Khác = total - Top 10`, không âm và share sum đúng;
- Pax total null/zero có empty/zero semantics đúng;
- weekday validator từ chối trùng/mất/sai thứ tự day index;
- V2 adapter giữ đầy đủ A/D/monthly weekday fields.

### 11.2. Database/PGlite

Fixture bao phủ:

- ít nhất 4 tháng;
- tháng đầy đủ và tháng giao một phần;
- ngày complete zero, partial, missing và future;
- Pax null, true zero và số dương;
- route/country có thứ hạng chuyến khác thứ hạng Pax;
- hơn 10 route/country để xác minh `Khác`;
- đủ 7 thứ, có min/max/average A/D/all;
- monthly weekday rows cho nhiều tháng.

Assertions:

- monthly totals bằng tổng daily aggregates cùng filter/version;
- `all = A + D` cho flight totals;
- Pax null không thành zero;
- Top 10 và `Khác` không double-count;
- V1 và V2 weekday parity khớp trên cùng dataset;
- dashboard publication RPC tiếp tục tạo payload hợp lệ;
- migration apply hai lần không lỗi;
- helper nội bộ không callable từ role công khai.

### 11.3. Edge contract/isolation

- canonical redirect giữ đủ granularity/month/dimension/metric.
- request phụ thiếu read version bị từ chối.
- watermark mismatch trả version-changed.
- filter hash giữ nguyên giữa overview và month drill-down.
- page size table là 20; limit donut là 10.
- dimension-share không chứa raw flight identity.
- cache key của flights và Pax không va nhau.
- export không bị giới hạn 20 dòng.

### 11.4. UI/source/browser

- chart dùng monthly khi 4+ tháng và daily khi tối đa 3 tháng.
- table luôn có parent row theo tháng.
- mở tháng mới tải daily detail; loading/error/retry nằm đúng tháng.
- hai donut xuất hiện cho route và country.
- title không còn `theo số chuyến`.
- donut Pax dùng ranking riêng và có chú thích dữ liệu đã ghi nhận.
- bảng hiển thị đúng 20 dòng/trang và chuyển trang được.
- weekly card full width tại 1440px; không vỡ ở 375px/768px.
- A/D/all của weekday không rơi về 0 do field thiếu.
- heatmap weekday monthly có dữ liệu V2.
- không xuất hiện watermark, contract/source/cache text trên UI.
- keyboard focus, legend, table disclosure và screen-reader summary hoạt động.
- không có mojibake trong nhãn tiếng Việt.

### 11.5. Lệnh kiểm tra dự kiến

Chạy từ `SeasonalManagement-web-traffic-report/app`:

```powershell
npm run test:traffic-report-contract
npm run test:rules
npx tsc --noEmit --pretty false
npx eslint "src/app/(public-report)/reports/traffic" "src/lib/trafficReport*.ts"
npm run build:traffic-report
```

Không coi build pass là bằng chứng production pass; vẫn phải đối chiếu API và UI công khai.

## 12. Trình tự thực hiện

### Phase 0 — Baseline và bảo vệ worktree

1. Ghi nhận `git status`, branch, commit, dirty paths của cả hai worktree.
2. Lập ownership map cho heatmap/workbook/V2/dashboard changes đang dở.
3. Không format hoặc ghi đè các file ngoài phạm vi.
4. Chụp fixture API production V1/V2 cho:
   - timeline dài hơn 3 tháng;
   - route/country pages;
   - weekday A/D/all;
   - dashboard publication version.
5. Ghi nhận production release hiện tại và release rollback trước đó.

### Phase 1 — Contract và test đỏ

1. Viết types/validators/builders cho monthly timeline và dimension share.
2. Viết test threshold 3/4 tháng, partial month, Pax null/zero.
3. Viết test Top 10 độc lập và `Khác`.
4. Viết V2 weekday parity tests bắt buộc A/D/monthly fields.
5. Viết source/UI tests cho title, page size, full-width và technical-copy removal.

### Phase 2 — Migration/RPC

1. Tạo migration mới, không sửa migration 20260904.
2. Bổ sung coverage-aware monthly timeline.
3. Bổ sung dimension-share Top N + `Khác`.
4. Bổ sung đầy đủ weekday A/D/monthly parity vào V2.
5. Chạy PGlite và migration-twice tests.
6. Kiểm tra dashboard publication function với payload V2 mở rộng.

### Phase 3 — Edge/API

1. Thêm timeline granularity/month parser.
2. Thêm dimension-share route.
3. Áp read-version pinning, cache key và response validation.
4. Chạy Edge contract/isolation tests.
5. Kiểm tra CSV/workbook endpoints không regress.

### Phase 4 — Frontend

1. Nâng cấp Trend chart và insight.
2. Tạo grouped monthly table + lazy daily disclosure.
3. Tạo reusable donut component.
4. Nối hai donut vào route/country sections.
5. Đổi table page size thành 20.
6. Sửa weekday null handling, V2 adapter và full-width layout.
7. Bỏ technical metadata khỏi public copy.
8. Kiểm tra responsive/accessibility theo baseline UI.

### Phase 5 — Local verification và release candidate

1. Chạy contract, PGlite, Edge, isolation, rules, TypeScript, ESLint và report-only build.
2. Browser QA tại 375px, 768px và 1440px.
3. Kiểm tra range 3 tháng, 4 tháng, cross-year và partial month.
4. Kiểm tra route/country flights/Pax donuts và pagination.
5. Kiểm tra weekday A/D/all và monthly heatmap.
6. Tạo immutable report-only artifact, ghi hash và file count.
7. Dừng trước production nếu chưa có authorization riêng.

### Phase 6 — Staging và production khi được phê duyệt

1. Backup schema/function liên quan và xác minh restore material.
2. Rehearse migration trên clone tối thiểu hai lần.
3. Apply migration bằng account được phê duyệt.
4. Xác minh V1/V2/dashboard publication trước khi deploy frontend.
5. Deploy Edge và report artifact vào staging release riêng.
6. Acceptance trên staging với cùng ma trận filter/date/type.
7. Chuyển production symlink sang immutable release đã duyệt.
8. Kiểm tra public API, public UI, cache, quyền truy cập và dashboard publication.
9. Giữ release trước và migration rollback procedure trong soak window.

## 13. Ma trận đồng bộ Report/Dashboard

Mỗi lần staging/production acceptance phải đối chiếu:

| Trường hợp | Report | Dashboard/publication | Kỳ vọng |
|---|---:|---:|---|
| Toàn kỳ, all | Flights/Pax | Flights/Pax cùng kỳ | Khớp khi cùng version và cùng semantics |
| Toàn kỳ, A | Arrivals/Pax đến | Metric tương ứng nếu dashboard công bố | Khớp hoặc ghi rõ dashboard không có scope này |
| Toàn kỳ, D | Departures/Pax đi | Metric tương ứng nếu dashboard công bố | Khớp hoặc ghi rõ dashboard không có scope này |
| Pax true zero | `0` | `0` | Không đổi thành missing |
| Pax missing | `—`/null | missing/null | Không đổi thành 0 |
| Watermark đổi giữa request | Reload bundle | Publication giữ last-known-good | Không ghép hai version |
| V2 weekday | 7 rows + A/D/monthly | Publication vẫn tạo được | Không regress dashboard |

Không hiển thị bảng kỹ thuật này cho người dùng cuối; lưu trong acceptance receipt.

## 14. Rollback

### 14.1. Frontend

- Feature gate monthly trend, donut và V2 weekday parity độc lập nếu cần.
- Có thể quay về daily trend + share bars trong release trước mà không đổi dữ liệu.
- Rollback bằng production symlink về immutable release trước; không overwrite release.

### 14.2. Edge/API

- `dimension-share` và timeline granularity là additive, có thể ngừng route mà không ảnh hưởng overview/dimension cũ.
- Không remove endpoint cũ trong cùng release.
- Khi rollback frontend, giữ response field mới là an toàn vì caller cũ bỏ qua field bổ sung.

### 14.3. Database

- Không drop canonical views hoặc snapshot.
- Không rollback bằng cách sửa migration lịch sử.
- Nếu phải reverse, chuyển caller về signature cũ trước, rồi `create or replace` function về body đã backup.
- Sau rollback phải xác minh lại V1 overview, V2 overview, dashboard publication, route/country dimension và quyền RPC.

## 15. Definition of Done

Hạng mục chỉ hoàn tất khi:

- phạm vi tối đa 3 tháng hiển thị xu hướng theo ngày;
- phạm vi từ 4 tháng lịch trở lên hiển thị xu hướng theo tháng;
- bảng xu hướng luôn gom tháng và mở được chi tiết ngày bằng lazy loading;
- tháng một phần được ghi rõ, Pax missing không thành 0;
- route và country đều có donut số chuyến cùng donut sản lượng khách;
- mỗi donut có Top 10 độc lập và `Khác` do backend trả;
- bảng route/country đúng 20 dòng/trang, phân trang và export toàn bộ hoạt động;
- tiêu đề đúng `Top 10 chặng bay` và `Top 10 Quốc gia`;
- mẫu khai thác theo tuần full-width;
- scope A/D/all và heatmap tháng của weekday có dữ liệu đúng trên V2;
- không còn fallback field thiếu thành 0;
- public UI không hiển thị metadata kỹ thuật;
- Report và Dashboard cùng canonical version tại thời điểm đối chiếu hoặc hiển thị trạng thái chưa đồng bộ một cách nghiệp vụ;
- contract/PGlite/Edge/isolation/rules/typecheck/lint/build đều pass;
- browser QA desktop/mobile/keyboard không có console hoặc network error;
- production API/UI/dashboard/cache/privilege checks đều pass sau deployment;
- có artifact hash, migration receipt, acceptance evidence và rollback evidence;
- production chỉ được thay đổi sau phê duyệt triển khai riêng.

## 16. Biên bản thực hiện production — 2026-09-05

### 16.1. Phạm vi đã hoàn thành

- Xu hướng tự chuyển sang theo tháng khi khoảng chọn đi qua từ 4 tháng lịch; bảng xu hướng gom theo tháng và tải chi tiết ngày khi mở tháng.
- Route và Country có hai donut xếp hạng độc lập theo số chuyến và sản lượng khách; phần ngoài Top 10 được gộp thành `Khác`.
- Bảng route/country giới hạn tối đa 20 dòng/trang và giữ xuất toàn bộ dữ liệu.
- Mẫu khai thác theo tuần có đủ 7 thứ, đầy đủ chỉ tiêu A/D/all và breakdown theo tháng; khối hiển thị chiếm trọn hàng nội dung.
- Metadata kỹ thuật đã được loại khỏi giao diện báo cáo công khai.
- Dashboard production tiếp tục dùng publication hiện hành và render bình thường sau cutover.

### 16.2. Điều chỉnh kỹ thuật so với kế hoạch ban đầu

Không tạo migration mới. Sau khi kiểm tra contract và dữ liệu canonical hiện hành, monthly timeline, Top 10 + `Khác` và weekday parity có thể được dựng từ cùng aggregate V2 đã pin phiên bản ngay tại Edge. Cách này không thay đổi schema/RPC production, không mở rộng quyền dữ liệu công khai và vẫn giữ nguyên semantics Pax missing/true zero. Các endpoint mới vẫn bắt buộc `expected_watermark` và `read_version` cho các request phụ.

### 16.3. Release và rollback

- Release ID: `20260905T051741Z-monthly-trend-top10-weekday`.
- Static release: `/srv/seasonal-traffic-report/releases/20260905T051741Z-monthly-trend-top10-weekday`.
- Edge functions: `/srv/seasonal-traffic-report/functions/20260905T051741Z-monthly-trend-top10-weekday`.
- Static artifact SHA-256: `f22f2cbef2f903a66ccb4a535d4b444026749339c5c936c77f23f68e5cc2d034`.
- Edge artifact SHA-256: `c2fcd084fcce09fafe6bdcb2456103141f69917fc47620b3a0137831b303879a`.
- Rollback static: `/srv/seasonal-traffic-report/releases/20260904T232016Z-unified-dashboard-v2-workbooks`.
- Rollback Edge: `/srv/seasonal-traffic-report/functions/20260904T232016Z-unified-dashboard-v2-workbooks`.
- Compose backup: `/srv/seasonal-traffic-report/infra/docker-compose.yml.before-20260905T051741Z-monthly-trend-top10-weekday`.

### 16.4. Bằng chứng nghiệm thu

- Contract/unit/PGlite/Edge/isolation: 52 + 32 + 7 test đều pass; Edge contract và isolation pass.
- TypeScript, targeted ESLint, report-only production build và `git diff --check` đều pass.
- Public API sau cutover: `source_watermark = 50198`, đủ 7 weekday rows, 8 monthly rows cho 01/2026–08/2026, route trả 10 Top rows và `Khác`.
- Public UI `/reports/traffic`: hiển thị `Cả hai · Theo tháng`; mở tháng 07/2026 tải đúng 31 dòng ngày; hai donut chuyến/khách có `Khác`; bảng chặng bay có 20 dòng trang đầu; bảng quốc gia không vượt 20 dòng; không còn nội dung kỹ thuật và không có lỗi console.
- Public Dashboard `/dashboard`: trả HTTP 200, render publication KPI hiện hành và không có lỗi console.
- Nginx config hợp lệ; timer `seasonal-traffic-report-refresh.timer` vẫn `enabled` và `active`.
- Lần thử cutover qua sai cổng origin đã tự rollback về release trước; sau khi xác định đúng listener `127.0.0.1:8780`, cutover chính thức và toàn bộ smoke test đều pass.
