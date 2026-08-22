# Kế hoạch triển khai Web Traffic Report theo dãy Ops Date liên tục

> **Trạng thái:** Staging đã triển khai trên nhánh `codex/web-traffic-report` tại Quick Tunnel tạm thời; production tiếp tục chờ nghiệm thu staging, named-tunnel và DNS. Xem evidence tại `docs/superpowers/artifacts/2026-08-22-public-traffic-report-baseline-audit.md`.
>
> **Ngày lập:** 2026-08-21.
>
> **Nguyên tắc thực thi:** triển khai theo từng task, kiểm thử trước khi chuyển task, không deploy production khi chưa hoàn tất đối soát và security gate.

## Mục tiêu

Tạo một trang báo cáo sản lượng web, đọc dữ liệu từ PostgreSQL/Supabase hiện có, phục vụ trên server và công bố qua Cloudflare Tunnel tại hostname riêng. Báo cáo phải thể hiện một dãy `Ops Date` liên tục do người dùng chọn, không dùng mùa làm bộ lọc và không bị ngắt khi khoảng ngày đi qua ranh giới mùa hoặc năm.

Trang báo cáo kết hợp:

- phong cách mở đầu và nhịp kể chuyện của ACI Annual Report;
- bố cục editorial, khoảng trắng và phần phương pháp của ACI Asia-Pacific;
- logic KPI, bộ lọc, phân rã và drill-down aggregate của báo cáo Looker Studio hiện tại;
- responsive thật, accessibility và trạng thái dữ liệu rõ ràng thay cho canvas BI cố định.

## Kết quả phải đạt

- Có route web ổn định, dự kiến `/reports/traffic`.
- Có link HTTPS qua tunnel, dự kiến `https://reports.ahtops.xyz`.
- Người xem truy cập công khai, không cần đăng nhập.
- Dùng nguồn chuẩn `reporting.effective_flight_operations`; không tạo database thứ hai.
- Mọi truy vấn dựa trên `from_date` và `to_date` inclusive; không gửi hoặc áp dụng `season_id`.
- Khoảng chọn chỉ bị ràng buộc bởi `min_ops_date` và `max_ops_date` hiện có; không áp dụng giới hạn cứng theo số ngày.
- Biểu đồ daily có đủ mọi ngày trong khoảng, kể cả ngày 0 chuyến.
- Phân biệt được `0`, `thiếu dữ liệu`, `đang cập nhật` và `Pax chưa báo cáo`.
- Filter nằm trong URL để reload, back/forward và chia sẻ link giữ nguyên trạng thái.
- Summary chạy qua endpoint công khai chuyên biệt; không tải toàn bộ lịch bay về trình duyệt để aggregate.
- Filter được aggregate tại thời điểm request trên một snapshot hiệu lực có index, refresh mỗi 20 giây; kết hợp cache Nginx 60 giây để giữ tuổi dữ liệu quan sát dưới 90 giây. Đây là thay đổi staging cần được chấp nhận trước production.
- Không công bố flight leg, record ID, số hiệu/giờ bay chi tiết hoặc field vận hành nhạy cảm.
- Có publication boundary, field allowlist, cache và rate limit; không để service-role key trong frontend.
- Có đối soát database, API, UI và workbook mẫu trước khi công bố.

## Phạm vi đã chốt

1. Không có filter mùa.
2. Không có preset “mùa hiện tại”.
3. Mùa chỉ là provenance nội bộ nếu cần truy dấu nguồn; không điều khiển báo cáo.
4. Khoảng ngày là liên tục và bao gồm cả ngày bắt đầu lẫn ngày kết thúc.
5. `Ops Date` theo ngày khai thác sân bay hiện hành: `05:00` đến `04:59` ngày kế tiếp.
6. Múi giờ nghiệp vụ là `Asia/Ho_Chi_Minh`; toggle UTC chỉ đổi nhãn/bucket giờ, không đổi cửa sổ `Ops Date`.
7. Kỳ so sánh mặc định là khoảng liền trước có cùng số ngày.
8. Số trung bình/ngày dùng toàn bộ số ngày lịch trong khoảng, không chỉ số ngày có bản ghi.
9. Thiết kế ưu tiên vận hành và phân tích; tỷ lệ định hướng là 25% editorial, 75% operational.
10. Không sao chép logo, ảnh, font, infographic, nội dung hoặc animation thuộc ACI.
11. Link công khai không yêu cầu tài khoản.
12. Chỉ công bố aggregate; không drill-down tới từng chuyến và không export raw flight legs.
13. Số chuyến dùng lịch hiệu lực sau khi áp dụng added/modified/deleted.
14. KPI Pax chỉ cộng dòng có `pax_status = 'reported'` và luôn đi cùng Pax coverage.
15. Không giới hạn cứng độ dài khoảng ngày; `from_date` và `to_date` phải nằm trong `[min_ops_date, max_ops_date]` hiện có.
16. Hiệu năng được kiểm soát theo loại truy vấn bằng aggregate, cursor pagination, zoom window, payload/group limit, timeout và cancellation.
17. Mốc `<150ms` là target đo lường cho warm DB execution và Nginx cache-hit; không phải release gate uncached qua Tunnel trước khi có benchmark staging.
18. Aggregate cell có 1-2 flight leg phải được suppress hoặc gộp/complementary-suppress vào `Khác`; đối soát nội bộ trước suppression luôn exact, còn grand total công khai chỉ exact khi cohort tổng có ít nhất 3 leg.
19. Mẫu số Pax coverage là các leg hiệu lực đã qua thời hạn báo cáo T+1 so với giờ bay local; leg tương lai/chưa đến hạn chưa vào mẫu số.
20. Khi URL không có ngày, mặc định từ 01/01 năm hiện tại đến Ops Date hoàn tất gần nhất, sau đó clamp vào min-max thực tế.
21. Duplicate cùng business leg xuyên mùa chọn candidate có authoritative server recency mới nhất; tie/missing recency bị quarantine.
22. Country dùng mapping database hiện tại; giữ `Unknown` trong breakdown, mẫu số và quality panel, không dùng Excel ghi đè DB.

## Sổ quyết định

| ID | Quyết định | Lựa chọn | Trạng thái | Ảnh hưởng |
|---|---|---|---|---|
| D1 | Đối tượng và quyền truy cập | Công khai không đăng nhập; chỉ aggregate, không chi tiết từng chuyến | Đã chốt 2026-08-21 | Cần public API riêng, privacy allowlist, cache, WAF/rate limit; không dùng operator auth |
| D2 | “Sản lượng chuyến” là lịch hiệu lực hay thực khai thác | Lịch hiệu lực sau added/modified/deleted | Đã chốt 2026-08-21 | Không cần bổ sung nguồn operated/cancelled trong phase 1 |
| D3 | Cách tính KPI Pax | Chỉ cộng Pax có trạng thái `reported`, đồng thời hiển thị coverage | Đã chốt 2026-08-21 | Tổng Pax, chart và export phải loại Pax chưa báo cáo khỏi tổng |
| D4 | Cơ chế làm mới dữ liệu công khai | Live aggregate qua public endpoint chuyên biệt | Đã chốt 2026-08-21 | Bắt buộc query guard, cache ngắn, WAF/rate limit và freshness metadata |
| D5 | Giới hạn khoảng ngày | Không có giới hạn cứng; chỉ chọn trong `min_ops_date` đến `max_ops_date` hiện có | Đã chốt 2026-08-21 | Tối ưu và giới hạn tài nguyên theo từng query type, không chặn theo tổng số ngày |
| D6 | Visual hierarchy | Hero ACI Annual Report + Executive Summary ACI Asia-Pacific + KPI comparison cards | Đã chốt 2026-08-21 | Cần semantic color/type tokens, responsive headline và deterministic insight rules |
| D7 | Aggregate API | Ba RPC chuyên biệt và một bundle wrapper cho initial single round-trip | Đã chốt 2026-08-21 | Giữ refetch timeline/breakdown độc lập nhưng lần tải đầu chỉ có một browser request |
| D8 | Web shell isolation | Hai route-group root layouts; public report không import desktop/Tauri graph | Đã chốt 2026-08-21 | Cần di chuyển route desktop vào group pathless và kiểm tra build chunks |
| D9 | Public API cache | Nginx fresh 60 giây, không serve stale; browser SWR thêm tối đa 30 giây; Cloudflare bypass | Đã chốt 2026-08-21 | Tuổi response tối đa 90 giây nếu giữ đúng `Age`; cache key bao phủ toàn bộ filter/zoom/cursor |
| D10 | Mốc hiệu năng `<150ms` | Target p95 cho warm DB full-range/concurrency 1 và Nginx cache-hit/concurrency 10; SLO uncached end-to-end chốt sau staging | Đã chốt 2026-08-21 | Báo cáo latency theo từng lớp và không dùng target như gate phát hành giả |
| D11 | Small-cell privacy | Suppress/gộp aggregate cell dưới 3 leg; giữ đối soát nội bộ exact và public total chỉ khi cohort đủ 3 | Đã chốt 2026-08-21 | Breakdown/table/tooltip/export phải dùng cùng suppression contract |
| D12 | Khoảng ngày khi URL không có filter | Từ 01/01 năm hiện tại đến Ops Date hoàn tất gần nhất | Đã chốt 2026-08-21 | Server clamp vào min-max và trả URL canonical trong initial overview |
| D13 | Trùng cùng business leg giữa hai mùa | Chọn candidate có authoritative server recency mới nhất; hòa/thiếu recency thì quarantine | Đã chốt 2026-08-21 | Phải định nghĩa recency tuple, xử lý tombstone trước khi lọc deleted và có evidence cho winner |
| D14 | Country canonical phase 1 | Dùng mapping database hiện tại và giữ bucket `Unknown`; Excel chỉ dùng đối chiếu ngoại lệ | Đã chốt 2026-08-21 | Không dùng workbook ghi đè database; Unknown vẫn nằm trong mẫu số/quality panel |
| D15 | Mẫu số Pax coverage | Leg hiệu lực đã đến hạn T+1 theo giờ local; chưa có cờ miễn trừ thì cargo/ferry vẫn được tính bảo thủ | Đã chốt 2026-08-21 | Phải tách due/not-due, công bố hạn chế exemption và bổ sung canonical flag khi có nguồn |

