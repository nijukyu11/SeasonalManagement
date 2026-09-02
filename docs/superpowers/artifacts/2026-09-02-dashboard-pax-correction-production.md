# Daily Pax auto-save và Dashboard correction production receipt

## Kết quả

- Source commit: `072e76b` (`feat(dashboard): publish daily pax corrections`).
- Cutover production: `2026-09-02 19:45` Asia/Ho_Chi_Minh.
- Migration: `20260902150000_public_dashboard_pax_correction.sql`.
- Migration SHA-256: `b802338ef7d9f59c83c7c777f7972fa753712b05214a743b08b2202a0449cdbc`.
- Runner SHA-256: `5b02ae6787e80e1aa796ac56b73af8236002506acc7347ceee34ebc367187654`.
- Runner service SHA-256: `553fa96148ce14049bdfc427cf7da40251e3fd3df8fd6444aa42f5903429f048`.
- Timer SHA-256: `23d5eef27f4d4367d373b76c2cee88423a0182aee18438d57b025adc5662805d`.
- Wake listener SHA-256: `102da6187ee24651c472c0d5c17ad1db759d6eb98d2b38b362dace36557400b2`.
- `systemd-analyze verify` pass; timer và listener đều `enabled`, `active`.
- Oneshot gần nhất `Result=success`, `ExecMainStatus=0`.

Luồng production sau cutover:

```text
Sửa ô Pax → Enter/rời ô → một RPC auto-commit
  → season_modifications + season_change_events(changed_fields=pax)
  → transactional dirty marker + NOTIFY sau COMMIT
  → coalesce 2 phút từ lần sửa cuối
  → single-flight selector/publisher/verifier
  → ready: advance head + acknowledge có điều kiện
  → lỗi/incomplete: giữ last-known-good và dirty marker
```

Client source gửi `changedFields` tường minh. RPC production cũng tự suy ra `changed_fields` từ `operation.mod` khi client cũ bỏ trống trường này, nên không cần chờ deploy bundle Daily Schedule mới để correction capture hoạt động đúng.

## Backup và PostgreSQL 17 clone rehearsal

- Production backup: `/home/ops/seasonal-backups/20260902T122615Z-dashboard-pax-correction/pre-correction.dump`.
- Backup SHA-256: `4754553fd86d9386daf86fc8390c599b151c882f640af223a527711deb0b48cc`.
- Rollout/rollback directory: `/home/ops/seasonal-rollouts/20260902T122615Z-dashboard-pax-correction`.
- Clone container: `seasonal-report-daily-pub-20260901t033824z`, PostgreSQL `17.6`, network `none`.
- Clone database: `pax_correction_rehearsal_20260902`, restore từ production dump hiện hành.
- Migration apply lặp lại thành công.

Clone evidence:

- Daily candidate 01/09 chuyển sang `ready_candidate`: `29580` chuyến, `29548` leg có Pax, `32` leg missing, Pax `5194679`.
- Publication `id=4`, watermark `50110` được tạo và verifier pass.
- Sửa một row bản sao Pax `219 → 220` tạo event `50111`, dirty marker và publication correction `id=5`; Pax tăng đúng `1`.
- Giả lập client cũ không gửi `changedFields` vẫn được trigger fallback bắt; acknowledgement với watermark cũ không clear event mới.
- Sau patch server normalization, một mutation client cũ khác trả `changedFields=[pax]` trực tiếp; publication kế tiếp giữ invariant checksum, head, A+D và missing Pax.
- Transaction rollback không để lại dirty marker.
- Correction lịch sử chọn Business Date của current head, không bị ngày mới hơn chưa mature chặn.

Clone runner dùng `DASHBOARD_VERIFY_PUBLIC_CACHE=false` vì container cô lập network. Production giữ mặc định `true` và bắt buộc kiểm tra public cache.

## Production trước và sau cutover

Trước cutover:

- canonical watermark `50110`, data version `16583`;
- projection `fresh`, cùng watermark `50110`;
- Dashboard head `id=3`, Business Date `2026-08-31`, watermark `50109`;
- candidate 01/09 bị `maturity_incomplete` dù Pax đã biết, do semantics cũ vẫn chờ T+24.

Sau migration, cùng dữ liệu thật trả `ready_candidate`:

```text
business_date=2026-09-01
source_watermark=50110
flights=29580
reported_legs=29548
missing_due_legs=32
reported_pax=5194679
arrival_reported_pax=2565167
departure_reported_pax=2629512
```

Runner tạo immutable publication `id=4`, checksum `c06e3538934ce1240dd06ffbeb1c2a8151e713caa43d17a5c04fb584ebb607a7`, rồi advance head. Verifier DB pass và public cache thấy publication mới ngay attempt `0`.

Public Report v2 với filter `2026-01-01..2026-09-01`, `type=all` và Dashboard publication cùng trả:

| Metric | Report live | Dashboard publication | Kết quả |
| --- | ---: | ---: | --- |
| Watermark | `50110` | `50110` | Khớp |
| Tổng chuyến | `29580` | `29580` | Khớp |
| Pax tổng | `5194679` | `5194679` | Khớp |
| Pax đến | `2565167` | `2565167` | Khớp |
| Pax đi | `2629512` | `2629512` | Khớp |
| Missing Pax | `32` | `32` | Khớp |

Invariant `flights = arrivals + departures` và `Pax tổng = Pax đến + Pax đi` đều pass. Report là live nên `data_as_of` có thể mới hơn thời điểm publication, nhưng cùng watermark/filter trả cùng số.

Report future-date smoke cho 03/09 trả `129` planned flights, timeline `status=future`, `reported_pax=null`, `missing_due_legs=0`. Vì vậy Report vẫn xem được lịch bay tương lai và không biến Pax chưa có thành `0`.

## Correction orchestration và cache

- Trigger `capture_public_dashboard_pax_correction` tồn tại và enabled; marker/functions là private.
- `anon`, `authenticated`, `service_role` đều không có execute trên correction selector.
- Timer persistent chạy mỗi 15 phút; wake listener nhận chung Daily Import và Pax correction notification.
- Production wake smoke nhận transactional channel, chạy runner và trả `already_current`; không tạo publication thừa.
- Retry runner là 2/5/15 phút; correction quiet window là 2 phút tính từ edit cuối.
- Public publication cache `s-maxage=60`; version cache `s-maxage=30`; verifier production chờ tối đa 120 giây.
- Dashboard client tiếp tục poll version và atomic swap; lỗi publish giữ last-known-good.

Không sửa Pax nghiệp vụ production chỉ để làm canary. Đường correction đã được chứng minh end-to-end bằng production-derived clone; lần chỉnh Pax thật đầu tiên trên Daily Schedule là live acceptance còn lại, cần theo dõi event → marker → publication mới trong SLA 2–10 phút.

## Verification source

- `npm run test:traffic-report-contract`: pass `28 + 22 + 7`, PGlite, Edge/isolation và runner contract.
- `npm run test:daily-import`: pass `16`.
- `npm run test:rules`: pass.
- `npx tsc --noEmit --pretty false`: pass.
- `npm run build:traffic-report`: pass, artifact `52` file.
- Targeted ESLint trên các file TS/MJS thay đổi: pass.
- Bash syntax runner: pass bằng Git Bash.
- `git diff --check`: pass, chỉ có warning line-ending Windows.

Full `npm run lint` chưa phải gate sạch vì build artifact `app/out-report` bị scan và có lỗi unrelated đã tồn tại tại `useGanttDragScroll.ts:79`. Không sửa lỗi ngoài phạm vi và không dùng kết quả full lint này để thay thế targeted lint/build/test đã pass.

## Rollback

Các bản orchestration trước cutover nằm trong rollout directory với SHA-256:

- runner: `ff3dad226d1647372985970e0b01a39fd4789b40282937b107a2b6d64fc42650`;
- service: `cc09934cbcfea26c1c3398cd047b565144cecd691b26512000a32761f04c73a0`;
- timer: `23d5eef27f4d4367d373b76c2cee88423a0182aee18438d57b025adc5662805d`;
- listener: `1d172eea88c95276f8f39735f4303c7eb5c2cf424a3bdfede98802ec49df8f42`.

Rollback an toàn trước hết là disable correction orchestration hoặc restore các file `.before`; không xóa publication/event/dirty-marker audit trail. Restore full dump chỉ là phương án cuối và cần phê duyệt riêng.
