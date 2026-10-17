# Báo cáo chuyển ngữ giao diện và bảng thuật ngữ

## Phạm vi và quyết định

- Phạm vi: giao diện desktop và báo cáo web trong `app/src/app`; các nhãn, thông báo và hàm định dạng phục vụ hiển thị trong `app/src/lib`.
- Cách thực hiện: dịch trực tiếp chuỗi giao diện; không thêm thư viện hoặc từ điển i18n.
- Giữ nguyên dữ liệu nghiệp vụ, tên biến/hàm, object keys, giá trị trạng thái dùng để xử lý, đường dẫn, tham số truy vấn, khóa lưu trữ, biểu tượng, CSS, bố cục, luồng xử lý, console và backend.
- Không sửa file test, cấu hình build hoặc định dạng/cột của mẫu nhập/xuất Excel/CSV/PDF.
- Giữ nguyên biến nội suy, mã chuyến, hãng, sân bay, loại tàu bay, thời gian, số liệu và nội dung do người dùng nhập.
- Người dùng cho phép chuyển ngữ ở lớp trình bày đối với thông báo lỗi, tên trường và dữ liệu kỹ thuật đang được hiển thị; không thay đổi đối tượng dữ liệu gốc.
- **Ngoại lệ được người dùng xác nhận: giữ `Slot` trong màn hình đánh giá khả năng thêm chuyến**, không dịch thành “suất”.

## Điều phối theo module

| Batch | Phạm vi | Ranh giới sở hữu |
|---|---|---|
| 1 | Điều hướng, đăng nhập, khung ứng dụng, thông báo dùng chung | Layout/root desktop và các component shell/auth/dialog/progress/sync |
| 2 | Lịch mùa, nhập lịch mùa, thêm chuyến | `SeasonalSchedulePage`, seasonal route, Seasonal import preview, New Flight |
| 3 | Lịch chi tiết | Detailed page, Edit Modal, Confirm Modal |
| 4 | Công bố và phiên bản | Publish Modal, Version History Modal, Version Changes View |
| 5 | Vận hành | Daily, Check-in, Gate và hai Daily import preview |
| 6 | Tổng quan và báo cáo nội bộ | Dashboard/components, Reports, Audit |
| 7 | Cài đặt | Settings page và Settings/components |
| 8 | Báo cáo web | Toàn bộ TSX thuộc `(public-report)` |
| 9 | Văn bản phát sinh ở lớp frontend | Nhãn/thông báo trong lib và hàm định dạng hiển thị dùng chung |

### Model và diễn biến

- Đợt đầu dùng Sonnet 5.5 medium. Provider xác nhận model thực tế `google-antigravity/claude-sonnet-5-5`, mức `medium`. Một số file đã được chuyển ngữ trước khi 9 job dừng vì hết hạn mức (429).
- Theo quyết định tiếp theo của người dùng: giữ phần Sonnet đã dịch; phần còn lại chuyển sang `google-antigravity/gemini-3.8-flash:medium`.
- Review độc lập dùng `google-antigravity/gemini-3.8-flash:high`.
- Cấu hình chỉ áp dụng trong phiên này; không lưu vào cấu hình chung và không tự chuyển model khi gặp lỗi.

## Bảng thuật ngữ chuẩn hóa

### Điều hướng và lịch bay

