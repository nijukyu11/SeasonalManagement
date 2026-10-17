# HTML theo bố cục BaoCaoSanLuong và PivotTable mẫu

## Phạm vi phê duyệt

Ngày 2026-09-06, sau đánh giá reference, người dùng yêu cầu “ok thực hiện chỉnh sửa”. Triển khai local MVP đã đề xuất: TOTAL/ngày/WEEKLY cạnh nhau, tab tháng, Analysis Airline/Country ba cặp tuần với CTG; pivot Hãng/Thị trường/Chặng/Ngày; giữ tóm tắt tuần và tháng đã nghiệm thu sơ bộ.

Không sửa reference, manifest Excel, schema nghiệp vụ hoặc materialized view. Không triển khai production. Các bảng 30 phút, Config, AC giao với Airline/Flight, PeakHour giao theo ngày ngoài phạm vi; bảng phân tích cũ vẫn truy cập được, không gọi chúng là pivot tương đương mẫu.

## Hợp đồng dữ liệu mở rộng trong MVP

- RPC HTML v2 và `traffic-html-data-v2`, giữ nguyên RPC v1; Edge gọi v2 sau khi rollout đồng bộ.
- Thêm resource `market_daily`: date × country × route × airline × direction. Cùng canonical selection, filter, watermark và snapshot như các resource cũ; không nhúng raw flight/history.
- Model đối soát resource mới với KPI, từng ngày và market, không chỉ tổng cuối kỳ. Giữ NULL khác 0, 250.000 dòng/25 MiB và cơ chế fail closed.
- Bao Analysis: bốn tuần Thứ Sáu–Thứ Năm quanh tuần chứa ngày nghiệp vụ đã kết thúc gần nhất tại data_as_of (giới hạn mốc vào mùa chọn): tuần trước nữa, trước, hiện tại, sau. Không chọn mốc từ ngày có Pax vì thiếu Pax không được làm dịch tuần. Tuần context giữ trọn 7 ngày kể cả giao mùa; TOTAL chỉ tính phạm vi mùa.
- CTG = chênh lệch của nhóm / tổng kỳ nền trong phạm vi bộ lọc; thiếu dữ liệu hoặc mẫu số 0 thì không xuất tỷ lệ giả.

## Bố cục và tương tác

- Bao: TOTAL; các tháng thực sự thuộc phạm vi (kể cả tháng biên và mùa qua năm); Analysis_Airline; Analysis_Country. Ngày/tuần giữ ARR/DEP và Total Flight/Pax. Biểu đồ tháng cột ARR/DEP và đường tổng, có chọn chuyến/khách.
- Pivot: hàng Airline→Route, Country→Route→Airline, Route→Airline, Month→Date. Cột tuần/tháng hoặc kỳ đối chiếu đặt cạnh nhau; phân biệt tuần nghiệp vụ với ISO bằng ngày bắt đầu/kết thúc.
- Tìm trong nhóm không thay đổi tổng. Bộ lọc nhiều lựa chọn thay đổi cả tổng và chi tiết. 20 nhóm gốc/trang; tổng không phụ thuộc phân trang/bung nhóm. Giữ state riêng từng tab, nút về bố cục mẫu.
- Tiêu đề nhiều tầng và cột nhãn cố định; vùng cuộn riêng, native controls, focus bàn phím; không chèn thông tin kỹ thuật vào báo cáo.
- Tóm tắt tuần/tháng và các phân tích cũ vẫn truy cập được; không sửa workbook/export Excel.

## Kiểm chứng

1. SQL v2 cài hai lần trên PGlite; v1 vẫn hoạt động, quyền RPC chỉ service_role.
2. Đối soát v2 với v1 và bản SQL dashboard V2 được lưu làm reference, cùng fixture/as_of/filter.
3. Test ngày cắt biên, mùa đông, năm nhuận, tuần không có Pax, NULL/0, nhóm chỉ ở kỳ đối chiếu, CTG khác growth.
4. Browser file:// offline: tab, bộ lọc nhiều lựa chọn, hierarchy, số liệu, reset, tìm kiếm, phân trang, XSS, keyboard, mobile, print và ảnh chụp.
5. Regression HTML tuần/tháng, Edge, Excel; TypeScript/lint/build report-only; kiểm tra fingerprint reference và UTF-8.

## Kết quả

Đã triển khai và kiểm thử local ngày 2026-09-06. Chưa nghiệm thu người dùng, dữ liệu production hoặc triển khai production.

### Nội dung đã làm

