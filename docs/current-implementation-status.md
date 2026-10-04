# Trạng thái triển khai và cơ chế hiện hành

**Cập nhật separation:** 2026-10-04; các kiểm tra public/nhánh ở phần lịch sử bên dưới vẫn mang ngày 2026-09-04.  
**Phạm vi mới:** checkout local và Supabase staging `seasonal-staging-20261003` trên host ops; chưa triển khai separation lên production.  
**Commits separation:** backend `97077b7`, prerequisites `adc30ff`, UI/Planning/Operations `781bd56`, reader/worker M10 `2785b68`; các thay đổi Report khác của worktree không gộp vào phạm vi này.

Tài liệu này là bản đối chiếu trạng thái hiện hành. Khi nội dung cũ trong `context.md`, `architecture.md`, kế hoạch hoặc artifact khác với tài liệu này, phải kiểm tra lại code/migration đang được checkout và trạng thái production trước khi thao tác. Kế hoạch mô tả ý định; artifact/receipt mô tả một lần triển khai trong quá khứ; không tài liệu nào tự chứng minh trạng thái live hiện tại.

## 0. Separation Planning / Operations — bằng chứng mới nhất

- Production: **NO-GO**, chưa apply migration/cutover hoặc bật hai feature gate. Staging đã bật reader native; safe reverse từ chối do đã có native writes, không được ép đảo cờ hoặc sửa revision.
- Hai cờ build desktop mặc định OFF: `NEXT_PUBLIC_SEASONAL_PLANNING_V1_ENABLED` và `NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED`. Không bật writer desktop mới nếu reader/projection và fencing chưa cùng đạt gate.
- Planning: draft RPC theo epoch/revision, receipt authoritative và import/export snapshot. Seasonal/Detailed native tự lưu, bỏ Save/Discard thủ công; pending/error/stale chặn Publish/điều hướng. Undo dùng tombstone và toàn bộ `after` từ receipt, không gửi `expected:null` cho draft đã tồn tại. Native Tauri đã quan sát delete → Undo → hiện lại dòng ở cả hai trang; regression SQL phủ scalar/resource, pairing và nhiều mutation liên tiếp với child counters.
- Operations: Daily/Check-in/Gate đọc/ghi theo ngày và leg ID; journal localStorage `operational:pending-mutation:v2:${operatorId}` giữ đúng UUID/revision/payload qua phiên trình duyệt mới, không hydrate anonymous/operator khác. Dashboard native độc lập dịch vụ mùa/settings, giữ free date range; AI workspace không có mùa nhận operational date bounds. Chromium đã quan sát component thật; chưa gọi provider AI live.
- Recovery Operational đã nghiệm thu bổ sung: SQL thật commit rồi mất ACK ở cả lần đầu và automatic retry; reload/auth reset gửi lại cùng UUID/payload/revision gốc dù snapshot đã mới hơn, nhận receipt cũ và không tăng revision/ghi lại dữ liệu. Regression M4 còn chặn mutation khác khi chưa xác nhận và retry đồng thời khi RPC đang chạy. Chromium trên Daily/Gate/Check-in thật xác nhận Retry bật lại sau transport failure và journal hydrate sau auth reset; boundary RPC điều khiển, không thay nghiệm thu app shell/auth/Gantt.
- W26: quyết định giữ occurrence ở dòng Excel sau đã áp dụng cho 7 key trùng; 417 rows/25.992 legs. PGlite native Stage → Commit → Snapshot → Excel → Parse → Commit lại giữ đủ 25.992 legs/8.574 pairs, 154 overnight K6 pairs và template 25 cột, 0 diagnostics/missing/extra.
- Staging: FULL JOIN 11 cột trên 251.937 canonical rows trước reader cutover chỉ có delta VN318 DEP scheduled 29/03/2026 00:10, ops 28/03, Pax NULL → 175 do Daily thắng. Không thêm/mất chuyến hoặc delta ngoài danh sách duyệt. Hai JWT/WebSocket client thật đã kiểm chứng event/reconnect/old+new date/loopback.
- Worker projection staging riêng tự refresh sau native Pax mutation và restore trong khoảng 8–11 giây; listener/timer riêng active, fallback 2 phút, không sửa production units/containers. Native Annual KPI ghi nhận KE2094 Pax NULL → 77 → NULL làm tổng Pax tăng đúng 77 rồi trở về 5.733.097.
- Worker publication staging riêng đã thực sự chạy qua systemd và xuất bản HEAD **101**; sau sửa publisher, gọi binary thật xuất bản HEAD **102**, rồi systemd trả `already_current`. Business date `2026-09-30`, watermark **63.577**, data version **94** giữ nguyên. Getter trả `annual-passenger-publication-v2`, `rolling_completed_ops_dates_30`, window 30 ngày, reported Pax **5.733.097**, forecast Pax **7.444.147** (99,43%), freshness `fresh`. Timer 15 phút và listener `public_dashboard_daily_wake` active; hai deploy scripts đã backport vào repo, không chỉ sửa bản staging.
- Tauri thật đã compile/launch bằng WebView2: Seasonal/Detailed delete/Undo khôi phục dòng; retry giữ đúng request, stale reload không replay mutation và giải phóng guard sau authoritative reload. Harness dùng RPC điều khiển; **không** coi đây là nghiệm thu app shell có auth thật, layout/CSS hoặc Gantt trên staging.
- M10 default-OFF refresh bảo toàn hàm legacy gốc để giữ JX801/JX902, không repin baseline; KPI/version/candidate/publisher cũng capture preimage thật để OFF/rollback không hạ hợp đồng V2. M10 extended PASS đủ 8 pha: AI no-season, Daily V2, nguồn native Report/KPI/publication cùng generation, candidate thật → publisher, fail-closed và rollback giữ consumer behavior. Reverse thành công kiểm trước native writes; sau commit thật bị từ chối, không hạ workspace revision để né guard. **16 suite SQL separation** gồm regression M4 recovery mới, projection worker **7/7**, TS unit **593/593**, build **14 static routes** pass; lint 0 errors/2 warnings có sẵn. Production vẫn **NO-GO** khi chưa nghiệm thu app shell/auth/Gantt thực tế.
- AI native/canonical có 251.937 dòng; raw legacy view có 251.945 do 8 nhóm business-key trùng được canonical resolution hợp nhất. Không tuyên bố raw count parity; đối soát field-level canonical chỉ có delta VN318 được duyệt.
- Checklist và bằng chứng theo mốc: `docs/superpowers/plans/2026-09-28-seasonal-operational-separation-implementation-plan.md`. Các mục chưa nghiệm thu giữ unchecked; các phần dưới đây mô tả trạng thái legacy/lịch sử, không phải kết luận live mới.

