# Kế hoạch nâng cấp toàn diện UI/UX và hoàn thiện thông tin Báo cáo HTML Pivot

**Ngày lập:** 2026-09-13  
**Tình trạng:** Đã hoàn thành triển khai & Kiểm thử tự động Passed 100% (Edge Playwright & PGlite).
**Mục tiêu:**
1. Đưa đầy đủ các chiều phân tích cốt lõi từ các file Excel mẫu (`SanLuong_Week_S26.xlsx`, `SanLuong_Country_2026.xlsx`, `SanLuongAPR.xlsx`, `BaoCaoSanLuong-public-v1.xlsx`) vào báo cáo HTML Pivot (`bao-live.html`, `period-live.html`, `weekly-live.html`).
2. Giải quyết dứt điểm các lỗi trải nghiệm UI/UX: hiện tượng chớp trắng (flicker) và giật cuộn (scroll jump) khi chuyển tab, bất nhất thanh công cụ giữa các tab, thiếu đường gióng phân cấp cây, dòng tổng bị khuất, và thiếu tính năng tùy biến pivot linh hoạt.  
3. Cung cấp bảng Tracker chi tiết với tiêu chí nghiệm thu có thể kiểm chứng độc lập bằng browser thực.

---

## 1. Dữ liệu thực tế & Đo lường kiểm chứng (Fact-Check từ Browser thực)

Đo lường trực tiếp trên bản artifact production thực tế (`app/tmp/production-live-verify/`) bằng Playwright Microsoft Edge headless (1680×1050):

| File báo cáo | Kích thước | Tab đo lường | Thời gian Click ➔ Render | Số lượng DOM Nodes | Hành vi Window Scroll | Tình trạng Bộ lọc (`.pivot-filters`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`bao-live.html`** (Báo cáo sản lượng mùa S26) | 6.1 MB | `TOTAL` | **764.7 ms** | **2,962 nodes** | Giữ `132 -> 132` | **Có sẵn** (trong `<details>`, 3 nhóm Hãng/Chặng/Thị trường) |
| | | `MAR 2026` | 56.4 ms | 474 nodes | **Bị giật: `132 -> 0`** | **Có sẵn** |
| | | `APR 2026` | 198.0 ms | 922 nodes | Giữ `0 -> 0` | **Có sẵn** |
| | | `MAY 2026` | 168.7 ms | 936 nodes | Giữ `120 -> 120` | **Có sẵn** |
| **`period-live.html`** (Phân tích theo kỳ) | 6.2 MB | `airline` | 27.5 ms | 479 nodes | **Bị giật: `244 -> 0`** | **Có sẵn** |
| | | `country` | 21.1 ms | 438 nodes | **Bị giật: `244 -> 0`** | **Có sẵn** |
| | | `route` | 33.9 ms | 479 nodes | Giữ `136 -> 136` | **Có sẵn** |
| | | `days` | 21.7 ms | 358 nodes | **Bị giật: `244 -> 0`** | **Có sẵn** |
| **`weekly-live.html`** (Báo cáo tuần chi tiết) | 784 KB | `airline` | 28.8 ms | 611 nodes | **Bị giật: `244 -> 0`** | **Có sẵn** |
| | | `days` | 27.1 ms | 1,097 nodes | **Bị giật: `244 -> 0`** | **Có sẵn** |

### Các kết luận kỹ thuật rút ra từ số liệu thực tế:
1. **Về bộ lọc của tab Bao (TOTAL, từng Tháng, Analysis)**:  
   - Tab Bao **KHÔNG HỀ THIẾU BỘ LỌC**. Mã nguồn dòng 418 gọi `controls(s)` cho mọi tab, và dòng 463–480 gắn `.pivot-filters` vô điều kiện. Cả 3 nhóm Hãng, Thị trường, Chặng đều có sẵn bộ checkbox và ô tìm kiếm riêng.  
   - **Vấn đề thực sự**: Bộ lọc bị ẩn trong thẻ `<details>` đơn sơ nên người dùng khó nhận biết; đồng thời tab Bao bị **khuyết các công cụ phụ**: không có ô "Tìm trong bảng", không có nút "Mở tất cả" / "Thu gọn", và không có menu "Hiển thị" (chọn Cấp nhóm, Trục cột).
2. **Về trục tuần (Week Horizon)**:  
   - Báo cáo non-Bao (`period`, `weekly`) **ĐÃ CÓ TRỤC CỘT TUẦN ISO** (`iso_week`) tại menu "Hiển thị" -> "Trục cột" (dòng 461, mã xử lý dòng 231).  
   - **Phần thực sự thiếu**:  
     a) Bản Bao mùa (`BAO_CAO_SAN_LUONG`) không có bộ chọn "Trục cột" (bị gán cứng thời gian, tab `WEEKLY` chỉ là một bảng dọc riêng biệt chứ không cho xoay ngang theo Hãng hay Thị trường).  
     b) Cả hai bản đều chưa đưa **Tuần nghiệp vụ T6–T5** (`business_week`) ra ngoài giao diện dropdown, dù hàm `columns()` dòng 231 đã hỗ trợ thuật toán bucket.
