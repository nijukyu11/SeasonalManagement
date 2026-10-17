# BÁO CÁO RÀ SOÁT CHUYÊN SÂU HIỆU NĂNG & ĐIỂM NGHẼN HỆ THỐNG
**Hệ thống:** Seasonal Management (Desktop App, Web Traffic Report & KPI Dashboard)  
**Thời điểm rà soát:** 2026-09-25  
**Mục tiêu tải khảo sát:** 30 – 50 người dùng đồng thời (CCU)  
**Tài nguyên phần cứng máy chủ Production:** 16 vCPUs (Intel Core i7-10700 @ 2.90GHz), 16 GB RAM, NVMe SSD 452 GB.

---

## 1. ĐÁNH GIÁ TỔNG QUAN (EXECUTIVE VERDICT)

### Trả lời trực diện câu hỏi khảo sát:
> **"Hạ tầng hiện tại có đủ sức phục vụ 30 – 50 CCU không?"**

**KHÔNG THỂ (Nguy cơ nghẽn dịch vụ hoặc rớt kết nối diện rộng là 100% nếu đạt 30 – 50 CCU hoạt động cùng lúc).**

### Phân cấp rủi ro hệ thống:
🔥 **NGUY CẤP (CRITICAL)**

### Nguy cơ lớn nhất nằm ở tầng nào?
Nguy cơ lớn nhất nằm ở **sự cộng hưởng giữa Tầng CSDL (truy vấn báo cáo tính toán nặng, thời gian giữ kết nối dài, bộ nhớ đệm `shared_buffers` quá nhỏ) và Tầng Connection Pool của PostgREST (`opsdata-supabase-rest`) chia sẻ chung một pool duy nhất cho cả Báo cáo công khai lẫn Vận hành quầy Desktop**:

1. **Hiệu ứng cạn kiệt Connection Pool của PostgREST:**  
   Container PostgREST hiện cấu hình pool kết nối `PGRST_DB_POOL=25` và `PGRST_DB_POOL_ACQUISITION_TIMEOUT=5` (giây).  
   Khi 1 người dùng mở trang Báo cáo Traffic (`/reports/traffic`), giao diện web lập tức kích hoạt **4 HTTP requests đồng thời** (`/overview`, `/timeline`, `/dimension` hãng bay, `/dimension` đường bay). Cả 4 requests này đều gọi hàm SQL `reporting.get_public_traffic_report_v2(...)`.  
   Theo đo đạc trực tiếp trên Production ngày 2026-09-25:
   ```
   EXPLAIN (ANALYZE, BUFFERS) SELECT public.get_public_traffic_report_v2(...)
   Execution Time: 1243 ms (~1,24 giây)
   Buffers: shared hit=34298 read=151818 (Tổng 186.116 lượt truy xuất trang đệm ~1,42 GB bộ nhớ logic)
   ```
   Vì mỗi request báo cáo giữ một kết nối database liên tục trong ~1,2 – 1,5 giây:
   - **Chỉ cần 6 – 7 người dùng mở trang báo cáo cùng một lúc (6 × 4 = 24 requests), toàn bộ 25 slot kết nối của PostgREST sẽ bị chiếm dụng hoàn toàn.**
   - Người dùng thứ 8 mở trang, hoặc nhân viên vận hành trên Desktop thực hiện cập nhật quầy/cửa (gọi RPC `apply_season_server_mutation_v1`) đều bị đưa vào hàng đợi chờ slot. Nếu chờ quá 5 giây, PostgREST sẽ từ chối với lỗi:
     `{"code":"PGRST003","message":"Timed out acquiring connection from connection pool."}`  
   - *Phân biệt lỗi hạ tầng:* `PGRST003` là lỗi nội bộ của PostgREST khi cạn kiệt slot kết nối. Nếu tầng reverse proxy (Kong / Cloudflare) trả timeout 504 mà không kèm CORS headers thì trình duyệt sẽ hiển thị `TypeError: Failed to fetch`.