| Thuật ngữ gốc | Cách hiển thị tiếng Việt | Ngữ cảnh |
|---|---|---|
| Dashboard | Tổng quan | Điều hướng, tiêu đề màn hình |
| Seasonal Schedule | Lịch mùa | Phân hệ lập kế hoạch theo mùa |
| Detailed Schedule | Lịch chi tiết | Lịch chuyến theo ngày trong mùa |
| Daily Schedule | Lịch ngày | Phân hệ vận hành |
| Check-in Allocation | Phân bổ quầy | Quầy làm thủ tục |
| Gate Allocation | Phân bổ cửa | Cửa ra tàu bay |
| Reports | Báo cáo | Điều hướng |
| Audit Log | Lịch sử thao tác | Theo dõi thao tác người dùng |
| Settings | Cài đặt | Điều hướng |
| Arrival / ARR | Đến | Nhãn hiển thị; giá trị enum gốc giữ nguyên |
| Departure / DEP | Đi | Nhãn hiển thị; giá trị enum gốc giữ nguyên |
| Turnaround | Cặp chuyến | Hai chặng được liên kết |
| Single flight | Chuyến đơn | Chuyến không có chặng đi/đến liên kết |
| Flight number | Số hiệu chuyến | Nhãn cột/biểu mẫu |
| Airline | Hãng | Nhãn ngắn; mã hãng giữ nguyên |
| Aircraft | Tàu bay | Nhãn ngắn; mã loại tàu giữ nguyên |
| Route | Tuyến | Điểm đi/đến theo ngữ cảnh |
| Codeshare | Liên danh | Số hiệu chuyến liên danh |
| Scheduled / J | Thường lệ | Nhãn loại chuyến; giá trị `J` giữ nguyên |
| Charter | Thuê chuyến | Nhãn loại chuyến |
| Stand | Vị trí đỗ | Không nhầm với cửa ra tàu bay |
| Carousel | Băng chuyền | Trả hành lý |
| Counter | Quầy | Quầy làm thủ tục |
| Scheduled arrival time / STA | Giờ đến kế hoạch | Nhãn hiển thị, không đổi field |
| Scheduled departure time / STD | Giờ đi kế hoạch | Nhãn hiển thị, không đổi field |
| Same day | Cùng ngày | Quan hệ cặp chuyến |
| Overnight | Qua đêm | Quan hệ cặp chuyến |
| Slot | Slot | Ngoại lệ nghiệp vụ được người dùng duyệt |

### Lưu, công bố và phiên bản

| Thuật ngữ gốc | Cách hiển thị tiếng Việt | Lưu ý |
|---|---|---|
| Draft | Bản nháp | Thuật ngữ nghiệp vụ, không dùng Planning Draft |
| Publish | Công bố | Không đồng nhất với lưu bản nháp |
| Published | Đã công bố | Trạng thái hiển thị |
| Version | Phiên bản | Lịch sử công bố |
| Snapshot | Bản lưu | Không hiển thị tên cấu trúc dữ liệu |
| Version diff | So sánh phiên bản | Màn hình so sánh |
| Added | Thêm mới | Nhóm thay đổi |
| Modified | Điều chỉnh | Nhóm thay đổi |
| Removed / Deleted | Xóa | Theo đúng trạng thái và ngữ cảnh gốc |
| Restore | Khôi phục | Khôi phục vào bản nháp, không tự công bố |
| Undo | Hoàn tác | Đảo thao tác trước |
| Before / After | Trước / Sau | So sánh giá trị |
| Save | Lưu | Nút hành động |
| Saved | Đã lưu | Chỉ khi trạng thái gốc xác nhận đã lưu |
| Pending | Chờ lưu / Chờ đồng bộ | Chọn đúng theo nguồn trạng thái hiện hữu |
| Unconfirmed result | Chưa xác nhận kết quả | Không khẳng định thao tác thất bại khi chưa biết kết quả |
| Conflict | Cần xem lại / Dữ liệu đã thay đổi | Theo ngữ cảnh nghiệp vụ |

### Thao tác và thông báo

| Thuật ngữ gốc | Cách hiển thị tiếng Việt | Lưu ý |
|---|---|---|
| Fetch data | Tải dữ liệu | Không dùng Fetch |
| Loading / Fetching | Đang tải… | Trạng thái tiến trình |
| Working | Đang xử lý… | Tiến trình khác tải dữ liệu |
| Sync / Syncing | Đồng bộ / Đang đồng bộ… | Không dùng Sync pending |
| Retry | Thử lại | Không thay đổi cơ chế thử lại |
| Refresh | Làm mới | Phân biệt với gửi lại thao tác |
| Cancel | Hủy | Không đổi hành vi |
| Confirm | Xác nhận | Không đổi hành vi |
| Close | Đóng | Nút đóng |
| Back | Quay lại | Điều hướng/hộp thoại |
| Search | Tìm kiếm | Ô tìm kiếm |
| Filter | Lọc | Bộ lọc |
| Select all | Chọn tất cả | Giữ phạm vi chọn hiện hữu |
| No data | Không có dữ liệu | Trạng thái trống |
| null / undefined | Chưa có dữ liệu | Chỉ lớp hiển thị; không đổi giá trị gốc |
| Raw technical error | Không thể thực hiện. Vui lòng thử lại. | Lỗi chưa nhận diện; ưu tiên thông báo đúng ngữ cảnh nếu có |
| Internal server error | Lỗi hệ thống. Vui lòng thử lại. | Không lộ mã lỗi, SDK hay câu SQL |
| Payload / Raw state | Thông tin chi tiết | Trình bày bằng nhãn nghiệp vụ, không đưa JSON thô lên UI |

