# Seasonal Partial Import V3 Verification

Date: 2026-07-23

## Scope

This artifact records verification for the server-first Seasonal Import V3
`merge` and `replace` paths. V3 stage, commit, status, cancel, refresh, and
export have no SQLite fallback.

## Task 9 Evidence

### Grouped diagnostics

- PGlite stages two overlapping weekly KE source rows across six dates.
- The server returns exactly two `duplicate-occurrence-key` diagnostics:
  `KE2093` and `KE2094`.
- Each diagnostic identifies source rows `[1, 2]`, reports
  `affectedDateCount=6`, and contains five sample dates.
- Invalid grouped diagnostics keep Commit disabled.
- The fixture exposed and fixed a formatter defect that rendered `KEKE2093`;
  the migration and canonical schema now render `KE2093`.

Commands:

```text
npm run test:seasonal-import-v3-sql
node --experimental-strip-types --test src/lib/seasonalImportPreview.test.ts src/lib/seasonalExportSnapshotContract.source.test.ts src/lib/exporter.test.ts src/lib/seasonalExportSnapshot.test.ts
node --test src/lib/canonicalSeasonalRows.raw-flight.test.cjs
```

Result:

```text
seasonal_partial_import_v3.sql: PASS
focused TypeScript tests: 32/32 PASS
canonical raw-flight tests: 7/7 PASS
```

### Export after synthetic merge

- Export V2 accepts a strict snapshot with `sourceRowCount=0`.
- Select-all contains each of four effective nondeleted records once.
- An omitted baseline pair remains present.
- A deleted-overlay record remains absent.
- Selecting one incoming leg closes the selection over its exact counterpart.
- Canonical output round-trips with identical occurrence signatures.

### Book3 shadow state

The read-only shadow harness:

- parses canonical source rows locally;
- calls only `stage_seasonal_import_v3`;
- records strict counts, grouped diagnostics, duration, and preview hash;
- calls `cancel_seasonal_import_v3` after every parsed stage response;
- has no commit RPC and emits `commitCalled=false`;
- exits nonzero for diagnostics, timeout, malformed counts, identity/strategy
  drift, or failed cancel.

The currently supplied workbook parses as 11 valid source rows and 118 atomic
occurrences. Its first row still operates Wednesday, Thursday, and Friday,
which overlaps rows 2 and 3 for `KE2093` and `KE2094`. The expected corrected
workbook count is 98 after Thursday and Friday are removed from row 1. The
workbook was not modified.

### Blocked external gate

`npm run test:seasonal-roundtrip` stopped before database access because
`SEASONAL_TEST_DATABASE_URL` was not configured. The disposable-database guard
worked as designed; no production database was contacted. This gate must be
rerun with a localhost disposable database during Task 10.

## Pending

- PostgreSQL concurrency and fault matrix.
- V3 load percentiles under the authenticated timeout.
- Production read-only preflight and additive migration.
- Preview-only live shadow with the corrected workbook.
- Native canary, updater build, release, and clean-machine verification.
