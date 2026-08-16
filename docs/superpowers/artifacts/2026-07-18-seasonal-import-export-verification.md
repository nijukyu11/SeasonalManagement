# Seasonal source-row Import/Export V2 verification

Updated: 2026-07-20

## Implemented locally

- Strict parser validation rejects missing headers, invalid dates/times/day flags, and incomplete ARR/DEP sides before network I/O.
- Seasonal and Settings repair import normalized source rows through staged/committed Import V2 only.
- The request contract is checksum/idempotency keyed and contains no client-expanded `flightRecords` payload.
- Server-generated record, link, and turnaround identities are stable for a season rather than tied to a transient import batch.
- Successful import initiates one generation-advanced coordinated workspace revalidation. The client does not also start a direct full-window load.
- Effective-leg materialization and pair resolution are shared across Detailed save, canonical export, and XLSX export.
- Export fetches a dedicated version-fenced snapshot, validates selection and pair closure, rejects empty/stale/incomplete data, then writes the workbook.
- Settings retains the visible `Seasonal Full Replace` workflow but no longer performs destructive clear-then-batch client writes.

## Local verification completed

| Gate | Result |
| --- | --- |
| Parser/validation/guard/import/effective/pair/export focused matrix | PASS within 58/58 focused tests |
| Source boundary for both Import V2 entry points | PASS |
| `npm run test:rules` | PASS |
| TypeScript | PASS |
| Production web build | PASS |
| Load/DB/round-trip harness syntax | PASS |

## Data audit and repair artifacts

- Read-only audit: `2026-07-18-seasonal-import-export-audit.sql`.
- Transactional, parameter-gated repair: `2026-07-18-seasonal-import-export-repair.sql`.
- The repair defaults to `dry_run=1`, requires reviewed S26/W25 IDs and counts, writes timestamp-labelled maintenance backups, and rolls back unless explicitly run with `-v dry_run=0`.

The read-only production audit was executed for S26/W25/W26. It found zero active duplicate groups, orphans, non-reciprocal links, invalid cardinality, and identifier collisions. No data repair was required or executed. The initial normalization audit exposed 10,887 false mismatches caused by truncating four-digit flight numbers; the normalization migration was corrected and the production mismatch count became zero.

## Production execution

- Import V2's three staging tables and five RPCs were deployed and their grants/signatures verified.
- The flight-number hotfix preserves four-digit values such as `5J5756` and still normalizes short values such as `LJ81` to `LJ081`.
- Stable RLS write-policy checks now use statement-level InitPlans, removing the same per-row permission-evaluation pattern found by the workspace read profile without changing RBAC results or the 8-second timeout.
- The combined workspace contention gate passed for one and seven independent clients with zero `57014`; all clients returned the same complete snapshot/fingerprint.
- Native canary build and installation completed. No updater release or V1 retirement was performed.

## Still pending

- `npm run test:seasonal-import-v2-db`: requires `psql` and `SEASONAL_TEST_DATABASE_URL` for an isolated disposable database.
- `npm run test:seasonal-import-v2-load`: requires an isolated deployed backend, authenticated token, W26 normalized fixture, and `SEASONAL_TEST_ALLOW_COMMIT=1`.
- `npm run test:seasonal-roundtrip`: requires semicolon-separated S26/W26 workbook paths in `SEASONAL_ROUNDTRIP_FIXTURES`.
- Production preview-only shadow import, real installed-canary import/navigation smoke, updater publication, and V1 retirement remain release operations. No statement-timeout increase, destructive production repair, version bump, updater publication, or V1 revoke/drop was performed.
