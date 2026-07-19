# Seasonal Import/Export Task 9 Verification

## Scope And Safety Boundary

- Production inspection target: self-hosted Supabase PostgreSQL reached through the approved SSH host. Credentials are intentionally omitted.
- PostgreSQL commands used `psql -X -v ON_ERROR_STOP=1` against database `postgres` as `supabase_admin` in container `opsdata-supabase-db`.
- Final P1 NOWAIT follow-up full read-only audit before the dry run: `2026-07-19 08:43:14.018118 UTC`.
- Final P1 NOWAIT follow-up full read-only audit after the dry run: `2026-07-19 08:44:04.485386 UTC`.
- The repair artifact ended with executable `rollback;`; structural validation found zero uncommented `commit;` statements. No production data or schema mutation was committed.
- A separate read-only production catalog check at `2026-07-19 08:44:08.577654 UTC` found zero Task 9 backup tables. The production dry run remains accurately classified as predeploy.

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

Final P1 NOWAIT follow-up dry-run tag: `20260719t084333z`. Backups contained 2 affected season rows, 13 affected base records, 4 affected modifications, and zero child/added-leg rows, matching assertions.

Inside the transaction after repair simulation:

- S26 base records: 26,180.
- S26 modifications: 1,424.
- W25 base and legacy-added records: 8,165, unchanged.
- The consolidated postcondition reported `0` blocking findings. It includes active imported-baseline duplicates, duplicate effective occurrences, strict effective added legs, added-relation anomalies, base/added ID collisions, orphan modifications, source rows that generate no occurrence, effective orphan/non-reciprocal links, invalid effective turnaround groups, and canonical identity mismatches.
- Effective link validation joins only the effective materialized set; hidden or deleted counterparts cannot satisfy a link.
- S26/W25 simulated data versions: 16,573 and 8,228.
- `SET CONSTRAINTS ALL IMMEDIATE` ran before the final postcondition, finalizer boundary, and rollback. Because the additive migration is not installed on production, this predeploy execution could fire only currently deployed constraints; it did not and could not exercise the new deferred Task 9 triggers.

The final `ROLLBACK` succeeded. At `2026-07-19 08:44:08.577654 UTC`, a separate read-only catalog query found zero tables matching `maintenance.seasonal_fix_20260719t084333z_%` and zero tables matching any `maintenance.seasonal_fix_%` tag.

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

The production catalog exposed 17 relevant FK edges. Gates and remarks are columns, not separate seasonal child tables. Task 12 staging tables are locked in the same transaction when they exist. All 16 static graph locks and both optional staging locks use `SHARE ROW EXCLUSIVE MODE NOWAIT`: ordinary `SELECT` readers remain allowed, but any conflicting direct writer makes lock acquisition fail immediately before fingerprints, backups, or mutations. With `psql -X -v ON_ERROR_STOP=1` and the artifact's `\set ON_ERROR_STOP on`, psql stops the script and closes the connection; PostgreSQL rolls back the open transaction and releases the advisory and season-row locks already acquired. The operator must quiesce direct writers and retry the complete artifact instead of waiting through a lock cycle.

`lock_timeout=10s` still applies per wait outside the `NOWAIT` graph statements, and `statement_timeout=120s` applies per statement; neither is a total transaction bound. The operator must monitor total wall time and cancel if it exceeds the approved threshold. On a successful idle-server run, advisory locks, season-row locks, and table locks are held through deferred checks, postcondition, and rollback or the separately authorized Task 12 commit.

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
- Every table-graph lock is fail-fast `NOWAIT`. Structural coverage requires all 16 static locks and both optional staging locks to retain deterministic order and `SHARE ROW EXCLUSIVE` mode, and requires `ON_ERROR_STOP` before the first lock/fingerprint boundary.
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
- Focused source structural tests: 17 passed, 0 failed. The new test was first observed failing against the non-NOWAIT artifact, then passed after the repair update.
- Structural repair check: exact V2 advisory locks precede ordered season-row locks; all 16 static and both optional staging table locks use `SHARE ROW EXCLUSIVE MODE NOWAIT` before fingerprints/backups; `ON_ERROR_STOP` is set before lock acquisition; one executable `SET CONSTRAINTS ALL IMMEDIATE` fires before the postcondition; the final executable statement is `rollback;`; and uncommented `commit;` count is zero.
- A local two-session lock-manager probe was not run because this workstation has no Docker CLI, local `psql`, or PostgreSQL service, while PGlite does not provide an equivalent multi-session PostgreSQL lock manager. The production idle-server dry run successfully exercised the NOWAIT statements; no conflicting writer was introduced on production solely for testing.
- `git diff --check`: passed.

