# Canonical flight-leg store — verification và production rollout

**Ngày:** 2026-08-29

**Phạm vi:** code, PGlite, parser shadow, TypeScript, production build, PostgreSQL 17 clone rehearsal và production rollout có kiểm soát

## Kết quả implementation

- Canonical schema/provenance/lifecycle, active occurrence uniqueness và manual-leg backfill: đã implement bằng additive migrations.
- Daily stage/preview: count/Pax/source/overlay plan, immutable preview hash, expected version và explicit zero-flight confirmation.
- Daily commit: soft-delete toàn scope + insert canonical Daily + overlay rebase + scope/audit/version trong một transaction; active-day pointer không được cập nhật.
- Manual add/edit/delete: dùng canonical RPC, không tạo live row ở legacy added-leg table và từ chối stale/deleted base.
- Seasonal V3 Merge/Full Replace: chỉ mutate Seasonal, tôn trọng Daily authority kể cả zero-flight day; V2 commit bị chặn sau cutover.
- Reporting: canonical effective boundary; public projection có source version/watermark/freshness và UI cảnh báo stale.
- Repair: preview + typed-confirmed, permissioned, idempotent Daily authority reset.

## Bằng chứng test

- `npm run test:daily-import`: pass 7/7.
- `npm run test:canonical-flight-store`: pass.
- `npm run test:daily-canonical-commit`: pass, gồm failpoint sau delete/sau insert/trước audit, zero-flight và reset rollback/idempotency.
- `npm run test:canonical-manual`: pass.
- `npm run test:seasonal-canonical-authority`: pass, gồm Merge/Full Replace và zero-flight authority.
- `npm run test:rules`, `test:dashboard-contract`, `test:daily-import-sql`, `test:seasonal-import-v3-sql`, `test:seasonal-schema-twice`: pass.
- `npx tsc --noEmit` và `npm run build` của app chính: pass.
- Public traffic report `npm run test:traffic-report-contract` và `npm run build`: pass.

## Hai workbook thật — read-only shadow

- `LB_20260823_20260827.xlsx`: valid, profile `compact-lb`, 358 source rows, 596 legs, S26 từ 2026-08-23 đến 2026-08-27, không diagnostics.
- `OperationalTurns (16).xls`: valid, profile `legacy-operationalturns`, 4.985 source rows, 8.072 legs, S26 từ 2026-08-01 đến 2026-09-30, không diagnostics.
- File LB ghi nhận 63 bare `G`, 295 Gate có prefix, 6 Stand alphanumeric, 296 Counter `C...` và 8 token `M...`; normalization contract đã được parser test và shadow áp dụng.

## Production/clone status

- PostgreSQL 17 isolated clone rehearsal đã pass trước production, với backup và reconciliation được giữ làm rollback evidence.
- Production đã áp dụng tuần tự bảy migration canonical/Daily/Manual/Seasonal/reset/reporting. Final Daily batch `1280be3c-f83f-44c0-a1b2-0c442551849c` thay atomic range `2026-08-23` đến `2026-08-27` ở data version `16577`, high-water `47548`.
- Canonical effective state và public traffic snapshot cùng trả 594 flights, 593 Pax-known legs và 102.307 Pax; active occurrence collision và lifecycle mismatch đều bằng 0.
- Public traffic materialized view đã cut over sang canonical effective source, refresh thành công và khớp watermark `47548/47548` tại thời điểm acceptance.