## 1. Kết luận về các thay đổi chưa được hợp nhất

| Nhóm | Bằng chứng hiện tại | Trạng thái chính xác | Hành động còn thiếu |
| --- | --- | --- | --- |
| Daily Pax correction cho Dashboard | Commit `072e76b` và receipt `3d928ce` đang có trên local `main` | Đã có trong local `main`; local `main` đang đi trước `origin/main` 2 commit | Push/merge hai commit để clone từ `origin/main` tái tạo được code đã ghi nhận |
| Dashboard rolling 30 ngày | Nhánh sạch `codex/dashboard-rolling-30-forecast` có `3ad9b54` và `36e9aa2` | Chưa có trong `main` hoặc `origin/main`. Receipt trên nhánh ghi đã cutover production, nhưng kiểm tra public ngày 2026-09-04 đang trả KPI live contract v1 và không mở endpoint Daily Publication | Không được coi receipt là trạng thái live. Cần đối chiếu flags/Nginx/Edge/database rồi mới quyết định merge hoặc rollback đồng bộ |
| Tối ưu Daily import staging theo Ops Date | Nhánh sạch `codex/daily-stage-opsdate-performance` có `6f05837`, đã có trên remote branch riêng | Chưa có trong `main`; chưa thấy receipt production trong repo | Review migration preimage, chạy contract/PGlite, rồi merge và apply theo quy trình migration nếu được duyệt |
| Giao diện KPI wallboard đang sửa | 5 file product trong worktree đang modified | WIP chưa commit: light theme, bố cục wallboard toàn màn hình, `view=standard`, chart/nhãn mới và consumer tương thích publication v2 | Hoàn tất review/test rồi commit riêng; không dùng worktree này làm bằng chứng rằng production đã có UI mới |
| Hai workbook/report mới | Hai file plan chưa được Git theo dõi | Chỉ là kế hoạch; chưa phải tính năng trong checkout này | Không ghi `PERIOD_ANALYSIS`, `BAO_CAO_SAN_LUONG` hoặc Monthly L2 là đã triển khai nếu chưa có source/contract/test tương ứng |
| `tmp/` và `AGENTS.md` | `tmp/` chưa được theo dõi; `AGENTS.md` chỉ đổi mốc memory context | Không phải thay đổi sản phẩm | Không đưa vào release; dọn/ignore riêng nếu cần |
| `codex/route-reload-port` | Nhánh cũ phân kỳ lớn so với `main`; phần lớn patch đã được thay thế hoặc tích hợp theo lịch sử khác | Nhánh lịch sử, không phải một release candidate hiện hành | Không merge toàn nhánh; chỉ lấy một thay đổi cụ thể sau khi chứng minh còn thiếu trên `main` |

