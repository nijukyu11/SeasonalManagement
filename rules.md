# BỘ QUY TẮC HOẠT ĐỘNG (SYSTEM RULES)

Tài liệu này định nghĩa các quy tắc xử lý dữ liệu và logic nghiệp vụ bắt buộc phải tuân thủ trong suốt vòng đời của dữ liệu trên hệ thống.

## 1. QUY TẮC ĐẦU VÀO & BUNG DỮ LIỆU (DATA EXPANSION RULES)
*   **Rule 1.1 - Khớp tần suất tuyệt đối:** Dữ liệu chi tiết chỉ được tạo ra vào các ngày trong tuần trùng khớp với mã tần suất (Days of Operation) và nằm trong dải ngày `Effective Date` đến `Discontinue Date` của file Excel gốc[cite: 2].
*   **Rule 1.2 - Giữ nguyên thời gian thực:** Khung giờ đến (`STA`) và đi (`STD`) phải được giữ nguyên giá trị tuyệt đối từ file gốc. Tuyệt đối KHÔNG áp dụng thuật toán cộng ngày (+1 day) cho các chuyến bay có khung giờ vắt qua nửa đêm.
*   **Rule 1.3 - Chuẩn hóa định dạng Số hiệu (Flight Number Standardization):**
    *   Số hiệu chuyến bay cấu thành từ `Airline` + `Flight`. Nếu `Flight` chỉ có chữ số thì padding bằng số 0 để đảm bảo đủ 3 chữ số. Ví dụ: `TW` + `8` -> `TW008`, `NX` + `978` -> `NX978`.
    *   Tất cả ký tự trong trường `Flight` của file nguồn là một phần của số hiệu chuyến bay. Ví dụ: `ZE` + `593A` -> `ZE593A`; không bóc tách `A` thành `Request Status Code`.

## 2. QUY TẮC LIÊN KẾT & CẤU TRÚC (STRUCTURAL RULES)
*   **Rule 2.1 - Chặng bay độc lập (Independent Legs):** Mỗi lượt bay (Arrival hoặc Departure) được quản lý như một Object (Flight Leg) hoàn toàn độc lập với một `ID` duy nhất.
*   **Rule 2.2 - Nhận diện cặp chuyến (Turnaround Linking):** Các chặng Đến và Đi nằm trên cùng 1 dòng của tệp Excel đầu vào phải được chia sẻ chung một mã `linkID` để duy trì mối quan hệ vòng quay tàu bay.
*   **Rule 2.3 - Xử lý chuyến khuyết (Single-leg Handling):** Các chuyến bay chỉ có chiều đến hoặc chiều đi (như Ferry, RON) vẫn được tạo `ID` bình thường, nhưng giao diện (UI) bắt buộc phải hiển thị dạng viền nét đứt (dashed border) để điều phối viên dễ dàng nhận diện và xử lý.

## 3. QUY TẮC THAO TÁC (MUTATION & STATE RULES)
*   **Rule 3.1 - Môi trường đệm (Sandbox Isolation):** Mọi thao tác chỉnh sửa chỉ diễn ra trên tập dữ liệu chi tiết đã được "bung", không tác động trực tiếp vào file gốc[cite: 2].
*   **Rule 3.2 - Quản lý trạng thái bằng Xóa mềm (Soft-delete):** 
    *   Hệ thống nghiêm cấm Hard-delete. 
    *   Khi người dùng xóa một chuyến bay, trạng thái vòng đời (`Action`) của chặng bay đó sẽ được cập nhật thành `deleted`. 
    *   Các trạng thái khả dụng khác: `null` (chưa chỉnh sửa), `modified` (đã cập nhật thông số), `added` (tạo mới thủ công).
*   **Rule 3.3 - Hiển thị trạng thái:** Các chuyến bay có `Action = 'deleted'` phải được hiển thị mờ hoặc gạch ngang trên giao diện Lịch bay thay vì biến mất hoàn toàn.

## 4. QUY TẮC GỘP CHUYẾN & XUẤT FILE (PATTERN GROUPING & EXPORT RULES)
*   **Rule 4.1 - Điều kiện gộp mẫu khắt khe (Strict Matching):** Các chuyến bay chỉ được gộp chung thành một Pattern tuần nếu trùng khớp hoàn toàn 100% cả 4 tham số: `Clean Flight Number`, `Route`, `Aircraft`, và `Schedule`[cite: 2].
*   **Rule 4.2 - Lọc dữ liệu xuất (Export Filtering):** Thuật toán gộp mẫu sẽ tự động bỏ qua toàn bộ các bản ghi mang trạng thái `Action = 'deleted'`.
*   **Rule 4.3 - Ngắt dòng ngoại lệ tuyệt đối (Strict Pattern Splitting):** Nếu trong một chu kỳ khai thác xuất hiện sự gián đoạn (do chuyến bay bị xóa hoặc chỉnh sửa thông số), hệ thống bắt buộc phải cắt gãy dải ngày `Effective` và `Discontinue` thành các dòng Excel độc lập (Trước ngoại lệ - Giai đoạn ngoại lệ - Sau ngoại lệ)[cite: 2]. Đảm bảo file kết xuất phản ánh chính xác từng ngày vận hành mà không chứa các chuyến bay "ảo".
*   **Rule 4.4 - Format nguyên bản:** File Excel đầu ra phải tuân thủ chính xác định dạng, cấu trúc cột và thứ tự của file lịch mùa gốc.