2. **Cấu hình bộ nhớ đệm PostgreSQL quá thấp so với phần cứng:**  
   Máy chủ vật lý có **16 GB RAM**, nhưng container `opsdata-supabase-db` đang chạy với cấu hình đo được từ hệ thống:
   - `shared_buffers = 128MB` (chỉ tương đương 16.384 buffer pages 8 KB, chiếm 0,8% tổng RAM máy chủ).
   - `effective_cache_size = 16MB` (được cấu hình ở mức 16MB trong biến tham số runtime, khiến Query Planner ước lượng sai chi phí đĩa).  
   Trong khi đó, riêng bảng `season_flight_records` đã chiếm **1,18 GB** (617 MB data + 566 MB index). Một lượt chạy hàm báo cáo truy xuất tới 186.116 lượt trang đệm (151.818 lượt đọc từ OS/đĩa), gấp 11 lần toàn bộ dung lượng `shared_buffers`. Điều này liên tục đẩy các trang dữ liệu khác ra khỏi cache, gây churn bộ nhớ dữ dội khi nhiều người cùng xem báo cáo.

3. **Cơ chế tải dữ liệu của Client có nguy cơ bùng nổ số lượng HTTP requests trong các nhánh Fallback:**  
   Trong `app/src/lib/supabaseStore.ts`, các hàm truy vấn quan hệ con sử dụng cơ chế chia nhỏ `readRowsByInFilter` với kích thước `SUPABASE_IN_FILTER_BATCH_SIZE = 100`.  
   Với mùa S26 trên Production có **68.230 chuyến bay**, việc duyệt danh sách `record_id` để lấy thông tin liên kết sẽ phát sinh tới $\lceil 68.230 / 100 \rceil = \mathbf{683 \text{ HTTP requests}}$ tuần tự cho mỗi quan hệ dữ liệu nếu kích hoạt nhánh fallback tải bảng rời (`loadSeasonWorkspaceSnapshotPaged`).

---

## 2. BẢNG PHÂN TÍCH ĐIỂM NGHẼN (RESOURCE BOTTLENECK MATRIX)