## Quy tắc áp dụng cho phát triển tiếp theo

1. Viết chữ trên nút ngắn, dùng động từ rõ: Lưu, Hủy, Công bố, Khôi phục, Thử lại.
2. Dịch nhãn hiển thị, không dịch khóa dữ liệu hoặc enum dùng trong xử lý. Một giá trị `REJECTED` có thể hiển thị “Không được chấp nhận” nhưng dữ liệu vẫn là `REJECTED`.
3. Giữ nguyên mọi biến nội suy. Đổi lời dẫn, không làm mất tên chuyến, ngày, số lượng hay dữ liệu đang được mô tả.
4. Không đưa lỗi thô từ thư viện/backend lên giao diện. Chuyển lỗi đã nhận diện thành hướng dẫn nghiệp vụ; lỗi chưa biết dùng lời nhắc an toàn theo ngữ cảnh. Log và phân loại lỗi gốc không thay đổi.
5. Không gọi chung một lỗi nhập lịch là “Lỗi hệ thống” nếu có thể cho người dùng biết ngày, chuyến hoặc ô dữ liệu cần sửa.
6. Tên trường ở bảng chi tiết phải dùng từ điển hiển thị; dữ liệu trước/sau không bị thay đổi hoặc ghi ngược vào API.
7. Không thay đổi định dạng nhập/xuất chỉ để đổi ngôn ngữ giao diện. Tên Excel, CSV, PDF và mã hãng/sân bay/tàu bay vẫn giữ nguyên.
8. Thuật ngữ hàng không chưa rõ nghĩa phải được xác nhận trước khi thay; không suy diễn từ chữ viết tắt.

## Kiểm chứng và phạm vi nghiệm thu

Kiểm chứng đợt chuyển ngữ ban đầu gồm 9 batch:

| Kiểm tra | Kết quả |
|---|---|
| `cd app && npx tsc --noEmit` | Đạt, không có lỗi TypeScript |
| `cd app && npm run build` | Đạt; tạo đủ 15 trang static |
| Smoke hành vi bằng script tạm | 19 ca đạt: giữ mã hãng/tuyến/số hiệu, số `0`, dữ liệu lồng nhau và dữ liệu đầu vào; giữ trạng thái nút lưu, chặn tải khi chưa lưu, không hủy thao tác commit khi kéo thả và chặn tải tệp nếu lịch xuất không bảo toàn vòng nhập/xuất |
| Chromium trên bản build: đăng nhập | Đã nhập tên đăng nhập sai định dạng, nhận thông báo “Tên đăng nhập không hợp lệ.”; không ghi nhận lỗi JavaScript |
| Chromium trên bản build: báo cáo web | Đã mở/đóng bộ lọc, kiểm tra chữ và ảnh giao diện; nhãn accessibility của nhóm `Unknown` hiển thị “Chưa xác định”; không ghi nhận lỗi JavaScript |

Smoke giao diện phát hiện và đã sửa thêm hai chỗ sót: thông báo “Username không hợp lệ.” và nhãn đọc màn hình dùng `Unknown`. Chỉ chuyển ngữ ở lớp hiển thị, không sửa validation đăng nhập hoặc khóa dữ liệu báo cáo.

Giới hạn: preview static không cung cấp API báo cáo, nên kiểm tra báo cáo có dữ liệu dùng fixture từ contract test hiện hữu và response tổng hợp cục bộ. Chưa nghiệm thu backend Production, toàn bộ màn hình desktop sau đăng nhập hoặc toàn bộ test suite. Build còn cảnh báo dữ liệu Browserslist cũ; không cập nhật dependency ngoài phạm vi chuyển ngữ.

