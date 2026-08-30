# Kế hoạch sửa Daily Schedule Import hai định dạng và replace atomic

**Trạng thái:** Đã triển khai và kiểm chứng local trên branch `codex/daily-import-v1`; chưa deploy migration, chưa bật commit production và chưa import dữ liệu thật.

> Các checklist bên dưới là kế hoạch gốc. Kết quả thực tế, bằng chứng test và phần còn lại trước production được ghi tại `docs/superpowers/artifacts/2026-08-28-daily-import-v1-verification.md`.

**Mục tiêu:** Daily Schedule import phải đọc được cả workbook OperationalTurns cũ `.xls` và workbook LB mới `.xlsx`, dù tiêu đề và kiểu biểu diễn dữ liệu khác nhau, miễn là 43 trường nghiệp vụ giữ nguyên thứ tự. Hệ thống phải xác định đúng Ops Date, preview chính xác phạm vi bị ảnh hưởng, thay thế toàn bộ lịch bay trong phạm vi đó bằng một commit atomic và không làm mất Daily snapshot, draft hoặc operational overlay khi Seasonal được merge/rebuild.

**Kiến trúc đề xuất:** Tách luồng thành ba lớp: `workbook adapter -> canonical Daily snapshot -> staged server commit`. Parser xác định vùng bảng và ánh xạ theo vị trí tương đối 0-42; tiêu đề chỉ dùng để nhận diện/cảnh báo, không quyết định field mapping. Server lưu Daily snapshot theo từng Ops Date, stage preview từ canonical legs, khóa tất cả season theo thứ tự ổn định và commit toàn file trong một PostgreSQL transaction. Seasonal baseline và Daily snapshot là hai nguồn riêng; workspace/read model chọn Daily snapshot cho ngày đang active và baseline cho ngày còn lại.

**Tech stack:** Next.js 16, React 19, TypeScript, SheetJS `xlsx`, Node `node:test`, Supabase PostgreSQL 17/PLpgSQL, Zustand, Tauri 2.

---

## 1. Baseline và bằng chứng đầu vào

### Workbook LB mới

- File kiểm tra: `LB_20260823_20260827.xlsx`.
- Vùng dữ liệu SheetJS: `B2:AR360`; 43 cột logic, 358 dòng dữ liệu.
- Nếu diễn giải đúng: 596 legs, một season `S26`, Ops Date `2026-08-23..2026-08-27`.
- Ngày là Excel date/formatted string kiểu `m/d/yyyy`; parser hiện tại dùng `raw:false` rồi hiểu dấu `/` thành `dd/mm/yyyy`, nên có thể suy sai ngày/mùa.
- Resource có token như `Stand18`, `Stand20A`, `B4`, `G5`, `G`, `C30` và `M1`; schema hiện tại lưu gate/stand/carousel bằng integer trong khi stand nghiệp vụ phải giữ được hậu tố chữ.

### Workbook OperationalTurns cũ

- File kiểm tra: `OperationalTurns (16).xls`.
- Vùng dữ liệu: `A1:AQ4986`; 43 cột logic, 4.985 dòng dữ liệu.
- Parser hiện tại đọc được: 8.072 legs, một season `S26`, 61 Ops Date `2026-08-01..2026-09-30`, không skip và không lỗi duplicate khi build trên baseline rỗng.
- Ngày giờ là text ISO `yyyy-mm-dd hh:mm:ss`.

### Kết luận cấu trúc

- Hai file có cùng thứ tự 43 trường nghiệp vụ nhưng khác:
  - vị trí bắt đầu vật lý (`B2` và `A1`);
  - tên tiêu đề;
  - kiểu cell ngày giờ;
  - cách biểu diễn resource;
  - mức độ đầy đủ của các trường operational.
- Không được dùng extension, tên file, chữ cột Excel tuyệt đối hoặc một bộ header duy nhất làm contract nhập liệu.

### Baseline code

- Parser/smart overwrite hiện tại: `app/src/lib/dailyScheduleImport.ts`.
- Handler hiện tại: `app/src/app/daily/page.tsx`.
- Test hiện tại nằm chủ yếu trong `app/scripts/rule-regression-tests.cjs`; test mới cần được tách thành test tập trung, không chỉ mở rộng monolith.
- Checkout hiện tại `bf3fec6` đang sau local `origin/main` (`0db5ba0`) 23 commit. Trước khi implement phải cập nhật baseline/rebase trên main đã xác minh, không viết migration từ checkout cũ.

---

