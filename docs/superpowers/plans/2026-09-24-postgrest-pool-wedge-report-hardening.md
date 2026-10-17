# Kế hoạch: PostgREST pool wedge & hardening báo cáo traffic

Ngày: 2026-09-24
Trạng thái: Bước 1 (khôi phục dịch vụ) đã chạy và đã kiểm chứng; **M3.3 (ba điểm, hai file) + M3.4 (kèm hợp nhất mã lỗi ngân sách) đã sửa và đã kiểm chứng cục bộ** (§6, §9); M1, M2, M3.1, M3.2, M3.5, M3.6, M3.7 chờ triển khai. **Chưa có thay đổi nào lên Production.**

> **Quy ước thời gian.** Mọi mốc trong tài liệu này là **UTC**. Cảnh báo phương pháp: `docker logs --since/--until` của Docker CLI phân tích timestamp **không có offset** theo **múi giờ local của host (+07)**, trong khi container Kong in log theo **UTC**. Hai truy vấn đầu tiên trong quá trình điều tra đã lệch **7 giờ** vì lỗi này. Luôn dùng hậu tố `Z` (`--since 2026-09-24T03:25:00Z`). Đã xác minh: host `+0700`, container Kong `+0000`.

## 1. Sự cố

Hai triệu chứng cùng một gốc, trong khoảng **03:29–04:44 UTC ngày 2026-09-24**:

- **Trang report công khai** (`report.ahtops.xyz`): mọi endpoint `/api/report/*` trả `503` với `error_code: REPORT_TEMPORARILY_UNAVAILABLE` — "Báo cáo tạm thời chưa thể cập nhật. Vui lòng thử lại."; phần "Sản lượng Tổng quan" hiện "Không thể tải xu hướng".
- **Ứng dụng Desktop** (Check-in/Gate): alert đỏ "Check-in Update Failed … apply season server mutation: TypeError: Failed to fetch".

Nguyên nhân trực tiếp tại tầng API: PostgREST (`opsdata-supabase-rest`) trả `504` với thân JSON

```json
{"code":"PGRST003","details":null,"hint":null,"message":"Timed out acquiring connection from connection pool."}
```

cho **mọi** request, kể cả `GET /app_operators` và `rpc/get_public_dashboard_publication_version_v1`. Pool 10 kết nối bị chiếm dụng hoàn toàn; pha hỏng hoàn toàn kéo dài từ `03:42:12` đến `04:28:50`.

**Lưu ý phân biệt quan trọng:** `PGRST003` **không** tạo ra `TypeError: Failed to fetch`. Nếu check-in nhận `PGRST003`, `assertOk` (`app/src/lib/supabaseStore.ts:216`) sẽ ném chuỗi "Timed out acquiring connection from connection pool." và alert hiển thị đúng chuỗi đó. `Failed to fetch` là lỗi tầng transport (Cloudflare trả trang lỗi không có CORS header, ví dụ `error code: 504` đã bắt được lúc 03:57 UTC). Hai lỗi này là hai biểu hiện khác nhau của cùng một sự cố hạ tầng, không phải cùng một đường lỗi.

### 1.1. Bước 1 — đã thực hiện (khôi phục dịch vụ)

`docker restart opsdata-supabase-rest` lúc **04:28:50 UTC**. Sau restart:

| Kiểm tra | Kết quả |
| --- | --- |
| `GET https://supabase.ahtops.xyz/rest/v1/seasons?limit=1` | 200, 0.46 s |
| `GET /rest/v1/app_operators?user_id=eq.…` (service_role) | 200, 2.7 ms |
| `POST /rest/v1/rpc/get_public_dashboard_publication_version_v1` | 200, 2.7 ms |
| `GET https://report.ahtops.xyz/api/report/v1/timeline?from=2026-09-20&to=2026-09-23` | 200, 0.50 s, đủ dữ liệu |
| `pg_stat_activity` (role `authenticator`) | 3 kết nối, 0 active |

### 1.2. Chốt an toàn Bước 1 — ĐÃ XÁC MINH bằng dữ liệu Production

Đường ghi **đã được chứng minh hoạt động end-to-end qua HTTP sau restart**, bằng chính traffic vận hành thật (không cần chạy smoke test rủi ro):

| Bằng chứng | Giá trị |
| --- | --- |
| `season_mutation_receipts` sau `04:28:50 UTC` | **34 receipt** — `checkin` 31 (62 op) + `detailed` 3 (315 op) |
| `season_change_events` sau `04:28:50 UTC` | **377 event**, cùng client `client-a5df3916-295c-4c88-af85-e16316c04d35` / `quannv@operators.local.ahtops` |
| Khoảng thời gian | `04:44:04.077 UTC` → đang tiếp diễn |
| Grant của `apply_season_server_mutation_v1` | `SECURITY DEFINER`; `EXECUTE`: `service_role` ✓, `authenticated` ✓, `anon` ✗ (đúng thiết kế) |
| `server_seq` cuối | 56 223 (tại thời điểm khảo sát) |

- [x] **Xác minh đường ghi sau restart** — đóng bằng 34 mutation thật ở trên.
- [x] **Không có mutation nào đang bay tại thời điểm restart.** Đây là câu hỏi dạng CI790 (giao dịch commit nhưng client nhận lỗi, hoặc ngược lại). Log Kong trả lời trực tiếp: POST cuối cùng tới `/rpc/apply_season_server_mutation_v1` trước restart là **`04:02:13 UTC`** và nó nhận **`504`** — tức request **chưa từng vào tới PostgREST**, không có transaction nào được mở. Giữa `04:02:13` và `04:44:03` **không có POST nào**. Vì receipt được insert trong **cùng transaction** với event của nó (commit marker), một mutation bị restart cắt ngang sẽ rollback và **không để lại dấu vết nào trong sổ cái** — nên sổ cái một mình không đủ; chính log Kong là thứ đóng điểm này.
- [x] **Kiểm chứng an toàn của cursor `serverSeq` (bài kiểm tra đảo thứ tự).** `nextServerSeq` là `max(server_seq)` trên một cột IDENTITY toàn bảng, nên chỉ an toàn nếu **thứ tự cấp phát trùng thứ tự commit**. Đã quét toàn bộ 21 224 event: **0 lần đảo thứ tự** (`server_seq` tăng đơn điệu theo `created_at`). → `server_seq > lastSeen` là cursor an toàn; lỗ hổng `server_seq` **không** làm mất bản ghi.
- [x] **Đối chiếu sổ cái ghi ↔ event (bất biến toàn vẹn).** `sum(operation_count)` theo receipt phải bằng `count(*)` event trong cùng cửa sổ:
  - `03:30–03:34 UTC`: 2 receipt `seasonal` / **240 op** ↔ **240 event** (`03:31:34.848` → `03:32:51.382`) — khớp tuyệt đối.
  - Sau restart: 34 receipt / **377 op** ↔ **377 event** — khớp tuyệt đối.
  → **Không mất dữ liệu ở phía server** (sổ cái ↔ event khớp tuyệt đối). Phạm vi của kết luận này **chỉ là server**: nó **không** nói gì về hàng đợi modification phía client (mục `[ ]` ngay dưới), nên **không được** đọc thành "toàn hệ thống không mất dữ liệu" cho tới khi mục đó đóng. Giữ phép đối chiếu này như một bất biến, chạy lại sau mọi lần wedge.
- [x] **Hai pipeline import đều không dính.** `season_import_batches` và `daily_schedule_import_batches` **đều rỗng trong ngày** → các ghi nguồn `daily`/`seasonal` đi **thẳng** qua `apply_season_server_mutation_v1`, không qua pipeline batch. Không có import nào bị kẹt hay mất.
- [ ] **KHÔNG chạy smoke test mutation trong transaction rollback.** `season_change_events.server_seq` là `GENERATED ALWAYS AS IDENTITY` (`public.season_change_events_server_seq_seq`, `is_identity = YES`, `column_default` rỗng), không phải `max()+1`. `nextval` không tham gia transaction → `BEGIN … ROLLBACK` vẫn **đốt** giá trị sequence và để lại lỗ hổng vĩnh viễn.
- [ ] **Xác minh hàng đợi phía client** (cần máy điều hành viên): xác nhận các modification đặt trong `03:50–04:02 UTC` (12 lần thử thất bại) còn nằm trong SQLite local (`pendingCount`) và đã được flush sau `04:44`, hoặc đã được ghi lại thủ công. Phần duy nhất của sự cố nằm ngoài tầm với của server.

### 1.3. Cửa sổ ảnh hưởng chính xác

Hai nguồn độc lập khớp nhau: sổ cái commit (`season_mutation_receipts`/`season_change_events`) và log Kong.

| Thời điểm UTC | Sự kiện |
| --- | --- |
| 03:26 – 03:32 | Vận hành bình thường: check-in, `daily` (3 op), **hai batch `seasonal` 120 op** commit lúc `03:31:34` và `03:32:51` (240 event) |
| 03:29 | 499 đầu tiên (1) |
| **03:37:00** | Pool nhảy từ rảnh → **10/10** (`backend_start`); **7×499** lúc `03:37:31`; 8 mutation check-in **vẫn commit thành công** trong phút này |
| **03:42:12** | **`504` PGRST003 đầu tiên** trên `/rpc/apply_season_server_mutation_v1` |
| 03:42 – 03:44 | Ghi vẫn thành công xen kẽ với 504 |
| **03:44:00.48** | Mutation commit thành công **cuối cùng** (Kong `POST 200` và receipt khớp nhau) |
| **03:50:22 – 03:53:09** | **12 lần thử ghi thất bại, nhịp đúng 10 giây** (03:50:22, :32, :43, :53, 03:51:03, :13, :24, :34, :44, 03:52:59, 03:53:09) |
| 04:02:13 | Lần thử thất bại cuối cùng |
| 04:02:13 – 04:44:03 | Client **bỏ cuộc** — 42 phút không có POST nào |
| **04:28:50** | `docker restart opsdata-supabase-rest` |
| **04:44:04** | `POST 200` đầu tiên; ghi trở lại bình thường |

**Nhịp 10 giây chính là bằng chứng cơ chế.** Khoảng cách giữa các lần thử thất bại bằng đúng `db-pool-acquisition-timeout` (10 s): mỗi lần thử đốt trọn cửa sổ chờ slot rồi bị trả `PGRST003`, client thử lại ngay, và vòng lặp đó chỉ dừng khi client bỏ cuộc.

### 1.4. Lưu lượng trong cửa sổ sự cố (log Kong, 03:25–04:55 UTC)

