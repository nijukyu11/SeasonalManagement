# Server-first route reload verification

Updated: 2026-07-20

## Implemented locally

- Operator-scoped cache epoch and same-user auth refresh policy prevent token refresh from unmounting the application shell.
- `SeasonAutoSyncScheduler` and Realtime setup have explicit disposal boundaries.
- The shared workspace coordinator owns one promise per canonical window and invalidation generation. Seven same-process callers join the same strict promise.
- Mutation/realtime invalidation advances generation. An older response cannot overwrite a newer snapshot and does not start a redundant third load after the new generation has completed.
- Existing fresh or stale server snapshots render immediately on Seasonal, Detailed, Daily, Check-in, Gate, and Dashboard. Settings and Audit use the same snapshot-first pattern.
- Workspace V2 loads bounded keyset pages sequentially under one `dataVersion`/`serverHighWater` token and commits only a complete assembly.
- Timeout/network errors do not select workspace V1 or direct-table fan-out. V1 is limited to a confirmed missing V2 signature during additive rollout.
- SQLite/native tables are not a route read, retry, import, export, or failure fallback.

## Local verification completed

| Gate | Result |
| --- | --- |
| Focused route/auth/coordinator/import/export tests | PASS, 58/58 |
| Coordinator/store/read-model focused tests | PASS, 16/16 |
| Snapshot-first source-boundary tests | PASS, 7/7 |
| `npm run test:rules` | PASS |
| `npx tsc --noEmit --pretty false` | PASS |
| Targeted ESLint | PASS with one non-blocking existing exhaustive-deps warning in `SeasonalSchedulePage.tsx` |
| `npm run build` | PASS; all 10 application routes statically generated |
| Script syntax checks | PASS |
| Workspace V2/RLS source contracts after production profiling fixes | PASS, 4/4 |
| Full TypeScript/Node regression suite | PASS, 371/371 |
| Seasonal Import V2 PGlite SQL suite | PASS; migration/schema exercised twice |
| Canonical schema rerun | PASS, 2/2 clean-schema runs |
| Native production-like build | PASS; all 10 application routes generated and NSIS bundled |

## Production database and native canary

- PostgreSQL 17.6 retained the authenticated role's existing `statement_timeout=8s`.
- Workspace V2 and Import V2 were deployed additively. Follow-up migrations removed the authenticated locking incompatibility, bounded both root branches before merge, retained cursor keyset ordering, and changed stable RLS permission checks into statement-level InitPlans.
- The RLS profile diagnosed 1,289 repeated `seasonal.read` checks before an 8-second timeout. After the InitPlan migration, the profiled late page completed in 43.153 ms with the workspace keyset index, no temp-file spill, and no `57014`.
- The production-like native canary built with the same Supabase variables as the release workflow and installed successfully at version `0.1.12`. Installer size: `25,285,344` bytes. SHA-256: `B1A2A1159F1562B90349FF1C029BD31CC5E575441469B3745FA3EA3C32C28971`.
- The clean-schema mirror applies the RLS InitPlan optimization after every policy-creation block. The twice-applied canonical schema regression passed after this ordering was fixed.

## Production Gate 7 capacity result

Season: `season-19cbca13-e11d-4b75-bcaa-00a6c5ca68c6`; snapshot: `dataVersion=16573`, `serverHighWater=25106`.

| Gate | One client | Seven independent clients |
| --- | ---: | ---: |
| Complete pages | 53 | 53 per client / 371 total |
| Assembled roots | 27,862 | 27,862 per client |
| Result fingerprint | `c8800c095ade11737f81ea8d025571c36884ead3cd2f779cafa92481882aaa13` | identical for all seven clients |
| Maximum concurrent page statements | 1 | 7 |
| Page p95 | 143.5 ms | 189.0 ms |
| Slowest page | 160.2 ms | 218.0 ms |
| `57014` / timeout log count | 0 | 0 |
| Longest DB CPU interval above 80% | 0.0 s | 8.0 s |
| Result | PASS | PASS |

The seven-client container CPU peaked at 463.1% across multiple cores, but the interval above the plan threshold lasted 8 seconds, below the 10-second rejection limit. Because every capacity/completeness criterion passed, the optional immutable server page cache was not added.

## Remaining release operations

- `npm run test:workspace-window-v2-db` still requires `psql` and `SEASONAL_TEST_DATABASE_URL` for an isolated database.
- The non-destructive installer rollback drill passed: the published signed `0.1.11` installer (SHA-256 `B1E31F5B7A302A88F5650EF613F453888D14E96A75C006056A84DC88663278F1`) installed successfully, opened the operator login shell, and the production-like `0.1.12` installer then restored the installed version to `0.1.12`.
- The installed `0.1.12` canary reaches the production operator login through the configured self-hosted Supabase endpoint. Authenticated route navigation is still pending because the SSH/database password is not the Supabase Auth password for the `admin` operator. Do not reset that operator or synthesize an impersonated session solely for this smoke test.
- Complete the authenticated installed-canary navigation smoke before updater publication. No production import mutation will be used without a designated disposable canary season.
- Keep workspace-read V1 available through the compatibility window.

## Release gate

The production capacity and rollback portions of the release gate passed. Do not publish the updater until the remaining authenticated installed-canary navigation check is recorded. Preserve these accepted limits:

- zero `57014`;
- page p95 below 2 seconds and maximum below 4 seconds;
- at most one concurrent page statement per independent client;
- sequential pages within each chain;
- identical complete token/ID/count sets for all clients;
- no workspace V1/direct-table request after V2 timeout or network failure.