### Trạng thái public được kiểm tra trực tiếp

Kiểm tra GET không xác thực ngày 2026-09-04 cho năm 2026:

- `/api/report/v1/overview` và `/api/report/v2/overview`: `200` nhưng đều trả `contract_version=traffic-report-v1`, không có `read_version_token` hoặc `filter_hash`, watermark `50197`;
- `/api/report/v1/annual-kpi?year=2026`: `200`, `contract_version=annual-passenger-kpi-v1`, `period_to=2026-09-03`, `source_watermark=50197`, `source_data_version=16584`, `projection_status=fresh`;
- `/api/report/v1/dashboard-version?year=2026`: `200`, cùng watermark/data version;
- `/api/report/v1/dashboard-publication?year=2026`: `404`;
- `/api/report/v1/dashboard-publication-version?year=2026`: `404`.

Kết luận: code có Report live v2 và feature flag Daily Publication, nhưng API public đang quan sát được vẫn cung cấp Report v1 và live Annual KPI v1. Chưa kiểm tra DOM/build flag nên không suy diễn thêm rằng UI đang dùng mode nào; các receipt cutover trước đó không đủ để khẳng định v2 vẫn active. Có thể đã rollback, tắt flag hoặc lệch Edge/Nginx/static route triển khai.

## 2. Cơ chế desktop đang có trong code

### 2.1. Nguồn dữ liệu và đọc workspace

- Tauri/Next.js là runtime giao diện; self-hosted Supabase là nguồn đọc/ghi bền vững và ranh giới xác thực cho vận hành bình thường.
- Route đọc snapshot theo cửa sổ từ Zustand trước để render ngay, sau đó `seasonWorkspaceWindowCoordinator` revalidate qua `get_season_schedule_allocation_window_v2`.
- V2 ghép các page keyset tuần tự dưới cùng `dataVersion` và `serverHighWater`. Không commit một snapshot bị cắt, trộn version hoặc thiếu page.
- Timeout/network failure không được chuyển sang direct-table fan-out, IndexedDB hoặc SQLite. SQLite/native sync chỉ còn cho repair/rollback khi bật rõ ràng.

### 2.2. Save, Fetch data và Realtime

```text
Draft/debounced edit
  -> serialize operation + changedFields
  -> apply_season_server_mutation_v1
  -> server receipt + season_change_events
  -> cập nhật snapshot/cache cục bộ
  -> Realtime patch trực tiếp hoặc đánh dấu cửa sổ cần revalidate
```

- `Save` flush draft/operation của route qua RPC server-authoritative; normal mode không upload SQLite pending queue.
- `Fetch data` ép đọc lại cửa sổ Supabase; không submit draft và không gọi native pending sync.
- Check-in/Gate dùng `ganttInteractionArbiter` theo target. Event có `serverSeq` và payload đầy đủ được patch trực tiếp; gap, reconnect, target lạ hoặc payload thiếu sẽ giữ snapshot hiện có và coalesce background revalidation.
- Server sequence quyết định latest-write-wins; client clock và thứ tự websocket đến không phải authority.

