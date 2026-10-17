# Kế hoạch tối ưu tài nguyên Dashboard/Report

Ngày lập: 2026-09-06. Trạng thái: đề xuất để review, chưa thực hiện thay đổi sản phẩm hoặc production.

## Mục tiêu

Giảm thời gian và dữ liệu tạm của Report live khi cache miss; giảm số lượt đọc và lượng dữ liệu Dashboard desktop tải về. Giữ nguyên tính đúng đắn của canonical metrics, Report Read Version và Daily Publication. Chỉ điều chỉnh hạ tầng khi số đo chứng minh cần thiết.

## 1. Bằng chứng đầu vào và giới hạn

Audit trực tiếp ngày 05/09/2026, khoảng 23:42–23:46 Asia/Ho_Chi_Minh:

| Nhóm | Kết quả | Cách sử dụng trong kế hoạch |
| --- | --- | --- |
| Host | 16 CPU logic; RAM 15,37 GiB, khả dụng khoảng 7,84 GiB; CPU idle 84–99% trong các mẫu ngắn; I/O wait 0% | Chưa có cơ sở nâng server; cần baseline giờ cao điểm |
| Report live RPC | Nhóm 123 calls: mean 1.682 ms, max 2.967 ms; ghi tạm tổng 4.293 MB | Ưu tiên profile SQL; đây là thống kê tích lũy, không phải p95 hiện tại |
| Dashboard publication | Payload mean 0,96 ms; version mean 0,94 ms; không ghi tạm | Giữ nguyên đường đọc publication |
| Workspace RPC | Nhóm 18.816 calls: mean 55,68 ms/page, không ghi tạm | Đo toàn bộ lượt tải Dashboard, không chỉ một page |
| Refresh trong 24 giờ | 288 lượt service: 6 refresh thật, 282 unchanged; tổng thời gian service khoảng 58 giây | Giữ watermark guard và lịch 5 phút trong đợt tối ưu đầu |
| Refresh tích lũy | 11.509 calls, 695 GB ghi tạm; mốc thống kê 24/08/2026 | Không coi là tải trong ngày hoặc dung lượng tạm còn nằm trên đĩa |
| Report public | Tháng: EXPIRED 6,99 s, HIT 1,08 s; YTD: EXPIRED 5,81 s, HIT 0,38 s | Mẫu end-to-end nhỏ, gồm mạng; chưa phải benchmark hoặc capacity limit |
| Bộ nhớ dịch vụ | Edge Report production khoảng 596 MiB; staging/rehearsal liên quan khoảng 479 MiB | Theo dõi working set và nhu cầu vận hành trước khi đặt limit hoặc dừng container |
| PostgreSQL | work_mem 4 MB; shared_buffers 128 MB; track_io_timing off | Thử nghiệm theo truy vấn trên clone nếu cần; không tăng toàn cục theo suy đoán |

Số liệu được thu bằng thao tác đọc qua SSH, pg_stat_statements, pg_stat_database, docker stats, vmstat, systemd journal và API public. Chưa có benchmark đồng thời hoặc baseline giờ cao điểm. Không dùng số liệu tích lũy để quy toàn bộ tài nguyên host cho Dashboard/Report.

## 2. Phạm vi và các điều kiện phải giữ

- Report tiếp tục đọc canonical committed data với watermark, data version, normalized filter hash và semantic data_as_of tương thích.
- Timeline, dimension và export giữ cùng Report Read Version; source đổi phải xử lý conflict đúng contract, không ghép kết quả khác phiên bản.
- Pax NULL là missing, Pax 0 là reported true-zero; giữ đúng all/A/D, Ops Date cutoff 05:00 và coverage/maturity hiện hành.
- Giữ active/deleted/duplicate resolution và operational overlays; không đẩy bộ lọc xuống trước bước chọn bản ghi canonical nếu làm đổi kết quả.
- Public Dashboard tiếp tục đọc immutable Daily Publication, giữ last-known-good, dirty marker, quiet window và single-flight publisher.
- Dashboard desktop giữ quyền truy cập và nghiệp vụ riêng. Không dùng public aggregate để thay thế các metric vận hành về nguồn lực/phân bổ khi chưa chứng minh tương đương.
- Giữ snapshot v1 và timer làm dependency/rollback trong đợt này. Candidate Selector hiện còn kiểm tra projection freshness; không tự retire snapshot.
- Không thay đổi Daily import/save pipeline, forecast formula, nhãn tiếng Việt hoặc thiết kế giao diện ngoài những thay đổi loading cần thiết.
- Không xóa container, volume, backup; không nâng máy, thêm Redis hoặc chỉnh cấu hình PostgreSQL toàn cục trong phạm vi mặc định.

