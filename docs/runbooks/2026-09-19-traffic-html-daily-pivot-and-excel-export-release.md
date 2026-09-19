# 2026-09-19 Production Release: Traffic HTML Daily Pivot Clarity & Native Excel Export

## 1. Mục tiêu & Các vấn đề giải quyết
1. **Tinh giản & chống rối bảng Pivot tab "Theo ngày":**
   - **Thanh chọn kỳ (Period Selector):** Thay vì xếp chồng hàng loạt bảng rỗng / không có dữ liệu của các kỳ khác nhau khiến giao diện dài vô tận và trùng lặp tiêu đề, hệ thống lọc thông minh chỉ các kỳ thực sự có dữ liệu và hiển thị thanh chọn kỳ dạng thẻ trực quan (`[ ★ Kỳ đã chọn ] | [ Kỳ trước ] | [ Tất cả kỳ có số liệu ]`).
   - **Tự động mở rộng (Expanded by Default):** Mặc định mở sẵn toàn bộ danh sách ngày trong tháng mà người dùng không cần bấm "Mở tất cả".
   - **Hiển thị thứ trong tuần (Day of Week):** Định dạng nhãn ngày trực quan dạng `01/09/2026 (Thứ 3)` giúp nhận diện nhanh quy luật khai thác theo thứ.
2. **Chuyển đổi toàn bộ xuất CSV thành xuất file Excel native (`.xlsx`):**
   - Thay thế nút `Xuất CSV` tại thanh công cụ hành động của bảng thành `Xuất Excel` (nền xanh lá nhạt nổi bật).
   - Tích hợp động cơ sinh file OpenXML `.xlsx` dạng nhị phân thuần client-side (chuẩn MIME `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
   - Tự động nhận diện dữ liệu số và lưu trữ dưới dạng numeric XML `<v>`, cho phép tính toán SUM/AVERAGE ngay trong Excel mà không bị lỗi text.
   - An toàn tuyệt đối: không có rủi ro Formula Injection do chuỗi văn bản được đóng gói trong inline strings `<is><t>`.

## 2. Các tệp mã nguồn thay đổi
- `app/supabase/functions/_shared/trafficHtmlPivotRuntime.ts`:
  - Thêm động cơ tính checksum CRC32, đóng gói file ZIP nhị phân và `tableToXlsx`.
  - Cập nhật hàm format ngày `name` kèm thứ trong tuần tiếng Việt (`Thứ 2`, `Thứ 3`, ..., `Chủ Nhật`).
  - Mặc định `depth: 1` và `pageSize: 0` cho tab `days`.
  - Thay thế nút `csvBtn` bằng `excelBtn`.
  - Thêm logic render thanh chọn kỳ thông minh `pivot-period-selector` cho tab `days`.
- `app/supabase/functions/_shared/trafficHtmlPivotStyles.ts`:
  - Bổ sung CSS cho nút `pivot-btn-excel`, thanh `pivot-period-selector` và các nút `pivot-period-btn`.

## 3. Nhật ký triển khai Production (100.91.158.79)
- **Phương thức kết nối:** SSH Paramiko qua `100.91.158.79`, người dùng `ops` với mật khẩu xác thực sudo.
- **Thư mục phát hành Edge Functions:**
  `/srv/seasonal-traffic-report/functions/20260919T104500Z-pivot-clarity-and-excel-export`
- **Kiểm soát tính toàn vẹn SHA-256 (Byte-exact parity):**
  - `trafficHtmlPivotRuntime.ts`: `760234db53106d91a706df26aeaea50e74743b33555099bd77b1d74d5dc53e27` (Trùng khớp 100%)
  - `trafficHtmlPivotStyles.ts`: `078b0e26ba5c7c7255937bceab641ca9e599b3784f3f799724f5c89e6d5b7fda` (Trùng khớp 100%)
- **Cấu hình & Tái khởi động Service:**
  - Sao lưu compose: `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260919-excel`
  - Mount mới: `/srv/seasonal-traffic-report/functions/20260919T104500Z-pivot-clarity-and-excel-export:/home/deno/functions:ro`
  - Khởi động lại: `docker compose -f /srv/seasonal-traffic-report/infra/docker-compose.yml up -d traffic-report-edge`
  - Trạng thái container: `running` (StartedAt: `2026-09-19T04:19:58Z`, không restart).

## 4. Bằng chứng nghiệm thu thực tế trên Live Production
- **Endpoint HTTP 200 OK:**
  - Báo cáo tháng: `v2/html-export` (T9/2026) trả về HTTP 200 OK, dung lượng 1.89 MB.
  - Báo cáo tuần: `v2/html-export` (11-17/09) trả về HTTP 200 OK, dung lượng 864 KB.
- **Headless Browser & Openpyxl Automated Acceptance Test:**
  - Tab "Theo ngày": Hiển thị duy nhất 1 bảng gọn gàng theo kỳ mặc định (`★ Kỳ đã chọn`), thanh chọn kỳ hiển thị đầy đủ `['Kỳ trước', '★ Kỳ đã chọn', 'Tất cả kỳ có số liệu']`.
  - Cột ngày hiển thị đầy đủ thứ: `01/09/2026 (Thứ 3)`, `02/09/2026 (Thứ 4)`, ...
  - Tải file Excel từ tab "Theo ngày": Tệp `.xlsx` sinh ra hợp lệ (`34 hàng x 7 cột`), các ô chuyến bay / hành khách lưu đúng kiểu số (`int`).
  - Tải file Excel từ tab "Hãng hàng không" (Analysis): Tệp `.xlsx` sinh ra hợp lệ (`23 hàng x 5 cột`).
  - Tải file Excel từ Báo cáo tuần: Tệp `.xlsx` sinh ra hợp lệ (`23 hàng x 7 cột`).
