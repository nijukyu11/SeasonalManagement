# Kế hoạch hợp nhất codebase và chuyển Report/Dashboard sang Live Traffic Aggregate

**Ngày lập:** 2026-08-31

**Trạng thái:** Đang thực hiện trên `codex/live-traffic-aggregate-integration` — đã merge local, hoàn tất feature parity/shared cutover dưới flag và rehearsal clone; chưa deploy/migration production, UI v2 mặc định tắt; YTD/full-range performance còn No-Go

**Implementation receipt:** `docs/superpowers/artifacts/2026-08-31-live-traffic-aggregate-implementation-receipt.md`

**Quyết định mục tiêu:** Report và phần Report Mode của Dashboard dùng chung một live aggregate contract đọc từ canonical effective flight legs, có watermark/data version và cache ngắn; Dashboard Operational Mode tiếp tục dùng workspace RPC riêng.

**Phạm vi code:** Git worktree `SeasonalManagement`, Git worktree `SeasonalManagement-web-traffic-report`, canonical reporting SQL, public report Edge API, Dashboard, test/build/deploy/runbook liên quan.

---

## 1. Kết luận về commit/merge trước implementation

### 1.1 Không cần merge để lập kế hoạch

File này được tạo trực tiếp trong worktree chính để khóa trình tự thực hiện. Không cần và không nên commit/merge chỉ để viết kế hoạch.

### 1.2 Bắt buộc hội tụ Git trước khi bắt đầu shared contract

Hai thư mục hiện không phải hai repository độc lập:

- `C:\Users\tuan\Documents\SeasonalManagement` là worktree của nhánh `codex/daily-import-v1`;
- `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report` là worktree của nhánh `codex/web-traffic-report`;
- cả hai dùng chung Git common directory `C:\Users\tuan\Documents\SeasonalManagement\.git` và cùng remote `nijukyu11/SeasonalManagement`.

Vì vậy không copy file để “hợp nhất workspace”. Việc cần làm là commit các thay đổi theo đúng chủ đề rồi hợp nhất lịch sử Git trên một nhánh integration sạch.

### 1.3 Bằng chứng divergence hiện tại

- `codex/daily-import-v1` đang tại commit `16f55de`, trùng `origin/main`, nhưng worktree có 15 path thay đổi/chưa track.
- `codex/web-traffic-report` đang tại commit `c3ed6a9`, ahead `origin/main` 22 commit và behind 4 commit, với 49 path thay đổi/chưa track.
- Merge-base hiện tại là `e829087`.
- Nhánh report chưa xuất hiện trên remote theo tên `codex/web-traffic-report`; source hiện hành cần được ghi nhận và backup bằng Git trước khi integration.
- Chỉ `app/package.json` trùng trong hai tập dirty path, nhưng lịch sử hai nhánh khác nhau trên 183 file, bao gồm route layout, package/lockfile, schema, migrations, report API/UI, Dashboard và deploy scripts.

### 1.4 Quyết định merge

Không merge trực tiếp `codex/web-traffic-report` vào worktree chính đang dirty. Không rebase lịch sử report đã dùng cho staging/production.

Trình tự an toàn:

1. Kiểm kê và commit riêng thay đổi của `codex/daily-import-v1`.
2. Kiểm kê và commit riêng thay đổi của `codex/web-traffic-report`.
3. Sau khi được duyệt push/backup, tạo nhánh mới `codex/live-traffic-aggregate-integration` từ `origin/main` trong một worktree sạch.
4. Merge `codex/daily-import-v1` vào integration branch.
5. Merge `codex/web-traffic-report` bằng merge commit, giữ lịch sử; không squash/rebase mặc định.
6. Resolve conflict theo contract đích, chạy toàn bộ baseline gates, rồi mới bắt đầu code live aggregate.
7. Chỉ merge integration branch về `main` sau khi source/test/build/rehearsal đạt yêu cầu và có phê duyệt riêng.

---

## 2. Mục tiêu và nguyên tắc kiến trúc

### 2.1 Target flow

```text
Seasonal / Daily / Manual changes
  -> canonical active records + modifications
  -> reporting.canonical_effective_flight_legs
  -> reporting.public_traffic_candidates
  -> một live aggregate RPC theo một PostgreSQL statement snapshot
  -> /api/report/v2 + version envelope + cache key theo watermark
  -> shared traffic data adapter
       -> Report
       -> Dashboard Report Mode

Workspace RPC v2
  -> Dashboard Operational Mode
  -> live operations, resource, timeline và drill-down
  -> không tuyên bố cùng as-of với Report Mode
```

### 2.2 Invariant bắt buộc

- Không public row-level canonical data; browser chỉ gọi aggregate wrapper.
- Không quay lại đọc raw history, physical preimage hoặc Daily staging rows.
- `Pax NULL` là chưa có dữ liệu; `Pax 0` là true zero.
- Future/not-due Pax không được nhập nhằng với missing Pax.
- Ops Date dùng cùng canonical function và ngưỡng 05:00.
- `all = A + D` cho flight count và các metric có thể cộng.
- Một response bundle dùng một database statement snapshot.
- Mọi response có `dataAsOf`, `sourceWatermark`, `dataVersion`, `contractVersion` và coverage metadata.
- Request phụ như dimension/export phải pin `expectedWatermark`; mismatch trả lỗi version-changed để client tải lại bundle.
- Report và Dashboard chỉ hiển thị “đồng bộ” khi version envelope giống nhau.
- Không drop snapshot/timer trong cùng release bật live API; snapshot v1 được giữ làm rollback cho đến hết soak window.

### 2.3 Những lớp được giữ trong pha đầu

- `canonical_active_flight_records_v1` và `canonical_effective_flight_legs`.
- `public_traffic_candidates` để giữ ranking/dedupe/quarantine cho đến khi uniqueness được enforce tại canonical write.
- Aggregate RPC và Edge public boundary.
- HTTP cache/rate limit/query timeout.
- Snapshot v1, projection state và timer ở trạng thái rollback-only trong giai đoạn dual-run.

### 2.4 Những lớp dự kiến decommission sau cutover

- Materialized view `reporting.public_traffic_effective`.
- Projection refresh runner/service/timer.
- Manual snapshot refresh helper.
- Projection state chỉ phục vụ physical snapshot.
- Runbook/cutover/cache-expiry steps chỉ còn liên quan snapshot.

Decommission là release riêng, sau khi live v2 đã qua staging, production shadow comparison và soak window được phê duyệt.

---

## 3. Phase 0 — Làm sạch và hội tụ hai worktree

### Task 0.1 — Chụp baseline và khóa thay đổi mới

- [ ] `git fetch --prune` sau khi được phép cập nhật remote refs; ghi commit remote main.
- [ ] Chụp `git status`, branch, merge-base, worktree list và diff stat cho cả hai worktree.
- [ ] Lưu test/build receipts hiện có và mapping release production về commit/source.
- [ ] Tạm dừng feature work mới trên hai nhánh trong lúc commit/converge.
- [ ] Không dùng `git reset --hard`, `checkout --`, stash mù hoặc xóa untracked artifact.

**Checkpoint:** Có inventory từng path, owner/scope và quyết định commit/ignore/retain rõ ràng.

### Task 0.2 — Commit worktree Daily/canonical theo scope

Nhóm commit đề xuất:

1. Daily contract/parser/tests.
2. Canonical migrations và overlay/authority fixes.
3. Public traffic aircraft snapshot migration/test đã thuộc lịch sử production.
4. Rule/package changes cần cho các test trên.
5. Docs/AGENTS tách riêng khi nội dung không thuộc runtime.

Trước mỗi commit:

- [ ] Review diff, `git diff --check` và UTF-8/mojibake scan.
- [ ] Chạy targeted unit/source/PGlite tests tương ứng.
- [ ] Không gom file không liên quan chỉ để có clean status.

### Task 0.3 — Commit worktree Report theo scope

Nhóm commit đề xuất:

1. Traffic report UI + shared client contract hiện tại.
2. SQL/Edge aggregate contract và Pax presence semantics.
3. Aircraft/dimension/regular-flight additions.
4. Annual KPI dashboard là scope riêng, không trộn vào live traffic core.
5. Build/test tooling.
6. Deploy scripts/Nginx/runbook/staging evidence.

Không commit mặc định:

- `traffic-report-ui-*.tar.gz`;
- CSV điều tra tạm;
- `tmp/` hoặc generated release artifacts;
- secret/env/credential material.

Nếu artifact cần retention, lưu theo artifact policy riêng với checksum, không đưa vào source commit tùy tiện.

### Task 0.4 — Integration rehearsal trong worktree sạch

- [ ] Tạo `codex/live-traffic-aggregate-integration` từ current `origin/main`.
- [ ] Merge nhánh Daily/canonical trước để thiết lập canonical database boundary.
- [ ] Merge nhánh Report sau, giữ merge commit và lịch sử phát hành.
- [ ] Không giải quyết conflict bằng blanket “ours/theirs”.
- [ ] Ghi conflict inventory và quyết định cho từng nhóm file.

Hotspot bắt buộc xử lý chủ động:

| Nhóm | Quy tắc resolve |
|---|---|
| `app/src/app/(desktop)` so với root desktop routes | Chọn một route architecture; giữ nguyên URL/Tauri behavior và vẫn build được report-only artifact |
| Dashboard page | Chỉ giữ một canonical implementation; không để hai bản copy drift |
| `package.json`/lockfile | Hợp nhất scripts/dependencies rồi regenerate lockfile bằng package manager, không chọn nguyên một phía |
| `rule-regression-tests.cjs` | Giữ union các gate Daily, desktop-route isolation và public report |
| SQL migrations | Giữ mọi migration đã áp dụng; live aggregate dùng migration mới, không sửa migration production đã chạy |
| `schema.sql` | Regenerate/verify từ chuỗi migration hợp nhất; không dùng schema của một nhánh ghi đè nhánh kia |
| Report Edge/API contract | Giữ v1 làm rollback, thêm v2 additive |
| Deploy/runbook | Giữ production receipts, bổ sung dual-run/live-v2/cutover/decommission |

### Task 0.5 — Baseline gate sau merge

- [ ] `npm ci` trong app hợp nhất.
- [ ] Traffic report contract/PGlite/Edge/isolation tests.
- [ ] Daily canonical/import/authority/overlay tests.
- [ ] Dashboard operational tests.
- [ ] Rule regression suite.
- [ ] TypeScript, targeted ESLint và `git diff --check`.
- [ ] Desktop/Tauri source gates liên quan route layout.
- [ ] Report-only build không chứa desktop routes.
- [ ] Desktop build không mất Report/shared modules cần thiết.
- [ ] UTF-8/mojibake scan cho toàn bộ file thay đổi.

**Checkpoint Phase 0:** Integration branch sạch, test baseline pass và cả Report/Dashboard cùng tồn tại trong một lịch sử Git trước khi thay đổi contract.

---

## 4. Phase 1 — Characterization và benchmark live source

### Task 1.1 — Khóa contract `traffic-report-v2`

Định nghĩa chung:

```ts
interface TrafficVersionEnvelope {
  contractVersion: 'traffic-report-v2';
  dataAsOf: string;
  sourceWatermark: number;
  dataVersion: number;
  filterHash: string;
}
```

Contract phải chứa:

- normalized `from/to`, `A/D/all`, airline, route, country và time basis;
- KPI current/comparison;
- continuous daily timeline;
- `reportedPax`, `reportedLegs`, `dueLegs`, missing/null/zero semantics;
- dimensions và pagination/version behavior;
- empty/error/version-changed states.

### Task 1.2 — Characterization tests trước khi sửa SQL

- [ ] Chụp output v1 cho 7 ngày, 30 ngày, YTD và full range.
- [ ] Fixtures cho null, true zero, positive Pax và future/not-due.
- [ ] Deleted/terminal/non-active rows.
- [ ] Duplicate ranking/quarantine và cross-season overlap.
- [ ] A/D/all, daily sum và dimension totals.
- [ ] Current production sample được lưu dưới dạng expected aggregate, không lưu raw row-level data.

### Task 1.3 — Benchmark canonical live query

Chạy read-only trên clone/staging trước:

- [ ] `EXPLAIN (ANALYZE, BUFFERS)` cho 7d/30d/YTD/full-range.
- [ ] Filter airline/route/country và A/D/all.
- [ ] Warm/cold query, concurrency 1/10/50.
- [ ] Đo ảnh hưởng khi Daily/Seasonal import chạy đồng thời.
- [ ] Ghi p50/p95/p99, rows scanned, temp spill và lock/wait.

Go khi live query nằm trong latency budget được owner chốt, không tạo sequential scan/full spill ngoài dự kiến và không làm tăng đáng kể lock/commit latency của import. Nếu fail, tối ưu index/query trước; không quay sang frontend aggregation.

---

## 5. Phase 2 — Xây live aggregate song song với snapshot v1

### Task 2.1 — SQL live aggregate bundle

Create migration mới, ví dụ:

`app/supabase/migrations/<next_timestamp>_public_traffic_live_aggregate_v2.sql`

- [ ] Đọc `reporting.public_traffic_candidates` hoặc canonical effective boundary đã chứng minh tương đương.
- [ ] KPI, timeline, coverage và top dimensions trong một SQL statement/RPC.
- [ ] Tính watermark/data version trong cùng statement snapshot.
- [ ] Không convert `NULL` thành 0 để biểu diễn presence.
- [ ] True zero vẫn có `reportedLegs > 0` và `reportedPax = 0`.
- [ ] Continuous date spine phân biệt zero-flight, missing coverage và future.
- [ ] Direct table/view/RPC permissions vẫn bị revoke khỏi `anon/authenticated`.
- [ ] Chỉ aggregate wrapper cần thiết được cấp cho Edge service role.

### Task 2.2 — Edge/API v2 additive

- [ ] Thêm `/api/report/v2`, không đổi behavior `/api/report/v1`.
- [ ] Chuẩn hóa query/filter hash một lần.
- [ ] Trả version envelope trên overview/timeline/dimension/export.
- [ ] Hỗ trợ `expected_watermark` cho request phụ.
- [ ] Mismatch trả `409 DATA_VERSION_CHANGED` và `Cache-Control: no-store`.
- [ ] Dùng ETag/cache key theo `watermark + filterHash`.
- [ ] Rate limit, statement timeout và response-size budget.
- [ ] Không gửi Cookie/Authorization/apikey từ public browser.

### Task 2.3 — Differential shadow comparison

- [ ] Gọi v1 snapshot và v2 live cùng normalized filter.
- [ ] Chỉ so khi v1 watermark bằng v2 watermark.
- [ ] So flights, Pax, reported/due legs, A/D/all, daily rows và dimensions.
- [ ] Mismatch lưu aggregate diagnostic và làm fail gate; không log raw sensitive rows.
- [ ] Chạy matrix null/zero/future/duplicate/deleted/cross-season.

**Checkpoint Phase 2:** V2 pass contract/security/performance và khớp v1 tại cùng watermark; v1 vẫn phục vụ production.

---

## 6. Phase 3 — Shared adapter và hai Dashboard mode

### Task 3.1 — Shared traffic data adapter

Create/modify dự kiến:

- `app/src/lib/trafficReportContract.ts` hoặc package/module dùng chung tương đương;
- `app/src/lib/trafficReportDataAdapter.ts`;
- contract/unit tests.

Adapter chịu trách nhiệm:

- normalize filters;
- request/cancel/retry read-only;
- validate payload/version envelope;
- xử lý 409 bằng full-bundle reload;
- không tự tổng hợp lại KPI/Pax từ rows.

### Task 3.2 — Chuyển Report sang v2 sau feature flag

- [x] Report UI dùng shared adapter khi flag bật và giữ v1 khi flag tắt.
- [x] Giữ loading/error/empty/version-changed states.
- [x] Hiển thị `dataAsOf`, watermark và trạng thái live/snapshot.
- [x] CSV/Excel dùng cùng contract/filter/version.
- [x] Không đổi nhãn nghiệp vụ tiếng Việt ngoài phạm vi đã duyệt.

### Task 3.3 — Thêm Dashboard Report Mode

- [ ] Overview/Comparison cần khớp Report dùng shared adapter/v2.
- [ ] Exact date range và continuous date spine giống Report.
- [ ] A/D/all, airline/route/country dùng cùng normalized filter.
- [ ] Không dùng `buildDashboardOverview` để tính lại metric cần đối soát.
- [ ] Hiển thị badge `Report data` và version envelope.

### Task 3.4 — Giữ Dashboard Operational Mode riêng

- [ ] Workspace RPC v2 tiếp tục phục vụ row/resource/drill-down.
- [ ] Sửa refresh path để áp trực tiếp server result và đúng window key.
- [ ] Sửa Pax coverage: `NULL`, true zero và future/planned là ba trạng thái khác nhau.
- [ ] Hiển thị `Live operational` cùng serverHighWater/fetchedAt.
- [ ] Không gộp metric Operational với Report Mode trong cùng KPI mà không ghi rõ source.

**Checkpoint Phase 3:** Report và Dashboard Report Mode khớp tại cùng version; Operational Mode vẫn hoạt động và minh bạch source.

---

## 7. Phase 4 — Rehearsal, staging và production cutover

### Task 4.1 — Clone/staging rehearsal

- [ ] Restore production-compatible PostgreSQL clone.
- [ ] Apply integration migrations theo đúng thứ tự, dùng validated role.
- [ ] Chạy v1/v2 differential matrix.
- [ ] Concurrency/performance/load tests.
- [ ] Security/privilege/isolation tests.
- [ ] Browser UAT Report + Dashboard Report Mode ở desktop/mobile.
- [ ] Verify NULL hiển thị `—`, true zero hiển thị `0`.
- [ ] Verify import commit không block hoặc bị report query làm chậm ngoài budget.

### Task 4.2 — Production dual-run

- [ ] Deploy code/API v2 nhưng giữ UI mặc định ở v1.
- [ ] Shadow compare aggregate trong khoảng quan sát đã duyệt.
- [ ] Theo dõi latency/error/version-changed/database load.
- [ ] Không disable timer hoặc drop MV.

### Task 4.3 — UI cutover

- [ ] Chuyển Report sang v2 bằng reversible config/release switch.
- [ ] Chuyển Dashboard Report Mode sang cùng v2.
- [ ] Verify cùng filter trả cùng watermark/version/count/Pax/daily/A-D-all.
- [ ] Giữ v1 endpoint, MV và timer làm rollback trong soak window.

### Task 4.4 — Decommission snapshot ở release riêng

Chỉ thực hiện sau soak window và phê duyệt riêng:

- [ ] Chứng minh không consumer còn gọi v1 snapshot path.
- [ ] Backup schema và ghi rowcount/watermark cuối.
- [ ] Disable timer trước, quan sát, rồi remove service/helper.
- [ ] Drop/decommission MV/projection state bằng migration riêng.
- [ ] Xóa config/runbook/cache rule không còn dùng.
- [ ] Retain rollback artifact và migration evidence.

---

## 8. Test matrix bắt buộc

| Nhóm | Tình huống | Kỳ vọng |
|---|---|---|
| Git integration | Merge Daily + Report histories | Không mất route, migration, test hoặc deploy evidence |
| Build isolation | Report-only build | Không chứa desktop/Tauri routes |
| Desktop | Desktop/Tauri build | Dashboard/operational routes hoạt động |
| Filter | A, D, all | `all = A + D` |
| Date | 7d/30d/YTD/full/custom | Cùng normalized range và continuous spine |
| Pax | toàn NULL | Pax là `null/—`, không phải 0 |
| Pax | true zero | reported leg có Pax 0 và coverage available |
| Pax | mixed NULL/0/positive | Tổng và presence đúng |
| Pax | future/not-due | Không tính như reported Pax |
| Lifecycle | deleted/terminal/non-active | Không xuất hiện trong live aggregate |
| Duplicate | unambiguous duplicate rank | Chỉ một business leg |
| Duplicate | ambiguous candidate | Quarantine/fail theo contract, không first-row-wins |
| Cross-season | cùng Ops Date ở nhiều season | Public business-key policy deterministic |
| Version | request phụ cùng watermark | Bundle nhất quán |
| Version | watermark đổi giữa hai request | 409 và full reload |
| Cache | ETag/filterHash/watermark | Cache cũ không gắn vào version mới |
| Security | anon/authenticated direct SQL/RPC | Bị từ chối |
| Security | public aggregate API | Không trả row-level fields |
| Refresh | record/modification mới ở Dashboard | Window membership cập nhật ngay |
| Failure | live SQL timeout/error | UI error rõ ràng; có rollback v1 trong soak |
| Import load | Daily/Seasonal commit đồng thời report traffic | Không deadlock hoặc vượt latency budget |