| Request | Kết quả |
| --- | --- |
| `rpc/get_season_schedule_allocation_window_v2` | **592 × 200**, 4 × 504 — lưu lượng lớn nhất |
| `rpc/apply_season_server_mutation_v1` | 43 × 200, **13 × 504** |
| `rpc/get_public_dashboard_publication_version_v1` | 47 × 200, 45 × 499 |
| `rpc/get_public_traffic_report_v2` | **40 × 499**, 7 × 200 |
| `rpc/get_public_traffic_report_overview_v1` | **33 × 499** |
| `audit_entries` / `audit_delta_chunks` / `audit_sessions` | 43 / 43 / 42 × 201–200 (pipeline audit vẫn ghi được) |
| `app_operators` | 15 × 200, **12 × 504** |
| `seasons?limit=1` | 2 × 504 |
| `rpc/get_public_annual_passenger_kpi_v1` / `_version_v1` / `_config_v1` | 6 / 7 / 2 × 499 |

Hai kết luận rút ra: (a) **đường ghi bị ảnh hưởng thật** — 13 × 504 trên mutation RPC, 12 × 504 trên `app_operators`; (b) toàn bộ 499 tập trung ở các RPC báo cáo/KPI, tức **đường đọc nặng là nguồn chiếm slot**.

## 2. Bằng chứng đã xác minh

Mục này trộn **đo đạc** và **suy luận**; mỗi dòng ghi rõ loại. Không có dòng nào là phỏng đoán không nhãn.

| # | Loại | Dữ kiện | Nguồn |
| --- | --- | --- | --- |
| 1 | đo | **Log request của PostgREST là error-only.** Ba request 200 gọi sau restart (04:29–04:36 UTC) **không** sinh dòng request nào trong `docker logs opsdata-supabase-rest`; log chỉ có `PGRST003`. Nguyên nhân: `log-level` mặc định `"error"` (xác nhận bằng `postgrest --example`). | `docker logs`, `postgrest --example` |
| 2 | đo | **Log của Kong thì đầy đủ** (ghi cả 200 của `apply_season_server_mutation_v1`). Xem §1.4 cho bảng phân bố trong cửa sổ sự cố. | `docker logs opsdata-supabase-kong` |
| 3 | đo | **Hiện không có caller lạ.** Trong netns của PostgREST chỉ có 2 kết nối vào `:3000`, cả hai từ Kong `10.0.2.13`. Các socket loopback `127.0.0.1:3000` thấy trước đó thuộc `lnf-api` (docker-proxy publish), **không liên quan** PostgREST. | `nsenter -t <pid> -n ss -tn` |
| 4 | đo | `opsdata-traffic-report-rest-staging` (`10.0.2.6`) là **PostgREST thứ hai trỏ vào DB Production**, nhưng chỉ có 1 kết nối listener 4 ngày — không phải nguồn gây tải. Nợ vệ sinh hạ tầng. | `docker inspect`, `pg_stat_activity` |
| 5 | đo | **Không có vòng reload config.** PostgREST không ghi sự kiện `Connection Pool initialized` / `schema cache reload` nào trong cửa sổ sự cố. | `docker logs` |
| 6 | đo | **Không có vòng lặp query hoàn tất.** `pg_stat_statements` (reset 2026-09-10): biến thể v2 đầy đủ 474 calls, mean 3668 ms (tổng 1 738 680 ms); 115 calls @ 560 ms; 254 calls @ 39 ms. | `pg_stat_statements` |
| 7 | đo | `track_functions = none` → không có bộ đếm cấp function để đối chiếu thêm. | `SHOW track_functions` |
| 8 | đo | **Thời điểm suy giảm:** nginx giữ đúng **1 request/phút** tới hết phút 10:36 +07, rồi **13 request trong phút 10:37 +07**; Kong ghi **7×499** lúc **03:37:31 UTC**; toàn bộ 10 backend của pool được tạo lúc **03:37:00 UTC**. Cùng phút 03:37:00 còn có **8 mutation check-in** thành công. | `nginx access.log`, Kong log, `backend_start`, `season_mutation_receipts` |
| 9 | đo | **Isolate của edge bị kill theo wall-clock.** `opsdata-traffic-report-edge` ghi liên tục `wall clock duration warning` + `early termination has been triggered`. Chuỗi trong binary `edge-runtime` v1.74.0 xác nhận supervisor có `wall clock duration warning` / `wall clock duration reached`; **không có CLI flag, không có biến `EDGE_RUNTIME_*`, không có key `wallClock*`** để chỉnh ngưỡng này → **ngân sách wall-clock là hằng số nội bộ, không tinh chỉnh được**. | `docker logs`, `strings` binary, `edge-runtime start --help` |
| 10 | đo | **Trạng thái pool lúc wedge:** cả 10 backend `active`, `wait_event` rỗng, transaction/query **mới tinh** ở cả 3 lần lấy mẫu trong ~25 phút; **đúng 10 PID đó tồn tại từ 03:59 đến 04:23 UTC — 46 phút, vượt qua cả `db-pool-max-lifetime = 1800` (30 phút) mà không hề bị recycle.** | `pg_stat_activity` |
| 11 | đo | `get_public_traffic_report_v2` một lượt (2026-09-01…2026-09-23, scope `full`): **2 508 ms, 150 646 buffer pages**. | `EXPLAIN (ANALYZE, BUFFERS)` |
| 12 | đo | **Blackout ghi:** receipt cuối trước blackout `03:44:00.48 UTC`, receipt kế tiếp `04:44:04.08 UTC`. Trong đó: 6 phút im lặng (03:44→03:50), 12 lần thử thất bại nhịp 10 s (03:50:22→03:53:09), 1 lần nữa (04:02:13), rồi 42 phút client bỏ cuộc. | `season_mutation_receipts`, Kong log |
| 13 | **suy luận** | Hai batch `seasonal` 120 op cho thấy **hình dạng workload** ghi nặng tồn tại. **Thời gian giữ slot chưa được đo**, và vì `created_at` của receipt là **commit marker**, hai batch này đã nhả slot lúc `03:31:34`/`03:32:51` — **4 phút 9 giây trước khi pool bị ghim ở 03:37:00**, nên **không thể** là nguồn đồng thời tại 03:37:00. | `season_mutation_receipts` |
| 14 | đo | **Một batch nặng đã rollback giữa vòng lặp.** Lúc `02:42:44 UTC`, `server_seq` nhảy `55 453 → 55 570` — **một dải liền mạch 117 giá trị bị đốt**. Đây là lỗ hổng **duy nhất trong ngày** và nằm **trước** sự cố. Chứng minh một transaction đã insert ~117 event rồi abort. (Không chứng minh được có retry: một abort không để lại receipt.) | `season_change_events` |
| 15 | đo | **Không có transaction mutation nào chạy trong blackout.** Trong `03:37–04:44` có **0 receipt, 0 event, và 0 giá trị `server_seq` bị đốt**. Các lần thử thất bại chết ở tầng giành slot (`PGRST003`) nên chưa từng insert. | `season_mutation_receipts`, `season_change_events` |
| 16 | đo | **Không có lần đảo thứ tự `server_seq`.** 0 vi phạm trên toàn bộ 21 224 event → thứ tự cấp phát trùng thứ tự commit. | `season_change_events` |
| 17 | đo | **Đối chiếu sổ cái ↔ event khớp tuyệt đối**: 240 op ↔ 240 event (03:30–03:34); 377 op ↔ 377 event (sau restart). | `season_mutation_receipts`, `season_change_events` |

## 3. Kết luận nguyên nhân

**Nguyên nhân chính (độ tin cậy cao).** Pool 10 slot bị chiếm dụng liên tục và không tự hồi phục.

1. **Kích hoạt.** Lúc `03:37:00` pool bị ghim ở 10/10. Nhu cầu đồng thời cùng lúc gồm lưu lượng đọc nặng (`get_season_schedule_allocation_window_v2` 592 lần trong cửa sổ; `get_public_traffic_report_v2` mean 3.7 s) và burst ghi check-in (8 mutation trong phút đó). Các 499 đầu tiên xuất hiện từ `03:29`, và **7×499 lúc `03:37:31`**.
2. **Vách đá ở `03:42:12`.** `504` PGRST003 đầu tiên. Từ đây mọi request phải chờ hết 10 s rồi bị trả về lỗi.
3. **Sập tự duy trì.** Bằng chứng cơ chế nằm ở nhịp: 12 lần thử ghi thất bại cách nhau **đúng 10 giây** (`03:50:22` → `03:53:09`). Mỗi lần thử đốt trọn `db-pool-acquisition-timeout`, client thử lại ngay, hàng đợi không bao giờ rút cạn. Client bỏ cuộc lúc `04:02:13`; chỉ restart PostgREST lúc `04:28:50` mới giải phóng pool, ghi trở lại lúc `04:44:04`.

**Điều KHÔNG phải nguyên nhân (đã loại trừ bằng bằng chứng):**

- **Caller lạ tần số cao.** Loại trừ: dữ kiện #2 (mọi request report đều từ edge `10.0.2.7`), #3 (socket chỉ có Kong), #15 (0 transaction mutation trong blackout). Không có caller nào ngoài đường Kong đã điều tra.
- **Batch `seasonal` giữ slot tại 03:37:00.** Loại trừ: dữ kiện #13 — receipt là commit marker, hai batch đã nhả slot 4 phút 9 giây trước đó.
- **Khóa hàng `seasons`.** Loại trừ: `apply_season_server_mutation_v1` có `perform 1 from public.seasons … for update`, nhưng dữ kiện #10 cho thấy `wait_event` rỗng ở cả 3 lần lấy mẫu — chờ khóa sẽ hiện `Lock`.
- **Rò rỉ kết nối / connection leak.** Loại trừ: dữ kiện #15 — các lần thử chết ở tầng giành slot, không mở transaction nào.
- **Query treo dài.** Loại trừ: dữ kiện #10 — `xact_start`/`query_start` **mới tinh ở mọi lần lấy mẫu**, không có transaction dài nào giữ slot.

**Vì sao các knob pool hiện tại không cứu được.** Dữ kiện #10 trả lời trực tiếp: cùng 10 PID tồn tại **46 phút**, vượt `db-pool-max-lifetime = 1800` (30 phút) mà **không hề bị recycle**. `max-lifetime` và `max-idletime` chỉ recycle một kết nối **đã được trả về** pool; các kết nối này bị checkout liên tục suốt wedge nên không knob nào chạm tới. Tăng `db-pool` lên 25 chỉ **dịch vách đá** từ 10 sang 25. → **Chữa gốc phải là giảm thời gian mỗi request (M3), không phải tinh chỉnh pool (M2).**

**Bốn ngân sách xếp chồng — và cái ngắn nhất là của chính edge (8 s).**

| Ngân sách | Giá trị | Nguồn |
| --- | --- | --- |
| `postgrestRpc` timeout nội bộ của edge | **8 s** | `AbortSignal.timeout(8_000)` — `app/supabase/functions/traffic-report/index.ts:202,217` |
| `db-pool-acquisition-timeout` | 10 s | `postgrest --dump-config` |
| `nginx proxy_read_timeout` | 10 s | nginx conf |
| `edge-runtime --request-wait-timeout` | 10 000 ms | `edge-runtime start --help` |

