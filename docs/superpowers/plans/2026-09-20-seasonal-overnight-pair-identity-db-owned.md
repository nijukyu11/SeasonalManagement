# Kế hoạch triển khai — Danh tính cặp turnaround do DB sở hữu (seasonal overnight pair identity)

- Ngày lập: 2026-09-20
- Phạm vi: seasonal import/export round-trip (`stage_seasonal_import_v3`, `commit_seasonal_import_v3`, `generate_seasonal_import_records_v2`), client export `canonicalSeasonalRows.ts`
- Chỉ đạo: metadata cặp **lưu ở DB**, KHÔNG ghi vào file Excel (file import có thể đến từ hệ thống khác, không có sheet/cột metadata)
- Trạng thái: chưa code — tài liệu này là checklist bám sát khi code

---

## 0. Chẩn đoán đã xác minh trên production (2026-09-20, read-only)

### 0.1 Số liệu gốc

| Chỉ số (seasonal, active) | Giá trị | Nguồn |
|---|---|---|
| Tổng dòng | 30.388 | `q_link_state.sql` §2-3 |
| Có link `sameday` | 20.932 dòng (≈10.466 cặp) | §3 |
| Có link `overnight` | **38 dòng = 19 cặp** (19 ARR + 19 DEP) | §3, `q_link_state2.sql` §5 |
| Không link | 9.418 (4.087 ARR + 5.331 DEP) | §3, probe#3 §C |
| Nhóm `turnaround_id` | 10.485 nhóm, **tất cả đúng 2 leg** | `q_link_state2.sql` §8 |
| Link treo / không đối xứng | 0 / 0 | §7 |
| Trùng danh tính (date, airline, flight_number) A+D | 0 | §9 |
| Anchor `sameday` ≠ date / `overnight` DEP ≠ anchor+1 | 0 / 0 | probe#3 §B, `q_link_state2.sql` §5 |
| `scheduled_date` lệch `date` / `day_of_week` lệch JS-dow | 0 / 0 | §6 |
| Dòng có link mà `linked_source_row_index` NULL | **0** (20.970/20.970 đều non-null) | probe#5 §I |
| Dòng xoá mềm `deletion_reason='seasonal_rebuild'` | **0** | `q_link_state2.sql` §13 |
| Ghi `season_source_rows` theo strategy | chỉ `replace` (delete+insert từ payload); `merge` **không** đụng | `20260817173000:1601-1670` |

**Kết luận 1 (đã hiệu chỉnh)**: link trong DB sạch về cấu trúc; gate export (`date-metadata-mismatch`, `invalid-linked-pair`) **không** kích hoạt trên production — không phải nguyên nhân. Về **nguồn gốc** link: `linked_source_row_index` non-null **không** chứng minh cùng-dòng — cả hai đường đều ghi cột này (cùng-dòng ⇒ row index của chính nó; cross-row ⇒ row index của đối tác), và app (`linkFlightRecordPairs`, `atomicSchedule.ts:910-1000`) ghi `linkedSourceRowIndex = partner.sourceRowIndex`. Vì vậy 19 cặp `overnight` hiện có **chưa** được xác định nguồn gốc bởi các probe đã chạy (chúng có thể đến từ nhánh cùng-dòng `std < sta`, từ cross-row, hoặc từ thao tác app) — cần probe **P0** (`tmp/audit/seasonal-export-defects/q_link_state7.sql`) trước khi kết luận.

### 0.2 Payload / stage

| Bằng chứng | Giá trị | Nguồn |
|---|---|---|
| `season_import_batch_rows.row_data.linkType` có giá trị | **0 / 2.432** dòng (10 batch gần nhất) | `q_link_state4.sql` §F2 |
| Key `linkedSourceRowIndex` trong raw row | **không tồn tại** | probe#5 §G |
| `season_import_batch_records_v3.linked_occurrence_key` có giá trị | **18.590 / 26.545** dòng (batch mới nhất) | `q_link_state6.sql` §K |
| Batch gần nhất | 2026-08-21, `apply_strategy=replace` | §F2 |

**Kết luận 2 (đã hiệu chỉnh so với bản nháp trước)**: stage canonical v3 **có** ghi link — producer **đang hoạt động** là nhánh **cùng-dòng** (`has_arrival and has_departure` trong `arr_dep_expansion`, `20260718090000:643-690`), với `link_type` do so sánh giờ quyết định: `std < sta` ⇒ `overnight` (và DEP `scheduled_date = source_scheduled_date + 1`), ngược lại ⇒ `sameday`. **Lưu ý:** cùng-dòng **cũng có thể** là `overnight`, nên "overnight ⇒ cross-row" là suy luận sai. Đường link **cross-row tường minh đã tồn tại** (`explicit_linked_source_row_index` → `resolved_cross_row_link_type` → `counterpart_candidates`/`reciprocal_links`), nhưng **không có producer từ file**: file không mang link, và `parseSeasonalSchedule` không suy ra. ⇒ Cặp qua đêm **2 row riêng** không bao giờ được link **bởi đường file** khi import; link cross-row quan sát được trên production phải đến từ đường khác (app `linkFlightRecordPairs` + native schedule mutation, hoặc lịch sử) — xác định bằng P0.

### 0.3 Blast radius (candidate, KHÔNG phải kết luận mất link)

| Chỉ số | Giá trị | Nguồn |
|---|---|---|
| Cạnh ứng viên overnight (cardinality tính trên **toàn bộ** ứng viên) | 10.038 | `q_link_state6.sql` §J |
| Trong đó hai đầu đều chưa link | 4.269 | §J |
| **1:1 toàn cục (cả 2 chiều = 1) VÀ hai đầu chưa link** | **1.099** | §J |
| 1:1 toàn cục (mọi trạng thái) | 2.669 | §J |
| 1:1 chỉ trong đồ thị con "chưa link" (không dùng làm số toàn cục) | 1.528 | probe#4 §D2 |
| ARR chưa link có ứng viên DEP duy nhất | 1.449 | §J |
| DEP chưa link có ứng viên ARR duy nhất | 1.853 | §J |
| ARR/DEP chưa link có >1 ứng viên (mơ hồ) | 1.398 / 1.151 | §J |
| ARR chưa link nhưng có DEP same-day đối ứng trong ngày | 1.344 | probe#3 §C |
| Theo season: `season-f77c5ea9…` / `season-19cbca13…` | 1.271 / 257 (1:1 trong đồ thị con) | probe#4 §E2 |

**Supersession lịch sử**: 252 dòng `overnight` đã xoá mềm ↔ **0** dòng active cùng danh tính (season, type, airline, flight_number, scheduled_date) ⇒ **không** có bằng chứng mất link do thay thế; `deletion_reason='seasonal_rebuild'` = 0 ⇒ đường `replace` mới (20260829) chưa từng chạy. Vì vậy "replace xoá link" hiện là **lỗi tiềm ẩn**, không phải nguyên nhân đã quan sát.

### 0.4 Probe còn thiếu (chưa chạy — phiên này không có credential)

| Probe | Câu hỏi | File |
|---|---|---|
| **P0** | 19 cặp `overnight` (38 dòng) đến từ cùng-dòng hay cross-row? (so `source_row_index` ↔ `linked_source_row_index`, prefix `turnaround_id`, `source_import_batch_id`) | `tmp/audit/seasonal-export-defects/q_link_state7.sql` §P0a-P0b |
| **P0c** | Có dòng nguồn nào sinh occurrence với **>1 partner row** hoặc >1 `link_type` không? (nếu có ⇒ `overnight_link_row_index` row-level không biểu diễn đủ — quyết định M2b) | §P0c |
| **P0d** | Có cặp ARR+DEP **cùng `source_row_index`** nhưng cả hai **unlinked** không? (đây là phơi nhiễm hồi sinh link nếu cho nhánh cùng-dòng chạy trên dòng live đã unlink) | §P0d |