3. **Về nguyên nhân giật cuộn (Window Scroll Jump)**:  
   - Khi chuyển từ tab có chiều cao lớn (như `TOTAL` với gần 3,000 nodes) sang tab ngắn hơn (`MAR 2026`), lệnh `content.replaceChildren()` xóa sạch DOM khiến chiều cao trang sụp về 0 trước khi bảng mới được dựng, đẩy thanh cuộn window về đỉnh (`WinScroll: 132 -> 0` hoặc `244 -> 0`). Dù runtime đã có logic restore `.table-scroll`, nhưng scroll của toàn trang (`window.scrollY`) bị reset không mong muốn.
4. **Về trần dữ liệu cho tính năng Drill-down**:  
   - Payload RPC v2 (`traffic-html-data-v2`) giới hạn 25 MiB và **không nhúng raw flight records** (không có từng chuyến bay riêng lẻ kèm số hiệu chuyến và giờ hạ cánh thực tế).  
   - Trần hạt nhân chi tiết nhất hiện có trong HTML offline là `market_daily` (`date × route × airline × country × direction` kèm `flights` và `reported_pax`).  
   - **Ranh giới cam kết**: Drill-down trong phạm vi HTML offline sẽ hiển thị **danh sách phân rã theo Chặng bay / Hãng bay / Chiều bay / Khách của Ngày đó**. Muốn có danh sách chuyến bay chi tiết từng chuyến (`Flight number`, `Config`, `STA/STD` như sheet `Detail1`/`Detail2` trong Excel) thì bắt buộc phải mở rộng contract/RPC ở backend trong một phiên riêng biệt.

---

## 2. Khoảng cách thông tin chi tiết (Gap Analysis: HTML vs Excel mẫu)

