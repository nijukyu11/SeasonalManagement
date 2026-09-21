# Kế hoạch triển khai — Tái cấu trúc Giao diện KPI Wallboard 24/7 theo Bố cục 2 Cột (Phương án A)

**Ngày:** 2026-09-21  
**Mục tiêu:** Tối ưu hóa giao diện Dashboard KPI sản lượng khách năm (`/reports/traffic/dashboard`) trên màn hình cố định **$1920 \times 1080$ không tương tác** theo **Phương án A (Bố cục 2 cột dọc Side-by-Side Command View)**.  
**Nguyên tắc bất biến:** **Giữ nguyên 100% các thông tin, chỉ số và chuỗi văn bản (copy) hiện hữu**, không thêm thông tin mới, không kéo dữ liệu live vào publication wallboard. Chỉ thay đổi kiến trúc bố cục, tỷ lệ không gian, kiểu chữ và xử lý triệt để các lỗi thị giác (lệch số, đè nhãn, nhiễu chấm đồ thị).

---

## 1. Ranh giới & Ràng buộc cốt lõi (Invariants)

1. **Bảo tồn toàn bộ thông tin và câu chữ hiện hữu:**
   * **Header:** Tiêu đề `KPI sản lượng khách năm {year}`, metadata `Ngày số liệu {business_date} · Cập nhật lúc {refreshed_at}`, badge `Dữ liệu mới nhất` / `Bản cập nhật gần nhất`.
   * **Hero Panel:** Tag `Năm dương lịch`, `Đến hết {period_to}`, câu thông điệp chính (`hero-message`), câu ghi chú `hero-note` (`Còn thiếu ... khách để đạt KPI năm` / `Đã đạt ...`), giá trị tiến độ `Đã đạt / KPI năm: {reported} / {target}`, thanh tiến độ `ProgressBar`.
   * **Status Panel:** `Đánh giá tiến độ`, icon trạng thái + tên trạng thái (`Đang đúng tiến độ`, `Có rủi ro`, ...), vòng tròn `CompletionRing`, khối `Khách đến` (`arrival_reported_pax`), khối `Khách đi` (`departure_reported_pax`).
   * **3 Thẻ Metrics:**
     * Thẻ 1: `Ngày còn lại` + note (`Tính từ hôm nay đến 31/12` / `Chưa bắt đầu kỳ KPI` / `Kỳ KPI đã kết thúc`).
     * Thẻ 2: `Trung bình thực tế / ngày` + note (`{elapsed_days} ngày đã hoàn tất`).
     * Thẻ 3: `Dự báo cuối năm` + note (`Theo TB {window} ngày gần nhất...`).
   * **Biểu đồ xu hướng:** `Xu hướng tích lũy`, `Sản lượng khách so với tiến độ KPI`, badge `Dự báo {gap}%`, Legend (`Đã đạt`, `Tiến độ cần đạt`, `Dự báo luỹ kế năm`), đường dóng dọc `Ngày số liệu mới nhất: {period_to}`.
2. **Khắc phục 3 lỗi hiển thị cốt lõi:**
   * **Đồng nhất tỷ lệ %:** Sửa vòng tròn `CompletionRing` từ `Math.round(percent)` thành `displayDecimal(percent, '%')` (ví dụ `73,6%`), đồng bộ $100\%$ với số cạnh thanh progress bar.
   * **Chống đè nhãn cuối năm:** Thiết kế cụm nhãn cuối năm (KPI & Dự báo tại ngày 31/12) với cơ chế neo tách biệt (collision-free endpoint badge), không đè chữ lên nhau khi giá trị gần kề.
   * **Loại bỏ nhiễu trục X:** Bỏ hoàn toàn 365 chấm `<DayDot />` li ti dưới đáy trục X. Giữ 12 mốc tháng (T1 đến T12) lớn, rõ ràng.
