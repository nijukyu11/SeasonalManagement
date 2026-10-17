# Kế hoạch chuyển đổi báo cáo sản lượng sang HTML offline

Ngày lập: 2026-09-05.  
Trạng thái: Hợp đồng HTML đã được duyệt; đã triển khai ba mẫu và kiểm thử local. Còn nghiệm thu dữ liệu thực tế/người dùng trước production. Không thay schema nghiệp vụ, materialized view hoặc manifest Excel.  
Workspace tài liệu: `C:\Users\tuan\Documents\SeasonalManagement`.  
Workspace triển khai chính: `C:\Users\tuan\Documents\SeasonalManagement-web-traffic-report\app`.

## 1. Mục tiêu và phạm vi đã thống nhất

Tạo báo cáo dưới dạng một file `.html` tự chứa, mở trực tiếp bằng trình duyệt khi không có mạng. Người dùng chia sẻ đầy đủ dữ liệu tổng hợp trong phạm vi đã xuất.

Báo cáo có các bảng thiết kế sẵn, mô phỏng cách đọc PivotTable: bung/thu gọn nhóm, lọc, tìm kiếm và sắp xếp. Cấu trúc hàng, cột, cấp nhóm và công thức chỉ tiêu do hệ thống định nghĩa cố định.

Các chỉ tiêu sản lượng chính phải xem và so sánh được theo:

- Chuyến bay: Đến, Đi, Tổng.
- Hành khách: Đến, Đi, Tổng.
- Kỳ hiện tại, các kỳ đối chiếu đã xuất, chênh lệch tuyệt đối và phần trăm.
- Pax thiếu/null tiếp tục là thiếu dữ liệu; không tự đổi thành `0` hoặc suy đoán từ cấu hình ghế.

### Trong phạm vi

- Ba mẫu HTML: Tuần chi tiết, Phân tích theo kỳ, Báo cáo sản lượng theo mẫu.
- Chế độ báo cáo tháng trong mẫu Phân tích theo kỳ để giữ nội dung Monthly Overview L2.
- Bảng và biểu đồ liên quan có bộ lọc cố định theo từng tab.
- Đóng/mở nhóm nhiều cấp; chọn mức chi tiết; tìm kiếm; sắp xếp; cố định tiêu đề/cột tên nhóm.
- Một file chứa dữ liệu, CSS, JavaScript và biểu đồ; không dùng CDN, API hoặc tài nguyên ngoài khi đọc.
- Chế độ in bằng trình duyệt cho tab hiện tại, có phạm vi/chỉ tiêu/chiều/kỳ đối chiếu đang chọn.
- Giữ xuất Excel hiện có trong giai đoạn chuyển tiếp; không sửa trực tiếp file mẫu.

### Ngoài phạm vi

- Pivot tùy chỉnh; kéo thả trường; đổi trục hàng/cột; tự tạo chỉ tiêu hoặc công thức.
- Lọc chéo toàn bộ tab, dashboard builder, chỉnh dữ liệu hoặc lưu ngược vào hệ thống.
- Mở thêm ngày/năm chưa được nhúng vào file; cập nhật số liệu tự động khi mở offline.
- Chạy VBA, Power Query, Excel PivotCache hoặc macro trong trình duyệt.
- Bung tới raw flight leg/history hoặc cho tải dữ liệu bị loại trừ khỏi nguồn reporting.
- Tạo lại XLSX từ trạng thái HTML, tạo PDF server-side, lưu báo cáo cá nhân hoặc chia sẻ trạng thái đang lọc.
- Bổ sung báo cáo 30 phút, cấu hình ghế, dữ liệu nguyên nhân hoặc sự kiện chưa được chốt nguồn.

## 2. Quan hệ với kế hoạch Excel và ranh giới phê duyệt

Tài liệu liên quan:

- [Workbook Master và Monthly L2](./2026-09-03-workbook-master-monthly-operations-level-2.md).
- [Period Analysis và BaoCaoSanLuong public](./2026-09-04-period-analysis-bao-cao-san-luong-workbooks.md).
- File mẫu tại `docs/report_ref`; giữ nguyên nội dung và fingerprint.

Kế hoạch này bổ sung đầu ra HTML. Việc gom các mẫu HTML không tự động xóa, đổi tên, ẩn hoặc thay thế các report type/manifest Excel hiện có.

Chỉ thực hiện triển khai sau khi người dùng yêu cầu. Trước khi cần thay đổi schema, API contract, materialized view, template manifest hoặc chiến lược export khác với tài liệu này, trình diff/đề xuất cụ thể và dừng phần phụ thuộc để chờ duyệt. Không coi việc tạo file kế hoạch là quyền sửa các thành phần đó.

