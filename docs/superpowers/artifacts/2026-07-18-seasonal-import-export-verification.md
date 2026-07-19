# Seasonal Import/Export Task 9 Verification

## Scope And Safety Boundary

- Production inspection target: self-hosted Supabase PostgreSQL reached through the approved SSH host. Credentials are intentionally omitted.
- PostgreSQL commands used `psql -X -v ON_ERROR_STOP=1` against database `postgres` as `supabase_admin` in container `opsdata-supabase-db`.
- P1 follow-up full read-only audit before the dry run: `2026-07-19 08:23:02.897333 UTC`.
- P1 follow-up full read-only audit after the dry run: `2026-07-19 08:24:56.689707 UTC`.
- The repair artifact ended with executable `rollback;`; structural validation found zero uncommented `commit;` statements. No production data or schema mutation was committed.
- A separate read-only production catalog check at `2026-07-19 08:25:00.971541 UTC` found zero Task 9 backup tables and zero deployed copies of the three new effective-base/overlay helper functions sampled by this follow-up. The production dry run is therefore accurately classified as predeploy.

## Live Season Baseline

| Season | Season ID | Base records | Modifications | Source rows | Added-leg rows | Data version |
|---|---|---:|---:|---:|---:|---:|
| S26 | `season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6` | 26,182 | 1,426 | 0 | 0 | 16,572 |
| W25 | `season-fbe44d36-5c64-4cca-97c3-00a2a6b36451` | 8,165 | 25 | 0 | 0 | 8,227 |
| W26 | `season-f77c5ea9-be54-4615-ab0a-d83062b9b854` | 26,641 | 627 | 0 | 0 | 395 |

All S26/W25/W26 modifications are owned by base `season_flight_records`. There are zero `action='added'` modifications and zero `season_modification_added_legs`. Existing `source_kind='added'` rows are legacy base records, not reconstructable added-modification payloads. The repair does not fabricate source rows or added legs.

## Blocking Findings

The audit emits `severity`, `blocking`, and `blocking_count` on every result row, followed by a machine-readable `__blocking_summary__` row. Both production audits returned `blocking_count=6`, representing these six blocking finding rows:

| Category | Season | Finding rows | Members |
|---|---|---:|---|
| `duplicate-active-imported-baseline-occurrence` | S26 | 2 | PR585 and PR586 duplicate groups |
| `invalid-turnaround-cardinality` | S26 | 2 | HX and RF effective turnaround groups |
| `invalid-turnaround-cardinality` | W25 | 1 | JX703 singleton group |
| `orphan-link` | W25 | 1 | JX703 points to absent JX704 |

Inventory, completeness proof, legacy classification, broad base-duplicate inventory, and raw-padding categories are explicitly non-blocking. Only active imported-baseline duplicates are blocking; deleted, inactive, and legacy-state base duplicates are not promoted into that gate.

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
- The follow-up audit now separates base rows from effective/manual added-leg rows and canonical mismatches from raw padding-only differences.
- Base rows have zero airline mismatches and zero canonical `flight_number` mismatches. The differences are only values such as raw `81` versus canonical raw `081`.
- Production has zero added-leg rows, so canonical added-leg mismatches and added-leg raw-padding findings are both zero.
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

P1 follow-up dry-run tag: `20260719t082433z`. Backups contained 2 affected season rows, 13 affected base records, 4 affected modifications, and zero child/added-leg rows, matching assertions.

Inside the transaction after repair simulation:

- S26 base records: 26,180.
- S26 modifications: 1,424.
- W25 base and legacy-added records: 8,165, unchanged.
- The consolidated postcondition reported `0` blocking findings. It includes active imported-baseline duplicates, duplicate effective occurrences, strict effective added legs, added-relation anomalies, base/added ID collisions, orphan modifications, source rows that generate no occurrence, effective orphan/non-reciprocal links, invalid effective turnaround groups, and canonical identity mismatches.
- Effective link validation joins only the effective materialized set; hidden or deleted counterparts cannot satisfy a link.
- S26/W25 simulated data versions: 16,573 and 8,228.
- `SET CONSTRAINTS ALL IMMEDIATE` ran before the final postcondition, finalizer boundary, and rollback. Because the additive migration is not installed on production, this predeploy execution could fire only currently deployed constraints; it did not and could not exercise the new deferred Task 9 triggers.

