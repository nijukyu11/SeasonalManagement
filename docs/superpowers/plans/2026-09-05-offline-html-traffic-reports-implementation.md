# Biên bản triển khai HTML offline — 05/09/2026

Trạng thái: đã triển khai và kiểm thử local sau khi người dùng duyệt hợp đồng bằng phản hồi “Ok”. Chưa chạy migration, refresh hay phát hành production. Việc đọc định nghĩa RPC đang chạy chỉ dùng truy vấn read-only.

## 1. Kết quả

| Mẫu | Nội dung đã triển khai |
|---|---|
| Tuần chi tiết | Tổng quan; ngày thật của kỳ chọn, đúng 7 ngày trước/sau; cây hãng/chặng, quốc gia/chặng/hãng, chặng/hãng, nhóm/loại tàu bay; hai cặp chênh lệch đúng chiều |
| Phân tích theo kỳ | Một/nhiều tháng, mùa, năm, khoảng ngày; nhiều năm quá khứ; khối đối chiếu xếp dọc; tháng/ngày hoặc tuần nghiệp vụ/ISO riêng; giờ và tần suất |
| Tổng quan tháng L2 | Dùng mẫu Phân tích theo kỳ; tóm tắt, kỳ trước/cùng kỳ, Top 5 ngày/giờ xếp riêng theo chuyến/khách và Đến/Đi/Tổng |
| Báo cáo sản lượng | Tổng hợp, tuần Thứ Sáu–Thứ Năm, tháng kể cả tháng biên mùa, Analysis Airline/Country; tối đa bốn tuần đến ngày mới nhất có khách ghi nhận và ba cặp tuần liền nhau |

Các bảng sản lượng có Chuyến bay/Hành khách và Đến/Đi/Tổng. Chênh lệch khách để trống nếu một kỳ còn thiếu khách; số khách ghi nhận bằng 0 vẫn là 0. Tần suất chỉ thể hiện lịch định kỳ, không gán Pax hay cộng tỷ lệ ổn định.

Mỗi tab giữ bộ lọc độc lập, tìm tên không làm đổi tổng, sắp xếp trong cùng cấp, bung/thu gọn, đặt lại và in tab hiện tại. Biểu đồ chuyến/khách tách riêng, Top 10 + Khác xếp hạng độc lập. Bảng nhóm phân trang 20 nhóm; tổng tính toàn bộ phạm vi lọc, không chỉ trang đang mở.

HTML dùng điều khiển trình duyệt, màu tương phản, số căn phải và focus rõ theo baseline-ui/ui-ux-pro-max; không thêm animation. CSS/JS/SVG/dữ liệu nhúng trong một file, không CDN, fetch hay localStorage. Không có tab thông tin kỹ thuật hoặc kiểm soát dữ liệu. Metadata kiểm chứng chỉ nằm trong dữ liệu nhúng, không hiện trong luồng đọc.

## 2. Mapping và khác biệt có chủ đích với Excel

- Giữ cấu trúc nghiệp vụ đã ghi ở mục 5 kế hoạch và bảng reference của đề xuất hợp đồng; không chuyển mọi sheet trong sáu workbook mẫu.
- Không mang Data/Table1, Change Log, drill-down raw, VBA, PivotCache, liên kết hoặc Power Query vào HTML.
- Không sao chép pixel/style Excel; dùng bảng HTML, lọc native, biểu đồ SVG. Không chỉnh file mẫu hoặc manifest Excel.
- Không ghép ngày thứ N giữa hai kỳ; bảng thời gian dùng ngày thật của từng kỳ. Bình quân dùng số ngày lịch đã chọn, kể cả ngày còn thiếu.
- Các bảng so sánh dùng giá trị từng kỳ, chênh lệch và % so với kỳ đối chiếu. Không bổ sung công thức đóng góp riêng ngoài hợp đồng chỉ tiêu đã duyệt; phần này cần đối chiếu nghiệp vụ khi nghiệm thu Analysis.
- Nội dung ghi chú/chuyến sớm không có nguồn xác nhận không được tạo giả. Tần suất giữ điều kiện hiện hành: ít nhất 4 ngày hoạt động, 4 tuần trong khoảng từ lần đầu đến lần cuối, mức ổn định tối thiểu 70%.

## 3. File triển khai

Đường dẫn dưới đây tính từ `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app`.