### 2.3. Seasonal Import V3 và export

```text
Workbook
  -> parser + canonical source rows
  -> stage_seasonal_import_v3
  -> server preview được persist
  -> operator xác nhận merge hoặc replace có quyền season.repair
  -> commit_seasonal_import_v3
  -> revalidate snapshot/version
  -> get_seasonal_export_snapshot_v2 khi export
```

- `merge` chỉ thay các baseline occurrence có trong file đến, giữ bản ghi bị lược và mọi operational overlay.
- `replace` là thao tác sửa chữa phá hủy có kiểm soát: yêu cầu quyền, hiện count sẽ xóa/clear và xác nhận season code.
- Client V3 không fallback sang V2/V1, direct-table writes hoặc SQLite.
- Status/cancel/receipt theo owner giải quyết retry và ambiguous response; status check không tự stage hoặc tự commit.

### 2.4. Daily Schedule Import V1

```text
.xlsx/.xls
  -> analyzeDailyScheduleWorkbook
  -> nhận diện đúng một bảng 43 cột nghiệp vụ
  -> buildDailyImportStagePayloadV1
  -> stage_daily_schedule_import_v1
  -> preview + zero-flight confirmation nếu cần
  -> commit_daily_schedule_import_v1
  -> patch dataVersion + force revalidate Daily window
```

- Parser hỗ trợ profile `legacy-operationalturns`, `compact-lb` và layout tương thích theo vị trí; workbook có 0 hoặc nhiều hơn 1 sheet hợp lệ bị chặn.
- Stage/commit bị chặn khi season đích còn draft/pending change.
- Batch `cancelled`/`expired` được restage đúng một lần bằng request ID mới; lỗi không rõ kết quả được đối chiếu bằng status RPC.
- Chỉ `PT409` có message `Stale Daily import stage` được coi là stale-version có thể tự phục hồi: refresh season metadata rồi stage lại đúng một lần. Các RPC error khác không được retry mù.
- Commit trả `dataVersion` mới; client cập nhật season cache/store, force-revalidate cửa sổ Daily và chỉ sau đó hiển thị hoàn tất.
- Commit `6f05837` đề xuất thay phép tính Ops Date trong loose-identity lookup bằng cột `season_flight_records.operational_date` đã persist/index. Tối ưu này chưa nằm trong `main`.

## 3. Cơ chế Report và Dashboard

### 3.1. Canonical metrics và Report live

- Canonical effective leg được quyết định ở database sau active/deleted/duplicate resolution và operational overlays.
- Ops Date dùng biên `05:00–04:59` tại `Asia/Ho_Chi_Minh`.
- `Pax NULL` là missing; `Pax 0` là reported true-zero. Frontend không `coalesce` missing thành 0 và không tự cộng lại metric backend đã sở hữu.
- Code Report v2 gọi `get_public_traffic_report_v2`. Initial read trả source watermark, semantic `data_as_of`, filter hash và read-version token; timeline/dimension/export phải dùng cùng version hoặc nhận conflict khi source đã đổi.
- Report read version chống trộn dữ liệu giữa request, nhưng không giữ một MVCC snapshot qua nhiều HTTP request. Export tái lập cần một statement/job và receipt riêng.
- Public API kiểm tra ngày 2026-09-04 vẫn trả `traffic-report-v1` cho cả path `/v1/overview` và `/v2/overview`; vì vậy live-v2 là khả năng có trong code, chưa phải contract đang quan sát được trên production.

### 3.2. Daily Publication đã có trong code

```text
Daily acceptance hoặc committed Pax correction
  -> durable dirty marker + transactional NOTIFY
  -> runner coalesce/single-flight
  -> canonical metrics + watermark checks + quality gate
  -> immutable public_dashboard_publications
  -> ready mới được advance current head
  -> verifier; lỗi giữ last-known-good
```