---

## 1. Hợp đồng chốt trước khi code

- **HĐ-1 — DB là nguồn chân lý của danh tính cặp, áp cho MỌI producer.** Ba trạng thái của occurrence key, và đây là luật **tổng** (không có ngoại lệ theo shape file):
  1. **Live record tồn tại và đang có tuple link** ⇒ **kế thừa tuple sống** (`link_type`, `pair_anchor_date`, `linked_record_id`, `turnaround_id`, `linked_source_row_index`). Producer (cùng-dòng **hoặc** cross-row) **không** được tái suy diễn/ghi đè.
  2. **Live record tồn tại nhưng unlinked** ⇒ **VETO**: không producer nào được gắn link (kể cả nhánh cùng-dòng `has_arrival and has_departure`). Đây là cơ chế bảo vệ unlink có chủ ý (HĐ-7) — kể cả khi file có row chứa cả ARR+DEP. Ghi **warning** `live-occurrence-unlinked` (kênh M2c — **không** chặn commit) + `counts.vetoedUnlinkedLiveCount`.
  3. **Live record vắng** ⇒ producer được phép resolve, nhưng chỉ khi **cả hai đầu** cùng vắng (mục HĐ-3).
  - **Ngoại lệ tường minh của "không tự xoá link sống"**: strategy `replace` với đầu đối tác vắng trong batch ⇒ tuple của dòng unresolved bị **xoá atomically** (HĐ-3), vì bản ghi cũ bị `delete` — giữ lại sẽ tạo dangling.
- **HĐ-2 — File không mang metadata.** Không thêm cột/sheet vào Excel export. Không đổi 25 cột hiện hành của `exportCanonicalSeasonalRowsToExcel`. (Nhánh cùng-dòng là suy diễn từ **layout** file, không phải metadata — và nay cũng chịu HĐ-1.)
- **HĐ-3 — All-or-nothing cho cả hai chiều, và khác nhau theo strategy.**
  - Producer chỉ resolve khi **cả hai đầu** cùng ở trạng thái 3 (cùng vắng trong DB) — hoặc cả hai đầu cùng trạng thái 1 (kế thừa). **Hỗn hợp** (một đầu vắng, một đầu live-unlinked; hoặc một đầu vắng, một đầu live-linked với đối tác khác) ⇒ **unresolved**, không gắn link một phía.
  - Kế thừa chỉ áp khi **cả hai đầu** của cặp cùng có mặt trong batch canonical đến — vì commit chỉ resolve `linked_final_record_id` trong phạm vi batch (`20260817173000:1146-1163`) và sẽ raise `Materialized linked occurrence is missing from batch %` nếu đầu kia vắng.
  - Một đầu vắng ⇒ dòng đó **unresolved**:
    - **`merge`**: partner vẫn sống trong DB ⇒ **không đụng** cột link của bản ghi (giữ nguyên link sống), tuyệt đối không ghi NULL. Nếu link sống hiện tại đã trỏ tới đầu đối tác **không còn active** (dangling sẵn có) ⇒ chỉ ghi **warning** `dangling-existing-link` (kênh M2c), không tự sửa.
    - **`replace`**: partner bị xoá ở nhánh `delete from public.season_flight_records` (L1467-1480) ⇒ giữ link sẽ tạo **dangling**. Dòng unresolved trong replace phải **xoá tuple atomically** (cả 5 cột NULL, `linked_occurrence_key` NULL) và hash không chứa trường link — cặp coi như không còn tồn tại trong season sau full replace.
- **HĐ-4 — Suy luận cross-row chỉ cho overnight, chỉ khi cả hai đầu vắng.** Luật chặt: cùng `airline`+`aircraft`+`route`; `DEP.date = ARR.date + 1`; `DEP.schedule < ARR.schedule`; DOW lệch đúng +1; **chỉ nhận 1:1 hai chiều**; **từ chối khi mơ hồ** (để nguyên không link + **warning** `ambiguous-pair-candidate` (kênh M2c)).
  - **Hợp đồng night-stop:** cặp cross-row **cùng ngày** hoặc `DEP.schedule >= ARR.schedule` (kể cả bằng giờ) **không** được suy luận — file chủ ý không mang ngữ nghĩa same-day/overnight, nên fallback **không** được tự phát minh. Chỉ link **do DB sở hữu** (kế thừa, trạng thái 1) mới giữ được topology đó. Suy luận same-day cross-row **ngoài phạm vi** (không có nhu cầu quan sát được; same-day thường nằm cùng-dòng).
- **HĐ-5 — Ghi link theo tuple nguyên tử.** Năm cột (`link_type`, `pair_anchor_date`, `linked_record_id`, `turnaround_id`, `linked_source_row_index`) chỉ được ghi **cùng lúc** từ một tuple đã resolve; KHÔNG `coalesce` từng cột độc lập (sinh tuple lai, có thể không đối xứng). Chưa resolve ⇒ không đưa các cột này vào UPDATE.
- **HĐ-6 — Hash phản ánh đúng tuple mà dòng đến SẼ mang sau commit.** Hai phía đối xứng:
  - dòng đến **có** tuple sẽ ghi (resolved, hoặc kế thừa từ live) ⇒ hash **gồm** trường link;
  - dòng đến **không** có tuple (veto/unresolved) ⇒ hash **loại** trường link; phía DB cũng loại trường link khi bản ghi sống đang unlinked ⇒ hai hash bằng nhau ⇒ `needs_update=false` ⇒ **không** UPDATE ⇒ unlink không bị hồi sinh.
  - Hệ quả: **không** còn yêu cầu "dòng cũ unlinked phải nhận link mới". Dòng live-unlinked **không bao giờ** nhận link từ import (HĐ-1 mục 2); việc gắn link cho các cặp đang tồn tại là M8 (backfill có phê duyệt).
  - Trường hợp `merge` một-đầu-vắng: hash dùng **tuple sống** (để không sinh `needs_update` giả), nhưng UPDATE **bỏ** cột link (HĐ-5) ⇒ không churn, không wipe.
- **HĐ-7 — Unlink là hành động DB-side và có thẩm quyền.** Muốn bỏ cặp thì sửa trong app (đã xoá link trong DB) — file không có cơ chế "unlink tường minh", và **mọi** producer (kể cả nhánh cùng-dòng) bị veto bởi HĐ-1 mục 2, nên unlink **không thể** bị hồi sinh bởi re-import cùng file.
- **HĐ-8 — `replace` kế thừa trước khi xoá, và rebuild metadata link cho `season_source_rows`.** Replace là đường **duy nhất** ghi lại `season_source_rows` (delete + insert từ payload, `20260817173000:1601-1670`) ⇒ phải set lại `overnight_link_row_index`/`link_type` từ topology đã resolve **khi và chỉ khi** dòng nguồn đó nhất quán (xem M2b); nếu không, store thứ hai này mất danh tính cặp dù `season_flight_records` đã đúng.
- **HĐ-9 — Không tự ý sửa dữ liệu hiện có.** Backfill 1.099 cạnh 1:1 là mốc riêng, cần phê duyệt tường minh.
- **HĐ-10 — Thay đổi hành vi đã biết của nhánh cùng-dòng.** Trước đây re-import một row ARR+DEP sẽ gắn lại link cho cặp live đã unlink; nay bị veto. Đây là chủ ý (HĐ-7) và phải được ghi trong artifact phát hành + runbook, vì người vận hành có thể quan sát "import không còn tự link cặp cũ".

---

## 2. Mốc triển khai

### M0 — Baseline & hợp đồng kỹ thuật (base = **effective definition** trên production)