## Deferred Task 12 Commit

1. Deploy the additive migration without invoking the occurrence finalizer.
2. Stage S26 and W26 source rows in preview-only mode and approve shadow parity.
3. Rerun the read-only audit. If any asserted count, ID, data version, or state changed, regenerate this repair rather than weakening assertions.
4. Rerun the complete repair dry run after deployment so `SET CONSTRAINTS ALL IMMEDIATE` exercises the newly deployed deferred triggers; require postcondition zero, unchanged persistent fingerprints after rollback, and zero leaked backups.
5. Change only the repair artifact's final executable `rollback;` to `commit;` and run it with `psql -X -v ON_ERROR_STOP=1`.
6. Confirm the timestamped maintenance tables persist, the finalizer created `season_flight_records_active_imported_occurrence_v2_key`, and the post-commit machine audit reports `blocking_count=0`.

No production `COMMIT` is authorized or performed in Task 9 or this follow-up.

---

# Task 11: Seasonal Import/Export V2 End-to-End Verification

Date: 2026-07-19

## Scope and RED Evidence

Task 11 adds reproducible source-row fixtures and behavioral database, load,
fault-injection, and workbook round-trip harnesses. It does not deploy the V2
migration, repair production data, build a native application, bump a version,
or publish a release.

Observed RED checkpoints before the final implementation:

- The database package command rejected an absent
  `SEASONAL_TEST_DATABASE_URL` and refused any database name outside the
  `seasonal_task11_*` disposable namespace.
- The real two-session race harness expected a legacy `staged` result while
  the current V2 contract correctly persisted `validated`; the assertion
  failed before being aligned with the deployed migration contract.
- The first W26 load cleanup attempted direct season deletion and failed on
  the real foreign-key graph. Cleanup was changed to the product's
  `manage_season_metadata_v2('delete')` boundary, after which the test left
  zero seasons, batches, and test operators.
- This workstation has no local `psql`. A command-shim attempt was rejected by
  Node as `spawnSync psql ENOENT`, proving that a `.cmd` shim did not satisfy
  the direct executable contract. A temporary compiled `psql.exe` wrapper
  outside the repository subsequently made the unchanged package command pass.
- The identity/cleanup quality tests were RED because the database runner had
  no import-safe entry point and the load harness had no shared lifecycle
  helper. The test process failed while importing the missing
  `runSeasonalImportV2DbTest` and `runWithCleanupAndClose` exports. The GREEN
  implementation and behavioral evidence are recorded below.

The follow-up spec review initially found all three required behaviors absent:
the load harness did not invoke the shared committed-refresh helper, the
round-trip did not commit and snapshot the reimport target, and
`unresolvedPairCount` was a literal zero. The corrected behavioral runs below
replace those unsupported assertions.

## Deterministic Fixtures

Both committed JSON fixtures contain canonical source rows only. They contain
no `flightRecords`, atomic record IDs, production rows, or credentials. Real
workbook overrides are opt-in through `SEASONAL_S26_FIXTURE` and
`SEASONAL_W26_FIXTURE`; an override must reproduce the manifest hash and
verified counts.

| Season | Real source workbook | Workbook SHA-256 | Coverage | Source rows | Generated occurrences | Duplicate occurrence keys | Canonical-row SHA-256 |
|---|---|---|---|---:|---:|---:|---|
| S26 | `S26_Updated_1779803544123.xlsx` | `edd1315e3b5a44854d15cd345ba1f99c4770944e91e3dc2f20614e4e751840e5` | 2026-03-29 through 2026-10-25 | 912 | 25,849 | 0 | `e40d314eec9f779f259a07da07b66e1c278b62953a12ab50208e8bbcfb542cd1` |
| W26 | `W26_Alternative.xls` | `97908483683ba6c52f27f23e229957ed171f1db73f86df5a5aa28734e7a9f154` | 2026-10-25 through 2027-03-27 | 130 | 26,370 | 0 | `34ac336788dc112c3e36e9781839a5ccfbcf88927f947ff261ae5e3dd5ddfb21` |