3. **Màn hình cố định $1920 \times 1080$, không tương tác (Zero-scroll, Non-interactive):**
   * Giữ trọn vẹn trong `100dvh` (1080px), không phát sinh thanh cuộn (`overflow: hidden`).
   * Cỡ chữ, độ dày nét vẽ (stroke width) và độ tương phản màu sắc được tối ưu cho tầm nhìn từ xa $2\text{m} - 5\text{m}$.

---

## 2. Cấu trúc bố cục đích (Target Architecture — Option A)

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ HEADER (h-11): Tiêu đề KPI năm          Ngày số liệu · Cập nhật lúc ...    ● Dữ liệu mới nhất    │
├──────────────────────────────────────┬───────────────────────────────────────────────────────────┤
│ CỘT TRÁI: ĐIỀU HÀNH & TIẾN ĐỘ (~42%)  │ CỘT PHẢI: BIỂU ĐỒ XU HƯỚNG TÍCH LŨY (~58%)                │
│ (flex col gap-3 justify-between)     │ (h-full flex col)                                         │
│                                      │                                                           │
│ ┌──────────────────────────────────┐ │ ┌───────────────────────────────────────────────────────┐ │
│ │ 1. KHỐI HERO (Tiến độ trọng tâm) │ │ │ XU HƯỚNG TÍCH LŨY                    [↗ Dự báo +0,6%] │ │
│ │  • Tag Năm dương lịch · Đến hết..│ │ │ Sản lượng khách so với tiến độ KPI                    │ │
│ │  • Thông điệp chính              │ │ │                                                       │ │
│ │  • Ghi chú (Còn thiếu.../Đã đạt) │ │ │  8M ┤                               ┌─ Dự báo 7,53M   │ │
│ │  • Đã đạt / KPI năm: ... / ...   │ │ │     │                    .·--··''   └─ KPI 7,49M      │ │
│ │  • [Thanh Progress Bar]   73,6%  │ │ │  6M ┤             ..·--''  (18/09)                    │ │
│ └──────────────────────────────────┘ │ │     │       .·--''          ● Đã đạt 5,51M            │ │
│                                      │ │  4M ┤  .·--'                                          │ │
│ ┌──────────────────────────────────┐ │ │     │.'                                               │ │
│ │ 2. KHỐI STATUS (Cơ cấu & Trạng   │ │ │  2M ┤'                                                │ │
│ │    thái)                         │ │ │     │                                                 │ │
│ │  • Đánh giá tiến độ + Icon status│ │ │  0M └──────┬──────┬──────┬──────┬──────┬──────┬────── │ │
│ │  • Vòng tròn hoàn thành: 73,6%   │ │ │           T2     T4     T6     T8    T10    T12       │ │
│ │  • Khách đến: ...                │ │ │     ══ Đã đạt   --- Tiến độ KPI   -- Dự báo luỹ kế    │ │
│ │  • Khách đi:  ...                │ │ └───────────────────────────────────────────────────────┘ │
│ └──────────────────────────────────┘ │                                                           │
│                                      │                                                           │
│ ┌──────────────────────────────────┐ │                                                           │
│ │ 3. KHỐI METRICS BỔ TRỢ (Grid)    │ │                                                           │
│ │  ┌──────────────┬──────────────┐ │ │                                                           │
│ │  │ Ngày còn lại │ TB thực tế   │ │ │                                                           │
│ │  │ (kèm note)   │ (kèm note)   │ │ │                                                           │
│ │  ├──────────────┴──────────────┤ │ │                                                           │
│ │  │ Dự báo cuối năm (kèm note)  │ │ │                                                           │
│ │  └─────────────────────────────┘ │ │                                                           │
│ └──────────────────────────────────┘ │                                                           │
└──────────────────────────────────────┴───────────────────────────────────────────────────────────┘
```

---

## 3. Danh sách tệp tác động (Files to Touch)

### Sửa đổi (Modify):
1. `app/src/app/(public-report)/reports/traffic/dashboard/AnnualPassengerKpiDashboard.tsx`:
   * Chỉnh sửa cấu trúc JSX sang 2 cột cho chế độ wallboard.
   * Chuẩn hóa hiển thị tỷ lệ % tại `CompletionRing` thành 1 chữ số thập phân (`displayDecimal(percent, '%')`).
   * Tinh chỉnh `TrendChart`: loại bỏ `DayDot`, cấu hình cụm nhãn cuối năm (`ReferenceDot` / `Label` offset an toàn), tối ưu vị trí nhãn ngày số liệu mới nhất.
2. `app/src/app/(public-report)/report.css`:
   * Cập nhật media query `@media (min-width: 1280px) and (min-height: 720px)` cho `.kpi-dashboard.kpi-wallboard`.
   * Thiết lập hệ lưới 2 cột: `grid-template-columns: minmax(0, 42fr) minmax(0, 58fr)`.
   * Điều chỉnh chiều cao, khoảng cách (gap), padding và kích thước chữ (typography) đảm bảo vừa khít $100\text{dvh}$ không tràn trang trên $1920 \times 1080$.
3. `app/src/app/(public-report)/reports/traffic/dashboard/AnnualPassengerKpiDashboard.source.test.ts`:
   * Cập nhật các test case kiểm tra selector CSS và cấu trúc DOM của wallboard để khớp với bố cục 2 cột mới.

---

## 4. Các mốc triển khai chi tiết & Checklist

### Mốc 0 (M0) — Baseline & Khóa an toàn trước khi sửa
- [ ] Chụp trạng thái mã nguồn hiện tại, đảm bảo worktree sạch hoặc nắm rõ các thay đổi ngoài phạm vi.
- [ ] Chạy bộ kiểm thử hiện tại: `node --test app/src/app/(public-report)/reports/traffic/dashboard/AnnualPassengerKpiDashboard.source.test.ts`.
- [ ] Ghi nhận baseline kích thước font chữ, khoảng cách và các chuỗi text hiện có.

### Mốc 1 (M1) — Sửa lỗi hiển thị & Chuẩn hóa định dạng số liệu
- [ ] **Đồng nhất tỷ lệ %:**
  * Sửa `CompletionRing` trong `AnnualPassengerKpiDashboard.tsx` từ `Math.round(percent)` sang `displayDecimal(percent, '%')`.
  * Đảm bảo cả hai vị trí (hero progress bar và completion ring) đều hiển thị chính xác định dạng `XX,X%`.
- [ ] **Dọn sạch trục X biểu đồ:**
  * Xóa bỏ component `DayDot` và trục phụ `xAxisId="days"`.
  * Tối ưu trục X chính: Giữ 12 mốc tháng với font chữ lớn ($\ge 18\text{px}$), đậm nét, dễ đọc từ xa.
- [ ] **Chống đè nhãn cuối năm trên biểu đồ:**
  * Tách biệt tọa độ nhãn của `target` (KPI) và `projection` (Dự báo) tại điểm cuối năm ($X = 365/366$).
  * Khi $|\text{projection} - \text{target}| < 0.2\text{M}$, tự động phân tách offset Y hoặc dùng thẻ tóm tắt mốc cuối năm (Endpoint Summary Tag) có nền trắng, viền rõ để không bị đè chữ.
  * Tinh chỉnh nhãn `ReferenceLine` mốc ngày số liệu mới nhất (`position="insideTopLeft"` hoặc canh lề an toàn tránh đè trục Y).

### Mốc 2 (M2) — Tái cấu trúc DOM sang 2 cột dọc (JSX Layout)
- [ ] Tách `dashboard-shell` của chế độ wallboard thành cấu trúc 2 cột chính:
  * `<div className="wallboard-grid">` chứa `wallboard-col-left` và `wallboard-col-right`.
- [ ] **Cột Trái (`wallboard-col-left`):**
  * Gom Khối 1 (`hero-panel`): Giữ nguyên toàn bộ tags, thông điệp, progress bar và số liệu.
  * Gom Khối 2 (`status-panel`): Giữ nguyên đánh giá tiến độ, icon trạng thái, vòng tròn % và 2 thẻ Khách đến / Khách đi.
  * Gom Khối 3 (`metrics-grid`): Bố trí 3 thẻ metric (`Ngày còn lại`, `Trung bình thực tế / ngày`, `Dự báo cuối năm`) vừa vặn với chiều ngang cột trái.
- [ ] **Cột Phải (`wallboard-col-right`):**
  * Đặt trọn vẹn `chart-panel` và `TrendChart` với chiều cao $100\%$ cột phải.
  * Tận dụng chiều cao lớn để đường cong lũy kế trải dài thanh thoát, thoáng đãng.

### Mốc 3 (M3) — Tối ưu hóa CSS & Typography cho màn hình 1920x1080 (report.css)
- [ ] Cấu hình `.kpi-dashboard.kpi-wallboard`:
  * `height: 100dvh`, `overflow: hidden`.
  * Cột trái: `flex flex-col justify-between gap-3`.
  * Cột phải: `height: 100%`, `display: flex`, `flex-direction: column`.
- [ ] Tinh chỉnh typography theo chuẩn khoảng cách nhìn $2\text{m} - 5\text{m}$:
  * Số Hero (`hero-message`): $40\text{px} - 48\text{px}$, đậm, rõ.
  * Số liệu chính (`hero-progress-value`, `metric-value`, `soft-stat-value`): $32\text{px} - 38\text{px}$.
  * Nhãn phụ & ghi chú: Tối thiểu $15\text{px} - 16\text{px}$, màu `#334155` hoặc `#475569` (độ tương phản cao, không dùng màu xám quá nhạt).