D1-D15 là baseline nghiệp vụ đã chốt; mọi thay đổi sau này phải cập nhật sổ quyết định trước khi code tiếp.

## Các mặc định kỹ thuật có thể điều chỉnh sau

- Màn hình mở mặc định: từ ngày 01/01 của năm hiện tại đến `Ops Date` hoàn tất gần nhất, được clamp vào `[min_ops_date, max_ops_date]`.
- Duplicate cùng business leg xuyên mùa chọn bản có authoritative server recency mới nhất. Recency phải đến từ trường/server event đã audit, không dùng clock phía client hoặc thứ tự tên mùa; hòa hoặc thiếu recency thì quarantine và cảnh báo.
- Country phase 1 lấy mapping database hiện tại, giữ bucket `Unknown` và lập danh sách ngoại lệ đối chiếu Excel; không ghi đè DB từ workbook.
- Các GET overview/timeline/breakdowns trả `Cache-Control: public, max-age=60, stale-while-revalidate=30, stale-if-error=0`; export luôn `no-store` để không chiếm cache bằng payload lớn.
- Chỉ một tầng shared cache được bật cho `/api/report`; nếu Nginx giữ cache thì Cloudflare Cache Rule phải bypass API này.
- Nginx chỉ giữ fresh cache 60 giây và tuyệt đối không `proxy_cache_use_stale`/background-update. SWR 30 giây là semantics của private browser cache; nhờ `Age` được giữ đúng, tuổi response tối đa vẫn là 90 giây kể từ lúc origin sinh, kể cả khi upstream treo/lỗi.
- Frontend canonicalize SearchParams trước request đầu. Edge trả `308` + `no-store` về URL canonical cho client ngoài gửi param không chuẩn; Nginx chỉ cache canonical HTTP 200 nên không cần parse/sort array bằng cache key thô.
- Freshness UI và acceptance dùng tuổi tối đa 90 giây do cửa sổ SWR 30 giây; luôn hiển thị `generated_at`, `data_as_of`, `source_watermark` nếu chứng minh được và cache status/age.
- Preset: 7 ngày, 30 ngày, 90 ngày, tháng đến hiện tại, năm đến hiện tại và tùy chọn.
- Granularity mặc định: ngày. Khoảng dài vẫn giữ dữ liệu daily; UI có thể cho xem tuần/tháng mà không thay đổi date contract.
- Metric nổi bật trong hero: tổng chuyến; Pax là KPI song song có coverage.
- Breakdown: Top 10 + `Khác`, có thể chuyển sang bảng đầy đủ.
- Drill-down chỉ đi tới aggregate theo ngày/hãng/chặng/quốc gia; không trả flight leg.
- Ngôn ngữ phase 1: tiếng Việt, định dạng ngày/số `vi-VN`.
- Export phase 1: XLSX và CSV aggregate theo filter hiện hành; không có raw-data sheet. PDF là phase sau nếu render bằng trình duyệt không đủ ổn định.
- Config/số ghế không thuộc phase 1 cho đến khi có nguồn canonical.

## Ngoài phạm vi phase 1

- Thay thế dashboard desktop hiện tại.
- Thay đổi quy trình import mùa hoặc cơ chế đồng bộ lịch bay.
- AI Workspace hoặc insight do LLM tạo.
- Public anonymous truy cập trực tiếp reporting schema, view hoặc bảng nguồn.
- Chi tiết từng chuyến, số hiệu/giờ bay, gate/stand/carousel, record ID và provenance nội bộ.
- Raw flight export.
- Native Excel pivot XML giống hệt workbook mẫu.
- Capacity/seat configuration khi database chưa có nguồn chuẩn.
- Bản đồ tương tác và scroll-jacking.
- Tauri release, trừ kiểm thử regression do thay đổi `AppShell`.

## Baseline và điều kiện bắt đầu

Checkout hiện tại không phải baseline triển khai: branch `codex/route-reload-port` tại app `0.1.10`, trong khi ref `origin/main`/`app-v0.1.20` mới hơn. Phiên code phải:

1. Tạo worktree sạch từ `origin/main` mới nhất.
2. Không đụng hoặc ghi đè thay đổi sẵn có trong `AGENTS.md` của workspace hiện tại.
3. Đọc lại `AGENTS.md`, `context.md`, `architecture.md` và các plan/reporting migration liên quan trong worktree mới.
4. Re-audit các file đã đổi giữa checkout hiện tại và `origin/main`, đặc biệt:
   - `app/package.json`;
   - `app/src/app/dashboard/page.tsx`;
   - `app/supabase/schema.sql`.
5. Kiểm tra live Supabase/RPC và server config trước mọi migration hoặc deploy; không suy ra trạng thái production từ tài liệu cũ.

## Kiến trúc mục tiêu

```text
Browser
  -> reports.ahtops.xyz
  -> Cloudflare WAF/rate limit + named Tunnel
     (bypass shared cache cho /api/report nếu Nginx là cache owner)
  -> Nginx
     -> /reports/traffic: Next.js static export
     -> GET /api/report/v1/{overview,timeline,breakdowns}: canonical aggregate gateway + cache
     -> GET /api/report/v1/export: cursor-paged aggregate export, no-store
  -> Supabase Edge Function `public-traffic-report` (GET)
  -> public.get_public_traffic_report_overview_v1(...)
     -> reporting.get_traffic_report_kpis(...)
     -> reporting.get_traffic_report_timeline(...)
     -> reporting.get_traffic_report_breakdowns(...)
  -> live aggregate query layer
  -> reporting.effective_flight_operations
  -> PostgreSQL
```

Các ranh giới bắt buộc:

- PostgreSQL không được expose qua tunnel.
- `supabase.ahtops.xyz` tiếp tục là API hostname; không trộn static UI vào API ingress.
- Browser không được query trực tiếp reporting schema hoặc RPC nội bộ hiện có.
- HTTP Edge route nhận unauthenticated GET sau WAF/rate limit; database role `anon` không được execute bốn RPC mới hoặc `SELECT` trực tiếp view/bảng reporting.
- Nếu Edge Function cần server credential, secret chỉ nằm trong server secret store, không nằm trong bundle, HTML, log hoặc repo.
- Nginx ưu tiên gọi Edge Function qua loopback/private network. Nếu buộc dùng public upstream, Edge phải xác thực một origin credential riêng hoặc mTLS; credential này khác service-role và chỉ nằm ở Nginx/Edge secret store. Direct Edge URL thiếu origin auth phải bị từ chối để không bypass WAF/rate limit/cache.
- Public endpoint phải validate ngày/filter, áp dụng field allowlist, giới hạn payload và không trả raw row.
- Giữ `output: "export"` để không phá Tauri.
- Initial render và mỗi lần commit filter chỉ phát một browser request tới bundle overview. Pagination/zoom sau đó được phép gọi endpoint timeline độc lập, không refetch KPI/breakdown bất biến.
- Dùng hai route-group root layouts; public-report root không import `AppShell`, `OperatorAuthGate`, `NativeRuntimeGate`, `AppSidebar`, Zustand desktop store hoặc Tauri IPC.
- Root public chỉ render `WebReportShell` server component và một client island nhỏ cho SearchParams/chart.
- Chuyển giữa desktop root và public-report root gây full-page load có chủ đích để giữ bundle isolation.

## Hợp đồng dữ liệu

### Grain và nguồn chuẩn

- Một dòng báo cáo là một flight leg hiệu lực `A` hoặc `D`.
- Nguồn chuẩn: `reporting.effective_flight_operations`.
- Bản ghi deleted bị loại; added/modified dùng phiên bản hiệu lực phía server.
- Khóa kỹ thuật hiện có vẫn giữ provenance mùa, nhưng query báo cáo không lọc mùa.
- Phải định nghĩa business key xuyên mùa và authoritative server recency tuple trước khi cho phép date range xuyên mùa trên production. Candidate có tuple mới nhất thắng; hòa/thiếu tuple bị quarantine.
- Dedupe phải xét cả tombstone/deleted candidate trước bước loại deleted. Nếu candidate mới nhất là deleted, leg không được hồi sinh từ bản cũ ở mùa khác.
- Reporting query seam phải dùng cột Ops Date kiểu `date`; không lọc/sort/index bằng chuỗi `ops_date`.
- Đẩy date/type/dimension predicate xuống trước các enrichment join route/aircraft/Pax để giảm số dòng xử lý.
- Không triển khai ba RPC mới bằng cách bọc máy móc `reporting.query_aggregated`; generic function hiện có không mang đúng contract Pax/date-spine/public bundle.
- Có thể dùng tập `filtered AS MATERIALIZED` trong bundle để tái sử dụng cùng snapshot logic, nhưng chỉ chốt sau khi benchmark memory/disk spill.
- `pax_status = 'reported'` hiện cần được audit vì nguồn hiện tại có thể chỉ đánh dấu khi `pax > 0`. Nếu nghiệp vụ cần biểu diễn “đã báo cáo 0 Pax”, phải bổ sung trạng thái báo cáo độc lập; không suy ra từ số 0.

### Request contract

Các input được phép:

- `from_date`;
- `to_date`;
- `type[]` (`A`, `D`);
- `airline[]`;
- `route[]`;
- `country[]`;
- `aircraft[]` hoặc `ac_group[]`;
- `time_basis` (`local`, `utc`) cho peak-hour;
- `comparison` (`previous_period`, `previous_year`, `none`);
- `granularity` và `zoom_from`/`zoom_to` cho timeline;
- cursor/page-size/sort/limit theo query type cho timeline, breakdown và bảng aggregate;
- `contract_version` để client từ chối response không tương thích.

Không nhận `season`, `season_id`, `seasonIds` hoặc biến thể tương đương từ UI.

Riêng GET overview cho phép `from_date` và `to_date` cùng vắng mặt. Server lấy metadata trong cùng DB call, áp dụng D12, clamp vào `[min_ops_date, max_ops_date]` rồi trả normalized/canonical filter; browser cập nhật URL bằng `history.replaceState` mà không phát request metadata thứ hai. Nếu chỉ thiếu một đầu ngày thì từ chối. Timeline/breakdown/export luôn yêu cầu đủ hai ngày.