Phê duyệt đã có phải được kiểm tra trong hội thoại tại thời điểm triển khai; không hỏi lại cho cùng một quyết định đã được chấp thuận. Production là bước riêng sau khi có bản nghiệm thu cụ thể và quyền triển khai phù hợp.

## 3. Baseline cần kiểm tra lại trước khi code

Các điểm nối hiện có đã xác nhận khi lập kế hoạch:

| Thành phần | File/thư mục tính từ workspace triển khai |
|---|---|
| Chọn và chuẩn hóa kỳ xuất | `src/lib/trafficWorkbookExportContract.ts` |
| Dialog export | `src/app/(public-report)/reports/traffic/TrafficWorkbookExportDialog.tsx` |
| Lấy overview, dimension, các kỳ | `supabase/functions/traffic-report/index.ts` |
| Model và phép gom kỳ | `supabase/functions/_shared/trafficWorkbookCore.ts` |
| Renderer Excel | `supabase/functions/_shared/trafficWorkbookRenderer.ts` |
| Export Excel cũ | `src/lib/trafficReportExcelExport.ts` |
| Manifest Excel | `report-templates/*/v1/manifest.json` |
| Test workbook | `src/lib/trafficWorkbookExport.test.ts` |
| Test Edge/isolation | `scripts/traffic-report-edge-contract.test.mjs`, `scripts/traffic-report-isolation-test.mjs` |

Worktree có các thay đổi đang tồn tại. Trước mỗi bước triển khai phải kiểm tra trạng thái hiện tại, bảo toàn công việc khác và phối hợp nếu file đang được sửa trong task khác.

Audit trước đã ghi nhận các vấn đề sau; cần tái hiện bằng code hiện tại trước khi sửa vì main task có thể đã thay đổi:

1. Nhóm chỉ có ở tuần trước/sau bị lấy metrics của kỳ đó làm metrics hiện tại.
2. Bình quân kỳ so sánh dùng số ngày kỳ hiện tại.
3. Gom tháng/tuần biên dùng số ngày trọn kỳ mặc dù chỉ chọn một phần.
4. Có cột Pax Đến/Đi nhưng thiếu trường tương ứng trong timeline/dimension hoặc bị mất khi gom model.
5. Nhóm chỉ có ở kỳ đối chiếu bị bỏ khỏi một số bảng.
6. Chiều chênh lệch khác nhau giữa các report, thiếu đối soát Pax và tổng chi tiết.

Các phát hiện này là đầu vào kiểm tra, không phải xác nhận mới về production. Audit trước chưa đọc được API production do HTTP 403.

## 4. Mapping chuyển đổi các workbook

| Workbook hiện tại | Mẫu HTML | Nội dung bảo toàn |
|---|---|---|
| `MASTER_OPERATIONS` | Phân tích theo kỳ | Tổng quan, ngày/tháng/tuần, hãng, thị trường, chặng, AC, giờ và tần suất |
| `MONTHLY_OVERVIEW_L2` | Phân tích theo kỳ — chế độ tháng | Tóm tắt, tháng trước/cùng kỳ, ngày/giờ cao điểm, ghi chú có nguồn |
| `WEEKLY_DETAIL` | Tuần chi tiết | Kỳ chọn + đúng 7 ngày trước + đúng 7 ngày sau |
| `PERIOD_ANALYSIS` | Phân tích theo kỳ | Một/nhiều tháng, mùa, năm, custom; nhiều năm đối chiếu |
| `BAO_CAO_SAN_LUONG` | Báo cáo sản lượng theo mẫu | TOTAL, WEEKLY, tháng, Analysis Airline/Country |
| Excel 6 sheet cũ | Giữ trong chuyển tiếp | Không đổi hành vi chỉ để phục vụ HTML |

### Vai trò các file reference

| File trong `report_ref` | Áp dụng vào HTML |
|---|---|
| `SanLuongAPR.xlsx` | Bố cục CB/HK với Đến/Đi/Tổng cho bảng sản lượng |
| `SanLuong_Week_S26.xlsx` | Bảng tuần, ngày, nhóm hãng/thị trường/chặng; phân biệt tuần nghiệp vụ và ISO |
| `SanLuong_Country_2026.xlsx` | Phân cấp Country → Route → Airline theo kỳ |
| `SanLuong_S26.xlsm`, `SanLuong_S26 - Copy.xlsm` | Bảng mùa/tháng, AC, giờ, tần suất; chỉ chuyển các bảng thuộc phạm vi ở mục 5 |
| `BaoCaoSanLuong.xlsm` | Cách đọc TOTAL, WEEKLY, tháng và hai bảng Analysis |

Không nhúng các sheet Data/Table1, Change Log, bản sao drill-down hoặc nguồn liên kết bên ngoài. Các phần tham chiếu nằm ngoài MVP phải được ghi rõ trong biên bản mapping, không đánh dấu đã chuyển toàn bộ file mẫu.

