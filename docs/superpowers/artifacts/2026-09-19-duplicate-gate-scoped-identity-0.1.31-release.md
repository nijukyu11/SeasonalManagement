# Scoped duplicate flight-day gate và release desktop 0.1.31

Ngày: 2026-09-19. Sự cố: tạo chuyến bay mới trong Seasonal Schedule (`New Flight`) bị chặn bởi popup
`Add Flight Failed — Duplicate flight number NX985 on 2026-07-16. Each flight number may appear only once within a calendar day.`
dù chuyến đang tạo là JX704 và không xung đột gì với NX.

## 1. Nguyên nhân gốc

`app/src/app/(desktop)/SeasonalSchedulePage.tsx`, nhánh `onSubmitSeasonal`, gọi:

```ts
assertNoDuplicateFlightNumbers([...flightRecords, ...candidateRecords]);
```

`assertNoDuplicateFlightNumbers` (`app/src/lib/atomicSchedule.ts:800`) quét khoá `date|airline|flightNumber` trên **toàn bộ** mảng
được truyền vào và ném lỗi ở **vi phạm đầu tiên gặp trong thứ tự mảng**. Vì `flightRecords` là cả mùa, gate này thực chất
kiểm tra "cả mùa có trùng số hiệu ngày nào không", chứ không kiểm tra "chuyến vừa thêm có trùng không".

Dữ liệu S26 vẫn còn 2 cặp trùng số hiệu/ngày được ghi nhận là có trước policy F07
(`docs/superpowers/artifacts/2026-09-06-import-export-production-rollout.md`, mục "Dữ liệu lịch sử cần quyết định riêng"):

- `NX985` ngày `2026-07-16`: ARR 03:00 + DEP 23:35, route MFM.
- `ZE593A` ngày `2026-07-27`: ARR 00:40 + ARR 23:25, route ICN.

Bốn row đều `status='active'`, `action=null`. Khi quét mùa, gate dừng ở cặp `NX985/2026-07-16` và ném lỗi trước khi
chạm tới chuyến vừa thêm ⇒ mọi thao tác thêm chuyến trên S26 đều bị chặn kèm thông báo sai đối tượng.

### Tái hiện (script tạm, đã xoá sau khi dùng)

Fixture: 4 row legacy `NX985`/`ZE593A` + 1 chuyến JX704 mới, chạy đúng biểu thức của call site.

```
A whole-season gate (current add-flight site): blocked -> Duplicate flight number NX985 on 2026-07-16. Each flight number may appear only once within a calendar day.
B scoped gate (candidate fix): PASS (no throw)
C scoped gate, genuine NX985 collision: blocked -> Duplicate flight number NX985 on 2026-07-16. ...
D scoped gate, overlay-deleted identity re-add: PASS (no throw)
```

Dòng A khớp nguyên văn thông báo trong ảnh sự cố.

## 2. Sửa

| Vị trí | Trước | Sau |
| --- | --- | --- |
| `SeasonalSchedulePage.tsx` (New Flight) | `assertNoDuplicateFlightNumbers([...flightRecords, ...candidateRecords])` | `assertNoDuplicateFlightNumbersForEffectiveRecords(flightRecords, modifications, candidateRecords)` |
| `app/src/lib/dailySchedule.ts` (`validateDailyCellEdit`, sửa số hiệu) | `findDuplicateFlightNumberViolations(nextRecords)` trên cả window rồi lấy `violations[0]` | lọc vi phạm theo đúng identity của record đang sửa (`date` + `airline` + số hiệu đã chuẩn hoá) |
| `app/scripts/rule-regression-tests.cjs` | contract chỉ phủ Detailed/Daily | contract phủ thêm Seasonal (dương + âm) và 2 case mới cho Daily cell edit |

Hành vi giữ nguyên theo policy F07 (`2026-09-06-seasonal-daily-import-export-hardening.md`): chặn cùng airline + số hiệu
trong cùng ngày lịch; chuyến đã bị overlay `deleted` không tính; chuyến draft thêm rồi xoá trong cùng draft không chặn
tạo lại. Chỉ thay đổi: vi phạm **có sẵn từ trước, không liên quan tới thao tác** không còn chặn thao tác.

Ba luồng add còn lại đã đúng từ trước: `detailed/page.tsx:743`, `daily/page.tsx:1085` (đều dùng gate scoped).

## 3. Kiểm chứng

- `node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts` — 3/3 pass, gồm test mới
  "pre-policy duplicate flight-days in a season do not block adding an unrelated flight" (legacy NX985 không chặn add JX;
  trùng thật vẫn chặn; overlay-deleted re-add pass).
- `npm run test:rules` — pass, gồm negative control: tạm hoàn nguyên `dailySchedule.ts` thì case mới fail đúng thông báo
  `Duplicate flight number NX985 on 2026-07-16` ⇒ test có tác dụng.
- `npm run test:seasonal-new-flight-creation` 9/9, `npm run test:atomic-flight` 6/6.
- `npx tsc --noEmit` sạch; `npx eslint` trên các file sửa sạch.

## 4. Phát hành

Bump `0.1.31` (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`),
commit `ca754e7`, tag `app-v0.1.31`.

- Workflow `Release desktop app`, run [35422763701](https://github.com/nijukyu11/SeasonalManagement/actions/runs/35422763701),
  tạo lúc `2026-09-19T05:00:03Z`, kết quả `success` sau `13m32s`; các bước `Run updater tests`, `Run rule regression tests`,
  `Run Python agent tests`, `Build signed Tauri bundle`, `Publish GitHub release` đều pass.
- Release `app-v0.1.31` publish lúc `2026-09-19T05:12:38Z`, 3 asset:
  - `SeasonalManagement_0.1.31_x64-setup.exe` — 22.787.342 bytes,
    `sha256:0787000e505178967fd14ba250d24447d8583cb7a955a349bf01189f06cb7bda`
  - `SeasonalManagement_0.1.31_x64-setup.exe.sig`
  - `latest.json` — `version: "0.1.31"`, `pub_date: 2026-09-19T05:12:33Z`, endpoint `windows-x86_64` trỏ đúng installer
    ⇒ app operator đang chạy 0.1.30 tự cập nhật lên 0.1.31, không cần cài tay.
- Phạm vi production đợt này: chỉ client Seasonal/Daily — không migration, không thay đổi DB, không deploy lại report site.

## 5. Tồn đọng (không sửa trong đợt này)

- **Gate export của Seasonal** (`SeasonalSchedulePage.tsx:1083`) vẫn chặn khi tập export chứa trùng số hiệu/ngày — đúng
  thiết kế: stage import Seasonal key theo `season_id|scheduled_date|airline|normalized_flight_number`
  (`20260724090000_seasonal_partial_import_v3.sql`), nên workbook chứa 2 cặp legacy sẽ không re-import được; chặn ở
  export là phát hiện sớm. Muốn export sạch phải xử lý dữ liệu: audit bằng
  `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql` (read-only), chọn row sai trong mỗi cặp rồi xoá/đổi số
  hiệu qua flow chuẩn trong app. Phiên này không có credential production (SSH `ops@100.91.158.79` trả
  `Permission denied (publickey,password)` với key hiện có; không có secret trong env) nên chưa audit/repair.
- **`buildDailyScheduleImportUpdate`** (`dailyScheduleImport.ts:862`) vẫn quét cả window, nhưng không còn đường chạy
  production: daily page dùng `stage_daily_schedule_import_v1`; hàm chỉ còn được `scripts/rule-regression-tests.cjs` dùng
  làm contract legacy.