Public endpoint từ chối range đảo ngược, ngày nằm ngoài `[min_ops_date, max_ops_date]`, filter ngoài allowlist hoặc request vượt resource contract của query type. Không được từ chối chỉ vì tổng số ngày trong range vượt một ngưỡng cứng.

### Response contract

Mọi endpoint trả `common_meta` gồm:

- `min_ops_date`, `max_ops_date`, normalized/canonical filter;
- `from_date`, `to_date`, `day_count`;
- `generated_at`, `data_as_of`, `source_watermark`, `request_hash`, `contract_version` và timezone; tuổi shared cache thực lấy từ HTTP `Age`/`X-Cache-Status`, không giả lập trong JSON origin;
- số leg của cohort và mọi quality count như `Unknown`/chưa mapping chỉ khi chính count đó không vi phạm threshold; nếu 1-2 leg thì trả trạng thái `suppressed`, không trả exact count;
- `suppression_policy = { threshold: 3, applied, suppressed_cell_count }`; không trả exact value của cell/cohort bị suppress;
- trạng thái chất lượng, completeness hoặc cảnh báo partial data.

Payload theo endpoint:

- `overview`: `common_meta`, Executive Summary, KPI/current-comparison/Pax coverage, timeline overview hoặc initial window, Top 10 + `Khác`, peak-hour và quality;
- `timeline`: `common_meta`, `page_from`, `page_to`, cursor, granularity, series và quality; không lặp KPI/breakdown;
- `breakdowns`: `common_meta`, dimension/cursor/sort, rows/Top N/`Khác`, peak-hour nếu được yêu cầu và quality; không lặp daily series/KPI;
- `export`: `common_meta`, format/dimension/page/cursor metadata và publication rows đã suppress; không lặp UI bundle và không tạo server-side job trong phase 1.

Response công khai chỉ được chứa các dimension/metric đã duyệt: `ops_date`, `type`, `airline`, `route`, `country`, `aircraft_group`, `hour_bucket`, `bucket_minutes`, `time_basis`, các count tổng hợp ARR/DEP, `pax_reported`, `pax_coverage` và quality metadata đã suppress. `hour_bucket` chỉ là bucket aggregate 30/60 phút, không phải giờ bay riêng lẻ. Không trả flight number, giờ bay chính xác, gate, stand, carousel, record ID, operator hoặc provenance nguồn.

### RPC contract và single round-trip

Ba hàm nội bộ chuyên biệt trong schema `reporting`:

```text
reporting.get_traffic_report_kpis(
  p_from_date date,
  p_to_date date,
  p_filters jsonb,
  p_comparison text,
  p_data_as_of timestamptz
) returns jsonb

reporting.get_traffic_report_timeline(
  p_from_date date,
  p_to_date date,
  p_window_from date,
  p_window_to date,
  p_granularity text,
  p_after_date date,
  p_page_size integer,
  p_filters jsonb,
  p_data_as_of timestamptz
) returns jsonb

reporting.get_traffic_report_breakdowns(
  p_from_date date,
  p_to_date date,
  p_filters jsonb,
  p_top_n integer,
  p_time_basis text,
  p_bucket_minutes integer,
  p_data_as_of timestamptz
) returns jsonb
```

Thêm một wrapper bundle `public.get_public_traffic_report_overview_v1(...) returns jsonb` để lần render đầu chỉ có một GET từ browser, một Edge-to-PostgREST call và một DB round-trip. Edge chỉ thực hiện một PostgREST request/outer `SELECT`; wrapper lấy metadata/default date và chụp `data_as_of` đúng một lần rồi gọi ba hàm nội bộ, trả:

```text
{
  meta,
  executive_summary,
  kpis,
  timeline,
  breakdowns,
  peak_hours,
  quality
}
```

Ba RPC `reporting.*` và wrapper không grant cho `PUBLIC`, `anon` hoặc `authenticated`; migration chỉ grant quyền tối thiểu cho server role dùng trong Edge Function. Ưu tiên `SECURITY INVOKER`; nếu bắt buộc dùng `SECURITY DEFINER`, phải pin `search_path`, owner và object qualification rồi có privilege-escalation test. Nginx và browser không giữ service-role credential. Timeline page tiếp theo và refetch do zoom có endpoint GET riêng nhưng phải dùng cùng filter normalization, contract version và freshness semantics.

Tất cả function chỉ đọc dữ liệu và được khai báo volatility phù hợp (`STABLE` sau khi test). Một outer PostgREST statement/transaction phải giữ cùng MVCC snapshot cho metadata và ba section; `data_as_of` chỉ là nhãn của snapshot, không được dùng thay cơ chế snapshot. Test concurrency phải commit một writer trong lúc wrapper chạy và chứng minh mọi section cùng thấy trạng thái trước hoặc sau commit, không trộn hai trạng thái. Nếu cách chia ba function không chứng minh được snapshot này, implementation phải chuyển sang một SQL statement với shared filtered CTE thay vì giữ ba lời gọi độc lập.

Mọi section trong bundle phải có cùng `request_hash`, `data_as_of` và normalized filter. Nếu kỳ so sánh nằm ngoài data domain, trả `comparison.status = unavailable|partial`; không clamp im lặng.

`generated_at` là thời điểm origin sinh response; `data_as_of` là snapshot time dùng chung trong DB statement; `source_watermark` là watermark cập nhật/commit mới nhất mà reporting source có thể chứng minh. Nếu nguồn chưa có watermark tin cậy, trả `source_watermark.status = unknown` thay vì đồng nhất nó với thời điểm request.

KPI response tối thiểu gồm `current`, `comparison`, `peak_day` và:

```text
pax: {
  reported_total,
  reported_legs,
  reported_eligible_legs,
  eligible_legs,
  missing_eligible_legs,
  not_due_legs,
  planned_legs,
  coverage
}
```

Trong phase 1, `eligible_legs` là mọi leg hiệu lực có `scheduled_local_at + 1 day <= data_as_of` theo `Asia/Ho_Chi_Minh`; `reported_eligible_legs` là phần giao với `pax_status = 'reported'`; `coverage = reported_eligible_legs / eligible_legs`. Leg chưa đến hạn nằm trong `not_due_legs` và không vào mẫu số. Do chưa có cờ canonical miễn trừ, cargo/ferry vẫn nằm trong mẫu số một cách bảo thủ; methodology phải ghi rõ và chỉ loại khi có nguồn eligibility đã duyệt.

### Resource contract theo loại truy vấn

Không dùng một `max_days` chung. Mỗi query type có hợp đồng tài nguyên riêng:

| Query type | Phạm vi dữ liệu | Cơ chế bảo vệ |
|---|---|---|
| Metadata | Toàn bộ nguồn | Nằm trong `common_meta` của overview cùng DB call; endpoint diagnostics riêng nếu có không được client gọi trước initial overview |
| KPI | Toàn bộ range đã chọn | Aggregate một record, index phù hợp, cache ngắn, statement timeout và cancellation |
| Timeline | Toàn bộ range logic; tải theo cửa sổ đang xem | Date cursor/page, zoom window, granularity rõ ràng và payload cap; daily window không được bỏ ngày |
| Breakdown | Toàn bộ range đã chọn | Aggregate theo dimension, Top N hoặc cursor pagination, group/cardinality limit |
| Peak-hour/heatmap | Range hoặc zoom window hiện hành | Bucket aggregation, cursor/window pagination và bucket-count limit |
| Export | Toàn bộ range đã chọn | GET phân trang/cursor, chỉ aggregate và `no-store`; browser ghép CSV/XLSX theo chunk. Async server-side job là phase sau nếu benchmark chứng minh cần |

KPI toàn kỳ phải được profile và tối ưu để chạy trên toàn bộ `[min_ops_date, max_ops_date]`. Query phụ vượt budget phải trả lỗi kiểm soát kèm hướng dẫn zoom/phân trang; không âm thầm cắt ngày hoặc trả partial result như dữ liệu đầy đủ.

Single round-trip không đồng nghĩa trả một payload daily không giới hạn. Bundle initial trả KPI/breakdown toàn range cùng timeline overview hoặc cửa sổ đang thấy; timeline page/zoom sau đó tải độc lập. Mọi partial section phải có `complete = false`, cursor và phạm vi rõ ràng.

### Performance target và cách đo

- Mục tiêu `<150ms` được đánh giá ở p95 cho hai workload: DB execution của bundle trên warm buffers/full min-max tại concurrency 1, và Nginx cache-hit TTFB tại concurrency 10. p99 vẫn phải ghi nhận nhưng chưa là release gate; đây chưa phải cam kết end-to-end qua Internet/Tunnel.
- Đo riêng: PostgreSQL execution, Edge Function duration, Nginx upstream/cache TTFB, Tunnel TTFB và browser payload/parse/render.
- Ghi p50/p95/p99 cho cold/warm cache và concurrency 1/10/30; ghi cả payload bytes, số bucket và buffer reads.
- Dùng `EXPLAIN (ANALYZE, BUFFERS)` trên full min-max, range phổ biến và zoom/page đại diện.
- Nếu chưa đạt 150ms, tối ưu predicate pushdown, typed date, query shape và index theo evidence; không tăng timeout hoặc thêm max-days để che bottleneck.
- Chỉ chốt SLO uncached production sau benchmark; báo cáo pass/fail riêng cho target 150ms và end-to-end latency.

### Date spine và trạng thái ngày

Selected range đầy đủ vẫn được khai báo bằng `from_date`/`to_date` và `day_count`. Mỗi timeline RPC tạo `generate_series(page_from_or_window_from, page_to_or_window_to, interval '1 day')` rồi left join dữ liệu hiệu lực; bundle overview có thể tạo bucket tuần/tháng bao phủ toàn selected range. Không bắt DB sinh toàn bộ daily rows ngoài window chỉ để rồi cắt bỏ ở API.

Timeline có thể được truyền theo nhiều trang hoặc zoom window. Toàn bộ selected range vẫn là một time domain liên tục; trạng thái client `not_loaded/loading` không được biến thành data status `missing` hoặc `zero`. Mỗi response phải khai báo `page_from`, `page_to`, cursor tiếp theo và trạng thái complete. Khi ở granularity ngày, mọi ngày giữa `page_from` và `page_to` đều phải xuất hiện đúng một lần; ghép các trang không được hở hoặc trùng ngày. Ở overview tuần/tháng, mỗi bucket vẫn bao phủ một đoạn ngày liên tục và người dùng có thể zoom về daily.

