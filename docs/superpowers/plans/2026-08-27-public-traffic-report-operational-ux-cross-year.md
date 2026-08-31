# Kế hoạch cải thiện Public Traffic Report: dữ liệu liên tục xuyên mùa/năm và UX vận hành

**Ngày lập:** 2026-08-27  
**Cập nhật:** 2026-08-29, bổ sung Route là dimension Thị trường theo xác nhận mới nhất  
**Trạng thái:** Đã triển khai schema/API/UI và phát hành tại `report.ahtops.xyz`; còn chờ file nguồn lịch sử để backfill/reconcile  
**Phạm vi:** Public report `/reports/traffic`, API aggregate, reporting schema, server hosting, tunnel và production acceptance tại `report.ahtops.xyz`  
**Kế hoạch nền được kế thừa:** `2026-08-21-web-traffic-report-continuous-date.md`

**Bằng chứng triển khai ngày 2026-08-29:** contract/database/isolation tests pass; build production pass; dải `2025-10-25–2026-08-26` trả đủ 306 ngày và toàn miền 520 ngày không bị giới hạn cứng; Route/Airline/Country table và CSV directional hoạt động; QA 375×812 và 1440×900 không tràn ngang, mobile filter ở mức 80dvh; release server `20260829T063928Z-5ec9653dac35` đang phục vụ qua named tunnel tại `https://report.ahtops.xyz/reports/traffic`. Backfill các mùa cũ chưa chạy vì chưa nhận file nguồn chính thức. Truy vấn timeline toàn miền chưa cache đo được khoảng 0,54 giây, vì vậy mục tiêu dưới 150ms chưa được xác nhận cho truy vấn full-range chưa cache; cache-hit và truy vấn dimension đạt nhanh hơn đáng kể.

## 1. Mục tiêu

1. Cho phép người dùng chọn một dải `Ops Date` liên tục xuyên mùa và xuyên năm, không có season filter và không có giới hạn cứng theo số ngày.
2. Không biểu diễn ngày chưa có dữ liệu nguồn như ngày khai thác bằng 0.
3. Tổ chức lại báo cáo theo câu chuyện vận hành: tổng quan → thị trường → hãng → mẫu khai thác.
4. Loại bỏ nội dung kỹ thuật/debug khỏi UI công khai.
5. Thu gọn filter trên desktop và chuyển filter mobile thành bottom sheet/drawer có trạng thái draft/applied rõ ràng.
6. Giữ các quyết định dữ liệu đã chốt: công khai, dùng lịch hiệu lực mới nhất, Pax chỉ cộng số đã báo cáo và luôn kèm coverage, Country lấy từ database + `Unknown`.
7. Đổi câu chuyện `Xu hướng` từ so sánh ARR/DEP sang tương quan **sản lượng chuyến bay ↔ hành khách đã báo cáo**; ARR/DEP/Cả hai là phạm vi người dùng chọn, không phải các series cạnh tranh nhau.
8. Đổi cơ cấu Thị trường và Hãng sang đối chiếu **tỷ trọng chuyến bay ↔ tỷ trọng hành khách đã báo cáo**, luôn đặt Pax coverage cạnh số hành khách.
9. Phần Thị trường công bố cả `Route` (chặng bay) và `Country`/`Unknown`; Route có filter, ranking, bảng và export aggregate. Không dùng bản đồ thị trường.
10. Bổ sung bảng chi tiết aggregate theo Thị trường và Hãng, mỗi bảng có phạm vi `Cả hai / Chuyến bay đến / Chuyến bay đi` độc lập và action tải dữ liệu tương ứng.
11. Host web report và các dịch vụ dữ liệu cần thiết trên server; người dùng truy cập công khai qua tunnel tại `https://report.ahtops.xyz`, không kết nối trực tiếp từ trình duyệt vào database.

## 2. Kết quả kiểm tra hiện trạng ngày 2026-08-27

### 2.1. Kết luận

API hiện tại **không khóa theo mùa** và đã chấp nhận truy vấn xuyên mùa/xuyên năm. Điểm chặn người dùng gặp phải đến từ hai lớp:

- UI đặt `min`/`max` của hai `input[type=date]` bằng `metadata.min_ops_date` và `metadata.max_ops_date` từ API.
- Miền dữ liệu công bố hiện chỉ bắt đầu từ `2025-10-25`; các mùa/ngày cũ hơn không có dữ liệu hiệu lực trong snapshot báo cáo nên bị date picker vô hiệu hóa.

Ngoài ra có lỗi chất lượng dữ liệu nghiêm trọng: một số khoảng ngày không có bản ghi nguồn đang được `generate_series` điền thành `0 chuyến` với `completeness = complete`. Đây là “không có dữ liệu” chứ chưa đủ bằng chứng để kết luận “có khai thác và sản lượng bằng 0”.

### 2.2. Bằng chứng source

- `TrafficReportClient.tsx` gắn trực tiếp `min={bundle.metadata.min_ops_date}` và `max={bundle.metadata.max_ops_date}` cho hai ô ngày.
- Edge Function chỉ nhận `from`/`to`; allowlist không có `season` hoặc `season_id`.
- RPC lấy biên bằng `min(ops_date)`/`max(ops_date)` từ `reporting.public_traffic_effective` và chỉ từ chối ngày nằm ngoài biên này.
- Timeline dùng `generate_series` để tạo date spine và phân trang; không có `max_days` chung.

### 2.3. Bằng chứng database và API read-only

| Hạng mục | Kết quả kiểm tra |
|---|---|
| Miền `reporting.public_traffic_effective` | `2025-10-25` đến `2027-03-28` |
| Tổng số dòng hiệu lực | 60.357 |
| Truy vấn xuyên mùa/năm | `2025-10-25` đến `2026-08-26`: HTTP 200, đủ 306 ngày |
| Truy vấn toàn miền | 520 ngày: HTTP 200, trang đầu 366 ngày, có `timeline_next_cursor` |
| S25 | Metadata `2025-03-30`–`2025-10-25`, nhưng chỉ có 3 dòng nguồn vào cuối mùa |
| W25 | Metadata `2025-10-26`–`2026-03-28`, nhưng dữ liệu quan sát chỉ đến đầu 02/2026 |
| Khoảng không có dòng hiệu lực | `2025-11-01`–`2025-11-30` và `2026-02-01`–`2026-03-27` |
| Cách API đang biểu diễn khoảng 11/2025 | 30 điểm timeline, mỗi điểm `0 chuyến`, `completeness = complete` |

### 2.4. Giới hạn của lần kiểm tra

