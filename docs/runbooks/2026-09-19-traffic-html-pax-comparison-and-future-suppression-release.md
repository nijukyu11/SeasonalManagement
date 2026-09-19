# 2026-09-19 Production Release: Traffic HTML Pax Comparison Recovery, Future Week Suppression & Monthly Elapsed Averages

## 1. Bối cảnh & Nguyên nhân gốc
- **Tệp báo cáo tháng (`tong-quan-khai-thac-thang` T9/2026):**
  - T8/2026 có 3 chặng ferry/crew không có khách (`missing_due_legs = 3`), khiến logic kiểm tra trước đó đánh nhãn `Chưa đủ khách` và khóa toàn bộ cột chênh lệch Chuyến bay & Hành khách của các bảng chi tiết.
  - T9/2026 là tháng đang diễn ra (mới có dữ liệu đến ngày 18/09), nhưng bình quân khách/ngày bị chia nhầm cho toàn bộ 30 ngày lịch của tháng (gây ảo giác bình quân tụt dốc).
- **Tệp báo cáo tuần (`bao-cao-tuan` 11/09 - 17/09/2026):**
  - Tuần kế tiếp (18/09 - 24/09/2026) là kỳ tương lai theo lịch bay dự kiến, chỉ mới có 1 ngày thực tế (18/09), nhưng hệ thống vẫn thực hiện so sánh hành khách 1 ngày của tuần tới với 7 ngày của tuần này, sinh ra con số chênh lệch sai lệch nghiêm trọng (-86,2% hành khách).

## 2. Các thay đổi đã thực hiện & kiểm thử
1. **`app/supabase/functions/_shared/trafficHtmlReportContract.ts`:**
   - Sửa hàm `compareHtmlMetrics`: Cho phép tính và hiển thị so sánh Chuyến bay và Hành khách (với cờ `provisional: true` khi độ phủ chưa đạt 100%), không còn trả về null/bị chặn.
2. **`app/supabase/functions/_shared/trafficHtmlMonthlyRuntime.ts`:**
   - Thay thế nhãn `Chưa đủ khách` bằng huy hiệu độ phủ thực tế (ví dụ `Độ phủ 99.9%`).
   - Tự động đếm chính xác số ngày đã qua (`18 ngày`) từ dòng `timeline` để tính bình quân khách/ngày cho tháng đang diễn ra.
   - Bổ sung footnote giải thích rõ ràng cơ chế tính toán và đối chiếu.
3. **`app/supabase/functions/_shared/trafficHtmlReportRuntime.ts`:**
   - Bổ sung `isFuturePax`: Chặn so sánh hành khách tuần tương lai chưa diễn ra (trả về dấu `—`), giữ nguyên đối chiếu chuyến bay theo lịch dự kiến (`+40 chuyến, +4,7%`).
   - Nhận xét tự động ghi rõ: *"Tổng khách: tuần kế tiếp có lịch bay tương lai, chưa thực hiện."*
4. **`app/src/lib/trafficHtmlReport.test.ts`:**
   - Cập nhật test contract bảo đảm 100% pass với logic provisional pax và suppressed future pax.

## 3. Nhật ký triển khai Production (100.91.158.79)
- **Phương thức kết nối:** SSH Paramiko qua `100.91.158.79`, người dùng `ops` với mật khẩu xác thực sudo.
- **Thư mục phát hành Edge Functions:**
  `/srv/seasonal-traffic-report/functions/20260919T065000Z-pax-comparison-fix`
- **Kiểm soát tính toàn vẹn (SHA-256):**
  - `trafficHtmlReportContract.ts`: `8110b19bea34f0f123cc8f907d5b71e485a442d51409635099da85672dc28023` (Trùng khớp 100%)
  - `trafficHtmlMonthlyRuntime.ts`: `7407b67a7624760b6375fc87f29c8a396ec3fb6d1f7506f936a3879fceb7b503` (Trùng khớp 100%)
  - `trafficHtmlReportRuntime.ts`: `8ed2d7418583dd886ae9041eacdd271b7b55355539b6ca3c70ba96f7a1f44322` (Trùng khớp 100%)
- **Sao lưu & Chuyển dịch Volume:**
  - Sao lưu: `/srv/seasonal-traffic-report/infra/docker-compose.yml.bak-20260919-paxfix`
  - Cập nhật mount: `/srv/seasonal-traffic-report/functions/20260919T065000Z-pax-comparison-fix:/home/deno/functions:ro`
  - Tái khởi động: `docker compose up -d traffic-report-edge`
- **Kết quả nghiệm thu trực tiếp:**
  - `opsdata-traffic-report-edge`: Up (healthy), không có exception trong logs.
  - Endpoint `v2/html-export` (Báo cáo tháng T9/2026): HTTP 200 OK, tệp kích thước 1.95 MB.
  - Endpoint `v2/html-export` (Báo cáo tuần 11-17/09): HTTP 200 OK, tệp kích thước 851 KB.
  - Headless Browser xác thực: Bảng số liệu hiển thị đầy đủ, không bị chặn số, bình quân chia đúng 18 ngày, tuần kế tiếp chặn số khách tương lai thành công.
