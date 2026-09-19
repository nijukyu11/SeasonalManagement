# Biên bản phát hành Production: Nâng cấp UI/UX Báo cáo Sản lượng (1400px, In-Card Toggles, Trend Comparison)

**Thời gian hoàn tất:** 09:45 ngày 19/09/2026 (Asia/Ho_Chi_Minh) / 02:45 UTC  
**Phạm vi:** Static release của trang báo cáo công khai (`/reports/traffic` và `/reports/traffic/dashboard`). Không thay đổi database, materialized view hay Edge Function (`20260917T063000Z-compact-header-ux` giữ nguyên).

---

### 1. Thông tin phiên bản & Release Lineage

| Mục | Chi tiết |
| :--- | :--- |
| **Release ID** | `20260919T024500Z-ui-ux-enhancements` |
| **Đường dẫn trên máy chủ** | `/srv/seasonal-traffic-report/releases/20260919T024500Z-ui-ux-enhancements` |
| **Con trỏ `current`** | `-> /srv/seasonal-traffic-report/releases/20260919T024500Z-ui-ux-enhancements` |
| **Con trỏ `staging-current`** | `-> /srv/seasonal-traffic-report/releases/20260919T024500Z-ui-ux-enhancements` |
| **Mã nguồn Git** | Commit `a26278a` trên nhánh `codex/web-traffic-report` (worktree `SeasonalManagement-web-traffic-report`) |
| **traffic.html SHA-256** | `c0fac9636b0b261cec17f45c9f1af37e23987b5d598ce50ef821890e2d55f944` (khớp byte-exact giữa local và server) |
| **Số tệp artifact** | 50 tệp tĩnh tạo bởi Turbopack Next.js export (`out-report`) |
| **Release nền tảng** | Carry-forward đầy đủ chunks từ `20260912T062757Z-compact-sticky-bar` để bảo toàn cache browser cũ |

---

### 2. Các thay đổi giao diện đã phát hành

1. **Mở rộng container tổng lên `1400px`:**
   - Đồng bộ lớp `max-w-[1400px]` tại `TrafficReportFilters.tsx` (sticky bar), `TrafficReportClient.tsx` (main div), `WebReportShell.tsx` (header/footer) và `page.tsx`.
   - Tăng thêm $120\text{px}$ không gian hiển thị trên màn hình Desktop mà không gây tràn ngang trên màn hình chuẩn $1440 \times 900$.
2. **Cụm Vận hành — In-Card View Toggle:**
   - `PeakHourChart` (24 khung giờ): Bổ sung nút chuyển `[ Biểu đồ 24h ] | [ Ma trận nhiệt ]`. Ma trận nhiệt được co gọn bề ngang từ $1540\text{px}$ về $1216\text{px}$ để nằm vừa vặn trong card.
   - `DayOfWeekChart` (Mẫu khai thác theo tuần): Bổ sung nút chuyển `[ Chu kỳ 7 Thứ ] | [ Ma trận nhiệt ]`.
3. **Biểu đồ xu hướng chuỗi ngày dài (`TrafficReportTrend.tsx`):**
   - Bộ chọn độ phân giải: `[ Tự động ] | [ Theo ngày ] | [ Theo tháng ]`, cho phép xem chi tiết từng ngày kể cả kỳ dài $4 - 7$ tháng.
   - Vạch phân cách tháng (Vertical Month Gridlines) trên trục X kèm nhãn tháng.
   - Dải hover toàn chiều cao cột và mốc trục hoành căn đầu tháng.
   - Đường đối chiếu so sánh nét đứt (Comparison Reference Line) màu hổ phách với lớp SVG text halo bảo vệ chữ và badge độ lệch trong tooltip.
4. **Nhúng Micro-insights vào thẻ KPI & Tái cấu trúc luồng đọc:**
   - Nhúng trực tiếp các dòng nhận định ngày/giờ cao điểm vào chân 3 thẻ KPI (Tổng / Đến / Đi).
   - Tinh gọn khối nhận xét thị trường thành 1 dòng xúc tích.
   - Đưa cụm `#operations-section` lên ngay sau Biểu đồ xu hướng, trước các bảng chi tiết Thị trường và Hãng bay.
5. **Chống cắt cụt nhãn chú giải Donut Chart:**
   - Áp dụng `break-words text-pretty` tại `TrafficDimensionShareDonut.tsx` và `TrafficReportDimensionSection.tsx`.

---

### 3. Bằng chứng nghiệm thu thực tế (Live Verification Evidence)

#### 3.1 Kiểm thử cục bộ trước khi phát hành
- `npm run test:traffic-report-contract`: **55/55 tests passed** (17 contract tests + 32 presentation/source tests + 7 operational hours tests).
- `npm run build:traffic-report`: Turbopack compile thành công 0 lỗi TypeScript, 50 tệp artifact tại `app/out-report`.

#### 3.2 Kiểm thử ingress & máy chủ Nginx
- Cấu hình Nginx (`nginx -t`): **syntax is ok, test is successful**.
- Nginx reload thành công không downtime.
- Ingress công khai:
  - `GET https://report.ahtops.xyz/healthz`: **HTTP 200 ok**.
  - `GET https://report.ahtops.xyz/reports/traffic`: **HTTP 200** (chứa `max-w-[1400px]`).
  - `GET https://report.ahtops.xyz/reports/traffic/dashboard`: **HTTP 200** (KPI năm 2026, 0 lỗi banner).

#### 3.3 Kiểm thử tự động trên trình duyệt thật (Chromium 1440 × 900) tải từ Production
```json
{
  "innerWidth": 1440,
  "scrollWidth": 1440,
  "hasOverflow": false,
  "stickyWidth": 1440,
  "kpiCount": 3,
  "kpiInsights": [true, true, true],
  "opsBeforeMarket": true,
  "marketBeforeAirline": true,
  "hasHeatmapToggle": true,
  "hasGranularityButtons": true
}
```
- Không có hiện tượng tràn ngang màn hình (`hasOverflow: false`).
- Cả 3 thẻ KPI đều hiển thị dòng `Điểm tin:`.
- Cụm vận hành nằm trước thị trường và hãng bay.
- Cụm nút toggle ma trận nhiệt và độ phân giải hiển thị và phản hồi chuẩn xác.

---

### 4. Phương án Rollback tức thì (khi cần)

Release cũ `20260912T062757Z-compact-sticky-bar` vẫn được lưu trữ nguyên vẹn trên máy chủ. Lệnh rollback:

```bash
echo admin | sudo -S ln -sfn /srv/seasonal-traffic-report/releases/20260912T062757Z-compact-sticky-bar /srv/seasonal-traffic-report/current
echo admin | sudo -S nginx -t && echo admin | sudo -S systemctl reload nginx
```
