# Runbook vận hành canonical Daily/Seasonal

## 1. Daily preview

1. Đảm bảo target season không có draft/pending sync.
2. Upload `.xls` hoặc `.xlsx`. Parser map theo vị trí trường, không theo tiêu đề.
3. Đối chiếu preview: Ops Dates, leg count, Pax trước/sau, nguồn Seasonal/Daily/Manual bị thay, overlay rebase và checksum.
4. Nếu có coverage gap, nhập rõ từng zero-flight Ops Date rồi stage lại. Không suy ngày leading/trailing từ tên file.
5. Kiểm tra phạm vi preview rồi bấm Commit; không cần nhập chuỗi xác nhận. Ngày zero-flight vẫn phải được xác nhận riêng trước khi stage lại.

## 2. Commit và unknown outcome

- Commit dùng batch ID, preview hash và expected season versions. Lỗi stale/version hoặc identity collision phải stage lại; không retry bằng payload đã sửa dưới cùng request ID.
- Nếu client mất kết nối sau khi gửi commit, gọi status bằng request ID. `committed` kèm receipt là kết quả cuối; không upload lại file để đoán trạng thái.
- Receipt cần lưu: batch, affected dates, before/deleted/inserted/active counts, Pax, overlay rebase, data version, checksum và server high-water.

## 2.1 Diễn giải loose identity khi operator đã tạo lại chuyến

- Leg trong file khớp canonical row theo loose identity: season, Ops Date, side, hãng và số hiệu đã chuẩn hoá (bỏ space/leading zero/hậu tố chữ).
- Row canonical đang active luôn thắng terminal row cũ: overlay (gate/stand/counter/Pax) của row active được rebase lên generation mới, còn terminal row chỉ là lineage lịch sử của chuyến đã xoá nên không được dùng lại làm nguồn overlay.
- `DAILY_LOOSE_IDENTITY_COLLISION` chỉ còn khi có từ hai row active trở lên cùng loose identity, hoặc khi không có row active nào mà tồn tại nhiều terminal generation khác occurrence key.
- Vì vậy preview hợp lệ vẫn có thể có `effectiveAfterCount` nhỏ hơn `afterCount`: đó là các leg bị giữ cancelled theo deletion overlay (`reason = overlay_deleted`) mà operator đã xoá trước đó, không phải mất dữ liệu. Muốn cho chuyến bay trở lại, xoá modification deleted của row đó bằng flow canonical (không sửa row trực tiếp) rồi stage lại.

## 2.2 Seasonal repair: timeout sau preview hợp lệ

- `Failed to fetch` không chứng minh commit thất bại. Dùng Resume/Check với **cùng request ID**; không tạo import mới hoặc bấm Commit lặp khi chưa biết kết quả.
- Nếu status trả `committed`, dùng Refresh để nhận snapshot mới, không commit lại. Nếu status trả `validated`, kiểm season version/preview rồi operator xác nhận Commit. Nếu preview expired/stale, stage lại theo flow của app.
- Với W26 Ver2 ngày 2026-10-06, log production ghi Kong HTTP 499 ở 125 giây và PostgREST `57014` ở 180 giây; batch vẫn `validated`, season version 401. Stage đã chấp nhận 22.945 occurrences; duplicate/zero-generated warnings không phải nguyên nhân timeout.
- Migration `20261006093000_seasonal_commit_indexed_conflicts_v1.sql` chỉ tối ưu generated-ID conflict lookup và index bảng tạm. Không thay rule repair, winner policy, Daily authority, overlay hoặc timeout. Workbook thật stage + commit trên bản sao mất khoảng 25 giây; không coi phép đo bản sao là bằng chứng production W26 đã được Replace.
- Trước apply, đối chiếu preimage function digest và rehearsal. Sau apply, kiểm post digest `5ac42483b1b974b30df9ce176ceb9d03`, chạy authenticated stage/commit/status/replay với season thử trong transaction rollback và xác nhận request thật không đổi.
- Rollback dùng `20261006093000_seasonal_commit_indexed_conflicts_v1.rollback.sql`; đã rehearsal byte-exact pre-digest `faefa36cab6c3f684ce17e0594ad0ef0`. Rollback hàm không đảo dữ liệu của một import đã commit.
- Receipt và `SHA256SUMS` tại `/home/ops/seasonal-commit-indexed-conflicts-20261006/`; kiểm `sha256sum -c SHA256SUMS` trên ops trước khi dùng artifact.

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

**Phân biệt đường chạy:** phần 5 bên dưới mô tả hợp đồng canonical/V3 cũ. Client Planning sau migration `20261016090000_seasonal_full_import_v1.sql` chỉ nhập full-file vào Draft bằng native draft RPCs, không có Merge/Replace hoặc Repair trong Settings. Chuyến manual **trong Draft** vắng file sẽ bị loại; Daily/Manual **trong Operations** không đổi cho tới Publish riêng. Xem `../current-implementation-status.md` để phân biệt checkout local với trạng thái đã triển khai.

- Chỉ dùng Seasonal V3. V2 commit cố ý bị chặn sau canonical cutover.
- Merge/Full Replace không được đổi Daily/Manual checksum.
- Seasonal rows trong active Daily scope được lưu deleted với reason `daily_authority`, kể cả zero-flight scope, để không resurrect lịch.

### 5.1 Plan trùng ngày lịch với Daily active (`daily-occurrence-collision`)

