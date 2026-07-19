# Seasonal Import/Export Task 9 Verification

## Scope And Safety Boundary

- Production inspection target: self-hosted Supabase PostgreSQL reached through the approved SSH host. Credentials are intentionally omitted.
- PostgreSQL commands used `psql -X -v ON_ERROR_STOP=1` against database `postgres` as `supabase_admin` in container `opsdata-supabase-db`.
- Final read-only audit before the dry run: `2026-07-19 06:13:18 UTC`.
- Final read-only audit after the dry run: `2026-07-19 06:13:23 UTC`.
- The repair artifact ended with executable `rollback;`. No production data or schema mutation was committed.

## Live Season Baseline

| Season | Season ID | Base records | Modifications | Source rows | Added-leg rows | Data version |
|---|---|---:|---:|---:|---:|---:|
| S26 | `season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6` | 26,182 | 1,426 | 0 | 0 | 16,572 |
| W25 | `season-fbe44d36-5c64-4cca-97c3-00a2a6b36451` | 8,165 | 25 | 0 | 0 | 8,227 |
| W26 | `season-f77c5ea9-be54-4615-ab0a-d83062b9b854` | 26,641 | 627 | 0 | 0 | 395 |

All S26/W25/W26 modifications are owned by base `season_flight_records`. There are zero `action='added'` modifications and zero `season_modification_added_legs`. Existing `source_kind='added'` rows are legacy base records, not reconstructable added-modification payloads. The repair does not fabricate source rows or added legs.

## Blocking Findings

### S26 PR585/PR586 duplicate base occurrences

Both discarded rows are hidden by exact `deleted` overlays with empty `changed_fields`. All four records and both overlays have zero counter, check-in-window, modification-child, and added-leg rows.

| Flight/date | Preserve effective record | Discard hidden duplicate |
|---|---|---|
| PR585, 2026-06-10 | `F_NEW_1780796888039_giomqg_1` | `LEG_A_2026-06-10_110_PR_PR585_MNL_15_20_321` |
| PR586, 2026-06-10 | `F_NEW_1780795793508_ycwhyq_0` | `LEG_D_2026-06-10_110_PR_PR586_MNL_16_30_321` |

The preserved records are an existing reciprocal ARR/DEP pair. The dry run proved their effective canonical hash remained `478ad5ba37d374861ed9cb0e82639d64` after deleting only the two hidden duplicates and their overlays.

### S26 ambiguous turnaround groups

The audit found two turnaround IDs with eight effective rows. Exact underlying inspection found ten rows forming five verified reciprocal pairs:

- HX: six underlying rows, three reciprocal pairs; the imported 2026-08-24 pair has two `deleted` overlays, leaving four effective rows and two effective pairs.
- RF: four underlying and effective rows, forming two reciprocal pairs.

The repair maps only these reciprocal ID pairs to deterministic unique turnaround IDs:

| Verified pair members | New turnaround ID | Effective before repair |
|---|---|---|
| `LEG_A_2026-08-23_943_HX_HX542_HKG_03_00_320`, `LEG_D_2026-08-23_943_HX_HX543_HKG_04_00_320` | `TRN_V2_2026-08-24_HX542_HX543_LEG` | No; both have deleted overlays |
| `F_NEW_1784417194491_ojlo5j_1`, `F_NEW_1784417194491_ojlo5j_2` | `TRN_V2_2026-09-02_HX542_HX543_FNEW1784417194491` | Yes |
| `F_NEW_1784417194495_2zf5s7_1`, `F_NEW_1784417194495_2zf5s7_2` | `TRN_V2_2026-09-18_HX542_HX543_FNEW1784417194495` | Yes |
| `LEG_A_2026-07-19_618_RF_RF531_CJJ_23_55_320`, `LEG_D_2026-07-19_619_RF_RF532_CJJ_00_55_320` | `TRN_V2_2026-07-19_RF531_RF532_LEG` | Yes |
| `F_NEW_1783648329496_a90ngi_1`, `F_NEW_1783648329496_a90ngi_2` | `TRN_V2_2026-07-20_RF531_RF532_FNEW1783648329496` | Yes |

All ten rows have reciprocal `linked_record_id` values and zero record/modification child rows. No pair was inferred from flight number, time, or proximity.

### W25 JX703 orphan

- Existing row: `DAILY_IMPORT_A_2025_10_31_JX703_TPE_17_15_32Q`.
- Missing asserted counterpart: `DAILY_IMPORT_D_2025_10_31_JX704_TPE_18_25_32Q`.
- The JX703 row has no overlay, counter, or check-in-window children.
- The repair clears only `linked_record_id` and `turnaround_id`. It does not fabricate JX704.