## 3. Thứ tự thực hiện

### Giai đoạn 0 — Chốt phiên bản và baseline

1. Đối chiếu static build, Edge function, SQL function/index, feature flags, Nginx và systemd trên production với các checkout/worktree. Ghi hash và commit thực sự tương ứng; không lấy ADR hoặc receipt cũ làm bằng chứng runtime.
2. Bảo toàn các thay đổi WIP hiện có. Khi được phép implement, tạo branch/worktree riêng từ baseline đã xác nhận, không mang theo thay đổi giao diện/workbook không liên quan.
3. Lập ma trận truy vấn: một ngày, một tháng, YTD, xuyên năm; all/A/D; có/không so sánh kỳ; lọc hãng/đường bay/quốc gia; overview/timeline/dimension/export.
4. Đo các lớp riêng: SQL execution và temp blocks; Edge origin time; Nginx HIT/MISS/EXPIRED; public end-to-end; số request và bytes cho toàn lượt Dashboard.
5. Dùng delta thống kê đầu/cuối khoảng đo, không reset thống kê chung. Ghi database, phiên bản, workload và cỡ mẫu. Nếu log hiện tại thiếu trường, đề xuất instrumentation tối thiểu thành thay đổi riêng.
6. Chọn dữ liệu production-derived clone phù hợp quy trình hiện có. Thu query plan bằng EXPLAIN (ANALYZE, BUFFERS) trên clone; workload đồng thời cũng chạy trên clone/staging đã duyệt. Không load-test production.

Đầu ra: baseline có thể chạy lại, bản đồ deployed source và ma trận kết quả chuẩn. Không bắt đầu sửa SQL dựa trên phiên bản chưa xác nhận.

### Giai đoạn 1 — Giảm chi phí SQL của Report live

Các điểm cần kiểm chứng bằng plan, không coi trước là nguyên nhân đã kết luận:

- get_public_traffic_canonical_bounds_v1 đang tính min/max qua canonical records và overlays; kiểm tra chi phí quét toàn nguồn ngay cả khi request có phạm vi ngày rõ ràng.
- Candidate slice, window ranking và nhiều CTE materialized: xác định sort/hash nào spill, cột nào không cần mang qua các bước trung gian.
- Phạm vi kỳ hiện tại và kỳ so sánh có thể tạo một khoảng scan rộng chứa phần giữa không được sử dụng; đánh giá đọc hai cửa sổ thực sự cần thiết mà vẫn giữ canonical resolution.
- Kiểm tra index và điều kiện lọc ngày/join theo source triển khai thật. Không thay effective Ops Date bằng raw operational_date nếu schedule overlay có thể làm đổi ngày.

Thứ tự sửa: bỏ tính toán/scan không cần thiết → thu hẹp dữ liệu trung gian → index có bằng chứng → mới thử work_mem theo transaction/function trên clone. Mỗi thử nghiệm ghi latency, temp bytes và peak memory dưới tải đồng thời; chọn thay đổi nhỏ nhất đạt mục tiêu.

Không cache bounds hoặc derived metadata nếu chưa có cơ chế invalidation bao phủ insert/update/delete/overlay và các mapping ảnh hưởng kết quả.

Đầu ra: migration additive hoặc function replacement có preimage/rollback, before-after query plans và differential results trên cùng filter/version/data_as_of.

