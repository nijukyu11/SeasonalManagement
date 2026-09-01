# ADR: Report live và Dashboard dùng Daily Publication

**Ngày:** 2026-09-01

**Trạng thái:** Đã implement và cutover production; hybrid runner là orchestration chính thức

## Bối cảnh

Public Report và public Dashboard có hai mục tiêu vận hành khác nhau:

- Report phục vụ truy vấn tình hình khai thác theo ngày hoặc kỳ tùy chọn tại bất kỳ thời điểm nào, và sẽ xuất báo cáo theo workbook mẫu.
- Dashboard là wallboard công cộng chạy 24/7, hiển thị thông tin chung và thường chỉ cần một lần công bố số liệu đã nghiệm thu mỗi ngày.

Hiện tại Report v1 và annual KPI Dashboard cùng đọc `reporting.public_traffic_effective`, nhưng dùng contract và phép dựng metric riêng. Live aggregate v2 đã tạo một shared adapter cho Report và Desktop Dashboard Report Mode; adapter đó không phù hợp làm read path cho public wallboard vì wallboard cần availability-first, last-known-good và publication semantics thay vì live-query semantics.

Clone rehearsal cũng chứng minh source watermark không đủ để xác định hai kết quả tương thích: cùng watermark vẫn có thể khác Pax khi semantic data-as-of khác nhau do time-based maturity.

## Quyết định

### 1. Một Canonical Traffic Metrics Module

Report và public Dashboard dùng chung một Canonical Traffic Metrics Module. Module này sở hữu Implementation của:

- canonical active/deleted/duplicate resolution;
- `season_modifications` overlay;
- Ops Date `Asia/Ho_Chi_Minh`, cutoff 05:00;
- A, D và all;
- flight count và daily series;
- Pax total/A/D, reported/due/missing/true-zero legs;
- complete/partial/missing/future/zero states.

Không frontend hoặc Adapter nào được tự tính lại các metric này.

### 2. Report đọc live canonical committed data

Report dùng Report Read Adapter. Initial read trả một Report Read Version gồm:

- metrics contract version;
- source watermark và data version;
- semantic data-as-of;
- latest completed Ops Date;
- normalized filter hash;
- opaque read token.

Timeline, dimension và export read phải dùng cùng Report Read Version. Nếu source watermark đổi, Adapter từ chối ghép dữ liệu và yêu cầu full reload/restart export.

Report Read Version chỉ phát hiện drift giữa các request; nó không giữ một PostgreSQL MVCC snapshot cũ. Export cần tái lập phải chạy trong một statement/job cố định và giữ receipt riêng.

### 3. Dashboard đọc Daily Publication

Public Dashboard không gọi Report Read Adapter. Sau khi Business Date hoàn tất daily import/reconciliation acceptance, Daily Publisher Adapter:

1. xác nhận expected watermark;
2. chụp semantic data-as-of;
3. tính qua Canonical Traffic Metrics Module;
4. kiểm tra watermark lần nữa;
5. chạy validation;
6. lưu checksum và receipt;
7. atomically chuyển current publication pointer nếu kết quả ready.

Mỗi Daily Publication là bất biến. Correction/republish tạo publication mới và giữ publication cũ cho audit.

Publication Ledger ghi các trạng thái:

```text
pending | ready | incomplete | empty | rejected_version | failed
```

Chỉ `ready` được advance current pointer. Certified zero-flight Business Date có thể `ready`; unexpected absence of usable aggregate data là `empty`.

Dashboard Read Adapter trả latest ready publication và current-pointer version nhỏ. Dashboard giữ last-known-good khi publisher hoặc version check lỗi, đồng thời hiển thị Business Date/publication freshness trung thực.

### 3.1. Hybrid runner ngoài transaction import

Daily Import không gọi Publisher trong transaction. Coverage trigger phát transactional `NOTIFY` sau khi ghi acceptance; notification chỉ được giao khi commit thành công. Một Listener Adapter đánh thức runner oneshot và lên lịch retry sau năm và mười lăm phút. Timer persistent 15 phút tiếp tục bắt lại notification bị lỡ hoặc server restart.

Runner là một Deep Module có Interface `run|listen`; Implementation giữ ba seam nội bộ:

- Candidate Selector chọn Business Date theo Ops Date 05:00–04:59, coverage liên tục, projection freshness, watermark, data version và maturity/Pax;
- Publisher Adapter tạo immutable attempt bằng idempotency key `annual-kpi:year:BusinessDate:watermark`;
- Verifier kiểm tra head, checksum, freshness, A+D, missing Pax và public cache SLA.

Runner dùng single-flight lock. `ready` mới advance head; `incomplete`, `empty`, `rejected_version` hoặc `failed` không sửa/xóa attempt và không thay last-known-good.

### 4. Pax presence là invariant chung

- `Pax NULL` là chưa báo cáo/missing.
- `Pax 0` là đã báo cáo true-zero.
- Không dùng `coalesce(pax, 0)` để tính hoặc hiển thị.

### 5. Snapshot v1 là rollback tạm thời

`reporting.public_traffic_effective`, projection state và refresh timer tiếp tục tồn tại trong dual-run/soak window. Việc retire chúng là release riêng sau khi Report live và Daily Publication đạt clone, staging, shadow comparison, wallboard UAT và production soak.

## Interface và Seam

Seam ngoài của kiến trúc có ba Interface:

```text
Report Read Adapter
  read report(query) -> report + Report Read Version
  read resource(query, Report Read Version, resource)

Daily Publisher Adapter
  publish(Business Date, expected watermark, reason, trigger) -> receipt

Dashboard Read Adapter
  read latest ready publication(year)
  check current publication pointer(year, known publication id)
```

Canonical Traffic Metrics Module là Deep Module phía sau ba Interface. SQL helpers, candidate scans, validation queries và persistence là Implementation riêng, không rò ra frontend contract.

## Hệ quả tích cực

- Report giữ đúng mục tiêu live/on-demand mà không buộc Dashboard chịu latency và failure mode của live query.
- Dashboard có atomic swap, last-known-good, audit history và cache payload bất biến.
- Locality của metric nằm trong một Module; sửa Pax/A-D/Ops Date có Leverage lên cả hai Adapter.
- Daily publication bình thường không cần clone rehearsal; clone vẫn bắt buộc cho thay đổi schema/SQL/release.
- Có thể retire materialized snapshot lớn sau soak mà không đánh đổi độ sẵn sàng wallboard.

## Chi phí và rủi ro

- Cần publication ledger/current pointer và publisher orchestration mới.
- Report live YTD/full-range phải được profile/lazy-load trước cutover.
- Read token không tự cung cấp historical replay; export phải có execution/receipt riêng.
- Daily acceptance cần cung cấp Business Date và expected watermark đáng tin cậy.
- Cần phân biệt public Dashboard với Desktop Dashboard Report Mode trong code, test và tài liệu.

## Phương án không chọn

### Cả Report và public Dashboard cùng gọi live aggregate

Không chọn vì tạo Shallow reuse: cùng Adapter nhưng khác SLO, cache cadence và failure strategy. Wallboard có thể blank/chậm khi live aggregate hoặc canonical scan gặp lỗi.

### Cả hai chỉ đọc daily snapshot

Không chọn vì Report mất khả năng kiểm tra canonical committed data tại thời điểm người dùng truy vấn.

### Frontend dùng chung utility để tính metric

Không chọn vì aggregate logic, Pax privacy/presence và lifecycle sẽ rò qua frontend, làm mất Locality và không bảo đảm một PostgreSQL statement snapshot.

### Chỉ giữ publication mới nhất

Không chọn vì không tái lập được wallboard đã công bố, không có correction lineage và khó audit mismatch.

## Quan hệ với quyết định trước

- Giữ nguyên ADR `2026-08-29-canonical-flight-leg-store.md`: canonical live leg store, active predicate, overlay và Ops Date không thay đổi.
- Điều chỉnh hướng trong kế hoạch `2026-08-31-live-traffic-aggregate-report-dashboard.md`: shared live Adapter tiếp tục phù hợp cho Report và Desktop Dashboard Report Mode, nhưng không phải read path đích cho public Dashboard 24/7.

## Cổng triển khai

Gate production của quyết định này đã đạt ngày 01/09/2026 bằng production-derived clone, backup, migration transaction, systemd verification, wake smoke và kiểm tra last-known-good. Mọi thay đổi schema/SQL/timer/cache tiếp theo vẫn cần evidence, clone/staging rehearsal tương ứng và phê duyệt production riêng.