## 5. Đặc tả bảng cố định

### 5.1. Phân tích theo kỳ

| Tab | Cấp nhóm cố định | Bộ lọc dữ liệu trong tab | Nội dung chính |
|---|---|---|---|
| Tổng quan | Chỉ tiêu và kỳ | Kỳ đối chiếu đã nhúng | Sáu chỉ tiêu; chênh lệch và % |
| Theo thời gian | Tháng → Ngày; chế độ tuần là cây riêng | Tháng hoặc tuần có trong file | Sản lượng theo thời gian, phạm vi từng kỳ rõ ràng |
| Hãng hàng không | Airline → Route | Airline, Route | Giá trị, tỷ trọng, so sánh |
| Thị trường | Country → Route → Airline | Country, Route, Airline | Giá trị, tỷ trọng, so sánh |
| Chặng bay | Route → Airline | Route, Airline | Giá trị, tỷ trọng, so sánh |
| Tàu bay | AC Group → AC Type | AC Group, AC Type | Giá trị, tỷ trọng, so sánh |
| Giờ khai thác | Khung giờ cố định | Khung giờ | Sản lượng và bình quân; Pax cần nguồn phù hợp |
| Tần suất | Airline → Route → Số hiệu | Airline, Route | Tần suất, ngày hoạt động; không suy diễn Pax |

Chế độ tháng có thêm các phần Tóm tắt tháng, Ngày cao điểm và Giờ cao điểm. Ghi chú nghiệp vụ/chuyến bay sớm chỉ có nội dung khi có nguồn xác nhận; không tạo nội dung giả để lấp đủ tab.

Top ngày/nhóm theo CB và HK phải xếp hạng độc lập. Khả năng so sánh chi tiết từng ngày giữa các kỳ chưa bao gồm trong MVP: hiển thị ngày thật của mỗi kỳ, không tự ghép ngày thứ N thành ngày tương đương.

### 5.2. Tuần chi tiết

| Tab | Cấp nhóm cố định | Nội dung |
|---|---|---|
| Tổng quan | Chỉ tiêu | Trước/chọn/sau và hai cặp so sánh |
| Theo ngày | Giai đoạn → Ngày | Sáu chỉ tiêu; ngày của ba giai đoạn |
| Airline | Airline → Route | Sản lượng, tỷ trọng, chênh lệch |
| Country | Country → Route → Airline | Sản lượng, tỷ trọng, chênh lệch |
| Route | Route → Airline | Sản lượng, tỷ trọng, chênh lệch |
| Tàu bay | AC Group → AC Type | Sản lượng, tỷ trọng, chênh lệch |

Kỳ chọn có thể khác bảy ngày. Trình bày ngày bắt đầu/kết thúc và số ngày của cả ba giai đoạn; tổng sản lượng và bình quân/ngày là hai chỉ tiêu riêng. Dữ liệu tương lai phải phân biệt với sản lượng thực tế; Pax chưa có không được suy đoán.

### 5.3. Báo cáo sản lượng theo mẫu

| Tab HTML | Sheet tham chiếu | Cấp nhóm và nội dung |
|---|---|---|
| Tổng hợp | TOTAL | Tháng → Ngày, sáu chỉ tiêu |
| Theo tuần | Bảng WEEKLY trong TOTAL của mẫu gốc; sheet WEEKLY của export hiện hành | Tuần Thứ Sáu–Thứ Năm → Ngày |
| Theo tháng | Các sheet tháng | Bộ chọn tháng, bảng sáu chỉ tiêu và biểu đồ |
| Phân tích Airline | Analysis_Airline | Cặp tuần so sánh → Airline; CB/HK theo chiều |
| Phân tích Country | Analysis_Country | Cặp tuần so sánh → Country; CB/HK theo chiều |

Tạo danh sách tháng từ phạm vi mùa thực tế, kể cả phần tháng đầu/cuối. Giữ quy tắc lựa chọn các cặp tuần Analysis đã chốt; không tự mở rộng từ các tuần gần nhất thành mọi cặp tuần trong mùa. Ghi rõ các cặp được nhúng tại lúc xuất.

## 6. Quy tắc tương tác dùng chung

### Điều khiển

- Chỉ tiêu: `Chuyến bay`, `Hành khách`, `Cả hai`.
- Chiều: `Tổng`, `Đến`, `Đi`, `Hiện cả ba`.
- Kỳ đối chiếu: chỉ các kỳ đã xuất, không truy vấn lại nguồn.
- Mức nhóm: thu gọn, mở cấp tiếp theo, mở toàn bộ.
- Bộ lọc dữ liệu theo mục 5; tìm kiếm tên; sắp xếp trong từng cấp anh em.
- Nút đặt lại đưa tab về trạng thái mặc định.