> **Cảnh báo đã xác minh:** production **không** còn là thân hàm của `20260817173000`/`20260718090000`. Ba hàm đích đã bị các migration sau **vá động** bằng `replace()` trên `pg_get_functiondef`:
> - `stage_seasonal_import_v3`: `20260724090000` (tạo) → `20260817173000` (replace-full-reset) → `20260829170000` (canonical authority: `source_kind 'imported'→'seasonal'`, `'added'→'manual'`, guard `is_canonical_flight_leg_active_v1`, `schedule_replacement_scopes`, `v_preserved_overlay_count`) → `20260906010000` (`importGuardVersion`) → `20260920170000` (diagnostic `daily-occurrence-collision` + comment).
> - `commit_seasonal_import_v3`: `20260724090000` → `20260817173000` → `20260818100000` (bounded turnaround/link temp updates) → `20260829170000` → `20260906010000`.
> - `generate_seasonal_import_records_v2`: chỉ `20260718090000` (không bị vá sau) — vẫn phải verify bằng digest.
>
> ⇒ Dựng migration mới **từ file cũ sẽ revert** các fix canonical-authority/daily-guard. Base bắt buộc là **định nghĩa đang chạy trên production**.

- [ ] Fetch base: `pg_get_functiondef` của 3 hàm (base64 qua SSH theo skill) → lưu `tmp/audit/seasonal-pair-identity/preimage/<fn>.sql` **kèm `md5`**. Đây là nguồn duy nhất để sửa và là nội dung `rollback.sql` (byte-exact).
- [ ] Chụp `md5(pg_get_functiondef(...))` preimage của: `public.stage_seasonal_import_v3(jsonb)`, `public.commit_seasonal_import_v3(uuid,integer,text)`, `public.generate_seasonal_import_records_v2(uuid)`.
- [ ] Dựng **effective definition trong PGlite** bằng cách áp **toàn bộ chuỗi migration** hiện có (mới nhất `20260920200000`) (không phải chỉ file nguồn), rồi assert `md5(pg_get_functiondef(...))` PGlite **= preimage production** cho cả 3 hàm. Lệch ⇒ dừng, dò migration còn thiếu (đây là check thay thế cho "so với file 20260817173000").
- [ ] Ghi danh sách **sentinel bắt buộc còn sống** sau khi vá (assert bằng `position(... in pg_get_functiondef(...))`, ngoài digest): `source_kind = 'seasonal'`, `'sourceKind', 'seasonal'`, `deletion_reason='seasonal_rebuild'`, `schedule_replacement_scopes`, `is_canonical_flight_leg_active_v1`, `canonical_active_flight_records_v1`, `v_preserved_overlay_count`, `importGuardVersion`, `daily-occurrence-collision`, `manual-occurrence-collision`, và anchor bounded-update của `20260818100000`.
- [ ] Lưu snapshot số liệu mục 0.1–0.3 thành file JSON trong `tmp/audit/seasonal-pair-identity/` để so sau khi áp.
- [ ] Chạy **P0** (`python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state7.sql`) và ghi kết quả vào snapshot: nguồn gốc 19 cặp `overnight` (cùng-dòng/cross-row/app), có dòng nguồn nào >1 partner row (§P0c — quyết định M2b), có cặp cùng-row đang unlinked (§P0d — phơi nhiễm hồi sinh).
- [ ] Xác nhận với người dùng: giữ nguyên HĐ-1..HĐ-10 — đặc biệt HĐ-1 mục 2 (**veto mọi producer khi live unlinked**, kể cả nhánh cùng-dòng), HĐ-3 (`replace` xoá tuple atomically), HĐ-6 (hash hai phía đối xứng) và **HĐ-10** (thay đổi hành vi quan sát được của nhánh cùng-dòng).

**Done**: preimage + digest lưu file; PGlite effective-definition khớp digest production; danh sách sentinel đã chốt; không có sai lệch preimage.

### M1 — Harness PGlite & fixture tái hiện lỗi

- [ ] Tạo `app/supabase/tests/seasonal_import_pair_identity_pglite.mjs` theo mẫu `app/supabase/tests/seasonal_import_daily_duplicate_guard_pglite.mjs` (dùng `pglite_test_support.mjs` — chạy offline, không cần `SEASONAL_TEST_DATABASE_URL`).
- [ ] Thêm script `app/package.json`: `"test:seasonal-pair-identity": "node supabase/tests/seasonal_import_pair_identity_pglite.mjs"` (đặt cạnh `test:seasonal-import-daily-duplicate-guard`).
- [ ] Tạo `app/supabase/tests/seasonal_import_pair_identity_parity.mjs` theo mẫu `seasonal_import_daily_duplicate_guard_parity.mjs` (so digest PGlite ↔ production).
- [ ] Fixture: season S26 giả lập, 1 cặp overnight cross-row (ARR VN200 2026-06-01 23:30 + DEP VN201 2026-06-02 01:05, **hai row riêng**, cùng airline/aircraft/route), 1 cặp same-day cross-row, 1 row **cùng-dòng** (ARR+DEP trong một row, cả hai shape `std < sta` và `std > sta`), 1 chuyến lẻ.
- [ ] **Case A — carry-forward (seed trước):** seed DB một cặp overnight **đã có link** (import lần 1 với intent, hoặc insert trực tiếp record có `link_type='overnight'` + `turnaround_id`), rồi import lại payload **không mang link** (merge) ⇒ link phải nguyên vẹn, `needs_update` không được ghi NULL. Trước khi vá: FAIL (link mất).
- [ ] **Case B — replace:** sau Case A, import lại cùng payload bằng `replace` ⇒ link vẫn nguyên vẹn (carry-forward chạy trước `delete`).
- [ ] **Case C — cả hai đầu vắng trong DB (tạo mới):** payload có đủ ARR + DEP của cặp cross-row mới, không mang link ⇒ suy luận 1:1 và commit ghi link cho **cả hai** đầu (đây là case insert, **không** dùng để chứng minh `needs_update`).
- [ ] **Case D — một đầu vắng trong batch (tách theo strategy):**
  - **D1 `merge`:** payload chỉ có ARR (DEP đã có trong DB, có link sống) ⇒ (a) **không** raise `Materialized linked occurrence is missing from batch`; (b) cột link của ARR **không bị ghi NULL**; (c) link sống trong DB giữ nguyên; (d) nếu link sống đó đã dangling ⇒ có **warning** `dangling-existing-link` và **không** tự sửa; (e) `needs_update` không sinh giả (hash dùng tuple sống).
  - **D2 `replace`:** cùng payload, strategy `replace` ⇒ ARR phải có **cả 5 cột link = NULL** (tuple xoá atomically), **không** còn `linked_record_id` trỏ tới bản ghi đã bị xoá, `turnaround_id` không còn nhóm 1 leg; probe hậu kiểm dangling = 0.
- [ ] **Case E — unlink có thủ tục (DB-side) KHÔNG được hồi sinh — hai shape:**
  - **E1 (cùng-dòng):** cặp live đã unlink (như thao tác app) với **row ARR+DEP cùng-dòng** trong payload ⇒ (a) **không** gắn lại link (veto HĐ-1 mục 2); (b) `needs_update=false` (hash hai phía đều loại trường link — HĐ-6); (c) có **warning** `live-occurrence-unlinked`. **Trước khi vá: FAIL** (nhánh cùng-dòng hồi sinh link).
  - **E2 (cross-row):** cùng kịch bản với payload 2 row riêng ⇒ **không** hồi sinh, **không** suy luận lại (HĐ-1 mục 2 + HĐ-4), có **warning**.