- [ ] Kiểm tra responsive fallback cho các màn hình nhỏ hơn hoặc chế độ standard view (`view=standard`).

### Mốc 4 (M4) — Cập nhật Test Suite & Source Verification
- [ ] Cập nhật file test `AnnualPassengerKpiDashboard.source.test.ts`:
  * Khẳng định giữ nguyên toàn bộ chuỗi text được phê duyệt (`KPI sản lượng khách năm`, `Hôm nay cần phục vụ tối thiểu`, `Năm dương lịch`, `Tính từ hôm nay đến 31/12`, v.v.).
  * Xác nhận selector CSS mới cho bố cục 2 cột.
  * Xác nhận không còn `DayDot` trên Recharts LineChart.
  * Chạy test và đảm bảo 100% test cases pass.

### Mốc 5 (M5) — Kiểm thử trực quan (Visual Verification) trên độ phân giải chuẩn 1920x1080
- [ ] Render thử nghiệm dashboard ở viewport chính xác $1920 \times 1080$.
- [ ] Xác minh:
  * [ ] Không có thanh cuộn ngang hoặc dọc (`scrollWidth === innerWidth`, `scrollHeight === innerHeight`).
  * [ ] Số % ở Hero và Completion Ring khớp nhau hoàn toàn đến từng chữ số thập phân (`73,6%`).
  * [ ] Không có hiện tượng chữ đè chữ tại mốc ngày 31/12 trên biểu đồ.
  * [ ] Toàn bộ các thông điệp, ghi chú, nhãn ngày tháng hiển thị đầy đủ, không bị cắt cụt (`text-overflow`).

---

## 5. Tiêu chí nghiệm thu hoàn thành (Done Criteria)

1. **Bảo tồn thông tin:** Không có bất kỳ chuỗi text hay chỉ số nào bị lược bỏ so với bản gốc.
2. **Khớp độ phân giải:** Vừa khít màn hình $1920 \times 1080$, tuyệt đối không cuộn.
3. **Thẩm mỹ & Rõ ràng:** Cột trái gọn gàng, đường dóng thẳng tắp; Cột phải thoáng đãng, đồ thị trực quan, không va chạm nhãn.
4. **Kiểm thử tự động:** Toàn bộ test suite trong dự án pass 100%.
5. **Kế hoạch này là tài liệu bám sát trước khi thực hiện bất kỳ lệnh code nào.**
```,i: