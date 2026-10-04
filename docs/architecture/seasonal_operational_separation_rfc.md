# RFC: Phân Tách Kiến Trúc Lịch Bay Mùa (Planning) & Lịch Bay Vận Hành (Operations)
## Kèm Thiết Kế Versioning, Publish, Diff Engine, Tương Thích Report/Dashboard & Tối Ưu Hiệu Năng Backend

- **Tài liệu**: Technical Proposal / Request for Comments (RFC)
- **Tác giả**: Engineering Team
- **Ngày lập**: 2026-09-27
- **Trạng thái**: Đã tiếp thu ý kiến chỉ đạo & Hoàn thiện phương án
- **Mục tiêu**: 
  1. Tách rời hoàn toàn hai phân hệ "Lập Lịch Bay Mùa (Seasonal/Planning)" và "Điều Hành Bay Hàng Ngày (Operations/Daily)".
  2. Thiết kế cơ chế Quản lý Phiên bản (Versioning) theo định dạng ngày công bố (ví dụ: `W26-27JUN26`), quy trình Công bố (Publish) và So sánh Thay đổi (Diff Engine).
  3. Bảo toàn tuyệt đối tính toàn vẹn của phân hệ Báo Cáo Sản Lượng (Traffic Report) và Màn Hình Dashboard (KPI Wallboard 24/7).
  4. Đánh giá và tích hợp các cập nhật tối ưu truy xuất dữ liệu backend gần nhất (Keyset Pagination V2, PostgREST Pool Hardening, Projection Caching, Statement Timeouts, Concurrency Locks), phòng ngừa triệt để các sai lệch về phiên bản và rủi ro nghẽn hệ thống.

---

## 1. Khảo sát Hiện trạng & Sự Tiến hóa qua các Migrations (Current Architecture Audit)

### 1.1. Lịch sử Kiến trúc & Sự Tiến hóa qua các Migrations
Hệ thống ban đầu được thiết kế chỉ để quản lý Lịch bay Mùa. Qua các đợt phát triển, tính năng nạp lịch bay vận hành ngày (Daily Schedule) và báo cáo sản lượng (Traffic Report) được bổ sung và tiến hóa qua các mốc chính:

1. **Giai đoạn ban đầu (`20260828090000_daily_schedule_import_v1.sql`)**:
   - Khởi tạo cơ chế Daily Import bằng cách tạo các bảng batch: `daily_schedule_import_batches`, `daily_schedule_import_batch_legs`, `daily_schedule_import_seasons`, và con trỏ `daily_schedule_active_days`.
   - Lúc này, view `daily_schedule_effective_legs_v1` kiểm tra: nếu ngày có trong `daily_schedule_active_days` thì lấy từ batch legs, ngược lại fallback về `season_flight_records`.
2. **Giai đoạn thống nhất Canonical Store (`20260829153000_daily_schedule_canonical_commit.sql` & ADR `2026-08-29`)**:
   - Nhận thấy cơ chế active-day pointer rời rạc gây khó khăn cho việc lập chỉ mục và báo cáo, hệ thống đã ra quyết định: **Bảng `public.season_flight_records` trở thành Canonical Live Leg Store duy nhất** cho toàn bộ hệ thống, gộp cả 3 nguồn:
     * `source_kind = 'seasonal'` (lịch kế hoạch mùa).
     * `source_kind = 'daily'` (lịch nạp thực tế hàng ngày).
     * `source_kind = 'manual'` (chuyến bay tạo thủ công).
   - Cơ chế con trỏ `daily_schedule_active_days` bị bãi bỏ hoàn toàn. Bảng batch legs chỉ còn đóng vai trò staging/preimage.
3. **Giai đoạn Thẩm quyền Tuyệt đối & Ghép cặp Turnaround (`20260829170000...` $\rightarrow$ `20260921021500_daily_schedule_import_survivor_perf_fix.sql`)**:
   - Theo migration `20260829170000_seasonal_canonical_authority.sql`: Khi Seasonal nạp (kể cả Full Replace), các ngày đã có Daily authority (`schedule_replacement_scopes`) bắt buộc phải bị đánh dấu inactive `status='deleted', deletion_reason='daily_authority'`.
   - Hàm `commit_daily_schedule_import_v1` hiện tại (định nghĩa cuối cùng) hoạt động theo nguyên tắc:
     * Soft-delete toàn bộ các chuyến bay active trong khoảng ngày bị ảnh hưởng (`operational_date = any(affected_dates)`) với `status = 'deleted'`, `action = 'deleted'`, `deletion_reason = 'daily_replacement'`.
     * Tự động xóa liên kết cặp (`turnaround_id = null`, `linked_record_id = null`) của các chuyến bay đối ứng sống sót nằm ngoài khoảng ngày nạp.
     * Chèn các chuyến bay mới từ file Daily vào chính bảng `public.season_flight_records` với `source_kind = 'daily'`, `status = 'active'`.
     * Rebase điều chỉnh tài nguyên theo allowlist (`gate`, `stand`, `carousel`, `counter`, check-in, `mct/fb/lb/bhs/ghs`) qua `matched_record_id`; Pax của chuyến mới lấy từ `leg_data`, không sao chép lớp phủ Pax cũ (`20260921021500:241-242`).
4. **Giai đoạn Tối ưu hóa Truy xuất & Tăng tốc Báo cáo (`20260924...` $\rightarrow$ `20260925121500_public_traffic_canonical_legs_acceleration.sql`)**:
   - Khắc phục sự cố tắc nghẽn PostgREST pool connection wedge (ngày 24/09/2026).
   - Tạo bảng projection chuyên biệt `reporting.canonical_flight_legs` (36 MB) và hàm làm mới `reporting.refresh_public_traffic_canonical_legs_v1()`, được điều phối bởi daemon máy chủ `/usr/local/sbin/seasonal-traffic-report-refresh`, rút ngắn thời gian chạy của RPC `get_public_traffic_report_v2` từ 2500ms xuống ~500ms.

### 1.2. Các Ràng buộc Chéo Kỹ thuật (Tight Coupling Points)
Mặc dù đã giải quyết được bài toán tập trung dữ liệu, kiến trúc hiện tại bộc lộ 4 điểm nghẽn nghiêm trọng:

* **Ràng buộc Database**: Bảng `season_flight_records` bắt buộc phải có `season_id` (foreign key trỏ về `public.seasons`). Do đó, bảng `daily_schedule_import_batch_legs` và hàm `stage_daily_schedule_import_v1` bắt buộc phải phân bổ chuyến bay vào từng mùa (`seasonCode`). Khi nạp các ngày giao mùa hoặc các ngày mà Mùa chưa được tạo trước trong DB, hệ thống lập tức báo lỗi `DAILY_SEASON_MISMATCH`.
* **Ràng buộc UI & State**: Màn hình Daily (`app/src/app/(desktop)/daily/page.tsx`), Check-in (`checkin/page.tsx`), Gate (`gate/page.tsx`) đều bị phụ thuộc vào state `season`, render dropdown chọn Mùa, và gọi RPC `get_season_schedule_allocation_window_v2` bắt buộc nhận `p_season_id`.
* **Ràng buộc Navigation**: `app/src/app/(desktop)/components/AppSidebar.tsx` tự động gắn `?season=${seasonId}` vào tất cả các route vận hành khi chuyển trang.
* **Thiếu vắng Quy trình Publish & Versioning**: Người lập lịch khi chỉnh sửa lịch mùa (Draft) không có cơ chế đóng gói phiên bản, không có quy trình "Publish" để chuyển giao có kiểm soát sang phân hệ Vận hành, và không có công cụ Diff trực quan để bóc tách 3 nhóm Added/Modified/Removed trước khi phát hành.

---

## 2. Thiết kế Cơ sở Dữ liệu & Mô hình Dữ liệu Mới (Database & Data Model Design)

### 2.1. Phân Tách Hai Không Gian Dữ Liệu Độc Lập

```
   ┌────────────────────────────────────────────────────────┐
   │             SEASONAL PLANNING (MÙA)                   │
   │  - Workspace: S26, W26, S27...                         │
   │  - Import Seasonal SSIM / Excel                        │
   │  - Bảng: seasonal_flight_drafts, seasonal_source_rows   │
   │  - Edit Draft, Pairings, Day-of-week                   │
   └───────────────────────────┬────────────────────────────┘
                               │
                       [ DIFF ENGINE ]
                     (Preview So sánh)
                               │
                       [ PUBLISH ACTION ]
               (Tạo Version: W26-27JUN26 & Snapshot)
                               │
                               ▼
   ┌────────────────────────────────────────────────────────┐
   │            OPERATIONAL RUNTIME (VẬN HÀNH)             │
   │  - Trục thời gian liên tục (Bất kỳ ngày nào)          │
   │  - Bảng: operational_flight_legs                       │
   │  - Màn hình Daily, Gantt Gate, Gantt Check-in          │
   └───────────────────────────▲────────────────────────────┘
                               │
                        [ DAILY IMPORT ]
                  (AMS / File Khai thác ngày)
                  (Ghi đè theo Ground Truth)
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
    [ PUBLIC TRAFFIC REPORT ]       [ KPI WALLBOARD 24/7 ]
     (/reports/traffic)             (/reports/traffic/dashboard)
     - RPC: get_public_traffic...   - Publication Ledger
     - Projection: canonical_legs   - Hybrid Runner & Daemon
```

### 2.2. Chi tiết Database Schema Mới

#### A. Phân hệ Seasonal Planning (Bảng Nháp Mùa)
`seasonal_flight_drafts` chỉ chứa kế hoạch mùa, không chứa Daily. DDL bên dưới **chỉ minh họa các cột lõi**, không phải migration chạy được: phải chuyển provenance/source rows, overlay/history, pairing và hợp đồng import V3/export snapshot V2 từ bảng hiện hành trước khi xóa writer cũ. Giữ stable draft identity qua các lần sửa giờ.
```sql
create table if not exists public.seasonal_flight_drafts (
  draft_id text primary key default ('DRF_' || gen_random_uuid()::text),
  season_id text not null references public.seasons(id) on delete cascade,
  link_id text not null default '',
  type text not null check (type in ('A', 'D')),
  airline text not null,
  flight_number text not null,
  raw_flight_number text not null,
  route text not null,
  schedule text not null, -- HH:mm
  aircraft text not null,
  category text not null default 'C',
  pax integer,
  date date not null,     -- Ngày bay kế hoạch
  day_of_week integer not null check (day_of_week between 1 and 7),
  status text not null default 'active' check (status in ('active', 'deleted')),
  turnaround_id text,
  linked_draft_id text,
  link_type text check (link_type in ('sameday', 'overnight')),
  pair_anchor_date date,
  source_row_index integer,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_seasonal_flight_drafts_season_date
  on public.seasonal_flight_drafts (season_id, date);
```

#### B. Phân hệ Operational Runtime (Bảng Vận Hành Thực Tế)
Tạo bảng mới **`public.operational_flight_legs`** làm trung tâm cho mọi hoạt động vận hành, check-in, gate và báo cáo:

```sql
create table if not exists public.operational_flight_legs (
  leg_id uuid primary key default gen_random_uuid(),
  
  -- Định danh thời gian & nghiệp vụ khai thác
  operational_date date not null,
  scheduled_date date not null,
  scheduled_time time not null,
  side text not null check (side in ('ARR', 'DEP')),
  airline text not null,
  flight_number text not null,
  raw_flight_number text,
  route text not null,
  
  -- Đặc tính tàu bay & phân loại khai thác
  aircraft_type text not null default 'Unknown',
  flight_category text not null default 'C',
  pax integer,
  code_shares text,
  int_dom_ind text,
  
  -- Tài nguyên vận hành thực tế
  stand text check (stand is null or stand ~ '^[1-9][0-9]*[A-Z]?$'),
  gate integer check (gate is null or gate > 0),
  carousel integer check (carousel is null or carousel > 0),
  counter_token text,
  check_in_start text,
  check_in_end text,
  check_in_allocation_mode text check (check_in_allocation_mode in ('grouped', 'broken')),
  
  -- Ghép cặp Turnaround thực tế
  turnaround_id text,
  linked_leg_id uuid references public.operational_flight_legs(leg_id) on delete set null,
  link_type text check (link_type in ('sameday', 'overnight')),
  pair_anchor_date date,
  
  -- Nguồn gốc dữ liệu & Thẩm quyền bảo vệ
  source_type text not null check (source_type in ('published_seasonal', 'daily_import', 'operational_manual')),
  source_batch_id uuid,
  source_season_id text references public.seasons(id), -- Quyền sở hữu cho Publish xóa đúng leg mùa
  source_draft_id text,                         -- Stable identity qua các lần Publish
  published_version_id uuid,
  is_daily_ground_truth boolean not null default false, -- metadata trên leg, không thay day-scope
  daily_authority_locked boolean not null default false, -- metadata trên leg, không bảo vệ ngày 0 chuyến
  status text not null default 'active' check (status in ('active', 'cancelled', 'deleted')),
  deletion_reason text,
  
  -- Dấu vết kiểm toán (Audit Trail)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- Chỉ lập unique key sau khi probe dữ liệu xác nhận không loại chuyến hợp lệ
-- trùng ngày/chiều/hãng/số hiệu/giờ. Dùng stable identity + lineage để upsert.
create index if not exists idx_operational_flight_lookup
  on public.operational_flight_legs (operational_date, side, upper(airline), upper(flight_number), scheduled_time)
  where status = 'active';

-- Chỉ mục hỗ trợ Keyset Pagination V2 cho cửa sổ Gantt vận hành
create index if not exists idx_operational_flight_legs_keyset
  on public.operational_flight_legs (operational_date, scheduled_time, leg_id)
  where status = 'active';
```

**Daily authority** cần một bảng cấp `operational_date` với batch, count (cho phép 0), checksum, thời điểm commit/reset, người reset và revision. Backfill từ `schedule_replacement_scopes` kể cả ngày 0 chuyến; chỉ reset bằng RPC có quyền và audit.

#### C. Bảng Versioning, Snapshots & Audit Log (Quy Ước Đặt Tên Phiên Bản)

Theo yêu cầu thống nhất từ người dùng, quy ước đặt tên phiên bản được cấu trúc theo format:
$$\text{version\_tag} = \mathbf{[SEASON\_CODE]\textbf{-}[DDMMMYY]} \quad \text{(Ví dụ: } \mathbf{W26\text{-}27JUN26}, \mathbf{S26\text{-}15APR26}\text{)}$$
Trường hợp trong cùng ngày phát hành nhiều lần, tự động thêm hậu tố thứ tự (`W26-27JUN26.1`, `W26-27JUN26.2`).

```sql
-- 1. Quản lý phiên bản Publish của từng Mùa
create table if not exists public.seasonal_publish_versions (
  version_id uuid primary key default gen_random_uuid(),
  season_id text not null references public.seasons(id) on delete restrict,
  season_code text not null,       -- "W26", "S26"
  version_tag text not null,       -- "W26-27JUN26"
  sequence_in_day integer not null default 1,
  
  published_at timestamptz not null default now(),
  published_by uuid not null references auth.users(id),
  publish_notes text not null default '',
  
  range_start date not null,
  range_end date not null,
  
  total_flight_count integer not null default 0,
  added_count integer not null default 0,
  modified_count integer not null default 0,
  removed_count integer not null default 0,
  unchanged_count integer not null default 0,
  
  diff_summary jsonb not null default '{}'::jsonb,
  snapshot_checksum text not null,
  
  unique (season_id, version_tag)
);

-- 2. Lưu Full Snapshot JSONB bất biến để phục hồi/so sánh; PostgreSQL tự quản lý TOAST,
-- không giả định JSONB đã được ứng dụng nén hay tải cả mùa về client.
create table if not exists public.seasonal_publish_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references public.seasonal_publish_versions(version_id) on delete cascade,
  season_id text not null references public.seasons(id) on delete cascade,
  snapshot_payload jsonb not null,
  checksum text not null,
  created_at timestamptz not null default now()
);

-- 3. Lưu Delta Changelog chi tiết giữa các phiên bản
create table if not exists public.seasonal_publish_diff_entries (
  diff_id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.seasonal_publish_versions(version_id) on delete cascade,
  base_version_id uuid references public.seasonal_publish_versions(version_id) on delete set null,
  change_type text not null check (change_type in ('added', 'modified', 'removed')),
  flight_key text not null,
  operational_date date not null,
  side text not null check (side in ('ARR', 'DEP')),
  airline text not null,
  flight_number text not null,
  before_state jsonb,
  after_state jsonb,
  changed_fields text[] not null default array[]::text[],
  created_at timestamptz not null default now()
);

create index if not exists idx_diff_entries_version
  on public.seasonal_publish_diff_entries (version_id, change_type);
```