### Bổ sung: chuẩn hóa modal nhập dữ liệu và xác nhận/khôi phục

Đã tích hợp hai nhóm chuyển ngữ modal và rà soát độc lập. Những nguyên tắc bổ sung:

- Lịch ngày V1/V2: nút chính **Nhập và thay thế**, trạng thái bận **Đang nhập…**. Đợt nhập đã lưu phải thông báo rõ trạng thái, không hướng người dùng nhập lại tệp.
- Lịch mùa: nút chính **Áp dụng dữ liệu nhập**, trạng thái bận **Đang nhập…**. Bộ đếm chế độ Thay thế mô tả **Chuyến bay hiện có trong mùa bị xóa**, không dùng “mùa trước”; thông báo sau nhập cũng áp dụng cách diễn đạt này.
- `RequestId` chỉ đổi nhãn giao diện thành **Mã yêu cầu**; giữ nguyên trường `requestId`, mã lỗi và các predicate nhận diện xung đột/khôi phục.
- Thông báo nhập mùa đã nhận diện giữ đầy đủ danh sách dòng trùng, dòng được giữ lại hoặc không được giữ lại, định danh lượt bay, số lượng và ngày. Bổ sung nhãn nghiệp vụ cho mã chẩn đoán; không thay bằng thông báo lỗi chung hoặc fallback tiếng Anh thô.
- Chẩn đoán nghiệp vụ đã nhận diện được ưu tiên trước phân loại HTTP chung: số hiệu `VN401`, `VN403`, `VN404`, `VN409` và chỉ số dòng tương ứng không phải mã HTTP. Bước lọc lỗi kỹ thuật nhạy cảm vẫn chạy trước; lỗi HTTP thực và lỗi mạng/thời gian chờ vẫn được nhận diện.
- Ba giá trị `workbookProfile` do parser hỗ trợ chỉ đổi cách hiển thị: `legacy-operationalturns` → **Mẫu lịch vận hành cũ**, `compact-lb` → **Mẫu lịch bay rút gọn**, `position-compatible-unknown` → **Mẫu cột tương thích chưa xác định**. Không đổi mã mẫu hoặc cấu trúc tệp Excel.
- Xem trước hủy liên kết giữ cả hai số hiệu chuyến bay hoặc cả hai chỉ số dòng nguồn và số ngày; chỉ chuyển ngữ `sourcePlan.preview`, không đổi các thao tác ghi trong `sourcePlan.writes`.

Kiểm chứng sau các sửa chữa cuối cùng:

| Kiểm tra | Kết quả |
|---|---|
| `npx tsc --noEmit` tại `app` | Đạt, không có lỗi TypeScript |
| `npm run build` tại `app` | Đạt, tạo đủ 15 trang static |
| Smoke hành vi trực tiếp trên module TypeScript | 33 kiểm tra đạt: các dạng chẩn đoán nhập mùa, va chạm số hiệu/chỉ số dòng với mã HTTP, lỗi HTTP/mạng thật, lọc lỗi kỹ thuật, phân loại nhãn mẫu tệp đúng trường và giữ nguyên toàn bộ thao tác ghi hủy liên kết cùng ngày/qua đêm so với baseline đã giữ trong phiên |
| Chromium: Daily V1/V2, nhập mùa, xác nhận thay đổi | 8 kịch bản đạt: xác nhận, trạng thái bận, chặn nhập lại đợt đã lưu, đóng/hủy, mã mùa đúng/sai khi Thay thế, cảnh báo giữ dòng và số hiệu `VN404`, giữ hai số hiệu trong xem trước hủy liên kết; không ghi nhận lỗi JavaScript |

Smoke Chromium dùng các component thật, CSS từ bản build và cùng font biểu tượng với layout desktop, trong harness cục bộ với fixture và callback kiểm chứng; không kết nối backend hoặc ghi dữ liệu thật. Đây không phải nghiệm thu luồng khôi phục/công bố với backend hay Production. Build vẫn có cảnh báo Browserslist cũ; không cập nhật dependency ngoài phạm vi. Harness đã được dọn sau kiểm chứng.