The committed S26 JSON is 662,976 bytes with SHA-256
`49ace884b1931655f078650b29aeaa647b1db9ea86e8098488e4a0dad3697cec`.
The committed W26 JSON is 94,845 bytes with SHA-256
`28f970dbf5cd3cfd0eaaaaa6cfd38352e56c5fe779c25f3ddc4b7e6a296fcb8b`.

The requested `S26_Updated_1783694873754.xlsx` was not present. The selected
S26 workbook is the newest available full-season `S26_Updated` candidate that
strict-parsed with zero duplicate occurrence keys. The dated
`s26_19jul_Q.xls` slice was therefore not used as the success fixture.
`DAD_SeasonalS26.xlsx` remains a negative fixture: 927 source rows, 25,652
generated occurrences, and 319 duplicate occurrence keys.

The W26 workbook contains 16,747 detailed rows. Its fixture is derived only by
the documented daily parser, W26 season partition, canonical normalization,
pairing, source-row grouping, in-memory workbook export, and strict parse.
No missing or unknown flight is synthesized. Re-running both real-workbook
overrides reproduced the committed fixture hashes and counts exactly.

The final local committed-fixture verification strict-parsed and performed an
in-memory workbook round trip without a database. S26 expanded 912 source rows
to 25,849 occurrences with zero duplicates in 29.30 ms. W26 expanded 130
source rows to 26,370 occurrences with zero duplicates in 15.98 ms.

## Real PostgreSQL Integration

A uniquely named database
`seasonal_task11_20260719_185600_dde993` was created on the remote PostgreSQL
17.6 cluster solely for Task 11. The runner verified the database name before
loading the bootstrap, `schema.sql`, tracked V2 migration, SQL integration
suite, and multi-session harness.

The actual command `npm run test:seasonal-import-v2-db` exited `0`. The checked
in runner still calls `spawnSync('psql', argv)` directly, requires
`SEASONAL_TEST_DATABASE_URL` and `SEASONAL_TEST_TEMP_DB=1`, and exits on the
first nonzero child. Because local `psql` is unavailable, the successful run
used a temporary compiled `psql.exe` placed first on `PATH`. It forwarded SQL
and local files through SSH to container-local `psql`; it lived outside the
repository, contained no password, and was deleted after verification.

The true two-session race/idempotency case passed with one batch and 250 staged
rows. PostgreSQL exposed real lock waits: `advisory` for the first client,
`transactionid` for the second, and `relation` for the season lookup. The
cross-season-code lookup remained fail-closed with SQLSTATE `21000` rather
than choosing an arbitrary season.

The corrected follow-up used a second disposable PostgreSQL 17.6 database,
`seasonal_task11_followup_20260719_124455_3b42f0`. The actual package command
again exited `0` in 11.1 seconds through the temporary executable wrapper and
repeated the SQL and true multi-session coverage before the corrected W26 load
and S26/W26 round-trip harnesses ran.

Final pair-diagnostic gap closure used a third disposable PostgreSQL 17.6
database, `seasonal_task11_finalpair_20260719_130607_fda16e`. The package
command exited `0` in 9.8 seconds and again completed the SQL and multi-session
suite before the final S26/W26 round-trip.

The identity/cleanup quality follow-up first exposed an infrastructure mistake
on disposable database
`seasonal_task11_quality_1784468810191_7deb2b`. The direct package runner
correctly verified and loaded schema/migration/SQL through container-local
`psql`, but the Node tunnel pointed at the host's PostgreSQL listener instead
of the unexposed `opsdata-supabase-db` container. Concurrency stopped with
`28P01` before creating its test rows. After the tunnel target was corrected,
Node verified the exact disposable database identity; the run was paused and
the database was dropped rather than claiming an incomplete success. This was
a test-infrastructure endpoint error, not a product or migration failure.

