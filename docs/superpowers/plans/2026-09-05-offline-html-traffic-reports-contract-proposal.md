# Đề xuất hợp đồng xuất HTML offline

Ngày: 2026-09-05. Trạng thái: **Đã được người dùng duyệt bằng phản hồi “Ok”; đã triển khai endpoint/RPC và kiểm thử migration trong DB fixture local. Chưa chạy migration hoặc phát hành production.**

Tài liệu này chốt hợp đồng theo mục 2, 7–8 của [kế hoạch triển khai](./2026-09-05-offline-html-traffic-reports.md). Ba mẫu HTML đã được triển khai local; xem [biên bản và bằng chứng kiểm thử](./2026-09-05-offline-html-traffic-reports-implementation.md) để phân biệt phần đã đạt và nghiệm thu còn lại.

## 1. Quyết định cần duyệt

Đề nghị cho phép thực hiện cùng một gói thay đổi:

1. Thêm `GET /api/report/v2/html-export`, tách khỏi endpoint Excel hiện hành.
2. Thêm RPC aggregate-only `public.get_public_traffic_html_export_v1` và helper reporting riêng, chỉ Edge được gọi qua quyền server hiện hành. Không cấp quyền đọc flight leg cho trình duyệt.
3. Dùng một lần gọi RPC để lấy mọi kỳ và mọi bộ dữ liệu cần thiết trong cùng PostgreSQL statement snapshot. Không ghép các dimension độc lập, không chuyển qua snapshot Excel cũ khi nguồn live lỗi.
4. Thêm model/renderer/runtime HTML và lựa chọn HTML trong dialog; giữ đường Excel, manifest, file mẫu và mặc định hiện hành.

Không bao gồm thay bảng nghiệp vụ, materialized view, manifest Excel, chạy refresh hoặc triển khai production. Nếu thực tế cần một trong các thay đổi đó, trình riêng trước khi thực hiện. Tên phiên bản HTML là hợp đồng riêng, không phải sửa manifest Excel.

## 2. Kết quả khảo sát nguồn local

Đường dẫn trong bảng tính từ `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app`, trừ nơi ghi rõ workspace tài liệu.

| Nguồn/đường gọi hiện có | CB Đến/Đi/Tổng | HK Đến/Đi/Tổng | Thiếu cho HTML |
|---|---|---|---|
| `traffic-report/index.ts`: `fetchWorkbookOverview` → `get_public_traffic_report_overview_v1` | Có tại KPI/timeline | KPI có đủ ba; timeline chưa có A/D | Timeline sáu chỉ tiêu, coverage khách theo chiều |
| `fetchWorkbookDimension` → `get_public_traffic_report_dimension_v2` | Có mỗi dimension độc lập | Có tổng, chưa có A/D | Joint Country × Route × Airline; không đủ để bung cây |
| Overview `breakdowns.aircraft_type` | Có group/type và A/D/Tổng | Có tổng, chưa có A/D | Sáu chỉ tiêu, presence theo chiều; bỏ cách bucket Top + Other làm nguồn cho cây đầy đủ |
| Overview giờ/peak-hour/weekday heatmaps | Có chỉ tiêu chuyến bay | Không có số khách tương ứng ở các bảng giờ đang dùng | Cần aggregate giờ HK theo cùng semantics; bucket giờ thiếu phải được nhận diện |
| Core `regular_flights`/dữ liệu tần suất từ report | Ngày hoạt động, số lần, lịch định kỳ | Không có, không suy diễn | Giữ định nghĩa tần suất; không cộng `consistency_percent` hay ngày phân biệt như số chuyến |
| Edge V2 → `get_public_traffic_report_v2` | Có KPI/timeline/dimension/AC/hour | KPI có A/D/Tổng; timeline/dimension/AC chỉ tổng; giờ không có HK | Vẫn cần joint aggregate và presence A/D. Dimensions trong RPC full có giới hạn hạng, không dùng làm tập lá đầy đủ |

Các file SQL cần đọc cùng nhau:

- Workspace triển khai: `supabase/migrations/20260830213000_public_traffic_report_remove_suppression.sql`; `20260904120000_public_traffic_peak_heatmaps.sql`.
- Workspace tài liệu: `app/supabase/migrations/20260829163000_canonical_effective_read.sql`; `20260829190000_public_traffic_canonical_cutover.sql`; `20260831210000_public_traffic_live_aggregate_v2.sql`.
- Các bản cập nhật V2 trong workspace tài liệu: `20260901113000_public_dashboard_publication_timeline_quality.sql`, `20260901123000_public_dashboard_hybrid_runner.sql`, `20260902150000_public_dashboard_pax_correction.sql`. Chỉ đọc bản định nghĩa gốc ngày 31/08 sẽ bỏ sót cutoff 05:00 và điều kiện Pax được ghi nhận sớm.

Hai workspace không có cùng catalog migration. Đây là khảo sát code local, **không phải xác nhận schema/API đang chạy trên production**. Sau khi duyệt contract cần đối chiếu định nghĩa DB thực tế bằng truy vấn chỉ đọc trước khi chuẩn bị migration triển khai.

### Nguồn canonical và phiên bản

Đề xuất HTML theo semantics live V2 hiện hành: sử dụng reporting candidate slice hiện có, áp dụng đúng bước chọn canonical winner/quarantine/deleted như V2, rồi mới aggregate. Helper này đọc qua ranh giới canonical/reporting; không truy vấn raw history/base rows để tự dựng lại nguồn.

Không đọc trực tiếp `canonical_effective_flight_legs` rồi bỏ qua bước loại trùng/terminal của public reporting. Không dùng `public_traffic_effective` của đường Excel snapshot trộn với live V2 trong cùng file HTML. Không đổi hai đường hiện hành trong gói này.

Các yếu tố cùng tham gia snapshot: flight legs, coverage ledger, mapping quốc gia/AC, watermark, data version và semantic data-as-of. Vì một số mapping/coverage có thể thay đổi mà không làm tăng flight watermark, chỉ so watermark giữa nhiều request không đủ. Một RPC `STABLE` chạy trong một statement snapshot giải quyết rủi ro này mà không cần thêm bảng giữ snapshot.

## 3. Mapping reference sang catalog HTML

Đã đọc cấu trúc ZIP/XML và các tiêu đề đại diện của sáu file, không mở macro/refresh và không ghi lại workbook. SHA-256 cả sáu khớp `report-templates/source-reference-fingerprints.json`.

| File mẫu | Bảng/cấu trúc chuyển theo kế hoạch | Không chuyển trong MVP |
|---|---|---|
| `SanLuongAPR.xlsx` | `CountryApr`, `AirlineApr`, `Country26apr-2may`, `Airline_26apr-2may`: bố cục Count of Flight/Sum of Pax, A/D và tổng | `Sheet1` là dữ liệu chi tiết, không phải nguồn số liệu HTML |
| `SanLuong_Week_S26.xlsx` | Airline/Country/Routes; mẫu tổng hợp CB/HK Đến/Đi/Tổng ở Sheet1; PeakHour chuyển vào phân tích theo kỳ | Data, Detail1/2, các sheet lọc/phụ trợ; không bê nguyên PivotCache hoặc bộ lọc đang lưu trong mẫu |
| `SanLuong_Country_2026.xlsx` | Bảng pivot ở Sheet3 tham chiếu cây thị trường; không tạo tùy chọn pivot tự do | Data |
| `SanLuong_S26.xlsm` và `SanLuong_S26 - Copy.xlsm` | Airline, Country, Routes, Country_ChiTiet; Month, Frequency, PeakHour, ACType theo catalog cố định | Per30min, 30days, Config, Data, Change Log, bản drill-down và sheet phụ; không cam kết chuyển toàn bộ 18 sheet |
| `BaoCaoSanLuong.xlsm` | TOTAL, bảng tuần trong TOTAL, APR–OCT, Analysis_Airline/Country | Table1, VBA, liên kết/kết nối Excel |