The final `ROLLBACK` succeeded. At `2026-07-19 08:25:00.971541 UTC`, a separate read-only catalog query found zero tables matching `maintenance.seasonal_fix_20260719t082433z_%` and zero tables matching any `maintenance.seasonal_fix_%` tag.

## Repair Lock Boundary

Before fingerprints or backups, the repair first acquires per-season transaction advisory locks using the exact V2 commit key expression `pg_advisory_xact_lock(hashtextextended(season_id, 0))`. It acquires S26, W26, and W25 in lexical season-ID order, then locks those same three `seasons` rows with one ordered `FOR UPDATE`. Only after both season lock layers succeed does it take `SHARE ROW EXCLUSIVE` locks in a fixed parent-first order on the exact mutable seasonal FK graph observed in the live catalog:

```text
seasons
season_source_rows
season_source_row_days
season_flight_records
season_flight_record_counters
season_flight_record_checkin_windows
season_modifications
season_modification_added_legs
season_modification_counters
season_modification_checkin_windows
season_mod_history_entries
season_mod_history_changes
season_mod_history_record_changes
season_change_events
schedule_notification_deliveries
season_entity_versions
```

The production catalog exposed 17 relevant FK edges. Gates and remarks are columns, not separate seasonal child tables. Task 12 staging tables are locked in the same transaction when they exist. These locks allow ordinary `SELECT` readers while blocking concurrent `INSERT`/`UPDATE`/`DELETE`. `lock_timeout=10s` applies to each lock wait and `statement_timeout=120s` applies to each statement; neither is a total transaction bound. The operator must monitor total wall time and cancel the maintenance transaction if it exceeds the approved threshold. Advisory locks, season-row locks, and table locks are held through deferred checks, postcondition, and rollback or the separately authorized Task 12 commit.

## Persistent-State Proof

| Season | Before fingerprint | After fingerprint | Counts unchanged |
|---|---|---|---|
| S25 | `647e095aa9a25eb666753cbfe0e50e43` | `647e095aa9a25eb666753cbfe0e50e43` | Yes |
| S26 | `097e4e976fb8106343c93f366cdc9ea2` | `097e4e976fb8106343c93f366cdc9ea2` | Yes |
| W25 | `0c1b151941e3c08707fe040152890631` | `0c1b151941e3c08707fe040152890631` | Yes |
| W26 | `7bd171520a385ec980bff2216e4b1a35` | `7bd171520a385ec980bff2216e4b1a35` | Yes |

The complete audit output from `AUDIT 01B` through `ROLLBACK`, covering fingerprints, category rows, `blocking_count=6`, exact IDs, and detail queries, was byte-for-byte identical before and after the dry run. Both normalized sections have SHA-256 `a6791789a249d4f4499c2c5d0eba7001c4c1eead9be63ffcfbb36b44737665`. Production remains in the pre-repair state.

## Follow-Up Spec Review

- Collision protection now covers both mutation surfaces. The child trigger validates direct child inserts/updates, while the parent trigger locks the season and validates an existing child whenever a parent becomes `action='added'`.
- Deferrable, initially deferred constraint triggers on both parent and child reject every final non-added-parent/child relation, added parent without exactly one valid child, identity/action/status/source-kind/source-side mismatch, and missing parent marker. SQL coverage proves malformed final states fail at `SET CONSTRAINTS`, while valid parent-first and child-first atomic sequences both succeed.
- A deferrable overlay-visibility constraint trigger validates final state for both OLD and NEW base identities affected by modification insert, update, move, or delete. It rejects `deleted -> modified`, overlay deletion, and leg/season moves that expose a base collision at `SET CONSTRAINTS ALL IMMEDIATE`, while a coordinated transaction that removes the colliding manual-added relation succeeds regardless of write order.
- Cross-table guards cover every effective base-table record regardless of `source_kind`, including legacy W25 rows stored as `source_kind='added'`. Child-backed manual additions remain distinguished by `season_modification_added_legs`, so legacy base rows do not self-collide. Manual-after-legacy-base and legacy-base-after-manual insert/update bypasses are rejected; non-colliding writes remain valid. The base-only unique index remains intentionally scoped to active imported baseline rows.
- The repair acquires the same advisory key used by `commit_seasonal_import_v2`, in deterministic season-ID order, before its ordered season-row locks and then the table graph. No table lock is held while waiting for a V2 season lock.
- Occurrence identity matches `atomicSchedule.ts`: `record.date` is authoritative, airline and candidate flight strings are trimmed before fallback, and canonical flight identity follows `cleanFlightNumber`, including prefixed values and numeric padding. The helper, guards, finalizer index, audit, and repair postcondition use these semantics for both base and effective added legs.
- The postcondition and audit share the same effective-base/effective-added concepts. The known incomplete W25 legacy classification remains an explicit non-action and is not weakened into a guessed repair.

