# Seasonal import duplicate resolution — migration readiness (20260920)

Status: **staged, not applied to production.** The client half shipped in
desktop `0.1.33`; the database half is ready to apply in one command once the
ops host credential is available in the session.

## Problem

An import file that repeats one occurrence across rows (a wide base row plus
narrow exception rows for the same flight number and date — the normal shape of
the W26 weekly pivot) was rejected: the stage dropped every colliding occurrence
and returned a blocking `duplicate-occurrence` diagnostic, so the operator could
never commit a schedule that is otherwise complete. The client-side guard added
in `0.1.31` (and the `20260920170000_seasonal_import_daily_duplicate_guard`
migration) removed the false "Add Flight Failed" error, but the server stage kept
blocking those files.

## Change

`app/supabase/migrations/20260920220000_seasonal_import_duplicate_resolution.sql`
(28.320 B, 762 lines, idempotent, `lock_timeout 15s` / `statement_timeout 300s`):

- `seasonal_import_atomic_preview_v2(uuid)`: duplicate occurrences resolve to
  the widest Effective→Discontinue coverage, then the most generated
  occurrences, then the lowest source row index. Losers are reported as
  `duplicate-occurrence-resolved` **warnings** (`sourceRowIndexes`,
  `keptSourceRowIndexes`, `occurrenceKey`, `sampleDates`, `affectedDateCount`).
- Rows whose selected operating days never fall inside their own window are
  skipped with `zero-generated-records` as a **warning**; a file that generates
  nothing at all still blocks through `no-generated-records`.
- `stage_seasonal_import_v2`/`v3` split diagnostics into blocking
  (`severity <> 'warning'`) and non-blocking channels; `stage_seasonal_import_v3`
  and `seasonal_import_v3_response` expose
  `warningCount` / `warningsTruncated` / `warnings`.
- Structural diagnostics keep blocking: relationship, pair date, manual
  collision and the daily collision guard (`seasonal_import_daily_duplicate_guard`).

Client: `0.1.33` tolerates missing warning fields (older servers), renders
"Resolved warnings" in the import preview dialog and labels the blocking section
"Blocking diagnostics".

## Evidence

- `app/supabase/tests/seasonal_import_duplicate_resolution_pglite.mjs` — chain
  from `schema.sql` through the guard plus the new migration; six shapes
  (equal coverage, wide-vs-narrow, all-zero rows, guard regression, commit,
  idempotent re-run) plus a rollback rehearsal. Rollback restores the exact
  pre-state.
- Byte-exact digests (PGlite rehearsal):

| function | pre | post |
| --- | --- | --- |
| `seasonal_import_atomic_preview_v2(uuid)` | `2893f79aec30cbec00c0ec44870c7ffa` (24.470 B) | `67203104c1bf80f7c3ac90cee2bdc2a6` (26.672 B) |
| `stage_seasonal_import_v2(jsonb)` | `3cfd475c428823d6e8807ab607ab93b4` (47.310 B) | `ae0692092af24660dee5e1ff07d1a2eb` (46.120 B) |
| `stage_seasonal_import_v3(jsonb)` | `9923e168ddf705b1a0fa50f6d59e80c1` (30.249 B) | `31e99bb3fc2492b2493c0069eab7e0cd` (34.852 B) |
| `seasonal_import_v3_response(uuid)` | `b2852ef7f2a99c1c01bfb479912db81d` (1.304 B) | `bbe8f218cb074fe2ee5cd9789e585731` (1.545 B) |

  `stage-v3` pre equals the post-patch digest recorded in
  `2026-09-20-seasonal-import-daily-duplicate-guard.md`, i.e. the rehearsal chain
  still reproduces production byte-for-byte.
- `scripts/rule-regression-tests.ts` fixture updated for the new severity split;
  the suite passes.
- Server/client contract cross-check: the patched stage and status payloads
  parse through the shipped `parseSeasonalImportV3StageResult` with the warnings
  channel intact (exactly the six `DIAGNOSTIC_FIELDS`).
- Production probes (`tmp/audit/w26/rollout/verify.sql`) rehearsed verbatim in
  PGlite: P1 equal coverage keeps row 1 (`insertCount=1`), P2 wide row wins
  (`insertCount=7`), P3 skipped row warns, P3b nothing-generated blocks, P4 the
  Daily collision guard still blocks, P5 the previously blocked file commits and
  bumps the season row count. Everything runs inside `begin`/`rollback`.

## Production rollout (pending)

Bundle: `tmp/audit/w26/rollout/` — `README.md` (ordered commands), `q_digests.sql`
(pre/post digests), `q_dump.sql` + `build_rollback.py` (byte-exact pre-image),
`rollback.sql`, `verify.sql`, `rehearse_verify.mjs`. Target host
`100.91.158.79`, database `opsdata-supabase-db`, user `ops`; requires
`SEASONAL_SSH_PASSWORD` in the environment.

Blocked on: the ops host credential is not present in this session, so the
read-only pre-state check, the apply, the probes and the rollback rehearsal have
not been executed against production. No production state was modified.

## Compatibility

Clients `<= 0.1.32` reject the new response fields, so every desktop must be
restarted (the updater installs `0.1.33`) before the migration lands. The
migration is additive for the client: no RPC signature changed.
