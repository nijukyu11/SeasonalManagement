# Report live + Dashboard Daily Publication production cutover receipt

## Kết quả

- Thời điểm release: `2026-09-01T05:03:47Z`.
- Production source watermark: `49954`.
- Projection state: `fresh:49954`.
- Report đã cutover sang `traffic-report-v2`, nguồn `live`.
- Dashboard đã cutover sang immutable Daily Publication `id=2`, Business Date `2026-08-30`.
- Release tĩnh hiện hành: `/srv/seasonal-traffic-report/releases/20260901T050347Z-report-dashboard-ready-cutover`.
- Release tĩnh rollback: `/srv/seasonal-traffic-report/releases/20260831T122517Z-kpi-cache-fix-production`.

## Backup và rehearsal

- Backup: `/home/ops/seasonal-backups/20260901T050347Z-report-dashboard-ready-cutover/pre-cutover.dump`.
- SHA-256 backup: `b25844709bb5a923c17622c7a9d816a0963a4a5658f3836ef948155f3687e0a5`.
- Rollout evidence: `/home/ops/seasonal-rollouts/20260901T050347Z-report-dashboard-ready-cutover`.
- Clone chạy bằng PostgreSQL production-derived, `--network none`, bảo toàn owner/ACL.
- Bốn canonical Daily import event `49951`, `49953`, `49952`, `49954` được accept.
- Event superseded `47560` bị từ chối với `Daily import receipt no longer owns every affected Ops Date`.
- Retry event `49954` trả lại cùng `coverage_id=4`.
- Clone có `242/242` ngày complete, `missing=0`, `partial=0` và tạo publication `ready`.
- Clone checksum hợp lệ; `anon/authenticated` không gọi được acceptance; `service_role` không đọc trực tiếp coverage ledger.

## Production Release C — coverage và publication

- Migration: `20260901114500_public_traffic_daily_acceptance.sql`.
- Coverage ledger: `4` receipt canonical, phủ `2026-01-01..2026-08-31`.
- Trigger `capture_public_traffic_daily_acceptance`: tồn tại đúng một bản; future canonical Daily import commit sẽ tự ghi coverage sau khi kiểm tra batch, range, data version, checksum và replacement scope hiện hành.
- Publication history: giữ nguyên attempt `id=1` incomplete và thêm attempt `id=2` ready.
- Current head: publication `id=2`.
- Payload checksum: `914cadf107eb36789b9d4ffc77f6695aefa5f5b4bc7474b6e40ef280c74964aba`, kiểm tra lại từ payload trả `true`.
- ACL: acceptance wrapper chỉ cấp cho `service_role`; ledger vẫn không public.

## Đối chiếu cùng filter/as-of

Phạm vi `2026-01-01..2026-08-30`, type `all/A/D`, watermark `49954`:

| Metric | Report live v2 | Dashboard publication | Kết quả |
| --- | ---: | ---: | --- |
| Tổng chuyến bay / due legs | 29.340 | 29.340 | Khớp |
| Tổng Pax đã báo cáo | 5.157.402 | 5.157.402 | Khớp |
| Pax đến | 2.548.214 | 2.548.214 | Khớp |
| Pax đi | 2.609.188 | 2.609.188 | Khớp |
| Legs có Pax | 29.308 | 29.308 | Khớp |
| Legs chưa có Pax | 32 | 32 | Giữ trạng thái missing, không đổi thành 0 |

`A + D = all` cho cả flights và reported Pax. Production differential trả `same_metrics=true`.

## Production Release D — static cutover

- Build flags: `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED=1`, `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION=true`.
- Artifact SHA-256: `88be0ecf51879b36f0ab74c42a8d254a87a9b88c1574d33014272bf93e82e082`.
- Artifact được giải nén vào release immutable mới; symlink `/srv/seasonal-traffic-report/current` được đổi atomically.
- Nginx config test pass trước cutover.

Public API smoke:

- `/api/report/v2/overview?from=2026-01-01&to=2026-08-30`: `200`, `traffic-report-v2`, `X-Report-Source-Mode: live`, watermark `49954`, flights `29340`, Pax `5157402`.
- `/api/report/v1/dashboard-publication?year=2026`: `200`, publication `2`, Business Date `2026-08-30`, Pax `5157402`, cache `HIT` với ETag mới.
- `/api/report/v1/dashboard-publication-version?year=2026`: `200`, freshness `fresh`, watermark `49954`.

Browser UAT trên URL production:

- Report render “Nguồn live · watermark 49.954”, tổng `29.340` chuyến và `5.157.402` Pax; A/D render `14.682 / 14.658` chuyến và `2.548.214 / 2.609.188` Pax.
- Dashboard render “Ngày số liệu 30/08/2026”, `5.157.402 / 7.487.168`, Pax đến `2.548.214`, Pax đi `2.609.188`.
- Biểu đồ thực tế có kích thước render `1159 × 410`. Cảnh báo Recharts tại thời điểm mount là transient, không làm mất chart.

## Vận hành và rollback

- Command acceptance: `/usr/local/sbin/seasonal-traffic-dashboard-accept`.
- Command publication: `/usr/local/sbin/seasonal-traffic-dashboard-publish`.
- Hai command dùng stdin cho `psql` qua `docker exec -i`; watermark và status vẫn fail closed.
- Chưa retire MV/timer v1 trong release này. Việc cleanup chỉ thực hiện sau soak và phê duyệt riêng.
- Rollback UI tức thì: trỏ symlink `current` về release cũ ở trên.
- Rollback database khi cần: dùng full backup nêu trên; không xóa publication/coverage ledger để che audit trail.
- Daily Publication tiếp theo chỉ advance head khi publisher trả `ready`; attempt incomplete/empty/failed giữ last-known-good.