- [ ] **Case F — đổi danh tính occurrence:** payload đổi `scheduled_date`/`flight_number` của một đầu ⇒ occurrence key không khớp dòng cũ ⇒ **không** kế thừa link (không gán cặp cho chuyến khác); dòng cũ xử lý theo strategy hiện hành.
- [ ] **Case G — mơ hồ:** 2 ứng viên DEP cùng khớp 1 ARR ⇒ **không** link, có **warning** `ambiguous-pair-candidate`.
- [ ] **Case H — night-stop (hợp đồng HĐ-4):** cặp cross-row **cùng ngày** (DEP cùng `date`, giờ muộn hơn) và cặp có `DEP.schedule == ARR.schedule` ⇒ **không** suy luận, để nguyên unlinked; và **đối chứng**: nếu cặp cùng-dòng đó **đã có link sống** trong DB ⇒ kế thừa giữ nguyên (chỉ DB-owned mới giữ topology đó).
- [ ] **Case I — hash-update theo topology có intent DB rõ ràng (HĐ-5/HĐ-6):** cặp live **đã link** (intent DB), payload merge có đủ hai đầu + đổi một trường không-link (ví dụ `pax`/`schedule`) ⇒ `needs_update=true`, UPDATE chạy và ghi tuple **nguyên tử** (5 cột cùng giá trị như trước, không NULL hoá, không tuple lai).
- [ ] Ghi chú PGlite: cần `;` sau `$function$` khi nối câu lệnh; đọc file SQL bằng bytes (giữ CRLF).

**Done**: chạy `node app/supabase/tests/seasonal_import_pair_identity_pglite.mjs` → trước khi vá: Case A/B FAIL đúng chẩn đoán, **E1 FAIL (hồi sinh link)** + D1/D2 chứng minh hành vi hiện tại (guard raise hoặc dangling); C/E2/F/G/H/I là hành vi mong đích chưa đạt.

### M2 — SQL: carry-forward danh tính cặp trong stage

- [ ] Migration mới `app/supabase/migrations/20260920HHMMSS_seasonal_pair_identity_carry_forward.sql`:
  - **Nguồn thân hàm = preimage production đã fetch ở M0** (không copy từ `20260817173000`/`20260724090000`); phát hành dạng `create or replace function` **toàn thân** để diff review được và không phụ thuộc `replace()` mảnh — mọi bản vá upstream (canonical authority, `importGuardVersion`, daily/manual guard, bounded temp updates) phải còn nguyên trong thân hàm mới.
  - Guard idempotence: `position('pair_identity_resolve_v1' in pg_get_functiondef(...)) > 0` → `return`; kèm `begin; set local lock_timeout='15s'; set local statement_timeout='300s';` + `notify pgrst, 'reload schema';`.
  - **Vị trí chèn pass:** sau các khối diagnostic hiện có (`manual-occurrence-collision`, `daily-occurrence-collision`) và **chỉ khi** `v_batch.status = 'validated'`; trước khi set status/`seasonal_import_v3_response`. Pass không đổi `occurrence_key` của dòng nào ⇒ không ảnh hưởng các guard đó (assert: `counts` diagnostics trước/sau pass không đổi trên fixture).
  - Giữ nguyên `comment on function public.stage_seasonal_import_v3(jsonb)` (bổ sung câu về pair identity) + khối `revoke/grant execute` như migration trước.
  - Sau khi áp: assert lại **toàn bộ sentinel M0** trên `pg_get_functiondef` (ngoài digest) — nếu mất bất kỳ sentinel nào ⇒ `raise exception` trong migration (fail-fast, không để revert âm thầm).
- [ ] Trong `stage_seasonal_import_v3`, sau bước ghi `season_import_batch_records_v3`, thêm **một pass "resolve pair identity" duy nhất** (`pair_identity_resolve_v1`) chạy trên **toàn batch** — đây là chỗ thực thi HĐ-1 cho **mọi** producer, kể cả tuple mà `generate_seasonal_import_records_v2` đã tự suy ra ở nhánh cùng-dòng:
  - **Bước 0 — dựng bảng trạng thái live:** occurrence key của `public.season_flight_records` (`status='active'`, `action is distinct from 'deleted'`, `season_id = v_target_season_id`) join `normalize_seasonal_flight_number_v2`, công thức key **giống hệt** `existing_source` (`20260817173000:1019-1060`); kèm cờ `has_live` và `live_tuple` (5 cột link) + `live_partner_key`.
  - **Bước 1 — VETO (HĐ-1 mục 2):** dòng đến có `has_live = true` **và** `live_tuple is null` (live unlinked) ⇒ **xoá sạch tuple** khỏi dòng đến (`record_data.linkType`/`pairAnchorDate`/`turnaroundId`/`linkedSourceRowIndex` = null, `linked_occurrence_key` = null) **kể cả khi** `generate` đã gán link từ nhánh cùng-dòng; ghi **warning** `live-occurrence-unlinked` vào kênh M2c (KHÔNG vào `diagnostic_items` — sẽ chặn commit) + `counts.vetoedUnlinkedLiveCount`.
  - **Bước 2 — KẾ THỪA (HĐ-1 mục 1):** dòng đến có `has_live = true` **và** `live_tuple is not null` ⇒ ghi tuple **từ live** (`link_type`, `pair_anchor_date`, `turnaround_id`, `linked_source_row_index`; `linked_occurrence_key` = `live_partner_key`), ghi đè tuple mà `generate` có thể đã suy ra — live tuple là chân lý (HĐ-1 mục 1); `counts.carryForwardCount`.
    - Nếu **đầu đối tác vắng** trong batch ⇒ giữ trạng thái **unresolved**: `merge` ⇒ không ghi cột link (M4) nhưng hash dùng tuple live (HĐ-6); `replace` ⇒ tuple rỗng (HĐ-3).
  - **Bước 3 — HỖN HỢP ⇒ unresolved:** một đầu vắng DB, đầu kia có live (bất kể linked/unlinked) ⇒ **không** gắn link, ghi `counts.unresolvedPairCount` (HĐ-3).
  - **Bước 4 — TẠO MỚI:** cả hai đầu **cùng vắng** ⇒ giữ tuple do `generate` resolve (cùng-dòng) và/hoặc để M3 suy luận cross-row 1:1; ghi tuple **nguyên tử** (HĐ-5), KHÔNG `coalesce` từng cột với giá trị cũ.
  - **Bước 5 — tính lại `record_hash`** cho **mọi** dòng bị thay đổi ở bước 1-4, theo công thức đối xứng của HĐ-6 (gồm trường link khi dòng đến có tuple sẽ mang; loại khi không) — vì hash phải khớp `existing_source` để không sinh `needs_update` giả và không hồi sinh unlink.
- [ ] Áp dụng cho **cả** `merge` và `replace`: với `replace`, pass này chạy ở stage khi dòng cũ vẫn còn sống (trước `delete from public.season_flight_records` tại `commit_seasonal_import_v3` L1467-1480).
- [ ] Thêm bộ đếm vào response/preview: `counts.carryForwardCount`, `counts.inferredPairCount`, `counts.derivedSameRowCount`, `counts.vetoedUnlinkedLiveCount`, `counts.unresolvedPairCount`, `counts.ambiguousPairCount` để verify sau khi áp và để client hiển thị (M5).

**Verify**: M1 Case A/B/C/D1/D2/E1/E2/F/G/H/I chuyển sang PASS; probe production sau này thấy `link_type='overnight'` không giảm sau import; P0d (nếu có cặp cùng-row unlinked) đếm khớp `vetoedUnlinkedLiveCount`.

### M2b — SQL: rebuild metadata link cho `season_source_rows` (store thứ hai)