Mỗi ngày có một trong các trạng thái:

- `complete`: dữ liệu ngày đã hoàn tất;
- `partial`: ngày hiện tại hoặc ingestion chưa hoàn tất;
- `zero`: nguồn đã hoàn tất và thực sự không có chuyến;
- `missing`: không đủ bằng chứng để kết luận 0;
- `suppressed`: có dữ liệu nhưng cohort/cell dưới 3 leg nên không công bố exact value;
- `future`: ngày tương lai nếu khoảng chọn bao gồm lịch kế hoạch.

UI không được biến `missing` hoặc `suppressed` thành số 0. Nếu database hiện chưa có nguồn xác định ingestion completeness, task dữ liệu phải bổ sung metadata/freshness contract hoặc trả `unknown`, không tự suy đoán ở frontend.

Suppression được áp dụng sau filter cho mọi cohort/cell có `leg_count < 3`, kể cả tooltip/table/export. Các dimension cell nhỏ được gộp vào `Khác`; nếu `Khác` vẫn chỉ đại diện một cell nhỏ có thể suy ra bằng phép trừ, dùng complementary suppression hoặc bucket thô hơn. Grand total chỉ công bố exact khi cohort tổng có ít nhất 3 leg; không trả exact `suppressed_legs` làm lộ giá trị bị ẩn.

### KPI chuẩn

- `flights = count(*)`.
- `arrivals = count(*) where type = 'A'`.
- `departures = count(*) where type = 'D'`.
- `total_flights = arrivals + departures`.
- `pax_reported = sum(pax where pax_status = 'reported')`.
- `pax_due = scheduled_local_at + interval '1 day' <= data_as_of` theo `Asia/Ho_Chi_Minh`.
- `eligible_legs = count(*) where pax_due`; chưa loại cargo/ferry nếu chưa có canonical exemption flag.
- `reported_eligible_legs = count(*) where pax_due and pax_status = 'reported'`.
- `pax_coverage = reported_eligible_legs / eligible_legs`; leg chưa đến hạn không vào mẫu số.
- `avg_flights_per_day = total_flights / day_count`.
- `delta = current - previous`.
- `delta_percent = delta / previous`, với trạng thái riêng khi previous bằng 0.
- `CTG = driver_delta / previous_period_total`.
- Tuần dùng duy nhất ISO `IYYY-IW`.
- `Unknown` là một bucket hiển thị được và vẫn nằm trong mẫu số.

## Cấu trúc trải nghiệm

### 1. Header và hero

- Header gọn: brand riêng, tên báo cáo, `Cập nhật lúc`, `Chia sẻ liên kết`, `Xuất báo cáo`.
- Hero nền Navy `#081322`, ngắn hơn một viewport, hiển thị khoảng ngày và một kết luận chính.
- Display number tối đa 70px và headline tối đa 60px trên desktop; dùng `clamp()` để giảm còn khoảng 36-40px/30-36px trên mobile, không dùng kích thước cố định.
- Cyan `#00B4D8`/`#42C1C7` dùng cho số liệu và điểm nhấn trên Navy; Cobalt `#234093` dùng cho data/surface trên nền sáng, không dùng làm chữ nhỏ trên Navy.
- Không hiển thị tên mùa trong hero hoặc filter.
- Animation chỉ dùng opacity/transform nhẹ và có `prefers-reduced-motion`.

### 2. Executive Summary

- Lead-in editorial 3-4 insight xác định bằng quy tắc dữ liệu: ngày cao điểm, hãng có tỷ trọng lớn nhất, tăng/giảm so với kỳ trước hoặc cùng kỳ và trạng thái Pax coverage.
- Insight dùng đúng filter/comparison của bundle và cùng `data_as_of`; không gọi LLM, không suy diễn khi dữ liệu partial/unavailable.
- Mỗi insight có số, đơn vị, kỳ tham chiếu và link/anchor tới chart aggregate liên quan.
- Nếu coverage thấp hoặc comparison không đủ domain, thay insight tăng trưởng bằng cảnh báo dữ liệu có ngôn ngữ trung tính.
- Giới hạn chiều dài theo editorial measure 60-75 ký tự mỗi dòng; mobile xếp một cột.

### 3. Filter sticky

- Khoảng `Từ ngày` - `Đến ngày`.
- Preset ngày/tháng/năm, không có preset mùa.
- ARR/DEP, hãng, đường bay, quốc gia.
- Local/UTC chỉ xuất hiện ở khu vực peak-hour hoặc dưới dạng filter có phạm vi rõ ràng.
- Chip filter, reset và validation `from_date <= to_date`.
- SearchParams canonical gồm `from`, `to`, `type`, `airline`, `route`, `country`, `comp`, `tz`; array được sort/dedupe và default được ghi rõ.
- URL canonical, ví dụ:
  `/reports/traffic?from=2026-01-01&to=2026-08-20&type=A,D&airline=VN,VJ&route=DAD-HAN&country=VN&comp=previous_period&tz=local`.
- Bookmark, reload, back/forward và chia sẻ phải phục hồi đúng trạng thái; param lạ hoặc ngoài domain được reject/canonicalize rõ ràng.

### 4. KPI band

- Tổng chuyến, chuyến đến, chuyến đi.
- Pax đã báo cáo, Pax coverage.
- Trung bình chuyến/ngày và ngày cao điểm.
- Mỗi card có current value, pill badge delta/% và nhãn rõ `so với kỳ trước cùng số ngày` hoặc `so với cùng kỳ năm trước` theo `comp`.
- Pill dùng icon/hướng + chữ + màu; không dùng xanh/đỏ làm tín hiệu duy nhất và có trạng thái `unavailable|partial`.
- Số dùng `font-variant-numeric: tabular-nums`; Pax card luôn hiển thị coverage và số leg reported/eligible trong tooltip hoặc helper text.

### 5. Continuous trends

- Hai small-multiple đồng bộ: `Chuyến bay` và `Hành khách`.
- Mỗi chart tối đa hai series `Đến` và `Đi`.
- Mọi ngày có vị trí trên time-scale.
- `0` vẽ về baseline; `missing` tạo khoảng hở/marker cảnh báo; `suppressed` dùng ký hiệu/nhãn riêng và không lộ exact tooltip.
- Crosshair/tooltip đồng bộ; có brush/zoom cho khoảng dài.
- Click ngày mở breakdown aggregate của ngày đó, không trả danh sách chuyến và không âm thầm đổi toàn bộ filter.
- Có bảng dữ liệu thay thế cho keyboard và screen reader.

### 6. Breakdown và vận hành

- Airline, route, country: horizontal bar Top 10 + `Khác`, có tab bảng đầy đủ sau khi áp dụng small-cell/complementary suppression.
- Peak hour: bucket 30/60 phút, ARR/DEP và Local/UTC rõ ràng.
- Heatmap: tháng/ngày trong tuần hoặc ngày/giờ tùy lát nghiệp vụ; date domain phải liên tục.
- Aircraft mix: aircraft/ac_group; chưa có seat config.

### 7. Bảng aggregate, chất lượng và phương pháp

- Bảng aggregate theo ngày/hãng/chặng/quốc gia có sort, search, sticky header và grand total theo filter; cell/cohort dưới 3 leg không lộ exact value qua sort/search/tooltip/export.
- Không có cột hoặc API dẫn tới flight leg riêng lẻ.
- Panel chất lượng hiển thị missing Pax, Unknown mapping, duplicate/quarantine và partial days; count dựa trên 1-2 leg hiển thị `suppressed`, không lộ exact value.
- Phần phương pháp ghi định nghĩa Ops Date, Pax, comparison, freshness và nguồn dữ liệu.
- Export chỉ dùng cùng filter/data contract với UI và chỉ chứa aggregate.

## Visual system

- Hero/navy: `#081322`.
- Primary/Cobalt: `#234093`.
- Accent Cyan: `#00B4D8`.
- Secondary data Cyan: `#42C1C7`.
- Warning/accent: `#D97706`.
- Surface: `#F8FAFC`.
- Text: `#0F172A`; muted: `#64748B`.
- Dùng semantic tokens như `--report-hero`, `--report-primary`, `--report-accent-cyan`, `--report-data-cyan`; không rải raw hex trong component.
- Contrast đã định hướng: Cyan trên Navy dùng được cho số lớn; Cobalt trên Navy không đạt cho chữ nhỏ nên chỉ dùng trên surface sáng hoặc mảng trang trí không truyền nghĩa.
- Dùng font có giấy phép và hỗ trợ tiếng Việt, ưu tiên font dự án hoặc `Inter`/`Be Vietnam Pro`.
- Web font phải `font-display: swap|optional`, có fallback gần metric và không gây layout shift cho headline/KPI.
- Desktop max-width khoảng 1440px; mobile một cột, không horizontal scroll.
- Màu không phải tín hiệu duy nhất; chart phải có label/pattern/shape phù hợp.
- Contrast tối thiểu WCAG AA; focus rõ; target cảm ứng tối thiểu 44x44px.

## File dự kiến

Tên chính xác phải được revalidate trên `origin/main` trước khi code.

### Database và contract

- Create: `app/supabase/migrations/20260822090000_traffic_report_continuous_date.sql`
- Modify: `app/supabase/schema.sql`
- Create: `app/src/lib/traffic-report/trafficReportContract.ts`
- Create: `app/src/lib/traffic-report/trafficReportContract.test.ts`
- Create: `app/src/lib/traffic-report/publicTrafficReportClient.ts`
- Create: `app/src/lib/traffic-report/publicTrafficReportClient.test.ts`
- Create: `app/supabase/functions/public-traffic-report/index.ts`
- Create: `app/supabase/functions/public-traffic-report/index.test.ts`
- Create: SQL contract/reconciliation tests cho ba RPC `reporting.*` và wrapper `public.get_public_traffic_report_overview_v1` theo test convention được revalidate trên `origin/main`.

### Web shell và UI

