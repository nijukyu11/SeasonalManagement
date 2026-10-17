# Kế hoạch Triển khai Mẫu Báo cáo HTML: Phân tích Biến động & Bất thường (VARIANCE_ANALYSIS)

**Ngày lập:** 2026-09-22  
**Trạng thái:** Kế hoạch chi tiết hoàn chỉnh (Chờ xác nhận để triển khai)  
**Workspace tài liệu & quản lý:** `C:\Users\tuan\Documents\SeasonalManagement`  
**Workspace triển khai mã nguồn:** `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report\app`

---

## 1. Mục tiêu và Phạm vi Kỹ thuật

### 1.1. Mục tiêu nghiệp vụ
1. **So sánh linh hoạt 2 kỳ tự do:** Người dùng được chọn Kỳ A (Kỳ phân tích: `from` – `to`) và Kỳ B (Kỳ đối chiếu: `baseline_from` – `baseline_to`) với độ dài ngày tùy ý.
2. **Bộ chỉ số phân tích biến động động (Dynamic Variance Metrics):** 4 preset chỉ số phục vụ từ lãnh đạo điều hành đến chuyên viên phân tích (Tổng quan, Tăng trưởng & Đóng góp, Hiệu suất tải, Cân đối chiều bay).
3. **Radar cảnh báo bất thường tự động (Anomaly Radar):** Nhận diện tức thì tuyến bay/hãng bay mới, dừng khai thác, đột biến sản lượng vượt ngưỡng, và mất cân đối 2 chiều. Cho phép người dùng tùy chỉnh trực tiếp ngưỡng nhạy ngay trên file offline.
4. **Cầu nối biến động khép kín (Mathematical Waterfall):** Phân rã nguyên nhân biến động khách (Quy mô tần suất vs Hiệu suất tải vs Lệch số ngày) hoặc biến động chuyến bay (Nhịp độ chuyến/ngày vs Lệch số ngày) với cơ chế cổng kiểm soát dữ liệu hoàn tất / lịch tương lai.
5. **Dòng thời gian ghép theo Thứ lịch (Calendar DOW by N-th Occurrence):** Khử sai lệch chu kỳ tuần bằng cách ghép Thứ lịch theo thứ tự xuất hiện, bảo toàn dữ liệu ngày dôi dư.

### 1.2. Ràng buộc bất biến (Hard Constraints)
- **Single-file Offline:** Một file `.html` duy nhất chứa toàn bộ dữ liệu JSON, CSS, SVG và runtime JavaScript. Hoạt động 100% offline (`file://`), không kết nối mạng, không CDN, tuân thủ CSP `default-src 'none'`.
- **Resource Budget:** Tổng kích thước file HTML không vượt quá 25 MiB (`HTML_MAX_BYTES`), và tổng số dòng dữ liệu gom không vượt quá 250,000 dòng (`HTML_MAX_ROWS = 250_000`).
- **Không suy diễn dữ liệu:** Dữ liệu thiếu giữ nguyên `—` (null). Không biến null thành 0. Tuyến mới mở không gán `+100%` mà trả `percent: null` kèm nhãn `[MỚI]`.
- **Bảo toàn 100% số liệu gốc:** Lọc ngưỡng radar chỉ thực hiện client-side trên DOM; không cắt tỉa dữ liệu thô khỏi file xuất. Ngày dôi dư khi ghép thứ không bị loại bỏ khỏi tổng kỳ.

---

## 2. Chuẩn Hóa Toán Học & Ranh Giới Dữ Liệu

### 2.1. Hạt nhân phân vùng duy nhất (Canonical Partition Grain)
Để triệt tiêu lỗi đếm đôi giữa hãng bay và chặng bay, mọi phép phân loại (Radar, Top Động lực, Waterfall) thống nhất dùng một hạt nhân duy nhất từ dataset `market`:
$$\text{Canonical Grain} = (\text{country}, \text{route}, \text{airline})$$

