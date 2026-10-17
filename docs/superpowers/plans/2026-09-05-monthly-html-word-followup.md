# Báo cáo HTML tổng quan tháng phục vụ báo cáo Word

Ngày: 2026-09-05. Trạng thái: đã triển khai và kiểm thử local; chưa triển khai production.

## 1. Phạm vi được duyệt

Người dùng duyệt bổ sung mốc tháng trước của năm trước và bố cục phục vụ file `TỔNG QUAN KHAI THÁC THÁNG 9-2026.docx`. Không sửa file Word hoặc reference Excel. Chuyến bay sớm, hãng/chặng mới, quay lại, tạm dừng và kết luận ảnh hưởng năng lực nhà ga nằm ngoài đợt này: cần quy tắc và nguồn xác nhận riêng.

Giữ nguồn canonical/reporting hiện hành, một RPC/statement snapshot, không lấy raw history hoặc trộn snapshot Excel vào HTML. Không đổi bảng nghiệp vụ, MV, template manifest, chiến lược export hoặc quyền truy cập.

## 2. Contract bổ sung đã duyệt

Chỉ `MONTHLY_OVERVIEW_L2` với cả `comparison=previous` và `comparison=year_ago` được bổ sung tự động:

| ID | Phạm vi | Vai trò |
|---|---|---|
| `current` | Tháng báo cáo | `current` |
| `previous` | Tháng trước | `previous` |
| `year_ago` | Tháng báo cáo năm trước | `comparison` |
| `previous_year_ago` | Tháng trước của năm trước | `previous` (context tự động) |

Mỗi kỳ có đủ sáu resource hiện hành: KPI, timeline, market, aircraft, hours, frequency. Bổ sung cặp `year_ago-vs-previous_year_ago`; không tạo cặp `current-vs-previous_year_ago`. Các kỳ luôn là tháng lịch đầy đủ, kể cả tháng 2 nhuận và tháng 1 qua năm. Kỳ context ngoài dữ liệu tiếp tục theo quy tắc coverage/missing hiện hành, không mượn dữ liệu kỳ khác.

Không thêm query parameter hay loại template. Giữ `traffic-html-data-v1` với phần mở rộng có điều kiện trên; validator yêu cầu đủ kỳ/resource/cặp tương ứng. Bỏ một hoặc cả hai lựa chọn so sánh vẫn được tôn trọng, không âm thầm thêm bốn kỳ. Các report type khác không thêm context này.

Sửa kèm lỗi validator cũ: spread object kỳ cùng năm trước có thể ghi đè ID `year_ago` thành `comparison-YYYY`. Chỉ lấy `from/to` của helper; không mang ID phụ vào expected periods. Riêng HTML tháng, tháng cùng kỳ năm trước lấy trọn tháng lịch thay vì sao ngày cuối 28/02 sang năm nhuận.

SQL cập nhật trong migration HTML đang chờ phát hành local `20260905180000_public_traffic_html_export.sql`; chưa chạy SQL này vào production. Nếu khi triển khai phát hiện migration đã được áp dụng ở môi trường đích, phải tạo migration nâng cấp có version mới; không chỉ sửa lịch sử migration và cho rằng DB đã cập nhật. Tắt luồng HTML trong lúc nâng cấp SQL/Edge để tránh trộn validator ba kỳ với envelope bốn kỳ; chỉ bật lại khi toàn bộ cùng phiên bản và smoke đạt. Excel vẫn là đường dự phòng.

## 3. Bố cục đã triển khai