---

## 9. Rollback boundaries

### Trước UI cutover

- Disable feature flag v2 hoặc không publish v2 UI.
- V1 snapshot/timer tiếp tục hoạt động; không data rollback.

### Sau UI cutover, trong soak window

- Chuyển Report và Dashboard Report Mode về v1 adapter/release.
- Giữ v2 SQL/API additive để điều tra; không drop ngay.
- Reconcile watermark và aggregate trước lần cutover tiếp theo.

### Sau snapshot decommission

- Không hứa instant rollback về MV nếu MV đã drop.
- Khôi phục bằng migration/release đã rehearsal và backup evidence.
- Vì vậy decommission cần approval riêng và không gộp với live cutover.

---

## 10. Go/No-Go

### Go khi

- Hai nhánh đã hội tụ trong integration branch sạch.
- Mọi migration đã chạy production được giữ nguyên trong Git history.
- Baseline Daily/Report/Dashboard tests pass sau merge.
- V2 khớp v1 ở cùng watermark trên toàn differential matrix.
- Live query đạt latency/load budget và không ảnh hưởng import đáng kể.
- NULL/zero/future semantics pass SQL, API và browser UI.
- Security aggregate-only và role isolation pass.
- Có reversible cutover và snapshot v1 rollback trong soak window.

### No-Go khi

- Worktree còn dirty không rõ owner/scope.
- Merge conflict được resolve bằng bỏ nguyên một phía hoặc làm mất production migration.
- `schema.sql` không tái tạo được từ migration chain hợp nhất.
- Live query tạo sequential scan/temp spill/load vượt budget.
- Cross-request version có thể bị trộn.
- Report và Dashboard khác count/Pax/daily/A-D-all tại cùng watermark.
- True zero vẫn bị Dashboard coi là missing.
- Cần drop MV/timer trước khi v2 được shadow/rehearsal/accepted.

---

## 11. Definition of Done

Chỉ coi hoàn tất khi có bằng chứng code/test/log rằng:

1. Report và Dashboard source đã nằm trong một integration/main history; không còn hai nhánh sản phẩm drift độc lập.
2. Report và Dashboard Report Mode gọi cùng `traffic-report-v2` shared adapter/API.
3. Live aggregate chỉ đọc canonical effective/candidate boundary, không raw history/staging.
4. Một response bundle có một statement snapshot và version envelope đầy đủ.
5. Request phụ không trộn watermark; mismatch được reload an toàn.
6. Pax NULL, true zero và future/not-due đúng ở SQL/API/UI.
7. Cùng filter cho cùng flights, Pax, daily rows và A/D/all trên hai trang.
8. Dashboard Operational Mode giữ chức năng live nhưng minh bạch source/as-of riêng.
9. Live query đạt performance/concurrency budget và không làm hỏng import workload.
10. Public access vẫn aggregate-only; direct internal access bị revoke.
11. Production dual-run/cutover có receipt và rollback về v1 trong soak window.
12. Snapshot/timer chỉ bị decommission ở release riêng sau phê duyệt, với backup và rollback evidence.

---

## 12. Thứ tự thực hiện đề xuất

```text
Commit riêng từng dirty worktree
  -> integration branch/worktree sạch
  -> merge Daily/canonical
  -> merge Report
  -> resolve + baseline gates
  -> traffic-report-v2 characterization/benchmark
  -> live SQL/API additive
  -> v1/v2 differential shadow
  -> shared adapter
  -> Report + Dashboard Report Mode cutover
  -> production soak với v1 rollback
  -> decommission snapshot/timer ở release sau
```

Không đảo thứ tự giữa branch convergence, baseline characterization và live API implementation. Viết shared contract trước khi codebase hội tụ sẽ tiếp tục tạo hai bản contract và tái lập chính vấn đề drift cần loại bỏ.