Điểm cần đọc đúng: **file BaoCaoSanLuong gốc không có sheet riêng tên WEEKLY**; WEEKLY là bảng trong TOTAL. Đường export hiện tại đã tạo sheet WEEKLY riêng. HTML giữ tab Theo tuần theo kế hoạch, tham chiếu nội dung bảng tuần, không tuyên bố sao chép một sheet gốc không tồn tại. Tháng biên của mùa được sinh từ phạm vi thật, không cố định APR–OCT.

Đây là xác nhận mapping nội dung cho triển khai, chưa phải nghiệm thu hình thức hoặc xác nhận toàn bộ công thức/chart/pivot được chuyển sang HTML. Skill Spreadsheets được áp dụng ở chế độ đọc cấu trúc; không round-trip các template phức tạp qua thư viện xuất Excel.

## 4. HTTP contract đề xuất

### Request

`GET /api/report/v2/html-export`

| Tham số | Quy tắc |
|---|---|
| `html_template` | `weekly-detail-v1`, `period-analysis-v1`, `bao-cao-san-luong-v1` |
| `report_type` | Giữ năm giá trị nghiệp vụ đang có, chỉ để chọn nội dung. WEEKLY_DETAIL → weekly; BAO_CAO_SAN_LUONG → bao; MASTER_OPERATIONS/MONTHLY_OVERVIEW_L2/PERIOD_ANALYSIS → period |
| `period_mode` | Dùng quy tắc mode hiện hành theo report type: custom/month/month_range/season/year; MONTHLY_OVERVIEW_L2 chỉ month, BAO_CAO_SAN_LUONG chỉ season |
| `from`, `to` | Ops Date ISO inclusive; phải khớp preset đã chọn, không cắt âm thầm |
| `month`, `month_from`, `month_to`, `season_code`, `year` | Chỉ nhận tham số liên quan mode; reuse hàm chuẩn hóa lịch đã kiểm thử |
| `comparison` (lặp) | `previous`, `year_ago` cho Master/Monthly; Weekly tự định nghĩa trước/sau nên từ chối tham số này |
| `comparison_year` (lặp) | Cho Period Analysis; chuẩn hóa, loại trùng, không giới hạn ba năm. Năm không có dữ liệu trả lỗi rõ, không loại ngầm |
| `airline`, `route`, `country` (lặp) | Reuse allowlist/chuẩn hóa bộ lọc export; không nâng quyền hoặc mở rộng tập lọc |
| `tz` | `local` hoặc `utc`, default local; chỉ đổi trục giờ, không đổi Ops Date |

Không nhận `template_version` của Excel; không nhận HTML/JavaScript/cấu hình pivot từ client. Chiều luôn xuất cả A/D; chọn chiều ở bản offline chỉ lọc bộ dữ liệu đã nhúng. Từ chối tham số lạ, tổ hợp template/report sai hoặc kỳ đối chiếu không thuộc report type. BaoCaoSanLuong tự chọn tối đa bốn tuần theo quy tắc hiện hành để dựng ba cặp Analysis; không nhận danh sách cặp tùy ý.

Ví dụ:

```text
/api/report/v2/html-export?html_template=weekly-detail-v1&report_type=WEEKLY_DETAIL&period_mode=custom&from=2026-09-01&to=2026-09-04&tz=local
/api/report/v2/html-export?html_template=period-analysis-v1&report_type=PERIOD_ANALYSIS&period_mode=year&year=2026&from=2026-01-01&to=2026-12-31&comparison_year=2025&comparison_year=2024&tz=local
```

### Response và giới hạn tài nguyên

