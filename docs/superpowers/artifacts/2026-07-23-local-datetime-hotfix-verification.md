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
- Node/TypeScript tests: 377 passed.
- Rule regression tests passed.
- Canonical schema twice test: 2 runs passed.