- **Tóm tắt tháng:** một bảng sáu dòng Chuyến bay/Hành khách Đến, Đi, Tổng. Bốn mốc tháng cạnh nhau; mỗi ô có bình quân/ngày của chính kỳ đó; hai cột chênh lệch tuyệt đối và tỷ lệ so tháng trước/cùng kỳ.
- **Nhận xét:** sản lượng, bình quân, chênh lệch và đối chiếu biến động tháng của hai năm bằng điểm phần trăm. Có vùng văn bản chỉ đọc để chọn/sao chép sang Word. Nhận xét mô tả phép tính, không kết luận nguyên nhân.
- **Điểm ảnh hưởng:** nhìn ngay ba góc hãng, thị trường, chặng; xếp tăng/giảm riêng theo chuyến và khách. Có nút chuyển sang chi tiết cùng kỳ phân tích.
- **Hãng/thị trường/chặng/tàu bay:** mỗi nhóm gồm hai dòng Chuyến bay/Hành khách liền nhau. Mở rộng để xem Đến/Đi và cấp con. Market: quốc gia → chặng → hãng; Airline: hãng → chặng; Route: chặng → hãng. Nhóm chỉ có ở kỳ đối chiếu vẫn xuất hiện.
- **Tương tác:** chọn chiều, chọn kỳ xếp hạng ảnh hưởng, bộ lọc độc lập từng phần, sắp xếp, tìm nhóm, 20 nhóm/trang. Search và paging chỉ đổi dòng hiển thị, không đổi tổng hoặc xếp hạng; filter đổi đúng phạm vi tính. Tổng không cộng các dòng subtotal hoặc cộng ba góc nhìn với nhau.
- **Cơ cấu:** biểu đồ tròn Top 10 + Khác cho cả chuyến và khách, đặt tháng hiện tại/cùng kỳ cạnh nhau; cùng nhóm giữ màu giữa hai kỳ trong cùng chỉ tiêu. Biểu đồ thu gọn mặc định, có chú giải giá trị/tỷ trọng.
- **Ngày và giờ cao điểm:** xếp hạng độc lập chuyến/khách theo chiều chọn; số ngày/giờ và bình quân, bảng toàn bộ ngày/24 giờ kèm giờ chưa xác định. Thứ tự giờ cùng Dashboard: 05:00–04:00 địa phương hoặc 22:00–21:00 UTC; đổi múi giờ không đổi Ops Date. Không tự gộp giờ liên tiếp; chưa gọi giờ điển hình trong Frequency là danh sách chuyến bay sớm đầy đủ.
- **Tần suất:** giữ dữ liệu định kỳ hiện hành và điều kiện 4 ngày/4 tuần/70%, không suy ra lifecycle.

Không thêm phần kiểm soát dữ liệu hoặc metadata kỹ thuật trên báo cáo. Cảnh báo nghiệp vụ thiếu khách/lịch bay tương lai vẫn được giữ để tránh đọc nhầm. Pax thiếu không đổi thành 0, delta khách bị chặn khi một kỳ chưa đủ; mẫu số 0 cho phép delta nhưng không tạo phần trăm giả. Khi xếp hạng khách/ngày/giờ hoặc tỷ trọng chưa có đủ dữ liệu, hiển thị lý do thay vì kết luận sai.

## 4. Module và kiểm thử

Workspace: `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app`.

| Module | Thay đổi |
|---|---|
| `supabase/migrations/20260905180000_public_traffic_html_export.sql` | Context tháng thứ tư, cặp biến động năm trước, tháng cùng kỳ trọn tháng |
| `supabase/functions/_shared/trafficHtmlReportModel.ts` | Validate kỳ mới/cặp mới; sửa ID năm trước |
| `supabase/functions/_shared/trafficHtmlMonthlyRuntime.ts` | Runtime riêng cho tháng; không thay nhánh Weekly/Period/Bao |
| `supabase/functions/_shared/trafficHtmlMonthlyStyles.ts` | CSS chỉ áp dụng tháng, tương phản và focus, bảng responsive/print |
| `supabase/functions/_shared/trafficHtmlReportRenderer.ts` | Chọn monthly runtime, CSS và tên file tháng |
| `src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx` | Giải thích tự thêm tháng thứ tư khi chọn hai đối chiếu |
| `src/lib/trafficHtmlReport.test.ts` | Bốn kỳ, tùy chọn một/không đối chiếu, tháng 1, tháng 2 nhuận, thiếu context bị từ chối |
| `scripts/test-traffic-monthly-layout.mjs` | Fixture/đối soát V2/bộ browser offline riêng cho tháng |
| `scripts/traffic-html-edge.test.mjs` | Monthly một RPC, tên file, envelope cũ thiếu kỳ bị 422 |
| `scripts/test-traffic-html-offline.mjs` | Cập nhật smoke tháng, giữ kiểm thử các loại khác |
| `scripts/test-traffic-html-dialog.mjs` | Tải cả Weekly và Monthly HTML; Excel vẫn mặc định |