Mặc định: cấp nhóm đầu tiên, Tổng CB và Tổng HK; một kỳ đối chiếu mặc định phù hợp với loại báo cáo. Các kỳ khác vẫn nằm đầy đủ trong file. Báo cáo không chọn so sánh thì không sinh cột so sánh rỗng.

### Hành vi bắt buộc

1. Bung/thu gọn chỉ đổi mức hiển thị; không đổi số tổng hay dữ liệu.
2. Tìm kiếm không đổi phạm vi tính; tự mở nhánh có kết quả và ghi rõ đây là kết quả tìm kiếm.
3. Bộ lọc dữ liệu áp dụng cho bảng, subtotal, grand total và chart thuộc tab hiện tại. Các tab khác giữ bộ lọc riêng.
4. Điều kiện lọc đang áp dụng luôn nhìn thấy được; không để người đọc hiểu subtotal đã lọc là tổng toàn báo cáo.
5. Tỷ trọng của một dimension dùng cùng mẫu số cho mọi nhóm ở cùng phạm vi lọc/chiều/kỳ. Nếu hiển thị tỷ trọng trong nhóm cha, dùng nhãn riêng.
6. Sắp xếp không tách con khỏi cha; tie-break dùng tên/key ổn định.
7. Các nhóm chỉ có ở một kỳ vẫn hiện với đúng dữ liệu của chính kỳ đó.
8. Không phụ thuộc localStorage để file hoạt động; mở lại file trở về trạng thái mặc định trong MVP.
9. Bàn phím sử dụng được các nút nhóm, bộ lọc và vùng cuộn; có `aria-expanded`, nhãn điều khiển và focus rõ.

### So sánh và trình bày bảng rộng

Bảng sản lượng hỗ trợ sáu cột: CB Đến/Đi/Tổng, HK Đến/Đi/Tổng. Bảng so sánh dùng Hiện tại/Đối chiếu/Chênh lệch/% theo chỉ tiêu và chiều đang chọn.

Khi chọn nhiều năm hoặc `Hiện cả ba`, chia thành các khối bảng cố định xếp dọc theo kỳ/chiều/chỉ tiêu thay vì thêm không giới hạn cụm cột. Không tạo trình dựng bảng tùy chỉnh.

Biểu đồ CB và HK có đơn vị riêng, đặt ngoài vùng bảng. Biểu đồ Top 10 + Khác nếu dùng phải tính từ dữ liệu đầy đủ của phạm vi đang lọc, xếp hạng riêng từng chỉ tiêu; không cộng nhóm Khác có sẵn lần nữa.

## 7. Hợp đồng dữ liệu nội bộ cần chốt trước khi triển khai

### Nguồn và phiên bản

- Dùng nguồn canonical/reporting hiện hành; kiểm tra lại đường gọi RPC tại thời điểm triển khai.
- Không lấy số liệu từ workbook mẫu, raw history, bản sao drill-down hoặc duplicate rows.
- Cùng một export phải có snapshot/read version, source watermark và semantic data-as-of nhất quán.
- Hash toàn yêu cầu export bao gồm tất cả kỳ và bộ lọc. Mỗi resource có thể có filter hash khác nhau vì ngày/chiều khác nhau; kiểm tra chúng khớp resource mong đợi, không bắt mọi resource có cùng hash.
- Nếu nguồn thay đổi giữa các lượt đọc thì từ chối file chưa hoàn tất; không phát hành file trộn phiên bản.

### Các bộ dữ liệu tối thiểu

| Bộ dữ liệu | Độ chi tiết cần có | Mục đích |
|---|---|---|
| KPI | Kỳ × Chiều | Tổng quan và baseline đối soát |
| Timeline | Kỳ × Ngày × Chiều | Ngày/tháng/tuần và bình quân |
| Thị trường | Kỳ × Country × Route × Airline × Chiều | Ba cây hãng/thị trường/chặng |
| Tàu bay | Kỳ × AC Group × AC Type × Chiều | Cây AC |
| Giờ | Kỳ × Khung giờ × Chiều | Bảng giờ; không giả định Pax đã sẵn có |
| Tần suất | Các khóa nghiệp vụ hiện có | Cây hãng/chặng/số hiệu, chỉ tiêu không cộng dồn tùy tiện |

Dữ liệu nền chỉ gồm các tổ hợp cần cho bảng cố định. Không dựng một khối dữ liệu đa chiều tổng quát với mọi trường. Ví dụ bộ Thị trường không cần AC hoặc Ngày nếu bảng không lọc theo các trường đó.