| File | Vai trò |
|---|---|
| `supabase/migrations/20260905180000_public_traffic_html_export.sql` | RPC mới và helper riêng; một STABLE statement snapshot cho tất cả kỳ/dataset; chỉ service_role được gọi public RPC |
| `supabase/functions/_shared/trafficHtmlReportContract.ts` | Request HTML, kiểu dữ liệu, ngân sách, phép cộng/null và so sánh dùng chung |
| `supabase/functions/_shared/trafficHtmlReportModel.ts` | Hash request/resource, kỳ/lịch, bucket duy nhất, Pax presence, tổng lá/KPI và A+D |
| `supabase/functions/_shared/trafficHtmlReportRuntime.ts` | Catalog tab cố định và tương tác offline; chưa cần một file definitions riêng |
| `supabase/functions/_shared/trafficHtmlReportRenderer.ts` | Đóng gói HTML, CSS, script, SVG; escape dữ liệu; CSP chặn kết nối |
| `supabase/functions/traffic-report/index.ts` | GET HTML mới, một lần gọi RPC, timeout, kiểm chứng rồi mới tải attachment; lỗi nghiệp vụ, no-store |
| `src/lib/trafficHtmlExportContract.ts` | URL HTML riêng; không gửi template_version Excel |
| `src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx` | Chọn HTML/Excel; Excel mặc định, giữ lựa chọn report type hiện hành |
| `scripts/build-traffic-report-only.mjs` | Đưa contract HTML vào build cô lập |
| `../deploy/traffic-report/nginx*.conf` | Route HTML chính xác, bỏ cookie/authorization đầu vào, không cache, timeout 40 giây; mới sửa local |

Nguồn là candidate slice canonical cùng quy tắc xếp phiên bản, quarantine và loại terminal như V2 hiện hành. Không đọc raw history hoặc snapshot Excel để thay thế khi lỗi. Giữ cutoff Ops Date 05:00 và điều kiện Pax được ghi nhận của bản sửa 02/09. Không sửa RPC V2, bảng nghiệp vụ hoặc materialized view.

Watermark nhúng dạng chuỗi thập phân để không mất độ chính xác bigint. Cả yêu cầu dùng một statement snapshot; không chia trang RPC. Giới hạn 250.000 bucket, 25 MiB file và 30 giây SQL; vượt giới hạn trả lỗi, không cắt dữ liệu. Đây là ngưỡng bảo vệ, chưa phải cam kết hiệu năng production.

## 4. Bằng chứng local

| Kiểm tra | Kết quả |
|---|---|
| `npm run test:traffic-report-contract` | Đạt 100 Node tests, SQL PGlite, Edge contract và report isolation; gồm 20 workbook tests |
| `npm run test:traffic-html` | Đạt model/metrics/renderer, SQL RPC và hành vi Edge thực với HTTP/RPC được mock |
| V2 parity trong PGlite | Định nghĩa V2 được lấy read-only từ production ngày 05/09, chạy trong DB fixture độc lập; KPI chuyến/khách/presence và timeline khớp từng A/D/all |
| SQL mở rộng | Migration áp dụng hai lần; deleted/ambiguous không đếm; NULL/true-zero; cutoff trước/sau 05:00; nhiều kỳ, năm nhuận, mùa đông qua năm; UTC; unknown giờ; group ID khác nhưng tên giống; tần suất; quyền RPC; watermark conflict |
| `npm run test:traffic-html-offline` | Đạt trên Microsoft Edge headless, file://, context offline; sáu artifact; 0 request HTTP(S), 0 lỗi JavaScript |
| Tương tác offline | Search không đổi tổng, filter độc lập/reset, keyboard Enter/aria-expanded, sáu khối theo chiều, Top 10 CB/HK khác nhau, Khác, phân trang, cây tần suất, cao điểm ngày/giờ, Unicode và nhãn chứa script không thực thi |
| `npm run test:traffic-html-dialog` | Đạt với build local và API fixture: HTML gọi đúng endpoint đúng một lần, tải .html, mở lại dialog vẫn mặc định Excel |
| TypeScript / ESLint | `npx tsc --noEmit --pretty false` và ESLint các module HTML/dialog đạt |
| `npm run build:traffic-report` | Đạt khi bật và tắt cờ HTML; giữ build report-only cô lập |
| Layout | Đã xem ảnh desktop, mobile 375px, print-media và tần suất; mobile cuộn bên trong bảng, không tràn ngang toàn trang |