Tập hợp tất cả các hạt nhân được chia thành 3 tập rời nhau:
1. $S_{\text{new}}$: Các bộ có $F_A > 0$ và $F_B = 0$.
2. $S_{\text{dropped}}$: Các bộ có $F_A = 0$ và $F_B > 0$.
3. $S_{\text{cont}}$: Các bộ có cả $F_A > 0$ và $F_B > 0$.

### 2.2. Cổng kiểm soát dữ liệu (Gate) và Hai nhánh Waterfall

Vì đối tượng `HtmlPeriod` chỉ chứa metadata thời gian (`contains_future`, `calendar_days`, ...), trạng thái đầy đủ của số liệu hành khách được kiểm tra từ tài nguyên `kpi` của từng kỳ với `direction = 'all'`:

```
                      [KIỂM TRA CỔNG DỮ LIỆU CẢ 2 KỲ]
contains_future === false (trên cả 2 HtmlPeriod)
VÀ kpi_all.pax_status === 'complete' (trên cả 2 kỳ)
VÀ kpi_all.unreported_legs === 0 (trên cả 2 kỳ) ?
                         /                                \
                      [ĐẠT]                            [KHÔNG ĐẠT]
                       │                                    │
          ┌────────────┴────────────┐          ┌────────────┴────────────┐
          │   NHÁNH 1: WATERFALL    │          │   NHÁNH 2: WATERFALL    │
          │  HÀNH KHÁCH (PAX FLOW)  │          │ CHUYẾN BAY (FLIGHT FLOW)│
          │  (Đã hoàn tất 100% ops) │          │(Bao gồm cả lịch kế hoạch)│
          └─────────────────────────┘          └─────────────────────────┘
```

#### Nhánh 1: Cầu nối Hành khách (Khi cả 2 kỳ đã hoàn tất 100% số liệu thực tế)
- **Phương trình bảo toàn:**
  $$\Delta \text{Pax}_{\text{Total}} = +\text{Pax}_A(S_{\text{new}}) - \text{Pax}_B(S_{\text{dropped}}) + \Delta_{\text{Days}}^{\text{Pax}} + \Delta_{\text{Volume}}^{\text{Pax}} + \Delta_{\text{Load}}^{\text{Pax}}$$
- **Tác động lệch ngày trên $S_{\text{cont}}$:**
  $$\Delta_{\text{Days}}^{\text{Pax}} = (Days_A - Days_B) \times \overline{\text{Pax}}_B(S_{\text{cont}})$$
- **Tác động quy mô tần suất trên $S_{\text{cont}}$:**
  $$\Delta_{\text{Volume}}^{\text{Pax}} = Days_A \times \left(\overline{\text{Flt}}_A(S_{\text{cont}}) - \overline{\text{Flt}}_B(S_{\text{cont}})\right) \times \overline{L}_B(S_{\text{cont}})$$
  *(với $\overline{L}_B(S_{\text{cont}}) = \frac{\text{Pax}_B(S_{\text{cont}})}{\text{Flt}_B(S_{\text{cont}})}$ là hệ số khách/chuyến kỳ B).*
- **Tác động hiệu suất tải (Hạng chốt - Plug khử sai số làm tròn số nguyên):**
  $$\Delta_{\text{Load}}^{\text{Pax}} = \Delta \text{Pax}(S_{\text{cont}}) - \Delta_{\text{Days}}^{\text{Pax}} - \Delta_{\text{Volume}}^{\text{Pax}}$$

#### Nhánh 2: Cầu nối Chuyến bay (Fallback khi có ngày tương lai hoặc khách chưa complete)
- Khai báo minh bạch trên giao diện: *“Tổng chuyến bay bao gồm cả lịch bay kế hoạch chưa thực hiện của các ngày tương lai”*.
- **Phương trình bảo toàn chuyến bay:**
  $$\Delta \text{Flights}_{\text{Total}} = +\text{Flt}_A(S_{\text{new}}) - \text{Flt}_B(S_{\text{dropped}}) + \Delta_{\text{Days}}^{\text{Flt}} + \Delta_{\text{Rate}}^{\text{Flt}}$$
