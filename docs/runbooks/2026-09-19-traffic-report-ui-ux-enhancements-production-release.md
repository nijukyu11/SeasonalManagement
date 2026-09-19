# Biên bản phát hành Production: Nâng cấp UI/UX Báo cáo Sản lượng & Khôi phục nút Xuất Báo cáo HTML Offline

**Thời gian hoàn tất:** 09:50 ngày 19/09/2026 (Asia/Ho_Chi_Minh) / 02:50 UTC  
**Phạm vi:** Static release của trang báo cáo công khai (`/reports/traffic` và `/reports/traffic/dashboard`). Không thay đổi database, materialized view hay Edge Function (`20260917T063000Z-compact-header-ux` giữ nguyên).

---

### 1. Thông tin phiên bản & Release Lineage

| Mục | Chi tiết |
| :--- | :--- |
| **Release ID** | `20260919T031500Z-ui-ux-with-html-export` |
| **Đường dẫn trên máy chủ** | `/srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export` |
| **Con trỏ `current`** | `-> /srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export` |
| **Con trỏ `staging-current`** | `-> /srv/seasonal-traffic-report/releases/20260919T031500Z-ui-ux-with-html-export` |
| **Mã nguồn Git** | Commit `a3fc749` trên nhánh `codex/web-traffic-report` (worktree `SeasonalManagement-web-traffic-report`) |
| **Release nền tảng** | Carry-forward đầy đủ chunks từ `20260912T062757Z-compact-sticky-bar` để bảo toàn cache browser cũ |

---

### 2. Nguyên nhân nút "Xuất báo cáo" bị ẩn và biện pháp xử lý triệt để

1. **Nguyên nhân gốc rễ (Root Cause):**
   - Tại `TrafficReportClient.tsx:35`: `const workbookExportEnabled = process.env.NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED === 'true';`.
   - Tại `TrafficWorkbookExportDialog.tsx:27`: `const htmlEnabled = process.env.NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED === 'true';`.
   - Script build tĩnh `build-traffic-report-only.mjs` trước đó chỉ kế thừa `process.env` môi trường máy trạm mà không thiết lập mặc định các cờ production này. Do đó, Next.js Turbopack đã compile `workbookExportEnabled` thành `false`, dẫn tới nút `Xuất báo cáo` và hộp thoại tải file HTML bị render thành `null`.
2. **Biện pháp khắc phục vĩnh viễn:**
   - Đã sửa `build-traffic-report-only.mjs`: thiết lập mặc định `true` cho:
     - `NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED: process.env.NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED ?? 'true'`
     - `NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED: process.env.NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED ?? 'true'`
     - `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION: process.env.NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION ?? 'true'`
   - Nhờ vậy, mọi lần chạy `npm run build:traffic-report` đều tự động kích hoạt đầy đủ nút Xuất báo cáo và định dạng HTML offline mà không phụ thuộc vào biến môi trường thủ công.

---

### 3. Các thay đổi giao diện đã phát hành

1. **Khôi phục hoàn toàn Hộp thoại Xuất Báo cáo HTML Offline:**
   - Nút **"Xuất báo cáo"** hiển thị nổi bật tại chân trang báo cáo (trên khối Ghi chú dữ liệu).
   - Hộp thoại tải báo cáo cung cấp định dạng **`HTML offline (.html)`** cho cả 5 mẫu báo cáo:
     - *Workbook tổng hợp khai thác*
     - *Tổng quan khai thác tháng - Mức 2*
     - *Báo cáo tuần chi tiết*
     - *Phân tích theo kỳ*
     - *Báo cáo sản lượng theo mẫu (BaoCaoSanLuong)*
2. **Mở rộng container tổng lên `1400px`:**
   - Đồng bộ lớp `max-w-[1400px]` tại `TrafficReportFilters.tsx` (sticky bar), `TrafficReportClient.tsx` (main div), `WebReportShell.tsx` (header/footer) và `page.tsx`.
   - Tăng thêm $120\text{px}$ không gian hiển thị trên màn hình Desktop mà không gây tràn ngang trên màn hình chuẩn $1440 \times 900$.
