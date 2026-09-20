# Range picker neo theo From + release desktop 0.1.32

Ngày: 2026-09-20. Phạm vi: UI lọc khoảng ngày của 3 bề mặt Daily / Check-in / Gate + helper dùng chung
`app/src/lib/dailySchedule.ts`; phát hành desktop `0.1.32` qua GitHub Actions. Không đổi DB, không đổi report site.

## 1. Bối cảnh

Bộ lọc khoảng ngày có 2 ô From / To, nhưng chỉ **một** ô được cập nhật khi người dùng đổi mốc bắt đầu. Chọn From xong,
To vẫn giữ giá trị cũ ⇒ hai hệ quả:

- From ≥ To ⇒ chặn cứng `Timeline start must be before end` (Daily/Check-in) hoặc bảng tải rỗng;
- From < To nhưng lệch xa ⇒ tải dư khoảng ngày (chậm, dễ tưởng dữ liệu bị lặp).

Trong khi đó ba nút nhanh `1D/2D/7D` **đã** neo theo From (`To = From + N ngày`), nên hành vi không nhất quán giữa hai
cách nhập cùng một mốc.

## 2. Thay đổi (nằm trong 0.1.32)

| File | Thay đổi |
| --- | --- |
| `app/src/lib/dailySchedule.ts` | Thêm `addDaysToLocalDateTime(value, days)` — tách từ bản sao cục bộ ở Check-in/Gate để 3 trang dùng chung một implementation |
| `app/src/app/(desktop)/daily/page.tsx` | Ô From: có giá trị mới ⇒ `To = From + 1 ngày`; dải nút nhanh dùng helper chung |
| `app/src/app/(desktop)/checkin/page.tsx`, `app/src/app/(desktop)/gate/page.tsx` | Bỏ bản sao helper cục bộ, dùng helper chung; giữ hành vi `From ⇒ To + 1` |

Quy ước sau đợt này: sửa ô From (gõ tay hoặc chọn picker) ⇒ đặt lại `To = From + 1 ngày` — đúng bằng cửa sổ mặc định
1 ngày của trang; ba nút nhanh `1D/2D/7D` giữ ngữ nghĩa riêng `To = From + N ngày`. Ô To vẫn sửa độc lập được sau đó.

Commit: `c04b36e` (feature), `f51f456` (bump 0.1.32).

### 2b. Guard rỗng — có trên `main`, **không** nằm trong 0.1.32

`4f3a6c5` thêm `if (!value) return value;` vào helper. Lý do: V8 parse `new Date(':00')` **không** ra `NaN` (rơi về
`2000-01-01T00:00`), nên chuỗi rỗng lọt qua check `Number.isNaN` và helper trả mốc `2000-01-02` khi From rỗng rồi bấm
`1D/2D/7D`. Đường này **không tới được** trong 0.1.32 (handler From đã chặn `nextFrom` rỗng), và hành vi trước đợt này
cũng y hệt, nên đây là hardening chứ không phải regression: commit nằm trên `main`, sẽ theo bản phát hành kế tiếp.
Tag `app-v0.1.32` đã publish nên **không** re-tag/rewrite asset (giữ bất biến version ⇒ tránh hai binary khác nhau cùng
một số version trong updater).

## 3. Kiểm chứng

- **DOM thật** (dev server Next + browser, các trang `/daily`, `/checkin`, `/gate`): đổi ô From ⇒ ô To tự nhảy đúng
  `From + 1 ngày`; sửa To sau đó vẫn giữ; nút `1D/2D/7D` không đổi hành vi.
- **Helper** — trích nguyên văn thân hàm từ `src/lib/dailySchedule.ts` và chạy bằng Node:
  - `main` (có guard `4f3a6c5`): 7/7 case pass — cộng ngày giữ nguyên giờ/phút, rollover tháng
    (`2026-01-31T23:59 ⇒ 2026-02-01T23:59`), rollover năm (`2026-12-31T05:00 ⇒ 2027-01-01T05:00`), tháng 2
    (`2026-02-28T05:00 ⇒ 2026-03-01T05:00`), khoảng 7 ngày, và chuỗi rỗng passthrough (`'' ⇒ ''`).
  - Tag `app-v0.1.32` (chưa có guard): 6/6 case ngày hợp lệ pass; case chuỗi rỗng trả `2000-01-02` — đúng như mục 2b.
- **Build production**: `npm run build` → compiled `47s`, TypeScript pass, 14 route static (`/daily`, `/checkin`, `/gate`
  đều prerender), export ra `app/out/`.
- **Gate của workflow**: `npm run test:rules` pass, `npm run test:updater` 8/8 pass; `npx eslint` trên 4 file đã sửa:
  0 error (1 warning `resizing` unused ở `checkin/page.tsx:471` — có sẵn, ngoài diff).

## 4. Phát hành

Bump `0.1.32` (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `Cargo.lock`, `tauri.conf.json`),
commit `f51f456`, tag `app-v0.1.32` (build từ chính tag này).

- Workflow `Release desktop app`, run [35483396731](https://github.com/nijukyu11/SeasonalManagement/actions/runs/35483396731),
  tạo lúc `2026-09-20T02:12:49Z`, kết quả `success` sau `10m30s`; các bước `Run updater tests`, `Run rule regression tests`,
  `Run Python agent tests`, `Build signed Tauri bundle`, `Publish GitHub release` đều `success`.
- Release `app-v0.1.32` publish lúc `2026-09-20T02:22:31Z`, 3 asset:
  - `SeasonalManagement_0.1.32_x64-setup.exe` — 22.786.560 bytes,
    `sha256:9826cf0c13f5c814ba053e4b72e6e7a5f9ea91914508d08bc1191751f134d22e`
  - `SeasonalManagement_0.1.32_x64-setup.exe.sig` — 432 bytes
  - `latest.json` — `version: "0.1.32"`, `pub_date: 2026-09-20T02:22:18Z`, endpoint `windows-x86_64` trỏ đúng installer
    ⇒ app operator đang chạy 0.1.31 tự cập nhật lên 0.1.32, không cần cài tay.
- Phạm vi production đợt này: chỉ client Daily/Check-in/Gate — không migration, không thay đổi DB, không deploy lại report site.

## 5. Tồn đọng (không sửa trong đợt này)

- Sửa ô From luôn ép cửa sổ về đúng 1 ngày, kể cả khi người dùng đang xem khoảng dài (2/7 ngày) rồi chỉnh mốc bắt đầu —
  phải sửa lại ô To hoặc bấm nút nhanh để lấy lại khoảng dài.
- Chuỗi **không rỗng nhưng không hợp lệ** (ví dụ `garbage`) vẫn bị V8 parse lỏng thành mốc `2000-01-*`; không tới được
  từ UI (`datetime-local` chỉ trả `YYYY-MM-DDTHH:mm` hoặc rỗng) nên không xử lý thêm.
