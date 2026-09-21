# Production Release Receipt: KPI Wallboard 2-Column Redesign & Full Surface Parity

- **Date:** 2026-09-21T09:25:00Z (16:25 GMT+7)
- **Host:** `100.91.158.79`
- **Operator:** `ops` via Paramiko SSH
- **Release Directory:** `/srv/seasonal-traffic-report/releases/20260921T024500Z-kpi-wallboard-2-column`
- **Active Symlink:** `/srv/seasonal-traffic-report/current -> /srv/seasonal-traffic-report/releases/20260921T024500Z-kpi-wallboard-2-column`
- **Staging Symlink:** `/srv/seasonal-traffic-report/staging-current -> /srv/seasonal-traffic-report/releases/20260921T024500Z-kpi-wallboard-2-column`
- **Git Commit:**
  - Branch `codex/web-traffic-report`: `92909b5`
  - Branch `main`: `c528b9e`

---

## 1. Scope of Changes

1. **KPI Wallboard 2-Column Redesign (`/reports/traffic/dashboard?view=wallboard`):**
   - Chuyển đổi từ bố cục dọc xếp tầng sang kiến trúc 2 cột bất đối xứng tối ưu cho màn hình $1920 \times 1080$ cố định (Tỷ lệ 16:9).
   - **Cột trái (42%):** Khối điều hành & tiến độ gồm Hero panel (Mục tiêu hôm nay, thanh tiến độ ngang), Status panel (Vòng tròn tỷ lệ hoàn thành donut, Khách đến / Khách đi), và các thẻ chỉ số phụ (Ngày còn lại, Trung bình thực tế/ngày, Dự báo cuối năm).
   - **Cột phải (58%):** Biểu đồ xu hướng tích lũy toàn màn hình với 3 đường dữ liệu (Thực tế lũy kế, Dự báo cuối năm, Tiến độ cần đạt KPI), vạch chia phân tách quá khứ / tương lai, và hệ thống nhãn so le không đè chữ.
   - Sử dụng `ResizeObserver` đo đạc kích thước thực tế truyền dạng số nguyên cho `<LineChart>` trên wallboard, khắc phục triệt để hiện tượng Recharts bị trắng (0x0) khi lồng trong Grid/Flexbox.
   - Đảm bảo Zero-scroll (`scrollHeight = 1080 <= 1080`) và Zero-clipping (`isOverflowing: false` trên toàn bộ 100% các khối con).

2. **Bảo tồn toàn vẹn các hệ khác và các tính năng đã phát hành:**
   - **Trang Báo cáo sản lượng (`/reports/traffic`):** Duy trì 100% các tính năng của đợt phát hành 20/09 (Phân loại chuyến bay nhị phân `Thường lệ` / `Không thường lệ`, nhãn đội tàu `Small - code C` / `Big - code D, E`, container 1400px, bộ lọc chuyển đổi không làm mất read version).
   - **Hệ thống Desktop Seasonal Management:** Không bị ảnh hưởng; các tệp nghiệp vụ seasonal / pairing được cách ly hoàn toàn, không đưa vào commit của đợt release này.
   - **Database & Edge Functions:** Không chạy migration mới, không sửa Edge functions, bảo tồn các quyền `service_role` và các API contract hiện hành.

---

## 2. Verification Evidence

1. **Đo đạc DOM thực tế trên Live Production (`https://report.ahtops.xyz/reports/traffic/dashboard?view=wallboard` - 1920x1080):**
   ```json
   {
     "viewport": { "innerWidth": 1920, "innerHeight": 1080 },
     "doc": { "scrollWidth": 1920, "scrollHeight": 1080 },
     "hasVerticalScroll": false,
     "hasHorizontalScroll": false,
     "shell": { "width": 1920, "height": 1080, "isOverflowing": false },
     "colLeft": { "width": 766, "height": 1031, "isOverflowing": false },
     "colRight": { "width": 1058, "height": 1031, "isOverflowing": false },
     "heroPanel": { "width": 766, "height": 318, "scrollHeight": 316, "clientHeight": 316, "isOverflowing": false },
     "statusPanel": { "width": 766, "height": 365, "scrollHeight": 363, "clientHeight": 363, "isOverflowing": false },
     "chartPanel": { "width": 1058, "height": 1031, "scrollHeight": 1029, "clientHeight": 1029, "isOverflowing": false },
     "chartHasSvg": true,
     "chartLinesCount": 3
   }
   ```

2. **Kiểm tra tính năng trang Báo cáo sản lượng (`https://report.ahtops.xyz/reports/traffic`):**
   - `Includes Thường lệ`: `true`
   - `Includes Không thường lệ`: `true`
   - `Includes Small - code C`: `true`
   - `Includes Big - code D, E`: `true`

3. **Kiểm tra HTTP Headers & APIs trên Server:**
   - `GET /reports/traffic/dashboard`: HTTP 200 OK
   - `GET /reports/traffic`: HTTP 200 OK
   - `GET /api/report/v1/annual-kpi?year=2026`: HTTP 200 OK (JSON hợp lệ)
   - `GET /api/report/v2/overview`: HTTP 200 OK (JSON hợp lệ)
