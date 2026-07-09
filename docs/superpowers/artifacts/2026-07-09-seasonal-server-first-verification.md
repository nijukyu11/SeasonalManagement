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
- Repair artifact hardening after final code review:
  - Added `maintenance.s26_duplicate_flight_record_counters_backup_20260709`
  - Added `maintenance.s26_duplicate_flight_record_windows_backup_20260709`
  - Added backup counters for child rows before deleting counters/windows
  - Not re-executed against live data because the 9 duplicate target records had already been deleted and the final re-audit remains clean

## Final Automated Verification

- `node --experimental-strip-types --test src/lib/nativeLocalSeasonStore.source.test.ts`: PASS, 4/4
- `node --experimental-strip-types --test src/app/components/syncActionButtonState.test.ts`: PASS, 4/4
- `node --experimental-strip-types --test src/app/seasonalDetailedDraftSave.source.test.ts`: PASS, 3/3
- `node --experimental-strip-types --test src/app/checkin/checkInCommitErrors.test.ts`: PASS, 6/6
- `node --experimental-strip-types --test src/lib/parser.test.ts`: PASS, 3/3
- `node --experimental-strip-types --test src/lib/atomicSchedule.duplicate.test.ts`: PASS, 1/1
- `node --experimental-strip-types --test src/lib/seasonalImportPatch.test.ts`: PASS, 7/7
- `node --experimental-strip-types --test src/lib/detailedScheduleState.test.ts`: PASS, 3/3
- `node --experimental-strip-types --test src/lib/exporter.test.ts`: PASS, 2/2
- `node --experimental-strip-types --test src/lib/onlineFirstMode.source.test.ts`: PASS, 10/10
- `node --experimental-strip-types --test src/app/syncFetchBoundary.source.test.ts`: PASS, 3/3
- `node --experimental-strip-types --test src/app/checkin/workspaceRefreshScope.test.ts`: PASS, 6/6
- Focused suite total: PASS, 52/52
- `npx tsc --noEmit --pretty false`: PASS
- `npm run lint`: PASS with 5 existing warnings and 0 errors
- `npm run build`: PASS, Next.js production build compiled successfully

## Final Real DB Re-Audit

- `docs/superpowers/artifacts/2026-07-09-s26-duplicate-audit.sql`: 0 rows
- `maintenance.s26_duplicate_flight_records_backup_20260709`: 9 backup rows for S26

## Manual UI Smoke

- Seasonal Schedule draft save: NOT_RUN in this terminal session
- Detailed Schedule draft save: NOT_RUN in this terminal session
- Check-in Gantt allocation save: NOT_RUN in this terminal session
- W26 TG copy to empty date: NOT_RUN in this terminal session
- S26 export all: NOT_RUN in this terminal session