### Giai đoạn 2 — Giảm tính toán lặp ở API và frontend Report

1. Trace request thực tế khi mở trang, đổi bộ lọc, đổi tab, sort, phân trang và export. Kiểm tra consumer nào đã có dữ liệu từ overview nhưng vẫn gọi lại RPC.
2. Trong checkout hiện tại, timeline/dimension gọi aggregate rồi cắt/sort ở Edge. Đánh giá hai phương án theo bằng chứng: tái sử dụng bundle đã có cùng Read Version, hoặc RPC chỉ trả phần dữ liệu cần dùng. Không mặc định thêm RPC nếu bundle nhỏ và tái sử dụng client đã đủ.
3. Hủy request UI cũ khi đổi filter; deduplicate request đang chạy có cùng identity. Nếu HTTP bị hủy nhưng SQL vẫn chạy, đo và xử lý riêng, không coi AbortController là bằng chứng giảm tải database.
4. Kiểm chứng cache key đang bao gồm raw query/read token có gây phân mảnh không. Giữ cache lock; chỉ chuẩn hóa query nếu giữ nguyên contract và chữ ký token.
5. Chỉ bổ sung shared aggregate cache nếu sau bước SQL và tái sử dụng bundle vẫn cần. Identity phải bao phủ contract, filter, source watermark/data version, semantic data_as_of, scope và các version của mapping/config có ảnh hưởng. Có giới hạn bytes/entries, TTL, eviction và deduplication.
6. Giữ semantics conflict của token cũ; không dùng cache để giả lập historical MVCC replay. Không tăng TTL bằng cách làm dữ liệu cũ trông như live. KPI config/save tiếp tục no-store.

ETag hiện được kiểm tra sau RPC: 304 có thể giảm bytes nhưng chưa chắc giảm SQL. Đo số RPC thực tế để nghiệm thu, không chỉ đếm response 304.

Đầu ra: request waterfall trước/sau, chứng cứ giảm calls/bytes, test cache/version/conflict và UI loading/error/empty states.

### Giai đoạn 3 — Giảm tải toàn mùa của Dashboard desktop

1. Liệt kê metric và consumer cần raw records, modifications, allocations; phân biệt Operations, Report Mode, AI context và export.
2. Chọn phần tổng quan có thể đọc aggregate hoặc cửa sổ ngày theo đúng nghiệp vụ. Giữ giao diện, bộ lọc và ý nghĩa metric hiện tại; không tự đổi mặc định cả mùa thành tháng/ngày để làm đẹp benchmark.
3. Aggregate mới nếu cần phải có quyền như đường đọc desktop hiện hành và version envelope. Chỉ tái sử dụng Canonical Traffic Metrics Module cho metric thực sự cùng định nghĩa.
4. Lazy-load dữ liệu chi tiết khi mở phần tương ứng; những phần cần cả mùa phải tiếp tục nhận đủ dữ liệu và không trộn version giữa page.
5. Giữ cache TTL, in-flight deduplication, activation/realtime invalidation và generation protection. Kiểm tra Save/Fetch/reconnect không hiển thị aggregate cũ là mới.

Đầu ra: contract desktop cần thiết, số page/bytes/latency toàn lượt tải trước/sau; test hội tụ dữ liệu qua edit/import và reconnect. Đây là release riêng sau khi Report live ổn định.

### Giai đoạn 4 — Vận hành và bộ nhớ, sau tối ưu chức năng