The successful corrected rerun used fresh disposable PostgreSQL 17.6 database
`seasonal_task11_quality_1784469485743_ebaab6`. Before `CREATE DATABASE`, the
orchestrator queried `current_database()` through container-local `psql` and
required the exact value `postgres`. It then obtained the current Docker
container IP, created the disposable database, required its exact identity,
opened a tunnel to that verified container IP, and required an exact Node `pg`
identity match before package DDL. The actual package command exited `0` in
14.42 seconds. The concurrency result reported the same verified database,
one batch, 250 rows, `advisory`, `transactionid`, and `relation` lock waits,
and the expected fail-closed `21000 Ambiguous seasonCode` conflict.

The checked-in runner now captures `psql --tuples-only --no-align` output from
`select current_database()`, accepts exactly one unadorned value, and compares
it in Node to the validated URL database name before schema, migration, or
tests. Fake-`psql` cases prove false, mismatched, empty, and multi-line output
all stop after one preflight invocation with no SQL file call. Both the runner
and concurrency harness require `SEASONAL_TEST_TEMP_DB=1`, localhost, and the
`seasonal_task11_*` namespace. Concurrency independently queries the connected
database before any test DDL or row operation and closes the client on a
mismatch.

## Principal Creation P2 Follow-Up

The final P2 regression was RED because `createTestPrincipals` issued each
auth-user, operator, and permission insert independently. An injected failure
at the second operator insert left six mock rows persisted, emitted no
`ROLLBACK`, and the successful path emitted no `COMMIT`. The outer lifecycle
still called `client.end()`, but it could not run identity-based cleanup because
the principal IDs had correctly not escaped the rejected promise.

The complete two-user creation sequence now runs through the existing
transaction helper. Both UUIDs are generated before `BEGIN` for use by the
inserts, but the principal object is returned only after all ten inserts and
`COMMIT` succeed. Mid-creation failure rolls back every pending auth, operator,
and permission row. Existing aggregate semantics remain intact when an
operation and rollback both fail, and the outer lifecycle still attempts
cleanup and `client.end()` while preserving all primary/cleanup/end errors.

Behavioral mock coverage proves the injected second-operator failure orders
`BEGIN`, six successful inserts, the failing insert, `ROLLBACK`, and `end`,
with zero persisted rows and no exposed principal IDs. The success case proves
ten inserts, `COMMIT`, ID exposure, cleanup, and `end` in that order.

## Tracked Concurrency Contract Follow-Up

The broader seasonal import/export suite exposed one final tracked-test failure:
124 tests passed and one failed because `seasonalImportModeGuard.test.ts`
still required the `SEASONAL_TEST_TEMP_DB` literal in the concurrency harness.
That environment rule had already moved behind the shared
`seasonal-test-database-guard.mjs` boundary, so the assertion no longer
described the runtime contract.

The tracked contract now verifies that the concurrency harness imports
`parseDisposableDatabaseConfig` and `verifyDatabaseIdentityOrClose` from the
shared guard, delegates environment validation through
`parseDisposableDatabaseConfig(process.env)`, and performs the live connected
database identity check through the shared helper before test DDL. Dedicated
shared-guard behavioral tests remain responsible for the temporary-database
flag, localhost restriction, disposable namespace, and exact live identity.
The tracked suite passed 19 of 19 tests in 166 ms after the correction, and the
same broader 16-file seasonal import/export command passed all 125 tests in
900 ms.

## Load and Fault Metrics

The W26 load harness ran against PostgreSQL 17.6 with a clean test season and
batch:

| Metric | Result |
|---|---:|
| Canonical request bytes | 60,896 |
| Client parse | 59.89 ms |
| Stage | 2,923.90 ms |
| Preview | 2,704.29 ms |
| Commit | 14,442.29 ms |
| Generated occurrences | 26,370 |
| Duplicate occurrences | 0 |

The harness rejected atomic `flightRecords`, payloads over 5 MB, zero-record
results, SQLSTATE `57014`, any duplicate count, and any generated-count drift.
No such failure occurred in the verified run.

