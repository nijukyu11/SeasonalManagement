# ADR: Canonical flight-leg store cho Daily, Seasonal và Manual

**Ngày:** 2026-08-29
**Trạng thái:** Đã implement và rollout production ngày 2026-08-29

## Quyết định

`public.season_flight_records` là canonical live leg store. Mọi leg có nguồn `seasonal`, `daily` hoặc `manual` dùng chung active predicate:

```sql
status = 'active' and action is distinct from 'deleted'
```

`season_modifications` tiếp tục là overlay vận hành. Bảng Daily batch legs chỉ là staging/audit; `daily_schedule_active_days` không còn được canonical commit hoặc live compatibility view sử dụng. Bảng legacy `season_modification_added_legs` được backfill về canonical store và bị khóa write.

## Authority và precedence

- Daily commit thay thế toàn bộ active leg của mọi nguồn trong exact affected Ops Dates, soft-delete preimage, insert Daily rows, rebase whitelist overlay và ghi replacement scope trong cùng transaction.
- Seasonal Merge/Full Replace chỉ mutate `source_kind='seasonal'` và không activate Seasonal row trong Daily replacement scope còn hiệu lực.
- Manual add tạo canonical base row `source_kind='manual'`; edit/delete dùng chung canonical RPC và từ chối base đã deleted/superseded.
- Daily authority chỉ được gỡ qua `preview_daily_authority_reset_v1` + `reset_daily_authority_v1`, yêu cầu `season.repair`, expected version, reason và typed confirmation.

## Identity, ngày vận hành và lifecycle

- Active occurrence uniqueness áp dụng xuyên cả ba nguồn.
- Ops Date dùng contract `Asia/Ho_Chi_Minh`, cutoff 05:00 của parser Daily.
- Daily/Seasonal replacement không hard-delete history. Row bị thay thế ghi đồng thời `status='deleted'`, `action='deleted'`, provenance batch và deletion reason.
- Zero-flight day phải nằm trong explicit affected dates và được operator xác nhận; tên file chỉ là hint.

## Reporting và projection

Consumer nội bộ đọc canonical compatibility/effective boundary. Public traffic report build projection từ canonical effective view, lưu source data version/watermark và trả metadata `fresh|stale`, để stale projection không bị hiển thị như empty thật.

## Hệ quả

- Seasonal V2 commit bị vô hiệu sau cutover; Seasonal write dùng V3 source-scoped authority.
- Legacy structures được giữ trong rollback window, chưa drop.
- Production rollout đã đi theo phase additive → shadow reconcile → read cutover → write cutover, sau PostgreSQL 17 clone rehearsal, backup và phê duyệt. Các rollout tiếp theo vẫn phải giữ cùng các gate này.