- Thành công: `200`, `Content-Type: text/html; charset=utf-8`, `Content-Disposition: attachment` với tên file an toàn, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Không stream một phần artifact cho client. Chỉ gửi file sau khi validate toàn bộ bucket, tổng đối soát và hoàn tất serialization.
- `400`: request sai; `409`: phiên bản không còn khớp nếu caller có pin; `422`: kỳ không khả dụng hoặc dữ liệu không đạt điều kiện xuất; `413`: vượt ngân sách; `503`: nguồn/RPC chưa sẵn sàng. Response lỗi là JSON ngắn, không giả thành HTML thành công.
- Ngân sách khởi điểm đề xuất: tối đa 250.000 bucket tổng hợp và 25 MiB HTML UTF-8; SQL statement timeout 30 giây. Đây là ngưỡng bảo vệ cần đo bằng dữ liệu đại diện trước phát hành, không phải cam kết hiệu năng. Vượt ngưỡng trả lỗi đề nghị thu hẹp phạm vi; không cắt hàng/kỳ.
- MVP không phân trang RPC. Không chuyển giới hạn hiện hành 732 dòng/25 trang hay 3.660 ngày của endpoint khác thành việc cắt dữ liệu HTML. Nếu một statement không đáp ứng budget, đề xuất riêng phương án phân trang có snapshot thực sự; chưa thêm bảng snapshot trong gói này.

## 5. RPC và envelope đề xuất

Chữ ký mới, không sửa chữ ký RPC V1/V2 cũ:

```sql
public.get_public_traffic_html_export_v1(
  p_request jsonb,
  p_expected_watermark bigint default null,
  p_data_as_of timestamptz default null
) returns jsonb
```

`p_request` là request đã normalize ở Edge, được validate lại trong SQL: `{contract_version, html_template, report_type, period_mode, from, to, comparison_years, comparisons, airlines, routes, countries, time_basis}`. Không nhận SQL expression hoặc tên trường tùy ý. Server xác định các kỳ, context, ngày/tháng/tuần và cặp Analysis theo cùng thư viện quy tắc và parity test.

RPC đặt `STABLE`, `SECURITY DEFINER`, search_path cố định; revoke khỏi PUBLIC/anon/authenticated và grant đúng vai trò server mà Edge đang sử dụng. Không thêm quyền SELECT nguồn. Mọi helper mới trong schema reporting cũng không public. Migration chỉ được viết sau khi đề xuất này được duyệt và quyền gọi hiện hành được kiểm chứng.

Envelope JSON:

```typescript
type HtmlExportEnvelope = {
  contract_version: 'traffic-html-data-v1';
  source_mode: 'live';
  source_watermark: string; // bigint decimal: không mất chính xác qua JSON
  data_version: number;
  data_as_of: string;
  snapshot_scope: 'single-statement';
  normalized_request: object;
  request_hash: string;
  periods: Array<{
    id: string; role: 'current' | 'previous' | 'next' | 'comparison' | 'analysis-week';
    from: string; to: string; calendar_days: number; label: string;
  }>;
  comparison_pairs: Array<{ id: string; minuend_period: string; baseline_period: string }>;
  calendar: object; // ngày thật, tháng/ISO/Fri-Thu và giao biên do server xác định
  resources: Array<{
    dataset: 'kpi' | 'timeline' | 'market' | 'aircraft' | 'hours' | 'frequency';
    period_id: string;
    filter_hash: string;
    normalized_filter: object;
    complete: boolean; // đọc hết tập, KHÔNG có nghĩa Pax đủ
    row_count: number;
    totals: object; // baseline server, tách khỏi các hàng lá
    rows: object[];
  }>;
};
```

Hash request gồm mọi kỳ/cặp đối chiếu và bộ lọc. Hash resource kiểm tra theo bộ lọc của chính period/dataset; không yêu cầu mọi resource chung một filter hash. `snapshot_scope` không được mô tả thành snapshot lịch sử có thể truy vấn lại: MVP chỉ bảo đảm tính nhất quán của lần xuất đó.

### Grain của các bucket