## 2. Các lựa chọn kiến trúc

### Phương án A — Chỉ vá parser client

- Thêm alias header, sửa date và ép mọi resource về số.
- Ưu điểm: nhanh, ít file thay đổi.
- Nhược điểm: vẫn commit ngay không preview; không chống stale/concurrent; không atomic toàn file nhiều season; vẫn trộn Daily với baseline và Seasonal rebuild.
- **Không chọn.** Chỉ giải quyết khả năng đọc file, không giải quyết lỗi replace đã audit.

### Phương án B — Parser chuẩn hóa + staged RPC nhưng tiếp tục sửa trực tiếp baseline

- Có preview/version/transaction nhưng Daily vẫn ghi `season_flight_records` và `season_modifications` như hiện tại.
- Ưu điểm: phạm vi schema vừa phải.
- Nhược điểm: provenance Daily/baseline vẫn lẫn; Full Replace phải đoán record nào cần giữ; một modification row có thể chứa cả Daily, Gate và Check-in fields.
- **Không chọn.** Rủi ro tái lập lịch mùa vẫn cao.

### Phương án C — Canonical Daily snapshot riêng + staged atomic commit

- Daily snapshot là nguồn có provenance riêng theo Ops Date.
- Baseline Seasonal không bị Daily soft-delete trực tiếp.
- Effective workspace chọn Daily snapshot cho ngày active và Seasonal baseline cho ngày không active.
- Seasonal rebuild không xóa Daily snapshot; muốn xóa phải dùng hành động repair riêng có preview.
- **Chọn phương án C.** Đây là phương án duy nhất đáp ứng đồng thời dual-format, atomic replace và seasonal compatibility.

---

## 3. Chính sách nghiệp vụ cần khóa trong implementation

1. **Ánh xạ theo vị trí tương đối:** xác định top-left của bảng rồi dùng index 0-42. Header dùng để chấm điểm profile và phát hiện lệch cột, không dùng để đổi field mapping.
2. **Hai format được hỗ trợ ngang nhau:** `.xls` và `.xlsx` cùng đi qua một canonical contract; extension chỉ phục vụ thông báo.
3. **Không partial parse:** một row/leg có dữ liệu dở dang, ngày không hợp lệ, duplicate hoặc resource chưa map làm preview invalid; không được bỏ row rồi tiếp tục delete.
4. **Một side trống hoàn toàn là hợp lệ:** ARR hoặc DEP có thể không tồn tại. Nếu flight/date chỉ có một phần thì báo lỗi có row/cell.
5. **Ops Date:** wall-clock tại `Asia/Ho_Chi_Minh`, ngưỡng 05:00; không dùng timezone máy để chuyển ngày.
6. **Range:** theo `min/max Ops Date` của từng season. Nếu giữa min/max có ngày không có leg, preview phải báo `coverage-gap`; commit chỉ được mở khi operator xác nhận explicit range/days. Không suy zero-flight day từ việc thiếu row.
7. **Identity:** strict occurrence key gồm season + Ops Date + side + airline + flight + route + scheduled time; loose key chỉ dùng để giữ stable record ID khi cùng season/Ops Date/side/airline/flight và match duy nhất. Loose collision làm preview invalid.
8. **Blank semantics:**
   - flight identity, scheduled date/time và route là trường bắt buộc cho leg tồn tại;
   - optional resource blank nghĩa là “file không cung cấp”, mặc định giữ operational overlay hiện có;
   - muốn xóa một resource phải có explicit clear marker/policy được cấu hình và hiển thị trong preview;
   - record mới nhận `null` cho optional blank.
9. **Resource token và kiểu dữ liệu:**
   - stand là canonical uppercase text: `Stand20A -> "20A"`, `Stand18 -> "18"`, numeric `18 -> "18"`; mọi Flight/Modification/AddedLeg/Stand-Gate Mapping phải dùng cùng `StandValue` dạng string;
   - gate vẫn là positive integer: `G1 -> 1`, `G01 -> 1`; bare `G` được coi là dữ liệu trống — không ghi đè Gate của record hiện có và trở thành `null` trên record mới;
   - counter vẫn là token string: `C30 -> "30"`, còn `M1`, `M2`... giữ nguyên uppercase; danh sách hỗn hợp được canonicalize bằng dấu phẩy;
   - carousel vẫn là positive integer: `B4 -> 4`;
   - lưu raw token trong staging và bind phiên bản/hash của normalization policy vào preview/commit.
