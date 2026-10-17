# Kế hoạch tái thiết kế Dashboard Desktop và gỡ bỏ AI Workspace / Sidecar

- Ngày khảo sát: 2026-10-12.
- Trạng thái: **Đã triển khai code, kiểm thử nghiệp vụ và smoke native local theo yêu cầu “triển khai theo kế hoạch”; kết quả và giới hạn nghiệm thu tại §10. Chưa phát hành Production.**
- Ứng dụng: `app/` — Next.js static export + React, Tauri 2/Rust, bộ cài Windows x64 NSIS. Không phải Electron.
- Đặc tả đã đọc đầy đủ: `C:/Users/tuan/.gemini/antigravity/brain/7e3c99d1-c4b5-40fc-9505-60ee688115c5/feasible_std_spec.md`, phiên bản 1.0, 669 dòng.
- Phạm vi khảo sát ban đầu: chỉ đọc và lập kế hoạch. Người dùng sau đó yêu cầu triển khai theo kế hoạch.
- Checklist dưới đây là tiêu chí đầy đủ; không coi build thành công là thay thế clean-install/upgrade trên máy nghiệm thu. Trạng thái đã thực hiện và phần chưa kiểm chứng được ghi tại §10.
- Cập nhật review: Dashboard thuần Planning, mặc định Draft, hai tab Tổng quan kế hoạch / Thay đổi kế hoạch; bỏ drill-down ngầm sang Daily live. Inventory sidecar và kết quả khảo sát hiện trạng giữ nguyên.

## 1. Kết luận và phạm vi

1. Desktop vẫn đóng gói Python AI sidecar dù đường submit AI Workspace hiện gọi Supabase Edge trực tiếp. Phải gỡ cả sidecar lẫn UI/logic AI Desktop; chỉ bỏ Python không loại bỏ AI Workspace.
2. Dashboard hiện có KPI/timeline vận hành và so sánh sản lượng MoM/WoW/YoY, nhưng **so sánh sản lượng không phải so sánh phiên bản lịch bay**. Version Diff đã có engine, API và viewer dùng được; không xây engine diff thứ hai.
3. Chưa tìm thấy engine Feasible STD theo đặc tả trong các module Desktop/SQL đã khảo sát. Check-in có cùng offset −180/−50 nhưng giải bài toán phân bổ quầy vật lý, không tính khả năng nhận thêm một chuyến trên toàn cửa sổ.
4. Thiết kế mới là **Planning Dashboard**: KPI, tải theo giờ và STD dùng cùng nguồn Draft hoặc published version của mùa đang chọn. Hai tab **Tổng quan kế hoạch / Thay đổi kế hoạch**; nguồn Operations live không làm baseline ngầm định.
5. Bỏ double-click kế hoạch → Daily. Draft drill-down tới Detailed đúng mùa; published drill-down tới snapshot read-only đúng version. Daily/Gate/Check-in vẫn ở sidebar Operations. Không thay nguồn Public Traffic Report/Annual KPI, template Import/Export, Publish, Daily authority, nhật ký retry hay cutover gate.
6. Các quyết định còn mở ở §8 gồm tải xuyên ngày, độ chính xác lấy mẫu, params và nơi truy cập báo cáo phụ. Không tự triển khai workflow approval, cấp slot đường băng hoặc ghi Operations từ Dashboard.

### 1.1 Hướng thiết kế cập nhật sau review

- “Loại bỏ hoàn toàn AI Workspace” bao gồm tab AI trên Dashboard, tab cấu hình AI Desktop, IPC, Python, dev harness, dependency độc quyền và hook CI; không chỉ ẩn UI.
- Header thống nhất: **Mùa → Nguồn kế hoạch (Draft mặc định / Published version cụ thể) → Khoảng ngày**. KPI/tải/STD đều dùng nguồn này; chọn bản đối chiếu chỉ ảnh hưởng diff, không đổi baseline KPI/STD.
- Với Draft: so với published mới nhất cùng mùa. Với published: mặc định so bản liền trước, có thể chọn published base cùng mùa. Draft comparison là phần tích hợp bổ sung, không giả định viewer published hiện hữu đã hỗ trợ.
- Box đổi tên thành **“Xét khả năng thêm chuyến”**, đánh giá mô phỏng không ghi dữ liệu. Xanh chỉ là khả thi theo tải xử lý của tập kế hoạch này, không phải cấp slot hay bảo đảm Operations live. Muốn thêm thật thì dùng luồng tạo Planning draft hiện hữu, không thêm writer mới trong Dashboard.
- Report và so sánh sản lượng không nằm trên hai tab chính; bảo toàn chức năng/export tại lối truy cập báo cáo riêng hoặc menu phụ được duyệt, không xóa âm thầm.
- Múi giờ tính toán: `Asia/Ho_Chi_Minh`, cutoff 05:00 dùng để nhóm ngày tải trong kế hoạch. UTC chỉ đổi hiển thị; không biến nguồn Planning thành Operations.

## 2. Current State Audit

### 2.1 Bằng chứng build và kích thước

| Thành phần | Hiện trạng đã đọc/đo | Ý nghĩa |
|---|---|---|
| `app/src-tauri/tauri.conf.json:6–10,40–49` | `beforeBuildCommand = npm run python:agent:bundle && npm run build`; `frontendDist = ../out`; `externalBin = binaries/dashboard-ai-agent`; NSIS + updater artifacts | Python binary thực sự nằm trong đường đóng gói |
| `app/scripts/build-python-agent.cjs:26–46` | pip install runtime/build requirements; PyInstaller `--onefile`; tên theo target triple | Bỏ sidecar phải bỏ cả hook, không chỉ xóa EXE |
| `app/src-tauri/binaries/dashboard-ai-agent-x86_64-pc-windows-msvc.exe` | **37.281.551 bytes = 35,554 MiB**, đo filesystem chỉ đọc | Đây là binary hiện có; không phải lượng giảm của NSIS nén |
| `.github/workflows/release.yml:47–54,77–90` | Setup Python 3.12/cache pip, install requirements, Python tests, signed native build | CI phụ thuộc sidecar trước khi đổi config |
| `app/package.json:45–54` | 4 script `python:agent:*`; `native:build = tauri build --ci` | Giữ native build, bỏ các script Python |
| `app/src-tauri/target/release/bundle/nsis/` | Artifact local cũ tới 0.1.10; package/config hiện 0.1.33 | Không dùng bộ cài cũ làm baseline so dung lượng |

**Chưa đo:** NSIS của cùng revision trước/sau, tổng dung lượng sau cài, frontend chunks, thời gian CI. Không cam kết giảm bao nhiêu phần trăm hoặc bao nhiêu phút. DevDependency npm không mặc nhiên được đóng vào Tauri; lợi ích giảm `node_modules` khác lợi ích giảm installer.

### 2.2 Inventory file/thư mục dự kiến xóa sau khi đã cắt hết callers

Mọi đường dẫn trong bảng là hiện hữu tại thời điểm khảo sát. Đây là danh sách kế hoạch, chưa xóa.

| Nhóm | File/thư mục |
|---|---|
| Python entry/build requirements | `app/ai-agent/agent_sidecar.py`, `app/ai-agent/requirements.txt`, `app/ai-agent/requirements-build.txt` |
| Python modules | `app/ai-agent/agent/__init__.py`, `main.py`, `contracts.py`, `provider_clients.py`, `sqlite_source.py`, `sql_validator.py` |
| Python tests | `app/ai-agent/tests/__init__.py`, `test_local_agent_workflows.py`, `test_provider_clients.py`, `test_sql_validator.py` |
| Generated Python artifacts | `app/ai-agent/.pyinstaller/`, các `__pycache__/` thuộc module này; không đụng cache/source khác |
| Sidecar binary | `app/src-tauri/binaries/dashboard-ai-agent-x86_64-pc-windows-msvc.exe`; kiểm kê các target khác trước khi dọn đúng binary cùng tên |
| Build hook | `app/scripts/build-python-agent.cjs` |
| AI dev spike/harness | `app/scripts/check-skawld-sdk.mjs`, `skawld-dashboard-agent-harness.mjs`, `test-skawld-dashboard-agent-harness.mjs`, `dashboard-ai-local-sql-source.mjs` |
| Dashboard AI UI | `app/src/app/(desktop)/dashboard/components/AiWorkspacePanel.tsx`, `AiNotebookCanvas.tsx`, `AiNotebookBlockRenderers.tsx` |
| Desktop AI settings UI | `app/src/app/(desktop)/settings/components/AiAnalysisTab.tsx` |
| Desktop AI libraries | `app/src/lib/dashboardAiAnalysis.ts`, `dashboardAiAdmin.ts`, `dashboardAiShared.ts` — chỉ xóa sau tách type đang dùng bởi export |

Sau khi gỡ các file trên, thư mục `app/ai-agent/` không còn vai trò. Không xóa cả `src-tauri/binaries/` nếu còn binary khác trong revision triển khai. Log/probe cũ ngoài inventory không tự động thuộc phạm vi xóa.

### 2.3 Inventory file phải sửa và dependency ngầm

