# Runbook vận hành canonical Daily/Seasonal

## 1. Daily preview

1. Đảm bảo target season không có draft/pending sync.
2. Upload `.xls` hoặc `.xlsx`. Parser map theo vị trí trường, không theo tiêu đề.
3. Đối chiếu preview: Ops Dates, leg count, Pax trước/sau, nguồn Seasonal/Daily/Manual bị thay, overlay rebase và checksum.
4. Nếu có coverage gap, nhập rõ từng zero-flight Ops Date rồi stage lại. Không suy ngày leading/trailing từ tên file.
5. Chỉ commit sau khi typed confirmation khớp chính xác preview.

## 2. Commit và unknown outcome

- Commit dùng batch ID, preview hash và expected season versions. Lỗi stale/version hoặc identity collision phải stage lại; không retry bằng payload đã sửa dưới cùng request ID.
- Nếu client mất kết nối sau khi gửi commit, gọi status bằng request ID. `committed` kèm receipt là kết quả cuối; không upload lại file để đoán trạng thái.
- Receipt cần lưu: batch, affected dates, before/deleted/inserted/active counts, Pax, overlay rebase, data version, checksum và server high-water.

## 3. Reconcile sau commit

Chạy các truy vấn read-only trong artifact `2026-08-29-canonical-flight-leg-store-reconciliation.sql` tại cùng source version. So sánh:

- staged legs với canonical Daily rows;
- active/effective count và Pax theo Ops Date;
- replacement-scope checksum/count;
- report projection source version/watermark và freshness.

Mismatch, stale projection hoặc overlay ambiguity là No-Go. Không sửa trực tiếp row production.

## 4. Reset Daily authority

Reset là repair có phá authority, không phải thao tác import bình thường:

1. Người thực hiện phải có `season.repair`.
2. Gọi preview với season, exact Ops Dates và expected data version.
3. Đối chiếu current Daily count, preimage count/Pax và overlay count.
4. Nhập nguyên văn `confirmationText`, reason tối thiểu 10 ký tự và request UUID mới.
5. Commit reset sẽ atomic: soft-delete Daily rows hiện tại, reactivate exact rows bị batch đó supersede, đánh dấu scope reset, tăng data version và phát audit event.
6. Retry cùng request UUID trả cùng receipt. Không tự update `reset_at` hay lifecycle columns.

## 5. Seasonal rebuild sau Daily

- Chỉ dùng Seasonal V3. V2 commit cố ý bị chặn sau canonical cutover.
- Merge/Full Replace không được đổi Daily/Manual checksum.
- Seasonal rows trong active Daily scope được lưu deleted với reason `daily_authority`, kể cả zero-flight scope, để không resurrect lịch.

## 6. Rollback release

- Trước write cutover: tắt feature flag/read path mới, giữ additive schema.
- Sau canonical commit: dùng audited reset/reversal, không hard-delete batch mới hoặc sửa preimage bằng tay.
- Projection chỉ được đánh dấu fresh sau khi refresh thành công từ canonical source.
- Drop legacy pointer/table là migration riêng sau rollback window và cần phê duyệt riêng.

## 7. Canonical helper privileges

- Các view `security_invoker` yêu cầu caller có `EXECUTE` trên `is_canonical_flight_leg_active_v1`, `canonical_flight_leg_ops_date_v1` và `canonical_flight_leg_occurrence_key_v1`.
- Giữ `PUBLIC` và `anon` bị revoke; cấp cho `authenticated`, `service_role` và `seasonal_bi_reader` nếu role BI tồn tại.
- Trên self-hosted production, chạy migration ACL bằng object owner `supabase_admin`. Sau đó probe Workspace V2 bằng role `authenticated`; không coi warning `no privileges were granted` là thành công.