10. **Stable allocations:** record match duy nhất giữ stable effective record ID và giữ Check-in/Gate allocation. Record bị omit khỏi Daily snapshot không xuất hiện trong effective schedule nhưng baseline/preimage và audit vẫn còn.
11. **File-level atomicity:** một file qua nhiều season phải commit tất cả hoặc rollback tất cả.
12. **Seasonal interaction:** Merge/Full Replace cập nhật baseline, sau đó effective resolver vẫn áp dụng các Daily active days. Full Replace mặc định không xóa Daily snapshots hoặc operational overlays của Daily legs.
13. **Explicit destructive reset:** nếu cần xóa Daily snapshots trong Seasonal repair, phải có preview count riêng, permission `season.repair` và typed confirmation `RESET DAILY`.
14. **Draft:** cùng client phải chặn Daily stage/commit khi season đích có Seasonal draft. Client khác nhận realtime invalidation; draft cũ không được save nếu base version đã đổi.

---

## 4. Contract cột theo vị trí

Index dưới đây tính từ cột đầu tiên của vùng bảng, không phải chữ cột vật lý:

| Index | Canonical field | Bắt buộc |
|---:|---|---|
| 1 | `AIRCRAFT_SERIES` | Không |
| 3 | `ARR-AIRLINE_FLIGHT_SUFFIX` | Có nếu ARR tồn tại |
| 6 | `ARR-Scheduled` | Có nếu ARR tồn tại |
| 7 | `ARR-FlightType` | Không |
| 8 | `ARR-ORIG_DEST_AIRPORT_CODE` | Có nếu ARR tồn tại |
| 9 | `ARR-FlightCategory` | Không |
| 10 | `ARR-STATUS_CODE` | Không |
| 12 | `ARR-MCT` | Không |
| 15 | `ARR-BagFirst` | Không |
| 16 | `ARR-BagLast` | Không |
| 17 | `ARR-PAX_TOTAL` | Không |
| 18 | `ARRReclaimBelt` | Không |
| 20 | `ARRStand` | Không |
| 21 | `ARR-CODESHARES` | Không |
| 23 | `DEP-AIRLINE_FLIGHT_SUFFIX` | Có nếu DEP tồn tại |
| 26 | `DEP-Scheduled` | Có nếu DEP tồn tại |
| 27 | `DEP-FlightType` | Không |
| 28 | `DEP-ORIG_DEST_AIRPORT_CODE` | Có nếu DEP tồn tại |
| 29 | `DEP-FlightCategory` | Không |
| 30 | `DEP-STATUS_CODE` | Không |
| 32 | `DEP-MCT` | Không |
| 36 | `DEP-PAX_TOTAL` | Không |
| 37 | `DEPGate` | Không |
| 38 | `CheckInDesk` | Không |
| 40 | `DEPStand` | Không |
| 41 | `DEP-CODESHARES` | Không |

Các index còn lại được giữ trong raw staging metadata để chẩn đoán/provenance nhưng chưa tham gia canonical schedule nếu chưa có contract nghiệp vụ.

---

## 5. Target flow

```text
operator chọn .xls/.xlsx
  -> đọc workbook + date1904 + raw cell metadata
  -> tìm vùng bảng/header row/top-left
  -> position-based canonicalization 0..42
  -> normalize date/resource bằng policy có version
  -> validate toàn bộ rows/legs/duplicates/seasons/coverage
  -> tính raw file SHA-256 + canonical payload SHA-256
  -> stage_daily_schedule_import_v1(...)
  -> server khóa/read snapshot và lưu batch + canonical legs
  -> server trả preview theo season/ngày/count/diagnostic/conflict
  -> operator xem affected dates và typed confirmation
  -> commit_daily_schedule_import_v1(batchId, expectedVersions, previewHash)
  -> lock tất cả seasons theo thứ tự ổn định
  -> recheck version/checksum/preview
  -> update active-day pointers + audit + dataVersion + events
  -> COMMIT một transaction cho toàn file
  -> initiating client revalidate đúng một lần
```

Unknown network outcome:

```text
  -> get_daily_schedule_import_v1_status(requestId)
  -> validated: hiển thị lại đúng preview, không auto-commit
  -> committed: dùng receipt để reconcile
  -> failed/cancelled/expired: không áp dụng client-side arrays
```

---

## 6. Public TypeScript contract dự kiến

```ts
export interface DailyWorkbookCellSource {
  sheetName: string;
  address: string;
  rawValue: unknown;
  formattedValue: string | null;
}

export interface CanonicalDailyImportLeg {
  sourceRowNumber: number;
  side: 'ARR' | 'DEP';
  seasonCode: string;
  operationalDate: string;
  scheduledDate: string;
  scheduledTime: string;
  airline: string;
  flightNumber: string;
  route: string;
  aircraft: string | null;
  flightType: string | null;
  category: string | null;
  requestStatusCode: string | null;
  resources: {
    pax?: number | null;
    stand?: string | null;
    gate?: number | null;
    carousel?: number | null;
    counter?: string | null;
    mct?: string | null;
    bagFirst?: string | null;
    bagLast?: string | null;
  };
  rawResourceTokens: Record<string, string | null>;
  occurrenceKey: string;
  looseOccurrenceKey: string;
}

export interface DailyImportDiagnostic {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  sheetName: string;
  rowNumber: number | null;
  cellAddress: string | null;
  seasonCode: string | null;
  operationalDate: string | null;
}

export interface DailyImportPreviewCounts {
  sourceRowCount: number;
  legCount: number;
  matchedCount: number;
  insertedCount: number;
  hiddenBaselineCount: number;
  unchangedCount: number;
  preservedAllocationCount: number;
  resourceUpdateCount: number;
  explicitResourceClearCount: number;
  coverageGapCount: number;
  invalidResourceTokenCount: number;
  duplicateCount: number;
}
```

`requestId` phải hash ổn định từ `contractVersion`, raw file checksum, canonical payload checksum, resource-normalization-policy hash, target seasons/ranges và expected data versions.

---

## 7. Database design dự kiến

Tạo additive migration mới sau migration mới nhất của main:

### `daily_schedule_import_batches`

- `batch_id`, `request_id`, `contract_version`, `status`.
- `file_name`, `file_extension`, `workbook_profile`.
- `raw_checksum`, `canonical_checksum`, `resource_policy_hash`.
- `expected_versions jsonb`, `preview jsonb`, `preview_hash`.
- `diagnostics`, `created_by`, timestamps, expiry/cancel/commit metadata.

### `daily_schedule_import_batch_legs`

- Canonical leg payload và occurrence keys.
- `source_row_number`, `sheet_name`, source cell addresses.
- Raw resource tokens và normalized values.
- Unique `(batch_id, occurrence_key)`; duplicate không được last-write-wins.

### `daily_schedule_import_seasons`

- Một row cho mỗi target season trong batch.
- Range start/end, explicit affected dates, expected dataVersion, preview counts.

### `daily_schedule_active_days`

- Primary key `(season_id, operational_date)`.
- Trỏ tới batch active mới nhất cho ngày đó.
- Cho phép import range chồng lấn thay thế theo từng ngày, không xóa lịch sử batch cũ.
- Một ngày active có thể hợp lệ với zero legs chỉ khi operator đã explicit-confirm ngày đó.

### Effective read boundary

- Workspace-window RPC và reporting effective view phải chọn:
  - canonical legs của active Daily batch nếu Ops Date có `daily_schedule_active_days`;
  - Seasonal baseline nếu ngày không có Daily snapshot active.
- Sau khi chọn schedule base, áp dụng operational allocations/modifications theo stable record ID và field-precedence policy.
- Không cho route/report đọc raw `season_flight_records` nếu cần effective schedule.

### Shared resource types

- `stand` là text canonical ở mọi relational table/payload/read model; giá trị hợp lệ gồm stand số (`"18"`) và stand có một hậu tố chữ (`"20A"`).
- `gate` và `carousel` tiếp tục là positive integer.
- `counter` tiếp tục là canonical token string để hỗ trợ đồng thời counter số và nhóm có prefix `M`.
- Migration phải cập nhật cả bảng settings `operational_stand_gate_mappings`, native cache/catch-up và mọi SQL JSON cast; không được chỉ đổi TypeScript type.

### Server functions

- `stage_daily_schedule_import_v1(jsonb)`.
- `commit_daily_schedule_import_v1(uuid, jsonb, text)`.
- `get_daily_schedule_import_v1_status(uuid)`.
- `cancel_daily_schedule_import_v1(uuid)`.
- Helper materializer/resolver dùng chung cho workspace, reports và Seasonal preview.

Commit phải dùng `pg_advisory_xact_lock` cho các season theo thứ tự ID, `FOR UPDATE` batch row, recheck mọi dataVersion và raise `40001` khi stale. Mọi thay đổi active days, audit, change events và dataVersion nằm trong cùng transaction.

---

## 8. Kế hoạch implementation theo task