| Chiều thông tin / Bảng | Mẫu Excel đối chiếu | Trạng thái hiện tại trong HTML | Giải pháp thực hiện |
| :--- | :--- | :--- | :--- |
| **1. Phân bổ Khung giờ & Cao điểm** | `SanLuong_Week_S26.xlsx` (Sheet `PeakHour`), `sanluong-summary.xlsx` (Sheet `PeakHour`, `Per30min`) | Payload JSON **đã có sẵn** dataset `hours` (48 dòng gồm 24 giờ × 2 chiều A/D), nhưng UI Pivot **chưa hiển thị**. | Tạo Tab / View chuyên dụng "Giờ khai thác & Cao điểm", hiển thị ma trận 24 khung giờ, tô màu heatmap nồng độ chuyến và khách. |
| **2. Cơ cấu Loại tàu bay (A/C Type)** | `SanLuong_Country_2026.xlsx` (cột `A/C Type`), `sanluong-summary.xlsx` (Sheet `ACType`) | Payload JSON **đã có sẵn** dataset `aircraft` (nhóm Narrowbody, Widebody và các loại A320, A321...), nhưng UI Pivot **chưa hiển thị**. | Tạo Tab / View chuyên dụng "Cơ cấu Đội tàu", hiển thị bảng phân bổ chuyến bay và khách theo loại tàu bay và phân nhóm thân hẹp/rộng. |
| **3. Tần suất theo Thứ trong tuần** | `SanLuong_Week_S26.xlsx` (Sheet `Sheet2`), `sanluong-summary.xlsx` (Sheet `Frequency`) | Payload JSON **đã có sẵn** dataset `frequency` (tần suất khai thác, ngày trong tuần); UI mới chỉ có tùy chọn cột `weekday` ẩn sâu. | Bổ sung Tab / View "Ma trận Tần suất" (Chặng bay / Hãng bay × Thứ trong tuần từ Thứ 2 đến Chủ nhật) phản ánh đúng Sheet2 của mẫu Excel. |
| **4. Ma trận Tuần cả mùa (Week Horizon)** | `SanLuong_Week_S26.xlsx` (Sheet `Airline`, `Country`, `Routes` xoay cột Tuần 13..43) | Báo cáo non-Bao đã có Tuần ISO; bản Bao mùa chưa có; cả hai đều thiếu Tuần nghiệp vụ T6–T5. | Mở khóa bộ chọn "Trục cột" cho bản Bao mùa; đưa lựa chọn `Tuần nghiệp vụ T6–T5` và `Tuần ISO` ra thanh công cụ để xoay ngang cột tuần kèm chỉ tiêu. |
| **5. Cấu hình ghế & Hệ số lấp đầy (Load Factor)** | `SanLuongAPR.xlsx` (cột `Config`), `SanLuong_Country_2026.xlsx` | Payload v2 chưa có trường `config_seats` (ghế cấu hình) nên chưa tính được `pax / seat`. | Hiển thị rõ chỉ số thay thế hiện có `Khách / Chuyến` (`pax_per_flight`); ghi nhận đề xuất bổ sung `config_seats` vào hợp đồng dữ liệu backend v3. |
| **6. Xem phân rã dữ liệu (Drill-down)** | `SanLuong_Week_S26.xlsx` (Sheet `Detail1`, `Detail2`) | Chưa có tương tác; các ô số liệu là text tĩnh. | Thêm Drawer / Flyout xem phân rã: click vào ô số liệu ngày/tháng sẽ bung danh sách chi tiết các Hãng, Chặng bay, Chiều bay cấu thành con số đó. |

---

## 3. Kiến trúc Giải pháp UI/UX Toàn diện