- **Tác động lệch ngày trên $S_{\text{cont}}$:**
  $$\Delta_{\text{Days}}^{\text{Flt}} = (Days_A - Days_B) \times \overline{\text{Flt}}_B(S_{\text{cont}})$$
- **Tác động nhịp độ chuyến/ngày (Rate Effect - Plug làm tròn):**
  $$\Delta_{\text{Rate}}^{\text{Flt}} = \Delta \text{Flights}(S_{\text{cont}}) - \Delta_{\text{Days}}^{\text{Flt}}$$

### 2.3. Điểm phần trăm đóng góp (pp Contribution)
Đồng bộ theo trạng thái của cổng kiểm soát:
1. **Khi Nhánh 1 kích hoạt (Pax complete):**
   $$\text{pp Contribution}_i^{\text{Pax}} = \frac{\Delta \text{Pax}_i}{\text{Pax}_{B, \text{Total}}} \times 100\%$$
   Tổng pp của tất cả các hạt nhân con cộng lại bằng chính xác $\% \Delta \text{Pax}$ của toàn cảng.
2. **Khi Nhánh 2 kích hoạt (Future / Incomplete Pax):**
   Tuyệt đối không bịa số pp Pax (hiển thị `—`). Bảng tự động xếp hạng theo $\Delta \text{Flights}$ và tính:
   $$\text{pp Contribution}_i^{\text{Flt}} = \frac{\Delta \text{Flights}_i}{\text{Flights}_{B, \text{Total}}} \times 100\%$$

### 2.4. Thuật toán Ghép Thứ lịch & Ngày dôi dư
1. Tính thứ lịch từ chuỗi `date` (Thứ 2 $\rightarrow$ Chủ Nhật).
2. Ghép cặp: Thứ $K$ lần xuất hiện thứ $N$ của Kỳ A ghép với Thứ $K$ lần xuất hiện thứ $N$ của Kỳ B.
3. Ngày dôi dư của kỳ dài hơn hiển thị ở nhóm riêng với cột đối chiếu để `—`. Toàn bộ tổng sản lượng, bình quân ngày và cả 2 nhánh Waterfall vẫn tính trên 100% dữ liệu gốc của cả hai kỳ.

---

## 3. Kiến Trúc Kỹ Thuật Toàn Chuỗi (End-to-End Pipeline)