| File | Nội dung cần cắt/thay | Phần phải bảo toàn |
|---|---|---|
| `app/src/app/(desktop)/dashboard/page.tsx` | Gỡ AI; thay nguồn KPI/tải/STD từ runtime sang Planning; thay Daily double-click bằng drill-down đúng Draft/Version; bố trí hai tab | Loading/error/auth fences, chức năng báo cáo/export không-AI được chuyển lối truy cập rõ ràng; Daily live giữ ở Operations |
| `app/src/app/(desktop)/settings/page.tsx` | Tab `aiAnalysis`, model/key state, provider helpers, key sync handlers và import `AiAnalysisTab` | Các tab quầy/gate/rules/users/repair/updater và quyền tương ứng |
| `app/src/lib/settingsAccessState.ts` | Bỏ `aiAnalysis` khỏi tab union; xử lý session tab cũ về tab hợp lệ | Protected tab logic Users/Repair |
| `app/src/lib/types.ts`, `settingsRules.ts` | AI types, default prompts/context documents, defaults/normalizers/hydration/serialization `aiAnalysis` | Operational settings không-AI, validation resource rules |
| `app/src/lib/supabaseRelationalMappers.ts` | AI row types/converters, inputs `aiModels`/context documents, serialize `ai_*` | Settings/flight/source-row mapping dùng chung |
| `app/src/lib/supabaseStore.ts:714–818` | Bỏ fetch `operational_ai_models`/`operational_ai_context_documents` và writers `replaceTableRows` tương ứng | **Không** thay bằng array rỗng rồi gọi replace: có thể xóa dữ liệu AI server; không cập nhật `ai_*` khi lưu settings không-AI |
| `app/src/lib/dashboardReportExport.ts:1–44` | Import type `DashboardAiContext`, `DashboardCustomWorkbookSpec`; tách contract export nghiệp vụ khỏi AI trước khi xóa lib AI | Workbook sản lượng/so sánh và `exportSave`; bỏ builder chỉ AI khi thực sự không còn caller |
| `app/src/lib/nativeSeasonCatchup.ts`, `nativeSeasonRepository.ts` | Types/wrappers/re-exports `callNativeDashboardAiAgent`, `queryNativeDashboardAiAgentHealth`, `queryNativeDashboardAiSql` | Native catchup, retry/sync, local SQL, cleanup phiên |
| `app/src-tauri/src/lib.rs` | AI request/health/provider DTOs; `DashboardAiAgentState`, token/create/probe/wait/ensure helpers; provider-key fetch; health/analyze/SQL commands; handler registrations; `.manage(...)` AI; shell import/init | Main shell, single-instance, export save/open/reveal, updater/process/sql, catchup |
| `app/src-tauri/src/native_catchup.rs` | `QueryNativeDashboardAiSqlInput/Result`, `query_native_dashboard_ai_sql`, `query_dashboard_ai_sql_on_connection`, temp view `dashboard_ai_flight_operations`, AI-only SQL validators/CTE parsing helpers | SQLite workspace schema, catchup/realtime/sync và validators không-AI |
| `app/src-tauri/tests/native_catchup.rs` | AI fixture/test groups theo các helpers bị xóa | Tất cả test native catchup/session/recovery không-AI |
| `app/src-tauri/tauri.conf.json` | `beforeBuildCommand` thành `npm run build`; bỏ `externalBin` AI | product identifier, window, static export, NSIS/updater signing/endpoints |
| `app/src-tauri/Cargo.toml`, `Cargo.lock` | Bỏ `tauri-plugin-shell` khi không còn consumer; cập nhật lock bằng Cargo | Các dependency dùng chung ở §2.4 |
| `app/package.json`, `package-lock.json` | Bỏ script/dependency AI; cập nhật lock bằng npm sau khi duyệt | Native/release/updater/report/import/export scripts |
| `.github/workflows/release.yml` | Bỏ Setup Python, Install Python agent dependencies, Run Python agent tests/cache pip | Node/Rust cache, env validation, test không-AI, signed build, publish manifest |
| `app/scripts/rule-regression-tests.cjs` | Bỏ module loads/readFile/assertions AI/Python/Skawld; tách kiểm thử nghiệp vụ khỏi AI; sửa test suite bị mất caller | Không xóa cả suite, không sửa baseline nghiệp vụ để che drift |
| `app/src/lib/dashboardReportingContract.source.test.ts`, `settingsAccessState.test.ts` | Bỏ block chỉ về AI; thay source/wording/layout assertions liên quan UI đổi bằng behavioral checks cần thiết | Coverage thật của reporting/permission/date/data isolation |
| `app/README.md`, `app/.gitignore`, tài liệu vận hành hiện hành | Khi triển khai: cập nhật build không Python, bỏ ignore/hướng dẫn độc quyền sidecar nếu có | Không viết lại tài liệu lịch sử để làm sai dấu vết |
| `app/src/lib/appSessionCleanup.ts:15–23` và Dashboard session state | Xử lý key cũ `dashboard:aiNotebook:*`/view `ai-workspace` theo chính sách dữ liệu được duyệt | Không `localStorage.clear()`, không xóa auth/journal/schedule data |

**Hai coupling cần xử lý trước khi xóa lib AI:**

- `dashboardReportExport.ts` đang lấy type từ `dashboardAiAnalysis.ts`. Chuyển phần data comparison/workbook thực sự cần giữ sang contract export nghiệp vụ nhỏ trong module hiện hữu; migrate mọi caller. Không giữ alias/re-export AI giả để qua type-check.
- Operational settings load/save đang fetch và replace bảng AI như một phần settings chung. Cắt read/write AI trong cùng thay đổi contract/mappers; settings cũ chứa trường AI phải vẫn hydrate được các trường còn lại, nhưng Desktop không tiếp tục quản lý AI. Cột/bảng AI server giữ nguyên, không DROP/migration trong task removal.

### 2.4 Dependencies và boundary cần giữ

| Dependency | Kế hoạch | Bằng chứng/ràng buộc |
|---|---|---|
| Python `fastapi==0.115.6`, `httpx==0.27.2`, `pydantic==2.10.4`, `uvicorn==0.32.1`; build `pyinstaller==6.11.1` | Bỏ requirements và bước cài/build trong repo | Không uninstall Python/package dùng chung trên máy người dùng |
| npm dev `@skawld/agent-sdk ^0.1.0`, `better-sqlite3 ^11.10.0` | Bỏ sau xóa dev harness | `better-sqlite3` consumer tìm thấy là `dashboard-ai-local-sql-source.mjs:125`; không phải SQLite Rust |
| Cargo `tauri-plugin-shell = 2` | Bỏ | `.sidecar(...)` dùng shell plugin; open/reveal export dùng `std::process::Command` |
| Cargo `reqwest`, `rusqlite`, `tokio`, `serde`, `serde_json`, `base64`, `dirs`, Tauri/process/single-instance/sql/updater | Giữ | Catchup/network/SQLite/export/main lifecycle còn dùng; không suy từ tên import AI mà xóa dependency |
| npm `@supabase/supabase-js`, Tauri API/plugin-process/sql/updater, `xlsx`, `recharts`, React/Next/Zustand | Giữ | Auth, data, updater, Excel và UI dùng chung; STD chart tái dùng Recharts |
| npm `html2canvas`, `jspdf` | Giữ | `checkinPdfExport.ts:898–900`, `gatePdfExport.ts:784–786` import động cho PDF |
| npm dev PGlite/pg/TypeScript/ESLint | Giữ | DB regression, tooling/build không-AI |

**Không thuộc gói Desktop / không tự xóa server:**

- `app/supabase/functions/dashboard-ai-analysis/`, `rotate-dashboard-ai-key/`, `_shared/dashboardAiShared.ts` là backend AI. Desktop ngừng gọi; việc retire endpoint/key/secrets cần duyệt riêng và kiểm mọi server consumer. Không suy rằng xóa các file này giảm installer.
- Giữ toàn bộ lịch sử `app/supabase/migrations/`, `schema.sql`, bảng/cột quyền AI trong DB và permission registry/Auth/Users & Roles đang dùng chung. Không sửa RLS/permission chung để gỡ UI AI.
- Giữ `reporting.flight_operations`, `reporting.effective_flight_operations`, `reporting.query_aggregated`, traffic report RPC/Edge và annual publication workers.
- Giữ `app/src/app/(public-report)/`, Traffic Report contracts/adapters/styles. Bảo toàn `TrafficReportModePanel.tsx` để truy cập báo cáo ngoài hai tab Planning chính; không nhúng runtime Report làm widget kế hoạch.

### 2.5 Hiện trạng Dashboard và luồng dữ liệu

Nguồn: `app/src/app/(desktop)/dashboard/page.tsx:203–205,914–951,1562–1729,2715–3532`; `dashboardAnalysis.ts`; `operationalDashboardAnalysis.ts`.