---

## 3. Thiết kế Cơ chế So sánh Phiên bản (Diff Algorithm & UI Viewer)

### 3.1. Thuật toán So sánh (Diff Engine)
So sánh snapshot **Planning** đã Publish gần nhất với draft hiện tại theo mùa. Ghép `source_draft_id`/provenance ổn định trước; fallback danh tính ngày vận hành + side + hãng + flight number chuẩn hóa **không có giờ** chỉ khi ghép 1:1. Trường hợp nhiều ứng viên: dùng thông tin phân biệt có bằng chứng hoặc báo ambiguous, không chọn giờ gần nhất.

### 3.2. Phân loại Thay đổi (Change Classification)
1. **Added**: Có trong draft, không có trong snapshot.
2. **Removed**: Có trong snapshot, không còn trong draft, kể cả khi cả ngày đã hết chuyến.
3. **Modified**: Cùng danh tính nhưng đổi giờ, route, aircraft, pax hoặc pairing; đổi giờ không được thành một cặp Added/Removed.
4. **Unchanged**: Không đổi thuộc tính so sánh.

Preview trả tách biệt **thay đổi Planning** và **thao tác Operations có hiệu lực**. `Skipped days` là mọi ngày còn Daily authority scope (kể cả 0 chuyến); `publishable days` là các ngày tương lai chưa có scope. Commit Publish phải retire leg `published_seasonal` do chính mùa sở hữu không còn trong draft trên publishable days; không retire Daily, Manual hoặc mùa khác. Preview gắn base version, draft revision và Daily scope revision/checksum; commit tái kiểm tra dưới cùng khóa ngày với Daily import, stale thì yêu cầu duyệt lại.

### 3.3. Giao diện Xem Trước Thay Đổi (UI Diff Viewer)
Trước khi nhấn xác nhận Publish, người dùng xem một modal trực quan:
- **Card tổng quan**: Thống kê số lượng `+ Added`, `~ Modified`, `- Removed`, `= Unchanged`.
- **Bảng dữ liệu phân màu**:
  * Added: Huy hiệu xanh lá (Green).
  * Removed: Huy hiệu đỏ, gạch ngang chữ (Red strikethrough).
  * Modified: Huy hiệu hổ phách (Amber), các ô thay đổi hiển thị `<Cũ> → <Mới>`.
- **Cảnh báo xung đột (Conflict Banner)**: Báo rõ có bao nhiêu ngày trong mùa đã có dữ liệu Daily thực tế và sẽ được bảo vệ (không bị mùa đè lên).
- **Trường hiển thị phiên bản tự động sinh**: Hiển thị sẵn tag phiên bản (ví dụ: `W26-27JUN26`) và cho phép người dùng nhập `Publish Notes`.

---

## 4. Thiết kế Lại Luồng Import & Export (Import/Export Flow Specs)

### 4.1. Import Seasonal (Lập Lịch Mùa)
1. Người dùng chọn Context Mùa trên màn hình Lập Lịch.
2. Tải lên file SSIM / Excel mùa.
3. Validate: Kiểm tra khung ngày bay có nằm trong `[season.effective_start, season.effective_end]`.
4. Dữ liệu chỉ ghi vào `seasonal_flight_drafts` và `seasonal_source_rows`.
5. **Hoàn toàn không tác động đến bảng vận hành `operational_flight_legs`** cho đến khi có hành động Publish chính thức.

### 4.2. Import Daily (Vận Hành Hàng Ngày) & Nguyên Tắc Daily Authority
Kế thừa và chuẩn hóa nguyên tắc từ `20260829170000_seasonal_canonical_authority.sql` và `20260921021500_daily_schedule_import_survivor_perf_fix.sql`:

> **Nguyên lý Tối thượng (Đã Thống Nhất)**: *"Dữ liệu nạp từ Daily (file AMS) là Chân lý Vận hành (Ground Truth of Operations), có Thẩm quyền Cao nhất (Highest Authority) đối với ngày vận hành đó."*

1. **Nạp Daily không cần Season ID**:
   - File Daily nạp trực tiếp theo tập ngày (`operational_date`), không yêu cầu Season ID hay kiểm tra mùa. Nếu file 0 chuyến không mang ngày, người dùng chọn rõ ngày trước khi stage; ngày chọn nằm trong persisted preview/hash và được xác nhận trước commit.
2. **Xử lý xung đột khi Nạp Daily (Daily Overwrite)**:
   - `affected_dates` là tập ngày trong file; commit thay **toàn bộ** leg active trong tập ngày (Seasonal, Daily cũ và Manual, như V1) rồi chèn Daily mới; preview nêu số Manual bị thay và tài nguyên có thể kế thừa. Import 0 chuyến vẫn tạo authority scope và xóa các chuyến cũ trong ngày.
   - Overlay rebase theo `matched_record_id` chỉ lấy allowlist gate/stand/carousel/counter/check-in/mct/fb/lb/bhs/ghs (`20260921021500:241-242`); Pax lấy từ `leg_data#>>'{resources,pax}'` của file, giữ nguyên NULL khác 0, không kéo lớp phủ Pax cũ.