| STT | Vị trí (File / Function / Endpoint / Config) | Vấn đề phát hiện | Cơ chế kỹ thuật & Số liệu đo đạc thực tế | Loại nghẽn | Mức độ rủi ro |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | `reporting.get_public_traffic_report_v2` (`app/supabase/migrations/`) | **Truy vấn tổng hợp nặng, thời gian giữ kết nối dài** | Hàm pipeline qua nhiều CTE Materialized (`candidate_slice`, `canonical_rows`, `live_rows`). Đo thực tế ngày 25/09/2026: **1243 ms**, **186.116 buffer accesses (~1,42 GB logical buffer reads)**. Giữ slot kết nối PostgREST trong hơn 1,2s mỗi query. | CPU, RAM, DB I/O | 🔥 **NGUY CẤP** |
| **2** | `opsdata-supabase-rest` (Cấu hình Container) | **Connection Pool dùng chung, không cô lập luồng vận hành** | `PGRST_DB_POOL=25`, `PGRST_DB_POOL_ACQUISITION_TIMEOUT=5`. Cả báo cáo công khai lẫn thao tác quầy Desktop đều dùng chung 25 slot này. Khi có tải xem báo cáo, toàn bộ hệ thống vận hành bị chặn chờ. | Connection Pool | 🔥 **NGUY CẤP** |
| **3** | `postgresql.conf` (`opsdata-supabase-db`) | **Cấu hình RAM Database quá thấp so với phần cứng 16GB** | Đo trực tiếp qua `SHOW`: `shared_buffers = 128MB` (16.384 pages), `effective_cache_size = 16MB`. Dung lượng đệm quá nhỏ so với kích thước bảng chính (1,18 GB), gây tranh chấp bộ nhớ và đẩy đĩa liên tục. | RAM, Disk I/O | 🚨 **CAO** |
| **4** | `app/src/app/(public-report)/reports/traffic/` (`TrafficReportClient.tsx`, `TrafficReportTrend.tsx`, `TrafficReportDimensionSection.tsx`) | **Bắn 4 requests độc lập khi mở trang** | 1 lần mở trang kích hoạt 4 fetch đồng thời: `/overview`, `/timeline`, `/dimension` (hãng), `/dimension` (chặng). Do URL và tham số khác nhau, Nginx `proxy_cache_lock` không thể gộp tải, dồn trọn 4 query nặng xuống CSDL. | Network, PostgREST Pool | 🚨 **CAO** |
| **5** | `app/src/lib/supabaseStore.ts` (Hàm `readModificationRowsForDashboardSeason`, dòng 846–867) | **Bùng nổ Batch HTTP Requests theo cardinality trong nhánh fallback** | Hàm lấy toàn bộ modifications của mùa theo `season_id`, đồng thời gọi `readRowsByInFilter('season_modifications', 'leg_id', recordIds)` để phòng ngừa sai lệch `season_id`. Với mùa S26 (68.230 records), thao tác này chia nhỏ thành **683 HTTP requests** nối tiếp nhau. | Network, PostgREST Pool | ⚠️ **TRUNG BÌNH** (Nhánh fallback) |
| **6** | `app/src/app/(desktop)/dashboard/page.tsx` (Dòng 237–265, `buildDashboardWindowKey`) | **Tải toàn bộ dữ liệu mùa vào RAM trình duyệt** | Scope `dashboard:operations:full` tải toàn bộ mùa S26 (68.230 records) qua các trang RPC. Client giữ toàn bộ mảng trong React state và thực hiện tính toán heatmap, thống kê đồng bộ trên Main Thread JS gây đơ trình duyệt. | Frontend RAM & CPU | ⚠️ **TRUNG BÌNH** |
| **7** | `app/src/lib/supabaseStore.ts` (Hàm `readFlightRecordCounters` dòng 789–800 & `readFlightRecordWindows` dòng 802–813) | **Nhánh fallback tải toàn bộ bảng không index lọc mùa** | Bảng con không có `season_id`. Dù nhánh gọi thực tế (`hydrateFlightRecordRows`) luôn truyền `recordIds` (lọc theo chunk 100), nhưng nhánh `selectAllRows` không tham số ở dòng 799/812 nếu bị gọi sẽ quét trọn 480.103 dòng của bảng counters. | Code Pattern | ⚠️ **TRUNG BÌNH** |
| **8** | Nginx Caching (`/etc/nginx/conf.d/traffic-report.conf`) | **Cache TTL ngắn (60s) và khóa cache phân mảnh theo URL** | Cache key `$scheme\|$request_method\|$host\|$uri\|$is_args$args` khiến các request khác nhau của cùng một dải ngày không dùng chung được cache. Bộ lọc ngày chỉ cần thay đổi 1 ngày là toàn bộ cache bị bypass. | Caching | ⚠️ **TRUNG BÌNH** |

---

## 3. PHÂN TÍCH CHUYÊN BIỆT CHO PHÂN HỆ REPORT & DASHBOARD

### 3.1. Đánh giá độ phức tạp của truy vấn tổng hợp `get_public_traffic_report_v2`

Truy vấn `reporting.get_public_traffic_report_v2` không quét lặp lại bảng gốc `season_flight_records` ba lần riêng biệt, mà thực hiện theo mô hình đường ống (*pipeline CTEs*):
1. **`candidate_slice`:** Gọi hàm `reporting.get_public_traffic_candidate_slice_v1(v_scan_from - 1, v_scan_to + 1)` để quét bảng gốc một lần duy nhất trong dải ngày, ghép với `season_modifications` để xác định bản ghi hiệu lực.
2. **`canonical_rows` & `live_rows`:** Các CTE tiếp theo được khai báo `AS MATERIALIZED`, nhận dữ liệu đã lọc từ bước 1 và áp dụng bảng map loại máy bay (`operational_aircraft_groups`), quốc gia đường bay (`operational_route_countries`).
3. **`current_rows` & `comparison_rows`:** Tách số liệu kỳ hiện tại và kỳ đối chiếu (WoW / MoM / YoY) từ tập `live_rows` trong bộ nhớ.
4. **Các tính toán phức tạp non-additive:**
   - **Giờ cao điểm & Giờ bay:** Tính `hour_counts` theo khung giờ $0..23$ hỗ trợ cả giờ địa phương (`local_minutes`) lẫn giờ quốc tế (`utc_minutes`).
   - **Chuyến bay thường lệ trong khung giờ:** Dùng thuật toán lọc `flight_occurrences` đếm số ngày xuất hiện độc lập (`count(distinct ops_date) >= 4`) và tính tỷ lệ hoạt động ổn định (`consistency_percent >= 70%`) trên từng số hiệu chuyến bay (`flight_number`).
   - **Phân nhóm máy bay:** Gom nhóm theo `aircraft_group` và `aircraft_type`.