- Bốn mode: Operations, Report (cờ `NEXT_PUBLIC_TRAFFIC_REPORT_V2_ENABLED`), Comparison sản lượng, AI Workspace.
- Operations: ARR/DEP/tổng chuyến/Pax/A−D, peak buckets, Pax coverage/missing, alerts; ARR/DEP timelines 30/60 phút, peak-day/hour heatmaps, baseline cùng thứ.
- Comparison: MoM/WoW/YoY, waterfall, CTG airline/route/country và biến động cơ cấu. Không có published version comparison ở mode này.
- AI: Notebook/prompt/model/session storage, workspace query scopes và Edge API. `dashboardAiAnalysis.ts` gọi `supabase.functions.invoke('dashboard-ai-analysis', ...)`; UI submit không đi qua Python sidecar.
- Native Operations hiện dùng free-date window khi `NEXT_PUBLIC_OPERATIONAL_SCHEDULE_V1_ENABLED=1`; vẫn có nhánh legacy context mùa. Đây là hiện trạng cần tách khỏi Dashboard Planning, không phải nguồn KPI/STD mới; không bật/tắt gate Operations để phục vụ redesign.
- `operationalDashboardAnalysis.ts:126–185` có cutoff 05:00, offset local UTC+7, bucket logic. Đây là logic tổng hợp khai thác, chưa là sliding-window feasibility.
- `DateRangeFilter.tsx` hiện lọc tháng/mùa và không được page dùng. Header mới chọn mùa/nguồn/khoảng ngày trong context Planning; reuse date helpers nếu semantics phù hợp, không nhập nguyên component cũ chỉ vì tên gần nhu cầu.
- Double-click hiện dẫn tới `/daily?date=...`. Trong target mới phải bỏ hành vi này khỏi biểu đồ kế hoạch; §5.4 quy định drill-down và ranh giới live.

## 3. Phân tích đặc tả Feasible STD và khoảng trống

### 3.1 Contract nghiệp vụ phải giữ

Theo §§1–5,7–9 của đặc tả:

- Mỗi chuyến **DEP active** là đúng **1 processing slot**, không dùng Pax/số ghế/số quầy làm trọng số; ARR không tính.
- Cửa sổ xử lý: `W(f) = [STD(f) − 180 phút, STD(f) − 50 phút)`, dài 130 phút. Dù đoạn mở đầu viết dấu đóng, pseudocode/SQL nhất quán dùng **start inclusive, end exclusive**; chọn chuẩn này và ghi rõ.
- `D(t) = count(f sao cho slot_start(f) <= t < slot_end(f))`.
- Với STD thử X: `M(X) = max D(t)` trên `[X−180, X−50)` **trước khi thêm chuyến thử**.
- `green` khi M<13; `amber` khi M=13; `red` khi M>13. `remaining=max(0,13−M)`.
- Với thêm đúng 1 chuyến: `projectedMax=M+1`, `canAddOne=(M+1<=13)`. M=12 vẫn xanh/có thể nhận nhưng sau thêm đạt 13; M=13 không nhận được. Không đổi màu theo projectedMax rồi gọi đó là status của đặc tả.
- Ngày VH d: `[d 05:00, d+1 05:00)` local. STD 01:30 ngày sau thuộc d; STD đúng 05:00 thuộc ngày mới. STD datetime ghép **scheduled_date + scheduled_time**, không ghép `operational_date + time`.
- Candidate chart mặc định `min_STD−30 → max_STD+30`, bước 5 phút; không phải toàn bộ ngày đều đã được xét. Box nhập STD ngoài range phải đánh giá riêng, không lấy “không có bar” làm xanh.
- Empty day: `data: []` và thông báo trống. Nếu box vẫn cho xét chuyến đầu tiên, phải phân biệt dữ liệu đầy đủ 0 chuyến với chưa tải/lỗi/không quyền.
- Chart là bar dọc, từng bar theo status, threshold dashed line; tooltip gồm STD **cả ngày**, window start/end, max demand, peak time, remaining và lý do không nhận.

### 3.2 Đánh giá thuật toán hiện có

| Module hiện hữu | Có thể reuse | Không được dùng thay engine STD |
|---|---|---|
| `operationalDashboardAnalysis.ts` | KPI, day/time basis và bucket data hiện hành | Count DEP trong bucket 30/60 phút không phải max demand của cửa sổ 130 phút |
| `checkinAllocation.ts:12–17,37–88` | Tham khảo half-open windows, datetime; có default −180/−50 | Phân bổ số quầy theo rules, lock/outage, grouped/broken; không phải 1 flight = 1 slot |
| `gateAllocation.ts` | Style/timeline resource UI nếu phù hợp | Gate/stand mapping và xung đột vật lý không chứng minh slot processing khả thi |
| `operationalScheduleContract.ts` / remoteStore | Active day-window query, snapshot/paging, cutoff/date presets | Adapter/render không tự tính M(X) |
| `SeasonalVersionChangesView.tsx` / diff formatters | Toàn bộ renderer Version Diff | Diff Added/Removed/Modified không phải capacity calculation |

**Cần code mới:** một module tính STD thuần độc lập và UI chart/assessment. Không cần dịch bảng MySQL `flights`/`time_grid` từ đặc tả thành bảng PostgreSQL thật khi nguồn lịch và index đã có.

### 3.3 Sai khác/điểm thiếu của đặc tả cần quyết định

1. **Lấy mẫu 5 phút có thể bỏ sót đỉnh tải.** Nếu giờ bay không nằm trên lưới, count tăng/giảm giữa hai tick. Ví dụ hai cohort 13 DEP có windows `[07:52,10:02)` và `[10:01,12:11)`: demand=26 trong 10:01–10:02 nhưng grid bắt đầu 07:52 bước 5 phút chỉ thấy tối đa 13. Một candidate window bao trùm đoạn đó có thể bị đánh giá nhẹ hơn thực tế. Đây là phản ví dụ phân tích, chưa chạy regression trong phiên khảo sát.
   - Khuyến nghị: STEP=5 để sinh candidate/render; tính max chính xác bằng event sweep trên start/end thực. Tại timestamp trùng nhau xử lý end trước start theo half-open interval. Đây là **hiệu chỉnh độ chính xác so với sampled pseudocode**, cần duyệt; không âm thầm thay spec.
   - Nếu bắt buộc parity sampled 5 phút: phải ghi rõ độ phân giải/không bảo đảm toàn cửa sổ; không gọi kết quả là cấp phép an toàn.
2. **Tải xuyên Ops Day:** SQL spec chỉ lấy DEP có `ops_date=d`; processing window thực có thể overlap chuyến ngày d−1/d+1. Ví dụ DEP 04:00 có window 01:00–03:10, DEP 05:30 ngày kế tiếp có window 02:30–04:40; hai chuyến thuộc hai Ops Day khác nhau nhưng tải overlap.
   - Khuyến nghị cho năng lực dùng chung: chọn candidate theo d, nhưng demand gồm mọi DEP **trong cùng nguồn kế hoạch đã chọn** có window overlap miền xét. Buffer tính từ params; không bù bằng Operations live hoặc linked peer tình cờ.
   - Nếu chọn đúng scope một ngày của spec, UI phải công bố chỉ xét cohort ngày đó; không ngụ ý capacity của toàn hệ thống xuyên ngày. Đây là lựa chọn bắt buộc trước implementation.
3. **SQL examples bị giới hạn demand grid bởi min/max hiện hữu** và inner join có thể bỏ candidate không có điểm/grid hoặc điểm demand=0. Engine phải bảo toàn đầy đủ candidate range, mặc định demand ngoài mọi window=0; không đánh rơi bar.
4. **Spec metadata tên `flight_date` nhưng API dùng `ops_date`; tooltip cần peak time nhưng response chưa có peak time từng candidate.** Contract mới dùng `opsDate`, `timezone`, bounds rõ ràng và thêm `peakAt`; không lấy HH:MM làm identity.
5. **OPS_DAY_START configurable trong spec nhưng hệ thống hardcode 05:00** ở nhiều helper/SQL. Không thêm option đổi cutoff trên riêng Dashboard. Bản đầu giữ 05:00; thay toàn cục là task khác cần migration/consumer parity.
6. **KPI Planning không phản ánh đã bay thực tế.** Bỏ Pax actual/coverage/missing và các cảnh báo chất lượng vận hành khỏi trang chính; giữ tổng chặng ARR/DEP, hãng, tuyến và ngày cao điểm theo nguồn kế hoạch. Không gán Pax planned thành actual.

## 4. Kiến trúc dữ liệu/API đề xuất

### 4.1 Tái sử dụng API hiện hành và phần cần nối thêm

| Nhu cầu | API/service hiện có | Quy tắc sử dụng |
|---|---|---|
| Draft cho KPI/tải/STD | `getSeasonalDraftWindowV1({seasonId, pageSize, afterDraftId, expectedEpoch, expectedRevision})` | Cursor theo draft ID; load đủ nguồn nhất quán epoch/revision rồi lọc ngày; API hiện không có date-range params, không bịa thêm tham số |
| Published source cho KPI/tải/STD | `getSeasonalPublishedSnapshotPageV1({versionId, afterDraftId, pageSize})` | Snapshot bất biến của đúng version; đủ pages, giữ scheduled date/time; không dùng runtime legs thay snapshot |
| Registry versions | `getSeasonalPublishVersionsV1({seasonId, afterSequence, pageSize})` | Cùng mùa context, cursor registry; không nạp toàn history upfront |
| Diff published | `getSeasonalVersionChangesPageV1(SeasonalVersionChangesInput)` → `get_seasonal_version_changes_page_v1` | `seasonal.read`; base null=liền trước; nhóm trước paging; không tự diff các trang đã tải |
| Diff Draft với published mới nhất | Có `previewSeasonalPublishV1` và `getSeasonalPublishPreviewPageV1`; payload có draftEpoch/revision/checksum/baseVersionId | Có sẵn Planning diff trong workflow Publish, nhưng preview còn gắn Operations/diagnostics/expiry. Cần tích hợp adapter/read contract phù hợp, không gọi preview tự động như một read widget vô điều kiện |
| Viewer diff/snapshot | `SeasonalVersionChangesView`, formatter và History snapshot viewer hiện hữu | Reuse renderer; bổ sung nguồn Draft có chủ đích, giữ History published không regression |
| Ngày/cutoff | `resolveOperationalDate`, `shiftVietnamIsoDate` và helpers Planning hiện hữu | Tính từ scheduled timestamp của kế hoạch; range mặc định start/end mùa. Ops Day chỉ là cách nhóm tải, không là nguồn runtime |
| Báo cáo hiện hữu | `TrafficReportModePanel` → `fetchTrafficReportV2Bundle` | Lối truy cập riêng/menu phụ, giữ nguồn canonical/freshness; không dùng làm KPI Planning |

Bằng chứng đọc bổ sung: `remoteStore.ts:279–342,920–975`; `seasonalPlanningContract.ts:16–96,126–156,172–271`. Audit Operations trước đó (`getOperationalScheduleAllocationWindowV1`, `loadFullOperationalScheduleWindow`) chỉ dùng bảo toàn Daily/Gantt; không là data path Planning Dashboard.

### 4.2 Invariants trên nguồn Planning

- Mọi result mang identity `{seasonId, sourceKind: draft|published, draftEpoch/revision hoặc versionId/checksum}`. KPI, chart và assessment chỉ dùng một identity; không trộn Draft/Published/Operations trong một result.
- Draft load phải pin epoch/revision xuyên cursor pages. Khi `snapshot_changed`, bỏ accumulation và reload theo pattern Planning hiện hữu; giới hạn retry, báo lỗi/stale nếu không hoàn tất. Không hiển thị partial season như dữ liệu đầy đủ.
- Published load đủ pages của cùng version; không dùng current draft khi snapshot thiếu/lỗi. Giữ published source immutable và read-only.
- Lọc status/tombstone theo contract từng nguồn trước aggregate. Normalize A/D và scheduled date/time thành input thuần; deduplicate theo draft/occurrence identity của snapshot, không theo flight number đơn độc. Codeshare không nhân thêm chuyến.
- Lọc KPI theo range được chọn; STD dùng cohort ngày và buffer xuyên ngày theo policy đã duyệt, **trong cùng nguồn**. Không lấy published của mùa bên cạnh hoặc runtime để bù data ngoài mùa ngầm định; biên mùa phải công bố scope/incomplete phù hợp.
- Khi Draft mutation/import/restore làm đổi revision, assessment cũ stale và phải tính lại. Đổi Daily/Manual runtime không được làm đổi Planning KPI/STD; Publish tạo version mới không tự chuyển selection đang xem.
- Không đọc SQLite AI temp view hoặc active Operations làm fallback. Thiếu quyền/gate/RPC Planning thì báo unavailable, không giả dữ liệu live là kế hoạch.
- Adapter Operational hiện có linked-peer/cancelled hazards đã khảo sát; không sửa mapper global của Daily/Gantt chỉ để đổi Dashboard sang Planning.

### 4.3 Data contract và vị trí logic mới

**Quyết định đề xuất:** giữ nguồn Draft/Published hiện hữu, normalize sang input STD thuần trong TypeScript; chưa tạo bảng time grid/Edge endpoint mới. Service data mỏng pin identity/complete dataset rồi gọi engine. Với full-season Draft/snapshot paging, phải đo payload/latency; chỉ bổ sung read RPC range có revision fence nếu số đo chứng minh cần, không dùng Operations day-window để né vấn đề.

Files mới dự kiến (chưa tạo):

- `app/src/lib/feasibleStdAnalysis.ts`: params, input/result types và core pure functions. Contract để trong cùng module này, không tách nhiều file chỉ một caller.
- `app/src/lib/feasibleStdAnalysis.test.ts`: regression cho boundaries/invariants chưa có coverage; không test source/wiring.
- Hook nạp dữ liệu Dashboard chỉ tạo nếu thực sự cần chia sẻ KPI/STD; ưu tiên pattern hooks hiện hữu. Không mở rộng remote API chỉ để forward local function.

Contract đề xuất:

- Input flight: `sourceRecordId` (draft/occurrence identity), `scheduledDate`, `scheduledTime` (giữ độ chính xác nguồn), `side`, `status`; normalize datetime local hoặc số thời gian tuyệt đối duy nhất. Không bắt Planning input mang Operational legId.
- Params: `slotBeforeMinutes=180`, `slotAfterMinutes=50`, `threshold=13`, `stepMinutes=5`, `stdRangeBufferMinutes=30`; `opsDayStart=05:00` cố định. Validate `before>after>=0`, threshold/step dương hữu hạn, miền xét có giới hạn trong source context.
- Metadata: `seasonId`, `sourceKind=draft|published`, draft epoch/revision hoặc versionId/checksum, `opsDate`, timezone, scope policy, source bounds/completeness, counted DEP, params, generatedAt, peakDemand/peakAt, invalid/excluded counts.
- Candidate row: `candidateStd`, `stdLabel`, `windowStart`, `windowEnd`, `maxDemand`, `peakAt`, `status`, `remaining`; assessment riêng có `projectedMax`, `canAddOne`.
- Dữ liệu lỗi timestamp hoặc incomplete phải hiển thị diagnostic, không thay bằng `00:00` rồi cho xanh. Empty dữ liệu hợp lệ khác unavailable/stale/loading/error.
- KPI, chart và box dùng cùng source identity/params. Đổi mùa/nguồn/day/revision vô hiệu assessment cũ; response cũ không overwrite selection mới, reset khi operator session đổi. Scope/cảnh báo luôn ghi “theo kế hoạch đang xét”.

Core algorithm sau khi chọn §8:

1. Chuẩn hóa/lọc active DEP, unique source record identity trong Draft/Published; ghép scheduled date/time, không dùng ops date để tạo STD.
2. Sinh event `+1` tại STD−before, `−1` tại STD−after; sort timestamp, half-open tie semantics; tạo các đoạn demand hằng.
3. Sinh candidate từ min/max ± buffer theo bước STEP đúng spec; retain full timestamps qua midnight. Không làm tròn âm thầm giờ nhập vào lưới.
4. Max trên toàn candidate window và peakAt; reuse segments, tránh quét toàn flight list cho mỗi tick. Với nhiều candidates tăng theo thời gian có thể sweep/deque thay vì nested flights × ticks × candidates. Chỉ tối ưu thêm khi có số đo.
5. Tính status/remaining và assessment +1. Nếu tương lai hỗ trợ dời chuyến, loại đúng leg đang dời trước assessment để tránh tự đếm; không đưa tính năng dời/auto-optimize vào bản này nếu chưa duyệt.
6. Derive bảng các **mốc STD trên lưới** liên tiếp cùng trạng thái, không gọi khoảng giữa hai mốc là đảm bảo liên tục. Input arbitrary STD phải đánh giá trực tiếp.

### 4.4 So sánh kế hoạch: Published và Draft

- Published target mặc định base liền trước; cho chọn published base khác cùng mùa. Reuse changes RPC/group paging/formatters; không mở cross-season comparison.
- Draft target mặc định base published mới nhất cùng mùa. Nếu chưa publish lần nào, dùng semantics Planning initial baseline với nhãn rõ, không gọi Draft là immutable version.
- `SeasonalVersionChangesView` hiện chỉ nhận published `versionId`, `disabled`, `versions`; **chưa phải viewer Draft**. Checklist tích hợp phải phân biệt data adapters Draft/Published nhưng share business renderer/formatter, không xây engine matching thứ hai hoặc forward fake versionId.
- Publish preview hiện có Planning counts/diff nhưng cũng tạo preview/đánh giá Operations/expiry và có thể yêu cầu quyền publish. Trước implementation phải xác minh quyền/side effects/cost; nếu không phù hợp read-only `seasonal.read`, bổ sung read-only Draft comparison contract reuse Planning diff logic. Không gọi commit Publish hoặc lách quyền để nạp widget.
- Draft diff pin epoch/revision/checksum/baseVersionId khớp source overview; draft hoặc latest base đổi thì invalidation/reload, không hiển thị summary từ preview cũ như current. Quyền đọc Dashboard không mặc nhiên cấp quyền tạo preview/write.
- Summary toàn comparison khác filtered groups/occurrences; range header và filter diff có nhãn phạm vi rõ. Thanh summary ở Tổng quan và full viewer ở Thay đổi dùng cùng cặp/identity.
- Diff row operational_date dùng cutoff05:00; Before/After có scheduled date. Nhãn phân biệt ngày lịch với ngày nhóm tải khi shift ngày/giờ.
- No/one version/no permission/blocked preview là trạng thái có UI đúng. Draft diff chưa available không cản KPI/STD đọc Draft; phải nêu nguyên nhân, không thay bằng published diff khác.
- Published Planning không đồng nhất Operations live vì Daily authority/manual/skipped days. STD trên published source chỉ đánh giá snapshot đó; không ngụ ý runtime capacity hoặc tự sửa version bất biến.

## 5. Component / State Architecture

### 5.1 Layout: hai tab chính

Header chung: **Mùa → Draft / Published version → Khoảng ngày**, mặc định phạm vi mùa; nhãn nguồn/revision và action mở chi tiết/xuất đúng nguồn. Không thêm selector mùa riêng cho mỗi widget.

| Tab / thứ tự | Nội dung | Nguyên tắc gọn |
|---|---|---|
| Tổng quan kế hoạch — 1 | Một hàng KPI: tổng chặng kèm ARR/DEP, số hãng, số tuyến, ngày cao điểm | Cùng source/range; bỏ Pax thực tế, coverage/missing, alert chất lượng runtime |
| Tổng quan kế hoạch — 2 | Tải theo giờ và STD khả thi của ngày chọn; chart rộng + box “Xét khả năng thêm chuyến” bên cạnh | Ngày xét trong range; không hiển thị hai timeline ARR/DEP + heatmap tháng + full diff cùng lúc |
| Tổng quan kế hoạch — 3 | Thanh summary nguồn đang xem ↔ base, Added/Modified/Removed, nút “Xem thay đổi” | Chuyển tab Thay đổi, không thêm bảng diff mini khó bảo trì |
| Thay đổi kế hoạch | Chọn base, summary và full shared diff viewer nhóm/ngày; Before/After khi mở dòng | Technical payload mặc định đóng; Draft adapter và published adapter phân biệt |

Bảng mốc STD/danh sách chuyến gây peak mở khi cần, không mặc định chiếm thêm một màn hình dài. Timeline khai thác kế hoạch chỉ mở khi cần; threshold slot khác peak bucket. Chart click điền **full datetime** vào box; khi xem version cũ chỉ mô phỏng.

Report/Comparison sản lượng tiếp tục truy cập trong không gian báo cáo riêng hoặc menu phụ được duyệt, không thêm tab thứ ba/thứ tư trong Dashboard Planning. Không xóa logic/export chưa có nơi thay thế. Không giữ AI tab disabled/placeholder.

### 5.2 Ranh giới components dự kiến

Ưu tiên dùng helpers/components đã có; các tên mới dưới đây là đề xuất cho phần UI chưa tồn tại, không phải file đã tạo.

- `dashboard/page.tsx`: orchestration, navigation và quyền; không chứa thuật toán STD/AI.
- `PlanningOverview.tsx`: KPI tổng chặng/ARR/DEP/hãng/tuyến/ngày cao điểm và tải kế hoạch. Tái dùng helper aggregation hiện có khi semantics phù hợp, không dùng nguyên `buildOperationalDashboard` đem Pax coverage/alert runtime sang Planning.
- `PlanningChangesPanel.tsx`: source/base adapter Draft hoặc Published và registry; reuse `SeasonalVersionChangesView`/business renderer hiện hữu với mở rộng nhỏ có chủ đích, vùng height/scroll hữu hạn.
- `FeasibleStdPanel.tsx`: params, biểu đồ/bảng candidate và source state; reuse Recharts đang cài. Table là alternate interaction/detail, không xây một engine thứ hai.
- `NewFlightFeasibilityBox.tsx`: input candidate và assessment; chia file vì có form/validation riêng. Không gọi mutate/publish từ nút “Xét”.

Nếu vùng KPI nhỏ và chỉ dùng tại page, có thể giữ markup trực tiếp thay vì tạo component chỉ forward props. Không thêm chart dependency mới.

### 5.3 State và quyền

- Planning context: seasonId, sourceKind, selected published versionId hoặc draft epoch/revision, rangeStart/rangeEnd; default Draft và range mùa. Đổi mùa reset version/base sang giá trị cùng mùa và revalidate range/day; đổi source giữ range nếu hợp lệ nhưng luôn vô hiệu assessment cũ.
- Comparison state: base published cùng mùa, registry cursor và load/expiry state; không đổi source KPI/STD. Hai tab chia sẻ cặp so sánh, không tạo hai requests/summary độc lập mâu thuẫn.
- Feasibility state: selected opsDate trong range + params + candidate input; result keyed theo source identity/scope/params. Chọn ngày trong dataset đầy đủ không refetch toàn nguồn; không serialize full flights vào localStorage.
- Permission: `seasonal.read` cho Planning overview/snapshot/published diff; xác minh quyền Draft comparison riêng trước triển khai. `daily.read` không là điều kiện vào Planning; `seasonal.write` chỉ cho luồng sửa draft hiện hữu, không được cấp bởi assessment.
- Session modes cũ operations/report/comparison/ai-workspace được chuyển có chủ đích về Planning tab hợp lệ hoặc lối báo cáo riêng; không hydrate notebook AI. Giữ auth/journal data, cleanup notebook theo chính sách đã duyệt.
- Realtime/manual refresh Draft: reuse Planning/session fences; stale assessment phải tính lại. Version đã chọn bất biến không chạy theo runtime notifications; Published registry có version mới không tự đổi baseline.
- Kiểm UI tối thiểu 1024×700 (min window Tauri hiện hành), 1440×900, light/dark; filter không bị tràn, từng panel scroll rõ; màu có label/icon, keyboard/tooltip focus được.

### 5.4 Điều hướng và action theo nguồn

| Thao tác | Draft hiện hành | Published version |
|---|---|---|
| Click/double-click ngày/tải để drill-down | Detailed đúng season/ngày, giữ context Draft; dùng route/controls hiện hữu | Snapshot viewer read-only đúng version/ngày; không mở Detailed current draft rồi ngụ ý cùng phiên bản |
| Xét khả năng thêm chuyến | Mô phỏng trên Draft, không ghi dữ liệu | Mô phỏng trên snapshot, không sửa version |
| Muốn thêm/sửa thật | Mở luồng tạo/sửa Planning draft hiện hữu, quyền seasonal.write; sau mutation tính lại | Chuyển có chủ đích về Draft; không tự restore/copy snapshot hoặc Publish |
| Daily/Gate/Check-in | Truy cập từ sidebar Operations | Truy cập từ sidebar Operations |

Bỏ action chính và double-click kế hoạch → Daily live. Action phụ “Mở vận hành ngày này” chỉ bổ sung nếu được duyệt, ghi rõ **dữ liệu vận hành hiện hành, không phải kế hoạch đang xem**, chỉ truyền ngày và kiểm daily.read; không truyền version/season để giả scope runtime. Planning vẫn dùng được khi không có daily.read. Xem §8 cho lối truy cập báo cáo phụ.


## 6. Step-by-Step Execution Plan

### Gate G0 — trước khi code

- [ ] G0.1 Ghi nhận hướng đã cập nhật: Planning Dashboard, Draft mặc định, hai tab và drill-down đúng nguồn. Duyệt quyết định còn mở §8: xuyên ngày, exact/sampled, params, lối báo cáo và action live phụ.
- [ ] G0.2 Chụp revision/config/runtime baseline đúng app, Node/Rust target, feature gates và artifact; không dùng NSIS 0.1.10 so với source 0.1.33.
- [ ] G0.3 Có staging/disposable DB/RPC cần thiết và operator test đúng quyền; không bật production native gate như một phần Dashboard redesign.
- [ ] G0.4 Nếu cần xóa notebook/retire server AI/key: chốt backup/retention/consumer ownership riêng trước hành động dữ liệu.

### Phase 1 — Clean-up Sidecar và AI Workspace

Thứ tự dưới đây cắt callers trước dependency; mỗi cụm giữ source/build nhất quán. Đây là clean cutover, không để shim/no-op AI.

- [ ] P1.1 Tách export contracts đang import lib AI sang contract nghiệp vụ trong module hiện hữu; bảo toàn exports Excel đang có consumer.
- [ ] P1.2 Bỏ Dashboard AI tab/state/effects/submission/UI và Settings AI tab/state/key handlers; resolver persisted view/tab cũ về valid defaults. Chưa redesign KPI ở bước này.
- [ ] P1.3 Gỡ AI types/defaults/normalizers và persistence Desktop trong `types`, `settingsRules`, mappers, Supabase store; cập nhật mọi constructor/caller/test. Chứng minh save settings không-AI **không ghi/xóa** model/context/key AI server.
- [ ] P1.4 Gỡ native TS wrappers/re-exports/DTOs, Rust command registrations/state/health/proxy/provider-key/SQL AI-only helpers và AI fixtures/tests. Giữ native catchup/network/session/export.
- [ ] P1.5 Đổi `beforeBuildCommand` thành `npm run build`; bỏ externalBin AI, shell plugin import/init/dependency; giữ capabilities không-AI và updater/process/single-instance.
- [ ] P1.6 Đồng bộ release workflow và test harness: bỏ Python setup/install/test, AI module loads/reads/source assertions. Bỏ source/wording tests không còn contract nghiệp vụ, không repin chúng theo layout mới; giữ behavioral suites không-AI.
- [ ] P1.7 Xóa đúng files §2.2; bỏ scripts Python/Skawld và devDependencies độc quyền; cập nhật npm/Cargo lockfile bằng toolchain. Không uninstall package Python toàn máy.
- [ ] P1.8 Cập nhật hướng dẫn native build và ignore riêng sidecar; kiểm reference/import/IPC graph không còn active Desktop AI path; backend/historical docs retained được phân loại rõ, không bắt “AI” bằng 0 trên toàn repo.
- [ ] P1.9 Verify TypeScript/lint/Rust, rule regressions và native build không Python. Launch Tauri, đăng nhập, đóng/mở và export file; không spawn/listen localhost AI.

**Exit Phase 1:** Desktop hết AI UI/invokes/binary/build requirement; settings/export/sync/updater hoạt động; không có requirement cài Python cho installer hoặc CI Desktop.