3. **Bảo vệ Chân lý khi Re-publish Lịch Mùa (Seasonal Publish Precedence)**:
   - Ngày có Daily scope chưa reset luôn bị bỏ qua, kể cả không còn leg nào. Snapshot Planning vẫn giữ lịch sử nhưng Publish không ghi/xóa Operations ngày đó.
   - Trên các ngày tương lai không có Daily scope, Publish thêm/cập nhật leg do mùa sở hữu **và retire leg đã Publish trước đây do chính mùa đó sở hữu nếu vắng trong draft**, kể cả ngày draft rỗng; không xâm phạm Manual/mùa khác.

### 4.3. Bảo Toàn Định Dạng File Mẫu Xuất (Export Templates)
1. **Export Lịch Mùa (Seasonal Export)**:
   - Giữ nguyên 100% format `canonicalSeasonalRows.ts` và `exporter.ts`: Xuất theo Pattern Group (tần suất các thứ trong tuần DOW 1–7, dải ngày áp dụng, thông tin ghép cặp).
2. **Export Lịch Vận Hành (Daily Export)**:
   - Giữ nguyên 100% format `dailyScheduleExport.ts`: Xuất danh sách chuyến bay theo khoảng ngày tùy chọn với đầy đủ 19 cột tiêu chuẩn (`Type`, `Flight`, `Config`, `STA/STD`, `Routes`, `TTL Pax`, `Load Factor`, `Airlines`, `Ops Date`, `Country`, `A/C Type`, `Stand`, `Carousel`, `Gate`, `Counters`, `MCAT`, `FB`, `LB`, `GHS`).

---

## 5. Thiết Kế API & Service Logic Tổng Thể

### 5.1. Nhóm API Lập Lịch Mùa (Seasonal Planning)
Các đường dẫn dưới đây là **hợp đồng logic**; app hiện dùng Supabase RPC, không mặc định phải tạo Next.js API routes mới. Stage/commit trả status, owner-scoped receipt và hash/revision chống preview stale.
- `GET /api/seasons`: Danh sách Mùa.
- `GET /api/seasons/:id/drafts`: Danh sách chuyến bay nháp trong mùa.
- `POST /api/seasons/:id/import-stage` & `commit`: Nạp file mùa vào bảng nháp.
- `POST /api/seasons/:id/publish-preview`: Chạy thuật toán Diff, trả về preview Added/Modified/Removed.
- `POST /api/seasons/:id/publish-commit`: Đóng gói snapshot, tạo phiên bản `[SEASON]-[DDMMMYY]`, đồng bộ các ngày tương lai vào `operational_flight_legs`.
- `GET /api/seasons/:id/versions`: Danh sách các lần publish kèm changelog.
- `GET /api/seasons/:id/versions/:vId/diff`: Chi tiết thay đổi của một version.

### 5.2. Nhóm API Vận Hành (Operational Runtime)
- `GET /api/operations/window?from=YYYY-MM-DD&to=YYYY-MM-DD`: Lấy dữ liệu vận hành theo khoảng ngày tự do (phục vụ Daily, Check-in, Gate). Không cần `season_id`. Hỗ trợ Keyset pagination V2.
- `POST /api/operations/import-daily/stage` & `commit`: Nạp file Daily AMS trực tiếp theo ngày.
- `PATCH /api/operations/legs/:id`: Cập nhật phân bổ Gate, Stand, Quầy Check-in, Pax.
- `POST /api/operations/export/daily`: Xuất Excel báo cáo vận hành theo khoảng ngày tùy chọn.

---

## 6. Thiết Kế Luồng Frontend & Tách Biệt State (UI/UX Architecture)

### 6.1. State Theo Miền Nghiệp Vụ
- Planning quản lý season context, revision draft và trạng thái lưu/preview. Không báo “đã lưu” khi mutation chưa có receipt server.
- Operations quản lý dải ngày, leg/window token và pending/error; không dùng season-scoped cache/key. Tái sử dụng store hiện có khi phù hợp, chỉ tạo `useOperationsStore` nếu việc tách thực sự cần. Mặc định Today theo `Asia/Ho_Chi_Minh`.

### 6.2. Cấu Trúc Lại Menu Điều Hướng & UX Chọn Ngày Vận Hành
- **UX Màn hình Vận hành**: Mặc định hiển thị ngày hiện tại (`Today`), tích hợp bộ nút bấm chọn nhanh: `[ Hôm nay ]`, `[ Ngày mai ]`, `[ 7 ngày tới ]` hoặc mở `[ Tùy chọn dải ngày ]`.
- **AppSidebar.tsx**:
  * Nhóm **LẬP LỊCH BAY (PLANNING)**: Lịch Bay Mùa (có chọn mùa), Xem Chi Tiết Mùa, Lịch Sử Phiên Bản.
  * Nhóm **ĐIỀU HÀNH BAY (OPERATIONS)**: Lịch Bay Hàng Ngày (chọn ngày tự do), Phân Bổ Cửa Bay, Phân Bổ Check-in, Báo Cáo Sản Lượng, Dashboard Màn Hình Lớn.
  * Gỡ bỏ hoàn toàn việc tự động đính kèm `?season=...` khi chuyển trang sang phân hệ Vận hành.

---

## 7. Phân Tích Tác Động & Thiết Kế Thích Ứng Cho Phân Hệ Report & Dashboard