### Task 1 — Tạo fixture và contract regression cho hai workbook

**Files:**

- Create: `app/src/lib/dailyScheduleWorkbookContract.test.ts`
- Create: `app/scripts/fixtures/daily-schedule/README.md`
- Create: các fixture tối giản, không chứa toàn bộ workbook người dùng.

**Steps:**

- [ ] Tạo fixture legacy `.xls` và compact `.xlsx` với cùng 43 logical columns nhưng khác top-left/header/date/resource representation.
- [ ] Không commit hai workbook thật; lưu SHA-256 và expected local-shadow counts trong verification artifact.
- [ ] Viết RED tests cho `A1`, `B2`, header row trong 10 dòng đầu và unknown-compatible headers.
- [ ] Assert đổi thứ tự hai anchor cột làm preview invalid, không tự map theo header.
- [ ] Assert file có sheet rác đầu tiên nhưng sheet hợp lệ thứ hai được nhận diện duy nhất; nhiều sheet hợp lệ phải yêu cầu operator chọn, không tự lấy sheet đầu.

### Task 2 — Viết workbook adapter theo raw cell và vị trí

**Files:**

- Create: `app/src/lib/dailyScheduleWorkbook.ts`
- Create: `app/src/lib/dailyScheduleWorkbook.test.ts`
- Modify: `app/src/lib/dailyScheduleImport.ts`

**Steps:**

- [ ] Thay `sheet_to_json(...raw:false)` bằng adapter giữ raw/formatted value, cell address, workbook `date1904` và logical column index.
- [ ] Detect data rectangle/header row/top-left; không giả định `A1` hoặc `B2`.
- [ ] Xác định profile `legacy-operationalturns`, `compact-lb`, hoặc `position-compatible-unknown` để hiển thị, không dùng profile để đổi mapping.
- [ ] Header score phải kiểm tra anchor tại đúng vị trí; alias mới chỉ làm tăng độ tin cậy.
- [ ] Trả structured diagnostics thay vì throw string đầu tiên.

### Task 3 — Chuẩn hóa ngày/Ops Date không phụ thuộc locale

**Files:**

- Create: `app/src/lib/dailyImportDateTime.ts`
- Create: `app/src/lib/dailyImportDateTime.test.ts`
- Modify: `app/src/lib/iataSeason.ts` nếu cần contract wall-clock rõ ràng.

**Steps:**

- [ ] Excel numeric date dùng workbook date system, không parse formatted `m/d/yyyy`.
- [ ] Text ISO được hỗ trợ như file legacy.
- [ ] Text slash chỉ parse khi date order rõ; chuỗi mơ hồ phải blocking diagnostic.
- [ ] Validate ngày/tháng/năm bằng round-trip; reject `2026-23-08`, 29/02 sai, giờ/phút ngoài range.
- [ ] Test `date1904`, timezone máy khác nhau, trước/sau 05:00, qua nửa đêm và IATA season boundary.

### Task 4 — Chuẩn hóa resource và migrate stand sang text

**Files:**

- Create: `app/src/lib/dailyImportResourcePolicy.ts`
- Create: `app/src/lib/dailyImportResourcePolicy.test.ts`
- Create: `app/supabase/migrations/20260828083000_allow_alphanumeric_stand_values.sql` (đổi sang timestamp kế tiếp nếu main đã dùng timestamp này trước lúc implement).
- Modify: `app/src/lib/types.ts`
- Modify: `app/src/lib/dailySchedule.ts`
- Modify: `app/src/lib/dailyScheduleImport.ts`
- Modify: `app/src/lib/gateAllocation.ts`
- Modify: `app/src/lib/settingsRules.ts`
- Modify: `app/src/lib/supabaseRelationalMappers.ts`
- Modify: `app/src/lib/localSeasonSqlStore.ts`
- Modify: `app/src/app/settings/components/GatesTab.tsx`
- Modify: `app/src-tauri/src/native_catchup.rs`
- Modify: `app/supabase/schema.sql` và các PGlite/native fixtures liên quan.

**Steps:**