### Phase 2 — Core Logic & Data Integration

- [ ] P2.1 Định nghĩa source adapters Draft/Published + STD params/input/result theo §3–4; pin season/source epoch-revision/version-checksum, khóa day/sampling policy; phân biệt loading/error/empty/incomplete/stale.
- [ ] P2.2 Viết regression core cho half-open/start/end, 12/13/14, crossing midnight/cutoff, off-grid peaks, empty/one-flight và không đếm trial hai lần.
- [ ] P2.3 Implement core `feasibleStdAnalysis.ts`, dùng event segments nếu đã duyệt exact max; retain full candidate range ±30 và arbitrary candidate assessment.
- [ ] P2.4 Nối Draft window và published snapshot APIs; load complete source với epoch/revision hoặc immutable version fence; source identity/datetime filter/dedupe, buffer trong cùng kế hoạch. Không dùng Operations day-window làm fallback.
- [ ] P2.5 Share source cho KPI/tải/STD, không đem Pax coverage/alert runtime sang Planning. Test ngày giáp biên mùa: không bù bằng runtime/mùa khác; incomplete theo policy phải rõ, không cho xanh giả.
- [ ] P2.6 Nối published registry/diff viewer; bổ sung Draft-vs-latest adapter reuse Planning diff. Xác minh Publish preview quyền/side effects/expiry; nếu không phù hợp, bổ sung read-only comparison contract không ghi preview/Operations. Kiểm no/one version, Draft initial baseline và stale revisions.
- [ ] P2.7 Smoke fixture disposable/RPC thật: Draft edit/import/restore làm result đổi; published source giữ immutable; Daily/Manual runtime không đổi Planning result. Đo full-season paging/payload/latency trước khi quyết định range read RPC riêng.

**Exit Phase 2:** Core đúng contract đã duyệt, không mixed snapshot; diff reuse engine hiện hữu; assessment trace được source/scope/revision.

### Phase 3 — UI Redesign

- [ ] P3.1 Dựng hai tab Tổng quan kế hoạch / Thay đổi kế hoạch và header mùa/nguồn/range thống nhất; Draft mặc định; đổi mùa/nguồn revalidate dates và clear assessment.
- [ ] P3.2 Dựng một hàng KPI tổng chặng/ARR-DEP/hãng/tuyến/ngày cao điểm, tải kế hoạch mở khi cần; bỏ runtime Pax/alerts và Daily double-click. Draft drill-down Detailed đúng mùa; published drill-down snapshot đúng version. Bảo toàn Report/Comparison/export qua lối truy cập riêng/menu phụ.
- [ ] P3.3 Dựng thanh diff summary trên Tổng quan và full shared viewer trên Thay đổi; hỗ trợ Draft-vs-latest + Published-vs-previous/custom cùng mùa. Kiểm source/base/revision thống nhất và History published không regression.
- [ ] P3.4 Dựng Feasible STD bar chart bằng Recharts, threshold dashed line/labels, tooltip ngày/giờ/window/peak/remaining, zero-demand/empty states và bảng candidate.
- [ ] P3.5 Dựng box “Xét khả năng thêm chuyến”; chart click điền full datetime, arbitrary STD đánh giá trực tiếp; đổi source/params vô hiệu result; không mutate. Action mở tạo Draft dùng workflow hiện hữu, published chỉ mô phỏng/read-only.
- [ ] P3.6 Verify UI Tauri/WebView2 thật với auth staging: 1024×700/1440×900, light/dark, scroll/keyboard, loading/error/stale, đổi nhanh ngày/version/session. Không coi browser harness giả native là nghiệm thu Desktop.

**Exit Phase 3:** Hai tab gọn, KPI/tải/STD/diff dùng đúng nguồn Planning, drill-down đúng Draft/Version; Daily/Gate/Check-in giữ không gian Operations, không có chuyển live ngầm định.

### Phase 4 — Verification & Packaging

- [ ] P4.1 Chạy matrix §7 bằng toolchain cùng môi trường trước/sau; dọn throwaway probes sau khi có evidence, giữ behavioral regression cần thiết.
- [ ] P4.2 Full native signed build Windows x64 NSIS với environment/public keys đúng, build không Python; kiểm app identifier/updater artifact/signature/latest.json không đổi ngoài version release được duyệt.
- [ ] P4.3 Đo installer bytes, main EXE bytes, installed app footprint, frontend chunks và CI durations; so hai build cùng toolchain/config/signing/compression; giữ baseline và after artifacts tách biệt.
- [ ] P4.4 Clean install và upgrade từ bản có sidecar: không còn sidecar mới; kiểm file sidecar cũ/process mồ côi có được installer dọn không. Nếu còn, xử lý đúng path thuộc app và duyệt uninstall cleanup; không xóa process/file tùy tiện theo tên.
- [ ] P4.5 Launch bản đóng gói trên máy không cài Python; nghiệm thu login, Overview/Diff/STD, Daily/Gate/Check-in, Excel/PDF, sync/retry/recovery và updater. Đóng app không để lại process AI.
- [ ] P4.6 Đối chiếu Report/Annual KPI contracts và Import/Export trước/sau; không deploy backend retirement hay production cutover cùng release nếu chưa duyệt riêng.
- [ ] P4.7 Ghi kết quả/SLO thực tế và release notes; các failure/blocker phải xử lý trước sign-off. Không đánh dấu hoàn thành bằng compile-only.

**Exit Phase 4:** Deliverable chạy end-to-end trong bản NSIS; số đo packsize có evidence và không còn sidecar; các consumer không-AI giữ hành vi.

### 6.1 Lệnh verify dự kiến, chỉ chạy sau khi phê duyệt

Working directory cho npm: `app/`; cho Cargo dùng manifest path tương ứng. Những lệnh dưới đây **chưa chạy trong phiên lập kế hoạch**.

```powershell
# Frontend/static export
npx tsc --noEmit
npm run lint
npm run test:rules
npm run test:dashboard-contract
npm run test:updater
npm run build

# Native compile/test/build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run native:build

# Existing data safety suites
npm run test:seasonal-operational-m4-window
npm run test:seasonal-operational-m6-planning
npm run test:seasonal-operational-m7-publish
npm run test:seasonal-operational-m9-schedule
npm run test:traffic-report-contract
node supabase/tests/seasonal_version_changes_pglite.mjs
node supabase/tests/seasonal_snapshot_integrity_indexed_pglite.mjs
node supabase/tests/seasonal_version_management_pglite.mjs

# New core regression, file chỉ tạo trong Phase 2
node --experimental-strip-types --test src/lib/feasibleStdAnalysis.test.ts

# Smoke shell thật và dữ liệu staging; sau đó smoke installer packaged
npm run native:dev
```

Các suite cần fixture/disposable DB phải chuẩn bị đúng environment trước, không trỏ test vào production. `test:dashboard-contract`/`test:rules` cần dọn AI/source assertions ở Phase 1 trước khi kỳ vọng pass. Kiểm export Imports/Daily/PDF bằng workbook và UI thật, không chỉ các lệnh compile ở trên.

## 7. Risks & Acceptance Criteria

### 7.1 Ma trận rủi ro

| Rủi ro | Evidence/Nguyên nhân | Kiểm soát/tiêu chí |
|---|---|---|
| Xóa AI lib làm gãy export | Type import trong `dashboardReportExport.ts` | Tách type + migrate callers trước; workbook nội dung/format giữ nguyên |
| Lưu settings xóa model AI server | `supabaseStore.ts:817–818` replace rows | Cắt writer AI, không gửi empty replacements; probe giữ nguyên server rows |
| Bỏ shell plugin làm gãy native startup | Rust `.manage/.plugin/generate_handler` còn AI | Atomic command/TS/config/dependency cutover, Rust compile + launch thật |
| Xóa reqwest/SQLite/PDF nhầm | Dependency dùng chung native catchup/PDF | Giữ như §2.4; smoke sync/export/open/reveal/upgrade |
| Test/CI vẫn readFile file đã xóa | Rule/source tests và Python steps | Bỏ block AI và load list, giữ regression nghiệp vụ; CI sạch không Python |
| Đếm sai nguồn/identity/status | Planning draft/snapshot khác Operational leg DTO; tombstones/codeshare | Source-specific normalization, unique draft/occurrence identity, complete paging; không fallback runtime |
| Đánh giá slot xanh sai | 5-minute sampling/off-grid hoặc thiếu ngày hàng xóm | Duyệt exact/scope; test peak giữa tick + incomplete fail-closed |
| Lệch ngày/timezone | ghép ops_date với STD/UTC OS | Full scheduled datetime, explicit Asia/Ho_Chi_Minh; test midnight/05:00 |
| Trộn revisions hoặc response cũ | Paging/realtime/day-version switch | Snapshot fences, complete result, request/session cancellation/fencing |
| Nhầm Planning với runtime hoặc sai drill-down | Daily authority/manual/skipped publish; Detailed current khác version cũ | Không tự mở Daily từ biểu đồ; Draft→Detailed, Published→snapshot; nhãn nguồn rõ |
| Draft diff widget đòi quyền/side effect Publish | Existing preview gắn Operations, expiry và preview storage | Read-only adapter/contract reuse Planning diff; không lách quyền hoặc gọi commit; match overview revision |
| “Approve” ghi lịch không atomic | Spec chỉ assessment, không workflow | Read-only mặc định; nếu duyệt write thì thiết kế permission/stale/receipt/publish riêng |
| Không giảm packsize như dự đoán | Compression/old baseline/dev-only deps | Đo cùng build; không cam kết số installer từ binary thô |
| Upgrade còn sidecar cũ | Artifact/file/process từ bản trước | Clean install + upgrade smoke, app-scoped uninstall cleanup nếu cần |
| Public report bị ảnh hưởng | Shared app/SQL/settings/types | No-change boundaries + Report/KPI/input-output parity |

