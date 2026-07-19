# Seasonal Import V2 Fixtures

These fixtures contain canonical Seasonal source rows only. They do not contain
atomic `flightRecords`, production database rows, or user credentials.

## S26

`seasonal-s26-source.json` is a strict parse of the first `S26` worksheet in
`S26_Updated_1779803544123.xlsx`. The source workbook SHA-256, coverage, source
row count, generated occurrence count, and canonical source-row SHA-256 are in
the fixture manifest. No flight identity is synthesized.

`S26_Updated_1783694873754.xlsx` was requested for verification but was not
present in the searched Documents scope on 2026-07-19. The selected workbook
is the newest available full-coverage `S26_Updated` candidate that
strict-parses with zero duplicate occurrence keys.

`DAD_SeasonalS26.xlsx` remains recorded as a negative duplicate fixture in the
S26 manifest. It is not used as a successful round-trip input.

## W26

`seasonal-w26-source.json` is deterministically derived from
`W26_Alternative.xls`. That workbook is a detailed schedule, not a canonical
Seasonal source workbook, so the derivation uses these production modules:

1. `parseDailyImportWorksheet` and `partitionDailyImportRowsByIataSeason` read
   real ARR/DEP occurrences and retain only the W26 batch.
2. `parseDailyImportDateTime` and `cleanFlightNumber` normalize values already
   present in each detailed row. Missing flight sides are skipped; no unknown
   flights are generated.
3. Same-row ARR/DEP records retain reciprocal pairing and their actual dates.
4. `buildCanonicalSeasonalRows` groups those occurrences into source rows.
5. The result is exported to an in-memory workbook and strict-parsed again.

Set `SEASONAL_W26_FIXTURE` or `SEASONAL_S26_FIXTURE` to the corresponding real
workbook path to make the harness rederive/reparse it and compare the result to
the committed fixture. An override must match the manifest source SHA-256; an
explicit expected hash can be supplied as `SEASONAL_W26_EXPECTED_SHA256` or
`SEASONAL_S26_EXPECTED_SHA256`.

The W26 fixture-specific generated count is 26,370. It is not asserted to equal
the current production imported count. Production shadow parity is a separate
Task 12 gate until the 228-record difference from the observed 26,598 count is
explained and approved.