- [ ] Trong `commit_seasonal_import_v3`, nhánh `replace` (L1601-1670): sau khi insert `season_source_rows`, set `overnight_link_row_index` = row index **đối tác** và `link_type` từ topology đã resolve (map theo `record_data.sourceRowIndex` của cặp đã resolve).
- [ ] **Luật nhất quán row-level (bắt buộc):** một dòng nguồn có thể sinh **nhiều** occurrence (nhiều ngày), mà `overnight_link_row_index`/`link_type` chỉ là **một** giá trị row-level. Chỉ ghi khi **tất cả** occurrence đã resolve của dòng nguồn đó trỏ tới **cùng một** partner row index **và** cùng một `link_type`; nếu **hỗn hợp** (nhiều partner row, hoặc nhiều `link_type`, hoặc chỉ một phần ngày được link) ⇒ để **NULL** cả hai cột + **warning** `mixed-source-row-link` (kênh M2c, kèm `sourceRowIndexes`) — tuyệt đối không ghi một giá trị đại diện cho nhiều cặp khác nhau, và **không** raise (đây là dữ liệu hợp lệ, chỉ không biểu diễn được ở mức row).
- [ ] Guard hậu kiểm trong commit (nhánh replace): không tồn tại `season_source_rows` có `link_type is not null` mà `overnight_link_row_index is null` (và ngược lại) ⇒ `raise exception` nếu vi phạm.
- [ ] Nhánh `merge` **không** ghi source rows (`20260817173000` chỉ có nhánh replace) ⇒ xác nhận bằng probe: `merge` không làm mất `overnight_link_row_index` của source rows hiện có.
- [ ] Kiểm tra `source_provenance_mode` (`full` cho replace, `fragmented` cho merge, L1767-1770) không bị ảnh hưởng.
- [ ] Verify trên production: snapshot workspace/export (`get_season_workspace_snapshot`, `get_seasonal_export_snapshot_v2`) trả source rows có `overnight_link_row_index`/`link_type` khớp topology; UI hiển thị cặp (kiểm bằng browser trên trang Seasonal Schedule); đếm số dòng bị `mixed-source-row-link` khớp probe P0c.

**Done**: source-row store và record store cùng phản ánh một topology; không còn store nào mất danh tính cặp sau `replace`.

### M2c — Kênh warning **không** chặn commit (bắt buộc trước khi thêm diagnostic mới)

> **Ràng buộc đã xác minh:** stage đặt `v_valid := v_batch.status = 'validated' and v_generated_count > 0 and v_diagnostic_count = 0 and v_manual_collision_count = 0` (`20260817173000:702-705`) ⇒ mọi row trong `pg_temp.seasonal_import_v3_diagnostic_items` đều **chặn** commit (status 'failed'), và commit còn raise nếu `jsonb_array_length(v_batch.diagnostics) <> 0` (`…:884-890`). Vì vậy các mã `live-occurrence-unlinked`, `ambiguous-pair-candidate`, `dangling-existing-link`, `mixed-source-row-link` **không được** đi vào kênh diagnostic hiện hành — nếu không, Case D1/E1/E2/G/H (kỳ vọng import tiếp tục) sẽ bị chặn.

- [ ] Stage: tạo thêm `pg_temp.seasonal_import_v3_warning_items` (cùng shape `code/message/source_row_indexes/occurrence_key/affected_date/airline/flight_number`), gom/rank theo **cùng** CTE như diagnostics → `v_warnings jsonb`, `v_warning_count`, `v_warnings_truncated`. **KHÔNG** sửa công thức `v_valid` (warning không chặn).
- [ ] Persist: giữ `season_import_batches.diagnostics` = **chỉ blocking**; warning nằm trong `preview->'warnings'` (`preview` đã được persist ở `…:747-759`) ⇒ gate commit `jsonb_array_length(v_batch.diagnostics) <> 0` giữ nguyên ngữ nghĩa.
- [ ] Response stage: thêm `warnings`, `warningCount`, `warningsTruncated`; `counts` thêm `vetoedUnlinkedLiveCount`, `ambiguousPairCount`, `unresolvedPairCount` (đã có từ M2) + `mixedSourceRowLinkCount`. Lưu ý `counts` **nằm trong `preview_hash`** (`…:715-745`) ⇒ hash phải deterministic và đổi khi counter đổi (test M6).
- [ ] Commit: trả `warnings`/`warningCount` từ `v_batch.preview->'warnings'`; warning phát sinh ở commit (M2b `mixed-source-row-link`) đưa vào response `warnings` + `counts.mixedSourceRowLinkCount` — **không** đưa vào `batches.diagnostics`, **không** raise (khác với guard toàn vẹn topology ở M4: guard đó là bất biến cấu trúc ⇒ vẫn raise).
- [ ] Client types: `SeasonalImportV3StageResult`/commit result thêm `warnings`/`warningCount`; preview dialog hiển thị khối "Cảnh báo" tách khỏi "Lỗi chặn commit" (M5).
- [ ] Test (M6): (a) fixture **warning-only** (veto + ambiguous) ⇒ `valid = true`, commit **thành công**; (b) fixture **blocking** (`daily-occurrence-collision` / duplicate occurrence) ⇒ `valid = false` và commit raise; (c) `batches.diagnostics` rỗng với fixture warning-only (điều kiện để qua gate commit); (d) `previewHash` deterministic: cùng payload ⇒ cùng hash; đổi counter ⇒ đổi hash.

**Done**: không có mã cảnh báo nào chặn commit; ba kênh tách bạch (blocking diagnostics / warnings / counts) và có test cho cả hai loại.

### M3 — SQL: suy luận 1:1 cross-row cho cặp mới (fallback, chỉ overnight)

- [ ] Thêm hàm `public.seasonal_import_infer_pair_links_v3(p_batch_id uuid) returns integer` (hoặc bước 4 trong pass M2), chạy **sau** bước veto/kế thừa — và **chỉ** cho dòng mà **cả hai đầu** vắng bản ghi sống (HĐ-3 bước 3/4).
- [ ] **Vị từ bắt buộc (chống hồi sinh link):** dòng đến chỉ được suy luận khi **cả hai đầu** đều **không** có bản ghi sống trong `season_flight_records` (occurrence key không khớp dòng live nào của season, xét trước mọi `delete` của `replace`). Chỉ dựa vào `linked_occurrence_key is null` là sai: cặp đã tồn tại nhưng bị người dùng **cố ý bỏ link** (Case E1/E2) sẽ bị suy luận lại ngay.
- [ ] **Phạm vi:** chỉ `link_type = 'overnight'` với `dep.date = arr.date + 1` **và** `dep.schedule::time < arr.schedule::time`; cùng `airline`, `aircraft`, `route`; DOW khớp (+1). Cặp cross-row **cùng ngày** hoặc `dep.schedule >= arr.schedule` ⇒ **không** suy luận (hợp đồng night-stop, HĐ-4) — file không mang ngữ nghĩa same-day, fallback không được phát minh (Case H).
- [ ] **Chỉ nhận 1:1 hai chiều:** đếm ứng viên hai chiều trên **toàn bộ** ứng viên trong batch; mỗi phía phải đúng 1 ứng viên; khác ⇒ không đổi + **warning** `ambiguous-pair-candidate` (kênh M2c).
- [ ] Ghi **tuple nguyên tử** cho **cả hai** đầu (mỗi đầu là một dòng riêng trong `season_import_batch_records_v3`): `linked_occurrence_key` trỏ sang đầu kia, `linkType='overnight'`, `pairAnchorDate = arr.date`, `turnaroundId` theo công thức `TRN_…` sẵn có trong `reciprocal_links` (L785-830 của `20260718090000`) — cùng công thức cho cả hai đầu để đảm bảo đối xứng; cập nhật `record_hash` cả hai dòng (HĐ-6).
- [ ] **KHÔNG** cài luật suy luận ở TypeScript: một nguồn luật duy nhất ở SQL. Preview tiêu thụ **diagnostic/bộ đếm của server** (stage chạy trước commit: `SeasonalSchedulePage.tsx:1811`, `settings/page.tsx:1291`); test đối chiếu là test SQL (M6) + assert trên response stage, không phải một implementation TS song song (hai implementation sẽ lệch nhau và có thể gắn intent trước khi DB resolve).
- [ ] Hệ quả ghi rõ trong tài liệu: 1.099 cặp chưa link **đang tồn tại** trong DB sẽ **không** được import tự link (vì đã có bản ghi sống ⇒ veto/unresolved) — việc này thuộc M8 (backfill có phê duyệt).