### 7.2 Acceptance — Sidecar/AI removal

- [ ] Không AI Workspace/AI settings UI, active imports, native AI commands, localhost AI call/process hoặc key synchronization từ Desktop.
- [ ] Không sidecar binary trong fresh bundle/install; Windows build/CI và máy chạy app không cần Python/PyInstaller.
- [ ] `npm ci`, frontend build/type/lint và native Cargo/NSIS không phụ thuộc AI scripts đã xóa; lockfiles đồng bộ, không dangling command registrations.
- [ ] Native sync/session cleanup/single-instance/updater và save/open/reveal export hoạt động; Excel/PDF Daily/Seasonal/Gate/Check-in giữ template.
- [ ] Operational settings không-AI load/save đúng và không xóa/chỉnh server AI keys/models/context; không thay Auth/RLS/User roles dùng chung.
- [ ] Có số đo before/after installer/installed footprint cùng điều kiện; không coi giảm node_modules là giảm installer.

### 7.3 Acceptance — Core STD

- [ ] Half-open: chuyến bắt đầu đúng t được đếm, kết thúc đúng t không đếm; end/start trùng nhau không sinh peak giả.
- [ ] M=0/12/13/14 lần lượt status green/green/amber/red; remaining 13/1/0/0; trial 1 chuyến cho projected 1/13/14/15 và canAddOne true/true/false/false.
- [ ] Arrival/cancelled/deleted/codeshare duplicate không làm tăng demand; active DEP dù chưa gán quầy vẫn đếm 1.
- [ ] Window dùng −180/−50, không lấy check-in edits hoặc số quầy/Pax thay công thức.
- [ ] STD 00:00/01:30/04:59 ngày sau và 05:00 ngày mới phân Ops Day chính xác; full timestamp ổn định qua tháng/năm, local/UTC presentation không đổi result.
- [ ] Off-grid peak regression §3.3 đạt policy đã duyệt; candidate nằm ngoài sampled grid/window còn có result đúng; không drop bar demand=0.
- [ ] Empty complete day chart rỗng; unavailable/incomplete/error không biến thành empty xanh; single flight có đủ ±30-minute range.
- [ ] Input STD ngoài chart/không chia hết STEP không làm tròn ngầm, kiểm trực tiếp; peakAt xác định tie rule ổn định.
- [ ] Thay threshold/before/after/step hợp lệ recalculation đúng; invalid params không làm loop vô hạn hoặc query không bounded.
- [ ] Nếu duyệt cross-day, overlap DEP d−1/d+1 tính đúng với query buffer đầy đủ; nếu day-only, scope limit được hiển thị rõ.
- [ ] Draft epoch/revision đổi trong paging không tạo partial/mixed counts; published pages cùng immutable version; buffer trong cùng source, không thêm runtime hay nguồn mùa khác ngầm định.

### 7.4 Acceptance — Dashboard/Version Diff

- [ ] Draft mặc định; chọn mùa/nguồn/range thống nhất cho KPI/tải/STD; KPI đúng tổng chặng/ARR-DEP/hãng/tuyến/ngày cao điểm, không Pax coverage runtime. Planning hoạt động với seasonal.read mà không cần daily.read.
- [ ] Published latest/previous/custom dùng existing engine; Draft-vs-latest reuse Planning diff với read permission/epoch-revision/base/expiry fence phù hợp. Nhóm toàn comparison trước paging, summary vs filter rõ; business table không lộ technical IDs.
- [ ] Kiểm fixture đủ >1 page và nhiều ngày gián đoạn: 50→100→124 changes, 26 lượt chặng→6 nhóm nếu fixture staging còn giữ; không yêu cầu những số này trên dữ liệu thực khác.
- [ ] Target/base/date/search đổi nhanh và logout/login không dùng kết quả phiên/session cũ; no versions/one version/no permission/transport error có UI đúng.
- [ ] Tooltip/bảng/day input phân ngày lịch và Ops Day; selected bar điền đúng ngày sau midnight; không dùng HH:MM đơn độc làm row key.
- [ ] “Xét” không tạo draft/Operational leg/Publish/approval record khi chưa có quyết định write workflow; thông báo là capacity assessment, không phải slot approval.
- [ ] Draft drill-down mở Detailed đúng mùa/ngày; published drill-down mở snapshot đúng version, không Detailed current/ Daily live. Sidebar Daily/Gate/Check-in, báo cáo/export riêng và History vẫn hoạt động; Import/Export, Daily authority và Public Report/Annual KPI không drift.
- [ ] Nghiệm thu layout bằng Tauri thật và bản đóng gói, không chỉ web component test; đủ loading/error/stale/empty/keyboard/light-dark.
- [ ] Hai tab Tổng quan/Thay đổi giữ layout gọn: một hàng KPI, chart+assessment, summary thay cho full diff trên Tổng quan; table/peak detail mở khi cần. Đổi Daily/Manual runtime không làm thay đổi kết quả Planning; đổi Draft revision làm stale và tính lại.

## 8. Câu hỏi cần làm rõ trước khi triển khai

Hướng Planning-only, Draft mặc định, hai tab và điều hướng đúng nguồn đã được đưa vào kế hoạch theo review. Bảng ghi rõ phần đã chốt và lựa chọn còn mở; cập nhật tài liệu không đồng nghĩa cho phép bắt đầu code.

| ID | Cần quyết định | Phương án khuyến nghị và hệ quả |
|---|---|---|
| Q1 — Đã chốt hướng | Nguồn Dashboard | **Draft mặc định / Published version cụ thể**, cùng nguồn cho KPI/tải/STD; Operations live không là baseline hoặc fallback |
| Q2 — Còn mở | Demand chỉ cohort một Ops Day hay mọi processing window overlap xuyên ngày? | **Overlap xuyên ngày trong cùng nguồn kế hoạch**, candidate ngày đang xét; biên mùa công bố scope/incomplete, không bù runtime |
| Q3 | Max demand phải chính xác mọi thời điểm hay sampled 5 phút? | **Exact event sweep**, STEP5 chỉ là candidate/display. Sampled parity cần công bố có thể bỏ sót peak và không dùng như phê duyệt an toàn |
| Q4 — Đã cập nhật | “Xét khả năng thêm chuyến” và action ghi | **Mô phỏng read-only**, không approval/Operational write/Publish. Muốn thêm thật dùng luồng tạo Planning draft hiện hữu; version cũ không sửa trực tiếp |
| Q5 | THRESHOLD13 và offsets180/50 cố định hay cho planner chỉnh? Lưu toàn app hay chỉ scenario? | **Defaults theo spec, điều chỉnh scenario rõ nhãn**, không lấy threshold alert 30/60 phút. Persist shared settings cần quyền/contract/RPC mới và migration riêng; cutoff05:00 giữ cố định |
| Q6 — Còn chốt lối truy cập | Report/Comparison sản lượng đặt ở đâu ngoài hai tab chính? | Giữ logic/export ở **không gian báo cáo riêng hoặc menu phụ**; không thêm tab Planning thứ ba. Chọn lối truy cập trước cutover, không xóa tính năng |
| Q7 | Có cần bỏ toàn bộ AI backend và dữ liệu notebook/key/models đã lưu không? | **Gỡ sạch Desktop**, giữ DB/migration/Edge server không đóng gói; retire backend/secrets riêng sau consumer audit. Notebook cũ export/retention theo người dùng trước cleanup |
| Q8 — Đã cập nhật phạm vi | So sánh nguồn kế hoạch | **Draft-vs-latest published và Published-vs-previous/custom cùng mùa**; Draft adapter cần xác minh contract read-only/preview. Cross-season/draft-vs-runtime ngoài phạm vi |
| Q9 | Candidate chart chỉ min/max±30 theo spec hay toàn ngày05:00→05:00? | **Min/max±30** đúng spec, box kiểm arbitrary STD; nếu toàn ngày thì thay range/empty-day contract có chủ đích. Không tự gọi lưới 5 phút là khoảng liên tục đảm bảo |
| Q10 | Ngưỡng chấp nhận latency/packsize là gì, máy/workload nghiệm thu nào? | Chốt bằng baseline cùng revision + workload ngày thực; **không đặt phần trăm giảm installer/SLO giả** từ artifact35,554MiB |
| Q11 — Còn mở, không mặc định thêm | Có cần action phụ “Mở vận hành ngày này”? | Mặc định chỉ sidebar Operations. Nếu thêm menu phụ, ghi nhãn live khác source kế hoạch, chỉ truyền ngày và kiểm daily.read; không là drill-down chính |

## 9. Hồ sơ nghiệm thu cần bàn giao sau code