Behavioral fault injection passed for failure before stage, response loss after
stage, commit-response delivery loss, and post-commit refresh failure. Reusing
the same request ID did not create another batch or recommit. Stage/commit
delivery loss recovered the single committed result.

The refresh case now invokes the actual shared
`loadTargetedCommittedImportRefresh` path after a real commit. Its snapshot
loader called the real export RPC once, changed only `totalCount`, and passed
that precisely malformed response through the strict snapshot materializer.
The materializer rejected the count mismatch and the behavioral result was
`Import committed, refresh failed` with the real season and batch IDs. The
540-byte committed recovery receipt round-tripped through the shared receipt
storage helpers and reconstructed the original minimal commit result. Batch
status, generated count, committed timestamp, season data version, batch count,
and active imported count were identical before and after refresh, proving no
restage or recommit. The receipt contained no source rows, workbook bytes,
filename, or upload payload. This claim is receipt-scoped; normal server
staging still persists canonical source rows by design. Owner, cross-mode, and
version conflicts remained fail-closed (`42501`, `23505`, and version conflict
respectively). The latest corrected W26 load/fault command exited `0` in 27.39
seconds.

Harness cleanup now runs season, batch, operator, permission, and user cleanup
inside one database transaction. A season-delete failure rolls back the prior
batch delete, preserving ownership links for retry. The shared lifecycle
helper always attempts `client.end()` and reports primary, cleanup, and close
errors together when needed. Mock tests prove failure rollback plus close,
successful `BEGIN`/delete/`COMMIT`/close ordering, atomic batch/season rollback,
and preservation of all three simultaneous errors.

## Round-Trip Results

| Season | Imported source rows | Generated occurrences | Export source rows | Workbook bytes | Re-import duplicates | Measured unresolved | Pairs | Turnaround groups | Signature result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| S26 | 912 | 25,849 | 730 | 588,196 | 0 | 0 | 8,861 | 8,861 | Exact match |
| W26 | 130 | 26,370 | 130 | 116,966 | 0 | 0 | 9,571 | 9,571 | Exact match |

| Season | Original committed season ID | Authoritative reimport season ID |
|---|---|---|
| S26 | `season-fc804486-14fb-4214-98ae-736eb1d84c06` | `season-a3d5475b-580e-49b6-8c1e-aeaf1936444b` |
| W26 | `season-7347c871-cea8-4404-8cfe-980d1c475bc7` | `season-e9d72144-6122-4ec8-86eb-5081aca34df3` |

Each path staged and committed into an isolated season, fetched a versioned
export snapshot, built canonical rows and an in-memory workbook, strict-parsed
that workbook, then reimported it through a separate batch. Because the server
enforces one authoritative season per season code, the harness deleted the
original committed season before same-code reimport. It captured the persisted
`_staging.targetSeasonId`, committed the reimport, and asserted that the commit
result and committed batch used that same non-empty target ID and that it
differed from the original ID. It verified authoritative season metadata and
record counts before cleanup.

The harness then fetched a versioned snapshot from the committed reimport
target, ran `materializeEffectiveSeasonalLegs`, and passed those effective legs
to the shared `resolveSeasonalPairs`. `assertEmptyPairDiagnostics` is invoked
independently for the baseline and reimport results before their equality is
checked. Each invocation explicitly requires unresolved, ambiguous,
nonreciprocal, and missing-counterpart counts to equal zero, so identical dirty
states cannot pass. For both fixtures all eight explicit baseline/reimport
checks measured zero. Sorted operational pair signatures, per-pair turnaround
cardinality, turnaround group count, and complete occurrence signatures still
matched the pre-export canonical data. Neither authoritative snapshot was
truncated; neither workbook was empty; missing, extra, duplicate, and count
deltas were zero. The latest two-season round-trip command exited `0` in
238.36 seconds. The harnesses do not read production rows or SQLite.

A local negative test constructs identical baseline and reimport diagnostic
objects with one nonzero field at a time. Equality succeeds by construction,
while both explicit empty assertions reject each of the four fields. This test
passed and is included in the focused count below.

## Production Read-Only Comparison and Task 12 Blocker