**Bản chất tiêu tốn tài nguyên:**  
Mặc dù chỉ quét bảng gốc một lần trong dải ngày, nhưng bước ghép nối (*joins*), xếp hạng (*window functions `row_number()`, `count() OVER`*) và gom nhóm non-additive trên tập dữ liệu chuyến bay lớn vẫn tiêu tốn **186.116 lượt truy xuất trang đệm** và mất **1243 ms** thời gian CPU.  
Trong môi trường `shared_buffers = 128 MB`, một truy vấn phải liên tục hoán đổi các trang đệm, gây nghẽn hàng đợi khi nhiều truy vấn cùng thực thi song song.

### 3.2. Rủi ro khi nhiều người cùng load Dashboard hoặc xuất báo cáo cùng lúc

Mô hình rủi ro hiện tại:
1. Khi có 6 – 8 người dùng mở trang Báo cáo Traffic hoặc bấm xuất Excel:
   - Mỗi người dùng tạo ra 4 requests đồng thời $\rightarrow$ tổng cộng 24 – 32 requests đập vào PostgREST.
   - Mỗi request giữ một kết nối CSDL trong ~1,2 – 1,5 giây.
2. Toàn bộ `PGRST_DB_POOL = 25` bị lấp đầy lập tức.
3. Nhân viên điều hành tại sân bay thao tác trên ứng dụng Desktop (Check-in, Gán quầy, Gán cửa) gửi request POST gọi RPC `apply_season_server_mutation_v1`.
4. Request vận hành bị rơi vào hàng đợi chờ kết nối của PostgREST (`PGRST_DB_POOL_ACQUISITION_TIMEOUT = 5s`).
5. Quá 5 giây không lấy được kết nối, PostgREST trả mã lỗi `PGRST003`. Ở phía client, nếu kết nối mạng qua proxy bị cắt đứt giữa chừng, giao diện hiển thị cảnh báo đỏ gián đoạn vận hành: `TypeError: Failed to fetch`.

> **Nhận định quan trọng về giải pháp:**  
> Việc chỉ tăng `PGRST_DB_POOL` hoặc tăng `PGRST_DB_POOL_ACQUISITION_TIMEOUT` **không giải quyết được gốc rễ vấn đề**. Nó chỉ làm dịch chuyển điểm rơi (*move the cliff*) và khiến client bị treo lâu hơn trước khi báo lỗi. **Biện pháp bắt buộc là phải rút ngắn thời gian giữ kết nối (giảm hold time từ 1243 ms xuống mức vài chục ms) và cô lập tài nguyên kết nối giữa Report và Vận hành quầy.**

### 3.3. Đánh giá cơ chế Polling, Duplicate Requests và Caching ở Frontend