Trước khi cam kết cấp bung/thu gọn, xác nhận nguồn có joint aggregate tương ứng. Các bảng Airline/Country/Route độc lập không đủ để suy ra Country → Route → Airline. Nếu RPC hiện có không cấp đủ, trình phương án aggregate đọc mới; không âm thầm ghép theo tên hoặc nới quyền đọc raw.

Mỗi bucket cần giá trị CB/HK, số bản ghi Pax đã có, thông tin thiếu/độ đầy đủ phù hợp, kỳ và chiều. Dùng khóa ổn định; không dùng riêng tên hiển thị hoặc slug có thể trùng làm định danh.

### Tính toán ở server và trong HTML

- Server sở hữu định nghĩa chỉ tiêu, calendar/season, coverage, snapshot và các bucket canonical.
- HTML chỉ cộng bucket rời nhau để đáp ứng bộ lọc đã định nghĩa, rồi tính lại tỷ lệ/bình quân/chênh lệch theo cùng quy tắc được kiểm thử.
- Tổng server đi kèm để đối soát trạng thái không lọc. Mỗi bộ lọc được nghiệm thu bằng truy vấn nguồn hoặc fixture độc lập cùng semantics.
- Không tính tổng từ các dòng cha/con đang hiển thị; dùng các bucket lá duy nhất.
- Không cộng AC Group với AC Type, không cộng tuần ISO với tuần nghiệp vụ, không cộng tuần trước/chọn/sau thành một KPI kỳ chọn.

### Quy tắc Pax, zero và so sánh

| Trường hợp | Cách xử lý |
|---|---|
| Không có Pax được ghi nhận | Giá trị HK thiếu; hiển thị `—` hoặc `Chưa có số liệu` |
| Có Pax thực sự bằng 0 | Giữ số `0` |
| Có một phần Pax | Giữ subtotal khách đã ghi nhận; gắn lời nghiệp vụ ngắn về phần còn thiếu |
| Một chiều thiếu Pax | Giữ chiều đó thiếu; không chia đôi tổng hoặc tự suy ra chiều còn lại |
| Tổng Pax canonical là subtotal đã ghi nhận | Giữ đúng giá trị và tình trạng thiếu, không gọi là tổng đầy đủ |
| Hai kỳ thiếu dữ liệu so sánh | Δ/% HK để trống khi không đủ điều kiện; vẫn xem được giá trị có sẵn |
| Mẫu số so sánh bằng 0 | % để trống; có thể ghi `Không có cơ sở tính %`; Δ vẫn tính khi hai giá trị hợp lệ |
| Nhóm không có hoạt động | CB chỉ là 0 khi coverage xác nhận; thiếu dữ liệu không tự thành 0 |

So sánh kỳ thông thường: `Hiện tại - Đối chiếu`, `% = Chênh lệch / Đối chiếu`. Weekly có hai cặp ghi rõ: `Kỳ chọn - Tuần trước` và `Tuần sau - Kỳ chọn`.

Số ngày của mỗi kỳ là giao của phạm vi thực tế được chọn với bucket tháng/tuần tương ứng. Không chia sản lượng bốn ngày cho cả tháng. Phạm vi có ngày thiếu vẫn dùng số ngày lịch được chọn cho chỉ tiêu mang tên bình quân/ngày, đồng thời nhận diện mức đầy đủ; không đổi âm thầm sang bình quân ngày có dữ liệu.

Tuần tương lai chỉ có lịch bay phải được phân biệt với thực tế. Khái niệm tổng sản lượng chuyến bay và khách đã ghi nhận phải theo semantics reporting đã duyệt, không tự thay đổi khi chuyển định dạng.

## 8. Cấu trúc triển khai đề xuất

Các tên file mới dưới đây là dự kiến, cần điều chỉnh theo conventions hiện tại trước khi code.

| Thành phần | File dự kiến / điểm sửa |
|---|---|
| Chọn loại đầu ra | Dialog export hiện có; giữ mặc định và đường Excel tương thích |
| Request HTML | Contract export hiện có hoặc module HTML riêng dùng lại bộ chuẩn hóa kỳ |
| Dữ liệu HTML | `_shared/trafficHtmlReportModel.ts`; reuse phần đúng của workbook core, không gọi renderer Excel để trích dữ liệu |
| Đặc tả bảng | `_shared/trafficHtmlReportDefinitions.ts`; cấu hình cố định theo report |
| Quy tắc aggregate/so sánh | Module pure dùng chung cho server/test/runtime khi khả thi |
| Renderer | `_shared/trafficHtmlReportRenderer.ts` |
| Runtime offline | Module bảng/filter/chart tối thiểu được bundle và nhúng vào HTML |
| Điều phối | `supabase/functions/traffic-report/index.ts`, reuse version pinning và phân trang |
| Test | Model/metrics, renderer, Edge contract, browser offline, Excel regression |