- [ ] Định nghĩa `type StandValue = string | null`; `FlightLeg.stand`, `FlightModification.stand` dùng string canonical, không dùng union `number | string` sau persistence boundary.
- [ ] Normalize stand bằng trim + uppercase + bỏ prefix `STAND`: `Stand20A -> "20A"`, `Stand18 -> "18"`, numeric `18 -> "18"`; reject token ngoài grammar đã khóa thay vì cắt mất suffix.
- [ ] Migrate PostgreSQL `stand` từ integer sang text tại `season_flight_records`, `season_modifications`, `season_modification_added_legs` và `operational_stand_gate_mappings`; backfill bằng `stand::text`, giữ nguyên null và thêm constraint/index phù hợp cho canonical stand text.
- [ ] Migrate TypeScript mappers, JSON casts, effective/reporting RPCs và Seasonal import/export để stand không còn bị cast `::integer` hoặc parse bằng `Number(...)`.
- [ ] Migrate native/SQLite schema, catch-up structs và fixtures để `stand` round-trip dưới dạng text; dữ liệu numeric cũ phải đọc thành string canonical.
- [ ] `StandGateMapping.stand` chuyển sang string; Settings dùng text input, validation canonical text và `resolveGateForStand()` so sánh string. Gate trong mapping vẫn là positive integer.
- [ ] Normalize gate: `G1 -> 1`, `G01 -> 1`; bare `G` trả trạng thái `missing` giống cell trống, không phải explicit clear và không phải lỗi.
- [ ] Normalize counter từng token: `C30 -> "30"`, `C01 -> "1"`, `M1 -> "M1"`, `M30 -> "M30"`; mixed input như `C30 C31 M1` thành `"30,31,M1"`.
- [ ] Normalize carousel: `B4 -> 4`; gate/carousel vẫn giữ database/TypeScript integer.
- [ ] Lưu raw resource token và resource-normalization-policy hash trong batch.
- [ ] Blank optional field không tạo changed field trên existing record; explicit clear marker mới tạo `null` update.
- [ ] Test policy/hash thay đổi sau preview làm commit stale/invalid.
- [ ] Test export/import round-trip giữ chính xác `20A`, Gate `1`, counters `30,M1` và không đổi các stand numeric cũ ngoài việc canonicalize thành text.

### Task 5 — Canonical validation và preview model phía client

**Files:**

- Create: `app/src/lib/dailyImportV1Contract.ts`
- Create: `app/src/lib/dailyImportV1Contract.test.ts`
- Create: `app/src/lib/dailyImportPreview.ts`
- Create: `app/src/lib/dailyImportPreview.test.ts`

**Steps:**

- [ ] Validate partial side, missing identity, invalid route/date, strict/loose duplicates và multi-season split.
- [ ] Tính range/affected dates sau khi toàn bộ leg hợp lệ; không tính từ subset parse thành công.
- [ ] Coverage gap là blocking cho đến khi có explicit date confirmation.
- [ ] Preview contract kiểm tra count equations, hash, season versions và unknown fields.
- [ ] Mọi diagnostic chứa sheet/row/cell để operator sửa đúng nguồn.

### Task 6 — Thêm durable stage schema và server preview

**Files:**

- Create: `app/supabase/migrations/20260828090000_daily_schedule_import_v1.sql` (đổi sang timestamp kế tiếp nếu main đã dùng timestamp này trước lúc implement).
- Modify: `app/supabase/schema.sql`
- Create: `app/supabase/tests/daily_schedule_import_v1.sql`
- Create: `app/supabase/tests/daily_schedule_import_v1_pglite.mjs`
- Modify: `app/src/lib/remoteStore.ts`
- Modify: `app/src/lib/supabaseStore.ts`

**Steps:**

- [ ] Tạo bốn bảng staging/active-day và RLS/permissions cần thiết.
- [ ] Stage idempotent theo requestId; cùng ID khác payload phải reject.
- [ ] Server tự tính preview từ persisted canonical legs và canonical DB snapshot; không tin count do client gửi.
- [ ] Preview trả count theo season và từng Ops Date, sample inserted/hidden identities, allocation conflicts và invalid-resource diagnostics.
- [ ] Batch có expiry/cancel/status recovery; stage không thay đổi season hoặc tạo season rỗng.

### Task 7 — Implement commit atomic toàn file và rollback evidence

**Files:**

- Cùng migration/SQL test Task 6.
- Create: `app/src/lib/dailyImportRpcContract.source.test.ts`.

**Steps:**

- [ ] Lock batch và tất cả seasons theo thứ tự ổn định.
- [ ] Recheck expected dataVersion, previewHash, checksums, resource-policy hash và permission `schedule.write`.
- [ ] Tạo season mới chỉ bên trong commit transaction nếu preview đã dự kiến.
- [ ] Update active-day pointers, dataVersion, audit và events trong một transaction.
- [ ] Fault injection sau từng phase phải rollback về byte/logical-equivalent preimage.
- [ ] Hai commit cùng range: commit thứ hai nhận `40001` và phải stage lại.
- [ ] Multi-season failure ở season cuối rollback cả season đầu.