- Delete/replace: `app/src/app/layout.tsx`; không giữ một top-level root layout dùng chung cho desktop và public report.
- Create: `app/src/app/(desktop)/layout.tsx`, là root layout duy nhất import `AppShell`.
- Move: `app/src/app/page.tsx` và toàn bộ route desktop hiện có vào `app/src/app/(desktop)/...`; route-group không đổi URL công khai.
- Revalidate rồi move các component/hook chỉ dành cho desktop vào subtree `(desktop)` nếu việc này làm import boundary rõ hơn; không bulk-move nếu gây rủi ro relative import không cần thiết.
- Create: `app/src/app/(public-report)/layout.tsx`, server-only root layout và metadata/style riêng.
- Create: `app/src/app/(public-report)/reports/traffic/page.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/WebReportShell.tsx`, server component không có `'use client'`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficReportClient.tsx`, client island duy nhất cho SearchParams và chart interaction.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficReportHero.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficExecutiveSummary.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficReportFilters.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficReportKpis.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/ContinuousTrafficChart.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficBreakdowns.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficAggregateTable.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficDataQuality.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/_components/TrafficMethodology.tsx`.
- Create: `app/src/app/(public-report)/reports/traffic/traffic-report.css`.
- Create: `app/src/app/(public-report)/reports/traffic/publicReportImportGraph.test.ts`.
- Create: `app/src/app/(public-report)/reports/traffic/publicReportStaticBundle.test.ts`.

### Export, test và vận hành

- Modify: `app/src/lib/dashboardReportExport.ts` hoặc tạo `app/src/lib/traffic-report/trafficReportExport.ts` nếu contract khác biệt đáng kể.
- Create: `app/src/lib/traffic-report/trafficReportExport.test.ts`
- Modify: `app/package.json`
- Create: `app/src/lib/traffic-report/trafficReportContract.source.test.ts`
- Create: `docs/runbooks/web-traffic-report-cloudflare.md`
- Create: `deploy/report-web/nginx.conf`
- Create: `deploy/report-web/cloudflared-ingress.example.yml`
- Create: `.github/workflows/report-web-deploy.yml` sau khi chốt phương thức truy cập server và secrets.
- Modify: `context.md`
- Modify: `architecture.md` nếu mô tả data flow hiện tại mâu thuẫn với web report.

## Kế hoạch thực hiện

### Task 0 - Chốt contract và tạo baseline sạch

- [x] Ghi câu trả lời D1-D11 và D15 vào plan.
- [x] Chốt D4 là live aggregate và ghi cơ chế bảo vệ public query vào plan.
- [x] Chốt Nginx là shared-cache owner cho `/api/report`; Cloudflare cache bypass route API để không cộng dồn độ cũ.
- [x] Xác nhận D12-D14: mặc định đầu năm đến nay; duplicate chọn bản mới nhất; Country dùng database + `Unknown`.
- [x] Fetch refs và tạo worktree từ `origin/main` mới nhất.
- [x] Ghi commit baseline và trạng thái production endpoint mà không in secrets.
- [ ] Inventory server: OS, Nginx/Caddy, cloudflared service, named tunnel, DNS ownership, thư mục deploy và rollback artifact. (Đã thử read-only; SSH identity hiện có bị từ chối.)
- [x] Xác nhận `reports.ahtops.xyz` có thể dùng và không đụng API ingress. (NXDOMAIN ngày 2026-08-22; chưa provision.)
- [x] Revalidate file list và migration timestamp.

**Done:** D1-D15 không còn mở; baseline, cache owner và rollback owner được ghi nhận.

### Task 1 - Khóa data contract bằng test

- [ ] Viết test cho request không có `season_id`.
- [ ] Viết test range inclusive và `day_count`.
- [ ] Viết test URL không có ngày dùng 01/01 năm hiện tại đến Ops Date hoàn tất gần nhất, được clamp đúng min-max và không tạo metadata request thứ hai.
- [ ] Viết test biên `04:59`/`05:00`.
- [ ] Viết test date spine 7, 31, 90, 365 ngày và range qua năm/mùa.
- [ ] Viết test metadata trả đúng `min_ops_date` và `max_ops_date`.
- [ ] Viết test mọi range nằm trong min/max đều hợp lệ, không phụ thuộc số ngày.
- [ ] Viết test ngày ngoài min/max và range đảo ngược bị từ chối.
- [ ] Viết test duplicate xuyên mùa chọn candidate có authoritative server recency mới nhất; hòa/thiếu recency bị quarantine.
- [ ] Viết test candidate mới nhất là deleted/tombstone thì bản cũ không được hồi sinh.
- [ ] Viết test cursor pagination ghép đủ date spine, không hở/trùng ngày.
- [ ] Viết test zoom overview -> daily giữ cùng tổng và đúng biên ngày.
- [ ] Viết test `zero` khác `missing`/`partial`.
- [ ] Viết test ARR + DEP = total.
- [ ] Viết test ISO week, Local/UTC và previous-period cùng số ngày.
- [ ] Viết test chỉ cộng Pax `reported`; coverage dùng leg đã đến hạn T+1, loại leg chưa đến hạn, và tạm tính cargo/ferry bảo thủ khi chưa có exemption flag.
- [ ] Viết test biên Pax due ngay trước/đúng/sau `scheduled_local_at + 1 day` theo `Asia/Ho_Chi_Minh`.
- [ ] Viết test riêng cho “đã báo cáo 0 Pax”; nếu nguồn không phân biệt được với chưa báo cáo thì contract phải trả trạng thái `unknown`, không tự gán `reported`.
- [ ] Viết test kỳ so sánh nằm một phần hoặc toàn bộ ngoài data domain trả `partial`/`unavailable`, không clamp im lặng.
- [ ] Viết test wrapper bundle và từng RPC chuyên biệt cho cùng filter trả tổng tương đương, cùng `request_hash` và cùng `data_as_of`.
- [ ] Viết concurrency test có writer commit giữa lúc wrapper chạy; metadata/KPI/timeline/breakdown phải cùng thấy snapshot trước hoặc sau commit, không trộn.
- [ ] Viết test initial render chỉ gọi một GET overview, kể cả khi URL thiếu ngày; Edge instrumentation xác nhận một PostgREST request. Timeline refetch chỉ xảy ra sau pagination/zoom.
- [ ] Viết test response công khai không chứa field flight-leg/raw.
- [ ] Viết allowlist test peak-hour chỉ có `hour_bucket`, `bucket_minutes`, `time_basis`, ARR/DEP aggregate; không có scheduled time của từng leg.
- [ ] Viết test small-cell suppression: cell 1-2 leg không lộ ở JSON/UI/export, được gộp/suppress nhất quán; raw reconciliation nội bộ exact và public total tuân thủ threshold/complementary suppression.
- [ ] Viết differencing tests cho các cặp filter công khai dễ suy luận; nếu phép trừ lộ cell 1-2 leg thì broaden `Khác`, complementary-suppress thêm cell hoặc từ chối filter combination đó.
- [ ] Viết test mọi quality count dựa trên leg, gồm `Unknown`/unmapped/missing Pax, đều chịu threshold 3 và complementary suppression.
- [ ] Viết source/import-graph test bảo đảm public root không kéo `AppShell`, `OperatorAuthGate`, `NativeRuntimeGate`, `AppSidebar`, provider desktop, Zustand hoặc Tauri IPC.

**Done:** test contract đỏ trước implementation và mô tả đầy đủ behavior cần xây.

### Task 2 - Aggregate publication API và security boundary

- [ ] Audit duplicate leg xuyên mùa; tài liệu hóa business key và authoritative recency tuple từ server fields/events trên baseline/live schema, không dùng client clock hoặc tên mùa.
- [ ] Áp dụng latest-wins trước khi lọc deleted; xuất reconciliation artifact gồm candidates, winner, recency evidence và quarantine cho tie/missing.
- [ ] Audit route-country Unknown/trùng/sai nhãn trên mapping database hiện tại; giữ `Unknown`, dùng Excel chỉ đối chiếu ngoại lệ và không silently sửa dữ liệu.
- [ ] Audit nguồn Pax để xác định có tín hiệu “đã báo cáo” độc lập với `pax > 0` và có eligibility/exemption cho cargo/ferry hay không; chưa có thì giữ `reported-zero = unknown` và công bố coverage bảo thủ theo D15.
- [ ] Bổ sung typed Ops Date seam kiểu `date`; đẩy date/type/dimension predicate xuống trước enrichment join.
- [ ] Thêm `reporting.get_traffic_report_kpis(...)` cho KPI, comparison, peak day và Pax coverage.
- [ ] Thêm `reporting.get_traffic_report_timeline(...)` dùng `generate_series` + left join, window/cursor/granularity và completeness metadata.
- [ ] Thêm `reporting.get_traffic_report_breakdowns(...)` cho Top 10 + `Khác` theo airline/route/country/aircraft group và ma trận peak-hour ARR/DEP.
- [ ] Thêm `public.get_public_traffic_report_overview_v1(...)` chụp một `data_as_of` rồi gọi ba hàm nội bộ trong một DB round-trip cho initial render.
- [ ] Thêm metadata query cho `min_ops_date`, `max_ops_date`, freshness và contract version.
- [ ] Tạo live aggregate query layer, không tạo snapshot/materialization định kỳ.
- [ ] Không bọc máy móc generic RPC hiện có; kiểm chứng query shape/predicate pushdown và chỉ dùng `MATERIALIZED` khi benchmark không spill.
- [ ] Tạo public Edge Function GET entrypoint chỉ trả aggregate allowlist; initial route gọi wrapper bundle, route timeline/breakdown phục vụ refetch độc lập.
- [ ] Trả `request_hash`, `data_as_of`, `source_watermark`, coverage, comparison status và quality/completeness metadata nhất quán giữa mọi section; watermark không chứng minh được phải là `unknown`.
- [ ] Explicitly `REVOKE EXECUTE` bốn function mới khỏi `PUBLIC`, `anon`, `authenticated`; chỉ grant server role của Edge, đồng thời revoke direct `SELECT` reporting khỏi public roles.
- [ ] Validate date range theo min/max, enum, filter cardinality và response size ở server; không thêm `max_days` chung.
- [ ] Áp dụng threshold 3 sau filter; small cell/cohort trả `suppressed`, gộp/complementary-suppress để không suy ra bằng phép trừ và không đưa exact value vào cache/log.
- [ ] Áp dụng cursor/window pagination và resource policy riêng cho timeline, breakdown, peak-hour và export.
- [ ] Không trả flight number, giờ bay chi tiết, gate/stand/carousel, record ID hoặc provenance.
- [ ] Chuẩn hóa request trước khi hash/cache: explicit defaults, sort/dedupe array, reject unknown/duplicate param và bao phủ filter/zoom/cursor/page/limit/sort trong key; noncanonical external request trả `308 no-store` tới canonical URL.
- [ ] Đặt statement timeout/query budget theo query type và trả lỗi kiểm soát thay vì để truy vấn public chạy vô hạn.
- [ ] Chạy `EXPLAIN (ANALYZE, BUFFERS)` cho min-to-max bundle/KPI và các zoom/page đại diện trước khi thêm index.
- [ ] Thêm index chỉ sau `EXPLAIN ANALYZE`, không đoán index.
- [ ] Trong Task 2, benchmark PostgreSQL và Edge local riêng; ghi p50/p95/p99, cold/warm, concurrency 1/10/30, buffer reads và payload bytes. Nginx/Tunnel benchmark thực hiện sau khi có staging ở Task 9.
- [ ] Đánh giá warm DB full-min-max p95 so với target `<150ms`; Nginx cache-hit target và uncached end-to-end SLO được đo sau khi có staging.
- [ ] Mirror migration vào `schema.sql`.

