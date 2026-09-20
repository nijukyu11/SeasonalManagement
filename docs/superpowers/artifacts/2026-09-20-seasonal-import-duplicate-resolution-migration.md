# Seasonal import duplicate resolution — migration readiness (20260920)

Status: **applied to production 2026-09-20** (client half shipped in desktop
`0.1.33`). Rollout evidence and the ops-host receipt are recorded in
`2026-09-20-seasonal-import-duplicate-resolution-rollout.md`.

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
  nothing at all still blocks with production's own `zero-generated-records`
  code and message, carrying exactly the six fields the client parses.
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
  from `schema.sql` through the guard plus the new migration; the shapes cover
  equal coverage, wide-vs-narrow, zero-day rows, all-zero rows, structural
  blocking, a committable mixed file, a committed narrow-first winner case and
  an idempotent re-run. Rollback restores the exact pre-state.
- Byte-exact digests (PGlite rehearsal):

| function | pre | post |
| --- | --- | --- |
| `seasonal_import_atomic_preview_v2(uuid)` | `2893f79aec30cbec00c0ec44870c7ffa` (24.470 B) | `9987a9adc58d7663876185ae49bf1882` (26.563 B) |
| `stage_seasonal_import_v2(jsonb)` | `3cfd475c428823d6e8807ab607ab93b4` (47.310 B) | `ae0692092af24660dee5e1ff07d1a2eb` (46.120 B) |
| `stage_seasonal_import_v3(jsonb)` | `9923e168ddf705b1a0fa50f6d59e80c1` (30.249 B) | `31e99bb3fc2492b2493c0069eab7e0cd` (34.852 B) |
| `seasonal_import_v3_response(uuid)` | `f6c413ad989a5dcbf780a87405c8aadb` (1.271 B) | `bbe8f218cb074fe2ee5cd9789e585731` (1.545 B) |

  `stage-v3` pre equals the post-patch digest recorded in
  `2026-09-20-seasonal-import-daily-duplicate-guard.md`, i.e. the rehearsal chain
  still reproduces production byte-for-byte.
- `app/scripts/rule-regression-tests.cjs` fixture updated for the new severity
  split; the suite passes.
- Server/client contract cross-check (`tmp/audit/w26/rollout/probe-shape.mjs`):
  the patched stage, status and blocked payloads all parse through the shipped
  `parseSeasonalImportV3StageResult`; the warning objects and the file-level
  blocking diagnostic carry exactly the six `DIAGNOSTIC_FIELDS`.
- Production probes (`tmp/audit/w26/rollout/verify.sql`) rehearsed verbatim in
  PGlite: P1 equal coverage keeps row 1 (`insertCount=1`), P2 wide row wins
  (`insertCount=7`), P3 skipped row warns, P3b nothing-generated blocks, P4 the
  Daily collision guard still blocks, P5 the previously blocked file commits and
  bumps the season row count. Everything runs inside `begin`/`rollback`.

## Production rollout (applied 2026-09-20)

Applied to `opsdata-supabase-db` on `100.91.158.79` (user `ops`) via
`tmp/audit/ssh_sql.py`. All four post digests equal the PGlite rehearsal
byte-for-byte; a second apply returns early on the `duplicate-occurrence-resolved`
marker and leaves the digests unchanged.

`verify.sql` probes on production (inside `begin; … rollback;`): P1 resolved
duplicate kept row 1 (`insertCount=1`), P2 wide row wins (`insertCount=7`), P3
skipped row warns `zero-generated-records`, P3b a file that generates nothing
stays blocked, P4 the Daily collision guard still blocks, P5 the previously
blocked file commits and persists the wide row (`source_row_index=3`,
`schedule=09:15`) while the narrow row is listed first. Season S26 kept
`data_version=16596`, `record_rows=67138`, `active_rows=25231`.

`rollback_probe_verbatim.sql` is `rollback.sql` byte-for-byte with only its final
`commit;` replaced by the four digest assertions plus `rollback;`, so the shipped
file's own `begin;`/`set local` and CREATE statements reach the server through
psql's scanner unchanged. It restored all four **raw** pre-state digests
(`2893f79a…` 24.470 B / `3cfd475c…` 47.310 B, CRLF preserved) and rolled back;
`q_digests.sql` then confirmed the live digests stayed post and the season counts
unchanged. `rollback_probe.sql` is the earlier DO-wrapped variant with the same
assertion. Receipt bundle: `/home/ops/seasonal-import-duplicate-resolution-20260920/`
(`sha256sum -c SHA256SUMS` → OK for all 15 files).

`seasonal_import_v3_response` differs between the local chain and production only
in line endings: the local migration file stores CRLF (`b2852ef7…`, 1.304 B) while
production stores LF (`f6c413ad…`, 1.271 B). The bodies are byte-identical after
`chr(13)||chr(10)` → `chr(10)` normalization, which is what the migration matches
on, and every post-patch body is LF, so post digests compare directly. The other
three functions match production raw.

Bundle sources: `tmp/audit/w26/rollout/` — `README.md` (ordered commands),
`q_digests.sql` (pre/post digests), `q_dump.sql` + `build_rollback.py` (byte-exact
pre-image), `rollback.sql`, `rollback_probe.sql`, `verify.sql`,
`probe-transcript.txt`, `rehearse_verify.mjs`. Requires `SEASONAL_SSH_PASSWORD`
in the environment; `ssh_sql.py` transports stdin as bytes so stored CRLF bodies
survive the round trip.

## Compatibility

Clients `<= 0.1.32` reject the new response fields, so every desktop must be
restarted (the updater installs `0.1.33`) before the migration lands. The
migration is additive for the client: no RPC signature changed.

## Review notes (2026-09-20)

- The file-level blocking diagnostic originally carried `generatedSourceRowCount`
  and `sourceRowCount`. The client parses blocking diagnostics with an exact
  field list, so those two fields would have made the client reject the whole
  stage response. They were removed; `probe-shape.mjs` now parses both a warning
  response and a blocked response through `parseSeasonalImportV3StageResult`.
- Winner persistence was verified end to end: with the narrow row listed first
  and the wide row second, the committed canonical records carry
  `source_row_index` of the wide row and its times (P5 in `verify.sql`, plus a
  committed case in the PGlite suite), so `on conflict (occurrence_key) do
  nothing` never sees a losing row.
- A suggested "generated rows below half of the source rows" blocking floor was
  rejected: production has no such rule, so adding it would newly block files
  the current stage accepts. The migration header was corrected to describe the
  rule that is actually implemented.
- The migration is idempotent by sentinel: a second run leaves all four function
  digests unchanged (`digest-resolution.mjs` rerun column).
