# Implementation receipt — Report live + Dashboard Daily Publication

**Ngày:** 2026-09-01 10:42 GMT+7

**Source baseline:** `d5695bbbe3e9c7dbce6800ca5789ae40a4c52318`

**Branch:** `codex/live-traffic-aggregate-integration`

**Production mutation:** Không

## Local gates

- `npm run test:traffic-report-contract`: pass.
- `npx tsc --noEmit --pretty false`: pass.
- Targeted ESLint cho Report/Dashboard contracts và clients: pass.
- `npm run build:traffic-report`: pass; static artifact 52 files, gồm `/reports/traffic` và `/reports/traffic/dashboard`.
- PGlite apply migrations hai lần: pass.
- Edge/source/isolation contract: pass.

PGlite chứng minh:

- Report Read Version giữ cùng watermark + semantic `data_as_of` cho overview/timeline/dimension/export.
- `Pax NULL` giữ `null`; true-zero giữ `0`.
- publisher idempotent; stale watermark bị `rejected_version`.
- incomplete/failed attempt không thay last-known-good.
- correction tạo publication id mới; finalized row không sửa tại chỗ.
- `service_role` chỉ gọi wrapper; không đọc ledger/private metrics trực tiếp.

## Lỗi lineage phát hiện trong implementation

Bounded live candidate seam đã loại modification tombstone trước canonical ranking, có thể hồi sinh predecessor cũ. Fixture thực tế cho 02/03 trả `180` thay vì canonical `80`.

Đã sửa seam giữ tombstone đến sau ranking. Differential/PGlite sau sửa pass và publication trả đúng `80`.

## Isolated production-clone rehearsal

- Host: production host, nhưng chỉ `pg_dump` read-only từ database chính.
- Run id: `20260901T033824Z`.
- Clone container: `seasonal-report-daily-pub-20260901t033824z`, network `none`.
- PostgreSQL: 17.6.
- Production database size: 931 MB; custom dump: 62 MB.
- Clone source watermark: `49954`.
- Clone migration order: candidate seam -> live aggregate v2 -> Daily Publication.
- Clone MV refresh và projection mark fresh: pass.
- Rehearsal receipts giữ tại `/home/ops/seasonal-rollouts/20260901T033824Z-report-daily-publication`.

Restore ban đầu dừng do role ownership/ACL của cluster khác image mặc định. Clone được tạo lại với đúng ba role `NOLOGIN` còn thiếu và restore bằng `supabase_admin --no-owner`; không bỏ ACL và không chạm database production.

### Report differential

Khoảng 01/08/2026–31/08/2026, scope `all`, `A`, `D`:

- flights, arrivals, departures: khớp v1/v2;
- total/arrival/departure Pax: khớp;
- due/reported leg: khớp;
- daily timeline flights/A/D/Pax: khớp;
- source watermark: `49954`;
- final warm transaction: 1.918 giây cho ba scope.

Re-run vài phút sau refresh ban đầu lệch do v2 lấy clock mới trong khi v1 cố định ở projection `refreshed_at`; một số Pax đã mature giữa hai thời điểm. Comparator cuối pin cả hai vào cùng semantic `data_as_of` và pass. Đây là bằng chứng thực tế cho Report Read Version, không phải data-source differential.

### Publication maturity gate

Rehearsal đầu tiên phát hiện publisher có thể ready sớm khi Business Date đã qua nhưng Pax T+1 của mọi leg chưa mature. Tại thời điểm rehearsal:

- row/flight count: `29460`;
- due legs: `29354`;
- not-yet-due legs: `106`;
- reported due legs: `29308`.

Đã bổ sung điều kiện ready `due_legs = flights`. Reapply trên clone và rerun cho kết quả:

- status: `incomplete`;
- error: `daily maturity, coverage, or Pax completeness validation failed`;
- current Dashboard publication: missing (không advance pointer);
- latest attempt status: `incomplete`;
- compute time: 1.580 giây.

ACL receipt:

```json
{"anon_publisher":false,"service_role_publisher":true,"service_role_direct_ledger":false}
```

Final clone check cũng chứng minh retry cùng idempotency key giữ đúng một attempt row và trigger chặn cả update lẫn delete finalized publication.

## Production unchanged verification

Sau clone rehearsal:

- production source watermark: `49954`;
- production projection: `fresh|49954`;
- live v2 function trên production: absent;
- publication ledger trên production: absent.

Không apply migration, deploy Edge/static artifact, install publisher, refresh production hoặc đổi feature flag.

## Remaining release gates

1. Duyệt production Release A (additive backend only) riêng.
2. Thiết lập Edge read-version secret và deploy Edge additive.
3. Shadow publication sau thời điểm mọi leg của Business Date đã mature; đối chiếu nhiều ngày.
4. Staging browser/cache/failure UAT.
5. Duyệt riêng Dashboard cutover, rồi Report live cutover.
6. Giữ MV/timer v1 làm rollback đến hết soak; cleanup cần phê duyệt khác.
