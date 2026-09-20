# Desktop 0.1.33 — seasonal import duplicate-resolution client (20260920)

Tag `app-v0.1.33` (Latest, published 2026-09-20T09:44:23Z) at commit `1f485b3`
(`5d6a8c1` resolution + warnings, `634ea71` version bump, `1f485b3` tolerance
default), workflow run
[`35502563899`](https://github.com/nijukyu11/SeasonalManagement/actions/runs/35502563899)
completed success. All gates passed before publish: updater tests, rule
regression tests, Python agent tests, signed Tauri bundle.

| asset | size | sha256 |
| --- | --- | --- |
| `SeasonalManagement_0.1.33_x64-setup.exe` | 22.790.801 | `5250dcbb5d2f9649d2ce7807515c0efe711bfdf1bd0292b808ba8e7d6821632c` |
| `SeasonalManagement_0.1.33_x64-setup.exe.sig` | 432 | `ce3f79ccf5f9719fe226c1ffc9219a8e38130fe3531ff7226a7581c8be1f0e46` |
| `latest.json` | 756 | `00acdf8d6275b82414269e4470ee6d11de2cc2e475c83c15610f6e70e4c01ea6` |

`latest.json` advertises `0.1.33` for `windows-x86_64` with the signed installer
URL and `pub_date 2026-09-20T09:44:18Z`, so every running desktop picks the
build up on its next update check.

## What changed in the client

- `parseSeasonalImportV3StageResult` / the v3 status contract tolerate a server
  that does not send the warning channel (missing `warningCount`,
  `warningsTruncated`, `warnings` default to `0`/`false`/`[]`), so `0.1.33`
  works against the current production database **and** after the migration.
- `SeasonalImportPreviewDialog` renders "Resolved warnings" (grouped by code,
  with source rows, sample dates, `+N more` and the truncation note) next to the
  blocking section, which is now labelled "Blocking diagnostics".
- `SeasonalImportPreviewDialog.source.test.ts` covers the new surface;
  `seasonalImportV3Contract.test.ts` covers the tolerance path.

## Ordering

The migration (`20260920220000_seasonal_import_duplicate_resolution.sql`) adds
fields that clients `<= 0.1.32` reject, so desktops must be restarted to install
`0.1.33` before the migration is applied. The migration itself is staged and
rehearsed; see
`2026-09-20-seasonal-import-duplicate-resolution-migration.md` for the
production sequence.
