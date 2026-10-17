# Báo cáo triển khai: Tối ưu hiệu năng Commit Daily Schedule Import (Khắc phục lỗi Statement Timeout 57014)

**Ngày thực hiện:** 2026-09-21  
**Mã migration:** `20260921021500_daily_schedule_import_survivor_perf_fix`  
**Host Production:** `100.91.158.79` (container `opsdata-supabase-db`)  
**Receipt ops host:** `/home/ops/daily-import-perf-fix-20260921/`  

---

### 1. Nguyên nhân gốc rễ của lỗi `canceling statement due to statement timeout [57014]`

1. **Giới hạn thời gian mặc định của Role API (`authenticator` / `authenticated`):**
   - Trên Supabase, role `authenticator` và `authenticated` có `statement_timeout = 8s`.
   - RPC `commit_daily_schedule_import_v1` chưa được cấu hình `statement_timeout` ở cấp hàm (trong khi `commit_seasonal_import_v3` đã được cấu hình `180s`).
2. **Kế hoạch thực thi chậm trong câu lệnh UPDATE rã cặp chuyến sống sót (Survivor Update):**
   - Câu lệnh:
     ```sql
     update public.season_flight_records survivor
     set ...
     where survivor.season_id = v_target.season_id
       and survivor.linked_record_id in (
         select deleted.record_id from public.season_flight_records deleted ...
       );
     ```
   - Bảng `season_flight_records` chưa có index trên `linked_record_id` và `superseded_by_batch_id`.
   - Với 267 dòng bị xóa trong đợt Daily replace, query planner chạy **Nested Loop**: với mỗi dòng bị xóa, Postgres quét tuần tự 25.000 dòng active của mùa, đồng thời gọi hàm PL/pgSQL `is_canonical_flight_leg_active_v1` trên từng dòng ($267 \times 25.000 = 6.675.000$ lần đánh giá).
   - Câu lệnh này mất **34 đến 45 giây**, vượt quá ngưỡng 8 giây $\to$ Bị Postgres hủy ngang với lỗi `canceling statement due to statement timeout`.

---

### 2. Chi tiết giải pháp kỹ thuật đã áp dụng

1. **Bổ sung 2 Partial Indexes trên `season_flight_records`:**
   - `CREATE INDEX idx_season_flight_records_linked_record ON public.season_flight_records (season_id, linked_record_id) WHERE linked_record_id IS NOT NULL;`
   - `CREATE INDEX idx_season_flight_records_superseded_batch ON public.season_flight_records (season_id, superseded_by_batch_id) WHERE superseded_by_batch_id IS NOT NULL;`
2. **Chuyển đổi câu lệnh UPDATE sang cú pháp JOIN trực tiếp:**
   - Sử dụng `FROM public.season_flight_records deleted WHERE survivor.linked_record_id = deleted.record_id`.
   - Thay thế hàm PL/pgSQL bằng predicate sargable: `survivor.status = 'active' AND coalesce(survivor.action, '') <> 'deleted'`.
   - Thời gian thực thi của câu lệnh giảm từ **34+ giây** xuống còn **0,059 mili-giây** (nhanh gấp $500.000$ lần).
3. **Cấu hình `statement_timeout = 180s` ở cấp hàm:**
   - `ALTER FUNCTION public.commit_daily_schedule_import_v1(uuid, jsonb, text) SET statement_timeout = '180s';`

---

### 3. Kết quả xác minh kỹ thuật

1. **Tiêu chuẩn tiêu hóa (Function Digests):**
   - **Pre-digest (Preimage):** `93d19f9acc19077f8da6ebb17a91442e`
   - **Post-digest (Sau khi patch):** `c7c704ce2d8956036f0b5ab4a4acd49a`
   - **Rollback rehearsal:** Khôi phục byte-exact tuyệt đối về `93d19f9acc19077f8da6ebb17a91442e`.
2. **Đo đạc thực tế toàn trình (End-to-End Benchmark):**
   - Thời gian commit toàn bộ batch Daily 256 chặng (thay thế 267 chặng cũ, rebase 122 overlay, recalculate checksum, pair 1:1): **1,247 giây** (so với trước đây chạy > 40 giây bị timeout).
3. **Trạng thái hệ thống:**
   - Mùa S26 giữ nguyên dữ liệu gốc `data_version = 16598`, 19.514 chặng bay đã ghép cặp nguyên vẹn.
   - Biên lai trên Ops Host tại `/home/ops/daily-import-perf-fix-20260921/` xác nhận `sha256sum -c SHA256SUMS` đạt `OK`.