**Done:** unauthenticated HTTP chỉ lấy được aggregate đã duyệt qua Edge GET; database public roles bị từ chối direct function/reporting/raw access và query không cần season.

### Task 3 - Client data layer và URL contract

- [ ] Tạo type/parser cho filter URL.
- [ ] Lấy min/max và default normalized range từ chính overview response; không gọi metadata trước. Client chỉ validate sơ bộ, server là nguồn chốt clamp/domain.
- [ ] Parse/canonicalize đúng `from`, `to`, `type`, `airline`, `route`, `country`, `comp`, `tz`; sort/dedupe array và loại/reject param lạ theo contract.
- [ ] Canonicalize trên client trước GET đầu để bookmark có param khác thứ tự vẫn chỉ phát một overview request; sau overview thiếu ngày, dùng `history.replaceState` với normalized default mà không refetch.
- [ ] Gọi relative same-origin GET `/api/report/v1/overview` bằng `credentials: 'omit'`, có `AbortSignal`/cancellation và không mang Cookie/Authorization/apikey.
- [ ] Mỗi filter commit chỉ tạo một overview request; không gọi song song ba endpoint từ browser.
- [ ] Không gọi RPC reporting nội bộ trực tiếp từ browser.
- [ ] Ghép timeline pages bằng `ops_date`; giữ `not_loaded/loading` tách khỏi `missing`, và hủy page request cũ khi người dùng zoom/filter nhanh.
- [ ] Cache in-memory theo filter; không tạo durable offline report state.
- [ ] Hiển thị loading, partial, empty và retry riêng biệt.
- [ ] Bảo đảm reload/back/forward/share giữ đúng filter.

**Done:** data layer không phụ thuộc mùa, không race khi đổi filter nhanh và không aggregate 100.000 dòng client-side.

### Task 4 - Public web shell

- [ ] Inventory route tree, hard-coded source-test paths và relative imports trước khi move.
- [ ] Bỏ top-level `app/src/app/layout.tsx`; tạo hai root layouts trong `(desktop)` và `(public-report)` theo route-group pathless, mỗi root sở hữu `html`/`body` hợp lệ.
- [ ] Chuyển home và toàn bộ route desktop vào `(desktop)` mà không đổi URL; root desktop là nơi duy nhất import `AppShell`.
- [ ] Tạo public root layout server-only; `WebReportShell` là server component và `TrafficReportClient` là client island nhỏ nhất có thể.
- [ ] Public import graph không được chạm `OperatorAuthGate`, `NativeRuntimeGate`, `AppSidebar`, `SeasonSyncProvider`, `AppUpdateProvider`, `ExportNotificationProvider`, desktop store, remote store, export-save hoặc `@tauri-apps/*`.
- [ ] Public data client chỉ import contract thuần và gọi relative `/api/report`; không import Supabase client hoặc native/desktop modules.
- [ ] Bọc client island dùng `useSearchParams` trong `Suspense` phù hợp static export; shell/hero HTML nền vẫn render được trước hydration.
- [ ] Giữ các route desktop cũ nguyên URL và behavior; chấp nhận full-page navigation giữa hai root layouts để bảo toàn isolation.
- [ ] Ẩn navigation desktop không phù hợp; thêm header report riêng.
- [ ] Không render form login, operator profile hoặc native sync controls trên report công khai.
- [ ] Client chỉ dùng relative API path đã version hóa; fail build/deploy nếu contract version hoặc route manifest bị thiếu.
- [ ] Source test xác nhận không còn top-level layout, cả hai group layout có root `<html>/<body>`, desktop layout là nơi duy nhất import `AppShell`, public layout không có `'use client'`.
- [ ] Resolve static import graph đệ quy từ public layout/page/shell và fail khi gặp sentinel desktop/native/Zustand.
- [ ] Parse `out/reports/traffic.html` và referenced chunks; phải có `traffic-report-root` và không có `Native app required`, `Checking operator session`, `appSidebarCollapsed`, `season-sync` hoặc Tauri sentinel.
- [ ] Browser smoke khi không có `window.__TAURI_INTERNALS__`: report render, không sidebar/auth/native warning, không console error hoặc request native/updater.
- [ ] Tauri smoke `/`, `/seasonal`, `/dashboard` sau route migration.

**Done:** route report mở được không cần tài khoản, chỉ gọi public aggregate API và native regression vẫn pass.

### Task 5 - UI foundation và continuous chart

- [ ] Dựng semantic visual tokens và responsive grid: Navy `#081322`, Cyan `#00B4D8`/`#42C1C7`, Cobalt `#234093`, contrast AA và typography hỗ trợ tiếng Việt.
- [ ] Dựng hero theo tinh thần ACI Annual Report với display number tối đa 70px, headline tối đa 60px và `clamp()` cho mobile.
- [ ] Dựng Executive Summary 3-4 insight deterministic, cùng filter/`data_as_of`; không dùng LLM và thay insight bằng cảnh báo khi comparison/coverage không đủ.
- [ ] Dựng freshness badge và filter sticky.
- [ ] Dựng KPI band tối đa 5-6 card, pill delta có nhãn kỳ so sánh và Pax coverage/leg numerator-denominator.
- [ ] Dựng hai chart daily đồng bộ cho chuyến và Pax.
- [ ] Vẽ đúng trạng thái `0`, `missing`, `partial`, `suppressed`, `future`; transport state `not_loaded/loading` không được đổi thành trạng thái dữ liệu.
- [ ] Thêm tooltip, keyboard table và reduced-motion.
- [ ] Thêm overview/brush và zoom window; tải thêm date pages mà không đổi range đã chọn.
- [ ] Thêm skeleton sau ngưỡng ngắn; không để chart trắng khi tải.
- [ ] Kiểm tra viewport 375, 768, 1024 và 1440px.

**Done:** dãy ngày luôn liên tục, mobile không tràn ngang và mọi trạng thái dữ liệu có thể hiểu được.

### Task 6 - Breakdown aggregate và phương pháp

- [ ] Airline/route/country Top 10 + `Khác` và bảng đầy đủ sau small-cell/complementary suppression.
- [ ] Peak-hour 30/60 phút, Local/UTC.
- [ ] Aircraft/ac_group, chưa có seat config.
- [ ] Click ngày mở breakdown aggregate với filter rõ ràng.
- [ ] Bảng aggregate có sort; raw/internal grand total exact, public total tuân thủ threshold/complementary suppression; suppressed cell không lộ qua sort/search/tooltip/export và không có route/API tới flight leg.
- [ ] Panel data quality không giấu trạng thái Unknown/missing/duplicate, nhưng mọi leg-based count 1-2 phải hiện `suppressed` thay vì exact value.
- [ ] Phần methodology ghi đủ định nghĩa KPI và data freshness.

**Done:** người xem đi được từ KPI -> xu hướng -> breakdown aggregate mà không mất context hoặc thấy dữ liệu flight-leg.

### Task 7 - Export và đối soát workbook

- [ ] Tạo GET `/api/report/v1/export` với format/dimension/cursor/page-size allowlist; chỉ trả aggregate đã suppress và luôn `Cache-Control: no-store`.
- [ ] Export XLSX/CSV aggregate dùng cùng request/filter với UI; browser lấy từng page/chunk có cancellation rồi tạo file, không dùng native/Tauri export path.
- [ ] Rate-limit/query budget export riêng; không dùng POST/job trong phase 1 và không áp dụng max-days chung.
- [ ] Tên file chứa `from-to` và thời điểm sinh.
- [ ] Dùng `operational_date`, không dựng lại Ops Date từ `record.date`.
- [ ] Không tạo sheet raw flight data hoặc field ngoài publication allowlist.
- [ ] Không quảng bá native pivot nếu export không giữ pivot XML.
- [ ] Đối soát ít nhất ba lát: một ngày, một tuần và một range xuyên mùa.
- [ ] Dùng lát mẫu 01-07/05/2026 làm checkpoint lịch sử: 838 chuyến và 141.687 Pax; nếu live DB khác phải giải thích bằng provenance/timestamp, không ép số.

**Done:** UI, API, SQL và export khớp theo cùng một contract; mọi chênh lệch có biên bản.

### Task 8 - Host, tunnel và deployment

