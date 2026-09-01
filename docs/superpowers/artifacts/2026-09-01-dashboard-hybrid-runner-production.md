# Dashboard hybrid runner production receipt

## Kết quả

- Thời điểm cutover: `2026-09-01 23:35` Asia/Ho_Chi_Minh.
- Migration: `20260901123000_public_dashboard_hybrid_runner.sql`.
- Migration SHA-256: `f9f8e3859d1ddf3722f30977345b836cd4a4aac8697a47bacf93aef73c779080`.
- Runner SHA-256: `ff3dad226d1647372985970e0b01a39fd4789b40282937b107a2b6d64fc42650`.
- Publisher SHA-256: `b3b8d4d222b0c88f5b5b0981cf3eaece1ab2818bff085f0c49a15ef824dee6cd`.
- Listener và timer production đã enable; oneshot gần nhất trả `Result=success`, `ExecMainStatus=0`.

Hybrid runner hiện chạy theo ba seam Candidate Selector → Publisher → Verifier. Daily Import chỉ ghi canonical coverage và phát transactional `NOTIFY`; Publisher không chạy trong transaction import.

## Backup và production-derived clone

- Backup: `/home/ops/seasonal-backups/20260901T163000Z-dashboard-hybrid-runner/pre-hybrid-runner.dump`.
- Backup SHA-256: `587929461d0d7a9325f988cb207de4af7b235b29841cd483cf5e3c2402fc65bd`.
- Rollout evidence: `/home/ops/seasonal-rollouts/20260901T163000Z-dashboard-hybrid-runner`.
- Clone container: `seasonal-report-daily-pub-20260901t033824z`, PostgreSQL `17.6`, network `none`.
- Database clone mới: `hybrid_runner_rehearsal_20260901`, restore từ production dump hiện hành.
- Clone baseline: watermark `50104`, coverage `4` receipt đến `2026-08-31`, publication ledger `2` row.
- Migration apply hai lần thành công trên clone.

Clone gates đã đạt:

- cutoff `05:00`: lúc `03:00` ngày 02/09, latest completed Ops Date là 31/08; lúc `06:00`, latest completed là 01/09;
- Candidate chỉ chọn ngày đã có coverage complete; coverage mới nhất hiện là 31/08;
- projection `stale` trả `projection_stale` và không gọi Publisher;
- verifier của last-known-good `id=2` trả checksum/head/A+D/missing-Pax hợp lệ;
- `anon`, `authenticated` và `service_role` không có execute trên Candidate Selector/Verifier nội bộ;
- function capture có `pg_notify`, không chứa lời gọi Publisher;
- listener nhận notification clone; runner defer giữ ledger `2` row và head `id=2`;
- không tạo mock Pax hoặc publication để kết luận đường production `ready`.

## Production baseline và hành vi cutover

Ngay trước migration:

- canonical source watermark: `50104`;
- projection: `fresh`, watermark `50104`, data version `16581`;
- coverage complete đến `2026-08-31`;
- Dashboard head: publication `id=2`, Business Date `2026-08-30`, watermark `49954`;
- publication ledger: `2` row.

Sau cutover, candidate thật cho 31/08 trả:

```text
status=maturity_incomplete
flights=29460
due_legs=29446
reported_legs=29308
missing_due_legs=138
pax_coverage_pct=99.53
source_watermark=50104
projection_watermark=50104
```

Vì `due_legs != flights`, runner không gọi Publisher. Ledger vẫn `2` row và head vẫn `id=2`; không có attempt giả hoặc head advance sớm. Khi giả lập thời điểm sau cutoff trên clone, toàn bộ `29460` leg đã due nhưng Pax coverage chỉ `99.48%`, nên candidate vẫn không đủ maturity. Đây là kết quả từ production-derived data, không phải mock.

Public API sau cutover:

- Report v2 đọc live watermark `50104`, data version `16581`, source mode `live`;
- với cùng phạm vi đến 30/08, Report trả `29340` chuyến, Pax `5157402`, Pax đến `2548214`, Pax đi `2609188`, missing Pax `32`;
- Dashboard tiếp tục trả publication `id=2`, Business Date `2026-08-30`, watermark `49954`, cùng các metric trên;
- Dashboard publication-version trả `fresh` cho immutable current publication;
- `Pax NULL` tiếp tục được phản ánh bằng missing leg, không chuyển thành `0`.

Report có thể nhìn thấy watermark mới trước Dashboard là hành vi có chủ đích: Report là live/on-demand, còn Dashboard chỉ đổi head khi Business Date đủ maturity và Pax contract. Business Date và source watermark của Dashboard vẫn được công khai trong publication metadata.

## Wake, retry và timer

- `seasonal-traffic-dashboard-wake-listener.service`: `active/running`.
- `seasonal-traffic-dashboard-runner.timer`: `active/waiting`, lịch `*:0/15`, persistent.
- Smoke `pg_notify('public_dashboard_daily_wake', ...)` trên production tạo hai transient retry tại `+5` và `+15` phút.
- Runner dùng non-blocking `flock`; một instance khác gặp lock sẽ exit thành công mà không publish.
- Rehearsal journal phát hiện health query của listener tạo header/`(0 rows)` mỗi hai giây. Runner đã chuyển kết nối LISTEN sang `psql -t -A`; clone và production smoke sau restart đều nhận wake mà không còn `listener_output` spam.
- Warning/failure được ghi stdout, journald và syslog. Alert Adapter `/usr/local/sbin/seasonal-traffic-dashboard-alert` là seam tùy chọn; production hiện chưa cấu hình kênh cảnh báo ngoài host.

## Cài đặt và rollback

Các file production là `root:root`: runner/publisher mode `0755`, systemd units mode `0644`. `systemd-analyze verify` không trả warning/error.

Rollback orchestration không sửa hoặc xóa publication ledger:

```bash
sudo systemctl disable --now seasonal-traffic-dashboard-runner.timer
sudo systemctl disable --now seasonal-traffic-dashboard-wake-listener.service
sudo systemctl stop seasonal-traffic-dashboard-runner.service
sudo cp /home/ops/seasonal-rollouts/20260901T163000Z-dashboard-hybrid-runner/seasonal-traffic-dashboard-publish.before \
  /usr/local/sbin/seasonal-traffic-dashboard-publish
```

Các function Candidate Selector/Verifier là additive. Transactional notification trở thành no-op nếu listener bị disable; không cần sửa transaction Daily Import để rollback orchestration. Full database dump ở trên chỉ là rollback cuối cùng và không được restore production khi chưa có phê duyệt riêng.

## Verification local

- `npm run test:traffic-report-contract`: pass `27 + 22 + 7`, PGlite, Edge contract và isolation.
- `npm run build:traffic-report`: pass, artifact `52` file.
- Bash syntax của runner/publisher: pass.
- `git diff --check`: pass; chỉ có warning line-ending của Windows working tree.
