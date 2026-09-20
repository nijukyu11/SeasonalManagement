# AMS 2017-2024 Daily Schedule import rollout (2026-09-20)

Historical AMS workbooks `AMS_DATA_BACKUP/AMS_2017.xlsx … AMS_2024.xlsx` were imported into the
production canonical Daily Schedule store through the repo Daily Schedule import Contract v1. No
application code, migration or contract changed; the rollout is data plus untracked scratch tooling
under `tmp/ams-import/` (`create-seasons.py`, `prepare-payload.cjs`, `import-driver.py`,
`expected-final.py`, `verify-import.py`, `verify-detail.py`).

## Why it was needed

Seasons `S17..W24` did not exist in production, so the AMS workbooks had no season targets and the
report/schedule surfaces had no historical Ops Dates.

## What ran

Executed on the SeasonalManagement self-hosted Supabase host (`supabase.ahtops.xyz`); the operator
account was used only as the authenticated RPC principal (`request.jwt.claim.sub`).

1. `create-seasons.py` — 16 seasons created through `manage_season_metadata_v2('create', …)` in one
   transaction; ranges come from the app's IATA season rules:
   `S17 2017-03-26..2017-10-28`, `W17 2017-10-29..2018-03-24`, `S18 2018-03-25..2018-10-27`,
   `W18 2018-10-28..2019-03-30`, `S19 2019-03-31..2019-10-26`, `W19 2019-10-27..2020-03-28`,
   `S20 2020-03-29..2020-10-24`, `W20 2020-10-25..2021-03-27`, `S21 2021-03-28..2021-10-30`,
   `W21 2021-10-31..2022-03-26`, `S22 2022-03-27..2022-10-29`, `W22 2022-10-30..2023-03-25`,
   `S23 2023-03-26..2023-10-28`, `W23 2023-10-29..2024-03-30`, `S24 2024-03-31..2024-10-26`,
   `W24 2024-10-27..2025-03-29`. All created with `data_version = 0`.
2. `prepare-payload.cjs` per workbook — repo analyzer (`analyzeDailyScheduleWorkbook`, `compact-lb`
   profile, sheet `STA`/`STD`) plus `parseDailyImportRowsStrict`, `buildDailyImportStagePayloadV1`
   and `confirmDailyImportZeroFlightDatesV1`. Payload checksums are reproducible: a rebuild after the
   tooling was moved reproduced `rawChecksum`, `canonicalChecksum`, legs, season targets and
   `requestId` byte-for-byte for `AMS_2021.xlsx`.
3. `import-driver.py` — per workbook one transaction: `set local role authenticated`, admin
   `request.jwt.claim.sub`, `lock_timeout = 30s`, `statement_timeout = 0` (the Daily RPCs only carry
   a `search_path` proconfig, so the `authenticated` role's 8s cap would otherwise cancel the big
   batches), then `stage_daily_schedule_import_v1` and `commit_daily_schedule_import_v1(batchId,
   expected_versions, previewHash)`. `probe` mode ran the same path with `rollback` for all eight
   workbooks before the first commit.

Workbooks were imported in chronological order because a later workbook must stage against the
`data_version` the earlier commits produced (`W20 v1→v2`, `W21 v1→v2→v3`, `W17/W18/W19/W22/W23`
`v1→v2`).

## Payload content (parser reconciliation)

| workbook | source rows | staged legs | seasons | dropped | sanitized cells |
|---|---|---|---|---|---|
| AMS_2017.xlsx | 10,544 | 16,774 | S17 12,100 · W17 4,674 | 87 × `DAILY_DUPLICATE_FLIGHT_NUMBER` | 2 |
| AMS_2018.xlsx | 22,290 | 34,823 | S18 20,621 · W17 7,501 · W18 6,701 | 38 × `DAILY_DUPLICATE_FLIGHT_NUMBER` | 0 |
| AMS_2019.xlsx | 28,400 | 45,120 | S19 25,902 · W18 10,358 · W19 8,860 | 3 × `DAILY_DUPLICATE_FLIGHT_NUMBER` | 0 |
| AMS_2020.xlsx | 31,694 | 8,936 | S20 62 · S21 200 · W19 8,574 · W20 63 · W21 37 | 3 × duplicate flight number, 2 × `DAILY_PARTIAL_SIDE`, 2 × `DAILY_DUPLICATE_OCCURRENCE` | 4 |
| AMS_2021.xlsx | 416 | 302 | S21 200 · W20 32 · W21 70 | 1 × duplicate flight number, 2 × `DAILY_PARTIAL_SIDE` | 4 |
| AMS_2022.xlsx | 5,549 | 9,162 | S22 5,380 · W21 41 · W22 3,741 | 4 × duplicate flight number, 2 × `DAILY_PARTIAL_SIDE` | 0 |
| AMS_2023.xlsx | 19,276 | 32,735 | S23 19,890 · W22 6,692 · W23 6,153 | 2 × duplicate flight number | 6 |
| AMS_2024.xlsx | 22,406 | 37,438 | S24 21,328 · W23 9,168 · W24 6,942 | 4 × duplicate flight number | 0 |