### W25 classification remains unresolved by design

All 8,165 W25 records are legacy `DAILY_IMPORT_*` base rows marked `source_kind='added'`, but the available records cover only `2025-10-26..2026-02-01`. The season bounds are `2025-10-26..2026-03-28`, and there are zero source rows from which to prove the missing baseline.

The repair asserts this incomplete state and performs no W25 reclassification. W25 source-row re-import remains blocked until an authoritative complete workbook is staged through V2.

## Informational Findings

- S26 has 1,616 raw flight-number padding differences.
- W26 has 1,492 raw flight-number padding differences.
- Both groups have zero airline mismatches and zero canonical `flight_number` mismatches. The differences are only values such as raw `81` versus canonical raw `081`.
- The occurrence and export contracts normalize through the canonical full flight identity. Task 9 therefore records these as informational and does not rewrite 3,108 production rows.

## Dry-Run Result

The transaction created timestamped backups using this exact naming strategy:

```text
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_seasons
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_records
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_record_counters
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_record_windows
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_modifications
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_mod_counters
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_mod_windows
maintenance.seasonal_fix_<UTC YYYYMMDDtHHMMSSz>_added_legs
```

Dry-run tag: `20260719t061322z`. Backups contained 2 season rows, 13 affected base records, 4 affected modifications, and zero child/added-leg rows, matching assertions.

Inside the transaction after repair simulation:

- S26 base records: 26,180.
- S26 modifications: 1,424.
- W25 base and legacy-added records: 8,165, unchanged.
- Duplicate imported occurrences, invalid effective turnaround cardinality, orphan links, non-reciprocal links, and orphan modifications: zero.
- S26/W25 simulated data versions: 16,573 and 8,228.

The final `ROLLBACK` succeeded. A separate catalog query found zero tables matching `maintenance.seasonal_fix_20260719t061322z_%` afterward.

## Persistent-State Proof

| Season | Before fingerprint | After fingerprint | Counts unchanged |
|---|---|---|---|
| S25 | `647e095aa9a25eb666753cbfe0e50e43` | `647e095aa9a25eb666753cbfe0e50e43` | Yes |
| S26 | `097e4e976fb8106343c93f366cdc9ea2` | `097e4e976fb8106343c93f366cdc9ea2` | Yes |
| W25 | `0c1b151941e3c08707fe040152890631` | `0c1b151941e3c08707fe040152890631` | Yes |
| W26 | `7bd171520a385ec980bff2216e4b1a35` | `7bd171520a385ec980bff2216e4b1a35` | Yes |

The before/after audit category summaries also matched exactly. Production remains in the pre-repair state.

## Constraint Deployment Order

The additive migration and schema install:

- Supporting indexes for `(season_id, date, airline, flight_number)`, `(season_id, operational_date)`, and `(season_id, turnaround_id)`.
- A canonical scalar occurrence normalizer shared by constraints and guards.
- A season-locking trigger that rejects future effective manual-added occurrence collisions against base or other added records.
- `finalize_seasonal_occurrence_constraints_v2()`, which refuses dirty data and creates the active imported occurrence unique index only after cleanup.

The additive migration does not invoke the finalizer, so the known PR duplicates cannot make Task 12 deployment fail. The repair invokes it after removing the asserted duplicates. Current Task 9 production dry-run reports the finalizer as deferred because the additive migration is not deployed yet.

## Local Verification

- `npm run test:seasonal-import-sql`: passed; PGlite migration ran twice, the manual-added collision trigger rejected a direct collision, and the finalizer rejected intentionally dirty fixtures.
- `npm run test:seasonal-schema-twice`: passed; full schema ran twice.
- Focused import/export source and contract tests: 38 passed.
- `npm run test:rules`: passed.
- Structural audit check: no DML/DDL statement; read-only transaction; final `ROLLBACK`.
- `git diff --check`: passed.

## Deferred Task 12 Commit

1. Deploy the additive migration without invoking the occurrence finalizer.
2. Stage S26 and W26 source rows in preview-only mode and approve shadow parity.
3. Rerun the read-only audit. If any asserted count, ID, data version, or state changed, regenerate this repair rather than weakening assertions.
4. Change only the repair artifact's final executable `rollback;` to `commit;` and run it with `psql -X -v ON_ERROR_STOP=1`.
5. Confirm the timestamped maintenance tables persist, the finalizer created `season_flight_records_active_imported_occurrence_v2_key`, and the post-commit audit has zero repaired blocking categories.

No production `COMMIT` is authorized or performed in Task 9.