The fixture-specific W26 expected count is 26,370. It is not production parity.
The current production W26 active imported baseline contains 26,598 unique
occurrences: all 26,370 fixture signatures are present and production has 228
additional signatures.

The 228 production-only signatures are explained structurally as:

- 154 daily `SQ173` departures from 2026-10-25 through 2027-03-27.
- 23 `AK642` arrivals and 23 `AK643` departures.
- 27 occurrences on 2027-03-28, outside the fixture coverage.
- 1 `HX546` arrival on 2026-12-16.

There are also 175 common-key field differences, mainly empty production
category versus fixture category `J`, plus the known `HX547` schedule mismatch
(`17:55` production versus `21:15` fixture). Task 12 must perform and approve a
preview-only shadow comparison before deployment or repair; the 228-count and
175-field deltas are an explicit blocker, not a Task 11 fixture failure.

Production was queried only in read-only transactions. Before and after the
disposable test, the W26 fingerprint was identical:
`26598|52ff4b3e40369ecd9606f07cbd41a32a`. Production contained zero Task 11 V2
RPCs, zero import-batch tables, and no migration metadata table. No Task 11
migration or mutation was applied to production. The follow-up reran the W26
fingerprint and RPC-count checks in a read-only transaction after its real
PostgreSQL harnesses; the fingerprint still matched and the RPC count remained
zero. The final pair-diagnostic run repeated the same read-only checks with the
same fingerprint and zero Task 11 RPCs.

## Cleanup Evidence

- The disposable database was dropped after terminating matching sessions;
  `pg_database` subsequently returned zero rows for its exact name.
- The verified SSH tunnel process was stopped and local port 55432 had zero
  listeners.
- The temporary wrapper executable/source, askpass, database marker, tunnel
  marker, database secret, production TSV, and fingerprint files were deleted.
  Zero files remained under the Task 11 temporary prefix.
- Final test-database cleanup before drop contained zero test seasons, batches,
  and operators.
- Follow-up database `seasonal_task11_followup_20260719_124455_3b42f0` also
  contained zero seasons, batches, and test operators before drop. Session
  termination found no remaining client, `DROP DATABASE` succeeded, and
  `pg_database` returned zero rows afterward.
- The verified follow-up tunnel PID 16740 was stopped, port 55433 had zero
  listeners, and all ten follow-up wrapper, askpass, secret, marker, and log
  items were deleted. A final local check found zero Task 11 temporary items.
- Final pair-diagnostic database
  `seasonal_task11_finalpair_20260719_130607_fda16e` contained zero seasons,
  batches, and test operators before drop. `DROP DATABASE` succeeded and
  `pg_database` returned zero rows. Tunnel PID 8308 was stopped, port 55434 had
  zero listeners, all nine final wrapper/askpass/secret/log/marker items were
  deleted, and the all-Task-11 temporary-item count was zero.
- The first quality-follow-up database was terminated and dropped after the
  tunnel endpoint incident; `pg_database` returned zero, its verified tunnel
  had zero listeners, and all wrapper/askpass/secret files were removed.
- The successful quality database had exact zero residue across seasons,
  batches, batch rows, source rows, flight records, operators, and auth users
  before drop (`0|0|0|0|0|0|0`). Cleanup revalidated the admin connection as
  `postgres`, terminated matching sessions, dropped the database, and observed
  zero matching `pg_database` rows. Verified tunnel PID 1072 was stopped, port
  55437 had zero listeners, and the complete temporary directory was deleted.
  A separate post-run check found zero matching tunnel processes, listeners,
  or temporary files. The quality run connected to admin database `postgres`
  only for exact identity/catalog checks and creation/drop of the disposable
  database. No schema, migration, fixture DDL, or fixture DML ran in production
  `postgres/public`.
- Principal-creation smoke database
  `seasonal_task11_principals_1784471538421_21d3ae` required exact admin,
  disposable, tunnel, and Node database identities before package DDL. The
  package DB/concurrency command exited `0` in 15.58 seconds, then the real W26
  load/fault command exited `0` in 27.39 seconds using transactional principal
  setup. Residue was exactly `0|0|0|0|0|0|0` for seasons, batches, batch rows,
  source rows, flight records, operators, and auth users. Cleanup revalidated
  admin database `postgres`, dropped the disposable database, observed zero
  `pg_database` rows, stopped verified tunnel PID 10656, and left zero
  listeners, matching SSH processes, wrappers, askpass files, credentials, or
  temporary items. It did not run production schema or fixture mutations.