Không quyết định endpoint hoặc thay đổi request contract chỉ bằng tên file trong kế hoạch. Lập diff hợp đồng cụ thể sau bước khảo sát nguồn và trình duyệt theo mục 2.

### Đóng gói và chia sẻ

- Một file HTML, asset và dữ liệu đều inline. Không dùng fetch để đọc JSON cạnh file hoặc import module qua `file://`.
- Không cần service worker, web server local hoặc quyền cài đặt.
- Nhúng dữ liệu bằng serialization có xử lý `</script>` và ký tự đặc biệt. Tên hãng/chặng/ghi chú phải được escape, không đưa dữ liệu vào `innerHTML` chưa xử lý.
- Không nhúng credential, token truy cập server, đường dẫn cá nhân hoặc raw history. Metadata kiểm tra phiên bản có thể nằm nội bộ; không hiện lên luồng đọc thông thường.
- File chứa đầy đủ dữ liệu được xuất. Thu gọn/ẩn nhóm không phải phân quyền.
- Tên file gợi ý: `bao-cao-tuan-<from>-<to>-<timestamp>.html`, `phan-tich-theo-ky-...html`, `bao-cao-san-luong-<season>-...html`.
- Resource budget dựa trên dung lượng thực và hiệu năng. Không giới hạn cứng ba năm; không cắt ngầm kỳ/dòng. Khi vượt khả năng xử lý, báo rõ để người dùng thu hẹp phạm vi trước export.

## 9. Các giai đoạn thực hiện

### Giai đoạn 1 — Chốt nguồn và tái hiện lỗi nền

- [x] Kiểm tra worktree, các thay đổi đồng thời và các quy tắc repo hiện tại.
- [x] Đối chiếu catalog bảng mục 5 với reference; đánh dấu rõ nội dung chuyển và ngoài MVP.
- [x] Tái hiện lỗi nền bằng fixture nhỏ, không sử dụng dữ liệu mẫu làm source of truth.
- [x] Mapping sáu chỉ tiêu; xác minh read-only định nghĩa V2 và các nguồn canonical/catalog trên production; joint aggregate được bổ sung bằng RPC mới ở local.
- [x] Chốt quy tắc coverage, zero, subtotal Pax, ngày biên và dấu chênh lệch.
- [x] Đề xuất chính xác phần API cần thêm; đã được người dùng duyệt trước khi triển khai. Không đổi manifest Excel.

Đầu ra: mapping dữ liệu và danh sách thay đổi cụ thể. Không hứa chức năng bung sâu khi chưa có nguồn tương ứng.

### Giai đoạn 2 — Sửa nền số liệu và tạo model HTML

- [x] Sửa lỗi đã tái hiện trong phạm vi được duyệt, bảo toàn đường Excel hiện hành.
- [x] Giữ nhóm xuất hiện/biến mất qua các kỳ mà không chép số liệu sang kỳ khác trong model Excel/HTML.
- [x] Bảo toàn Pax A/D/Tổng và thông tin thiếu qua các phép gom.
- [x] Thêm đối soát KPI/timeline/dimension theo từng kỳ/chiều.
- [x] Chuẩn hóa model phục vụ các cây nhóm cố định.
- [x] Một STABLE statement snapshot lấy toàn bộ resource theo hợp đồng đã duyệt, không phân trang; từ chối artifact không nhất quán hoặc vượt ngân sách.

Đầu ra: model và phép tính được kiểm thử độc lập, trước khi gắn giao diện.

### Giai đoạn 3 — Hoàn thành Weekly Detail offline

- [x] Khung HTML tự chứa, tab, header kỳ và chỉ tiêu.
- [x] Bảng ba giai đoạn, sáu chỉ tiêu và hai cặp so sánh.
- [x] Cây Airline/Country/Route/AC đúng catalog.
- [x] Bung/thu gọn, tìm, lọc, sắp xếp, reset, keyboard và sticky headers.
- [x] Biểu đồ CB/HK liên quan, không chồng bảng.
- [x] Chế độ in tab hiện tại, ghi rõ bộ lọc và phạm vi đang xem; đã kiểm tra print-media local.
- [x] Tích hợp đường tải HTML sau khi contract được duyệt.
- [x] Mở file `file://` khi tắt mạng và đối soát số liệu fixture.

Đầu ra: một báo cáo tuần đầy đủ, có thể gửi cho người dùng nghiệm thu bố cục và thao tác.

### Giai đoạn 4 — Phân tích theo kỳ và chế độ tháng