3. **Cụm Vận hành — In-Card View Toggle:**
   - `PeakHourChart` (24 khung giờ): Bổ sung nút chuyển `[ Biểu đồ 24h ] | [ Ma trận nhiệt ]`. Ma trận nhiệt được co gọn bề ngang từ $1540\text{px}$ về $1216\text{px}$ để nằm vừa vặn trong card.
   - `DayOfWeekChart` (Mẫu khai thác theo tuần): Bổ sung nút chuyển `[ Chu kỳ 7 Thứ ] | [ Ma trận nhiệt ]`.
4. **Biểu đồ xu hướng chuỗi ngày dài (`TrafficReportTrend.tsx`):**
   - Bộ chọn độ phân giải: `[ Tự động ] | [ Theo ngày ] | [ Theo tháng ]`.
   - Vạch phân cách tháng (Vertical Month Gridlines) trên trục X kèm nhãn tháng.
   - Dải hover toàn chiều cao cột và mốc trục hoành căn đầu tháng.
   - Đường đối chiếu so sánh nét đứt (Comparison Reference Line) màu hổ phách với lớp SVG text halo bảo vệ chữ và badge độ lệch trong tooltip.
5. **Nhúng Micro-insights vào thẻ KPI & Tái cấu trúc luồng đọc:**
   - Nhúng trực tiếp các dòng nhận định ngày/giờ cao điểm vào chân 3 thẻ KPI (Tổng / Đến / Đi).
   - Tinh gọn khối nhận xét thị trường thành 1 dòng xúc tích.
   - Đưa cụm `#operations-section` lên ngay sau Biểu đồ xu hướng, trước các bảng chi tiết Thị trường và Hãng bay.
6. **Chống cắt cụt nhãn chú giải Donut Chart:**
   - Áp dụng `break-words text-pretty` tại `TrafficDimensionShareDonut.tsx` và `TrafficReportDimensionSection.tsx`.

---

### 4. Bằng chứng nghiệm thu thực tế trên Production Live (`https://report.ahtops.xyz`)

#### Kiểm thử tự động trên trình duyệt thật (Chromium 1440 × 900) tải từ Production
```json
{
  "foundButton": true,
  "isOpen": true,
  "dialogTitle": "Xuất báo cáo",
  "formatOptions": ["HTML offline (.html)"],
  "reportTypes": [
    "Workbook tổng hợp khai thác",
    "Tổng quan khai thác tháng - Mức 2",
    "Báo cáo tuần chi tiết",
    "Phân tích theo kỳ",
    "Báo cáo sản lượng theo mẫu"
  ],
  "innerWidth": 1440,
  "scrollWidth": 1440,
  "hasOverflow": false,
  "kpiInsights": [true, true, true],
  "opsBeforeMarket": true,
  "marketBeforeAirline": true,
  "hasHeatmapToggle": true,
  "hasGranularityButtons": true
}
```

- Nút **"Xuất báo cáo"** đã xuất hiện và click mở hộp thoại modal thành công (`foundButton: true`, `isOpen: true`).
- Định dạng xuất **`HTML offline (.html)`** đã sẵn sàng hoạt động.
- Không có hiện tượng tràn ngang màn hình (`hasOverflow: false`).
- Cả 3 thẻ KPI đều hiển thị dòng `Điểm tin:`.
- Cụm vận hành nằm trước thị trường và hãng bay.
- Cụm nút toggle ma trận nhiệt và độ phân giải hiển thị và phản hồi chuẩn xác.

---

### 5. Phương án Rollback tức thì (khi cần)

Release cũ `20260912T062757Z-compact-sticky-bar` vẫn được lưu trữ nguyên vẹn trên máy chủ. Lệnh rollback:

```bash
echo admin | sudo -S ln -sfn /srv/seasonal-traffic-report/releases/20260912T062757Z-compact-sticky-bar /srv/seasonal-traffic-report/current
echo admin | sudo -S nginx -t && echo admin | sudo -S systemctl reload nginx
```