| Dataset | Khóa lá | Cách dùng/đối soát |
|---|---|---|
| KPI | period × direction A/D/all | Tổng do server cấp; so sáu chỉ tiêu, không cộng cả ba direction với nhau |
| Timeline | period × Ops Date × direction A/D | Spine đủ ngày; tổng ngày đối soát KPI. Tháng/tuần là cây thay thế, không cộng hai hệ tuần |
| Market | period × country × route × airline × direction A/D | Từ một tập lá dựng ba cây Airline/Market/Route; không bổ sung chiều thời gian/AC không thuộc bộ lọc của tab |
| Aircraft | period × group × type × direction A/D | Chỉ lá type, gồm nhóm Unknown; không trộn dòng subtotal group vào lá |
| Hours | period × hour 0–23/unknown × direction A/D | Có HK cùng semantics; unknown giữ ngoài xếp hạng nhưng tính trong đối soát. Khi mode tháng: kỳ là tháng đã chọn |
| Frequency | period × hour × direction × airline × route × flight number | Giữ qualifying weekday, occurrence/eligible days, typical time và consistency theo V2; không cấp Pax giả |

Các resource của tuần Analysis có period riêng. Không cộng chúng vào tổng mùa lần nữa. Tần suất chỉ là danh sách lịch định kỳ thỏa điều kiện, **không phải một partition bao trùm mọi chuyến**; không ép tổng tần suất bằng KPI.

Khóa được encode lossless từ tuple canonical có namespace, không ghép bằng dấu phân cách không escape hoặc slug của label. Dùng mã airline/route/aircraft hiện hành; country/group dùng giá trị danh mục canonical và discriminant riêng cho Unknown. Tên trình bày không quyết định join. Schema hiện tại không chứng minh có ID quốc gia bền vững qua đổi tên; MVP chỉ bảo đảm định danh không va chạm và nhất quán trong snapshot, không tự thêm master-data ID hoặc ghép lịch sử đổi tên.

### Metrics và coverage

Mỗi lá sản lượng có `flights`, `reported_pax`, `reported_legs`, `due_legs`, `missing_due_legs`, `true_zero_reported_legs`, `unreported_legs`, `flight_coverage`, `pax_status`. Số lượng dùng integer không âm; kiểm tra safe integer trước tính JS, từ chối nếu vượt độ chính xác.

- `reported_legs`/`reported_pax`: cùng điều kiện đủ tuổi ghi nhận của V2 đã cập nhật 02/09. Ngày hoàn tất đã được coverage chấp nhận có Pax được ghi nhận ngay; Pax null tiếp tục theo hạn T+24. Không tự đổi điều kiện thành mọi `pax IS NOT NULL`.
- `unreported_legs = flights - reported_legs` để không gọi một kỳ có chuyến tương lai và chỉ một phần Pax là đầy đủ chỉ vì chưa quá hạn báo cáo.
- Không bản ghi Pax đủ điều kiện: `reported_pax = null`; có true zero: giữ `0`; một phần: giữ subtotal được ghi nhận và cảnh báo nghiệp vụ ngắn.
- A hoặc D thiếu: chiều thiếu giữ null. Tổng là subtotal canonical đã ghi nhận; không chia đôi tổng hoặc trừ ngược để suy đoán chiều thiếu. Cộng null-aware chỉ trên những giá trị thực sự có, kèm trạng thái thiếu.
- So sánh HK chỉ tính Δ/% khi cả hai giá trị hợp lệ, coverage hoạt động đủ và không còn phần Pax chưa ghi nhận trong phạm vi so sánh. Thiếu: Δ/% null. Baseline 0 hợp lệ: Δ tính được, % null.
- Nhóm không có ở một kỳ: chỉ bổ sung CB 0 khi resource đọc đầy đủ và coverage xác nhận không có hoạt động; thiếu coverage giữ null. HK không có bản ghi vẫn null, kể cả CB bằng 0.
- `flight_coverage` độc lập `pax_status`, independent với việc request chỉ chọn một phần tháng. Số ngày lịch là giao phạm vi chọn/bucket, kể cả ngày missing.
- Giữ semantics chuyến bay effective của reporting; không gọi tuần tương lai là chuyến đã thực hiện. Hiển thị kỳ lịch bay tương lai và khách đã ghi nhận rõ ràng.

