# Kế hoạch Phát triển (Vertical Slices / Issues)

## Issue #1: Tracer Bullet - Parser cơ bản, chuẩn hóa số hiệu và UI nền tảng
* **Type:** AFK | **Blocked by:** None
* **What to build:** Thiết lập hạ tầng Firebase, UI (Aviation Command). Viết parser đọc 1 dòng Excel và chuẩn hóa `Clean Flight Number` (padding đủ 3 chữ số cho flight thuần số, giữ nguyên ký tự chữ trong flight nguồn). Lưu 1 Document `Flight Leg` xuống Firestore và hiển thị lên bảng dữ liệu UI.
* **Acceptance criteria:**
  - [ ] Khởi tạo Firebase & Cloud Firestore.
  - [ ] Áp dụng Design System Aviation Command.
  - [ ] Module upload cho phép nhận tệp `.xls`.
  - [ ] Gộp `Clean Flight Number` và giữ nguyên ký tự chữ trong flight nguồn (VD: `TW` + `8` -> `TW008`, `ZE` + `593A` -> `ZE593A`).
  - [ ] Lưu thành công 1 `Flight Leg` xuống database và render ra Table.

## Issue #2: Data Expansion Engine & Liên kết cặp chuyến (Turnaround Linking)
* **Type:** AFK | **Blocked by:** Issue #1
* **What to build:** Nâng cấp Parser xử lý dải ngày `Effective`, `Discontinue` và tần suất (1-3-5--). "Bung" dữ liệu thành chặng bay độc lập cho từng ngày. Sinh `linkID` để ghép cặp Đến (A) và Đi (D). Render UI viền nét đứt cho chuyến bay khuyết chiều (Single-leg).
* **Acceptance criteria:**
  - [ ] Thuật toán bung đúng số lượng chặng bay dựa trên dải ngày và tần suất khai thác.
  - [ ] Gán chung `linkID` cho các chặng Arrival và Departure cùng dòng dữ liệu gốc.
  - [ ] UI hiển thị viền nét đứt (dashed border) cho các chuyến bay Single-leg.

## Issue #3: Sandbox Mutations - Chỉnh sửa & Xóa mềm (Soft-Delete)
* **Type:** AFK | **Blocked by:** Issue #2
* **What to build:** Tính năng tương tác trên UI Sandbox. Cho phép chỉnh sửa (giờ, tàu bay) hoặc Xóa. Hệ thống cập nhật trường `Action` thành `modified` hoặc `deleted` (Soft-delete). UI hiển thị mờ/gạch ngang cho chuyến bay bị xóa.
* **Acceptance criteria:**
  - [ ] Click vào `Flight Leg` mở form chỉnh sửa `Schedule` (STA/STD) và `Aircraft`.
  - [ ] Cập nhật Firestore `Action = 'modified'` khi có chỉnh sửa.
  - [ ] Nút Xóa (Delete) cập nhật `Action = 'deleted'`.
  - [ ] Các chuyến bay bị soft-delete hiển thị mờ hoặc gạch ngang trên giao diện.

## Issue #4: Export Engine - Gộp chuyến (Strict Pattern Splitting) & Xuất Excel
* **Type:** AFK | **Blocked by:** Issue #3
* **What to build:** Xây dựng thuật toán Nhận diện mẫu (Pattern Grouping). Quét các chặng bay, gộp theo dải ngày và mã tuần. Áp dụng quy tắc ngắt dải ngày tuyệt đối nếu đứt gãy chu kỳ (do soft-delete). Kết xuất lại tệp `.xls` chuẩn xác.
* **Acceptance criteria:**
  - [ ] Gộp chặng bay dựa trên sự trùng khớp tuyệt đối của `Flight Number`, `Route`, `Aircraft`, và `Schedule`.
  - [ ] Tự động nhận diện mã tần suất tuần (VD: `1-3-5--`).
  - [ ] Bỏ qua các record có `Action = 'deleted'` khi gộp dòng.
  - [ ] Áp dụng `Strict Pattern Splitting`: tự ngắt `Effective/Discontinue` nếu chu kỳ đứt gãy.
  - [ ] File Excel đầu ra khớp format 100% với file gốc `DAD_SeasonalSchedule_S25.xls`.