Mặc định 8 s áp cho **mọi** RPC report; ngoại lệ duy nhất là HTML export (`35_000` ms, dòng 912).

**Đảo ngược ngân sách ở đúng đường tốn kém nhất.** HTML export là đường **duy nhất** được nới lên 35 s — và đó cũng là đường nặng nhất (một RPC `get_public_traffic_html_export_v2` trả cả báo cáo). 35 s **dài hơn cả bốn ngân sách còn lại** (10 s).

Cơ chế chính xác — **hai trạng thái khác nhau, chỉ một trạng thái bị ảnh hưởng:**

- **Request đang xếp hàng chờ slot (chưa có kết nối).** Ở trạng thái này request **không giữ** slot nào, và PostgREST tự bỏ cuộc ở `db-pool-acquisition-timeout` (10 s) với `PGRST003` — **trước** mốc 35 s. Ngân sách 35 s **không bao giờ chạm tới** ở trạng thái này. Đây là lý do phát hiện ở dòng dưới (§3 "Hệ quả ngược") vẫn đúng nguyên: edge abort ở 8 s nên không thấy `PGRST003`.
- **Request đã giành được kết nối và đang chạy truy vấn.** Đây mới là chỗ ngân sách 35 s gây hại: truy vấn HTML nặng giữ **kết nối đã cấp phát** tới 35 s, trong khi nginx đã bỏ cuộc ở 10 s, `edge-runtime` đã bỏ cuộc ở 10 000 ms và client đã đóng kết nối. Khoảng còn lại là **chiếm dụng xác sống** (zombie occupancy) trên chính truy vấn nặng nhất — đúng cơ chế khuếch đại của §3.
  - **Chiếm dụng kết nối phía server là một công thức, không phải một con số.** `statement_timeout='30s'` (`20260906120000_public_traffic_html_pivot_v2.sql:223`) tính **từ lúc statement tới PostgreSQL**; thời gian chờ giành kết nối (`db-pool-acquisition-timeout`, 10 s) nằm **ngoài** 30 s đó. Vậy:
    - Chiếm dụng kết nối tính từ lúc request vào = `t_acq + min(t_query, 30)`, với `t_acq < 10` → **trần ~40 s**.
    - Cửa sổ chiếm dụng vô ích sau mốc caller bỏ cuộc (~10 s) = `t_acq + min(t_query, 30) − 10` → **trần ~30 s**. Con số `~25 s` (kịch bản `t_acq ≈ 5`) và `~20 s` (kịch bản `t_acq ≈ 0`) đều chỉ là **một điểm trong khoảng**, không phải trần — đừng chốt số nào làm trần.
  - **Câu hỏi mở chưa đo: client abort ở 35 s có huỷ được truy vấn đang chạy phía PostgREST/PostgreSQL không?** Nếu **không**, kết nối bị giữ tới hết `min(t_query, 30)`; nếu **có**, ngân sách 35 s lại là yếu tố quyết định thời điểm nhả. Đưa vào M1 để đo, **không** kết luận theo hướng nào ở đây.
  - Điều **chắc chắn**, không phụ thuộc câu hỏi mở trên: 35 s **không phục vụ ai** sau mốc ~10 s — nginx, `edge-runtime` và client đều đã bỏ cuộc trước đó. Đó là toàn bộ cơ sở của M3.7.

Đây là **giả thuyết có thể đo được**, không phải kết luận. Phép đo phải nhắm vào **thời gian chiếm dụng của truy vấn đang chạy** (`pg_stat_activity` so tuổi `query_start` với các ngân sách 10 s của người gọi), **không** phải thời gian chờ giành slot — xem mục đo ở M1 (§4) và §8.

Ngoài đường HTML export, mọi đường báo cáo đều chết ở 8 s — và 8 s là ngân sách **ngắn nhất** trong bốn, nên edge tự abort trước khi PostgREST kịp trả lỗi.

Hệ quả **ngược** với cách diễn giải "ba ngân sách 10 giây": khi pool cạn, PostgREST chỉ trả `PGRST003` sau 10 s, nhưng edge **tự abort ở 8 s** — nên edge **không bao giờ nhìn thấy `PGRST003`**, nó chỉ nhận `TimeoutError`. Đây chính là cơ chế sinh ra 499 hàng loạt ở Kong (§1.4), và cũng là lý do chuỗi `PGRST003` của `assertOk` không hề xuất hiện trên đường báo cáo. **Đã đo lại bằng thực nghiệm** trên chính module edge: upstream treo → abort ở **8021 ms / 8031 ms** và trả `503` (§9).

Vì vậy "phân biệt mã lỗi" ở M3.4 phải nhận diện **cả** `TimeoutError` (đường thực sự xảy ra) **lẫn** thông điệp cạn pool (đường sẽ xảy ra nếu ngân sách 8 s được nới). M2 vẫn đúng ở kết luận "nới `db-pool-acquisition-timeout` một mình là vô hiệu" — nhưng lý do chính xác hơn: nới nó lên mà **không** nới ngân sách 8 s của edge thì edge vẫn abort trước, và mọi thứ giữ nguyên.

## 4. M1 — Instrumentation & forensics tái diễn

Mục tiêu: lần sau tái diễn phải **đo được** thay vì suy luận.

