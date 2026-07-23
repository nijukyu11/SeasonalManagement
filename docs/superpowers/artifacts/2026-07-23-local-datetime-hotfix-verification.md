# Local datetime schedule hotfix verification

Date: 2026-07-23

## Incident

Check-in/Gate schedule projection failed with:

```text
Invalid local datetime 2027-01-07T1025
```

The application expects schedule timestamps in `yyyy-mm-ddTHH:mm` form. The
production W26 baseline records were canonical, but 154 modification rows for
K6 841 stored the edited schedule as compact `1025`.

## Production repair

- Backed up all 154 original rows to
  `ops_hotfix.season_modification_schedule_20260723`.
- Updated all 154 compact values from `1025` to `10:25` in one transaction.
- Advanced W26 `data_version` to `397` so active clients revalidate stale
  snapshots.
- Verified `LEG_D_2027-01-07_56_K6_K6841_SAI_15_35_320` now stores `10:25`.
- Verified the remaining compact modification count is zero.

## Recurrence guard

Migration
`20260723090000_normalize_season_modification_schedule.sql` is deployed.

- A database trigger canonicalizes `HHmm` and `Hmm` inputs before persistence.
- A validated constraint permits only null or canonical `HH:mm` schedules.
- Invalid values such as `2500` fail with SQLSTATE `22007`.
- The client persistence boundary now canonicalizes schedule-bearing records,
  source rows, and modifications before the server mutation RPC.
- Detailed Schedule accepts `HH:mm` or compact `HHmm`, normalizes on blur, and
  displays an inline error for invalid time input.

## Verification

- Production repair transaction: 154 backed up, 154 updated, zero compact rows.
- Production trigger smoke: `1025` normalized to `10:25` inside a rolled-back
  transaction.
- Production rejection smoke: `2500` rejected inside the same rolled-back
  transaction.
- Production trigger enabled and format constraint validated.
- TypeScript typecheck passed.
- Node/TypeScript tests: 379 passed.
- Rule regression tests passed.
- Canonical schema twice test: 2 runs passed.

## Updater release

- Version alignment passed for `package.json`, `package-lock.json`,
  `tauri.conf.json`, `Cargo.toml`, and `Cargo.lock`: `0.1.13`.
- Cargo verification passed for `seasonal-management v0.1.13`.
- Updater unit tests: 8 passed.
- GitHub Actions release run `29976934381` completed successfully.
- Public release `app-v0.1.13` is neither draft nor prerelease.
- Published assets:
  - `latest.json`: 756 bytes,
    SHA-256 `ed6b762003c685d512a53cc8b7adeb01d0953edee66a97b14a23a643566c6bf5`
  - `SeasonalManagement_0.1.13_x64-setup.exe`: 22,646,303 bytes,
    SHA-256 `c7743ff4e37042cc2f7c85e9d39e0c1319aed66f3652eeb311367f963acd6c6e`
  - `SeasonalManagement_0.1.13_x64-setup.exe.sig`: 432 bytes,
    SHA-256 `985b6c944bacbe5ed2b51b67f364d53a8373793b89311620aab9a363e52666be`
- The public latest-updater endpoint returned version `0.1.13`, the
  `windows-x86_64` installer URL under tag `app-v0.1.13`, and a non-empty
  432-character signature.