**Verify**: M1 Case C PASS (cả hai đầu vắng ⇒ nhận link, cả hai đều là insert), Case D2 PASS (replace một đầu vắng ⇒ tuple rỗng, không dangling), Case E1/E2 PASS (live unlinked ⇒ **không** hồi sinh, **không** suy luận lại), Case G PASS (không link + diagnostic), Case H PASS (cùng ngày / bằng giờ ⇒ không suy luận). Probe SQL đối chiếu: số cặp suy luận trên fixture = số kỳ vọng, hai đầu cùng `turnaround_id`.

### M4 — SQL: hash đối xứng & ghi tuple (không wipe, không tuple lai, không hồi sinh unlink)

- [ ] `existing_source` (L1019-1060): dựng `semantic_data` theo **trạng thái tuple của chính bản ghi sống** — bản ghi sống **đang có** tuple (`link_type is not null`) ⇒ gồm `linkType`/`pairAnchorDate`/`linkedOccurrenceKey`/`linkedSourceRowIndex`; bản ghi sống **unlinked** ⇒ **loại** các trường đó khỏi hash. Mục đích: dòng đến bị veto (unlinked live) phải hash **bằng** dòng sống ⇒ `needs_update=false` ⇒ unlink không bị hồi sinh (HĐ-6).
- [ ] Phía dòng đến (hash do `generate_seasonal_import_records_v2`/pass M2 tính): gồm trường link **khi và chỉ khi** dòng đến mang tuple sẽ ghi (resolved tạo mới, hoặc kế thừa từ live, hoặc kế thừa-cho-hash khi `merge` một-đầu-vắng); loại khi veto/unresolved. Hai phía đối xứng ⇒ không sinh `needs_update` giả, không churn.
- [ ] Nhánh `merge` UPDATE (L1483-1512): chia hai nhánh theo trạng thái resolve của dòng đến —
  - resolved: ghi **đồng thời** `link_type`, `pair_anchor_date`, `linked_record_id` (= `linked_final_record_id`), `turnaround_id` (= `resolved_turnaround_id`), `linked_source_row_index` từ tuple;
  - unresolved (kể cả veto): **không** đưa 5 cột này vào SET (giữ nguyên giá trị đang sống trong DB). KHÔNG `coalesce` từng cột (HĐ-5).
- [ ] Nhánh `replace`: dòng unresolved phải vào DB với **tuple rỗng** (cả 5 cột NULL) — stage chịu trách nhiệm để `record_data`/`linked_occurrence_key` sạch cho strategy này (HĐ-3), vì `replace` **không** giữ bản ghi cũ để mà kế thừa; sau `insert` (L1514-1580) thêm **guard toàn vẹn topology**: với mọi bản ghi active của season, nếu `link_type is not null` thì phải đồng thời thoả
  - `linked_record_id is not null` và trỏ tới bản ghi **active** cùng season;
  - **đối xứng**: bản ghi đối tác có `linked_record_id` trỏ ngược lại chính nó;
  - **tuple khớp**: `link_type`, `turnaround_id`, `pair_anchor_date` của hai đầu **bằng nhau**;
  - `turnaround_id` có **đúng 2 leg active** trong season;
  - vi phạm bất kỳ điều nào ⇒ `raise exception` (fail validation) thay vì commit dữ liệu treo/lệch.
- [ ] Nhánh `insert` chung (L1514-1580): giữ nguyên — dòng mới đã có tuple do stage gán (hoặc NULL nếu unresolved, đúng vì không có gì để kế thừa).
- [ ] Rà `commit_seasonal_import_v2` (`20260829170000_seasonal_canonical_authority.sql:382`) xem có cùng lỗi wipe/hồi sinh không; nếu có, vá cùng migration.

**Verify**: M1 Case A/B PASS với cả hai strategy; Case C PASS (insert, cả hai đầu nhận link); Case **D1** (merge giữ link sống, hash không sinh `needs_update` giả) và **D2** (replace tuple rỗng + guard không raise) PASS; Case **E1** (live unlinked + payload cùng-dòng ⇒ `needs_update=false`, không UPDATE, DB vẫn unlinked) và **E2** PASS; Case **I** (live linked + đổi trường không-link ⇒ `needs_update=true`, tuple ghi nguyên tử, không NULL hoá) PASS; guard toàn vẹn topology raise đúng khi fixture bị cố ý làm lệch (test phụ: sửa một đầu thành trỏ sai ⇒ commit fail).

### M5 — Client: không đổi định dạng file, chỉ đồng bộ luật & hiển thị

- [ ] Giữ nguyên 25 cột export (`canonicalSeasonalRows.ts` L461-499). **Không** thêm cột link — file chủ ý **không** mang danh tính cặp, nên không thể kiểm topology bằng cách parse lại file.
- [ ] Xác nhận `buildCandidates` (L227-276) vẫn tách cặp overnight thành 2 row (đúng định dạng file) — chỉ bổ sung comment nêu rõ danh tính cặp do DB giữ.
- [ ] `validateCanonicalSeasonalRoundTrip` (L393-420): **giữ** kiểm occurrence fidelity như hiện tại; **KHÔNG** thêm kiểm topology cặp từ file (sẽ báo lỗi giả cho export hợp lệ). Client chỉ được: (a) kiểm occurrence; (b) hiển thị diagnostic/bộ đếm của server (`carryForwardCount`/`inferredPairCount`/`derivedSameRowCount`/`vetoedUnlinkedLiveCount`/`unresolvedPairCount`/`ambiguousPairCount` + code `live-occurrence-unlinked`/`ambiguous-pair-candidate`/`mixed-source-row-link`).
- [ ] **KHÔNG** cài luật suy luận/kế thừa cặp ở TS (không mở rộng `seasonalPairing.ts` thành implementation thứ hai của luật SQL) — rủi ro hai nguồn luật lệch nhau và gắn intent trước khi DB resolve (M3).
- [ ] `buildSourceRowRebuildPlan`/`applySourceRowRebuildPlan` (L565-622) + `rowFromCandidate` (L299-324): truyền `linkType` + `overnightLinkRowIndex` của cặp đã resolve vào `ParsedRow` khi rebuild, và **đưa trường link vào `rowSignature`** (L508-528) — nếu không, rebuild source rows sẽ âm thầm xoá metadata link mà vẫn báo "unchanged".
  - **Đã xác minh trong mã hiện hành (2026-09-20):** `ParsedRow` **có** hai trường này (`app/src/lib/types.ts:57` `overnightLinkRowIndex?: number`, `:60` `linkType?: 'overnight'|'sameday'`), nhưng `rowFromCandidate` (L299-324) **không** set chúng và `rowSignature` (L508-528) **không** gồm chúng ⇒ hiện tượng "rebuild xoá link mà vẫn báo unchanged" là **thật**, không phải giả định.
- [ ] Preview import: hiển thị **hai khối tách biệt** — "Lỗi chặn commit" (diagnostics hiện hành) và "Cảnh báo" (`warnings`/`warningCount` từ M2c: `live-occurrence-unlinked`, `ambiguous-pair-candidate`, `mixed-source-row-link`) — để người vận hành thấy trước khi commit mà không tưởng là lỗi.

**Verify**: chạy các suite seasonal hiện hành: `npm run test:seasonal-import-v3-sql`, `npm run test:seasonal-import-sql`, `npm run test:seasonal-canonical-authority`, `npm run test:rules`, `npm run test:atomic-flight`, `npm run test:seasonal-new-flight-creation` — tất cả xanh; export file thật vẫn đúng 25 cột, mở lại parse được; rebuild source rows giữ nguyên `overnightLinkRowIndex`/`linkType` (kiểm bằng snapshot sau rebuild).