- [x] Một/nhiều tháng, mùa, năm, custom; kỳ không so sánh, một năm và nhiều năm.
- [x] Kỳ đối chiếu đi theo khối dọc; không tạo bảng rộng không kiểm soát.
- [x] Cây tháng/ngày và tuần riêng; bảo toàn tuần biên, leap day, mùa qua năm.
- [x] Tab hãng/thị trường/chặng/AC theo cùng semantics đã kiểm thử local.
- [x] Tóm tắt tháng, xếp hạng ngày và giờ cao điểm; CB/HK xếp hạng độc lập.
- [x] Giữ tab giờ/tần suất, thêm aggregate giờ Pax; tần suất không suy diễn Pax.
- [ ] Kiểm tra lại trải nghiệm với dữ liệu nhiều năm thực tế được cho phép sử dụng.

Đầu ra: mẫu phân tích theo kỳ đáp ứng các period mode và nội dung tháng đã chốt.

### Giai đoạn 5 — BaoCaoSanLuong HTML

- [x] TOTAL, WEEKLY, tháng và hai Analysis theo catalog.
- [x] Mùa hè/đông có đủ mọi ngày trong phạm vi mùa, kể cả tháng biên.
- [x] Tuần nghiệp vụ Thứ Sáu–Thứ Năm; không trộn số tuần ISO.
- [ ] Analysis có CB/HK theo chiều, đúng cặp tuần, đúng mẫu số so sánh/đóng góp.
- [x] Đối soát tổng tháng/tuần với tổng báo cáo trên fixture; không cộng tuần giao biên hai lần.
- [ ] Đối chiếu nội dung, style và cách đọc với template gốc; ghi rõ khác biệt có chủ đích của HTML.

Đầu ra: BaoCaoSanLuong offline có các chức năng tương ứng thuộc phạm vi, không phụ thuộc Excel refresh.

### Giai đoạn 6 — Nghiệm thu và chuyển tiếp

- [ ] Chạy bộ validation mục 10; lưu kết quả và file HTML nghiệm thu.
- [x] Kiểm tra hồi quy Excel hiện có, không sửa sample/manifest Excel ngoài phạm vi duyệt.
- [ ] Đánh giá kích thước file, thời gian mở/lọc/bung nhóm theo các bộ dữ liệu thực tế.
- [ ] Nghiệm thu thao tác trên trình duyệt đích; kiểm tra một file gửi sang máy khác.
- [ ] Sau khi được phép triển khai: phát hành có thể rollback nhánh HTML, kiểm tra file tải từ URL thật.
- [ ] Chỉ cân nhắc ẩn/bỏ lựa chọn Excel/Master cũ khi có quyết định riêng sau giai đoạn dùng thử.

## 10. Test và validation

| Nhóm | Trường hợp tối thiểu | Điều kiện đạt |
|---|---|---|
| Sáu chỉ tiêu | Mỗi kỳ/dimension A/D/Tổng, số khách không đối xứng hai chiều | Khớp nguồn và không chia đôi tổng |
| Pax thiếu | All-null, true-zero, thiếu một chiều, thiếu một phần trong chiều | Giá trị và tình trạng thiếu đúng, không tạo 0 giả |
| Nhóm theo kỳ | Chỉ kỳ trước, chỉ hiện tại, chỉ kỳ sau, chỉ một năm đối chiếu | Không mất nhóm, không chép metrics giữa kỳ |
| Lịch và bình quân | 28/29/30/31 ngày, bốn ngày đầu tháng, tuần cắt biên, kỳ chọn khác bảy ngày | Đúng phạm vi và mẫu số từng kỳ |
| So sánh | Baseline 0/null, tăng/giảm, nhiều năm, không so sánh | Đúng dấu, đơn vị, mẫu số và trạng thái |
| Tổng và hierarchy | Country/Route/Airline, AC Group/Type, Unknown, key/tên trùng | Không cộng cha/con hai lần, totals khớp |
| Filter | Lọc từng trường và tổ hợp thuộc tab, trả về rỗng, reset | Tổng/ratio/chart khớp phạm vi; tab khác không bị tác động |
| Search/sort | Kết quả nằm trong nhánh đóng; sắp xếp số có null và tie | Không đổi tổng, không tách con khỏi cha |
| Collapse | Thu gọn/mở từng cấp/mở tất cả | Giá trị không đổi; đầy đủ dữ liệu kể cả dòng chưa dựng |
| Snapshot | Nguồn đổi giữa các resource/trang, trang thiếu/lặp | Từ chối file trộn phiên bản hoặc không đầy đủ |
| Chart | Top CB khác Top HK, Khác, không có Pax, tỷ trọng sau lọc | Đúng series/đơn vị/mẫu số, null là gap |
| Offline | Mở file bằng `file://` khi tắt mạng, tên đường dẫn có dấu/khoảng trắng | Tất cả chức năng hoạt động, không có request mạng |
| An toàn dữ liệu nhúng | Nhãn có HTML, dấu nháy, `</script>`, Unicode | Hiển thị như dữ liệu, không thực thi mã |
| Accessibility | Keyboard, focus, aria-expanded, vùng cuộn, thu phóng | Sử dụng được, tiêu đề/số liệu không bị che |
| In | Tab đang lọc, bảng có nhóm mở, chart và nhiều trang | Phạm vi rõ, header lặp phù hợp, không mất cột/chart |
| Hiệu năng | Tuần, mùa, năm, nhiều năm và nhiều nhóm | Đo file size, thời gian mở/lọc/bung; không cắt dữ liệu |
| Chuyển tiếp | Excel cũ và file reference | Không phát sinh regression hay đổi fingerprint mẫu |