### 7.1. Hiện Trạng Dataflow của Report và Dashboard
Theo các quyết định tại ADR `2026-08-29`, ADR `2026-09-01`, và artifact tăng tốc `2026-09-25`:
1. **Public Traffic Report (`/reports/traffic`)**:
   - Đọc trực tiếp từ bảng projection **`reporting.canonical_flight_legs`** qua RPC `public.get_public_traffic_report_v2`.
   - RPC này kiểm tra watermark từ `public.season_change_events.server_seq`.
   - Bảng projection này được nuôi bởi hàm `reporting.refresh_public_traffic_canonical_legs_v1()`, vốn đang đọc từ `reporting.get_public_traffic_candidate_slice_v1`.
   - Trên máy chủ, daemon **`/usr/local/sbin/seasonal-traffic-report-refresh`** kích hoạt làm mới projection.
2. **Public Dashboard Wallboard 24/7 (`/reports/traffic/dashboard`)**:
   - Đọc từ bảng bất biến **`reporting.public_dashboard_daily_publications`**.
   - Daemon máy chủ **`seasonal-traffic-dashboard-runner`** (Hybrid Runner) lắng nghe tín hiệu `NOTIFY` sau mỗi lượt import/acceptance, tính toán các chỉ số qua Canonical Traffic Metrics Module, kiểm tra SLA, và chuyển con trỏ `current head publication`.

### 7.2. Thiết Kế Thích Ứng Chi Tiết (Adaptation Architecture)

#### A. Candidate Slice & Projection: Shadow Trước, Cắt Chuyển Sau
Trong pha shadow, tạo candidate slice/projection **tên riêng** từ `operational_flight_legs`; giữ nguyên hàm `reporting.get_public_traffic_candidate_slice_v1` và projection/report công khai. Ánh xạ đủ hợp đồng cũ: ngày vận hành 05:00–04:59, `type`, `category`, route/aircraft/pax effective, Pax NULL, business key, thứ tự recency, duplicate/quarantine. `published_version_id` không phải `season_id` (Daily/Manual có thể không thuộc mùa); không dùng `coalesce(events.server_seq, 0)` để giả một thứ tự authority khi không có sự kiện.

#### B. Event Watermark & Preview
Publish/Daily commit ghi receipt và sự kiện, mỗi thay đổi leg phải có recency gắn `leg_id` hoặc phạm vi ngày để candidate slice phân giải được; nguồn không còn bắt buộc `season_id`. Web Report chỉ công bố projection fresh đến watermark đã refresh; nếu nguồn đã đổi mà projection chưa bắt kịp, trả trạng thái stale/đợi worker, không nhận snapshot trộn. Stage/preview gắn draft/base/scope revision và fingerprint; commit tái kiểm tra dưới khóa ngày dùng chung với Daily import.

#### C. Refresh Worker/Daemon
Không gọi full `reporting.refresh_public_traffic_canonical_legs_v1()` trong transaction Publish/Import qua PostgREST: hàm hiện quét toàn dải, tạo bảng tạm và nạp lại projection. Sau commit, tín hiệu `NOTIFY` đánh thức daemon; timer/freshness watermark khôi phục tín hiệu bị lỡ. Chỉ khi đạt parity và mọi writer đã chuyển mới flip candidate slice/projection reader công khai theo gate riêng. Dashboard publication dựa trên projection fresh.

#### D. Tuân Thủ Nguyên Tắc Pax Presence & Maturity
* `pax is null`: Chưa có báo cáo (Missing / Unreported).
* `pax = 0`: Đã báo cáo thực tế bằng 0 (True-zero). Tuyệt đối không dùng `coalesce(pax, 0)`.
* Chuyến bay quá 24 giờ sau giờ bay mà Pax vẫn null thì tự động đánh dấu `overdue missing` trên Dashboard.

---

## 8. Đánh Giá Các Cập Nhật Backend Gần Đây & Thiết Kế Tối Ưu Truy Xuất Dữ Liệu (Backend Hardening)

Khảo sát chuyên sâu từ báo cáo hiệu năng ngày 25/09/2026 (`docs/performance_and_bottleneck_audit.md`) và kế hoạch khắc phục sự cố pool wedge ngày 24/09/2026 (`docs/superpowers/plans/2026-09-24-postgrest-pool-wedge-report-hardening.md`) mang lại các yêu cầu bắt buộc cho kiến trúc mới:

### 8.1. Cô Lập Rủi Ro Nghẽn PostgREST Connection Pool (PGRST003 Prevention)
* **Thực trạng**: PostgREST (`opsdata-supabase-rest`) được cấu hình `PGRST_DB_POOL = 25` (trước đây là 10) và `PGRST_DB_POOL_ACQUISITION_TIMEOUT = 5s`. Khi có nhiều truy vấn báo cáo nặng, toàn bộ slot kết nối bị chiếm dụng, khiến thao tác điều hành quầy trên Desktop bị lỗi timeout `PGRST003` hoặc `TypeError: Failed to fetch`.
* **Giải pháp trong Kiến trúc Mới**:
  1. **Tách tải báo cáo khỏi transaction ghi**: Operational window có index theo ngày, projection report do daemon refresh sau commit; đo p50/p95 trên PostgreSQL và tải cạnh tranh thay vì khẳng định sẵn `< 50ms`.
  2. **Timeout có kiểm chứng**: Cấu hình timeout ở cấp RPC/session theo cú pháp PostgreSQL được test; timeout giới hạn tài nguyên nhưng không thay thế worker refresh, preimage guard hay giám sát pool.
  3. **Khóa giao dịch chung**: Daily và Publish lấy advisory lock **cùng namespace theo từng operational_date tăng dần** (Publish có thể khóa season trước, Daily không lấy season lock sau day lock), rồi recheck authority/preimage dưới khóa; không chỉ dùng khóa season riêng cho Publish.