185,290 staged legs across 25 season batches. 2020/2021 are the COVID workbooks: `S20` keeps 62 legs
over 210 Ops Dates (167 explicit zero-flight dates), `S21` 200 legs (115 zero-flight dates),
`W20` 63 legs (117 zero-flight dates).

## Committed batches

| workbook | batch result (inserted / deleted / active after · data_version) |
|---|---|
| AMS_2017.xlsx | S17 12,100/0/12,100 v1 · W17 4,674/0/4,674 v1 |
| AMS_2018.xlsx | S18 20,621/0/20,621 v1 · W18 6,701/0/6,701 v1 · W17 7,501/0/7,501 v2 |
| AMS_2019.xlsx | W19 8,860/0/8,860 v1 · W18 10,358/0/10,358 v2 · S19 25,902/0/25,902 v1 |
| AMS_2020.xlsx | W20 63/0/63 v1 · W19 8,574/0/8,574 v2 · S21 200/0/200 v1 · S20 62/0/62 v1 · W21 37/0/37 v1 |
| AMS_2021.xlsx | W20 32/32/32 v2 · S21 200/200/200 v2 · W21 70/37/70 v2 |
| AMS_2022.xlsx | W22 3,741/0/3,741 v1 · S22 5,380/0/5,380 v1 · W21 41/0/41 v3 |
| AMS_2023.xlsx | S23 19,890/0/19,890 v1 · W22 6,692/0/6,692 v2 · W23 6,153/0/6,153 v1 |
| AMS_2024.xlsx | S24 21,328/0/21,328 v1 · W23 9,168/0/9,168 v2 · W24 6,942/0/6,942 v1 |

Deletions appear only in `AMS_2021.xlsx`, where the replacement scope covers the 2021 Ops Dates that
`AMS_2020.xlsx` had imported one year earlier (Jan 1 - Mar 27 for `W20`, the whole `S21` window, and
`W21` Oct 31 - Nov 30). Every batch landed `status = committed`; the machine-readable receipts
(batch id, request id, preview hash, per-season counts, commit receipt, zero-flight dates) are in
`docs/superpowers/artifacts/2026-09-20-ams-2017-2024-daily-schedule-import.receipts.json`, raw psql
output in `tmp/ams-import/receipts/AMS_<year>.xlsx.import.txt`.

## Verification (production, after the last commit)

`tmp/ams-import/verify-detail.py` (scratch tooling, untracked):

- 2,769 `(season, ops_date)` leg counts compared against the payload-derived expectation — all match;
- per-season totals 185,021 legs; `S23 19,890` + `S24 21,328` + `W23 15,321` + `W24 6,942` carry Pax
  (2,159,751 / 3,488,609 / 2,591,465 / 1,120,555), `S19` carries the only other Pax sample (18,925);
- confirmed zero-flight scope dates match for all 16 seasons (`S20 167`, `S21 115`, `W20 117`,
  `W21 65`, `S22 8`, `W19 4`);
- active occurrence-key duplicates in `season_flight_records`: 0;
- duplicate staged keys inside the AMS batches: 0; staged rows retained for audit: 185,290.

`tmp/ams-import/verify-import.py` prints the per-season table (legs, Ops Dates, zero-flight dates,
replacement scopes, Pax sums, `data_version` vs the number of workbooks that targeted the season)
and ends with
`All season totals match the staged expectation.`

## Notes

- The public report API (`/api/report/v1/overview`) advertises a coverage window
  (`min_ops_date 2025-10-25`, `max_ops_date 2027-03-29`), so pre-2025 windows answer
  `INVALID_REPORT_FILTER`; the historical years are only reachable through the desktop/DB read paths.
  `annual-kpi` stays publication-driven and unchanged.
- `PAX` is read only from the AMS `ARR/DEP-PAX` columns; 2017-2022 workbooks mostly carry no Pax, so
  those seasons keep `pax = null` by design rather than fabricated zeros.
- Rollback, if ever needed: soft-delete the affected Ops Dates through the canonical store
  (`status/action`) or re-commit with the same scopes - the import is additive and reports every
  insertion through `daily_schedule_import_batches`, `daily_schedule_import_seasons` and
  `schedule_replacement_scopes` receipts.
