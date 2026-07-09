# Seasonal Server-First Verification - 2026-07-09

## W26 TG Audit

- Status: CONFIRMED_MALFORMED_ROWS
- Dry-run: NOT_APPLICABLE
- Committed: NOT_APPLICABLE
- Read-only audit on real Supabase returned 2 active malformed TG rows:
  - `F_NEW_1783478870768_7fpp66_0`, `2027-01-09`, `flight_number = TGTG559`, `raw_flight_number = TG559`
  - `F_NEW_1783478870768_7fpp66_1`, `2027-01-10`, `flight_number = TGTG559`, `raw_flight_number = TG559`
- No W26 TG data repair was executed in this task.

## S26 Duplicate Repair

- Status: COMPLETE
- Dry-run: COMPLETE
- Committed: COMPLETE
- Repair SQL: `docs/superpowers/artifacts/2026-07-09-s26-duplicate-repair.sql`
- Expected target records: 9 rows, all with `source_kind = 'added'`
- Expected retained records: canonical KC batch `F_NEW_1780654074182_b2t01n_*` and imported PR586 row `F_NEW_1780795793508_ycwhyq_0`
- Dry-run result:
  - `backed_up_records = 9`
  - `deleted_counter_rows = 0`
  - `deleted_window_rows = 0`
  - `deleted_records = 9`
  - Remaining duplicate groups inside transaction: 0 rows
  - Transaction ended with `ROLLBACK`
- Committed result:
  - `backed_up_records = 9`
  - `deleted_counter_rows = 0`
  - `deleted_window_rows = 0`
  - `deleted_records = 9`
  - Remaining duplicate groups inside transaction: 0 rows
  - Transaction ended with `COMMIT`
- Post-commit audit:
  - `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql` returned 0 rows
  - `maintenance.s26_duplicate_flight_records_backup_20260709` contains 9 backup rows for S26
