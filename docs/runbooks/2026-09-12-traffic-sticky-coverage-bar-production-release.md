# Biên bản phát hành Production: Thanh sticky quy mô mạng bay và bố cục rút gọn

**Thời gian hoàn tất:** 13:32 ngày 12/09/2026 (Asia/Ho_Chi_Minh)  
**Phạm vi:** Chỉ static release của trang báo cáo công khai (`/reports/traffic`). Không sửa database, materialized view, Edge Function hay cấu hình Nginx.

---

### 1. Thông tin phiên bản

| Bước | Release ID | `traffic.html` SHA-256 | Số file |
| :--- | :--- | :--- | :--- |
| Thêm thanh sticky + 3 card quy mô, deep-link có offset | `20260912T061518Z-sticky-coverage-bar` | `da0c35ed166c66249cbb9b7ca756051c27e5c54a4059c0b6ac6ddd55eda75216` | 50 |
| Bỏ hero + bố cục rút gọn (đang chạy) | `20260912T062757Z-compact-sticky-bar` | `f4e52ad6f11bbfc279256bc0cc5eca1ae3f44bbd1f27ca20e8f165ca21d3ad37` | 50 |

- **Đường dẫn:** `/srv/seasonal-traffic-report/releases/<Release ID>`; con trỏ `current` → `20260912T062757Z-compact-sticky-bar`.
- **Nguồn build:** working tree nhánh `codex/web-traffic-report` (xem mục 6). **Biên bản này không hàm ý bản build tái lập được từ Git**: tại thời điểm build cây làm việc còn thay đổi chưa commit, không có commit hay tag nào tương ứng với artifact đã phát hành. Thành phần tái lập duy nhất là release bất biến trên máy chủ cùng SHA-256 ở mục 1 (đối soát bằng `sha256sum <release>/reports/traffic.html`).
- **Thành phần không thay đổi:** schema/MV, `reporting.public_traffic_effective`, Edge Function, `edge.env`, `/etc/nginx/conf.d/traffic-report.conf` (`root /srv/seasonal-traffic-report/current`), cache zone.

---

### 2. Thay đổi giao diện

**`app/src/app/(public-report)/reports/traffic/TrafficReportClient.tsx`**
- Xoá toàn bộ `<section>` hero (tiêu đề lớn + dải ngày `from–to`).
- Giữ semantic bằng `<h1 className="sr-only">Báo cáo sản lượng khai thác</h1>` — không hiển thị pixel nào; outline sau khi đổi là `h1 → h2 ("Các chỉ số nổi bật", "Bộ lọc báo cáo", …) → h3 → h4`, không nhảy cấp.

**`app/src/app/(public-report)/reports/traffic/TrafficReportFilters.tsx`**
- Thanh sticky thêm: dải ngày đang xét + số ngày trong kỳ, và 3 card quy mô mạng bay (chặng bay / hãng khai thác / quốc gia) lấy từ `coverage_counts`; mỗi card deep-link tới mục bảng tương ứng.
- Bố cục rút gọn: một hàng `flex-wrap` dùng `order-*` responsive — desktop là **một hàng duy nhất** (ngày · số ngày | 3 card | presets + Bộ lọc), mobile tách 2 hàng (hàng 1: ngày + Bộ lọc; hàng 2: card cuộn ngang). Card thu gọn `min-h-9 → min-h-8`, `text-sm → text-xs`, `rounded-xl → rounded-lg`, padding/gap nhỏ hơn; giữ nguyên nhãn, `title`, `aria-label`.
- Offset deep-link tính động theo chiều cao thanh sticky (`chiều cao thanh + 8`), không còn hằng số cứng.

---

### 3. Nghiệm thu

**Cục bộ (trước khi stage):** `tsc --noEmit` sạch cho vùng report; 32 test report pass (`trafficReportContract.test.ts`, `TrafficReportPresentation.source.test.ts`); build với đúng cờ production (`NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED`, `NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED`, `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION`) tạo artifact 50 file.

**Staging** (`seasonal-traffic-report-staging-tunnel`, origin `staging-current`): `/healthz`, `/reports/traffic`, `/reports/traffic/dashboard` → 200. Đo bằng Chromium thật, cache tắt: thanh sticky 61px ở 1440px và 101px ở 375px, không tràn ngang, offset deep-link lần lượt 69/109px.

**Production** (`https://report.ahtops.xyz`, cache tắt, chờ request settle):

| Hạng mục | Kết quả |
| :--- | :--- |
| Thanh sticky 1440px | 61px, 1 hàng, 3 card inline |
| Thanh sticky 375px / 320px | 101px / 129px, `scrollWidth - innerWidth = 0` |
| Hero | đã xoá; còn đúng 1 `h1` sr-only (1×1, absolute) |
| Deep-link | offset 69px (desktop) / 109px (mobile); bấm card **quốc gia** → `?from=2026-01-01&to=2026-09-11&market_dimension=country` |
| Đồng bộ ngày | URL = `normalized_filter` = số hiển thị trên thanh (`01/01/2026–11/09/2026`, 254 ngày) |
| Hồi quy | biểu đồ giờ cao điểm, nút "Xuất báo cáo" còn nguyên; dashboard `/reports/traffic/dashboard` hiển thị KPI năm, không có banner lỗi |
| HTTP | `/healthz`, `/reports/traffic`, `/reports/traffic.txt`, `/reports/traffic/dashboard` → 200 |

**Kết luận điều tra lệch ngày (đối tượng advisory trước đó):** không phải lỗi sản phẩm. `updateViewState` ghi lại `bundle.metadata.normalized_filter`, nên thanh sticky luôn bằng URL và bằng tham số request; giá trị `to=2026-09-10` quan sát được đến từ một script kiểm thử staging chủ động mở `?to=2026-09-10`, đối chiếu nhầm với lần đọc thanh ở lần chạy khác (dữ liệu cũng vừa tiến 253 → 254 ngày).

---

### 4. Rollback

1. `ln -sfn /srv/seasonal-traffic-report/releases/20260912T061518Z-sticky-coverage-bar /srv/seasonal-traffic-report/current`
2. `nginx -t && systemctl reload nginx`
3. Smoke lại `/reports/traffic` và `/reports/traffic/dashboard`; cả hai release vẫn nằm nguyên trên máy chủ.
4. Không cần đụng database, Edge Function hay cache: thay đổi chỉ ở static artifact.

---

### 5. Trạng thái staging sau phát hành

- `staging-current` → `20260912T062757Z-compact-sticky-bar`; tunnel `seasonal-traffic-report-staging-tunnel.service` đã dừng (`inactive`), URL `trycloudflare` cũ không còn hiệu lực.

---

### 6. Trạng thái Git

- **Chỉ commit duy nhất file biên bản này** (`git add docs/runbooks/2026-09-12-traffic-sticky-coverage-bar-production-release.md`), không stage toàn bộ cây. Commit này là tài liệu vận hành, **không phải** mốc provenance của bản build: repo không chứa nguồn đã dùng để build.
- Mã nguồn đã deploy **chưa commit**: hai file `TrafficReportClient.tsx`, `TrafficReportFilters.tsx` nằm chung working tree với 22 file modified/43 file untracked từ các phiên trước; tách hunk sẽ trộn công việc không liên quan nên giữ nguyên trạng thái, không revert và không commit thay.
- Hệ quả: muốn tái lập đúng bản đang chạy, dùng release bất biến trên máy chủ (`releases/20260912T062757Z-compact-sticky-bar`, SHA-256 ở mục 1) hoặc rollback theo mục 4 — không dùng Git.