### Task 8 — Effective resolver và tương thích Seasonal rebuild

**Files:**

- Modify workspace-window RPC migration/schema.
- Modify effective reporting views/functions.
- Modify Seasonal V3 stage/commit bằng additive migration mới.
- Create: `app/supabase/tests/daily_seasonal_interaction.sql`.

**Steps:**

- [ ] Daily active day che baseline đúng ngày nhưng không delete baseline row/source row.
- [ ] Seasonal Merge cập nhật baseline; Daily active snapshot vẫn là effective result.
- [ ] Seasonal Full Replace mặc định preserve Daily active days và operational overlays của stable Daily legs.
- [ ] Thêm destructive `resetDailySnapshots` riêng; default false, preview/count/permission/typed confirmation bắt buộc.
- [ ] Stable match giữ record ID/allocations; ambiguous match block.
- [ ] Test Daily -> Merge, Daily -> Full Replace, Full Replace -> Daily, overlapping Daily ranges, deactivate Daily day để reveal baseline.

### Task 9 — Daily preview UI và draft/file-action guard

**Files:**

- Create: `app/src/app/components/DailyImportPreviewDialog.tsx`
- Create: `app/src/app/components/DailyImportPreviewDialog.source.test.ts`
- Modify: `app/src/app/daily/page.tsx`
- Modify/reuse: `app/src/lib/seasonalFileActionRuntimeState.ts`

**Steps:**

- [ ] Upload chỉ parse/stage; không commit tự động.
- [ ] Dialog hiển thị profile, file hash, season, min/max, từng affected date, before/after/insert/hidden/resource changes và diagnostics.
- [ ] Replace confirmation phải nhập exact range hoặc season+range, không dùng alert tổng quát.
- [ ] Block stage/commit khi cùng-client Seasonal draft tồn tại; revalidate token trước commit.
- [ ] Không còn thông báo “Use Save”; commit server thành công mới báo hoàn tất.
- [ ] Accessibility: dialog semantics, focus, keyboard, error summary và bảng dense trên màn hình nhỏ.

### Task 10 — Realtime, reconciliation và audit

**Files:**

- Modify: `app/src/app/components/SeasonSyncProvider.tsx`
- Modify: `app/src/lib/seasonWorkspaceStore.ts`
- Modify: audit read/write contracts.

**Steps:**

- [ ] Commit trả `dataVersion`, `serverHighWater`, batchId và per-season receipt.
- [ ] Initiating client revalidate server đúng một lần; không apply precomputed arrays trước RPC.
- [ ] Client khác mark stale và revalidate; không chỉ đọc lại snapshot cũ.
- [ ] Audit cùng transaction chứa checksum, profile, ranges, counts, sample identities, resource-policy hash và operator.
- [ ] Unknown network result dùng status receipt, không retry commit với request ID khác.

### Task 11 — Regression, shadow và rollback rehearsal

**Files:**

- Create: `app/scripts/daily-import-v1-shadow.mjs`
- Create: `app/scripts/daily-import-v1-load-test.mjs`
- Create: `docs/superpowers/artifacts/2026-08-28-daily-import-v1-verification.md`
- Modify: `app/package.json` và `app/scripts/rule-regression-tests.cjs`.

**Steps:**

- [ ] Chạy focused unit/source/SQL/PGlite tests.
- [ ] Chạy `npm run test:rules`, `npx tsc --noEmit --pretty false`, production build.
- [ ] Local shadow với hai file thật, chỉ stage/preview:
  - LB: 358 rows, 596 legs, `S26`, Ops Date `2026-08-23..2026-08-27`.
  - OperationalTurns: 4.985 rows, 8.072 legs, `S26`, Ops Date `2026-08-01..2026-09-30`.
- [ ] Test DB clone/transaction rollback với injected failure; pre/post baseline, overlays và active days phải khớp.
- [ ] Hai-client realtime test và concurrent stale test.
- [ ] Lưu exact hashes/counts/logs trong verification artifact, không commit workbook người dùng.

### Task 12 — Rollout có feature flag

**Steps:**