- Quick Tunnel staging cũ không còn phân giải DNS, nên chưa thể thao tác trực tiếp date picker trên URL cũ.
- Source và API nội bộ trên server đủ để xác nhận contract xuyên năm hoạt động và miền ngày đang bị giới hạn bởi dữ liệu công bố.
- Chưa xác nhận file nguồn đầy đủ của S25/W25 còn tồn tại ở đâu và có được phép công bố hay không.

### 2.5. Gap giữa ứng dụng thật và phương án đã duyệt ngày 2026-08-29

- `TrafficReportClient.tsx` vẫn vẽ timeline với ba series `Tổng/ARR/DEP`; `reported_pax` chỉ xuất hiện trong tooltip, chưa phải một series có trục riêng.
- Filter công khai vẫn có `type` toàn trang và `route`. Route là dimension hợp lệ cần giữ; global `type` chưa phù hợp với mô hình scope riêng theo từng section.
- `BreakdownTable` hiện chủ yếu hiển thị chuyến và tỷ trọng chuyến; chưa đặt tỷ trọng Pax và coverage theo dimension cạnh nhau.
- `breakdowns.route` đã được phát hành nhưng mới thiên về chuyến bay/tỷ trọng chuyến; chưa có tỷ trọng Pax, coverage và bảng chi tiết theo scope riêng.
- Route/Country/Hãng mới có breakdown Top N trong overview bundle; chưa có contract bảng chi tiết phân trang/sắp xếp theo phạm vi A/D/all độc lập.
- Excel/CSV aggregate đã chứa Route nhưng chưa có action tải riêng ngay tại bảng Thị trường theo dimension và scope đang xem.
- Timeline còn yêu cầu người dùng bấm “Tải dãy ngày tiếp theo” khi `timeline_has_more`; chart chính vì vậy có thể chỉ phản ánh trang đầu của dải dài.
- Các nhãn `ARR`, `DEP`, `Traffic composition`, `Data quality`, `Methodology`, `Completeness` và một số câu giải thích kỹ thuật vẫn xuất hiện trên UI người dùng cuối.

## 3. Các quyết định và mặc định triển khai

`D1–D10` và `D16` là quyết định nghiệp vụ/triển khai đã chốt. `D11–D15` là mặc định kỹ thuật/UX khuyến nghị để kế hoạch có thể thực thi; nếu người dùng chọn khác trước khi code thì cập nhật plan/ADR trước migration hoặc API contract change.

| ID | Quyết định |
|---|---|
| D1 | Trang báo cáo công khai, aggregate-only; không lộ flight-leg/raw operational fields. |
| D2 | Không có season filter. Mọi truy vấn dùng `from`/`to` inclusive trên trục `Ops Date` liên tục. |
| D3 | Mặc định từ đầu năm đến `Ops Date` hoàn tất gần nhất, clamp trong miền dữ liệu công bố. |
| D4 | Không áp dụng giới hạn cứng cho độ dài khoảng ngày. Dùng aggregate, pagination, zoom và resource budget theo query type. |
| D5 | Lịch hiệu lực chọn bản mới nhất theo business occurrence; bản deleted/tombstone không được hồi sinh. |
| D6 | Pax chỉ cộng số đã báo cáo; mọi KPI Pax phải kèm coverage numerator/denominator và phần trăm. |
| D7 | Route lấy từ dữ liệu lịch hiệu lực; Country lấy từ database, tuyến chưa mapping Country thuộc `Unknown`. |
| D8 | Ngày không có dữ liệu nguồn được phân biệt với ngày đã có coverage nhưng sản lượng bằng 0. |
| D9 | URL giữ trạng thái global `from`, `to`, `airline`, `route`, `country`, `comp`, `tz` và trạng thái cục bộ `trend_type`, `market_dimension`, `market_type`, `airline_type`; không thêm season param. |
| D10 | Không hiển thị request hash, raw config, raw RPC/HTTP error, suppression jargon hoặc nội dung debug cho người dùng cuối. |
| D11 | Global filter không còn điều khiển chiều bay. KPI luôn trình bày tổng + chuyến bay đến + chuyến bay đi; `Xu hướng`, bảng Thị trường và bảng Hãng có scope riêng. |
| D12 | `Cả hai` luôn là một tập aggregate A+D. Không vẽ A và D thành hai series để diễn giải tương quan chuyến bay/Pax hoặc tỷ trọng thị trường/hãng. |
| D13 | Route là dimension Thị trường công khai, nhưng chỉ ở mức aggregate và áp dụng cùng suppression/privacy rule như Country/Hãng. |
| D14 | Bản đồ thị trường bị loại bỏ. Khối Thị trường có selector `Chặng bay / Quốc gia`, ranking và bảng aggregate theo Route hoặc Country/`Unknown`, có phân trang và tải dữ liệu. |
| D15 | Download “chi tiết” vẫn là dữ liệu aggregate đã suppression, không phải flight-leg/raw schedule. |
| D16 | Web report được host trên server và public qua Cloudflare Tunnel connection `report.ahtops.xyz`; database/API nội bộ không mở truy cập trực tiếp cho trình duyệt hoặc Internet. |

Mặc định đang dùng trong kế hoạch:

- bỏ global `Loại chuyến`, dùng scope cục bộ tại từng khối;
- tải bảng Thị trường bằng CSV aggregate, giữ Excel toàn báo cáo là action riêng;
- link cũ có `type` được compatibility parser chuyển đổi trong một release: dùng `type` để seed các scope chưa có, sau đó canonicalize sang URL mới; `route` tiếp tục là param hợp lệ.

## 4. Phạm vi và ngoài phạm vi

### Trong phạm vi

- Audit và backfill/phát hành dữ liệu lịch sử đã được phê duyệt.
- Data coverage contract theo ngày/khoảng ngày.
- RPC/API cho dải ngày xuyên mùa/năm, adaptive granularity, pagination và zoom.
- Date-range picker dễ nhảy tháng/năm.
- Filter desktop/mobile và URL synchronization.
- Information architecture, KPI, chart, table, empty/loading/error state.
- Server deployment, reverse proxy, tunnel route `report.ahtops.xyz`, service persistence, health check và rollback.
- Test, staging/production acceptance và performance profile.

### Ngoài phạm vi

- Không tạo dữ liệu giả để lấp khoảng trống.
- Không suy diễn sector, seats, capacity, stand pressure hoặc market trend khi contract chưa có dimension-by-time.
- Không thêm hard-coded capacity/benchmark.
- Không công khai raw flights hoặc dữ liệu dưới ngưỡng privacy.
- Không ghi tunnel token, database credential hoặc secret triển khai vào source, tài liệu hay client bundle.

## 5. Kiến trúc thông tin đề xuất

```text
Ngữ cảnh báo cáo + filter đã áp dụng
└─ 1. Sản lượng Tổng quan
   ├─ KPI chính và coverage
   ├─ Insight vận hành xác định được từ dữ liệu
   └─ Xu hướng Chuyến bay ↔ Hành khách đã báo cáo theo Ops Date
└─ 2. Sản lượng theo thị trường
   ├─ Selector Chặng bay / Quốc gia
   ├─ Route hoặc Country/Unknown ranking: tỷ trọng Chuyến bay ↔ Hành khách đã báo cáo
   └─ Bảng dimension đang chọn, scope A/D/all riêng, phân trang và tải dữ liệu
└─ 3. Sản lượng theo hãng
   ├─ Airline ranking: tỷ trọng Chuyến bay ↔ Hành khách đã báo cáo
   └─ Bảng hãng đầy đủ, scope A/D/all riêng, phân trang và tải dữ liệu
└─ 4. Thông tin khai thác
   ├─ Peak day, peak hour
   ├─ 24 khung giờ tách Chuyến bay đến / Chuyến bay đi
   ├─ Day-of-week
   └─ Aircraft group
└─ 5. Phạm vi và chất lượng dữ liệu
   ├─ Thời điểm cập nhật
   ├─ Coverage theo ngày/khoảng ngày
   ├─ Pax coverage
   └─ Methodology/ghi chú có thể thu gọn
```

Trang phải bắt đầu bằng filter/KPI, không dùng hero lớn hoặc cấu trúc landing page trang trí.

## 6. Thiết kế từng section

### 6.1. Header và filter context

- Tiêu đề ngắn: “Báo cáo sản lượng khai thác”.
- Hiển thị dải ngày đã áp dụng, số filter dimension đang active và thời điểm dữ liệu cập nhật. Chiều bay được chọn tại từng khối phân tích, không đặt trong global filter.
- Hiển thị miền dữ liệu hiện có bằng ngôn ngữ người dùng: “Dữ liệu có thể chọn: 25/10/2025–28/03/2027”.
- Nếu range chứa khoảng thiếu dữ liệu, hiển thị cảnh báo nghiệp vụ ngay dưới filter, không chỉ trong methodology.

### 6.2. Sản lượng Tổng quan

KPI được phép khi dữ liệu hỗ trợ:

- Tổng chuyến, Chuyến bay đến, Chuyến bay đi.
- Pax đã báo cáo + coverage.
- Trung bình chuyến/ngày có coverage.
- Ngày cao điểm và số chuyến.
- Khung giờ cao điểm và số chuyến.
- So sánh với kỳ trước/cùng kỳ năm trước chỉ khi comparison status là `complete`.

Chart/table:

- Combo chart hai chỉ số theo thời gian: `Sản lượng chuyến bay` ở trục Y trái và `Hành khách đã báo cáo` ở trục Y phải; có zoom và granularity `day/week/month`.
- Scope của chart: `Cả hai`, `Chuyến bay đến`, `Chuyến bay đi`. Khi chọn `Cả hai`, mỗi ngày chỉ có một giá trị chuyến A+D và một giá trị Pax A+D.
- Không dùng ARR-vs-DEP làm insight chính. Chỉ mô tả đỉnh/đáy và biến động quan sát được; không gọi là tương quan thống kê nếu chưa có phương pháp được phê duyệt.
- Tooltip/bảng thay thế phải có Ops Date, scope, chuyến bay, Pax đã báo cáo, `reported_legs/due_legs`, coverage % và trạng thái dữ liệu.
- Hai series dùng màu + kiểu nét/marker khác nhau; nhãn trục và đơn vị luôn hiện rõ để tránh hiểu sai vì dual-axis.
- Có bảng dữ liệu thay thế cho accessibility/export.
- Ngày `missing/unpublished` phải tạo khoảng đứt hoặc vùng đánh dấu “Chưa có dữ liệu”, không nối thành đường 0.

### 6.3. Sản lượng theo thị trường

- Có selector dimension `Chặng bay / Quốc gia`; Route lấy từ lịch hiệu lực, Country lấy từ database và tuyến chưa mapping Country thuộc `Unknown`. Không có bản đồ.
- Horizontal grouped/ranked bar Top 10 + `Khác` cho dimension đang chọn, xếp giảm dần theo scope; hai đại lượng là tỷ trọng chuyến bay và tỷ trọng hành khách đã báo cáo.
- Bảng chi tiết không bị giới hạn Top N: Route hoặc Country/Thị trường, chuyến bay, tỷ trọng chuyến bay, Pax đã báo cáo, tỷ trọng Pax đã báo cáo, `reported_legs/due_legs` và coverage %.
- Bảng có selector riêng `Cả hai / Chuyến bay đến / Chuyến bay đi`; đổi selector chỉ reload bảng/biểu đồ Thị trường, không thay filter hoặc bundle của phần khác.
- Action “Tải dữ liệu chi tiết” dùng đúng dimension, scope, sort và filter của bảng, tải aggregate đã suppression. Ưu tiên CSV từ API cho bảng lớn; full-workbook Excel vẫn là action riêng toàn báo cáo.
- “Thị trường thấp nhất” chỉ hiển thị nếu tập dữ liệu đầy đủ, không bị Top N/suppression làm sai nghĩa.
- Trend theo Route/Country chỉ được thêm sau khi API có dimension-by-time được kiểm thử; phase đầu không giả lập từ breakdown tổng kỳ.

### 6.4. Sản lượng theo hãng

- Horizontal grouped/ranked bar Top 10 airline + `Khác`; hai đại lượng là tỷ trọng chuyến bay và tỷ trọng hành khách đã báo cáo.
- Bảng chi tiết: hãng, chuyến bay, tỷ trọng chuyến bay, Pax đã báo cáo, tỷ trọng Pax đã báo cáo, `reported_legs/due_legs` và coverage %.
- Bảng có selector riêng `Cả hai / Chuyến bay đến / Chuyến bay đi`; có tải aggregate theo đúng scope/sort/filter của bảng.
- Không gọi nhóm nhỏ bị suppression là “hãng thấp nhất”.
- Không thêm trend theo hãng khi nguồn chỉ trả breakdown tổng kỳ.

### 6.5. Thông tin khai thác

- KPI peak day/peak hour.
- Heatmap hoặc grouped bar 24 giờ tách rõ `Chuyến bay đến` và `Chuyến bay đi`, với số liệu exact trong tooltip/bảng.
- Nếu khoảng chọn gồm nhiều tháng, bổ sung bảng “Giờ cao điểm theo tháng” gồm tháng, giờ cao điểm đến + số chuyến và giờ cao điểm đi + số chuyến; không suy ra điểm nghẽn/công suất.
- Day-of-week chart.
- Aircraft group share/ranking.
- Không dùng `referenceCapacity = 14`; không kết luận điểm nghẽn khi chưa có nguồn capacity được phê duyệt.

### 6.6. Chất lượng dữ liệu

- Hiển thị ngắn gọn: data as of, ngày có coverage/ngày được chọn, ngày thiếu dữ liệu, Pax reported/due.
- Methodology chi tiết đặt trong disclosure cuối trang.
- UI nói “Chưa có dữ liệu cho 55 ngày” thay cho raw field như `timeline_has_more`, `request_hash` hoặc tên RPC.

## 7. Thiết kế lại filter

### 7.1. State contract

- `appliedFilter`: range/filter của bundle thành công và URL hiện hành.
- `draftFilter`: giá trị đang chỉnh trong popover/sheet.
- Mở filter: copy `appliedFilter` sang `draftFilter`.
- Close/Escape/Back/scrim: hủy draft, không đổi URL và báo cáo.
- Apply: validate → request → thành công mới cập nhật `appliedFilter`, URL và bundle.
- Apply lỗi: giữ bundle cũ, giữ sheet mở, chỉ lỗi cạnh field hoặc vùng action.
- Reset: đưa draft về YTD + không dimension filter; chưa áp dụng cho đến khi bấm “Áp dụng”. Reset global filter không ghi đè `trend_type`, `market_type`, `airline_type` nếu người dùng không chọn “Đặt lại toàn bộ báo cáo”.

### 7.2. Date-range picker

- Không dùng season selector.
- Cho phép nhảy nhanh tháng và năm; desktop hiển thị hai tháng, mobile một tháng.
- Có ô nhập ngày trực tiếp với label rõ, định dạng hiển thị theo locale Việt Nam nhưng URL giữ ISO `YYYY-MM-DD`.
- Chỉ disable ngày ngoài global publication bounds.
- Ngày thiếu coverage bên trong bounds vẫn chọn được và có indicator/legend riêng.
- Preset: 7 ngày, 30 ngày, YTD; bổ sung “Toàn bộ dữ liệu” nếu payload/performance contract đạt yêu cầu.
- Nút “Hôm nay” không vượt `latest_completed_ops_date`; dữ liệu lịch tương lai vẫn có thể chọn thủ công vì nguồn là lịch hiệu lực.

### 7.3. Desktop

- Sticky filter summary tối đa hai hàng, ưu tiên range và nút “Bộ lọc nâng cao”.
- Airline/route/country/comparison nằm trong popover/dialog dùng primitive accessibility hiện có; không hiển thị global type.
- Không để dropdown absolute thoát khỏi stacking context hoặc che chart.

### 7.4. Mobile

- Trạng thái đóng: trigger “Bộ lọc” cao không quá 72px, hiển thị range và số filter active.
- Trạng thái mở: bottom sheet/dialog tối đa khoảng 80dvh, `h-dvh`, header/body/footer riêng.
- Header có title và nút đóng; body là vùng cuộn duy nhất; footer cố định có “Đặt lại” và “Áp dụng”.
- Touch target tối thiểu 44×44px; có safe-area bottom padding.
- Có focus trap, focus return, Escape và browser Back; dùng accessible primitive, không tự viết keyboard/focus behavior.
- Không dùng arbitrary z-index; dùng scale của project.
- Không thêm animation nếu chưa được yêu cầu; nếu primitive có transition thì chỉ transform/opacity, không quá 200ms và tôn trọng reduced motion.

## 8. Data coverage và continuous-date contract

### 8.1. Vấn đề cần sửa trước UI

Hiện `generate_series + left join` không biết ngày nào đã được chứng nhận có nguồn. Vì vậy `không có row` bị quy thành `0 chuyến`. Cần có coverage ledger độc lập với flight count.

### 8.2. Mô hình đề xuất

Tạo coverage source trong schema `reporting`, ví dụ `reporting.public_traffic_coverage`, không cấp quyền direct cho public roles. Mỗi interval/day cần có:

- `from_date`, `to_date`;
- `status`: `complete`, `partial`, `missing`, `excluded`;
- `season_id`/`season_code` nội bộ;
- `source_batch_id` hoặc watermark;
- `reason_code`;
- `certified_at`, `certified_by` nếu quy trình có bước phê duyệt.

Quy tắc:

- `complete + 0 row` ⇒ sản lượng 0 hợp lệ.
- `partial/missing + 0 row` ⇒ giá trị null, không phải 0.
- `partial/missing + có row` ⇒ có thể hiển thị giá trị quan sát nhưng phải gắn trạng thái chưa đầy đủ; KPI tổng kỳ cũng chuyển `partial`.
- Global `min_ops_date/max_ops_date` lấy từ coverage đã công bố, không lấy từ season metadata đơn thuần và không phụ thuộc filter dimension.
- Không mở rộng min/max đến mùa cũ trước khi dữ liệu nguồn được import, kiểm tra và công bố.

### 8.3. Backfill lịch sử

1. Inventory mọi season: effective range, observed source range, distinct Ops Date, missing runs, provenance mode, import batch và duplicate quarantine.
2. Xác định file nguồn chính thức cho S25 và W25.
3. Chạy preview/import bằng workflow idempotent hiện có; không sửa trực tiếp snapshot aggregate.
4. Đối chiếu tổng chuyến theo season/ngày với file mẫu hoặc báo cáo đã được duyệt.
5. Chỉ sau khi reconciliation pass mới refresh snapshot và mở rộng coverage bounds.
6. Nếu không có file nguồn, giữ ngày đó ở trạng thái `missing/unpublished`; không tạo số liệu thay thế.

## 9. API/RPC contract

### 9.1. Metadata

Bổ sung hoặc làm rõ:

- `min_ops_date`, `max_ops_date`: global publication bounds.
- `latest_completed_ops_date`: mốc mặc định YTD/Pax due.
- `selected_day_count`.
- `covered_day_count`, `partial_day_count`, `missing_day_count`.
- `coverage_intervals` đã compact để UI đánh dấu gap.
- `timeline_granularity`, `timeline_has_more`, cursor/window metadata.
- `available_dimensions`/`contract_version` đủ để client biết Route, Country và Airline được công bố.

### 9.2. Timeline

- Toàn selected range luôn được mô tả trong metadata.
- RPC sinh bucket theo window/page được yêu cầu, không sinh toàn bộ daily spine rồi cắt ở API.
- Granularity mặc định theo budget: daily cho range ngắn, weekly/monthly cho range dài; người dùng zoom để drill về daily.
- Pagination áp dụng cho data table/export hoặc daily detail; chart tổng quan phải thể hiện toàn range bằng aggregate, không hiển thị trang đầu như toàn bộ series.
- Bucket tuần/tháng chứa coverage count và completeness; bucket không đầy đủ không được tính delta như complete.
- Mỗi timeline point/bucket của endpoint scoped phải trả `flights`, `reported_pax`, `reported_legs`, `due_legs`, `pax_coverage_pct`, `pax_status` cho đúng `type=all|A|D`.
- `type=all` được tính ở database từ cùng tập A+D; client không cộng hai series đã suppression và không tự ước tính Pax.

### 9.3. Breakdown và bảng chi tiết

- Overview bundle mặc định trả ranking Route/Country/Airline cho `type=all`.
- Thêm focused aggregate endpoint/RPC cho `dimension=route|country|airline`, `type=all|A|D`, `sort=flights|reported_pax|share`, cursor/page size và filter global.
- Scope bảng/biểu đồ được đổi bằng request riêng có abort/race guard; không reload toàn trang và không để response cũ ghi đè scope mới.
- Ranking Top N và privacy suppression được tính lại ở server theo scope. Client không suy ra hàng A/D từ hàng total vì có thể làm lộ cell nhỏ qua phép trừ.
- Bảng chi tiết trả hàng publishable đã phân trang, `Khác`/suppression metadata và tổng mẫu số dùng tính share; không dùng Top N response để kết luận thị trường/hãng thấp nhất.
- Export bảng Thị trường/Hãng gọi cùng query contract và cùng suppression với bảng; không tạo một đường truy vấn raw riêng.

### 9.4. Validation và cache

- Chỉ validate thứ tự ngày, global bounds, dimension/type allowlist, cardinality, cursor, sort và budget theo query type.
- Không thêm `max_days` chung.
- Same-origin GET, canonical query và cache key bao gồm toàn bộ normalized filter/granularity/window.
- API mapping lỗi kỹ thuật sang error code ổn định; UI chỉ hiển thị thông điệp và recovery action thân thiện.

### 9.5. Privacy

- Giữ suppression/grouping dưới 3 legs nhất quán ở KPI, chart, tooltip, table và export.
- Không để drilldown hoặc coverage metadata suy ra raw leg.
- Export chỉ aggregate đã kiểm duyệt.
- Route được công bố ở mức aggregate trong response, filter options và CSV/Excel; không công bố raw leg, flight number hoặc schedule exact qua Route và vẫn áp dụng suppression nhất quán.

### 9.6. Server hosting và tunnel

Luồng truy cập production:

```text
Người dùng
  → https://report.ahtops.xyz
  → Cloudflare Tunnel connection
  → reverse proxy trên server
  ├─ web report `/reports/traffic`
  └─ same-origin API `/api/report/*`
       → reporting service/RPC
       → database nội bộ
```

- Web report, API/reporting service và database được vận hành trên server; browser chỉ gọi public web/API qua cùng hostname.
- Tunnel route cố định `report.ahtops.xyz` tới reverse proxy nội bộ. Origin chỉ bind loopback/private interface phù hợp và không cần mở trực tiếp database hoặc cổng ứng dụng ra Internet.
- Reverse proxy chịu trách nhiệm route SPA/direct reload, request size/timeouts, compression và security headers. `/api/report/*` chỉ chuyển tới public aggregate API, không proxy tới database port.
- Tunnel agent, web service và API service chạy dưới service manager, tự khởi động lại sau reboot và có health check riêng.
- Cache chỉ áp dụng cho response aggregate công khai với cache key bao gồm toàn bộ canonical filter/range/scope/dimension. Không cache error, response partial không ổn định hoặc nội dung có secret.
- Secret tunnel/database nằm trong secret store hoặc environment file có quyền hạn chế trên server; không đưa vào repository, image public, log hay response client.
- Giữ một artifact/build trước đó và cấu hình reverse proxy/tunnel có version backup để rollback mà không đổi public hostname.

## 10. Các phần cần loại bỏ hoặc ẩn

- Hero lớn, tagline marketing và duplicate “Tổng chuyến trong kỳ”.
- “Executive summary” đứng trước filter/KPI; thay bằng insight vận hành sau KPI.
- English eyebrow không phục vụ nghiệp vụ.
- Request hash, contract version, RPC/function name, raw HTTP status/raw cursor.
- “aggregate only”, suppression threshold hoặc database jargon trên main UI.
- Hard-coded `referenceCapacity = 14` và mọi kết luận bottleneck dựa trên giá trị này.
- Percentage delta khi comparison là `partial`, `unavailable` hoặc `none`.
- Nút “Tải dãy ngày tiếp theo” như cách hoàn thiện chart chính; chart phải có aggregate toàn range.
- Global filter `Loại chuyến` và bản đồ thị trường. Giữ route multi-select, Route breakdown, bảng và export aggregate.
- ARR/DEP như nhãn chính ở UI; thay bằng “Chuyến bay đến/Chuyến bay đi”. Tên field nội bộ/API có thể giữ để tương thích nếu không lộ ra UI.
- `Traffic composition`, `Data quality`, `Methodology`, `Completeness` và các thuật ngữ kỹ thuật tương tự; thay bằng nhãn tiếng Việt phục vụ người dùng.

## 11. Kế hoạch thực hiện theo giai đoạn

### Phase 0 — Data audit và chốt nguồn lịch sử

**Mục tiêu:** biết chính xác mùa/ngày nào có dữ liệu đầy đủ trước khi đổi UI.

- Lập audit report theo season/day và missing interval.
- Xác minh file nguồn S25/W25, checksum, thời điểm import và owner phê duyệt.
- Định nghĩa coverage status và quy tắc zero-versus-missing.
- Reconcile aggregate theo mùa/ngày.

**Gate:** Không sang Phase 1 nếu chưa chốt được coverage semantics và phạm vi lịch sử được phép công bố.

### Phase 1 — Reporting snapshot, coverage và RPC

- Bổ sung coverage model/view.
- Giữ season identity/provenance nội bộ trong effective snapshot để audit được nguồn.
- Sửa KPI/timeline/breakdown completeness và bổ sung Pax coverage theo `type=all|A|D`.
- Thêm adaptive granularity/window/pagination contract.
- Giữ Route trong output public aggregate của overview wrapper, đồng thời giữ provenance nội bộ để audit và map Country.
- Thêm RPC bảng aggregate phân trang cho `route|country|airline`, có scope, sort, denominator/share, coverage và privacy suppression theo từng scope.
- Thêm database tests cho cross-season, cross-year, missing gap, true zero, partial comparison và privacy.

**Gate:** Direct SQL và RPC trả cùng bounds/count/completeness; range toàn miền không bị từ chối do độ dài.

### Phase 2 — Edge/API contract

- Truyền coverage metadata và granularity qua Edge Function.
- Giữ route trong allowlist/canonical query/CSV public và bổ sung source tests cho filter, ranking, table, export cùng privacy suppression.
- Thêm focused timeline/breakdown/table/export request cho scope cục bộ; giữ một overview request mặc định khi load trang.
- Chuẩn hóa client error code/message.
- Thêm cache/canonical URL tests.
- Profile payload/latency theo range ngắn, một năm, nhiều năm và full domain.

**Gate:** API cross-year pass; chart payload luôn đại diện toàn range hoặc tuyên bố completeness/pagination chính xác.

### Phase 3 — Filter UX và page IA

- Tách `draftFilter`/`appliedFilter`.
- Thay filter mobile bằng accessible bottom sheet.
- Thu gọn desktop filter và bổ sung date-range picker có month/year navigation.
- Bỏ global `type`; giữ Route filter và thêm scope control riêng cho Xu hướng, bảng Thị trường và bảng Hãng, có URL sync.
- Sắp xếp lại 4 section vận hành.
- Đổi Xu hướng thành combo chart Chuyến bay ↔ Hành khách đã báo cáo với dual-axis/tooltip/coverage rõ ràng.
- Đổi Route/Country/Airline ranking sang tỷ trọng Chuyến bay ↔ Pax; thêm bảng chi tiết và action tải dữ liệu aggregate.
- Tổ chức Route/Country trong cùng section Thị trường, bỏ bản đồ; thêm bảng giờ cao điểm theo tháng khi selected range đi qua nhiều tháng.
- Xóa technical/debug text và hard-coded capacity.
- Bổ sung loading/empty/error/partial states cho từng card/chart/table.

**Gate:** keyboard/mobile/back/reload/share acceptance pass; không có filter che nội dung.

### Phase 4 — QA, server deployment và nghiệm thu

- Build/lint/unit/source-contract/database integration.
- Deploy artifact lên server, cấu hình reverse proxy và Cloudflare Tunnel route `report.ahtops.xyz`.
- Cấu hình service persistence, health check, log rotation, secret permissions và rollback artifact.
- Kiểm thử 375px, tablet, desktop và landscape.
- So sánh API với direct SQL và file báo cáo mẫu trên các range đã chọn.
- Performance profile, cache behavior, privacy probe, direct-origin exposure check, reboot recovery và rollback rehearsal.

**Gate:** Product/Data owner duyệt dữ liệu; UX acceptance pass; `https://report.ahtops.xyz` đạt TLS/routing/health/security/reboot/rollback acceptance.

### Trình tự vertical slice khuyến nghị

1. **Coverage trước UI:** coverage ledger + missing/zero tests + full-range timeline contract.
2. **Trend end-to-end:** timeline scoped A/D/all + Pax coverage → Edge → contract → combo chart + bảng thay thế.
3. **Thị trường end-to-end:** Route + Country/Unknown aggregate table RPC + dimension/page/sort/scope → API → ranking/table/download; giữ Route và loại bản đồ.
4. **Hãng end-to-end:** Airline aggregate table RPC + page/sort/scope → API → ranking/table/download.
5. **Khai thác:** peak-hour đến/đi, monthly peak table, DOW và aircraft group với empty/suppressed states.
6. **Filter shell:** continuous date, draft/applied, mobile sheet, URL migration từ `type` cũ sang local scope params; giữ `route` trong canonical URL.
7. **Acceptance/deploy:** reconciliation, privacy/export, performance, browser/device, deploy server, bind `report.ahtops.xyz`, cache/tunnel, reboot recovery và rollback.

Mỗi slice phải có contract/database/source test trước UI. Không gom toàn bộ SQL, Edge và UI thành một big-bang release.

### Approval gates trước khi implement

- **Gate A — Schema/API:** Phase 1–2 thay đổi reporting schema, RPC và public contract. Trước khi tạo migration hoặc đổi Edge allowlist phải có phê duyệt rõ cho contract mới và policy tương thích link cũ.
- **Gate B — Import lịch sử:** Không chạy import/backfill khi chưa nhận file chính thức, checksum, phạm vi mùa và xác nhận được phép công bố.
- **Gate C — Server/tunnel:** Kiến trúc và hostname `report.ahtops.xyz` đã chốt; trước khi deploy cần xác nhận server access, quyền quản lý tunnel/DNS, secret path, service account và maintenance/rollback window. Không ghi hoặc yêu cầu người dùng dán secret vào plan.
- **Gate D — Privacy/export:** Không bật focused table/export trước khi directional suppression, complementary suppression và negative subtraction tests pass.

## 12. File/module dự kiến tác động khi implement

### Frontend

- `app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportMultiSelect.tsx`
- `app/src/app/(public-report)/reports/traffic/TrafficReportAdvancedCharts.tsx`
- `app/src/app/(public-report)/report.css`
- Component mới/được tách cho `TrafficReportFilterSheet`, `TrafficReportDateRange`, `TrafficReportTrend`, `TrafficReportDimensionTable`, `TrafficReportScopeSelector` và coverage notice nếu project chưa có primitive phù hợp.
- `TrafficReportMultiSelect` tiếp tục hỗ trợ Airline và Route; Country được giữ hoặc tổng quát hóa theo contract filter đã công bố.

### Contract/export

- `app/src/lib/trafficReportContract.ts`
- `app/src/lib/trafficReportContract.test.ts`
- `app/src/lib/trafficReportExcelExport.ts`
- Helper mới cho canonical URL/local scope migration và table-specific aggregate export nếu không phù hợp đặt trong contract/export hiện có.

### API/database

- `app/supabase/functions/traffic-report/index.ts`
- Migration mới trong `app/supabase/migrations/` cho coverage + scoped timeline/dimension table; không sửa hai migration đã chạy.
- `app/supabase/tests/public_traffic_report_v1_pglite.mjs`
- `app/scripts/traffic-report-edge-contract.test.mjs`
- Source-contract test xác nhận Route vẫn là dimension public aggregate trong UI/API/export, bản đồ/global type bị loại và không lộ raw fields.

### Deployment/runbook

- `docs/runbooks/public-traffic-report-deploy.md`
- Cấu hình reverse proxy/site cho `report.ahtops.xyz` và service definitions cho web/API/tunnel; tên file cụ thể chốt theo stack hiện có trên server.
- Artifact audit/acceptance mới; không ghi secret hoặc tunnel token.

## 13. Acceptance criteria

### Cross-season/cross-year

- [ ] Chọn được `2025-10-25–2026-08-26` khi range nằm trong global bounds.
- [ ] Chọn được range đi qua ranh giới W25/S26 và ranh giới năm mà không có season param.
- [ ] Range dài hơn 366 ngày được API chấp nhận; chart chính dùng aggregate toàn range, daily detail dùng pagination/zoom.
- [ ] URL reload, bookmark, copy link, Back/Forward giữ đúng applied filter.
- [ ] Date picker min/max khớp global publication bounds, không khớp “mùa đang chọn”.

### Data correctness

- [ ] S25/W25 có audit kết luận rõ `complete/partial/missing` theo ngày.
- [ ] Ngày không có nguồn không hiển thị `0` với `complete`.
- [ ] True zero chỉ được trả khi ngày nằm trong certified coverage.
- [ ] `min_ops_date/max_ops_date` khớp direct SQL trên coverage đã công bố.
- [ ] KPI range chứa gap có status/coverage phù hợp; không trình bày như complete.
- [ ] Comparison partial/unavailable không hiển thị percentage delta.
- [ ] Pax chỉ cộng reported Pax và luôn kèm coverage numerator/denominator.
- [ ] Route lấy từ dữ liệu lịch hiệu lực; Country dùng database và route chưa mapping Country vào `Unknown`; cả Route và Country xuất hiện đúng trong public aggregate payload/UI/export.
- [ ] Latest-wins/deleted/quarantine rules giữ nguyên và có regression test.

### Data story và bảng chi tiết

- [ ] Xu hướng có đúng hai series cho scope đang chọn: `Chuyến bay` và `Hành khách đã báo cáo`; không còn insight ARR-vs-DEP.
- [ ] `Cả hai` bằng direct SQL A+D cho chuyến, Pax, reported legs và due legs; không render A/D thành hai series riêng.
- [ ] Dual-axis có nhãn/đơn vị; tooltip và bảng thay thế có Ops Date, scope, chuyến, Pax, coverage và trạng thái.
- [ ] Route/Country/Airline chart đối chiếu tỷ trọng chuyến bay với tỷ trọng Pax đã báo cáo, không đối chiếu chuyến đến với chuyến đi.
- [ ] Bảng Thị trường và Hãng có state A/D/all độc lập; thay đổi một bảng không reload/đổi state của bảng kia hoặc Xu hướng.
- [ ] Bảng Thị trường có selector `Chặng bay / Quốc gia`, pagination/sort, giữ Route và Country/`Unknown`, không có bản đồ.
- [ ] Download tại bảng Thị trường dùng cùng dimension/scope/filter/sort và cùng suppression với dữ liệu đang xem; file có thể chứa Route khi dimension đang chọn là Chặng bay nhưng không chứa flight number, leg ID hoặc schedule exact.
- [ ] Nếu hiển thị bảng giờ cao điểm theo tháng, mỗi tháng có kết quả riêng cho Chuyến bay đến và Chuyến bay đi; không gắn nhãn quá tải khi chưa có capacity.

### UX/UI

- [ ] Ở 375×812, filter đóng không cao quá 72px và không che KPI/chart.
- [ ] Mobile sheet không vượt khoảng 80dvh, chỉ body cuộn, footer action luôn nhìn thấy và có safe-area padding.
- [ ] Close/Escape/Back/scrim hủy draft; Apply thành công mới đổi URL/report.
- [ ] Reset/Apply/Close rõ ràng; active filters nhìn thấy khi sheet đóng.
- [ ] URL chứa `route`, `market_dimension`, `trend_type`, `market_type`, `airline_type` khi có giá trị khác mặc định; reload/Back/Forward khôi phục đúng filter và scope cục bộ.
- [ ] Bookmark cũ có `type` được migration theo policy đã test; `route` được bảo toàn như filter hợp lệ, không làm crash hoặc âm thầm hiển thị số liệu sai.
- [ ] Touch target tối thiểu 44×44px, focus order hợp lý, focus return đúng trigger.
- [ ] Chart có title, đơn vị, legend, tooltip/tap và data-table/export alternative.
- [ ] Loading/empty/error/partial/missing state được định nghĩa theo từng section.
- [ ] Không có hero marketing, raw debug/config/script hoặc technical error trên UI.
- [ ] Không có hard-coded capacity hoặc claim vượt data contract.

### Performance/security

- [ ] Một initial overview request trả KPI + metadata + aggregate timeline phù hợp; không có metadata round-trip riêng.
- [ ] Resource budget được đo theo query type; không từ chối chỉ vì range dài.
- [ ] Aggregate/privacy suppression nhất quán ở UI/API/export.
- [ ] Ranking/suppression được tính lại ở server cho từng scope A/D/all; không suy ra directional cell bằng subtraction ở client.
- [ ] Public roles không execute trực tiếp reporting RPC hoặc đọc raw tables.
- [ ] Cache key không trộn filter/range/granularity; stale response không ghi đè request mới.

### Server/tunnel

- [ ] `https://report.ahtops.xyz` phân giải đúng tunnel connection, có TLS hợp lệ và không có mixed content.
- [ ] Mở trực tiếp `/reports/traffic`, reload sâu và URL có filter đều trả đúng web report, không lỗi route của SPA/reverse proxy.
- [ ] Browser chỉ gọi same-origin `/api/report/*`; không lộ database hostname/port/credential hoặc gọi trực tiếp reporting RPC.
- [ ] Cổng database và origin app không được public ngoài chủ đích; host header lạ không được phục vụ report.
- [ ] Web/API/tunnel services tự khởi động sau reboot, health check pass và log không chứa secret hoặc dữ liệu raw bị cấm.
- [ ] Cache header và cache key được xác nhận theo canonical filter/range/scope/dimension; không trộn dữ liệu giữa hai URL.
- [ ] Rollback về artifact trước đó hoàn tất mà không đổi hostname `report.ahtops.xyz` và có biên bản kiểm tra sau rollback.

## 14. Rủi ro và rollback

| Rủi ro | Giảm thiểu | Rollback |
|---|---|---|
| Backfill S25/W25 sai hoặc trùng | Preview, checksum, idempotency, duplicate quarantine, direct reconciliation | Giữ snapshot/coverage version cũ; không publish batch mới |
| Khoảng thiếu dữ liệu bị hiểu là zero | Coverage ledger và test missing-vs-zero | Tắt publication interval lỗi, trả `missing` |
| Full-range query quá nặng | Adaptive granularity, windowed timeline, pagination, statement timeout theo query type | Hạ granularity mặc định; không rút ngắn selected range |
| Mobile sheet lỗi focus/back | Accessible primitive + automated keyboard tests + device acceptance | Trở lại compact inline trigger/form trước đó |
| Cache trả nhầm filter | Canonical cache key + contract tests | Bypass cache `/api/report/*` trong thời gian sửa |
| Tunnel/DNS/TLS sai làm report không truy cập được | Kiểm tra route/hostname/certificate trước cutover, health monitoring và service auto-restart | Giữ cấu hình tunnel/site trước đó; rollback route về origin đã xác nhận |
| Origin hoặc database bị mở trực tiếp | Bind private/loopback, firewall allowlist, scan cổng và kiểm tra host header | Đóng rule/cổng public; chỉ phục vụ lại sau security acceptance |
| UI mới đưa claim chưa được nguồn hỗ trợ | Allowlist metric/insight theo contract | Ẩn metric/claim, không dùng fallback giả |
| Scope bảng và global filter mâu thuẫn | Bỏ global `type`; scope nằm tại từng khối và có URL param riêng | Tạm khóa scope về `all`, giữ overview đã xác minh |
| Client suy ra A/D làm lộ cell nhỏ | Server tính/rank/suppress theo từng scope; negative subtraction tests | Không phát hành directional table cho đến khi privacy test pass |
| Bookmark cũ chứa `type` | Canonical migration có test và thông báo scope đã được điều chỉnh; giữ nguyên `route` | Giữ compatibility parser một release; tạm khóa scope về `all` nếu migration lỗi |
| Export bảng khác dữ liệu đang xem | Dùng chung normalized request/scope/sort và response hash | Tắt action tải riêng, giữ full aggregate export hiện tại |

## 15. Các điểm đã chốt trước Phase 0/1

| Hạng mục | Quyết định đã chốt ngày 2026-08-27 | Tác động thực hiện |
|---|---|---|
| Phạm vi lịch sử | Công bố **tất cả mùa có dữ liệu hợp lệ**, không giới hạn từ S25 | Audit theo toàn bộ season hiện có; backfill theo từng batch, bắt buộc reconciliation và publication gate |
| Nguồn lịch sử | Người dùng sẽ tải file nguồn lên sau | Chưa chạy backfill trước khi nhận file chính thức; khoảng thiếu tiếp tục hiển thị “Chưa có dữ liệu”, không điền 0 |
| Chuẩn gom tuần | Tuần ISO **Thứ Hai–Chủ Nhật** | Aggregate tuần dùng timezone `Asia/Ho_Chi_Minh`; ghi rõ phạm vi tuần trong tooltip/bảng/export |
| Ngày tương lai | Cho phép chọn đến `max_ops_date` của lịch hiệu lực | Default vẫn từ đầu năm đến ngày hoàn tất gần nhất; Pax coverage chỉ tính leg đã đến hạn |
| Thị trường | Có cả Route từ lịch hiệu lực và Country từ database + `Unknown` | Giữ Route filter/ranking/table/export aggregate; cho chọn `Chặng bay / Quốc gia`; loại bản đồ |
| Xu hướng | Chuyến bay ↔ Hành khách đã báo cáo | A/D/all là scope cục bộ; `all` là một aggregate A+D; dual-axis có nhãn/coverage |
| Bảng | Thị trường và Hãng có scope riêng | Focused aggregate request, pagination/sort, URL sync và download theo đúng state bảng |
| Peak hour | Tách Chuyến bay đến và Chuyến bay đi | 24-hour view và monthly peak table không dùng capacity giả hoặc kết luận nghẽn |
| Hosting | Host trên server, truy cập qua Cloudflare Tunnel tại `report.ahtops.xyz` | Same-origin web/API qua reverse proxy; database nội bộ; service persistence, health check và rollback |

**Điều kiện đầu vào còn chờ:** file nguồn lịch sử chính thức cho S25/W25 và các mùa cũ hơn cần công bố. Sau khi nhận file, Phase 0 phải lập inventory/checksum, preview import và báo cáo reconciliation trước khi mở rộng `min_ops_date`.

## 16. Definition of Done

Kế hoạch được xem là hoàn tất sau implementation khi:

- dải ngày xuyên mùa/năm chọn được trong toàn miền dữ liệu công bố;
- dữ liệu thiếu được phân biệt với sản lượng 0;
- dữ liệu lịch sử mục tiêu đã được backfill/reconcile hoặc có trạng thái unavailable trung thực;
- báo cáo theo luồng vận hành, không còn nội dung technical/debug;
- Xu hướng và các khối tỷ trọng trình bày Chuyến bay ↔ Hành khách đã báo cáo, không dùng ARR-vs-DEP làm câu chuyện chính;
- Thị trường có Route và Country/Unknown, không có bản đồ; bảng Thị trường và Hãng có scope riêng và tải aggregate đúng dimension/state;
- filter mobile không che màn hình và có draft/apply/reset/close contract kiểm chứng được;
- mọi KPI/chart/table chỉ dùng nguồn đã có và giữ privacy/Pax coverage rules;
- `https://report.ahtops.xyz` hoạt động qua tunnel với TLS, same-origin API, database không public trực tiếp, service tự phục hồi sau reboot;
- production acceptance và rollback evidence đầy đủ.

## 17. Tài liệu tham chiếu và nguyên tắc sử dụng

- Kế hoạch nền: `docs/superpowers/plans/2026-08-21-web-traffic-report-continuous-date.md`.
- Baseline triển khai hiện tại: `docs/superpowers/artifacts/2026-08-22-public-traffic-report-baseline-audit.md`.
- Prototype UI đã duyệt: <https://aht-traffic-report-redesign.lminhtuan2911.chatgpt.site/>.
- Looker Studio tham khảo mới nhất: <https://datastudio.google.com/u/0/reporting/65214127-ce45-483e-9ae6-fb6058540a6f/page/p_ip1yzwwo2c>.
- ACI references chỉ dùng nguyên tắc hierarchy, typography và nhịp editorial; không sao chép asset/brand/layout nguyên bản.

Prototype Sites và Looker/PDF chỉ là bằng chứng thiết kế/tham khảo. Chúng không chứng minh UI → contract → Edge → RPC/SQL của ứng dụng thật đã hỗ trợ logic mới; mọi claim implementation phải dựa trên source, test, direct SQL và staging/production acceptance của repository này.