```
[Giao diện Export Dialog]
  └─ Người dùng chọn: Mẫu "Phân tích biến động", chọn Kỳ A (from, to) và Kỳ B (baseline_from, baseline_to)
       │
[Lớp URL Client (src/lib/)]
  ├─ trafficWorkbookExportContract.ts:
  │    • TrafficWorkbookReportType: thêm 'VARIANCE_ANALYSIS'
  │    • templateVersion: thêm 'variance-analysis-v1'
  │    • TrafficWorkbookExportDraft: thêm baselineFrom, baselineTo
  │    • normalizeTrafficWorkbookExportDraft: ép comparisons = [], comparisonYears = []
  │    • buildTrafficWorkbookExportUrl: phát baseline_from, baseline_to vào query params
  └─ trafficHtmlExportContract.ts:
       • buildTrafficHtmlExportUrl: map VARIANCE_ANALYSIS -> 'variance-analysis-v1'
       │
[Request Pipeline Backend (supabase/functions/_shared/)]
  ├─ trafficWorkbookCore.ts:
  │    • WORKBOOK_QUERY_KEYS: thêm 'baseline_from', 'baseline_to'
  │    • Dòng 283: thêm 'VARIANCE_ANALYSIS' vào mảng includes() kiểm tra reportType
  │    • Dòng 285: thêm nhánh expectedTemplate -> 'variance-analysis-v1'
  │    • Bắt buộc periodMode === 'custom'
  │    • Validate baselineFrom <= baselineTo; từ chối nếu (from, to) == (baselineFrom, baselineTo)
  ├─ trafficHtmlReportContract.ts:
  │    • HTML_TEMPLATES: map VARIANCE_ANALYSIS -> 'variance-analysis-v1'
  │    • normalizeHtmlRequest: đưa baseline_from, baseline_to vào object trả về
  └─ trafficHtmlReportRenderer.ts: rẽ nhánh mountTrafficHtmlVariance
       │
[PostgreSQL RPC]
  ├─ reporting.traffic_html_periods_v2:
  │    • Whitelist JSON request keys: thêm 'baseline_from', 'baseline_to'
  │    • Dòng 28: thêm 'VARIANCE_ANALYSIS' vào danh sách report not in (...)
  │    • Dòng 29: thêm nhánh WHEN 'VARIANCE_ANALYSIS' THEN 'variance-analysis-v1'
  │    • Sinh Kỳ A: id='current', role='current'
  │    • Sinh Kỳ B: id='baseline', role='comparison', label='Kỳ đối chiếu'
  └─ get_public_traffic_html_export_v2:
       • Dòng 242 tự động sinh cặp so sánh 'current-vs-baseline' vì role='comparison'
       • Kiểm soát ngân sách: 25 MiB và 250,000 dòng
       │
[Client-Side Runtime HTML Offline] (trafficHtmlVarianceRuntime.ts)
  ├─ Tab 1: Radar Bất thường (Lọc ngưỡng động client-side, canonical grain, chặn cờ ảo khi provisional/future)
  ├─ Tab 2: Cầu nối Waterfall (Gate kiểm tra -> Chạy Waterfall Pax hoặc Fallback Chuyến bay; Top pp đồng bộ)
  ├─ Tab 3: Ma trận so sánh đa chiều (Cây phân cấp, 4 bộ Preset chỉ số, xuất Excel .xlsx)
  └─ Tab 4: Dòng thời gian (Ghép thứ lịch theo lần xuất hiện, bảo toàn ngày dôi dư, heatmap 24h)
```

### Chi tiết các file thay đổi (tính từ workspace triển khai `SeasonalManagement-web-traffic-report/app`):