File mẫu kiểm thử và receipt nằm tại `app/tmp/html-offline-20260905/` trong workspace triển khai. Chúng dùng dữ liệu giả lập nhất quán, **không phải báo cáo production**.

| Artifact fixture | Bucket | Dung lượng UTF-8 | Thời gian mở quan sát |
|---|---:|---:|---:|
| `bao-cao-tuan.html` | 201 | 100.983 byte | 91 ms |
| `phan-tich-theo-ky.html` | 2.355 | 730.773 byte | 50 ms |
| `bao-cao-san-luong.html` | 750 | 265.004 byte | 39 ms |

Số đo là một lần chạy local, không dùng làm SLA. Receipt chi tiết: `validation.json`, `dialog-validation.json`; ảnh gồm weekly-desktop/mobile/print, period-desktop, bao-desktop, frequency-desktop, export-dialog.

## 5. Còn phải nghiệm thu trước production

1. Rehearsal trên clone có dữ liệu đại diện và cùng schema/role/source definitions: đối soát từng bộ lọc kết hợp và các kỳ với nguồn canonical; đo thời gian query, mở/lọc/bung với mùa/năm/nhiều năm và gần ngưỡng ngân sách.
2. Người dùng xác nhận layout ba mẫu, đặc biệt Analysis và ý nghĩa tỷ trọng/đóng góp; in nhiều trang thực tế, zoom và file gửi sang máy khác. Print-media headless không thay thế nghiệm thu máy in hoặc Excel Desktop.
3. So sánh cùng watermark/data_as_of/phạm vi giữa HTML và dashboard/publication; không coi việc chạy định nghĩa V2 trên fixture là đối soát số liệu production.
4. Sau khi được cho phép triển khai: kiểm tra migration dependencies, chạy migration bằng quyền phù hợp, reload schema cache PostgREST; phát hành Edge và Nginx đã kiểm tra `nginx -t`, rồi build frontend bật cờ. Tải từ URL thật và mở lại offline.

Không cần đổi schema nghiệp vụ, materialized view, Excel manifest hay chiến lược một-file trong gói này. Nếu rehearsal cho thấy cần đổi các phần đó, phải trình riêng.

## 6. Cờ phát hành và rollback (chưa thực hiện)

- Edge: `TRAFFIC_HTML_EXPORT_ENABLED=true` mới cho phép xuất HTML. Cờ tắt mặc định, endpoint trả 404.
- Frontend: `NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED=true` để hiện lựa chọn HTML; dialog hiện vẫn nằm trong `NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED=true`. Giữ allowlist report type hiện hành ở cả Edge/frontend.
- Bật Edge trước, frontend sau. Không đưa credential vào frontend/HTML. Dùng runbook triển khai hiện hành, không áp dụng SQL fixture `public_traffic_live_v2_reference_20260905.sql` vào môi trường thật.
- Rollback nhanh: tắt cờ Edge HTML, build/phát hành frontend với cờ HTML=false. Excel và RPC hiện hành không bị thay thế; có thể giữ RPC mới không được sử dụng, không cần xóa dữ liệu hay rollback bảng nghiệp vụ.

Lệnh browser yêu cầu Playwright có sẵn hoặc `TRAFFIC_BROWSER_RUNTIME` trỏ tới `node_modules/package.json` của runtime được cấp. Chạy dialog test sau build bật hai cờ export. Không chạy các lệnh deployment chỉ để hoàn tất test local.

## 7. Bản thử Weekly sau phản hồi bố cục

Người dùng duyệt “ok sửa thử” sau khi yêu cầu đặt các tuần cạnh nhau và làm rõ nhóm ảnh hưởng. Đã sửa nhánh Weekly trong runtime/renderer, không thay API, SQL, template Excel hay cách trình bày Period Analysis/BaoCaoSanLuong.