Từ migration `20260920170000_seasonal_import_daily_duplicate_guard.sql`, stage Seasonal V3 chặn mọi occurrence plan trùng
`(ngày lịch, hãng, số hiệu chuẩn hoá)` với một dòng **Daily đang active**: preview trả `valid=false`, batch ở trạng thái
`failed`, và commit bị từ chối (`must be validated before commit`). Đây là F07 áp cho đường import plan, không phải lỗi file.

1. Đọc diagnostic: message nêu `record_id` của dòng Daily đang chiếm ngày lịch đó; `sampleDates` là các ngày bị trùng.
2. Xác định ngày nào trong file plan đã có dữ liệu thực tế (Daily là authority) rồi **thu hẹp `effective`/`discontinue`**
   của file plan để không phủ các ngày đó, sau đó stage lại bằng request ID mới.
3. Nếu plan phải thay thế dòng Daily (ví dụ chuyến thực tế bị huỷ và plan mới là đúng), xử lý dòng Daily trước bằng flow
   repair/reset tương ứng (mục 4 hoặc overlay delete ở mục 8) rồi mới stage plan. Không sửa row canonical trực tiếp.
4. Không bỏ qua bằng cách commit batch `failed`; không xoá diagnostic phía client. Guard dùng chung bảng diagnostic nên
   không có đường commit tắt.

### 5.2 Plan trùng ngày lịch với dòng Add Flight active (`manual-occurrence-collision`)

Từ migration `20260920230000_seasonal_import_daily_guard_kind_classification.sql`, dòng **Add Flight** (`source_kind='manual'`)
đang active cũng chặn occurrence plan trùng `(ngày lịch, hãng, số hiệu chuẩn hoá)` ở **cả** Merge và Full Replace, và được báo
đúng code `manual-occurrence-collision`; trước đó Replace báo nhầm thành `daily-occurrence-collision` với message nêu "active
Daily leg" dù row bị chặn là dòng Add Flight. Preview trả `valid=false`, batch ở trạng thái `failed`, commit bị từ chối
(`must be validated before commit`), và `manualCollisionCount` là số occurrence bị chặn.

Lý do vẫn chặn: **Full Replace không reset leg của season**. Đo trên chuỗi migration khớp production, một stage + commit
Replace trên season 2 leg giữ nguyên cả 2 leg rồi chèn thêm leg của file (2 → 3 dòng). Dòng Add Flight vì vậy không tự biến
mất khi Replace; bỏ chặn sẽ để file và dòng Add Flight cùng tồn tại cho một ngày lịch.

1. Nếu file plan là đúng và dòng Add Flight là bản sao cũ: xử lý dòng Add Flight trước (Undo/overlay delete ở mục 8, hoặc flow
   repair tương ứng), rồi stage lại plan bằng request ID mới.
2. Nếu dòng Add Flight là đúng: thu hẹp `effective`/`discontinue` của file plan để không phủ ngày đó, rồi stage lại.
3. Không commit batch `failed` và không sửa row canonical trực tiếp.

## 6. Rollback release

- Trước write cutover: tắt feature flag/read path mới, giữ additive schema.
- Sau canonical commit: dùng audited reset/reversal, không hard-delete batch mới hoặc sửa preimage bằng tay.
- Projection chỉ được đánh dấu fresh sau khi refresh thành công từ canonical source.
- Drop legacy pointer/table là migration riêng sau rollback window và cần phê duyệt riêng.

## 7. Canonical helper privileges

- Các view `security_invoker` yêu cầu caller có `EXECUTE` trên `is_canonical_flight_leg_active_v1`, `canonical_flight_leg_ops_date_v1` và `canonical_flight_leg_occurrence_key_v1`.
- Giữ `PUBLIC` và `anon` bị revoke; cấp cho `authenticated`, `service_role` và `seasonal_bi_reader` nếu role BI tồn tại.
- Trên self-hosted production, chạy migration ACL bằng object owner `supabase_admin`. Sau đó probe Workspace V2 bằng role `authenticated`; không coi warning `no privileges were granted` là thành công.

## 8. Overlay delete và Undo của operator

- Mọi op workspace đi qua `apply_workspace_op_json(text,jsonb)`; từ migration `20260915100000_canonical_overlay_deletion_authority.sql`, `modification{action:'deleted'}` ghi canonical terminal (`deletion_reason='overlay_deleted'`) và `modification` khác chỉ phục hồi row khi `is_rebasable_terminal_flight_leg_v1`, nên overlay và canonical store không còn lệch nhau.
- Overlay `deleted` là nguồn của Undo: không xoá overlay bằng tay để "trả chuyến về". Dùng Undo trong app hoặc `remove_canonical_season_modification_v1`; xoá overlay qua `modificationDelete` sẽ chạy đúng semantics canonical (`manual_undo` cho overlay `added`, phục hồi row cho overlay `deleted`).
- Row bị import xoá (`daily_replacement`, `daily_authority`, `removed_from_source`), row đã supersede hoặc nằm trong replacement scope reset sẽ không được hồi sinh bởi op — muốn cho bay lại phải dùng flow repair/import tương ứng.
- Kiểm tra sức khoẻ read-only: `select count(*) from public.season_flight_records r join public.season_modifications m on m.season_id=r.season_id and m.leg_id=r.record_id and m.action='deleted' where public.is_canonical_flight_leg_active_v1(r.status,r.action);` phải trả `0`.
