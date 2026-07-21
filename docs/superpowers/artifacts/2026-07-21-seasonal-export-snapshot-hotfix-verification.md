# Seasonal Export Snapshot Hotfix Verification

Updated: 2026-07-21

## Symptom

The released `0.1.12` client rejected Seasonal Export V2 with:

```text
Cannot Export
Snapshot: seasonal export snapshot.seasonCode is missing.
```

## Root cause

Production `public.get_seasonal_export_snapshot_v2(text, integer)` returned a valid JSON object, but its deployed function body was older than the canonical repository contract. The live payload omitted both `seasonCode` and `sourceRowCount`. The client correctly failed closed on the first missing strict-snapshot field.

Before the hotfix, the authenticated read-only probe returned these keys:

```text
dataVersion,flightRecordCounters,flightRecords,flightRecordWindows,
modificationAddedLegs,modificationCounters,modifications,modificationWindows,
seasonId,serverHighWater,totalCount,truncated
```

## Fix

- Added `20260721090000_fix_seasonal_export_snapshot_identity_counts.sql`.
- Replaced only `public.get_seasonal_export_snapshot_v2(text, integer)` with the canonical strict Export V2 body.
- Restored `seasonCode` from `seasons.season_code` and `sourceRowCount` from `season_source_rows`.
- Preserved the existing permission check, version fence, complete relation arrays, `SECURITY DEFINER`, restricted grants, and additive V1 compatibility window.
- No client code or desktop version change was required.

## Verification

| Gate | Result |
| --- | --- |
| Focused export/import contract tests | PASS, 38/38 |
| Full TypeScript/Node regression suite | PASS, 372/372 |
| TypeScript | PASS |
| Rule regression suite | PASS |
| Canonical schema rerun | PASS, 2/2 |
| Production transaction dry run | PASS, then ROLLBACK |
| Production migration | PASS: `CREATE FUNCTION`, `REVOKE`, `GRANT` |
| PostgreSQL timeout logs during smoke | 0 |

The post-deployment authenticated probe returned all strict metadata and relation keys. S26 metadata was:

```text
seasonCode=S26
sourceRowCount=0
totalCount=26194
truncated=false
```

`sourceRowCount=0` is valid for this older season; the contract requires the non-negative field to be present, not greater than zero.

## Installed application smoke

The signed `0.1.12` application selected one Seasonal group (210 effective legs) and completed the strict export RPC in approximately 3.53 seconds. The UI displayed `Export completed` with no `seasonCode`, `sourceRowCount`, statement-timeout, or other export error.

The native smoke created `S26_Updated_1784621885801.xlsx` in Downloads (17,476 bytes). That exact test artifact was moved to the Windows Recycle Bin after verification and no longer exists at its original path.
