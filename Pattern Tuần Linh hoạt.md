### **1. Tổng quan: Pattern Tuần Linh hoạt**

Cơ chế này dùng để tạo lại dòng Seasonal Schedule từ dữ liệu chi tiết mà không làm sai pattern ngày bay. Mục tiêu không chỉ là phủ đúng danh sách ngày bay, mà còn phải xuất ra các dòng có `Effective`, `Discontinue`, và DOW chính xác theo thao tác của người dùng.

Nguyên tắc chính:

1. **Không tạo ngày bay ngoài ý muốn:** Một dòng pattern chỉ hợp lệ nếu khi expand `Effective -> Discontinue` theo DOW, nó sinh ra đúng tập ngày cần xuất, không thừa ngày.
2. **Ưu tiên gom thông minh:** Nếu nhiều ngày có thể gom thành một dòng dài hơn mà vẫn không sinh thêm ngày, hệ thống được phép gom để giảm số dòng.
3. **Tôn trọng phase boundary:** Khi người dùng link/unlink một phase cụ thể, export không được tự gộp ngược phase đó với phase khác chỉ vì flight/route/aircraft/time giống nhau.
4. **Row mapping theo link type:** `sameday` phải export thành một dòng ARR+DEP; `overnight` phải export thành hai dòng riêng.
5. **Overnight +1 chỉ là mapping export:** Dữ liệu DB giữ ngày bay thật. Với cặp manual `linkType: 'overnight'`, dòng DEP khi export phải map theo ARR +1 ngày cho `Effective`, `Discontinue`, và DOW.

### **2. Thuật toán Gom Pattern**

Với một tập ngày cần xuất cho cùng một source-row segment:

1. Sắp xếp tất cả ngày bay theo thứ tự tăng dần.
2. Bắt đầu từ ngày đầu tiên còn lại.
3. Thử mở rộng dần đến ngày xa nhất có thể.
4. Với mỗi khoảng thử, tính DOW từ các ngày trong khoảng đó.
5. Expand lại khoảng thử theo DOW.
6. Chỉ chấp nhận khoảng nếu tập ngày expand ra khớp chính xác tập ngày ban đầu trong khoảng đó.
7. Chọn khoảng hợp lệ dài nhất, tạo một dòng, rồi tiếp tục với các ngày còn lại.

Cách này cho phép gom các tuần lẻ vào pattern chính khi không làm phát sinh ngày bay giả.

### **3. Ví dụ Tuần Lẻ Được Gom Hợp Lệ**

Lịch trình bắt đầu **Thứ Tư, 18/06** và kết thúc **Thứ Ba, 29/07**. Pattern ổn định là `1.3.5.7`.

Tập ngày thực tế gồm:

- Từ 18/06 đến 28/07: các ngày Thứ 2, Thứ 4, Thứ 6, Chủ nhật có bay.
- Ngày 29/07: chỉ có Thứ 3.

Kết quả hợp lệ:

```text
18/06 - 28/07   1.3.5.7
29/07 - 29/07   .2.....
```

Dòng đầu tiên hợp lệ vì expand `18/06 - 28/07` với DOW `1.3.5.7` không sinh thêm ngày bay ngoài tập thực tế. Vì vậy không cần tách thành:

```text
18/06 - 22/06   ..3.5.7
23/06 - 27/07   1.3.5.7
28/07 - 29/07   12.....
```

Ba dòng trên vẫn phủ đúng ngày, nhưng không còn là output ưu tiên vì dòng `28/07 - 29/07 12.....` trộn Thứ 2 và Thứ 3 thành một pattern ngắn không phản ánh tốt nhất quy luật tuần.

### **4. Link Type Export**

Với cặp same-day đã được link, export phải consolidate thành một dòng:

```text
ARR fields + DEP fields trong cùng một record pattern
```

Với cặp overnight đã được link, export phải giữ hai dòng riêng để hệ thống đích link thủ công.

### **5. Overnight Manual Link**

Với cặp overnight đã được người dùng link thủ công:

```text
ARR export pattern = pattern thật của ARR
DEP export pattern = ARR pattern + 1 ngày
```

Ví dụ ARR:

```text
18/06 - 28/07   1.3.5.7
```

DEP export tương ứng:

```text
19/06 - 29/07   12.4.6.
```

Quy tắc này chỉ áp dụng cho export pattern. Không được cộng ngày trực tiếp vào dữ liệu DB hoặc flight leg chi tiết, vì DB đang lưu ngày bay thật.

### **6. Kết luận**

Pattern đúng là pattern vừa phủ chính xác ngày bay, vừa giữ đúng ý nghĩa phase mà người dùng đã tạo qua split, unlink, và relink. Export phải serialize các phase/link segment đã được xác nhận, không được tự tái gom toàn bộ từ daily legs nếu việc đó làm đổi hình dạng dòng pattern.