Lệnh kiểm tra:

```powershell
npm run test:traffic-html
npm run test:traffic-monthly-layout
npm run test:traffic-html-offline
npm run test:traffic-weekly-layout
npm run test:traffic-report-contract
npx tsc --noEmit --pretty false
# ESLint các file đã thay đổi
# Build bật cả hai cờ HTML/Workbook, sau đó:
npm run build:traffic-report
npm run test:traffic-html-dialog
```

Browser dùng Playwright của runtime được cấp qua `TRAFFIC_BROWSER_RUNTIME`, file:// và offline. Fixture SQL chạy trong PGlite độc lập; định nghĩa V2 được lưu từ lần đọc production trước đây chạy trên fixture này, không kết nối production.

## 5. Kết quả và giới hạn nghiệm thu

- Các test tháng tái hiện thiếu mốc thứ tư trước sửa và đạt sau sửa.
- Đối soát 4 kỳ × 3 chiều × 6 trường KPI với V2 trên fixture. Validator cũng đối chiếu tổng dataset/day spine, Unknown và các lá cùng phạm vi.
- Fixture minh họa khớp tổng chuyến Word: 3.666 / 3.304 / 3.978 / 3.898; tháng báo cáo Đến 1.950, Đi 1.948. Bình quân 118 / 110 / 128 / 130. MoM −80, YoY +594. Malaysia 256 → 370 = +44,5%, không dùng công thức 31% trong mẫu.
- Test hãng giảm chuyến nhất khác hãng giảm khách nhất; phần trăm dùng baseline đúng, đóng góp dùng tổng kỳ đối chiếu. Search/paging giữ tổng, filter độc lập, keyboard/aria-expanded, sao chép văn bản, mobile 375px/landscape, print-media.
- Test thiếu Pax chặn nhận xét so sánh/xếp hạng/biểu đồ; true zero khác null; nhóm chỉ có ở năm trước; tháng tương lai có cảnh báo; Top 10 + Khác; màu cùng nhóm qua kỳ; chuỗi chứa script không được thực thi; 0 request mạng, 0 lỗi JavaScript.
- Model/SQL/Edge, offline các loại báo cáo, Weekly, 100 test hồi quy Report, TypeScript/ESLint và build report-only đã được chạy. Receipt browser tháng: `tmp/html-monthly-review-20260905/validation.json`.

Bản xem thử chính: `tmp/html-monthly-review-20260905/tong-quan-thang-bo-cuc-moi.html`. **Chỉ tổng chuyến bốn tháng tham chiếu Word; phân bổ hãng/chặng, số khách và mốc as-of là giả lập**. Banner hiển thị ngay trong file. Không coi đây là đối soát CSDL thật hoặc chứng minh số liệu tháng 9 đã thực hiện đầy đủ.

Còn cần người dùng xem bố cục; rehearsal trên dữ liệu thật và cùng phiên bản/schema; nghiệm thu in nhiều trang thực tế, khả năng lọc/bung trên dữ liệu lớn; phê duyệt deployment riêng. Chưa triển khai production, chưa sửa nguồn mẫu và chưa làm nhóm nghiệp vụ đã hoãn.