```
                   KIẾN TRÚC UI/UX MỚI CHO RUNTIME HTML PIVOT
┌─────────────────────────────────────────────────────────────────────────────────┐
│ HEADER: Tiêu đề báo cáo · Thời gian · Phạm vi xuất · Mốc chốt Ops Date · [Nút In]│
├─────────────────────────────────────────────────────────────────────────────────┤
│ SMART NAVIGATION BAR (Tabs có Indicator, Badge số lượng, không reload trang)   │
│ [📊 Tổng quan] [📅 Tuần cả mùa] [🗓 Theo ngày] [⏰ Giờ cao điểm] [✈️ Đội tàu] [🔀 Pivot tùy biến]│
├─────────────────────────────────────────────────────────────────────────────────┤
│ UNIFIED TOOLBAR (Cố định khi cuộn; đồng bộ bộ lọc & công cụ trên mọi tab)       │
│  - Bộ chọn: [Chỉ tiêu: Chuyến/Khách/Cả hai] [Chiều: Đến/Đi/Tổng] [Trục cột ▾]    │
│  - Thao tác: [Bộ lọc nhanh (Active: 3) ▾] [🔍 Tìm trong bảng...] [Mở/Thu gọn]   │
├─────────────────────────────────────────────────────────────────────────────────┤
│ MULTI-PANEL VIEW CONTAINER (Zero-Flicker, Caching Tab DOM, Bảo toàn Window Scroll)│
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │ TABLE / MATRIX / HEATMAP                                                  │  │
│  │  - Sticky Header & Sticky Columns bằng CSS thuần (position: sticky)       │  │
│  │  - Tree Guide Lines (đường kẻ dọc phân cấp rõ ràng khi bung nhóm con)     │  │
│  │  - In-cell Data Bars (thanh trực quan tỷ trọng trong ô số liệu)           │  │
│  │  - Sticky Grand Total (dòng tổng ghim cố định đáy viewport khi cuộn)       │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│ FLYOUT DRAWER (Trượt từ phải khi click ô số liệu để xem phân rã chặng/hãng)    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Cơ chế chuyển tab không giật lag (Zero-Flicker & Preserved Window Scroll)
- **Multi-panel Virtual DOM**:
  - Không dùng `content.replaceChildren()` để xóa sạch DOM mỗi lần bấm tab.
  - Mỗi tab được render vào một container riêng biệt `<section class="pivot-tab-panel" id="tab-panel-{id}" role="tabpanel">`.
  - Khi chuyển tab: Ẩn/hiện bằng thuộc tính `hidden` hoặc CSS `display: none / block` kết hợp transition mờ nhẹ (`opacity 0.12s ease`).
  - Render theo cơ chế **Lazy-load + Cache**: Tab nào được click lần đầu mới tính toán render DOM, các lần click sau chuyển đổi ngay lập tức (< 5ms) vì DOM đã có sẵn.
  - Giữ nguyên vị trí cuộn riêng của từng bảng (`table-scroll.scrollTop/Left`) và **bảo toàn hoàn toàn `window.scrollY`**, triệt tiêu 100% hiện tượng nhảy trang về 0.

### 3.2. Chuyển Sticky Header & Column sang CSS thuần
- Loại bỏ hoàn toàn việc tính toán vị trí `th.style.top` bằng `ResizeObserver` trong JavaScript (nguyên nhân gây rung giật khi cuộn nhanh).
- Chuyển sang CSS chuẩn:
  ```css
  .table-scroll th { position: sticky; top: 0; z-index: 20; }
  .table-scroll tr:nth-child(2) th { top: var(--header-row1-height); z-index: 20; }
  .table-scroll .name { position: sticky; left: 0; z-index: 30; }
  .table-scroll thead .name { z-index: 40; }
  ```

### 3.3. Đồng bộ hóa Thanh công cụ (Toolbar Parity)
- Tất cả các tab (kể cả `TOTAL` và các tab Tháng) đều có đầy đủ:
  - Ô **Tìm kiếm tức thì trong bảng** (`s.search`) có highlight vàng.
  - Nút **Mở tất cả** và **Thu gọn**.
  - Bộ lọc **Hãng, Thị trường, Chặng** được đưa ra ngoài với giao diện Popover Drawer hiện đại, có nút "Chọn tất cả" và "Bỏ chọn", hiển thị số lượng mục đã lọc rõ ràng.
  - Bộ chọn **Trục cột** (Theo tháng, Tuần ISO, Tuần nghiệp vụ T6–T5, Thứ trong tuần).

### 3.4. Cố định Dòng Tổng (Sticky Grand Total)
- Bổ sung lớp `sticky-total` cho dòng Grand Total:
  ```css
  .pivot-report tfoot tr.grand-total th,
  .pivot-report tfoot tr.grand-total td {
    position: sticky;
    bottom: 0;
    z-index: 25;
    background: #f1f5f9;
    box-shadow: 0 -2px 6px rgba(15, 23, 42, 0.08);
  }
  ```
  Giúp người xem cuộn đến bất kỳ vị trí nào giữa bảng dài vẫn luôn nhìn thấy dòng tổng đối chiếu.

### 3.5. Bộ dựng Pivot Tùy chỉnh (Interactive Pivot Field Chooser)
- Bổ sung tab **"Pivot Tùy biến"** cho phép người đọc tự cấu hình báo cáo theo ý muốn:
  - **Trục Dòng (Rows)**: Chọn đa cấp (Hãng ➔ Thị trường, Thị trường ➔ Chặng ➔ Hãng, v.v.).
  - **Trục Cột (Columns)**: Chọn gom theo Tháng, Tuần T6–T5, Tuần ISO, hoặc Thứ trong tuần.
  - **Chỉ tiêu (Values)**: Chọn hiển thị Chuyến bay, Khách, Bình quân Khách/Chuyến, hoặc Tỷ trọng % đóng góp.
  - Tự động lưu cấu hình ưa thích vào `localStorage` của trình duyệt.

---

## 4. Bảng Tracker Triển khai Chi tiết (Actionable Tracker)

Bảng tracker dưới đây dùng để bám sát và kiểm chứng từng hạng mục khi bước vào giai đoạn code:

### Giai đoạn 1: Nâng cấp Kiến trúc Tab, Triệt tiêu Giật cuộn & Đồng bộ Toolbar (Core UX)

| ID | Hạng mục công việc | Mô tả kỹ thuật chi tiết | Tiêu chí nghiệm thu (Acceptance Criteria) | Trạng thái |
| :--- | :--- | :--- | :--- | :---: |
| **UX-01** | **Multi-panel Tab Architecture** | Chuyển cơ chế render tab sang multi-panel: DOM caching theo tab, chỉ ẩn/hiện bằng CSS. | Thời gian chuyển giữa các tab đã xem giảm xuống **0.70ms** (< 15ms), loại bỏ hoàn toàn hiện tượng trắng trang tạm thời. | `[x]` Đã xong |
| **UX-02** | **Lưu & Khôi phục Window Scroll** | Lưu và khôi phục `window.scrollY` theo từng tab, clamp theo `maxScroll`. | Khi chuyển tab và quay lại, màn hình giữ nguyên vị trí đọc; tab ngắn được clamp hợp lệ. | `[x]` Đã xong |
| **UX-03** | **Pure CSS Sticky Header & Column** | Loại bỏ can thiệp inline style của ResizeObserver khi cuộn; dùng `position: sticky; top: 0; left: 0`. | Cuộn mượt mà 60fps trên bảng lớn, header và cột tên cố định ổn định. | `[x]` Đã xong |
| **UX-04** | **Đồng bộ Toolbar trên Tab Bao** | Bổ sung ô tìm kiếm "Tìm trong bảng" và các nút "Mở tất cả / Thu gọn" trên tab Bao mùa. | Người đọc lọc được ngày/tháng và mở/đóng phân cấp đồng nhất trên mọi loại báo cáo. | `[x]` Đã xong |
| **UX-05** | **Cải tiến Drawer Bộ lọc** | Thêm nút "Chọn tất cả" và "Bỏ chọn" cho từng nhóm bộ lọc (Hãng, Thị trường, Chặng). | Thao tác chọn nhanh chỉ 1 click thay vì phải click từng checkbox. | `[x]` Đã xong |
| **UX-06** | **Tree Guide Lines cho Phân cấp Nhóm** | Thêm đường dóng thụt lề trực quan nối giữa nhóm cha và nhóm con. | Phân biệt rõ cấp Hãng → Chặng hoặc Thị trường → Hãng khi danh sách dài. | `[x]` Đã xong |
| **UX-07** | **Sticky Grand Total ở Chân Viewport** | Ghim dòng Grand Total cố định ở đáy viewport khi bảng dài hơn chiều cao màn hình. | Luôn đối chiếu được tổng số mà không cần cuộn kịch xuống cuối trang. | `[x]` Đã xong |

---

### Giai đoạn 2: Kích hoạt Dữ liệu có sẵn & Bổ sung các View theo Mẫu Excel

| ID | Hạng mục công việc | Mô tả kỹ thuật chi tiết | Tiêu chí nghiệm thu (Acceptance Criteria) | Trạng thái |
| :--- | :--- | :--- | :--- | :---: |
| **DAT-01** | **Kích hoạt Tab Giờ cao điểm (`hours`)** | Dựng View hiển thị dataset `hours` có sẵn: ma trận 24 khung giờ × Chiều Đến/Đi/Tổng cho Chuyến và Khách. | Hiển thị bảng Peak Hour chuẩn như sheet `PeakHour` của Excel mẫu, có heatmap nồng độ. | `[x]` Đã xong |
| **DAT-02** | **Kích hoạt Tab Cơ cấu Đội tàu (`aircraft`)** | Dựng View hiển thị dataset `aircraft` có sẵn: thống kê theo nhóm tàu bay thân rộng/hẹp và loại tàu (`A320`, `A321`...). | Hiển thị bảng phân bổ đội tàu như sheet `ACType` của Excel mẫu. | `[x]` Đã xong |
| **DAT-03** | **Kích hoạt Tab Ma trận Tần suất (`frequency`)** | Dựng View hiển thị dataset `frequency` có sẵn: ma trận Chặng/Hãng × Thứ trong tuần (T2 đến CN). | Phản ánh đúng nội dung sheet `Sheet2` / `Frequency` của Excel mẫu. | `[x]` Đã xong |
| **DAT-04** | **Mở khóa Trục Tuần cả mùa cho Tab Bao** | Mở khóa bộ chọn Trục cột trên tab Bao; bổ sung tùy chọn `business_week` (Tuần nghiệp vụ T6–T5) và `iso_week` (Tuần ISO). | Người đọc xoay được bảng Bao mùa theo chiều ngang các tuần liên tiếp như sheet `Airline`/`Country`/`Routes`. | `[x]` Đã xong |
| **DAT-05** | **Trực quan hóa Tỷ trọng trong ô (Data Bars)** | Thêm tùy chọn bật mini bar màu xanh nhạt nền ô số liệu thể hiện tỷ trọng so với giá trị lớn nhất của cột. | Quét mắt thấy ngay chặng bay hoặc hãng bay chiếm sản lượng vượt trội mà không cần so sánh từng con số. | `[x]` Đã xong |

---

### Giai đoạn 3: Tính năng Tùy biến Pivot & Drill-down Phân rã Dữ liệu

| ID | Hạng mục công việc | Mô tả kỹ thuật chi tiết | Tiêu chí nghiệm thu (Acceptance Criteria) | Trạng thái |
| :--- | :--- | :--- | :--- | :---: |
| **ADV-01** | **Interactive Pivot Builder (Bộ dựng Pivot)** | Cho phép người dùng tự chọn trường Dòng (Rows), trường Cột (Columns), và Giá trị (Values). | Người dùng tự tạo được báo cáo theo cấu hình bất kỳ và lưu vào `localStorage`. | `[x]` Đã xong |
| **ADV-02** | **Flyout Drill-down Phân rã dữ liệu** | Click vào ô số liệu ngày/tháng bung Drawer bên phải hiển thị danh sách phân rã theo Chặng/Hãng/Chiều từ `market_daily`. | Bấm vào ô tổng ngày thấy rõ các hãng và chặng cấu thành con số đó mà không bị rời trang. | `[x]` Đã xong |
| **ADV-03** | **Xuất dữ liệu Excel có định dạng (Rich TSV/Clipboard)** | Nâng cấp nút Sao chép/Xuất CSV để hỗ trợ định dạng bảng nhiều tầng khi paste trực tiếp vào Microsoft Excel. | Paste vào Excel giữ nguyên cấu trúc merged header và định dạng số có dấu phân cách hàng nghìn. | `[x]` Đã xong |

---

## 5. Ràng buộc Kỹ thuật, Bảo mật & Kế hoạch Kiểm chứng

### Ràng buộc bất biến:
1. **Ràng buộc kích thước file HTML (Resource Budget)**:  
   Tổng kích thước toàn bộ file HTML (gồm CSS, JS runtime, và JSON payload nhúng) không được vượt quá giới hạn an toàn `HTML_MAX_BYTES` (25 MiB). Hiện tại file `bao-live.html` là 6.1 MiB; mã nguồn runtime mới phải viết gọn, tinh gọn CSS, không dùng thư viện ngoài nặng nề.
2. **Chính sách bảo mật CSP (Content Security Policy)**:  
   File HTML xuất ra hoạt động ở chế độ ngoại tuyến (`file://` hoặc lưu cục bộ) với CSP nghiêm ngặt:  
   `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none';`  
   Tuyệt đối **không được tải bất kỳ tài nguyên bên ngoài nào** (không CDN, không Google Fonts, không remote icons). Toàn bộ SVG icon và CSS phải được nhúng inline.