### M6 — Test hồi quy & parity

- [ ] `app/supabase/tests/seasonal_import_pair_identity_pglite.mjs`: **11 case M1 (A, B, C, D1, D2, E1, E2, F, G, H, I)** + assert guard toàn vẹn topology của replace (đối xứng + tuple khớp + 2 leg) + assert "import lần 3 payload y hệt ⇒ `needs_update=false`, link nguyên vẹn". Chạy: `npm run test:seasonal-pair-identity`.
- [ ] Test kênh M2c trong cùng file PGlite: fixture **warning-only** ⇒ `valid=true` + commit thành công + `batches.diagnostics` rỗng; fixture **blocking** ⇒ `valid=false` + commit raise; `previewHash` deterministic (cùng payload ⇒ cùng hash, đổi counter ⇒ đổi hash).
- [ ] Parity digest: `app/supabase/tests/seasonal_import_pair_identity_parity.mjs` so `md5(pg_get_functiondef(...))` giữa PGlite sau migration và production sau khi áp (mẫu: `seasonal_import_daily_duplicate_guard_parity.mjs`).
- [ ] Probe round-trip client hiện có (đã kiểm: cần DB dùng-một-lần): `node --experimental-strip-types --import ./tmp/audit/seasonal-export-defects/register-ts-extension-resolver.mjs ./tmp/audit/seasonal-export-defects/seasonal-roundtrip-link-probe.mjs` — cập nhật probe phản ánh luồng DB-owned (bỏ case "legacy helper").
- [ ] Script DB-backed chính thức `npm run test:seasonal-roundtrip` (`scripts/seasonal-import-export-roundtrip.mjs`) cần `SEASONAL_TEST_DATABASE_URL` + `SEASONAL_TEST_TEMP_DB=1` với DB dùng-một-lần tên `seasonal_task11_*`; chạy khi có môi trường, ghi lại kết quả thực tế (hiện chưa cấu hình trong phiên này).
- [ ] Xoá `groupFlightLegs` + `detectOvernightPairs` (dead code) **chỉ khi** đã wire xong và test không còn tham chiếu (dọn dẹp cuối, không làm sớm).

**Verify**: toàn bộ suite seasonal xanh; probe round-trip in `PROBE OK` với case overnight.

### M7 — Áp production (theo skill `seasonalmanagement-prod-migration`)

- [ ] Rehearse PGlite: áp **toàn chuỗi migration** hiện có (mới nhất `20260920200000`) → assert `md5(pg_get_functiondef)` **= preimage production** (M0) → áp migration mới → assert digest post + **toàn bộ sentinel M0** còn sống (đặc biệt canonical-authority, `importGuardVersion`, `daily-occurrence-collision`), và `commit_seasonal_import_v2` **không đổi** (trừ khi M4 kết luận phải vá).
- [ ] Probe hành vi trong transaction `begin; … rollback;` với `set local "request.jwt.claim.sub" = '<operator uuid>'; set local role authenticated;` — thứ tự: probe commit-gate TRƯỚC, rollback rehearsal SAU (tránh false negative).
- [ ] Áp `python tmp/audit/ssh_sql.py < migration.sql`; verify digest post khớp rehearsal **và** sentinel còn sống trên production (chạy lại đúng script assert của M0 ngay sau khi áp).
- [ ] Probe hậu kiểm trên production (read-only): `link_type` coverage (số cặp `overnight` không giảm so baseline), nhóm `turnaround_id` = 2, không phát sinh dangling/non-reciprocal, `scheduled_date`/`dow` vẫn 0 lệch, và `season_source_rows.overnight_link_row_index`/`link_type` khớp topology sau một lần import thử trong transaction rollback.
- [ ] Upload `migration.sql`, `rollback.sql`, `receipt.txt`, `SHA256SUMS` lên `/home/ops/seasonal-pair-identity-<yyyymmdd>/`; xác nhận `sha256sum -c`.
- [ ] `rollback.sql` khôi phục **byte-exact** preimage **đã fetch từ production ở M0** (không phải bản trong `20260817173000`) cho cả 3 hàm; sau rollback, digest phải bằng pre-digest.

**Done**: digest post = rehearsal; sentinel còn sống; probe hậu kiểm sạch; receipt đã upload.

### M8 — Backfill (tuỳ chọn, cần phê duyệt riêng)

- [ ] Dry-run SQL đếm lại: 1:1 toàn cục + hai đầu chưa link (**1.099** tại 2026-09-20) và theo season.
- [ ] Trình danh sách cặp dự kiến (record_id, occurrence key) để người dùng duyệt.
- [ ] Chỉ chạy khi có phê duyệt: `begin; … commit;` với snapshot đúng các dòng sẽ đổi (phục vụ rollback), set `link_type='overnight'`, `pair_anchor_date`, `linked_record_id`, `turnaround_id`, bump `seasons.data_version`/`last_synced_at` như `20260723090000_normalize_season_modification_schedule.sql`.
- [ ] Hậu kiểm: `turnaround_id` nhóm đúng 2 leg, không tạo cặp trùng, export gate vẫn `valid`.

**Done**: số dòng đổi khớp dry-run; rollback file phục hồi được pre-state.

### M9 — Tài liệu & phát hành

- [ ] `docs/superpowers/artifacts/2026-09-20-seasonal-pair-identity-db-owned.md` (tiếng Việt): chẩn đoán, hợp đồng, số liệu trước/sau, bằng chứng probe.
- [ ] Runbook: thao tác unlink/relink cặp qua app (vì file không mang metadata).
- [ ] Commit tách: `fix(seasonal): …` rồi `docs(ops): record …`.
- [ ] Ghi memory: quyết định "DB sở hữu danh tính cặp, file không mang metadata".

---

## 3. Điểm vá chính xác (anchors)

### SQL

| Vị trí | Việc |
|---|---|
| `20260817173000_make_seasonal_replace_full_reset.sql:4` (`stage_seasonal_import_v3`) | **chỉ là mốc lịch sử** — thân hàm thật = preimage production (M0); pass resolve pair identity + hash đối xứng chèn trong thân đó |
| `…:765` (`commit_seasonal_import_v3`) | `replace`: pass chạy ở stage trước delete; `merge` UPDATE ghi tuple **nguyên tử** khi resolved, không đụng cột link khi unresolved/veto (M4) |
| `…:1019-1060` (`existing_source`/hash) | hash gồm trường link **chỉ khi bản ghi sống có tuple**; unlinked ⇒ loại khỏi hash (chống hồi sinh unlink, HĐ-6) |
| `…:1146-1163` (`linked_final_record_id` + guard) | lý do HĐ-3: guard raise khi đầu đối tác vắng trong batch |
| `…:1467-1480` (replace delete) | thứ tự: pass resolve pair identity phải xong trước |
| `…:1483-1512` (merge UPDATE) | hai nhánh resolved/unresolved (kể cả veto); KHÔNG `coalesce` từng cột |
| `…:1514-1580` (insert + guard) | guard **toàn vẹn topology**: đối xứng, tuple khớp, 2 leg active (M4) |
| `…:1601-1670` (replace source-rows insert) | rebuild `overnight_link_row_index`/`link_type` **chỉ khi nhất quán row-level**, ngược lại NULL + `mixed-source-row-link` (M2b) |
| `…:1767-1770` (`source_provenance_mode`) | `full` (replace) / `fragmented` (merge) — không đổi |
| `…:702-705` (`v_valid` gate) | lý do tồn tại kênh warning M2c: `v_diagnostic_count = 0` ⇒ mọi row diagnostic đều chặn commit |
| `…:884-890` (commit gate `jsonb_array_length(v_batch.diagnostics) <> 0`) | warning phải nằm ở `preview->'warnings'`, **không** ở `batches.diagnostics` |
| `20260818100000_bound_seasonal_commit_temp_updates.sql` | sentinel bounded-update phải còn sống (M0) |
| `20260829170000_seasonal_canonical_authority.sql` (`do $patch_stage$`, `do $patch_commit$`) | sentinel canonical authority (`source_kind='seasonal'`, `deletion_reason='seasonal_rebuild'`, `schedule_replacement_scopes`, `v_preserved_overlay_count`) phải còn sống |
| `20260906010000_import_terminal_coverage_and_identity.sql` | sentinel `importGuardVersion` phải còn sống |
| `20260920170000_seasonal_import_daily_duplicate_guard.sql` | sentinel `daily-occurrence-collision` + vị trí chèn pass (sau khối diagnostic) |
| `20260718090000_seasonal_source_import_v2.sql:639-715` (`arr_dep_expansion`) | nguồn của nhánh cùng-dòng (kể cả `overnight` khi `std < sta`) — nay chịu veto HĐ-1 mục 2 |
| `…:743-770` (`counterpart_candidates`), `…:785-830` (`reciprocal_links` + công thức `TRN_`) | tái dùng công thức `TRN_` cho inference cross-row (M3) |
| `20260829170000_seasonal_canonical_authority.sql:382` (`commit_seasonal_import_v2`) | rà cùng lỗi wipe/hồi sinh |