- Tổng quan: một bảng sáu dòng Chuyến/Khách Đến, Đi, Tổng; cột tuần trước, tuần báo cáo, chênh lệch, %, bình quân/ngày. Bình quân làm tròn sau phép chia; phần trăm Weekly hiển thị tối đa một chữ số thập phân.
- Hãng/thị trường/chặng/tàu bay: một bảng với hai cụm Chuyến bay/Hành khách, mỗi cụm đặt tuần trước và tuần báo cáo cạnh nhau. Bung nhóm để xem Đến/Đi và cấp con, không chia sáu khối bảng dọc.
- Xếp nhóm tăng/giảm riêng theo chênh lệch chuyến và khách. Đóng góp dùng chênh lệch nhóm / tổng tuần trước của phạm vi lọc, hiển thị điểm phần trăm. Không cộng ảnh hưởng giữa các góc nhìn.
- Bộ lọc nâng cao, biểu đồ cơ cấu và tuần kế tiếp thu gọn mặc định. Search chỉ đổi dòng hiển thị, không đổi tổng hoặc xếp hạng ảnh hưởng. Không xếp hạng khách khi tổng phạm vi chưa đủ dữ liệu so sánh.
- Giữ nguồn canonical và Pax-null; không gọi mọi lịch bay là chuyến thực hiện. Kỳ có ngày tương lai được cảnh báo, tuần kế tiếp tách riêng.

File xem thử: `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app/tmp/html-weekly-review-20260905/bao-cao-tuan-bo-cuc-moi.html`. Tổng kỳ chọn là 389 chuyến đến / 391 chuyến đi / 64.155 khách đến / 67.359 khách đi theo ví dụ người dùng. Ngày báo cáo, tuần trước/sau và phân bổ hãng/chặng đều là fixture minh họa, không phải kết quả truy vấn production; có banner ngay trong file.

Kiểm thử riêng `npm run test:traffic-weekly-layout` đạt: sáu chỉ tiêu, bình quân 56 / 56 / 111 chuyến và 9.165 / 9.623 / 18.788 khách; đúng chênh lệch và Top tăng/giảm; search giữ tổng/xếp hạng; filter độc lập; keyboard bung Đến/Đi; mobile 375px; print-media; Pax thiếu chặn nhận xét và xếp hạng; 0 request mạng, 0 lỗi JavaScript. Bộ offline ba mẫu, SQL/Edge, TypeScript/ESLint và 100 test hồi quy report cũng đạt.

Ảnh và receipt mới nằm cùng thư mục: `tong-quan.png`, `hang-hang-khong.png`, `thi-truong.png`, `mobile.png`, `ban-in.png`, `validation.json`. Còn chờ người dùng nhận xét bản thử; chưa triển khai production. Bảng số đo ở mục 4 là lần đo trước thay đổi Weekly này.

## 8. Báo cáo tháng theo mẫu Word — phần mở rộng đã duyệt

Sau khi xem Weekly, người dùng yêu cầu Tổng quan tháng cung cấp nội dung cho file Word tháng 9 và đã duyệt bổ sung tháng trước của năm trước. Chi tiết contract, bố cục, file thay đổi và kiểm thử được ghi tại [2026-09-05-monthly-html-word-followup.md](2026-09-05-monthly-html-word-followup.md).

Monthly có runtime riêng; bốn mốc tháng cạnh nhau, sáu chỉ tiêu, hai dòng chuyến/khách cho mỗi nhóm, Đến/Đi khi bung, xếp hạng ảnh hưởng và nhận xét sao chép sang Word. Giữ lựa chọn một/không đối chiếu; chỉ tự thêm context khi chọn cả tháng trước và cùng kỳ. Không triển khai lifecycle/chuyến bay sớm hoặc sửa template nguồn. SQL HTML local và validator được nâng cùng nhau; deployment cần kiểm tra trạng thái migration thật và tránh trộn phiên bản.

Bản thử: `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app/tmp/html-monthly-review-20260905/tong-quan-thang-bo-cuc-moi.html`; có banner dữ liệu giả lập. Không phải số liệu production. Weekly, Period Analysis, Bao và Excel giữ đường hiện hành; chưa triển khai production.

## 9. Bố cục theo reference ngày 2026-09-06

Người dùng đã duyệt chỉnh BaoCaoSanLuong và các bảng pivot theo mẫu. Biên bản mới: [HTML theo bố cục reference và PivotTable](2026-09-06-html-reference-pivot-layout.md).

Giao diện mặc định chuyển sang bảng pivot; tóm tắt tuần/tháng ở mục 7–8 vẫn truy cập qua “Tóm tắt và phân tích”. Bao có DAILY/WEEKLY cạnh nhau, tab tháng và ba cặp Analysis với CTG. HTML v2 bổ sung daily market aggregate để dựng cột tuần/tháng thực; không phân bổ ngược từ tổng. RPC HTML v1 vẫn giữ, Edge mới cần SQL v2 trước khi phát hành. Đây là kết quả local, chưa phải triển khai production; kết quả fixture không thay thế đối soát dữ liệu thật.