### 8.2. Kế Thừa & Nâng Cấp Keyset Pagination V2 Cho Phân Hệ Vận Hành
Kế thừa thành công từ migration `20260720090000_workspace_window_keyset_v2.sql`, RPC tải cửa sổ vận hành mới **`get_operational_schedule_allocation_window_v1`** bắt buộc sử dụng **Keyset Cursor Pagination** thay cho OFFSET/LIMIT truyền thống:
* **Bộ ba con trỏ Keyset Cursor**: `(p_after_operational_date, p_after_scheduled_time, p_after_leg_id)`.
* **Hỗ trợ chỉ mục B-Tree Composite**:
  ```sql
  create index idx_operational_flight_legs_keyset
    on public.operational_flight_legs (operational_date, scheduled_time, leg_id)
    where status = 'active';
  ```
* **Hiệu năng**: Keyset tránh OFFSET tăng theo số trang nhưng vẫn tốn công đọc/xử lý mỗi trang và nhiều HTTP requests khi dải rộng. Đo p50/p95 và `EXPLAIN (ANALYZE, BUFFERS)` trên dữ liệu đại diện; buộc các trang dùng cùng version/high-water để không trộn snapshot.

### 8.3. Loại Bỏ Triệt Để Hiện Tượng Bùng Nổ HTTP Batch Requests ở Client
* **Thực trạng cũ**: Hàm `readRowsByInFilter` trong `supabaseStore.ts` chia nhỏ danh sách `record_id` thành các mẩu 100 phần tử (`SUPABASE_IN_FILTER_BATCH_SIZE = 100`), dẫn đến việc phát sinh tới **683 HTTP requests** tuần tự khi tải mùa S26 (68.230 bản ghi).
* **Chuẩn hóa mới**:
  - Phân hệ Vận hành đọc theo dải ngày bằng RPC keyset, **một request mỗi trang**, giới hạn page size và kiểm tra version trên mọi trang; không cam kết một request cho dải ngày bất kỳ.
  - Tối ưu `scope=full` của Web Report là bài toán riêng: chỉ đổi số requests sau khi kiểm tra hợp đồng UI/report hiện hành, không gộp vào điều kiện cắt chuyển dữ liệu Operations.

---

## 9. Kế Hoạch Di Chuyển Dữ Liệu & Lộ Trình Triển Khai (Phased Rollout)

| Pha | Việc cần hoàn tất trước khi sang pha sau |
|---|---|
| 1. Schema/backfill | Tạo Planning, Operations, Daily day-scope và version tables; chuyển effective legs + provenance/source rows/overlays, Manual, pairing; seed snapshot Planning, bắt kịp high-water sau backfill. |
| 2. Chuẩn bị writer và shadow | Triển khai import Seasonal/Daily, mutation tài nguyên/Manual, export và UI mới **sau feature gate chưa kích hoạt**; nguồn cũ vẫn là authority. Replay/dual-write đã kiểm chứng cập nhật projection shadow trong khi report cũ phục vụ. |
| 3. Diff/Publish | Kiểm chứng ghép danh tính ổn định, đổi giờ, xóa hết ngày và khóa ngày chung khi chạy trên DB thử nghiệm; Publish production vẫn sau gate. |
| 4. Go/no-go & flip | Chặn writer cũ, replay đến high-water, kiểm parity; bật toàn bộ writer mới và chuyển reader/projection trong **cùng cửa sổ có kiểm soát**, mở ghi sau khi projection fresh. Chỉ khóa bảng cũ sau khi không còn writer cũ; fallback phải replay write mới trước khi mở writer cũ. |

Đối soát phải chạy **trước từng lần flip**, trên lịch sử sẵn có và các mutation phát sinh trong thời gian shadow; chuẩn hóa trường động, sai lệch chỉ số nghiệp vụ = 0. Rollback theo pha: trước khi writer mới chạy có thể rollback schema; sau khi đã ghi dữ liệu, rollback reader/feature gate và replay/đối soát, không hứa hoàn nguyên dữ liệu bằng file `.rollback.sql` trong 30 giây.

---

## 10. Đánh Giá Rủi Ro & Kế Hoạch Dự Phòng (Risk Mitigation)

| Rủi ro | Biện pháp |
|---|---|
| Publish tái tạo chuyến mùa trên ngày Daily không có leg | Authority scope cấp ngày độc lập với leg, giữ marker 0 chuyến và reset có audit. |
| Publish bỏ sót chuyến mùa đã xóa | Retire các leg cũ do **chính mùa** sở hữu trên ngày publishable; test v1→v2 xóa một chuyến và xóa hết ngày. |
| Preview cũ, Daily/Publish cùng commit | Preview hash/revision, khóa ngày chung theo thứ tự, recheck dưới khóa, stale phải duyệt lại. |
| Báo cáo lệch/freshness sai hoặc nghẽn pool | Shadow projection, parity trước flip, refresh worker ngoài transaction ghi, watermark đã được refresh và timer fallback. |

---

## 11. Đánh Giá Tinh Gọn: Loại Bỏ Draft UI & Save Thủ Công Trong Phân Hệ Lập Lịch Mùa