- [ ] Build static export và kiểm tra artifact `/reports/traffic`.
- [ ] Tạo Nginx config có HTTPS upstream nội bộ phù hợp, cache immutable assets và no-cache HTML.
- [ ] Chỉ public route report và asset cần thiết; các route desktop khác trong `app/out` phải trả 404 từ hostname report.
- [ ] Proxy public GET `/api/report/v1/{overview,timeline,breakdowns,export}` tới Edge Function qua loopback/private upstream nếu có; export `no-store`, không expose hoặc cache direct PostgREST POST RPC.
- [ ] Nếu Edge upstream không private, cấu hình origin credential riêng hoặc mTLS giữa Nginx và Edge; direct Edge URL thiếu credential trả lỗi `no-store` và không thể bypass WAF/rate limit.
- [ ] Thêm CSP và security headers; không nới `connect-src` ra ngoài allowlist.
- [ ] Cấu hình deep-link refresh cho static route.
- [ ] Thêm named-tunnel ingress `reports.ahtops.xyz -> Nginx`, không dùng quick tunnel.
- [ ] Không đặt Cloudflare Access/login challenge trước hostname report; WAF chặn method ngoài GET/HEAD và rate-limit theo cost endpoint, không trả challenge HTML cho XHR API.
- [ ] Chọn Nginx là shared-cache owner duy nhất; Cloudflare Cache Rule bypass toàn bộ `/api/report` để không cộng dồn TTL/SWR.
- [ ] Với response 200 cacheable, trả `Cache-Control: public, max-age=60, stale-while-revalidate=30, stale-if-error=0`; chỉ cache GET/HEAD overview/timeline/breakdowns và không serve stale khi origin lỗi. Export 200 vẫn `no-store`.
- [ ] Mọi 4xx/429/5xx trả `Cache-Control: no-store`, không ghi đè cached 200; 429 có `Retry-After`.
- [ ] Cấu hình Nginx fresh cache 60 giây với `proxy_cache_use_stale off` và `proxy_cache_background_update off`; SWR 30 chỉ do browser thực hiện. Không bật stale cho updating/timeout/error/5xx và không dùng Always Online trên API.
- [ ] Cache key gồm versioned path và canonical query string chứa toàn bộ filter/zoom/cursor/page/limit/sort. Chỉ canonical request được nhận 200/cache; noncanonical request nhận `308 no-store` tới cùng canonical URL, filter khác không collision.
- [ ] Strip Cookie/Authorization/apikey trước upstream; response không có `Set-Cookie`, secret hoặc raw fields.
- [ ] Expose/ghi log an toàn `Age`, `X-Cache-Status`, `generated_at`, `data_as_of`; không coi `cache_age_seconds` tại origin là tuổi thực của shared cache.
- [ ] Lưu secrets trong GitHub/server secret store; repo chỉ có template/fingerprint.
- [ ] Deploy vào thư mục versioned và đổi symlink/pointer atomically.
- [ ] Ghi previous artifact để rollback.
- [ ] Chỉ tạo workflow tự động sau khi manual staging deploy và rollback đã pass.

**Done:** link công khai chạy qua tunnel, deep link/refresh/public API/rate limit hoạt động và rollback được chứng minh.

### Task 9 - Verification và acceptance

- [ ] Chạy `npm run test:dashboard-contract`.
- [ ] Chạy test mới cho traffic report.
- [ ] Chạy `npm run test:rules`.
- [ ] Chạy `npm run lint`.
- [ ] Chạy `npx tsc --noEmit --pretty false`.
- [ ] Chạy `npm run build`.
- [ ] Chạy `npm run native:build` vì thay đổi root layouts/route placement có thể ảnh hưởng Tauri route resolution.
- [ ] Smoke anonymous public API thành công nhưng direct reporting schema/RPC nội bộ bị từ chối.
- [ ] Chứng minh initial load/filter commit chỉ có một overview request, không có metadata preflight; wrapper và ba internal section có cùng `request_hash`/`data_as_of`/MVCC snapshot.
- [ ] Smoke field allowlist: response/export không chứa raw flight fields.
- [ ] Smoke export GET phân trang sinh CSV/XLSX đúng filter/suppression, response `no-store`; POST/job/direct RPC export bị từ chối.
- [ ] Smoke HTML, assets, deep-link refresh, public API, cache HIT/MISS/SWR, 400/429 và same-origin qua tunnel.
- [ ] Chứng minh param order canonical dùng cùng cache key; filter khác không collision; response lỗi không được cache.
- [ ] Test biên cache Age 59/60 tại Nginx và tổng tuổi browser 89/90 giây; khi upstream treo/lỗi ở lúc Nginx hết hạn, Nginx không được phục vụ stale và không response nào vượt cửa sổ 90 giây.
- [ ] Chứng minh thay đổi đã khả kiến trong reporting source xuất hiện trên report trong tối đa 90 giây theo policy 60s fresh + 30s SWR; kiểm tra `source_watermark` hoặc ghi rõ trạng thái `unknown`.
- [ ] Ghi riêng benchmark DB/Edge/Nginx/Tunnel/browser; báo pass/fail warm DB p95 và Nginx cache-hit p95 target `<150ms`, không đồng nhất với uncached Internet SLO.
- [ ] Smoke range toàn bộ `min_ops_date` đến `max_ops_date`: KPI hoàn tất; timeline/breakdown tải theo page/zoom mà không hở hoặc trùng bucket.
- [ ] Kiểm tra bundle không chứa service-role key, tunnel token hoặc server secrets.
- [ ] Smoke direct Edge origin thiếu origin credential bị từ chối; public same-origin route qua Nginx vẫn thành công và origin credential không xuất hiện ở browser/log bàn giao.
- [ ] Kiểm tra keyboard, focus, contrast AA, reduced-motion và screen-reader table.
- [ ] Quét mojibake trên toàn bộ file thay đổi.
- [ ] `git diff --check` và xác nhận chỉ file trong scope bị đổi.

**Done:** tất cả automated checks pass, đối soát dữ liệu pass và có bằng chứng staging qua tunnel. Passing tests không thay thế phê duyệt người dùng.

### Task 10 - Rollout, theo dõi và tài liệu

- [ ] Cập nhật `context.md` với contract Ops Date/date-range/reporting access.
- [ ] Cập nhật `architecture.md` nếu cần.
- [ ] Hoàn thiện runbook deploy/rollback/tunnel.
- [ ] Ghi owner, thời điểm deploy, commit, artifact hash và config fingerprint.
- [ ] Theo dõi public API latency/error/rate-limit, cache hit, freshness, missing days và tunnel health sau rollout.
- [ ] Chỉ công bố production sau khi người dùng nghiệm thu staging.

**Done:** production rollout có owner, evidence, monitoring và rollback path.

## Tiêu chí nghiệm thu dữ liệu

1. `total_flights = arrivals + departures` cho mọi filter.
2. Đối soát nội bộ trước suppression: tổng theo airline/route/country bằng tổng toàn kỳ khi giữ `Unknown`. Ở response công khai, các bucket exact + `Khác` bằng grand total khi cohort tổng đủ 3 leg; cohort nhỏ trả `suppressed`.
3. Date spine có đúng số ngày từ `from_date` đến `to_date`, inclusive.
4. `min_ops_date` và `max_ops_date` khớp direct SQL; mọi range nằm trong biên được chấp nhận bất kể số ngày.
5. Ngày 0 chuyến khác trực quan và ngữ nghĩa với ngày thiếu dữ liệu.
6. Test 04:59/05:00 cho đúng `Ops Date`.
7. Deleted không xuất hiện; added/modified dùng phiên bản hiệu lực. Nếu cross-season winner mới nhất là tombstone/deleted, bản cũ không được hồi sinh.
8. Range đi qua tối thiểu hai mùa không bị ngắt hoặc double-count.
9. Duplicate xuyên mùa chọn đúng candidate có authoritative server recency tuple mới nhất và có reconciliation evidence; hòa/thiếu recency bị quarantine, không tie-break ngẫu nhiên.
10. Pax không biến planned/missing thành hành khách thực tế; coverage luôn đi cùng KPI Pax và dùng đúng mẫu số leg hiệu lực đã đến hạn T+1 theo giờ local.
11. ISO week duy nhất; UI/export không tự tính tuần khác database.
12. CTG nội bộ của breakdown exhaustive khớp thay đổi tổng; CTG công khai ghi rõ khi complementary suppression khiến decomposition không exhaustive.
13. UI, API, publication SQL sau suppression và export khớp ở các lát nghiệm thu; raw/internal SQL được giữ thành artifact đối soát riêng, không công bố.
14. Timeline pagination/zoom không mất hoặc trùng ngày; tổng nội bộ trước suppression của các trang/bucket khớp KPI cùng filter, còn public series giữ marker `suppressed` thay vì bịa exact value.
15. Aggregate table/export không mất/trùng bucket và không chứa raw flight fields.
16. Mỗi query type tuân thủ timeout/payload/group/page budget đã công bố; không có `max_days` chung.
17. Unauthenticated browser gọi được public Edge GET; database role `anon` không execute được bốn function mới và không đọc được reporting view/table.
18. Wrapper overview và ba section nội bộ dùng cùng normalized filter, `request_hash`, `data_as_of` và MVCC snapshot đã được concurrency-test; initial render/filter commit chỉ có một browser request, một Edge-to-PostgREST request và một DB round-trip.
19. Kỳ so sánh ngoài data domain trả `partial`/`unavailable`, không clamp hoặc biến thành 0.
20. “Đã báo cáo 0 Pax” chỉ được tính là reported khi có tín hiệu nguồn độc lập; nếu chưa có thì contract trả `unknown`.
21. Sau khi thay đổi đã commit và khả kiến trong reporting source, live aggregate phản ánh thay đổi trong tối đa 90 giây theo policy fresh 60 giây + SWR 30 giây; `source_watermark` đổi tương ứng hoặc khai báo rõ `unknown`, không cần chạy job snapshot.
22. Cache key không collision giữa filter/zoom/page khác nhau; request không chuẩn nhận `308 no-store` tới URL canonical, URL canonical tương đương dùng cùng cache entry và response lỗi không được cache.
23. Benchmark tách DB, Edge, Nginx, Tunnel và browser; target `<150ms` được kết luận riêng cho warm DB/cache-hit, không được báo như uncached end-to-end SLA khi chưa có số đo.
24. Mọi cohort/cell 1-2 leg trả `suppressed` hoặc được gộp/complementary-suppress; exact value không thể đọc từ một API/UI/tooltip/export response hoặc suy ra trực tiếp từ grand total.
25. Bộ differencing test đại diện không suy ra được small cell qua hai request được phép; trường hợp không bảo vệ được phải broaden bucket hoặc chặn filter combination. Phase 1 không tuyên bố differential privacy hình thức.
26. Peak-hour chỉ trả bucket aggregate 30/60 phút; mọi quality count dựa trên 1-2 leg, kể cả `Unknown`/unmapped/missing Pax, bị suppress nhất quán.