- `trafficHtmlPivotRuntime.ts` và `trafficHtmlPivotStyles.ts`: bảng tham chiếu là giao diện mặc định. Nút “Tóm tắt và phân tích” giữ báo cáo tuần/tháng và các phân tích cũ; “Bảng pivot mẫu” quay lại bảng tham chiếu.
- Bao TOTAL: DAILY và WEEKLY cạnh nhau; tháng có bảng bên trái/biểu đồ bên phải như vị trí drawing cột J trong mẫu. Tháng sinh theo mùa thực, không hardcode APR–OCT. Analysis giữ ba cặp tuần; mặc định chuyến, chọn được khách/cả hai và Đến/Đi/Tổng, CTG riêng.
- Pivot có Grand Total từng kỳ, footer tổng toàn bộ bộ lọc, phân trang 20 nhóm, tìm trong nhánh đóng, chọn nhiều giá trị, đổi cấp nhóm cho phép. Cột thời gian được xác định theo loại báo cáo/phạm vi đã xuất. Theo ngày mặc định Month→Date, sáu cột Chuyến/Khách Đến/Đi/Tổng; mỗi kỳ đã xuất có bảng riêng.
- In bảng rộng chia cột thành các phần tối đa tám cột số mỗi phần; bảo toàn toàn bộ giá trị đang hiển thị và lặp nhãn dòng. Không đồng nghĩa nghiệm thu máy in vật lý.
- SQL additive `20260906120000_public_traffic_html_pivot_v2.sql`: phiên bản v2, bảy resource/kỳ. Edge gọi v2. V1 không sửa/xóa; backend dashboard và workbook Excel giữ nguyên. Validator đối soát daily market theo ngày và theo nhóm ngoài đối soát KPI.

### Kiểm thử đạt

| Kiểm tra | Kết quả |
|---|---|
| `npm run test:traffic-html` | 6 test model; SQL PGlite và Edge đạt. Migration v1/v2 cài hai lần; quyền v2 anon/authenticated=false, service_role=true |
| `npm run test:traffic-pivot-layout` | Giá trị từng ô/kỳ, Grand Total, A+D, đa lọc, tìm không đổi tổng, bung bàn phím giữ focus, 20 nhóm/trang, calendar ngày, CTG/growth, Pax thiếu, mùa đông, XSS, print tách cột, 375px/landscape đạt |
| `npm run test:traffic-weekly-layout` | Sáu chỉ tiêu tuần, ảnh hưởng, thiếu Pax và thao tác tóm tắt cũ đạt qua nút chuyển chế độ |
| `npm run test:traffic-monthly-layout` | Bốn kỳ tháng, số liệu/nhận xét mẫu Word, thiếu Pax, phân trang, chart và đối soát SQL dashboard V2 cùng fixture đạt |
| `npm run test:traffic-html-offline` | Các loại báo cáo hoạt động bằng file:// offline, không request mạng hoặc lỗi JavaScript |
| `npm run test:traffic-report-contract` | Regression report, workbook, SQL, Edge và isolation đạt |
| TypeScript / ESLint targeted | Đạt, không còn cảnh báo unused trong runtime mới |
| `npm run build:traffic-report` | Build report-only đạt, 52 file; đã build lại với hai cờ export để kiểm tra dialog |
| `npm run test:traffic-html-dialog` | Hai lượt tải HTML tuần/tháng qua dialog local đạt; Excel vẫn mặc định. API được giả lập bằng SQL PGlite, không gọi production |
| Reference / UTF-8 | Cả sáu SHA-256 khớp manifest fingerprint; không có mojibake trong file thay đổi |

Lần đầu dialog test không tìm thấy nút xuất vì build chưa bật hai cờ export. Đã xác nhận `NEXT_PUBLIC_TRAFFIC_WORKBOOK_EXPORT_ENABLED`/`NEXT_PUBLIC_TRAFFIC_HTML_EXPORT_ENABLED`, build lại rồi chạy đạt; không sửa UI để lách test.

### Bản xem thử và bằng chứng

Trong `C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app/tmp/html-pivot-review-20260906/`:

- `bao-cao-san-luong-theo-mau.html`
- `phan-tich-theo-ky-pivot-mau.html`
- `validation.json`, ảnh TOTAL/tháng/Analysis/pivot/mobile/bản in.

Các file có banner “Dữ liệu minh họa giả lập, không phải production”. Số liệu fixture không được dùng để nhận xét khai thác thật. Hai file tuần/tháng trong thư mục review cũ đã được sinh lại với nút chuyển chế độ.

### Giới hạn còn lại / rollout sau khi được duyệt

- Cần nghiệm thu bố cục bởi người dùng; không tuyên bố tương đương toàn bộ Excel engine, macro, Power Query hoặc tất cả PivotCache của mẫu.
- Cần rehearsal dữ liệu đại diện, đối soát live cùng watermark/as_of/filter và đo gần giới hạn 250.000 dòng/25 MiB. Hiện mới chứng minh trên fixture, chưa chứng minh tải nhiều năm production.
- Triển khai SQL v2 trước, reload PostgREST schema cache và kiểm tra quyền; sau đó phát hành Edge/renderer cùng version, bật cờ frontend theo runbook. Giữ RPC v1 để có thể quay về Edge/renderer cũ; không downgrade riêng validator.
- Không deploy fixture SQL dashboard reference vào production. Không thay đổi source/schema/MV/manifest nếu chưa được duyệt riêng.