- Giữ refresh watermark guard 5 phút và runner recovery 15 phút. Quan sát thêm trường hợp hai timer trùng lịch gây candidate projection_stale; chỉ đổi thứ tự/wake nếu ảnh hưởng SLA được xác nhận.
- Listener hiện phát health query mỗi 2 giây. Chỉ xem xét thay adapter nếu số đo cho thấy đáng kể; không ưu tiên đổi một cơ chế nhẹ đã hoạt động ổn định.
- Inventory staging/rehearsal: owner, mục đích, dependency, rollback và nhu cầu dùng lại. Đề xuất stop các container hết nhu cầu theo danh sách cụ thể được duyệt, giữ volume và khả năng start lại.
- Theo dõi memory peak của Edge khi cold start, query rộng và export. Chỉ đặt limit sau khi xác định headroom; không đặt theo một mẫu idle khiến request hợp lệ bị OOM.
- Xây bảng quan sát: Report p95, cache miss rate, SQL temp bytes/request, refresh executed/unchanged, publish duration/failure, RAM available và I/O wait. Việc cài monitor/alert là bước triển khai được duyệt riêng, chưa tạo automation từ tài liệu này.

## 4. Mục tiêu nghiệm thu đề xuất

Các ngưỡng hiệu năng là mục tiêu, sẽ chốt sau baseline; không phải kết quả đã đạt.

| Hạng mục | Điều kiện |
| --- | --- |
| Đúng dữ liệu | Không có chênh lệch không giải thích được trong ma trận all/A/D, daily/Pax/coverage, deleted/duplicate/overlay tại cùng version và data_as_of |
| Report live SQL | Mục tiêu giảm ít nhất 40% p95 cho ma trận tháng/YTD cache miss và giảm ít nhất 50% temp bytes/request trên cùng clone/workload |
| Tải đồng thời | Không đổi cải thiện latency thành peak memory hoặc ảnh hưởng import/save vượt ngân sách đã chốt; giới hạn concurrency theo workload thực tế |
| API/Report UI | Không gọi lại aggregate cho cùng dữ liệu đã có và còn hợp lệ; chứng minh giảm calls/bytes qua waterfall |
| Dashboard desktop | Mục tiêu giảm ít nhất 70% rows/bytes trong lượt mở tổng quan được tối ưu; không tải thiếu chi tiết hoặc mất metric |
| Publication | Giữ đường đọc nhẹ, immutable head, dirty-marker acknowledgement, idempotency và last-known-good khi lỗi |
| Refresh | Dữ liệu không đổi không chạy full refresh; lỗi không đánh dấu fresh; không retire dependency đang được runner sử dụng |
| Bảo mật | RPC aggregate desktop giữ authorization; public chỉ trả aggregate được phép; không mở row-level data qua tối ưu |

Chạy test:traffic-report-contract, test:dashboard-contract, test:rules và build:traffic-report với đúng production flags cho phần liên quan. Khi thay desktop, chạy thêm build desktop và workspace-window checks phù hợp. SQL canonical cần differential trên PostgreSQL clone ngoài các test PGlite. Nghiệm thu UI desktop/public thực tế được ghi riêng với kiểm thử tự động.

## 5. Release và rollback

Tách thành các thay đổi có thể review/rollback độc lập: baseline/measurement → SQL Report → API/consumer → Dashboard desktop → vận hành tùy chọn. Không gộp chúng với WIP wallboard, forecast hoặc workbook.

Trước mỗi production release: chốt diff/migration hash, preimage, backup theo phạm vi và kết quả clone/staging. Chuẩn bị thứ tự rollback tương thích SQL/Edge/static, giữ implementation cũ trong thời gian theo dõi. Không restore toàn database để rollback một tối ưu truy vấn thông thường.

Sau release: kiểm tra đúng public URL, contract/headers/cache, version/freshness và metric matrix; theo dõi ít nhất một ca vận hành cao điểm và chu kỳ Daily publication, dự kiến 24–48 giờ. Rollback khi có metric mismatch, stale bị hiển thị fresh, lỗi authorization, publish/import/save regression hoặc tài nguyên vượt ngân sách đã chốt.

## 6. Phạm vi thực hiện ở bước lập kế hoạch này

Chỉ tạo tài liệu kế hoạch. Chưa sửa product code, chạy migration/refresh, tạo clone/backup, thay cấu hình, dừng container hoặc triển khai production. Việc implement và production rollout cần được người dùng yêu cầu ở bước tiếp theo; phê duyệt một bước không tự mở rộng sang toàn bộ kế hoạch.