## Tiêu chí nghiệm thu UX

- Không có filter, preset hoặc query parameter mùa.
- Date picker dùng đúng `min_ops_date`/`max_ops_date`; không áp dụng max-days cứng.
- Không bỏ ngày trên trục daily.
- Pan/zoom và tải thêm trang không làm thay đổi range đã chọn hoặc tạo khoảng hở giả.
- Filter URL có thể chia sẻ và phục hồi chính xác đủ `from`, `to`, `type`, `airline`, `route`, `country`, `comp`, `tz`.
- Phần trăm thay đổi luôn có nhãn kỳ so sánh.
- Hero dùng Navy/Cyan/Cobalt đúng semantic role; headline/display number co giãn bằng `clamp()` và không tràn ở mobile.
- Executive Summary có 3-4 insight theo quy tắc, cùng filter/`data_as_of`, không có nội dung LLM hoặc khẳng định tăng trưởng khi comparison/coverage không đủ.
- KPI Pax luôn kèm coverage; pill delta dùng chữ/icon và nhãn kỳ, không truyền nghĩa chỉ bằng màu.
- Loading có skeleton; error có retry; empty có lý do; partial có cảnh báo.
- `suppressed` có nhãn/legend riêng, không bị hiển thị như `0`, `missing` hoặc `partial`.
- Mobile 375px không có horizontal overflow.
- Có đường dùng hoàn chỉnh bằng bàn phím.
- Contrast AA và reduced-motion pass.
- Chart có bảng thay thế; màu không phải tín hiệu duy nhất.
- Style gợi tinh thần ACI nhưng dùng brand/assets riêng.
- Public bundle không chứa text/chunk/sentinel desktop hoặc Tauri; browser không có Tauri runtime vẫn mở report bình thường.
- Route desktop giữ URL/behavior sau khi chuyển vào `(desktop)` và Tauri native smoke pass.

## Security gate

- Không service-role trong frontend, workflow log hoặc tài liệu; nếu cần ở Edge Function thì chỉ nằm trong server secret store.
- Public HTTP chỉ mở GET gateway; `PUBLIC`, `anon`, `authenticated` không có quyền execute ba RPC `reporting.*`/wrapper DB hoặc đọc reporting schema/view/table.
- API và export chỉ trả field được publication allowlist; không có raw flight detail.
- Rate limit, cache policy, filter cardinality, response-size, cursor/page/window và timeout được cấu hình theo query type ở server boundary.
- Date validation chỉ dùng thứ tự ngày và `[min_ops_date, max_ops_date]`, không dùng giới hạn cứng theo số ngày.
- Public endpoint không nhận SQL fragment, column list hoặc tên relation từ client.
- Public client dùng same-origin GET với `credentials: 'omit'`; Nginx không forward Cookie, Authorization hoặc apikey và response không có `Set-Cookie`.
- Chỉ cache HTTP 200; 4xx/429/5xx luôn `no-store`; direct RPC POST và method ngoài GET/HEAD bị từ chối tại public route.
- Aggregate cell dưới 3 leg phải được suppress hoặc gộp vào `Khác` nhất quán ở API/UI/tooltip/export; bucket bị suppress phải giữ total reconciliation rõ ràng.
- Edge upstream chỉ nhận traffic qua private network hoặc origin auth/mTLS; direct origin không thể bỏ qua Cloudflare/Nginx guard. Origin credential tách biệt service-role và không đi xuống browser.
- Cloudflare Tunnel không expose Postgres, admin port hoặc Supabase Studio.
- API hostname hiện tại không bị Cloudflare Access chặn desktop app.

## Rollback

1. Gỡ/disable route DNS hoặc tunnel ingress của report, không đụng `supabase.ahtops.xyz`.
2. Đổi Nginx pointer về static artifact trước đó.
3. Revert frontend commit nếu lỗi web shell ảnh hưởng native app.
4. Revoke quyền execute RPC mới.
5. Chỉ drop function/view mới bằng migration rollback đã review; không xóa dữ liệu nguồn.
6. Giữ log, reconciliation artifact và nguyên nhân rollback để sửa ở release sau.

## Rủi ro và biện pháp

| Rủi ro | Biện pháp |
|---|---|
| Trùng leg tại ranh giới mùa | Business key + authoritative server recency; latest-wins có evidence, tombstone xét trước lọc deleted, tie/missing mới quarantine |
| `Pax = 0` bị hiểu sai | D3 + `pax_status` + coverage + quality state |
| Route-country sai/trùng | Giữ `Unknown`, lập master canonical riêng trước công bố |
| Browser bị `NativeRuntimeGate` chặn | Web shell riêng và source regression test |
| Root-layout migration làm hỏng route desktop/Tauri | Hai route-group pathless, inventory route trước move, static artifact test và native smoke cho route đại diện |
| Client tải quá nhiều dữ liệu | Aggregate, cursor pagination, zoom window, payload cap, cache và request cancellation |
| Ba RPC tạo ba round-trip hoặc lệch snapshot | Wrapper overview gọi ba hàm trong một DB call, chụp `data_as_of` một lần và contract-test `request_hash` |
| Bundle full-range quá lớn | KPI/breakdown full-range nhưng timeline initial chỉ overview/visible window; zoom/page tải độc lập và khai báo `complete` |
| Query bundle scan/enrichment nhiều lần | Typed date, predicate pushdown, `EXPLAIN (ANALYZE, BUFFERS)`; chỉ dùng materialization/index sau benchmark spill/buffer |
| Mục tiêu `<150ms` bị hiểu thành SLA chưa chứng minh | Tách target warm DB/cache-hit khỏi uncached end-to-end SLO và ghi p50/p95/p99 theo từng lớp |
| Cache 60s + SWR 30s bị hiểu là freshness 60s | Công bố tuổi tối đa 90s, kiểm thử Age/SWR; nếu sau này cần strict 60s phải đổi policy và sổ quyết định |
| Nginx và Cloudflare cùng cache làm cộng dồn độ cũ | Nginx là cache owner duy nhất, Cloudflare bypass `/api/report`, smoke config trước/sau deploy |
| Cache key bỏ sót filter hoặc lỗi bị cache | Canonical key bao phủ toàn bộ param ngữ nghĩa; chỉ cache 200; collision/error-cache tests |
| Attacker gọi thẳng Edge để bypass WAF/cache | Private upstream ưu tiên; nếu không có thì origin auth/mTLS riêng, firewall và direct-origin negative smoke |
| Public endpoint làm lộ dữ liệu vận hành | Publication allowlist, không raw row, contract test và response scan |
| Public endpoint bị lạm dụng | WAF/rate limit, query-type budgets, filter/group/page caps, cache và monitoring; không dùng max-days chung |
| Tunnel/API xung đột | Hostname riêng, inventory ingress, smoke API trước/sau deploy |
| Static deep link 404 | Nginx `try_files`/directory index và tunnel smoke |
| Checkout hiện tại cũ | Worktree sạch từ `origin/main`, re-audit trước code |
| Copy thiết kế ACI quá sát | Dùng visual principles, assets và brand riêng |

## Bằng chứng bàn giao bắt buộc

- Commit và danh sách file trong scope.
- Kết quả tests/lint/typecheck/build/native regression.
- SQL reconciliation cho ba lát dữ liệu.
- Screenshot desktop/mobile và accessibility checklist.
- HTTP/tunnel/public API/cache/rate-limit smoke log đã lược bỏ secrets.
- Static artifact hash và deployed version.
- Nginx/cloudflared config fingerprint, không chứa token.
- Rollback rehearsal result.
- Phê duyệt nghiệm thu của người dùng.

## Tài liệu nguồn

- `docs/superpowers/plans/2026-06-23-operational-dashboard-replacement.md`
- `docs/superpowers/plans/2026-06-22-selfhosted-server-cloudflare-cutover.md`
- `docs/runbooks/selfhosted-cloudflare-cutover.md`
- `docs/handoffs/20260623_dashboard_reporting_database_handoff.md`
- `docs/ai-report-export-guide.md`
- `docs/report_ref/BaoCaoSanLuong.xlsm`
- `docs/report_ref/SanLuong_S26.xlsm`
- `docs/report_ref/SanLuong_Week_S26.xlsx`
- Looker Studio report tham khảo: <https://datastudio.google.com/reporting/97416087-8c24-4a11-a8b2-6ac2973ae788/page/p_ip1yzwwo2c>
- ACI Asia-Pacific editorial reference: <https://www.aci-asiapac.aero/media-centre/perspectives/travel-retail-at-airports-the-economics-of-terminal-space>
- ACI Annual Report 2025 visual reference: <https://aciannualreport2025.aci.aero/stateofglobalaviation/>
- Next.js Route Groups và multiple root layouts: <https://nextjs.org/docs/14/app/building-your-application/routing/route-groups>
- Cloudflare cache revalidation/SWR: <https://developers.cloudflare.com/cache/concepts/revalidation/>
- Cloudflare default cache behavior: <https://developers.cloudflare.com/cache/concepts/default-cache-behavior/>
- Cloudflare Cache-Control semantics: <https://developers.cloudflare.com/cache/concepts/cache-control/>
- Nginx `proxy_cache_methods`: <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_methods>
- Nginx `proxy_cache_use_stale`: <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_cache_use_stale>

## Execution recommendation

Thực hiện theo vertical slices có thể nghiệm thu độc lập:

1. Contract + ba internal RPC + overview wrapper + SQL daily series + reconciliation CLI/test.
2. Hai route-group root layouts + public GET API + một KPI và continuous daily chart chạy end-to-end bằng đúng một initial overview request.
3. Breakdown aggregate + quality panel.
4. Export theo cùng contract.
5. Staging host/tunnel + security/rollback.
6. Visual polish và production rollout.

Không bắt đầu slice 2 nếu slice 1 chưa chứng minh được date spine xuyên mùa và phân biệt `zero`/`missing`.