## Điều chỉnh UX chọn kỳ và công cụ tại bảng — 2026-09-06

Theo yêu cầu bổ sung trước rollout:

- Khoảng ngày, một tháng, nhiều tháng, năm, mùa và năm đối chiếu được chọn trong modal xuất. Modal đã hỗ trợ các lựa chọn này; bổ sung giải thích file tải về giữ cố định phạm vi, đổi kỳ cần xuất lại. Không đổi API hoặc hợp đồng dữ liệu.
- Bỏ bộ chọn cột thời gian/kỳ dữ liệu và bộ lọc thời gian khỏi HTML. Các kỳ đối chiếu được xuất sẽ trình bày cạnh nhau hoặc thành bảng riêng. Tab tháng BaoCaoSanLuong chỉ chuyển giữa bảng có sẵn, không đổi phạm vi.
- Đưa tìm kiếm, chỉ tiêu, chiều, bộ lọc và nút mở/thu gọn của pivot vào thanh công cụ tại từng bảng. Thanh này bám đầu bảng khi cuộn. Cấp nhóm/sắp xếp nằm trong mục “Hiển thị”. Giữ trạng thái mở bộ lọc, focus và vị trí cuộn khi dựng lại bảng.
- Bảng ngày mỗi kỳ có bộ lọc và trạng thái mở/thu gọn độc lập. Báo cáo tóm tắt tuần/tháng và các bảng phân tích cũ cũng có thao tác mở/thu gọn tại bảng; không dùng nút chung để thay đổi các bảng khác.
- Không thay đổi công thức tổng, nguồn canonical, NULL/0, mẫu Excel hoặc dữ liệu production. Các bộ lọc phân tích chỉ áp dụng trong dữ liệu đã xuất; lựa chọn kỳ nền phân tích tháng không lấy thêm dữ liệu.

Kiểm chứng bổ sung: file HTML không có bộ chọn phạm vi; các lựa chọn kỳ có mặt trong modal; hai bảng ngày mở độc lập; thanh công cụ vẫn trong khung nhìn khi cuộn bảng dài; regression pivot/tuần/tháng/offline, model/SQL/Edge, TypeScript và build report-only. Các bản xem thử được sinh lại với dữ liệu giả lập. Chưa triển khai production trong lượt điều chỉnh này.

### Mặc định sắp xếp theo tổng chuyến bay

- Bảng nhóm hãng/thị trường/chặng/tàu bay mặc định theo tổng chuyến Đến + Đi của kỳ báo cáo giảm dần, áp dụng ở cả nhóm cha và nhóm con. Không cộng các kỳ đối chiếu vào điểm xếp hạng. Giá trị thiếu đứng cuối, đồng hạng theo tên.
- Bao Analysis xếp từng bảng theo tổng chuyến của tuần đích trong cặp so sánh đó. Bảng ngày/tuần/tháng giữ trình tự thời gian; phần nhận xét ảnh hưởng vẫn xếp theo mức ảnh hưởng đúng chức năng.
- Giữ lựa chọn đổi sắp xếp; đặt lại phục hồi mặc định tổng chuyến. Đổi chỉ tiêu hiển thị sang khách không tự đổi tiêu chí xếp hạng.
- Kiểm thử browser bổ sung cho thứ tự kỳ hiện tại, reset, đổi chỉ tiêu, Bao Analysis và bảo toàn thứ tự thời gian. Chỉ cập nhật local, không đổi dữ liệu/API hoặc triển khai production.

## Cập nhật triển khai production — 06/09/2026

Theo yêu cầu mới của người dùng, đã phát hành lúc 08:54 (giờ Việt Nam), release 20260906T013000Z-html-reference-pivot. Các ghi chú “chưa production” phía trên mô tả trạng thái ở giai đoạn local trước đó.

Đã khôi phục full backup vào clone, đối soát bốn báo cáo all/A/D trên clone và production cùng watermark 50933, kiểm thử canary rồi tải HTML thực từ modal công khai. Excel/dashboard vẫn hoạt động; snapshot fresh, 67.114 dòng, nội dung dashboard publication before/after không đổi. Đã tách quota xuất HTML khỏi biểu đồ sau khi kiểm tra public phát hiện 429. Giữ backup/previous release và đã dọn canary/clone.

Biên bản chi tiết: C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/docs/runbooks/2026-09-06-traffic-html-production-release.md. Bằng chứng: C:/Users/tuan/Documents/SeasonalManagement-web-traffic-report/app/tmp/production-html-20260906/public-verification.json.