### 11.1. Hiện Trạng Kỹ Thuật (Fact-Check Mã Nguồn)
Khảo sát chi tiết luồng đột biến dữ liệu hiện tại làm rõ các sự thật kiến trúc:
1. **Chế độ Server-Authoritative (`SERVER_AUTHORITATIVE_MODE = true`)**:
   - Tại `app/src/lib/nativeLocalSeasonStore.ts` (dòng 176–212), khi người dùng bấm Lưu (Save), hàm `runNativeScheduleMutation` lập tức gọi `applyServerAuthoritativeOperations` để thực thi RPC server `apply_season_server_mutation_v1` trên Supabase.
   - Không tồn tại một hàng đợi ngoại tuyến (offline outbox queue) nào được tải lên sau đó đối với phân hệ Lập lịch Mùa; `SeasonSyncProvider.run` không làm nhiệm vụ upload queue cho Seasonal.
2. **Phạm vi của Auto-Sync**:
   - Tại `app/src/lib/seasonAutoSync.ts` (dòng 4), biến `AUTO_SYNC_SOURCE_FAMILIES = new Set(['daily', 'checkin', 'gate'])`.
   - Cơ chế tự động đồng bộ ngầm chỉ áp dụng cho 3 phân hệ Vận hành (`daily`, `checkin`, `gate`), hoàn toàn không áp dụng cho `seasonal` và `detailed`.
3. **Điểm thừa thãi thực sự**:
   - Trên màn hình `SeasonalSchedulePage.tsx` và `detailed/page.tsx`, người dùng khi chỉnh sửa chuyến bay phải thông qua một tầng đệm giao diện cục bộ là React state `draftState` (Draft UI), sau đó phải bấm nút Lưu thủ công ("Save draft") thì dữ liệu mới được đẩy lên máy chủ.
   - Điều này tạo ra rủi ro mất dữ liệu nếu người dùng vô tình tải lại trang (`F5`), đóng ứng dụng, hoặc chuyển tab trước khi bấm Save, buộc codebase phải sinh thêm nhiều guard kiểm tra dở dang (`latestDraftStateRef`, kiểm tra draft trước khi import/export).

### 11.2. Đề Xuất Tinh Gọn Phân Hệ Lập Lịch Mùa (Seasonal / Detailed)
Sau khi kiến trúc mới đã tách rời bảng nháp `seasonal_flight_drafts` và thiết lập cổng kiểm soát **Publish (Diff Viewer & Versioning)**:
1. **Bản thân CSDL Lịch Mùa đã là một Sandbox an toàn**:
   - Mọi bản ghi trong `seasonal_flight_drafts` hoàn toàn không can dự hay gây ảnh hưởng gì tới số liệu Vận hành (`operational_flight_legs`), Daily, Gate, Check-in hay Báo cáo sản lượng.
   - Do đó, việc duy trì thêm một tầng `draftState` trên RAM của trình duyệt là không còn cần thiết.
2. **Loại bỏ Save thủ công sau khi có receipt bền vững**:
   - Seasonal/Detailed ghi mutation nháp qua RPC có revision/field conflict. Có thể debounce, nhưng phải hiển thị trạng thái đang lưu/lỗi, flush hoặc chặn điều hướng và Publish khi chưa có receipt; không khẳng định “đã lưu” chỉ vì đã cập nhật React state.
   - Bỏ `draftState`/nút Save cũ **sau khi** import/export, undo/pairing, multi-client và xử lý lỗi mạng đã đi qua đường nháp mới; tính an toàn Publish không thay thế biên xác nhận import.
3. **Cổng Publish**:
   - Diff Viewer phân biệt thay đổi Planning và thao tác ghi/xóa Operations có hiệu lực; khi draft hoặc Daily scope thay đổi sau preview, commit trả stale và yêu cầu người dùng xem lại trước khi xác nhận.

### 11.3. Ranh Giới Bảo Toàn Tuyệt Đối (Inviolable Boundaries)
Để đảm bảo tính toàn vẹn hệ thống và an toàn vận hành, các cơ chế sau **BẮT BUỘC ĐƯỢC GIỮ NGUYÊN VẸN 100%**:
1. **Giữ nguyên Biên Xác Nhận Import (Import Confirmation Boundaries)**:
   - Quy trình nạp file SSIM/Excel Mùa và nạp file Daily AMS bắt buộc duy trì mô hình 2 bước an toàn: **Stage $\rightarrow$ Preview & Validation Diagnostics $\rightarrow$ Explicit User Commit**.
   - Tuyệt đối không nạp thẳng vào CSDL mà không có màn hình xem trước và xác nhận của người dùng.
2. **Bảo toàn Cơ chế Đồng Bộ, Pending & Báo Lỗi của các Module Vận Hành**:
   - Các phân hệ Vận hành (`daily`, `checkin`, `gate`) tiếp tục duy trì cơ chế theo dõi trạng thái đồng bộ (`SeasonSyncProvider`), quản lý xung đột thời gian thực (`ganttInteractionArbiter`), quản lý tài nguyên quầy/cửa bay và xử lý lỗi mạng/hàng đợi khi kết nối chập chờn.
3. **KHÔNG xóa bỏ các Tiện ích Dùng Chung Toàn Cục**:
   - Tiếp tục duy trì `useSeasonSyncGuard` và `syncActionButtonState.ts` trong codebase vì đây là các module shared thiết yếu cho phân hệ Vận hành, quản lý tiến trình thao tác tệp, hiển thị trạng thái nút bấm và cảnh báo điều hướng toàn hệ thống.
