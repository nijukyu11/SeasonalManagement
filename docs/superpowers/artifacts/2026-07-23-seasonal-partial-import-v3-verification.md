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

## Task 11 Production Evidence

### Read-only preflight

- Production is PostgreSQL 17.6.
- `authenticated` retains `statement_timeout=8s`; no role timeout was raised.
- V3 RPCs/tables/columns were absent before deployment.
- S26 was version 16,573 with 26,194 physical records, 1,772
  modifications, and 406 deleted overlays.
- W26 was version 397 with 28,034 physical records, 1,802 modifications,
  and 954 deleted overlays.
- The 15-minute PostgreSQL/PostgREST timeout baseline contained zero `57014`
  or statement-timeout logs.

### Deployment and legacy drift repair

The tracked V3 migration was deployed with SHA-256
`fe5677f655b61150b448e489c31195e39342a4a2b207765569199aac012b91f9`.
Post-deploy checks confirmed:

- all four V3 RPCs are executable by `authenticated` and denied to `anon`;
- direct authenticated insert/update/delete on both V3 staging tables is
  denied;
- V2, Export V2, and workspace-window V2 signatures are unchanged;
- the legacy existing-season V2 guard is enabled;
- the authenticated timeout remains eight seconds.

The first live shadow exposed production function-body drift: the deployed V2
stage body required a removed `season_import_batches.client_id` column. The V2
signatures were correct but the implementation could not stage any import. The
old function bodies were backed up to
`ops_hotfix.seasonal_import_v2_functions_20260723`, then the tracked canonical
V2 migration, Export V2 identity hotfix, and V3 migration were applied in one
transaction. V3 also supplies a server-only `seasonal-import-v3` compatibility
marker when calling the V2 canonical staging helper; this does not widen the
client payload.

Reapplying canonical V2 restored older per-row RLS policy bodies. The first
workspace smoke therefore measured 7,262.6 ms p95. The tracked workspace/RLS
optimization chain was immediately reapplied; the repeated full S26 chain
passed:

```text
pages: 53
logical roots: 27,966
p95: 335.13 ms
max: 849.26 ms
duplicate roots: 0
```

Strict live Export V2 parsing also passed:

```text
S26: 26,194 records, 1,772 modifications, 0 source rows, 4,649.22 ms
W26: 28,034 records, 1,802 modifications, 0 source rows, 2,347.69 ms
```

### Dangerous V2 batch

Batch `c0269785-e583-4b41-8136-db7972f347cc` was locked and rechecked against
its exact status, owner, expected version, checksum, 11 source rows, and 98
generated occurrences. Its batch and source rows were backed up to:

```text
ops_hotfix.season_import_batch_c0269785_20260723
ops_hotfix.season_import_rows_c0269785_20260723
```

The batch is now `cancelled`, `committed_at` remains null, both V2 commit and
Resume paths reject it, and S26 remained at version 16,573.

### Live Book3 shadows

The supplied workbook remains uncorrected. Its live preview returned four
grouped duplicate diagnostics for rows 1-2 and 1-3, then cancelled without a
commit.

A temporary copy changed only row 1 Thursday/Friday to zero and retained the
original workbook cell types. It generated 98 occurrences with zero removals
or overlay clears, but correctly returned six grouped manual-collision
diagnostics covering 16 `KE2094` departures. These are not anonymous staging
garbage:

- five were created on 2026-06-23 with history `Added 5 flight(s)`; one later
  received check-in allocation/time edits;
- the remaining records have authenticated server mutation events from
  2026-07-15 and 2026-07-20;
- all are active `F_NEW_*` manual records with their own schedules and routes.

The server therefore refused to overwrite them. Both live shadows called no
commit, ended `cancelled`, and left S26 version, record count, event count, and
high-water unchanged. The temporary corrected workbook was deleted.

## Remaining Release Gates

- Version `0.1.15` is synchronized across npm, Cargo, Tauri, and lockfiles.
- Exact-release updater tests, rules, Python tests, PGlite/schema reruns,
  412/412 TypeScript tests, typecheck, ESLint, and web production build passed.
- Local Tauri release compilation and NSIS packaging completed and produced
  `SeasonalManagement_0.1.15_x64-setup.exe`. Local updater signing stopped at
  the expected missing-private-key boundary; the private key is available only
  to the GitHub release workflow.
- Signed GitHub updater publication and public metadata verification remain.
- A clean-machine installation cannot be performed from this development
  machine and remains a manual operational check after publication.