| Thành phần | Đường dẫn file | Thay đổi kỹ thuật cụ thể |
| :--- | :--- | :--- |
| **Client Export Contract** | `src/lib/trafficWorkbookExportContract.ts` | 1. Thêm `'VARIANCE_ANALYSIS'` vào type union `TrafficWorkbookReportType`.<br>2. Thêm `'variance-analysis-v1'` vào union `templateVersion`.<br>3. Mở rộng `TrafficWorkbookExportDraft` và `TrafficWorkbookExportRequest['period']`: thêm `baselineFrom`, `baselineTo`.<br>4. Trong `normalizeTrafficWorkbookExportDraft`: dòng 227 thêm nhánh `draft.reportType === 'VARIANCE_ANALYSIS' ? 'variance-analysis-v1' : ...`; dòng 255 ép `comparisons = []` và `comparisonYears = []` (ngăn chặn gửi comparison lạ khiến SQL từ chối).<br>5. Trong `buildTrafficWorkbookExportUrl`: nối `baseline_from` và `baseline_to` vào query string của URL. |
| **Client HTML Export Builder** | `src/lib/trafficHtmlExportContract.ts` | **Dòng 7–8:** Cập nhật `buildTrafficHtmlExportUrl` thêm nhánh `request.reportType === 'VARIANCE_ANALYSIS' ? 'variance-analysis-v1' : ...` (ngăn việc gán nhầm thành `'period-analysis-v1'` gây lỗi `invalid HTML template`). |
| **Export Dialog UI** | `src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx` | 1. Bổ sung `'VARIANCE_ANALYSIS'` vào mảng `reportTypeOrder` (dòng 26).<br>2. Thêm nhãn hiển thị: `Phân tích biến động sản lượng`.<br>3. Trong `initialDraft`: bổ sung khởi tạo `baselineFrom`, `baselineTo`.<br>4. Dựng UI chọn 2 kỳ: Kỳ A (`from`, `to`) và Kỳ B (`baselineFrom`, `baselineTo`) kèm 3 nút preset chọn nhanh (*Kỳ liền trước*, *Cùng kỳ tháng trước*, *Cùng kỳ năm trước*) và kiểm tra chặn trùng ngày. |
| **Backend Core & Query Whitelist** | `supabase/functions/_shared/trafficWorkbookCore.ts` | 1. Thêm `'VARIANCE_ANALYSIS'` vào type union `WorkbookReportType`.<br>2. Thêm `'variance-analysis-v1'` vào `WorkbookTemplateVersion`.<br>3. Bổ sung `'baseline_from'`, `'baseline_to'` vào Set `WORKBOOK_QUERY_KEYS`.<br>4. **Dòng 283:** Thêm `'VARIANCE_ANALYSIS'` vào mảng `includes(String(reportType))` (ngăn chặn lỗi `invalid workbook report type`).<br>5. **Dòng 285:** Thêm nhánh `expectedTemplate` trả về `'variance-analysis-v1'`.<br>6. Bắt buộc `periodMode === 'custom'`, cấm `comparisons` và `comparison_years`.<br>7. Validate `baselineFrom <= baselineTo`, từ chối nếu Kỳ A trùng khoảng Kỳ B. |
| **HTML Request Contract** | `supabase/functions/_shared/trafficHtmlReportContract.ts` | 1. Thêm `VARIANCE_ANALYSIS: 'variance-analysis-v1'` vào dictionary `HTML_TEMPLATES`.<br>2. Trong `normalizeHtmlRequest`: Bổ sung `baseline_from` và `baseline_to` vào object trả về (ngăn bị rơi trước khi gọi SQL RPC). |
| **PostgreSQL Migration** | `supabase/migrations/` (migration mới) | 1. Cập nhật `reporting.traffic_html_periods_v2`: <br>   - Thêm `baseline_from`, `baseline_to` vào whitelist các keys request hợp lệ.<br>   - **Dòng 28:** Thêm `'VARIANCE_ANALYSIS'` vào điều kiện `report not in (...)`.<br>   - **Dòng 29:** Thêm `WHEN 'VARIANCE_ANALYSIS' THEN 'variance-analysis-v1'`.<br>   - Sinh Kỳ A (`id: 'current'`, `role: 'current'`) và Kỳ B (`id: 'baseline'`, `role: 'comparison'`, `label: 'Kỳ đối chiếu'`). Không tự nhét cặp so sánh vào return của periods.<br>2. `get_public_traffic_html_export_v2` dòng 242 tự sinh cặp so sánh `'current-vs-baseline'` (vì Kỳ B có `role = 'comparison'`). Giữ nguyên kiểm tra trần 25 MiB và 250,000 dòng. |
| **Envelope Validator & Period Builder** | `supabase/functions/_shared/trafficHtmlReportModel.ts` | 1. Trong `expectedPeriods`: Nhận diện `report_type === 'VARIANCE_ANALYSIS'` và sinh đúng 2 kỳ `current` và `baseline` (`role: 'comparison'`).<br>2. Xác thực cặp so sánh `'current-vs-baseline'` trong `validateHtmlEnvelope`. |
| **HTML Renderer** | `supabase/functions/_shared/trafficHtmlReportRenderer.ts` | 1. Bổ sung tiêu đề tài liệu: `docTitle = 'Phân tích biến động sản lượng'`.<br>2. Import và rẽ nhánh mount `mountTrafficHtmlVariance` kèm stylesheet `trafficHtmlVarianceStyles`. |
| **Client-Side Variance Runtime** | `supabase/functions/_shared/trafficHtmlVarianceRuntime.ts` (mới)<br>`supabase/functions/_shared/trafficHtmlVarianceStyles.ts` (mới) | 1. Kiểm tra Cổng dữ liệu: Đọc `kpi` `direction = 'all'` của cả 2 kỳ để quyết định chạy Nhánh 1 (Pax) hay Nhánh 2 (Chuyến).<br>2. Radar bất thường lọc ngưỡng động client-side trên canonical grain `(country, route, airline)`.<br>3. Cầu nối Waterfall (Days + Volume/Rate + Load Plug).<br>4. Ma trận đa chiều 4 preset chỉ số, in-cell data bars và xuất Excel nhị phân `.xlsx`.<br>5. Bảng dòng thời gian ghép thứ lịch theo lần xuất hiện và heatmap 24 khung giờ. |