1. File inventory đã xóa/sửa và dependency graph sau cutover; backend/shared retained list có lý do.
2. Hướng Planning cập nhật và quyết định còn mở Q1–Q11, contract STD/Draft comparison cuối cùng; ghi rõ khác biệt được duyệt so với spec1.0.
3. Log verify thực chạy, fixture scope, ảnh/video Tauri theo ngày/version/assessment, evidence packaged app không Python/sidecar.
4. Before/after artifact sizes + toolchain/revision/config/signing, install/upgrade test; không suy diễn production từ local.
5. Report/Import/Export/Publish/sync/updater no-regression evidence; release notes và hướng dẫn sử dụng mới.

**Giai đoạn lập kế hoạch đã kết thúc; triển khai local được ghi nhận dưới đây. Không suy diễn kết quả local thành nghiệm thu Production.**

## 10. Kết quả triển khai và kiểm chứng local — 2026-10-12

### 10.1 Phạm vi đã triển khai

- Desktop: bỏ AI Workspace/AI Settings, TS IPC và Rust AI handlers/helpers, Python sidecar, shell plugin, scripts/dependencies độc quyền và Python CI/build hooks. Giữ backend AI, lịch sử SQL, Auth/RLS, native catchup và các dependency dùng chung.
- Planning Dashboard: Draft mặc định; Published là snapshot của version cụ thể. Hai tab Tổng quan/Thay đổi; KPI/chart/assessment cùng nguồn, full paging có epoch/revision hoặc version/checksum fence. Diff summary mang comparison identity; không hiện summary Draft cũ khi chuyển Published.
- STD: exact event sweep, half-open −180/−50, ngưỡng13; bước5 chỉ sinh candidate từ min_STD−30, không làm tròn gốc lưới hoặc STD nhập tự do. Demand xuyên ngày trong cùng nguồn; cutoff05:00. Assessment cũ bị vô hiệu khi đổi ngày/input/params/nguồn; refresh Planning tái dùng workspace change hook.
- Draft drill-down tới Detailed đúng mùa/ngày; Published mở viewer History đúng version ở chế độ read-only, không rehydrate/ghi restore journal. Sidebar Operations giữ nguyên. Reports/Comparison có route riêng `/reports` và giữ nguồn runtime/canonical.
- Export Seasonal vẫn25 cột. Workbook Comparison giữ Summary/Drivers/Waterfall/Selected Records; worksheet metadata AI-only đổi thành `Export Notes`, bỏ dòng placeholder “Latest AI Answer”. Template import/export lịch bay không đổi.
- Thêm read-only RPC `get_seasonal_draft_changes_page_v1`, reuse Planning diff engine, cùng migration/rollback `app/supabase/migrations/20261012140000_seasonal_draft_changes_v1*.sql`. Chỉ áp dụng vào fixture disposable trong phiên này; chưa migrate server.

### 10.2 Kiểm chứng đã chạy

| Kiểm chứng | Kết quả quan sát |
|---|---|
| Signed native build | `npm run native:build` thành công: Next static export, TypeScript, Rust release, Windows x64 NSIS và chữ ký updater `.sig`; build hook không Python |
| Lint các file UI/core/export mới hoặc sửa cho Dashboard | Pass; không disable rule hay dùng microtask để né lint |
| Core STD + source adapters | 21 tests pass: half-open, 12/13/14, off-grid peak, xuyên ngày, cutoff, codeshare/status, malformed input, paging/revision/checksum/cursor |
| Settings access | 3 tests pass: quyền Repair và chuyển tab AI/unknown cũ về tab hợp lệ |
| Dashboard/report workbook | 18 tests pass; workbook giữ tổng kỳ và driver values |
| Updater contract | 8 tests pass; không đồng nghĩa đã thực hiện live upgrade |
| Native catchup | 54 tests pass: session/recovery/catchup không-AI |
| Draft comparison SQL | `seasonal_draft_changes_pglite.mjs`: toàn bộ behavioral checks pass |
| Separation M0 | Baseline khớp: effective12, canonical8, quarantine1, export W26=8/M26=3, window5 |
| Public Traffic Report / Annual KPI | `test:traffic-report-contract` pass: 71 Node tests và SQL/Edge/isolation checks |

Smoke chạy **EXE giải nén trực tiếp từ NSIS cuối**, trong WebView2 thật, với SQL PGlite thật qua HTTP fixture local; không dùng giả native IPC. Quan sát:

- Draft45 chặng: ARR3/DEP42, hãng2/tuyến2; diff1 chặng sửa `12:10 → 09:32`. Published vẫn giữ snapshot gốc45 chặng; so lần công bố đầu cho45 added. Chuyển nguồn không giữ summary Draft cũ.
- Click cột STD điền `2026-10-26T09:02`: M8, projected9, có thể nhận. Input phút lẻ `11:03`: M13, projected14, không thể nhận. Đổi ngày xóa kết quả cũ; Làm mới hoàn tất và trả lại dữ liệu fenced.
- Scenario input trên native giữ `before>after>=0`: thử before10/after50 được chặn tại51/50; thử after200 khi before51 giữafter50; after0 và before10 hợp lệ; Reset trả180/50. Dashboard không crash và console không ghi lỗi trong smoke tham số cuối.
- Draft mở `/detailed?season=…&date=2026-10-26`; Published viewer hiển thị45/45 và nút Restore bị khóa.
- Xuất snapshot thật vào Downloads rồi đọc workbook:25 cột,15 pattern rows cho45 chặng/ngày. Xuất Comparison thật: current32/previous0/delta32, đúng nguồn runtime khác Planning45; workbook cuối có `Export Notes`. SanLuong workbook cũng được lưu thật.
- Layout1440×900 và1024×700: đã sửa tràn ngang; cả document/main không overflow. Dark styles được kiểm bằng class `dark` trên DOM native; không coi đây là kiểm thử cơ chế chọn theme toàn ứng dụng.
- Trace fixture không có mutation RPC trong các thao tác Dashboard/Xét/History snapshot/export. Fixture không có Traffic Report Edge endpoint nên không tuyên bố panel Traffic đã smoke end-to-end; contracts/SQL/Edge tests của panel đã pass.

### 10.3 Số đo packsize

Baseline được build từ revision `ed555a831153b1c41842e1bc82bf730910862631`, cùng version0.1.33, Node24.15.0, Rust1.95.0 và cấu hình NSIS local. Chữ ký updater là artifact ngoài installer; baseline ban đầu dừng ở bước ký do thiếu environment key nhưng container NSIS đã tạo. Build cuối ký updater thành công; không tuyên bố Authenticode Windows.

| Artifact | Trước (bytes) | Sau (bytes) |
|---|---:|---:|
| NSIS installer | 44,072,474 | 6,155,705 |
| Main EXE | 22,263,296 | 19,551,744 |
| Python sidecar trong NSIS | 37,433,200 | 0 |
| Payload main EXE + sidecar giải nén | 59,696,496 | 19,551,744 |
| Frontend static output | 6,595,325 | 6,450,317 |

Installer giảm **86,03%**:42,03MiB →5,87MiB. Payload giải nén không phải tổng installed footprint: chưa gồm uninstaller/WebView2/user data. Đã inspect cả hai NSIS bằng7-Zip; artifact cuối không có `dashboard-ai-agent.exe`.

- Bộ cài local: `app/src-tauri/target/release/bundle/nsis/SeasonalManagement_0.1.33_x64-setup.exe` và `.exe.sig`.
- Baseline: `C:/Users/tuan/AppData/Local/Temp/seasonal-dashboard-baseline-yi18fds0/`.
- Log build, metrics, payload giải nén và workbook smoke: `C:/Users/tuan/AppData/Local/Temp/seasonal-dashboard-verification-28qz_k_s/`.
- Artifact là bản **kiểm chứng local**, dùng endpoint local từ `.env.local`, không phải release Production. Không đổi version/identifier/updater endpoint hoặc publish `latest.json`.

### 10.4 Giới hạn và gate phát hành còn mở

- Full-repo `npm run lint` chưa xanh: còn lỗi ngoài các file Dashboard mới, ví dụ `useGanttDragScroll.ts:79` (ref trong render) và `operationalScheduleContract.test.ts:828` (`any`), cùng generated scaffolds. Lint phạm vi Dashboard đã pass; không che lỗi toàn repo bằng ignore.
- `test:rules` còn failure đã ghi nhận ở export overnight: suite cũ yêu cầu2 rows trong khi canonical export hiện hành gộp1 pattern row. Giữ failure, không sửa nghiệp vụ hoặc baseline ngoài yêu cầu này.
- Chưa clean-install/upgrade bằng NSIS trong VM Windows riêng không Python; không cài đè ứng dụng/registry của người dùng để giả nghiệm thu. Chưa đo installed footprint thực, CI duration hoặc thử tải thật trên workload lớn.
- Đã kiểm capability local: không tìm thấy `WindowsSandbox.exe`; module Hyper-V có `Get-VM` nhưng truy vấn bị từ chối do thiếu quyền. Không nâng quyền hoặc dùng VM của người dùng khi chưa được cấp môi trường nghiệm thu riêng.
- Chưa smoke live updater download/relaunch, PDF Gate/Check-in hoặc Traffic Edge trên môi trường đích trong phiên này. Các consumer này không bị đổi data path; tests không thay thế nghiệm thu live.
- Chưa deploy migration/ứng dụng lên staging hoặc Production. Cần chạy migration read-only diff trước khi client mới dùng RPC trên môi trường đích, rồi đóng các gate clean-install/upgrade và lỗi regression nêu trên trước phát hành.