### Client

| Vị trí | Việc |
|---|---|
| `app/src/lib/canonicalSeasonalRows.ts:227-276` (`buildCandidates`) | giữ tách 2 row cho overnight; không đổi định dạng |
| `…:179-196` (`pairLinkType`, `canRepresentAsSingleImportRow`) | dùng cho **hiển thị/nhãn** trong UI, KHÔNG dùng làm luật kế thừa/suy luận (M3: một nguồn luật ở SQL) |
| `…:299-324` (`rowFromCandidate`) + `…:508-528` (`rowSignature`) | mang `linkType`/`overnightLinkRowIndex` vào `ParsedRow` và **vào chữ ký** — chống rebuild source rows xoá metadata link mà vẫn báo "unchanged" (M5) |
| `…:565-622` (`buildSourceRowRebuildPlan`/`applySourceRowRebuildPlan`) | giữ `overnightLinkRowIndex`/`linkType` khi rebuild; verify bằng snapshot sau rebuild |
| `…:393-420` (`validateCanonicalSeasonalRoundTrip`) | **giữ** kiểm occurrence; **KHÔNG** thêm kiểm topology cặp từ file (M5) |
| `…:461-499` (`exportCanonicalSeasonalRowsToExcel`) | KHÔNG đổi (25 cột) |
| `app/src/app/(desktop)/SeasonalSchedulePage.tsx:1811` + `settings/page.tsx:1291` | preview = response stage; hiển thị diagnostic/bộ đếm server (M5) |
| `app/src/lib/seasonalPairing.ts` | KHÔNG mở rộng thành implementation luật thứ hai (M3/M5) |
| `app/src/lib/parser.ts` | `parseSeasonalSchedule` — không set link (đúng thiết kế) |
| `app/src/lib/seasonalImportRpcContract.ts:270-316` | canonicalizer gửi `overnightLinkRowIndex`/`linkType` (null mặc định) |

---

## 4. Rủi ro & rollback

| Rủi ro | Giảm thiểu |
|---|---|
| **Migration dựng từ file cũ ⇒ revert canonical-authority / daily-guard / importGuardVersion** | Base = preimage production (M0); phát hành toàn thân hàm; assert sentinel + digest PGlite = production trước khi áp (M7) |
| Suy luận sai cặp (2 chuyến trùng giờ/route) | Chỉ nhận 1:1 hai chiều; mơ hồ ⇒ bỏ qua + diagnostic; test Case G |
| **Hồi sinh unlink có chủ ý** (kể cả nhánh cùng-dòng) | VETO HĐ-1 mục 2 cho **mọi** producer + hash đối xứng HĐ-6 (`needs_update=false`); test Case E1 (cùng-dòng) + E2 (cross-row) |
| Suy luận phát minh ngữ nghĩa same-day/overnight | Hợp đồng night-stop HĐ-4: chỉ `dep.date = arr.date + 1` **và** `dep.schedule < arr.schedule`; bằng giờ/cùng ngày ⇒ không suy luận; test Case H |
| Gắn link một phía khi batch thiếu đầu kia (hỗn hợp live/vắng) | HĐ-3: chỉ resolve khi cả hai đầu cùng vắng hoặc cùng có live; hỗn hợp ⇒ unresolved + `counts.unresolvedPairCount`; test D1/D2 |
| `replace` một đầu vắng ⇒ dangling | HĐ-3: replace xoá tuple atomically cho dòng unresolved + guard **toàn vẹn topology** (đối xứng, tuple khớp, 2 leg) sau insert; test D2 |
| `replace` xoá sạch trước khi kế thừa | Thứ tự bắt buộc: pass resolve pair identity ở stage (dòng cũ còn sống) trước `delete` trong commit |
| `overnight_link_row_index` row-level đại diện sai nhiều cặp | M2b: chỉ ghi khi **một** partner row + **một** `link_type` cho **mọi** occurrence của dòng nguồn; hỗn hợp ⇒ NULL + `mixed-source-row-link`; probe P0c |
| **Warning lọt vào kênh diagnostic ⇒ chặn commit oan** | M2c: bảng warning riêng + `preview->'warnings'`; `v_valid`/gate commit không đổi; test warning-only (commit thành công) + blocking (commit raise) |
| Hash sai ⇒ churn `needs_update` hoặc không UPDATE khi cần | HĐ-6 đối xứng hai phía; test Case I (intent DB + đổi trường không-link ⇒ `needs_update=true`, tuple nguyên tử) |
| Thay đổi hành vi nhánh cùng-dòng gây bất ngờ vận hành | HĐ-10: ghi rõ trong artifact + runbook; `counts.vetoedUnlinkedLiveCount` hiển thị ở preview |
| Hai nguồn luật (SQL + TS) lệch nhau | M3: chỉ một implementation ở SQL; TS chỉ hiển thị diagnostic server |
| Backfill ghi sai | Mốc riêng (M8), dry-run + duyệt + snapshot dòng đổi |

Rollback: `rollback.sql` khôi phục byte-exact 3 hàm; dữ liệu (nếu M8 chạy) phục hồi từ snapshot pre-state.

---

## 5. Lệnh tái lập bằng chứng

```
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state.sql    # coverage + cột link
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state2.sql   # toàn vẹn + batch shape
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state3.sql   # theo season (key-presence)
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state4.sql   # 1:1 hai chiều + null-aware
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state5.sql   # shape raw row + cột v3
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state6.sql   # cardinality toàn cục + supersession
python tmp/audit/ssh_sql.py < tmp/audit/seasonal-export-defects/q_link_state7.sql   # P0: nguồn gốc 19 cặp overnight + nhất quán row-level + phơi nhiễm hồi sinh
```
Fetch preimage (base cho migration + rollback) — chạy một lần, lưu base64 vào `tmp/audit/seasonal-pair-identity/preimage/`:
```sql
\pset tuples_only on
select encode(convert_to(pg_get_functiondef('public.stage_seasonal_import_v3(jsonb)'::regprocedure),'UTF8'),'base64');
select encode(convert_to(pg_get_functiondef('public.commit_seasonal_import_v3(uuid,integer,text)'::regprocedure),'UTF8'),'base64');
select encode(convert_to(pg_get_functiondef('public.generate_seasonal_import_records_v2(uuid)'::regprocedure),'UTF8'),'base64');
```
(`SEASONAL_SSH_PASSWORD` truyền qua env, không ghi vào file.)