Fixture phải tự nhất quán giữa KPI/timeline/dimension; dùng tổng nguồn độc lập làm expected, không lấy chính helper đang test để tạo expected. Không thay test số liệu bằng test chỉ đếm sheet hoặc tìm chuỗi header.

Lệnh hiện có, chạy tại workspace `SeasonalManagement-web-traffic-report/app` khi triển khai:

```powershell
npm run test:traffic-report-contract
npx tsc --noEmit --pretty false
npm run build:traffic-report
```

Thêm lệnh test HTML/model/browser sau khi các module mới được tạo. ESLint chạy trên các file thay đổi. Không chạy migration hay refresh production chỉ để hoàn tất kiểm thử local.

## 11. Done means

- [ ] Có ba mẫu HTML offline theo mapping; chế độ tháng giữ nội dung đã chốt.
- [ ] Các bảng thiết kế sẵn bung/thu gọn, lọc, tìm, sắp xếp và reset đúng hành vi.
- [ ] Có CB/HK Đến/Đi/Tổng và so sánh tương ứng ở tất cả bảng sản lượng thuộc phạm vi đã xác nhận nguồn.
- [ ] Người nhận đọc được toàn bộ dữ liệu đã nhúng khi không có mạng; không có Pivot tùy chỉnh.
- [ ] Số liệu khớp reporting cùng thời điểm/phạm vi; Pax thiếu và true-zero được phân biệt.
- [ ] Không có phần thiếu nguồn bị che bằng giá trị giả hoặc âm thầm bỏ khỏi phạm vi nghiệm thu.
- [ ] Không có thông tin kỹ thuật gây nhiễu hoặc sheet kiểm soát dữ liệu trong luồng đọc.
- [ ] Tài liệu mẫu và đường Excel được bảo toàn theo phạm vi duyệt.
- [ ] Bằng chứng local, browser offline, nghiệm thu người dùng và production được báo riêng, đúng những gì đã kiểm tra.

## 12. Kết quả của lượt lập kế hoạch

Lượt này chỉ tạo tài liệu kế hoạch này. Chưa tạo file HTML, chưa sửa code/schema/API/manifest, chưa chạy migration hoặc triển khai production.

## 13. Tiến độ triển khai ngày 2026-09-05

Mục 12 ghi nhận lượt lập kế hoạch ban đầu, không phải trạng thái hiện tại.

Đã sửa nền tại workspace triển khai:

- Không lấy metrics của tuần trước/sau làm kỳ hiện tại; giữ nhóm chỉ có ở kỳ trước/cùng kỳ.
- Bình quân kỳ so sánh dùng đúng số ngày của từng kỳ, kể cả tháng 2 năm nhuận.
- Gom tháng/tuần theo giao phạm vi chọn, vẫn tính ngày lịch bị thiếu; giữ trọn phạm vi context Weekly.
- Giữ Pax Đến/Đi nếu input thực sự cung cấp, không đổi all-null thành zero.

Sáu test mới thất bại trước sửa và đạt sau sửa; workbook 20/20 test đạt. Bộ contract đạt 100 Node tests, SQL PGlite, Edge và isolation; TypeScript, ESLint ba file thay đổi và build report-only đạt. Sáu reference giữ fingerprint, không sửa manifest.

Chi tiết mapping và đề xuất API/RPC: [Hợp đồng xuất HTML offline](./2026-09-05-offline-html-traffic-reports-contract-proposal.md).

Sau phản hồi “Ok”, người dùng đã duyệt endpoint HTML cùng RPC aggregate-only mới. Đã triển khai model, RPC, ba mẫu offline, dialog và cấu hình route local; browser file:// offline, kiểm thử SQL/Edge, TypeScript/ESLint và build đều đạt. Chưa triển khai production hoặc xác nhận Excel Desktop.

Biên bản hiện hành và phần nghiệm thu còn lại: [Kết quả triển khai HTML offline](./2026-09-05-offline-html-traffic-reports-implementation.md). Checklist giai đoạn 4–6 và Done means chưa đánh dấu hoàn tất toàn bộ vì vẫn cần đối soát dữ liệu thực tế, đo tải đại diện và nghiệm thu người dùng.