- [ ] **Bật log request thành công của PostgREST**: `PGRST_LOG_LEVEL: info` cho service `rest` trong `/home/ops/opsdata-supabase/docker-compose.yml` (tạm thời, để điều tra tái diễn). Điều kiện tiên quyết — hiện tại **không thể** biết trong cửa sổ sự cố có bao nhiêu request report **thành công** (dữ kiện #1).
- [ ] **Bộ lấy mẫu `pg_stat_activity`**: timer systemd (10–15 s/lần) ghi `pid, state, xact_start, query_start, wait_event_type, wait_event, client_addr, application_name, left(query,200)` vào file xoay vòng.
- [ ] **Bộ đếm delta `pg_stat_statements`** theo cửa sổ. Lưu ý: **statement bị cancel không được ghi vào `pg_stat_statements`** — đó là lý do 474 calls "hoàn tất" trong 14 ngày không mâu thuẫn với 40 × 499.
- [ ] **Đo độ sâu fan-out và số worker của edge** thay vì truy tìm caller ngoài: đếm số RPC song song mỗi request trong `app/supabase/functions/traffic-report/index.ts`, và ghi lại `edge-runtime --policy` (mặc định `per_worker`) cùng số worker thực tế. Đây là biến **đo được trên máy sẵn có**.
- [ ] **Đo thời gian giữ slot của một batch `seasonal` nhiều operation.** Không thể suy ra từ `created_at` của receipt (đó chỉ là commit marker). Dùng `pg_stat_activity.xact_start` lấy mẫu trong lúc batch chạy, hoặc `EXPLAIN (ANALYZE)` trên `apply_season_server_mutation_v1` với payload 120 op. Nếu giữ slot hàng chục giây → **giới hạn kích thước batch** hoặc xếp hàng riêng.
- [ ] **Đo ngân sách wall-clock của edge bằng thực nghiệm**: bắn một request report dài trên staging, ghi lại mốc thời gian xuất hiện `wall clock duration warning` / `early termination`, từ đó suy ra ngân sách hiệu dụng và định cỡ page cap cho M3. (Không có knob nào để tăng ngân sách — dữ kiện #9.)
- [ ] **Đo HTML export (`35_000` ms, dòng 912) đối chiếu với ngân sách 10 s của nginx/edge-runtime** (§3): bắn một HTML export trên khoảng ngày lớn nhất được phép, ghi lại thời gian phản hồi thực và thời điểm client/nginx bỏ cuộc. Câu hỏi cần trả lời: HTML export có **thực sự** vượt 10 s trong điều kiện bình thường không? Nếu có → ngân sách 35 s đang giữ **kết nối đã cấp phát** vô ích và phải hạ về dưới ngân sách ngắn nhất; nếu không → 35 s chỉ là trần phòng hờ và rủi ro thấp hơn. **Phép đo phải là thời gian chiếm dụng của truy vấn đang chạy** (tuổi `query_start` trong `pg_stat_activity` lấy mẫu trong lúc request bay), **không** phải thời gian chờ giành slot — request đang xếp hàng chờ slot không giữ slot nào và bị `PGRST003` cắt ở ~10 s (§3). Đây là dữ kiện quyết định cho M3.7.
- [ ] **Cảnh báo sớm**: alert khi số kết nối `state = 'active'` của role `authenticator` ≥ 8 trong ≥ 60 s, hoặc khi xuất hiện `PGRST003`/`504`. Gắn vào adapter cảnh báo sẵn có `/usr/local/sbin/seasonal-traffic-dashboard-alert`.
- [x] **Ghim danh tính writer liên tục**: `client-a5df3916-295c-4c88-af85-e16316c04d35` / **`quannv@operators.local.ahtops`** là client desktop duy nhất ghi trong ngày — 178 receipt, cả bốn nguồn (`checkin` 172, `detailed` 3, `seasonal` 2, `daily` 1), từ `03:05:42` tới `06:23:20 UTC` đang tiếp diễn. Đây là đầu mối duy nhất cho câu hỏi "caller chưa định danh".
- [ ] **Vệ sinh hạ tầng (dữ kiện #4)**: tách `opsdata-traffic-report-rest-staging` khỏi DB Production, hoặc ghi rõ chủ ý nếu giữ nguyên.

## 5. M2 — Cấu hình pool & timeout

Key dưới đây đã được **kiểm chứng bằng `postgrest --dump-config`** trên đúng image `postgrest/postgrest:v14.12` đang chạy Production (env override → giá trị xuất hiện trong dump). Ba tên key từng bị ghi sai trong báo cáo trước và **sẽ làm PostgREST từ chối khởi động** (giết luôn biện pháp restart) đã được sửa:

| Key config | Biến môi trường | Mặc định hiện tại | Đề xuất |
| --- | --- | --- | --- |
| `db-pool` | `PGRST_DB_POOL` | 10 | **25** |
| `db-pool-acquisition-timeout` | `PGRST_DB_POOL_ACQUISITION_TIMEOUT` | 10 | **5** |
| `db-pool-max-lifetime` | `PGRST_DB_POOL_MAX_LIFETIME` | 1800 | 3600 |
| `db-pool-max-idletime` | `PGRST_DB_POOL_MAX_IDLETIME` | 30 | 600 |
| `db-pool-automatic-recovery` | `PGRST_DB_POOL_AUTOMATIC_RECOVERY` | true | true (giữ nguyên) |
| `log-level` | `PGRST_LOG_LEVEL` | `"error"` | `info` (thuộc M1) |

Ba tên **sai** không được dùng: `PGRST_DB_POOL_TIMEOUT`, `PGRST_DB_POOL_ACQUIRE_TIMEOUT`, `PGRST_DB_POOL_MAX_IDLE`.

- [ ] Áp cấu hình vào service `rest` trong `/home/ops/opsdata-supabase/docker-compose.yml`, rồi `docker compose up -d rest`.
- [ ] Xác nhận bằng log khởi động: `Connection Pool initialized with a maximum size of 25 connections` (hiện tại ghi `10`). **Nếu container không lên, key sai tên — kiểm tra ngay bằng `--dump-config`.**
- [ ] Kiểm tra ngân sách kết nối: `max_connections = 100`, hiện dùng ~44. Xác nhận lại `pg_stat_activity` ngay trước và sau khi đổi.
- [ ] **Ghi rõ giới hạn:** M2 là **defense-in-depth**, không phải chữa gốc (§3). Tăng pool chỉ dịch vách đá; và vì `db-pool-max-lifetime`/`max-idletime` **không recycle được kết nối đang bị checkout** (dữ kiện #10), M2 **không có cơ chế phục hồi** nếu sự cố lặp lại y hệt.
- [ ] **Thang timeout phải dịch chuyển cùng nhịp, không phải một knob đơn lẻ.** Ba ngân sách 10 s xếp chồng (§3) nghĩa là nới `db-pool-acquisition-timeout` một mình sẽ vô hiệu. Thứ tự đúng: `db-pool-acquisition-timeout` (5 s) **<** `nginx proxy_read_timeout` **<** ngân sách wall-clock của edge — hoặc để edge **tự shed/queue tại biên của nó** thay vì fan-out vào một pool đã bão hoà.
- [ ] **Không** đặt `statement_timeout` toàn cục cho role `authenticator`: role này cũng dùng cho các luồng dài. Nếu cần, làm qua `db-pre-request` **có điều kiện theo path** và chỉ áp cho RPC report.

## 6. M3 — Hiệu năng báo cáo & sức chịu của edge

Đây là **chữa gốc** (§3): giảm thời gian mỗi request để pool không bao giờ cạn.

- [ ] **Giảm thời gian `get_public_traffic_report_v2`** (hiện 2 508 ms / 150 646 buffer pages cho 23 ngày, scope `full`). Rà `EXPLAIN (ANALYZE, BUFFERS)` từng nhánh, bổ sung composite index trên các bảng nguồn (`season_flight_records`, `daily_schedule_effective_records_v1`, `season_modifications`) theo `(scheduled_date, status)` và các cột lọc thực tế. Mục tiêu: < 300 ms cho scope `full`.
- [ ] **Chặn trần công việc cho mỗi request**: bốn vòng fan-out tuần tự — `fetchWorkbookOverview` tới 25 trang (dòng 476), `fetchWorkbookDimension` tới 25 trang (dòng 505), nhánh `dimension-export` tới 25 trang (dòng 1171) trong `app/supabase/functions/traffic-report/index.ts`; và `TrafficReportTrend.tsx:147` lặp tới 50 trang tuần tự ở client. Đổi sang **page/row cap cứng + trả dữ liệu một phần kèm con trỏ** (`timeline_next_cursor` đã có trong contract) khi chạm ngân sách. Định cỡ cap theo ngân sách wall-clock **đo được** ở M1 — không đoán.
  - Số học đã biết (suy ra từ hằng số trong mã, không phải phỏng đoán): 25 trang × ngân sách 8 s/RPC = **tới 200 s** cho một request, trong khi ngân sách wall-clock của edge **ngắn hơn nhiều** (§3). Nghĩa là fan-out hiện tại **không thể** hoàn tất ở worst case, và mỗi trang bị abort vẫn **đốt một slot pool** trước khi chết — đúng cơ chế khuếch đại của §3.
  - Vì vậy M3.2 **vẫn chờ M1**: cần ngân sách wall-clock thực tế để chọn cap, thay vì đoán một con số.
- [x] **Sửa đường v1 bỏ `payload.error`** — ba điểm, hai file:
  - `TrafficReportTrend.tsx:159` (xu hướng): `if (!response.ok) throw new Error(payload?.error ? String(payload.error) : 'Không thể tải xu hướng. Vui lòng thử lại.');`
  - `TrafficReportDimensionSection.tsx:112` (bảng dữ liệu) và `:142` (tỷ trọng): cùng khiếm khuyết, `result` ở đây là `unknown` nên dùng thu hẹp `'error' in result` — **đúng mẫu đã có sẵn** ở `TrafficReportClient.tsx:179`, `TrafficWorkbookExportDialog.tsx:178`, `AnnualPassengerKpiDashboard.tsx:376,386,399`.
  - Ở `:142` điều kiện gộp cũ `!response.ok || !isTrafficDimensionResponse(result)` được tách làm hai để giữ nguyên hành vi cho nhánh sai hình dạng payload.
  - **Đã kiểm chứng cục bộ** (§9).
- [x] **Phân biệt mã lỗi ở edge**: nhánh generic tại `app/supabase/functions/traffic-report/index.ts` map mọi lỗi không khớp regex thành `503 REPORT_TEMPORARILY_UNAVAILABLE`. Đã thêm nhánh `REPORT_BACKEND_BUSY` + `Retry-After: 5` cho `TimeoutError` và các thông điệp cạn pool/đứt kết nối — nhận diện **cả hai** đường vì đường thực sự xảy ra là `TimeoutError` 8 s, không phải `PGRST003` (§3). **Đã kiểm chứng cục bộ** (§9).
  - **Kèm theo — ba điểm ném lỗi ngân sách bị phân loại sai.** Ba chỗ dùng **cùng một khái niệm** nhưng viết hai kiểu: `index.ts:708` ném mã trần `'WORKBOOK_RESOURCE_BUDGET_EXCEEDED'` (được nhánh riêng bắt → `413`), còn `:492`, `:526`, `:1182` ném chuỗi văn xuôi `'… exceeds resource budget'`. Ba chuỗi sau **rơi vào regex `exceed`** của nhánh generic → trả `400 INVALID_REPORT_FILTER` "Bộ lọc báo cáo chưa hợp lệ" — tức báo cho người vận hành rằng **bộ lọc sai**, trong khi sự thật là **phạm vi quá lớn**, và gắn `retryable: false` cho một tình huống thu hẹp kỳ rồi thử lại được. Đã hợp nhất về một mã: ba điểm ném `'WORKBOOK_RESOURCE_BUDGET_EXCEEDED: <nguồn>'`, nhánh bắt đổi từ `===` sang `startsWith`. **Đã kiểm chứng cục bộ bằng A/B** (§9.3).
  - **Lỗ hổng còn lại ở cùng nhánh catch (CHƯA sửa).** Regex generic `/invalid|unsupported|must|required|cardinality|outside|provided|exceed/i` vẫn bắt nhóm lỗi **nội bộ hợp đồng** — `'invalid workbook overview payload'`, `'invalid workbook timeline payload'`, `'invalid workbook timeline cursor'`, `'invalid dimension payload'`, `'invalid dimension export payload'` — và trả `400 INVALID_REPORT_FILTER` + `retryable: false`. Đó là lỗi RPC trả sai hình dạng, **không phải** lỗi bộ lọc của người dùng. Không sửa ngay vì regex này **cũng** đang bắt đúng các lỗi thật của `normalizeRequest` (`invalid type`, `invalid comp`, `invalid sort`, `invalid metric`, `invalid granularity`, `invalid read_version`, `… requires from and to`) — sửa đúng đòi hỏi tách hai nguồn lỗi (ví dụ mã lỗi có tiền tố riêng cho lỗi hình dạng payload), tức là một thay đổi thiết kế vượt phạm vi M3.4. Ghi nhận ở đây để không bị coi là đã đóng.
- [ ] **Rà cache nginx** (`/etc/nginx/conf.d/traffic-report.conf`): `proxy_cache_valid any 0` nghĩa là `503` **không bao giờ** được cache → mọi lần retry đập thẳng vào edge. Cân nhắc negative caching ngắn (2–5 s) cho `503`, và `proxy_cache_use_stale` khi backend bận.
- [ ] **Backoff có jitter ở client**: wallboard poll 60 s và dashboard runner 15 phút hiện retry không jitter. Nhịp 10 giây quan sát được ở §1.3 chính là kiểu dồn hàng cần chặn.
- [ ] **M3.7 — Đưa ngân sách HTML export (`35_000` ms, dòng 912) về dưới ngân sách ngắn nhất** (§3): hiện 35 s dài hơn cả bốn ngân sách 10 s. Cơ chế gây hại nằm ở trạng thái **truy vấn đã giành được kết nối nhưng chạy lâu**. Chiếm dụng kết nối phía server = `t_acq + min(t_query, 30)`, trần **~40 s** kể từ lúc request vào (`t_acq < db-pool-acquisition-timeout` 10 s; `statement_timeout='30s'` tại `20260906120000_public_traffic_html_pivot_v2.sql:223` tính từ lúc statement tới PostgreSQL, **không** gồm thời gian chờ slot). Cửa sổ vô ích sau mốc caller bỏ cuộc (~10 s) vì vậy có trần **~30 s** — đừng chốt `~25 s` hay `~20 s` làm trần, cả hai chỉ là một điểm trong khoảng. (Khi request còn đang **xếp hàng chờ slot** thì ngân sách 35 s không bind — `PGRST003` cắt ở ~10 s.) **Chờ số đo ở M1 trước khi đổi** — nếu HTML export bình thường vẫn dưới 10 s thì hạ trần xuống dưới ngân sách ngắn nhất là thay đổi thuần lợi; nếu nó thường xuyên vượt 10 s thì phải xử lý ở tầng khác (chunk/tác vụ nền) chứ không chỉ hạ số. **Câu hỏi mở cần đo ở M1:** client abort ở 35 s có huỷ được truy vấn phía server không — câu trả lời quyết định việc hạ trần có thực sự rút ngắn cửa sổ chiếm dụng hay không.

## 7. Thứ tự thực hiện

1. ~~**Chốt an toàn Bước 1** (§1.2)~~ — **ĐÃ XONG**: 34 mutation thật commit sau restart, không có mutation nào đang bay tại thời điểm restart, cursor `serverSeq` đã kiểm chứng an toàn, đối chiếu sổ cái ↔ event khớp tuyệt đối.
2. **M3 (chữa gốc) song song với M1** — hạ thời gian `get_public_traffic_report_v2` + chặn trần công việc mỗi request. Đây là thứ duy nhất thực sự ngăn tái diễn: M2 đã chứng minh không có knob pool nào recycle được kết nối đang bị checkout.
   - **M3.3 + M3.4 đã sửa xong và đã kiểm chứng cục bộ** (§9.2, §9.3) — **trong worktree, chưa lên Production**; chờ triển khai theo §9.4. M3.3 nay là **ba điểm / hai file** (thêm `TrafficReportDimensionSection.tsx:112,142`), M3.4 kèm **hợp nhất mã lỗi ngân sách** ở ba điểm ném.
   - M3.1 (hạ thời gian RPC) và M3.2 (cap công việc) **vẫn chờ M1** để định cỡ theo số đo, không đoán.
3. **M1** — bật `PGRST_LOG_LEVEL=info`, sampler, cảnh báo sớm, đo fan-out của edge và chi phí batch `seasonal`.
4. **M2** — áp 5 key pool đã kiểm chứng, như **defense-in-depth** và theo thang timeout dịch chuyển cùng nhịp.

## 8. Mục còn mở

- Cơ chế giữ slot chính xác trong `03:42:12–04:28:50` (kết nối bị checkout liên tục mà vẫn quay vòng transaction ngắn) — cần M1 mới đo được. Đây là **phần duy nhất của nguyên nhân chính** chưa đóng.
- **Ngân sách 35 s của HTML export có thực sự bị dùng không** (§3, M3.7): nếu HTML export thường xuyên vượt 10 s thì đây là một cơ chế chiếm dụng **độc lập** với nguyên nhân chính — nhưng chỉ ở trạng thái **truy vấn đã giữ kết nối và chạy lâu** (chiếm dụng `t_acq + min(t_query,30)`, trần ~40 s từ lúc request vào; cửa sổ vô ích sau mốc 10 s trần ~30 s), và nó chỉ ảnh hưởng đường HTML export, không giải thích được wedge của các RPC 8 s. Chờ số đo ở M1, và đo bằng **tuổi truy vấn đang chạy**, không phải thời gian chờ giành slot. Kèm một câu hỏi mở phải đo cùng: client abort ở 35 s có huỷ được truy vấn phía server không.
- Ngân sách wall-clock thực tế của edge — chờ đo thực nghiệm (M1).
- Thời gian giữ slot của batch `seasonal` nhiều operation — chờ đo (M1). Không ảnh hưởng kết luận §3 (batch đã nhả slot trước 03:37:00) nhưng quyết định có cần giới hạn batch size.
- Hàng đợi modification phía client trong `03:50–04:02` — cần kiểm tra trên máy điều hành viên (§1.2).
- Chủ ý của `opsdata-traffic-report-rest-staging` trỏ vào DB Production — chờ quyết định hạ tầng.

## 9. Ghi chú triển khai & bằng chứng kiểm chứng cục bộ (2026-09-24)

### 9.1. Nguồn release của báo cáo là worktree `codex/web-traffic-report`

Đã xác minh bằng ba biên bản phát hành Production liên tiếp — `docs/runbooks/2026-09-13-…:11–12`, `2026-09-17-…:11–12`, `2026-09-19-…:15–16` — tất cả đều ghi **nhánh Git & worktree nguồn** là `codex/web-traffic-report` tại `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report`. Đây là worktree của chính repo này (`git worktree list`), hiện ở commit `3551d28`.

**Sự thật quan trọng về khả năng build:** trong checkout `main` (`C:/Users/tuan/Documents/SeasonalManagement`), `app/supabase/functions/traffic-report/index.ts` import **sáu** module từ `../_shared/` — `trafficWorkbookCore.ts`, `trafficWorkbookRenderer.ts`, `trafficHtmlReportContract.ts`, `trafficHtmlReportModel.ts`, `trafficHtmlReportRenderer.ts`, `trafficReportPresentationAggregates.ts` — và **cả sáu đều không tồn tại** trong checkout đó (`git ls-files`/`git ls-tree HEAD` chỉ có `cors.ts` và `dashboardAiShared.ts`; `git log` cho các đường dẫn này **rỗng**, tức chưa từng được Git theo dõi). Hệ quả:

- Module edge **không thể** được load, `deno check`, build hay deploy từ checkout `main`: `deno check` trả `TS2307 Cannot find module` cho cả sáu import.
- Bộ test `app/scripts/traffic-report-edge-contract.test.mjs` chỉ **so khớp văn bản nguồn** nên vẫn xanh — nó không hề import module. **Đừng** đọc việc suite này xanh là bằng chứng module edge build được.
- Sáu module đó **có đủ** trong worktree `codex/web-traffic-report`. Vì vậy **mọi thay đổi với Edge Function phải thực hiện trong worktree này**, không phải trong `main`.

### 9.2. Các hunk đã sửa (chỉ trong worktree `codex/web-traffic-report`)

| # | File | Thay đổi |
| --- | --- | --- |
| M3.3a | `app/src/app/(public-report)/reports/traffic/TrafficReportTrend.tsx:159` | `if (!response.ok) throw new Error(payload?.error ? String(payload.error) : 'Không thể tải xu hướng. Vui lòng thử lại.');` |
| M3.3b | `app/src/app/(public-report)/reports/traffic/TrafficReportDimensionSection.tsx:112` | `if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result && result.error ? String(result.error) : 'Không thể tải bảng dữ liệu. Vui lòng thử lại.');` |
| M3.3c | `app/src/app/(public-report)/reports/traffic/TrafficReportDimensionSection.tsx:142–143` | Tách điều kiện gộp thành hai nhánh; nhánh `!response.ok` nay đọc `result.error` với cùng cách thu hẹp, nhánh sai hình dạng payload giữ nguyên chuỗi cũ |
| M3.4a | `app/supabase/functions/traffic-report/index.ts:1244` + `:1295–1304` | Thêm `const errorName = …` (lấy `error.name` bằng thu hẹp `in`, không cast) và nhánh `REPORT_BACKEND_BUSY` + `Retry-After: 5` cho `TimeoutError` / thông điệp cạn pool-đứt kết nối |
| M3.4b | `app/supabase/functions/traffic-report/index.ts:492`, `:526`, `:1182`, `:1263` | Ba điểm ném lỗi ngân sách đổi sang mã chuẩn `'WORKBOOK_RESOURCE_BUDGET_EXCEEDED: <nguồn>'`; nhánh bắt đổi `===` → `startsWith` |

Cả năm hunk đều **chưa commit** (worktree đang giữ nhiều thay đổi WIP khác không thuộc phạm vi này). `git diff` trên hai file cho thấy diff **chỉ** chứa năm hunk trên — không có thay đổi lân cận nào bị kéo theo.

### 9.3. Bằng chứng kiểm chứng (chạy trên worktree, không phải `main`)

| Kiểm tra | Kết quả |
| --- | --- |
| `deno check` module edge — **trước** sửa (bản HEAD) | 165 lỗi (nợ sẵn có của function, **không** thuộc phạm vi M3) |
| `deno check` module edge — **sau** sửa | **165 lỗi** — y hệt; **0 lỗi** trong khoảng dòng 1240–1310 |
| `npx eslint` `TrafficReportTrend.tsx` | 0 error; 1 warning **có sẵn** (`validFlightRows` không dùng, dòng 236) |
| `npm run test:traffic-report-contract` | pass — **37 + 34 + 7** test, ba suite `public-traffic-report-v1`, `traffic-report-edge-contract`, `traffic-report-isolation` (22 file) |
| Harness lỗi edge (module thật + stub PostgREST), chế độ `pgrst003` — **trước** sửa | `503`, `Retry-After: null`, `REPORT_TEMPORARILY_UNAVAILABLE` |
| Harness lỗi edge, chế độ `pgrst003` — **sau** sửa | `503`, **`Retry-After: 5`**, **`REPORT_BACKEND_BUSY`** |
| Harness lỗi edge, chế độ `hang` (upstream treo) — **trước** sửa | `503` sau **8021 ms**, `Retry-After: null`, `REPORT_TEMPORARILY_UNAVAILABLE` |
| Harness lỗi edge, chế độ `hang` — **sau** sửa | `503` sau **8031 ms**, **`Retry-After: 5`**, **`REPORT_BACKEND_BUSY`** |
| `npx tsc --noEmit` (worktree, vòng 2) | **0 lỗi** trong `reports/traffic/` và `src/lib/`. 35 lỗi còn lại **toàn bộ** thuộc `tmp/production-html-20260906/edge-before.ts` — snapshot cũ không nằm trong build |
| `npx eslint` `TrafficReportDimensionSection.tsx` + `TrafficReportTrend.tsx` (vòng 2) | 0 error; 1 warning **có sẵn** (`validFlightRows` không dùng — có mặt ở `HEAD:236`, không do thay đổi này) |
| `TrafficReportPresentation.source.test.ts` (vòng 2) | 23/23 pass |
| `traffic-report-edge-contract.test.mjs` (vòng 2) | pass |
| `deno test _shared/trafficReportPresentationAggregates.test.ts` (vòng 2) | 7/7 pass |
| Biểu thức thu hẹp `'error' in result` của M3.3b/c | **Trích trực tiếp từ `TrafficReportDimensionSection.tsx`** (2 biểu thức), `new Function('result', …)` rồi kiểm 8 dạng thân phản hồi: **2 site × 8 = 16/16 pass** — thân `400`/`503` của edge được đưa nguyên văn lên UI; `null`, chuỗi trần, mảng, `{error_code}` không kèm `error`, `{error: ''}` và thân thành công đều rơi về chuỗi dự phòng |
| Harness A/B phân loại ngân sách (module thật + stub PostgREST trả `has_more: true` vô hạn) — **trước** sửa | `400` `INVALID_REPORT_FILTER`, "Bộ lọc báo cáo chưa hợp lệ…", **26 RPC** |
| Harness A/B — **sau** sửa | **`413` `WORKBOOK_RESOURCE_BUDGET_EXCEEDED`**, "Phạm vi báo cáo quá lớn…", **26 RPC** |
| Pin nguồn mới trong `TrafficReportPresentation.source.test.ts` — chạy trên bản **HEAD** (trước sửa) | **FAIL** — `trendPin=no-match`, `dimensionSites=0` |
| Cùng pin đó — chạy trên bản **đang làm việc** (sau sửa) | **PASS** — `trendPin=MATCH`, `dimensionSites=2` |
| Pin dimension — hoàn nguyên **một** site bất kỳ (site 0 **hoặc** site 1) | **FAIL cả hai trường hợp** — `count` về `1`. Pin dùng `match(…gu)` + `assert.equal(length, 2)` nên bắt được hồi quy **từng site riêng lẻ**, không chỉ khi cả hai cùng mất |
| `TrafficReportPresentation.source.test.ts` (vòng 3, đã thêm pin) | **24/24** pass (vòng 2 là 23/23) |
| **Live read** production: mở `https://report.ahtops.xyz/reports/traffic` bằng trình duyệt thật, đọc request mạng | Trang gọi **`/api/report/v2/overview`**, **`/v2/timeline`**, **`/v2/dimension` ×4**, **`/v2/dimension-share` ×4** — **không có request `/v1/` nào**. DOM render đủ ("Xu hướng chuyến bay"), không có thông báo lỗi |
| `npm run test:rules` (cổng quy tắc toàn repo) | pass |
| `npm run build:traffic-report` (đường build phát hành thật) | **Thành công** — `Compiled successfully in 10.9s`, TypeScript pass, 50 file vào `out-report` |
| **Artifact phát hành có mang thay đổi M3.3a không** | **Có.** `out-report/_next/static/chunks/14c1~ax2tw8.0.js` chứa `if(!a.ok)throw Error(s?.error?String(s.error):"Không thể tải xu hướng. Vui lòng thử lại.")` — đúng biểu thức đã sửa, sau minify. **Đây là bằng chứng bổ trợ, không phải bằng chứng chính:** nó chứng minh thay đổi đã vào bundle phát hành, nhưng **không** chứng minh hành vi (grep trên bundle minified không phân biệt được site nào với site nào — các chuỗi dự phòng của dimension còn xuất hiện ở nhiều chỗ khác như `:120`, `:143`, `:230`). Bằng chứng hành vi là **pin nguồn fail-pre-fix / pass-post-fix** ở hai dòng trên |

Chế độ `hang` là phép đo trực tiếp ngân sách 8 s ở §3: abort ở **8021/8031 ms**. Harness chỉ là script dùng-một-lần, **đã xoá** (cả vòng 1 lẫn vòng 2); bản sao hoàn nguyên 4 literal dùng làm mốc so sánh của phép A/B cũng **đã xoá**. (Pin nguồn thì **không** dùng bản sao — nó đọc thẳng `git show HEAD:` và bản đang làm việc, xem hai dòng "Pin nguồn" ở bảng trên.)

**Phạm vi của phép A/B (M3.4b).** Vế "trước" **không** dùng `git show HEAD:`. Lý do **chỉ áp cho `index.ts`**: file này mang sẵn công việc chưa commit từ trước (worktree hiện có **15 file đã sửa + 12 file untracked**), nên `HEAD:` không phải bản "trước thay đổi này" mà là bản trước **nhiều** thay đổi — phép so sánh sẽ không quy được kết quả cho 4 literal vừa sửa. (Với `TrafficReportTrend.tsx` và `TrafficReportDimensionSection.tsx` thì ngược lại: diff so với `HEAD` **đúng bằng** các hunk của lượt này — 2 dòng và 5 dòng — nên `HEAD:` **là** mốc trước-sửa hợp lệ, và đó chính là cách hai dòng "Pin nguồn" ở bảng trên làm.) Thay vào đó, vế "trước" là **bản sao của chính file đang làm việc**, chỉ hoàn nguyên **đúng 4 literal** vừa sửa (ba mã ngân sách về chuỗi văn xuôi, `startsWith` về `===`); harness từ chối chạy nếu phép hoàn nguyên không khớp gì. Nhờ vậy kết quả `400 → 413` **quy được chính xác** cho thay đổi này.

Số RPC bằng nhau ở cả hai vế (**26** = 1 trang đầu + 25 vòng lặp, `page` 1→26) chứng minh vòng lặp chạm trần **giống hệt nhau** — biến duy nhất là **cách phân loại**. Vế "trước" tái hiện đúng khiếm khuyết: thông báo "bộ lọc chưa hợp lệ" cho một tình huống **phạm vi quá lớn**, kèm `400` (client sẽ không thử lại). Vế "sau" trả đúng `413` + mã chuẩn. Hai điểm ném còn lại (`:492`, `:526`) đi qua **cùng** nhánh `startsWith` vừa được chứng minh, và không nhánh nào xếp trước nó khớp chuỗi mới.

**Phạm vi của kiểm chứng M3.3b/c.** Không có harness chạy thật cho hai điểm này: **chính bundle client** chọn đường đọc `v1` hay `v2` (`bundle.contract_version === 'traffic-report-v2'` → `TrafficReportClient.tsx:285`), chứ không phải backend; và **live read ở trên chứng minh Production đang đi `v2`** cho mọi endpoint báo cáo, tức hai điểm `v1` này hiện **không được thực thi** ở Production. Đã kiểm: biên dịch (tsc), lint, source test **có pin**, và **hành vi của chính biểu thức trích từ file nguồn** trên 8 dạng thân phản hồi. Phần **chưa** được chạy thật là đường đi từ `fetch` trong component tới `setError` — chỉ đọc mã để xác nhận.

### 9.4. Việc còn lại trên máy điều hành viên (workstation này **không** có quyền SSH)

Từ máy trạm này: `~/.ssh/config` rỗng, `read ssh://` báo "No SSH hosts are configured", và `docs/runbooks/public-traffic-report-deploy.md:24` ghi rõ triển khai *"require[s] the infrastructure operator/session and must not be inferred from local files"*. Vì vậy các bước sau **phải** do phiên điều hành viên chạy.

**Phạm vi mặc định: chỉ phát hành M3** — đúng phần việc được giao trong lượt này. Worktree còn mang **feature `VARIANCE_ANALYSIS` chưa commit** (WIP của người dùng, chưa được yêu cầu phát hành); nó là **nhánh quyết định riêng**, không tự động đi kèm.

**Hai changeset rời nhau hoàn toàn theo file — đã kiểm, không phải suy đoán:**

| Bằng chứng | Kết quả |
| --- | --- |
| `git show HEAD:…/traffic-report/index.ts \| grep ^import` so với bản đang làm việc | **giống hệt** — `index.ts` mới **không** cần API mới nào từ `_shared/` |
| Diff `index.ts` | **đúng 6 hunk, toàn bộ là M3.4** (3 literal ngân sách, `errorName`, `startsWith`, `REPORT_BACKEND_BUSY` + `Retry-After: 5`) — **0 dòng variance** |
| Diff `TrafficReportTrend.tsx` / `TrafficReportDimensionSection.tsx` | **0 dòng variance** (2 và 5 dòng) |
| Diff `_shared/*.ts` | toàn bộ là `VARIANCE_ANALYSIS` + plumbing `baseline_from`/`baseline_to`/`baselineFrom`/`baselineTo` |

⇒ **Đường A tách được theo file và chỉ cần `index.ts`** (chạy được với `_shared/` **cũ** mà `cp -r` mang sang). **Đường B thì KHÔNG** — xem cảnh báo ở mục B: bundle build từ toàn bộ `src/` nên nó luôn chở theo cả dialog variance. Và **toàn bộ đường C là variance** — không cần đụng tới.

| Đường | Phát hành trong lượt này? | File |
| --- | --- | --- |
| **A. Edge Function** | **Có** | `app/supabase/functions/traffic-report/index.ts` (M3.4a + M3.4b) |
| **B. Static UI** | **Khuyến nghị HOÃN — xem cảnh báo dưới** | `TrafficReportTrend.tsx` + `TrafficReportDimensionSection.tsx` (M3.3a/b/c) và `TrafficReportPresentation.source.test.ts` (pin, không lên Production). **Không tách được khỏi bundle** — publish `out-report` là publish cả variance UI |
| **C. Variance WIP** | **KHÔNG** | Server: `_shared/trafficHtmlVarianceRuntime.ts`, `_shared/trafficHtmlVarianceStyles.ts`, `_shared/trafficWorkbookCore.ts`, `_shared/trafficHtmlReportContract.ts`, `_shared/trafficHtmlReportModel.ts`, `_shared/trafficHtmlReportRenderer.ts`, migration `20260922120000_…`. Client (**nằm trong bundle**): `TrafficWorkbookExportDialog.tsx`, `src/lib/trafficWorkbookExportContract.ts`, `src/lib/trafficHtmlExportContract.ts`. Test (không vào bundle, hoàn nguyên chỉ để test khớp): `src/lib/trafficHtmlReport.test.ts`, `src/lib/trafficWorkbookExport.test.ts` — **để nguyên trong worktree** |

**Một script làm cả A lẫn B** — `tmp/deploy_20260923.py` giải nén tarball tĩnh (bước 2), dựng functions + sửa mount compose + recreate container (bước 3–5), chuyển **cả** `current` **lẫn** `staging-current` (bước 6), rồi `reload nginx` (bước 7). Không có bước staging thật, và **không thể** phát hành riêng A hay B bằng script đó. Với đường A thì vẫn tách được — **artifact edge tách được theo file** (chỉ cần thêm một dòng `cp` cho `index.ts`, xem Bẫy 1) — nhưng **đường B thì không tách được** khỏi bundle tĩnh, nên "chỉ stage đúng file" **không** đủ để phát hành B mà không kèm variance.

**A — Edge Function:**

1. **Kiểm chứng + build** trong worktree `codex/web-traffic-report`: `npm run test:traffic-report-contract`, `npm run test:rules`, `npm run test:traffic-variance-regression`, `npx tsc --noEmit --pretty false`, `npm run build:traffic-report`.
   - **Vì sao vẫn chạy `test:traffic-variance-regression`:** với phạm vi đã chốt (chỉ A, không overlay `_shared/`, B hoãn) thì **không** phần variance nào lên Production — nên đây **không** phải cổng chặn cho lượt này, mà là để xác nhận worktree không bị hỏng trước khi lấy artifact từ nó. Nếu sau này chọn lựa chọn 2 hoặc 3 thì nó trở thành cổng chặn thật: đây là **test duy nhất** phủ `trafficHtmlVarianceRuntime.ts` / `trafficHtmlVarianceStyles.ts` và nhánh `VARIANCE_ANALYSIS`, còn `test:traffic-report-contract` **không** đụng tới nó. Đã chạy: pass (assert ở mức DOM, kiểm đẳng thức nhánh hành khách/chuyến bay, ngưỡng radar, ghép Thứ lịch N-th occurrence).
   - **Cảnh báo nhiễu:** `npx tsc --noEmit` hiện trả **35 lỗi**, **toàn bộ** thuộc `tmp/production-html-20260906/edge-before.ts` — một snapshot cũ **không được Git theo dõi** và không nằm trong build. Đừng đọc 35 lỗi này là hồi quy. Nếu muốn đầu ra sạch, xoá hoặc di chuyển thư mục đó trước khi chạy.

2. **⚠️ Hai cái bẫy đã xác minh — mỗi cái đều làm hỏng bản phát hành theo một kiểu khác nhau.**

   - **Bẫy 1 — `tmp/deploy_20260923.py` KHÔNG chở `traffic-report/index.ts`.** Script tạo thư mục functions mới bằng `cp -r <old_functions> <new_functions>` rồi **chỉ overlay đúng một file**: `_shared/trafficReportPresentationAggregates.ts` (biến `SHARED_TS_PATH`). Chạy nguyên bản hôm nay sẽ **mang `index.ts` cũ sang** → **M3.4a và M3.4b bị bỏ rơi âm thầm**, container vẫn khởi động xanh, smoke `200` vẫn pass, và bạn sẽ tưởng đã phát hành xong. Phải **thêm đúng một dòng `cp`** cho `traffic-report/index.ts` vào bước overlay — và **không** đụng `_shared/` (đã kiểm: import của `index.ts` mới giống hệt `HEAD`, nên nó chạy được với `_shared/` **cũ** mà `cp -r` mang sang). Script còn hai vấn đề nữa: `RELEASE_ID`/`ARCHIVE_PATH` đang ghim vào bản **09-23** (`20260923T163000Z-weekday-stats-peakhour-pin`), nên chạy lại sẽ **phát hành lại bundle tĩnh cũ và ghi đè `current`**; và nó `ln -sfn` **cả `current` lẫn `staging-current`** sang cùng release, tức không có bước thử staging thật.

   - **Bẫy 2 — KHÔNG chép tay `app/supabase/functions/traffic-report/index.ts` vào container.** Artifact **đang chạy** trên Production là một **bundle đã chia chunk**, không phải bản sao mã nguồn: `/home/deno/functions/main/main/` chứa `index.ts` + `index.ts.map` + **28 file `chunk-*.js`** + 4 `chunk-*.js.map`. Các chuỗi API prefix (`/api/report/v1`, `/api/report/v2`) và `TRAFFIC_REPORT_V2_ENABLED` nằm **trong các file chunk**, không nằm trong `index.ts` cấp cao nhất. File trong repo là **file phát triển ~4 500 dòng**, import **sáu** module `_shared/*` bằng đường dẫn tương đối. Container chỉ mount `/home/deno/functions` → `/home/deno/functions:ro`; nếu chỉ đặt `index.ts` vào `main/main/` mà không kèm `_shared/`, sáu import đó **không giải được** và container chết lúc khởi động. `deno check` cục bộ **không** phát hiện được điều này vì function đã có **165 lỗi type sẵn có** (§9.3) — đầu ra đỏ không phân biệt được lỗi cũ với lỗi mới.
     - **Hệ quả:** phải dùng **đúng đường build đã sinh ra artifact hiện tại**. Các tarball trong `deploy/traffic-report/` (`traffic-report-release-<TS>-*.tar.gz`) có bố cục `report/v1/…`, `report/v2/…`, `functions/…`, `supabase/…` — dùng chúng làm **khuôn bố cục**, không tự nghĩ ra bố cục khác.
     - **Lưu ý về compose:** `deploy/traffic-report/docker-compose.yml` trong repo là **bản mẫu đã lược gọn** — thiếu biến môi trường, healthcheck, `entrypoint`, mount `logs`/`static` mà container thật đang chạy. Bản có thẩm quyền là bản **trên máy chủ**. Đừng dùng bản trong repo để dựng lại container.

   - **Vệ sinh bảo mật (chỉ ghi nhận, không sửa trong lượt này):** `tmp/deploy_20260923.py` nhúng **mật khẩu `ops`/sudo dạng plaintext** và dùng `paramiko.AutoAddPolicy()` (chấp nhận mọi host key chưa biết). Credential nằm trong một file **untracked** của repo và lần kết nối đầu tiên có thể bị MITM bắt. Người vận hành nên chuyển sang SSH key + `known_hosts` trước khi dùng lại script này.

3. **Đường C (variance) — KHÔNG làm trong lượt này.** Không apply migration, không overlay phần `_shared/` của variance, không phát hành `TrafficWorkbookExportDialog.tsx`. Lý do: đây là **WIP chưa được yêu cầu phát hành**, và `_shared/trafficHtmlReportRenderer.ts:7-8` import **tĩnh** hai module **untracked** — phát hành nó là phát hành một feature chưa qua review. Chỉ cần stage đúng file theo bảng phạm vi ở trên là đủ tách hai changeset **ở phía edge**; còn với bundle tĩnh thì việc tách đó **không** thực hiện được bằng cách chọn file (xem cảnh báo ở mục B).

   - **Nếu sau này quyết định phát hành variance, thứ tự là C trước A/B.** `20260922120000_…` là `create or replace` **thân hàm** `reporting.traffic_html_periods_v2` — **cùng chữ ký** `(jsonb, timestamptz, date)` như bản đã apply ở `20260906120000:15` (khớp cả `alter function`/`revoke` ở `:106-107`), nên **không** sinh overload. Người gọi duy nhất là `20260906120000:228`, gọi **2 tham số**; grep `p_analysis_to` trong TS = rỗng (tham số này vốn có sẵn từ `_v1`, dùng cho `BAO_CAO_SAN_LUONG`). ⇒ **Cả hai thứ tự đều an toàn cho các report type hiện có**; đặt C trước chỉ để tránh cửa sổ "code mới gặp DB cũ" làm phần variance rỗng.
   - **Rollback riêng cho migration:** giữ lại định nghĩa **cũ** của `traffic_html_periods_v2` để `create or replace` ngược lại. Hàm này dùng chung cho HTML export nên migration tác động lên đường export **ngay khi apply**, trước cả khi code mới lên.

4. Stage vào `/srv/seasonal-traffic-report/functions/<TS>-<slug>` rồi trỏ `main` sang đó — **không** ghi đè tại chỗ (giữ đường lùi: trỏ `main` về thư mục `<TS>` trước đó). Nếu theo `deploy_20260923.py`, nhớ sửa cả `sed` trên `/srv/seasonal-traffic-report/infra/docker-compose.yml` cho khớp tên thư mục mới.

5. `docker restart opsdata-traffic-report-edge` (hoặc `docker compose … up -d --force-recreate` như script), rồi **cổng kiểm tra quan trọng nhất là "module có load được không"**: đọc log khởi động và xác nhận **không** có lỗi `Module not found` / `failed to load`. Sau đó gọi một request report bình thường và xác nhận **`200`** (không phải `503`).
   - **Smoke A:** khi backend bận, thân lỗi phải là `REPORT_BACKEND_BUSY` kèm header `Retry-After: 5` (thay vì `REPORT_TEMPORARILY_UNAVAILABLE`).
   - **Smoke bắt buộc thêm — gọi HTML export.** Một request report thường **không** chạm đường này, mà `index.ts` mới phân loại lỗi cho **mọi** route kể cả export. Xuất một HTML export thật và xác nhận tài liệu hoàn chỉnh (không phải `503`).
     - *Nếu sau này phát hành variance thì đây cũng là đường kiểm nó — nhưng phải truyền **trọn bộ** tham số, thiếu một điều kiện là bị validate từ chối và cho **kết quả giả âm tính**: `report_type=VARIANCE_ANALYSIS`, `period_mode=custom`, `template_version=variance-analysis-v1`, `baseline_from`/`baseline_to` dạng ISO với `baseline_from ≤ baseline_to` và **khác** `from`/`to` (trùng sẽ bị `baseline period duplicates current period`), và **không** kèm `comparison`/`comparison_year`.*
   - **Smoke cho M3.4b không chạy được trên dữ liệu thật**: nhánh `WORKBOOK_RESOURCE_BUDGET_EXCEEDED` chỉ kích hoạt khi vượt trần 25 trang, mà dữ liệu Production hiện **không** chạm trần — đó chính là lý do khiếm khuyết này tồn tại âm thầm. Bằng chứng cho M3.4b là **phép A/B cục bộ** ở §9.3, không phải smoke live. Đừng cố dựng dữ liệu để chạm trần trên Production.

**B — Static UI:**

**⚠️ Cảnh báo quan trọng — bundle tĩnh KHÔNG tách được theo file.** Khác với đường A, bundle là kết quả build của **toàn bộ** `src/`, nên **không thể** loại `TrafficWorkbookExportDialog.tsx` ra khỏi nó — `TrafficReportClient.tsx:29` **import tĩnh** nó, render ở `:440`, nên nó luôn nằm trong bundle.

Đúng là có **ba cổng `NEXT_PUBLIC_*`** quanh phần này — nhưng cả ba đều **mở sẵn** theo mặc định của chính lệnh build của dự án, nên **không** cổng nào che được variance:

| Cổng | Ở đâu | Mặc định của `npm run build:traffic-report` | Hệ quả |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED` | `TrafficReportClient.tsx:35` (chặn cả dialog ở `:440`) | **`'true'`** — `app/scripts/build-traffic-report-only.mjs:73` (`?? 'true'`) | dialog **hiện** |
| `NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` | `TrafficWorkbookExportDialog.tsx:25`, filter ở `:309` | **không được set ở đâu cả** → `?? ''` → set **rỗng** | `enabledReportTypes.size === 0` ⇒ filter cho **qua hết**, gồm `VARIANCE_ANALYSIS` |
| `NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED` | `:27`, khối "Định dạng" ở `:292` | **`'true'`** — `:74` (`?? 'true'`) | lựa chọn HTML **hiện** |

Vì ba cờ này là **build-time** (`NEXT_PUBLIC_*` được inline lúc build), kết luận phải đọc từ **script build**, không từ việc "có cờ hay không": với lệnh build của dự án, `VARIANCE_ANALYSIS` **có** là một mục chọn được và **cả hai** đường xuất đều tới được.

Xác nhận độc lập, mạnh hơn mặc định của script: kế hoạch phát hành **09-11** (`docs/superpowers/plans/2026-09-11-public-traffic-report-coverage-counts-backend.md:251`) ghi cờ này *"xác định từ hành vi production live (không đoán)"* — workbook `=true` (dialog "Xuất báo cáo" hiện), HTML `=true` (mục "Định dạng → HTML offline (.html)"), và `NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` **không đặt** ("dialog hiện đủ 5 loại"; nay có loại thứ sáu nên sẽ hiện đủ **6**). Cùng dòng đó còn ghi tiền lệ đúng loại lỗi này: *"Build đầu thiếu cờ export nên dialog biến mất — đã build lại kèm cờ"*.

Publish `out-report` hiện tại **cùng** `_shared/` cũ mà `cp -r` mang sang ⇒ **tặng người dùng một control vỡ**, ở **cả hai** đường xuất:

| Người dùng chọn | Đi tới | `_shared`/DB cũ ném | Người dùng thấy |
| --- | --- | --- | --- |
| Variance, output **HTML** | `/api/report/v2/html-export` → `traffic_html_periods_v2` (bản 09-06) | `invalid HTML preset` | lỗi validate của HTML export |
| Variance, output **workbook** | `/api/report/v1/workbook-export` → `trafficWorkbookCore.ts:283` (bản `HEAD`) | `invalid workbook report type` | rơi vào regex generic `index.ts:1305` → **"Bộ lọc báo cáo chưa hợp lệ"** + `retryable: false` — đúng kiểu lệch thông điệp mà M3.4b vừa sửa |

**Bốn lựa chọn sạch, xếp theo độ ít hệ luỵ — phải chọn rõ một cái:**

1. **Không phát hành B trong lượt này (khuyến nghị).** Có lý do độc lập đủ để hoãn mà không cần viện tới hai rủi ro trên: M3.3a/b/c nằm trên đường **`v1`**, mà Production đang chạy **`v2`** (§9.3) — phát hành B **không thay đổi hành vi nào** trên Production.
2. **Nếu buộc phải phát hành B: dùng allowlist, không cần sửa mã nguồn.** Đây là cách rẻ nhất và **đã có sẵn** trong hệ thống, không cần surgery bản sao scratch như lựa chọn 3:
   - **Build:** `NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES=MASTER_OPERATIONS,MONTHLY_OVERVIEW_L2,WEEKLY_DETAIL,PERIOD_ANALYSIS,BAO_CAO_SAN_LUONG` → `TrafficWorkbookExportDialog.tsx:309` lọc `VARIANCE_ANALYSIS` ra khỏi danh sách ⇒ **không còn radio nào để chọn**.
   - **Edge — hai biến, không phải một, và phải đi cùng nhau.** `index.ts` có **hai** cổng riêng biệt, cả hai **đã có sẵn từ `HEAD`** và **không** bị diff M3.4 đụng tới (đã kiểm: `git diff` trên `index.ts` = **0** dòng chạm các dòng này):
     - `:571` + `:608` — `TRAFFIC_WORKBOOK_EXPORT_ENABLED !== 'true'` ⇒ **404** `WORKBOOK_EXPORT_DISABLED` / "Tính năng export workbook chưa được bật." (công tắc bật/tắt cả executor)
     - `:575-576` (workbook-export) + `:611-612` — `allowedTypes.length && !allowedTypes.includes(...)` ⇒ **404** `WORKBOOK_REPORT_TYPE_DISABLED` / "Loại workbook này chưa được bật."
     - `:909-910` (html-export) — cùng allowlist ⇒ **404** "Loại báo cáo chưa được bật."
   - **Ngữ nghĩa allowlist rỗng — đã ghim theo mã:** guard là `allowedTypes.length && …`, tức set **rỗng = cho qua hết** (không hạn chế), chứ **không** phải "tắt hết". Muốn chặn thì **phải** liệt kê tường minh 5 loại cũ. Đừng nhầm với `WORKBOOK_EXPORT_DISABLED` — đó là cổng khác, ở dòng khác.
   - **Đây LÀ cơ chế rollout có tài liệu — tôi đã tra nhầm bản runbook.** Bản đúng nằm trong **worktree**: `SeasonalManagement-web-traffic-report/docs/runbooks/public-traffic-report-deploy.md:48-54` — `:49` *"rollout theo allowlist đồng bộ: `NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` cho UI và `TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` cho Edge"*, và `:51` là quy tắc bắt buộc: *"nếu chỉ một trong hai flag được bật, coi cấu hình là chưa hoàn tất: UI có thể không hiện action hoặc Edge trả `WORKBOOK_EXPORT_DISABLED`"*.
     - **Hai bản runbook đã lệch nhau:** bản ở repo chính `SeasonalManagement/docs/runbooks/public-traffic-report-deploy.md` **không** có mục allowlist nào (grep `allowlist` → rỗng; `:40-60` là cờ dashboard KPI). Khi tra tài liệu phát hành, **luôn đọc bản trong worktree**, và cân nhắc đồng bộ ngược lại repo chính.
     - **Bắt buộc làm trước:** người vận hành đọc **file env root-only trên máy chủ** để biết trạng thái hiện tại của **cả hai** biến Edge trước khi đổi — đặt lệch một trong hai là cấu hình chưa hoàn tất theo đúng `:51`.
   - **Cổng kiểm tra — khác lựa chọn 3, đừng dùng nhầm cổng:** dưới allowlist, chuỗi `VARIANCE_ANALYSIS` **vẫn nằm trong bundle** (mảng `reportTypeOrder` là mã, chỉ bị lọc lúc chạy), nên `grep -rl "VARIANCE_ANALYSIS" out-report` **không** phải cổng hợp lệ ở đây. Cổng đúng là **kiểm trên trình duyệt ở staging**: mở dialog "Xuất báo cáo" và xác nhận danh sách **đúng 5 loại**, không có "Phân tích biến động & Bất thường".
3. **Build trong một bản sao scratch**, sau khi hoàn nguyên **trọn bộ** file client mang variance về `HEAD:` — **không** đụng worktree thật (đó là WIP của người dùng). Tập cần hoàn nguyên, **giữ nguyên** hai `.tsx` của M3.3:
   `TrafficWorkbookExportDialog.tsx`, `src/lib/trafficWorkbookExportContract.ts` (34 dòng đổi, 6 dòng variance), `src/lib/trafficHtmlExportContract.ts` (3 dòng, 1 variance), và hai file test `trafficHtmlReport.test.ts` + `trafficWorkbookExport.test.ts` (không vào bundle, hoàn nguyên để test khớp). **Phải build lại** — `out-report` hiện tại đã build kèm dialog.
   **Đã kiểm là khả thi:** hai `.tsx` của M3.3 **không** import hai export contract đó (chúng chỉ dùng `trafficReportDataAdapter` / `trafficReportV2Contract` / `trafficReportTrendGranularity`), và người dùng duy nhất của hai contract là chính dialog + hai file test ⇒ giữ M3.3 mà hoàn nguyên variance client **vẫn compile**.
   **Cổng kiểm tra bắt buộc (chỉ cho lựa chọn này):** `grep -rl "VARIANCE_ANALYSIS" out-report` phải **rỗng** trước khi phát hành.
4. **Phát hành kèm nguyên đường C** (migration + `_shared/` + dialog) — chỉ sau khi feature variance được review.

Các bước 6–7 dưới đây giữ lại cho lựa chọn 2, 3 hoặc 4.

6. **[HOÃN theo khuyến nghị ở trên — chỉ làm nếu chọn lựa chọn 2, 3 hoặc 4.]** Build với `npm run build:traffic-report` rồi phát hành bundle tĩnh theo `docs/runbooks/2026-09-19-…`.
   - **Lựa chọn 2 (allowlist):** build kèm `NEXT_PUBLIC_TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` và đặt `TRAFFIC_WORKBOOK_ENABLED_REPORT_TYPES` bên Edge. Cổng kiểm tra là **kiểm trên trình duyệt ở staging** (dialog liệt kê **đúng 5 loại**), **không** phải grep bundle — `VARIANCE_ANALYSIS` vẫn nằm trong bundle dưới dạng literal mảng.
   - **Lựa chọn 3 (scratch revert):** build trong bản sao scratch **sau khi** đã hoàn nguyên trọn bộ file client mang variance; cổng kiểm tra là `grep -rl "VARIANCE_ANALYSIS" out-report` phải **rỗng**.
   - **Về phạm vi hiệu lực của M3.3 — nay đã xác định, không còn là câu hỏi mở.** Live read ngày 2026-09-24 (§9.3) cho thấy trang report đang chạy gọi **toàn bộ `v2`** (`/api/report/v2/overview`, `/v2/timeline`, `/v2/dimension` ×4, `/v2/dimension-share` ×4) và **không** gọi `/v1/` lần nào. Cơ chế khớp: client chọn v1/v2 theo `bundle.contract_version === 'traffic-report-v2'` (`TrafficReportClient.tsx:285`), và bundle do `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED` quyết định ở **thời điểm build**; script build mặc định đặt cờ này là `'1'` (`app/scripts/build-traffic-report-only.mjs:72`).
   - **Kết luận vận hành:** ba điểm sửa M3.3a/b/c nằm trên đường đọc **`v1`**, nên bản phát hành này **không** thay đổi hành vi nhìn thấy được trên Production. Đây là **sửa lỗi phòng ngừa** cho đường v1 (và cho trường hợp cờ v2 bị tắt). Nếu vẫn muốn xác nhận lại sau khi phát hành, chỉ cần mở trang và xem request bundle đi tới `/api/report/v2/…` hay `/api/report/v1/…`.
   - M3.4 thì **có** hiệu lực ngay trên mọi đường (nhánh lỗi ở edge dùng chung cho cả v1 và v2).

7. Ghi biên bản phát hành theo mẫu `docs/runbooks/2026-09-19-…` (Release ID, con trỏ `current`/`staging-current`, **bằng chứng**, rollback).
   - **Nếu hoãn B (khuyến nghị) thì biên bản chỉ cần cho đường A:** không có release UI mới, nên **không** có `current`/`staging-current` nào đổi — mục rollback chỉ cần phần **edge** (trỏ mount `functions` về thư mục `<TS>` trước) và ghi rõ **DB không đổi** (không apply migration nào). Ghi rõ "B hoãn" cùng lý do, để lần sau không ai tưởng M3.3 đã lên Production.
   - **Không ghi "commit nguồn" — không có commit nào để ghi.** Worktree `codex/web-traffic-report` đang có **15 file đã sửa + 12 file untracked chưa commit** (gồm cả hai module variance và migration), và luật bàn giao của dự án là **không tự ý commit gộp** khi worktree đang mang WIP của người dùng. Thay vào đó ghi: **sha256 của artifact đã phát hành** + **trạng thái worktree tại thời điểm phát hành** (danh sách file + `git status --short`). Đó là cách bản phát hành 09-11 đã làm.
   - **Rollback: ghi theo đúng những đường thực sự đã phát hành** — số đường khác nhau theo từng lựa chọn, vì **chỉ lựa chọn 4** mới đụng DB:
     - **Hoãn B (khuyến nghị) → chỉ edge:** trỏ mount `functions` về thư mục `<TS>` trước. Ghi rõ **UI không đổi** (`current`/`staging-current` không đổi) và **DB không đổi** (không apply migration nào).
     - **Lựa chọn 2 (allowlist) hoặc 3 (scratch revert) → edge + UI:** thêm `current`/`staging-current` về release trước. **DB vẫn không đổi** — cả hai lựa chọn này **không** apply migration nào, nên **không** có bước `create or replace` ngược.
     - **Lựa chọn 4 (kèm C) → cả ba:** thêm `create or replace` lại định nghĩa **cũ** của `reporting.traffic_html_periods_v2`.
     Ghi thừa một đường không phát hành sẽ khiến người trực rollback đi tìm một con trỏ (hoặc một hàm) không hề đổi.

**Đề xuất chưa thực hiện (cần quyết định riêng):** thêm một bước `deno check` cho module edge vào quy trình phát hành. Đây là **lỗ hổng tái diễn** đã cho phép cả M3.3 lẫn M3.4b tồn tại: `app/scripts/traffic-report-edge-contract.test.mjs` chỉ **so khớp văn bản nguồn**, nên nó xanh kể cả khi module không thể load (§9.1). Nhưng đưa `deno check` vào ngay bây giờ sẽ **đỏ** (165 lỗi sẵn có của function, §9.3), nên chỉ hữu ích kèm việc dọn nợ type của function — hoặc ít nhất là kiểm tra **sáu import `_shared` giải được**. Việc này **không** nằm trong phạm vi M3 và chưa được làm.