---

## 4. Kế hoạch Thực hiện Từng Bước (Action Plan)

```
1. [Client URL Contract] Cập nhật trafficWorkbookExportContract.ts và trafficHtmlExportContract.ts -> verify: npx tsx test client URL builders
2. [Backend Core Contract] Cập nhật trafficWorkbookCore.ts và trafficHtmlReportContract.ts -> verify: npx tsx test request normalizers
3. [PostgreSQL Migration] Viết migration Postgres mở rộng traffic_html_periods_v2 & export RPC -> verify: test PGlite RPC
4. [Model Validator] Cập nhật expectedPeriods & validateHtmlEnvelope trong trafficHtmlReportModel.ts -> verify: test Node isolation
5. [Variance Runtime] Xây dựng trafficHtmlVarianceRuntime.ts và trafficHtmlVarianceStyles.ts -> verify: test suite toán học & identity
6. [Renderer Integration] Tích hợp mountTrafficHtmlVariance vào trafficHtmlReportRenderer.ts -> verify: test render HTML offline
7. [Export Dialog UI] Cập nhật TrafficWorkbookExportDialog.tsx -> verify: Playwright headless browser test
```

### Tiêu chí nghiệm thu (Acceptance Criteria):
1. **Kiểm tra biên toàn chuỗi URL:** Client gọi `buildTrafficHtmlExportUrl` sinh đúng query `report_type=VARIANCE_ANALYSIS&html_template=variance-analysis-v1&baseline_from=...&baseline_to=...`. Không bị rơi tham số, không bị gán nhầm template hay dính lỗi `invalid workbook parameter`.
2. **Khép kín Waterfall Pax (Nhánh 1):** Khi dữ liệu quá khứ hoàn tất, tổng $\text{New} + \text{Dropped} + \Delta_{\text{Days}} + \Delta_{\text{Volume}} + \Delta_{\text{Load}} \equiv \Delta \text{Pax}_{\text{Total}}$ (chính xác đến từng lượt khách, không có sai số làm tròn).
3. **Khép kín Waterfall Chuyến (Nhánh 2):** Khi có ngày tương lai hoặc khách incomplete, tổng $\text{New} + \text{Dropped} + \Delta_{\text{Days}} + \Delta_{\text{Rate}} \equiv \Delta \text{Flights}_{\text{Total}}$. Cột pp Pax hiển thị `—`.
4. **Radar lọc động:** Thay đổi ngưỡng 30% / 10 chuyến / 1,000 khách trên giao diện offline cập nhật lại thẻ đếm tức thì (< 15ms), không mất dữ liệu thô.
5. **Dòng thời gian:** Thứ 2 lần 1 Kỳ A ghép đúng Thứ 2 lần 1 Kỳ B; ngày dôi dư hiển thị `—` ở cột đối chiếu; tổng kỳ không bị hụt.
6. **Mở offline hoàn toàn:** Tải file về máy, ngắt toàn bộ kết nối mạng, mở bằng trình duyệt Microsoft Edge/Chrome: mọi tương tác chuyển tab, đổi preset, chỉnh ngưỡng radar và xuất file `.xlsx` hoạt động trơn tru. Ngân sách đảm bảo $\le 25\text{ MiB}$ và $\le 250,000$ dòng.