## 6. Kiểm tra bắt buộc trước khi tạo HTML

1. Đủ resource theo template và period; `complete=true`; row_count khớp; unique tuple keys, không duplicate rows.
2. Timeline đủ spine ngày, giữ missing/null có coverage. Sáu KPI khớp tổng nguồn độc lập; A+D bằng all theo quy tắc subtotal khách.
3. Market/AC/hour (gồm Unknown) đối soát KPI cùng kỳ/chiều; không dùng frequency làm tổng KPI.
4. Cặp Weekly là current−previous và next−current; mỗi kỳ bình quân theo số ngày riêng. Bao analysis giữ ba cặp gần nhất được chọn, không sinh mọi cặp mùa.
5. Fixture độc lập gồm asymmetric A/D Pax, true-zero, all-null, partial, missing day, group only-in-comparison, Unknown/nhãn trùng, leap day, mùa qua năm và tháng biên.
6. Parity với V2 đã áp dụng các migration correction/cutoff; test trước/sau 05:00, completed accepted date có Pax trước T+24, null chưa quá hạn và null quá hạn. Không chỉ so tổng flights.
7. Không lấy nguồn thay thế khi RPC không sẵn sàng; không phát hành artifact nếu mismatch. Thông tin kiểm soát giữ trong test/log an toàn, không tạo tab kiểm soát cho người đọc.

## 7. Thay đổi đã thực hiện độc lập với contract mới

Workspace triển khai, không có migration/API mới:

| File | Thay đổi |
|---|---|
| `supabase/functions/_shared/trafficWorkbookCore.ts` | Union nhóm ở các kỳ nhưng lấy metrics đúng kỳ; giữ nhóm chỉ có previous/yearAgo; clip ngày tháng/tuần theo phạm vi chọn; giữ context Weekly; giữ Pax A/D nếu nguồn có cung cấp; nhận diện ngày thiếu |
| `supabase/functions/_shared/trafficWorkbookRenderer.ts` | Bình quân và số ngày ở mỗi dòng kỳ so sánh lấy phạm vi riêng, không dùng số ngày kỳ hiện tại |
| `src/lib/trafficWorkbookExport.test.ts` | Thêm sáu kiểm thử hồi quy: context-only, prior/year-only, tháng/tuần biên + Pax true-zero/null, missing day, February leap-year denominator, weekly contexts |

Đã tái hiện sáu test thất bại trước sửa, sau sửa workbook 20/20 đạt. Không tuyên bố đã sửa toàn bộ vấn đề nền: Pax theo chiều chưa được API cấp đủ, presence/coverage và Δ HK chưa có model HTML, kiểm tra pin/dedup across resources còn thuộc phần sau duyệt.

## 8. Validation local và bước tiếp theo

Kết quả ngày 2026-09-05 tại workspace triển khai:

- `npm run test:traffic-report-contract`: đạt 100 Node tests (62 + 31 + 7), SQL PGlite, Edge contract và isolation.
- `npx tsc --noEmit --pretty false`: đạt.
- `npx eslint supabase/functions/_shared/trafficWorkbookCore.ts supabase/functions/_shared/trafficWorkbookRenderer.ts src/lib/trafficWorkbookExport.test.ts`: đạt.
- `npm run build:traffic-report`: đạt, artifact report-only build local.
- SHA-256 của sáu reference: khớp catalog đang lưu; không sửa mẫu hoặc manifest.

Chưa có: RPC/HTML contract được duyệt; ba file HTML nghiệm thu; browser file:// offline; đo hiệu năng trên dữ liệu thật; Excel Desktop acceptance; smoke URL thật; production deploy.

Sau khi duyệt mục 1, triển khai theo thứ tự: RPC aggregate + fixture/parity → model và metric validation → Weekly HTML và offline test → Period/monthly → BaoCaoSanLuong → nghiệm thu. Tắt feature HTML là rollback chuyển tiếp; đường Excel tiếp tục hoạt động. Không cần quyết định lại các tương tác/phạm vi đã chốt trong kế hoạch gốc.