#### A. Trang KPI Dashboard TV (`/reports/traffic/dashboard`):
- **Cơ chế Polling:** Định kỳ mỗi 60 giây (`ANNUAL_KPI_VERSION_POLL_MS = 60000`).
- **Trạng thái:**
  - Ở chế độ `DASHBOARD_DAILY_PUBLICATION_ENABLED = true`, frontend chỉ thăm dò endpoint `/api/report/v1/dashboard-publication-version?year=2026`. Endpoint này đọc bảng đầu bản tin `reporting.public_dashboard_publication_heads`, thời gian xử lý chỉ mất **2,7 ms** (cực kỳ nhẹ, an toàn).
  - Bản thân dữ liệu bản tin được sinh trước bởi tiến trình nền `seasonal-traffic-dashboard-runner` (15 phút/lần) dựa trên bảng vật lý hóa `reporting.public_traffic_effective`.
  - **Đánh giá:** Phân hệ TV Dashboard hoạt động rất tối ưu, không phải là nguồn gây nghẽn khi bản tin Daily Publication hoạt động bình thường.

#### B. Trang Web Traffic Report (`/reports/traffic`):
- **Vấn đề Duplicate Requests:** Khi tải trang hoặc thay đổi bộ lọc, 3 component con độc lập (`TrafficReportClient.tsx`, `TrafficReportTrend.tsx`, `TrafficReportDimensionSection.tsx`) tự phát sinh 4 lời gọi API riêng biệt:
  - `/api/report/v1/overview?...`
  - `/api/report/v1/timeline?...`
  - `/api/report/v1/dimension?...&dimension=airline`
  - `/api/report/v1/dimension?...&dimension=route`
- Cả 4 requests đều chứa phần lớn dữ liệu trùng lặp từ cùng một phạm vi báo cáo. Do URL khác nhau, cơ chế `proxy_cache_lock` của Nginx không thể gộp thành một request duy nhất.

---

## 4. KẾ HOẠCH TRIỂN KHAI & KHUYẾN NGHỊ KHẮC PHỤC (ROADMAP)

### 4.1. Giai đoạn 1: Xử lý nhanh (Quick Wins – Giảm tải ngay lập tức)

1. **Gộp lời gọi API ở Frontend Traffic Report (Request Coalescing):**
   - **Mục tiêu:** Xây dựng tầng Data Hook/Context tập trung tại `app/src/app/(public-report)/reports/traffic/`.
   - **Cơ chế:** Khi người dùng thay đổi bộ lọc, frontend chỉ gửi **1 request duy nhất** lấy toàn bộ dữ liệu báo cáo (`scope=full`), sau đó phân phối lại cho các component Overview, Trend, và Dimension.
   - **Kết quả:** Giảm ngay **75% số lượng truy vấn xuống backend** (từ 4 queries xuống 1 query/lượt xem trang), giải phóng tức thì 3/4 áp lực kết nối lên PostgREST.

2. **Tối ưu hóa cấu hình Bộ nhớ PostgreSQL (`postgresql.conf`):**
   - Nâng `shared_buffers` từ `128MB` lên **`4GB`** (25% dung lượng RAM vật lý 16GB của máy chủ). Giúp giữ các khối dữ liệu của bảng `season_flight_records` (1,18 GB) trong RAM, loại bỏ hiện tượng đẩy đĩa liên tục.
   - Nâng `effective_cache_size` từ `16MB` lên **`10GB`** để Query Planner đánh giá chính xác chi phí bộ nhớ đệm của hệ điều hành.
   - Nâng `work_mem` từ `4MB` lên **`32MB`** để các thao tác sắp xếp, băm và window function thực thi trọn vẹn trong RAM.

---

### 4.2. Giai đoạn 2: Tối ưu CSDL – Thiết kế Bảng Tổng Hợp 2 Tầng (Summary Tables)

Để bảo đảm **vừa tra cứu tự do theo mọi khoảng ngày bất kỳ**, vừa giữ nguyên **đầy đủ 100% tính năng hiển thị hiện tại của giao diện web** (bao gồm Giờ cao điểm, Giờ Local/UTC, Nhóm máy bay, Chuyến bay thường lệ), kiến trúc tổng hợp được chia làm 2 tầng:

#### Tầng 1: Bảng tổng hợp các chỉ số cộng dồn (Additive Daily Cube)
- **Bảng:** `reporting.daily_traffic_summary`
- **Khóa chính / Độ hạt (Grain):** `(ops_date, type, airline, route, country, aircraft_group, aircraft_type, hour_local, hour_utc)`
- **Các chỉ số cộng dồn:** `flights_count`, `arrivals_count`, `departures_count`, `reported_pax`, `due_legs`, `reported_legs`.
- **Phục vụ trọn vẹn cho mọi khoảng ngày tùy ý:**
  - Tổng sản lượng chuyến bay & hành khách (Kỳ hiện tại & Đối chiếu WoW/MoM/YoY).
  - Tỷ trọng và xếp hạng Hãng hàng không, Đường bay, Quốc gia, Loại máy bay.
  - Xu hướng sản lượng theo ngày / tháng / tuần (Timeline).
  - Biểu đồ phân bổ 24 khung giờ cao điểm (theo cả giờ địa phương Local lẫn giờ quốc tế UTC).

#### Tầng 2: Bảng phân tích chuyến bay thường lệ theo khung giờ (Regular Flights Rollup)
- **Bản chất kỹ thuật:** Chỉ số "Chuyến bay thường lệ trong khung giờ" sử dụng điều kiện `count(distinct ops_date) >= 4` và `consistency_percent >= 70%` trên từng số hiệu chuyến bay (`flight_number`). Đây là phép tính không cộng dồn (*non-additive*).
- **Phương án kiến trúc:**
  - Tách riêng thành bảng rollup theo tuần/tháng hoặc tạo endpoint lazy-load riêng cho danh sách chuyến thường lệ khi người dùng mở chi tiết bảng Giờ cao điểm.
  - Không để phép tính `count(distinct ops_date)` này cản trở hoặc làm chậm 95% số liệu tổng quan của trang báo cáo.

---

### 4.3. Giai đoạn 3: Cô lập tài nguyên & Tối ưu Desktop Dashboard

1. **Cô lập Connection Pool giữa Báo cáo và Vận hành quầy (Resource Isolation):**
   - Tách PostgREST hoặc cấu hình PgBouncer pooler riêng cho Public Report, bảo đảm luồng ghi Check-in / Gate trên Desktop không bao giờ bị nghẽn khi có đột biến truy cập Báo cáo.

2. **Chuyển đổi Desktop Dashboard sang mô hình Windowing:**
   - Không tải toàn bộ mùa S26 (68.230 chuyến bay) vào RAM trình duyệt. Chuyển sang tải theo khoảng ngày mặc định (ví dụ: tuần hiện tại hoặc tháng hiện tại), chỉ tải thêm khi người dùng chủ động mở rộng khoảng thời gian quan sát.

---

## 5. TỔNG KẾT 3 ĐIỂM NGHẼN NGUY HIỂM NHẤT CẦN XỬ LÝ TRƯỚC

1. 🔥 **[Tầng CSDL & Báo cáo] Thời gian giữ kết nối của `get_public_traffic_report_v2` quá dài (1243 ms / query):**  
   Mỗi lượt xem báo cáo chiếm trọn 1 slot kết nối database trong hơn 1,2 giây để tính toán tổng hợp. Cần triển khai Bảng tổng hợp dữ liệu 2 tầng (Summary Tables) để đưa thời gian phản hồi xuống mức vài chục ms.
2. 🔥 **[Hạ tầng kết nối] Dùng chung 1 Connection Pool cho cả Báo cáo ngoài và Vận hành quầy nội bộ:**  
   Cả người dùng xem báo cáo công khai lẫn nhân viên điều hành quầy check-in Desktop đều đi qua cùng một pool 25 kết nối của `opsdata-supabase-rest`. Khi báo cáo có tải, toàn bộ thao tác gán quầy/cửa bị nghẽn chờ và rớt kết nối. Cần cô lập pool riêng cho luồng vận hành Desktop.
3. 🚨 **[Frontend Traffic Report] Bắn 4 requests độc lập khi mở trang Báo cáo:**  
   Trang `/reports/traffic` bắn 4 fetch độc lập (`/overview`, `/timeline`, `/dimension` hãng, `/dimension` chặng) khiến Nginx cache không thể gộp tải. Cần gộp ngay thành 1 request tập trung (`scope=full`) ở client.