## Final Verification Matrix

- Focused parser/import/export/selection/pairing/recovery/snapshot and quality
  regression tests: 110 passed, 0 failed in 1,112 ms. This includes the
  identical-nonzero diagnostic rejection plus exact identity, no-schema-on-
  mismatch, concurrency entry guard, principal creation rollback/commit,
  atomic cleanup rollback, and client-close cases.
- Broader 16-file seasonal import/export regression command: 125 passed, 0
  failed in 900 ms. Its immediately preceding RED run was 124 passed and 1
  failed at the obsolete concurrency source-literal assertion; the corrected
  tracked suite itself passed 19 of 19 tests in 166 ms.
- `npm run test:rules`: passed.
- `npx tsc --noEmit --pretty false`: passed.
- Targeted ESLint, including all four Task 11 runtime scripts/harnesses, the
  shared database guard, and both quality regression files: passed.
- `node --check` for those seven JavaScript files: passed.
- `npm run test:seasonal-import-sql`: passed on PGlite; tracked migration ran
  twice in 3,470 ms.
- `npm run test:seasonal-schema-twice`: passed; full schema ran twice.
- `npm run test:seasonal-import-v2-db`: latest real PostgreSQL smoke passed in
  15.58 seconds through the temporary executable wrapper, including
  concurrency.
- `npm run test:seasonal-import-v2-load`: latest real PostgreSQL smoke passed
  in 27.39 seconds with the metrics above.
- `npm run test:seasonal-roundtrip`: passed for real S26 and W26 fixtures in
  238.36 seconds.
- `npm run build`: passed in 57.54 seconds with Next.js 16.2.4; compilation
  completed in 27.9 seconds and all 12 static pages generated.
- Strict UTF-8 decoding passed for all ten pre-quality Task 11 files.
  Mojibake, hardcoded external host/credential/personal-path, and
  trailing-whitespace scans found zero matches; `git diff --check` passed.
- The follow-up repeated strict UTF-8, mojibake, secret, external-host,
  personal-path, trailing-whitespace, stale-claim, and `git diff --check` scans
  over exactly the two corrected harnesses and this verification artifact; all
  scans passed with zero findings.
- The quality follow-up adds one shared guard and two regression files, making
  the cumulative Task 11 boundary exactly 13 files. Final strict UTF-8,
  mojibake, secret, external-host, personal-path, trailing-whitespace, and diff
  scans covered all 13 files; the current follow-up diff itself contains
  exactly eight intended files. All scans passed with zero findings.
- The exact eight follow-up files are the DB runner, DB runner regression,
  shared DB guard, load harness, cleanup regression, round-trip harness,
  concurrency harness, and this verification artifact. No package metadata,
  fixture, migration, schema, production repair, or release file changed.
- The principal-creation P2 follow-up modifies exactly three files: the load
  harness, cleanup regression, and this verification artifact. Final syntax,
  diff, UTF-8, mojibake, secret, external-host, personal-path,
  trailing-whitespace, and fixture-boundary scans covered that exact set and
  the cumulative 13-file Task 11 boundary with zero findings.
- The final tracked-test follow-up modifies exactly two files: the tracked
  Seasonal import mode guard test and this verification artifact. It requires
  no remote database run and performs no production mutation. Final diff,
  strict UTF-8, mojibake, secret, external-host, and personal-path scans covered
  exactly those two files with zero findings.
- Fixture-boundary verification found zero `flightRecords`, `record_id`, or
  `seasonId` keys in either JSON, and zero `.xls` or `.xlsx` files in the Task
  11 Git changes. Both JSON source-row byte counts and SHA-256 values matched
  their manifests.

Task 11 is verification-only. Task 12 remains responsible for additive
production deployment, shadow parity approval, any authorized repair, native
canary build, version bump, updater release, and production smoke testing.