3. **Giới hạn hạt nhân Drill-down**:  
   Dữ liệu phân rã trong Flyout Drawer lấy từ `market_daily` (đến cấp `date × route × airline × country × direction`), tuyệt đối không bịa đặt số hiệu chuyến bay lẻ nếu contract backend chưa cung cấp.

### Quy trình kiểm chứng sau khi hoàn thành:
1. **Chạy test tự động với Playwright Edge**:  
   Sử dụng script đo lường kiểm tra lại các chỉ số:
   - Thời gian chuyển tab: giảm xuống dưới 15ms cho các tab đã cache.
   - Trạng thái `window.scrollY`: độ dịch chuyển bằng 0 khi chuyển tab.
   - Kiểm tra hiển thị đầy đủ của các tab mới: `hours`, `aircraft`, `frequency`.
   - Kiểm tra tính đầy đủ của bộ lọc và thanh công cụ trên cả 3 file mẫu (`bao-live.html`, `weekly-live.html`, `period-live.html`).
2. **Kiểm tra tính tương thích In ấn & Xuất CSV**:  
   Bảo đảm chế độ in `@media print` phân trang chuẩn xác và hàm xuất CSV/TSV bảo toàn dữ liệu lưới chữ nhật.

---

## 6. Biên bản Hoàn thiện & Nghiệm thu Hồi quy (2026-09-13)