- Publisher không overwrite publication cũ. Correction tạo publication mới tại head Business Date hiện hành.
- Dirty marker chỉ được acknowledge khi ready publication có watermark không thấp hơn event mới nhất; concurrent edit vẫn còn dirty cho vòng sau.
- Known Pax của một Ops Date đã complete được report ngay. T+24 chỉ là hạn phân loại `Pax NULL` overdue, không chặn Pax đã biết.
- Client có hai read mode compile-time: Daily Publication khi `NEXT_PUBLIC_TRAFFIC_DASHBOARD_DAILY_PUBLICATION=true`, hoặc live `/annual-kpi` khi flag không bật.
- Cả hai mode poll version mỗi 60 giây bằng ETag; lỗi background giữ snapshot đang hiển thị.

### 3.3. Annual KPI và rolling forecast

- Migration đang có trên `main` tạo `annual-passenger-publication-v1`: forecast dùng average Pax YTD nhân số ngày của năm sau quality gate.
- Migration chỉ có trên nhánh rolling-30 tạo `annual-passenger-publication-v2`: actual YTD không đổi; phần còn lại của năm dùng trung bình tối đa 30 Ops Date liên tục gần nhất, tối thiểu 7 ngày, không có ngày missing/partial và coverage tối thiểu 99,5%.
- Worktree frontend hiện giải mã v1/v2 và hiện basis rolling khi metadata có mặt, nhưng thay đổi này chưa commit trên `main`.
- Do endpoint public đang trả live KPI v1 và Daily Publication 404, tài liệu vận hành chỉ được gọi **live KPI v1 là contract API đang khả dụng**; mode UI vẫn cần xác minh flags/static DOM và publication head.

## 4. Tính năng hiện hành theo code-of-record

| Khả năng | Trạng thái |
| --- | --- |
| Desktop server-first Supabase, V2 window, Realtime convergence | Có trên `main` |
| Seasonal Import V3 preview/merge/replace/recovery/export snapshot | Có trên `main` |
| Daily dual-format atomic import, zero-flight confirmation, PT409 stale recovery | Có trên `main` |
| Public Report live v2 với read-version/watermark/filter hash | Có trên `main`; public API hiện vẫn trả `traffic-report-v1` |
| Immutable Daily Publication, publication ledger, runner, dirty-marker Pax correction | Có trên local `main`; hai commit mới nhất chưa có trên `origin/main` |
| Public dashboard thực tế đang dùng Daily Publication | Không được xác nhận; endpoint hiện trả 404 |
| Rolling 30-day forecast source | Có trên nhánh riêng; chưa có trên `main` |
| Indexed Ops Date Daily staging | Có trên nhánh riêng; chưa có trên `main` |
| Light wallboard/full-height KPI UI | WIP chưa commit |
| Workbook `PERIOD_ANALYSIS` / `BAO_CAO_SAN_LUONG` | Kế hoạch, chưa phải tính năng trong checkout này |

## 5. Quy tắc cập nhật trạng thái tiếp theo

1. Phân biệt bốn mức: có trong `main`, có trong worktree/branch, đã apply database, và đang được public route/UI sử dụng.
2. Không nâng trạng thái từ plan/receipt lên “đang hoạt động” nếu thiếu source commit trong code-of-record hoặc live read hiện tại.
3. Trước migration/deploy phải kiểm tra exact migration SHA, preimage, backup, clone rehearsal và rollback; sau deploy kiểm tra API contract, header/cache, public DOM và watermark/data-as-of.
4. Sau khi merge/push hoặc thay đổi feature flag, cập nhật bảng ở mục 1 và mục 4; không sửa các artifact receipt lịch sử.

## 6. Verification của lần cập nhật này

- `git ls-remote` xác nhận remote `main` vẫn ở `8d83783`; remote branch Daily optimization ở `6f05837`; rolling-30 chưa có remote branch tương ứng.
- `npm run test:daily-import`: 16/16 pass.
- `npm run test:traffic-report-contract`: 29 + 25 + 7 test pass; PGlite, Edge contract, isolation và Dashboard runner contract đều pass.
- `git diff --check`: pass; chỉ có cảnh báo chuyển LF/CRLF của worktree Windows.
- Scan UTF-8 các tài liệu thay đổi không phát hiện marker mojibake.