- [ ] Thêm `DAILY_IMPORT_V1_STAGE_ENABLED` và `DAILY_IMPORT_V1_COMMIT_ENABLED`; bật stage trước, commit sau.
- [ ] Deploy additive schema/RPC; giữ legacy UI commit disabled khi V1 đã bật để không có hai writer semantics.
- [ ] Rehearse trên clone/rollback, sau đó một canary range nhỏ được operator phê duyệt.
- [ ] Kiểm chứng preview receipt, before/after counts, effective Daily/Gate/Check-in/Seasonal views và realtime hai máy.
- [ ] Rollback ứng dụng bằng tắt commit flag; không drop batch/audit/active-day tables trong đợt rollback đầu.

---

## 9. Test matrix bắt buộc

| Nhóm | Cases |
|---|---|
| Layout | `A1`, `B2`, header row 1-10, blank leading columns, unknown aliases đúng vị trí, swapped anchors |
| File | BIFF `.xls`, OOXML `.xlsx`, uppercase extension, corrupt workbook, nhiều sheet |
| Date | raw serial 1900/1904, ISO text, DMY/MDY mơ hồ, leap day, trước 05:00, qua nửa đêm, season boundary |
| Row | ARR-only, DEP-only, partial side, blank row, invalid flight/route, outlier date |
| Resource | numeric stand -> text, `Stand18 -> "18"`, `Stand20A -> "20A"`, `G1 -> 1`, bare `G` -> missing/blank, `B4 -> 4`, `C30 -> "30"`, `M1 -> "M1"`, mixed counters, blank preserve, explicit clear |
| Identity | exact duplicate, loose collision, schedule/route change, same flight khác Ops Date |
| Range | một ngày, nhiều ngày, gap, zero-day explicit, overlapping imports, multi-season |
| Atomic | failure after active-day replace, audit failure, event failure, season creation failure, last-season failure |
| Concurrent | two tabs, two users, stale preview, resource policy changed, Seasonal commit between stage/commit |
| Seasonal | merge/rebuild/full replace, active Daily day, deleted baseline, manual added flight, allocation/draft |
| Realtime | initiating client, remote client, unknown commit response, idempotent status recovery |

---

## 10. Acceptance/Done means

- Cả hai file thật tạo đúng canonical counts/ranges nêu ở baseline hoặc có diagnostic có cell address giải thích chính xác vì sao không thể commit.
- Header khác nhau không ảnh hưởng field mapping khi logical positions 0-42 giữ nguyên.
- Không còn dùng `raw:false` formatted date làm nguồn sự thật cho Excel date cell.
- Không row lỗi nào bị skip rồi gây delete dữ liệu cũ.
- Preview hiển thị đầy đủ affected dates và before/after/insert/hidden/resource counts trước xác nhận.
- Delete/insert/active-day/audit/event của toàn file nằm trong một transaction; fault injection chứng minh rollback nguyên trạng.
- Commit stale/concurrent bị từ chối và yêu cầu preview mới.
- Seasonal Merge/Full Replace không làm mất Daily active snapshot theo mặc định; Daily import không mutate/delete baseline source.
- Gate/Check-in allocations của stable identities được giữ; blank resource trong file không âm thầm xóa allocation.
- Stand `20A` round-trip qua parser, PostgreSQL, native cache, workspace RPC, UI edit, export và re-import mà không bị đổi thành `20` hoặc lỗi cast.
- Gate `G1` được lưu thành integer `1`; counter `C30` được lưu thành token `30`, còn `M1` giữ nguyên `M1`.
- Bare `G` không tạo Gate update trên existing record và cho kết quả `gate=null` trên record mới.
- Realtime hai client converges về cùng `dataVersion/serverHighWater`.
- Không có production import trước khi shadow, clone rollback và canary được phê duyệt riêng.

---

## 11. Quyết định đã khóa

Đã khóa theo xác nhận nghiệp vụ:

1. Stand dùng canonical text; `Stand20A -> "20A"`, `Stand18 -> "18"` và toàn bộ stand persistence/settings phải hỗ trợ alphanumeric stand.
2. Gate bỏ prefix `G` và lưu số: `G1 -> 1`; bare `G` được coi như cell trống, không phải lệnh xóa.
3. Counter bỏ prefix `C` và giữ prefix `M`: `C30 -> "30"`, `M1 -> "M1"`.
4. Blank operational resource giữ giá trị/overlay hiện có; chỉ explicit clear mới xóa.
5. Seasonal Full Replace mặc định giữ Daily active snapshots; xóa Daily phải là destructive action riêng.

Không còn quyết định resource nào đang mở đối với hai workbook mẫu. Token ngoài các grammar đã khóa vẫn phải tạo structured diagnostic thay vì bị cắt hoặc ép kiểu im lặng.