## Constraint Deployment Order

The additive migration and schema install:

- Supporting indexes for `(season_id, date, airline, flight_number)`, `(season_id, operational_date)`, and `(season_id, turnaround_id)`.
- A canonical scalar occurrence normalizer shared by constraints and guards.
- Season-locking parent, child, base, and overlay guards that reject future effective occurrence collisions across manual-added children and base records of every `source_kind`.
- Deferrable parent/child constraint triggers that preserve the atomic parent-first write order while preventing a transaction from committing an `added` parent without its matching child.
- `finalize_seasonal_occurrence_constraints_v2()`, which refuses dirty data and creates the active imported occurrence unique index only after cleanup.

The additive migration does not invoke the finalizer, so the known PR duplicates cannot make Task 12 deployment fail. The repair invokes it after removing the asserted duplicates. Current Task 9 production dry-run reports the finalizer as deferred because the additive migration is not deployed yet; the production catalog check independently confirmed all three sampled Task 9 helper/validator counts are zero.

## Local Verification

- `npm run test:seasonal-import-sql`: passed in 7,242 ms; PGlite migration ran twice. Its migrated dry-run-equivalent transaction exercised the new deferred triggers, rejected malformed parent/child final states, overlay exposure collisions, all legacy-base/manual-added insertion and update bypasses, and both base/added collision directions. It accepted valid parent-first and child-first creation, a coordinated overlay exposure/manual removal, and non-colliding legacy base writes, forced `SET CONSTRAINTS ALL IMMEDIATE`, verified post-state assertions, and ended with `rollback;`.
- `npm run test:seasonal-schema-twice`: passed; full schema ran twice.
- Focused parser/import/export/selection/pairing tests: 64 passed, 0 failed.
- Export snapshot, source-boundary, raw-flight parity, and Supabase source contract tests: 40 passed, 0 failed.
- `npm run test:rules`: passed.
- Migration/schema occurrence-constraint blocks are byte-for-byte equal: 723 lines each, SHA-256 `0996d3c7ac36ced4456f1f24bb2edb7ef10dc7cf9685dfc99486c0eea473913a`.
- Structural audit check: zero DML/DDL statements and a repeatable-read read-only transaction.
- Structural repair check: exact V2 advisory locks precede ordered season-row locks, all 16 table locks precede fingerprints/backups, one executable `SET CONSTRAINTS ALL IMMEDIATE` fires before the postcondition, the final executable statement is `rollback;`, and uncommented `commit;` count is zero.
- `git diff --check`: passed.

## Deferred Task 12 Commit

1. Deploy the additive migration without invoking the occurrence finalizer.
2. Stage S26 and W26 source rows in preview-only mode and approve shadow parity.
3. Rerun the read-only audit. If any asserted count, ID, data version, or state changed, regenerate this repair rather than weakening assertions.
4. Rerun the complete repair dry run after deployment so `SET CONSTRAINTS ALL IMMEDIATE` exercises the newly deployed deferred triggers; require postcondition zero, unchanged persistent fingerprints after rollback, and zero leaked backups.
5. Change only the repair artifact's final executable `rollback;` to `commit;` and run it with `psql -X -v ON_ERROR_STOP=1`.
6. Confirm the timestamped maintenance tables persist, the finalizer created `season_flight_records_active_imported_occurrence_v2_key`, and the post-commit machine audit reports `blocking_count=0`.

No production `COMMIT` is authorized or performed in Task 9 or this follow-up.
