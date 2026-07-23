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

## Task 10 Evidence

### Real PostgreSQL concurrency and ownership

The database runner used an isolated PostgreSQL 17.6 database reached only
through a localhost tunnel. It recreated the canonical schema, applied V3, and
ran the SQL suite plus client-level concurrency barriers.

Results:

- two commits of one batch produced exactly one schedule event;
- competing previews against one season version produced one commit;
- a concurrent normal season mutation fenced the stale commit with SQLSTATE
  `40001`;
- cancel racing commit produced one terminal `committed` status;
- cross-owner status, cancel, and commit calls failed with SQLSTATE `42501`.

### Authenticated load and fault matrix

Five Book3-sized synthetic merge runs generated 98 occurrences each under the
real authenticated eight-second statement timeout:

```text
merge stage p95/max: 246.07 ms
merge commit p95/max: 213.63 ms
SQLSTATE 57014: 0
```

A full W26 replace used 130 source rows and generated 26,370 occurrences:

```text
full replace stage: 7,106.60 ms
full replace commit: 3,082.98 ms
SQLSTATE 57014: 0
```

The bulk commit keeps the normal collision trigger active for ordinary writes.
Only records locked into the current V3 commit's temporary staged set use the
set-wise collision recheck. This removed the former per-row trigger timeout
without widening the authenticated role timeout.

Fault injection passed before stage, after stage response, before commit,
after a lost commit response, after commit before refresh, and during status.
Recovery remained status-only, duplicate commit count stayed zero, and observed
V2/SQLite fallback count stayed zero.

### Compatibility gates

- V2 full W26 load generated 26,370 occurrences with zero duplicates.
- S26/W26 import-export round trips preserved occurrence signatures and exact
  flight-pair closure with zero duplicate flight numbers.
- Workspace-window V2 migrations and SQL integration tests passed on PostgreSQL
  17.6, including the canonical-schema idempotency path.
- V3 PGlite migration rerun, canonical schema applied twice, and rule
  regressions passed.
- The complete TypeScript source suite passed 412/412 tests.
- TypeScript, focused ESLint, and the Next.js production build passed.

Commands:

```text
npm run test:seasonal-import-v3-db
npm run test:seasonal-import-v3-load
npm run test:seasonal-import-v2-load
npm run test:seasonal-roundtrip
npm run test:seasonal-import-v3-sql
npm run test:seasonal-schema-twice
npm run test:rules
node --experimental-strip-types --test <all TypeScript test files>
npx tsc --noEmit --pretty false
npx eslint <V3 implementation and harness files>
npm run build
```

## Remaining Release Gates

- Production read-only preflight and additive migration.
- Preview-only live shadow. The supplied workbook still has 118 occurrences
  and overlapping first three rows; the corrected 98-occurrence workbook is
  not currently available at the supplied path.
- Native build, updater publication, and installation verification.
