# Production: HTML theo mẫu và thao tác tại bảng

Hoàn tất lúc 08:54 ngày 06/09/2026 (Asia/Ho_Chi_Minh), theo yêu cầu triển khai production của người dùng.

## Phạm vi đã phát hành

- Báo cáo tuần, tổng quan tháng, phân tích theo kỳ và BaoCaoSanLuong dạng HTML offline. Chọn kỳ tại modal, công cụ mở/thu gọn tại từng bảng, mặc định nhóm theo tổng chuyến Đến + Đi giảm dần; bảng thời gian giữ trình tự ngày/tháng.
- Giao diện report-only, Edge và hai migration additive 20260905180000_public_traffic_html_export.sql, 20260906120000_public_traffic_html_pivot_v2.sql. Chỉ thêm hàm HTML; không đổi schema bảng nghiệp vụ, canonical source, MV, template manifest hoặc công thức dashboard/Excel.
- Nginx: HTML có no-store, timeout riêng và zone traffic_report_html_per_ip 6r/m, burst 2; không dùng chung quota với truy vấn biểu đồ. Cấu hình staging trong repository đã đồng bộ, dịch vụ staging trên máy chủ không thay đổi.

## Phiên bản và khôi phục

- Release: 20260906T013000Z-html-reference-pivot.
- Static: /srv/seasonal-traffic-report/releases/20260906T013000Z-html-reference-pivot.
- Edge: /srv/seasonal-traffic-report/functions/20260906T013000Z-html-reference-pivot.
- Previous: 20260905T051741Z-monthly-trend-top10-weekday.
- Backup root-only: /srv/seasonal-traffic-report/backups/20260906T013000Z-html-reference-pivot, gồm full database dump, compose, edge.env và Nginx cũ. Không đưa thông tin bí mật vào repository.
- SHA-256 database dump: 6d1e07feb4a6252591935eacf8366b4f29c0a48d81485367bf7283ee1816c47d.
- SHA-256 static archive: 38fb83894cd1f2b9e62613ab421324e250a91348df95e118512aa1c24b3644b0.
- SHA-256 functions archive: 5ab06a8f7c5672e7c143dcea6db9719160b0be895db6280a289756d9903dd977.
- SHA-256 Nginx cuối: a064ae9caf9087f2140683a7fdab3513c3b49e94e3dec6b9a3a945e2509805f7.

Rollback ứng dụng: khôi phục compose/edge.env/Nginx từ backup, đưa symlink current về previous, chạy lại riêng traffic-report-edge, nginx -t rồi reload. Giữ các hàm HTML additive ở DB khi rollback ứng dụng; không restore toàn bộ DB lên production cho một lỗi giao diện. Full dump đã được khôi phục thành công vào DB thử riêng và đối chiếu 67.114 dòng snapshot, watermark 50.933.

## Kiểm chứng

- Build report-only 52 file; HTML model/SQL/Edge, regression report/Excel/dashboard, browser pivot/tuần/tháng/offline đã đạt. Thêm regression riêng cho quota HTML không chia sẻ với biểu đồ.
- Clone và production: đối soát bốn báo cáo tại cùng data_as_of=2026-09-06T01:30:00Z, watermark 50933, các chiều all/A/D. Chuyến, khách đã ghi nhận, số leg báo khách, due/missing và true-zero khớp get_public_traffic_report_v2; validator kiểm tra thêm từng resource, theo ngày và nhóm. Giữ NULL khác 0.
- Canary: tuần 0,95s; tháng 2,00s; theo kỳ gần chín tháng 9,63s; Bao 7,74s. Đây là từng lượt đo, không phải thống kê p95 hoặc kiểm thử tải nhiều người.
- Public: tải tuần trực tiếp từ modal, mở file offline, kiểm tra thứ tự giảm dần, nút tại bảng, không còn input chọn kỳ, sáu chỉ tiêu tuần; không có lỗi JavaScript.
- Public tải tháng 200 (3,185s), theo kỳ 200 (9,993s), Bao 200 (8,515s). Excel tuần 200, ZIP/Open XML có 31 phần; không thay thế nghiệm thu mở Excel Desktop.
- Dashboard publication vẫn annual-passenger-publication-v2 và nội dung before/after bằng nhau. Production source watermark vẫn 50933, snapshot fresh, 67.114 dòng. RPC HTML v2 execute: anon=false, authenticated=false, service_role=true.
- Dịch vụ canary và DB clone html_release_20260906 đã dọn; giữ full backup và các release cũ để khôi phục.

## Sự cố đã xử lý trong rollout

1. Kiểm tra archive bằng pipeline gặp SIGPIPE vì pg_restore --list không đọc hết luồng. Dump không hỏng; chuyển sang kiểm tra/restore trực tiếp file archive, khôi phục clone đạt.
2. Health check ban đầu gặp connection reset trong lúc Edge vừa khởi động, kích hoạt rollback trước khi đổi static. Bổ sung retry có giới hạn cho bước chờ sẵn sàng; chuyển lại đạt.
3. Public export ban đầu trả 429 vì dùng chung zone biểu đồ nhưng burst nhỏ hơn. Tách quota HTML riêng, kiểm tra Nginx và phát hành lại cấu hình; lượt tải trực tiếp từ modal đã đạt sau sửa.

Bằng chứng local: app/tmp/production-html-20260906/ gồm public-verification.json, production-reconcile.jsonl.receipt.json, canary.txt, cutover-retry.txt, final-state.txt, file HTML thật và ảnh chụp. Dữ liệu tổng hợp trong bằng chứng không phải fixture và không được phát hành như static demo.