### 6.1. Tinh chỉnh nâng cao đã hoàn tất:
1. **Thanh tỷ trọng trong ô (DAT-05):**
   - Sử dụng CSS `linear-gradient` trên thuộc tính `background-image` của thẻ `td`, loại bỏ hoàn toàn thẻ div phụ và không làm ảnh hưởng tới `position: sticky` của dòng `Grand Total` hoặc chế độ in `@media print`.
   - Tính toán `colMax` động cho từng cột theo từng cặp `(metric, direction)` riêng biệt (`A`, `D`, `all`). Triệt tiêu hiện tượng cột A/D bị giới hạn ở 50% hoặc các ô bị bẹp ở sàn 2%.
   - Loại trừ dứt điểm các dòng tổng (`.grand-total`) và dòng tổng tháng (`.month-total`) khỏi việc vẽ thanh tỷ trọng, giữ cho số liệu tổng hợp được rõ ràng, trực quan và không làm méo mó thang đo của các ngày.
   - Bổ sung tùy chọn bật/tắt trực tiếp trong dropdown "Hiển thị" (`s.showBars`).

2. **Lưu & Khôi phục Cấu hình Pivot (ADV-01):**
   - Phân vùng khóa lưu trữ theo loại báo cáo và ID tab (`traffic_pivot_cfg_${report_type}_${tabId}`).
   - Nút "Về bố cục mẫu" xóa bỏ cấu hình đã lưu trong `localStorage` và đưa giao diện về đúng trạng thái mặc định của mẫu ban đầu, kể cả sau khi tải lại trang (`page.reload()`).

### 6.2. Kết quả kiểm thử tự động toàn diện (Passed 8/8 test suites):
- `test-traffic-html-comprehensive-ux.mjs`: PASSED (10/10 test cases, đo lường chuyển tab 0.70ms, kiểm tra scaling toán học chính xác 100%, zero runtime errors).
- `test-traffic-pivot-improvements.mjs`: PASSED (Sanitization, formula injection guard, UTF-8 BOM, dual-flavor clipboard).
- `test-traffic-pivot-layout.mjs`: PASSED (Bố cục, responsive, print media).
- `test-traffic-html-offline.mjs`: PASSED (6/6 receipts offline).
- `test-traffic-monthly-layout.mjs`: PASSED.
- `test-traffic-weekly-layout.mjs`: PASSED.
- `test-traffic-html-dialog.mjs`: PASSED.
- `traffic-html-edge.test.mjs`: PASSED.
