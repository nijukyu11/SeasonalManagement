# Deleted flight Save hotfix verification

Date: 2026-07-23

## Incident

Deleted flights could reappear after Save. The reported W26 flights were
`Z2827`, `Z26827`, and `LJ084`.

The investigation found two different production states:

- `LJ084` and its linked arrival `LJ083` already had complete deletion
  overlays.
- `Z2827` and `Z26827`, plus their linked arrivals `Z2826` and `Z26826`, had
  no delete mutation or deletion overlay. Their most recent mutations were
  Check-in modifications.

The client also had a stale callback window in the sync guard, draft
modifications were not compacted with deletion as a terminal operation, and
allocation routes could overwrite an existing deleted overlay with a stale
modified operation.

## Production data repair

- Backed up the four Z2 linked-flight record sets before mutation:
  `/home/ops/seasonal-backups/20260723-w26-z2-linked-pairs-before-delete.json`.
- Backup size: 961,947 bytes.
- Backup SHA-256:
  `a287c791c0b72d146f13b4ee0ab8b44e7f36b6566bc047da110adcefac1fbae4`.
- Applied mutation `repair-20260723-w26-z2-linked-pairs-v1` through
  `public.apply_season_server_mutation_v1(jsonb)`.
- The repair produced 613 mutation operations/events: 612 deletion overlays
  plus one history operation.
- The resulting W26 server sequence was 28,526.

Post-repair overlay counts:

| Flight | Direction | Total occurrences | Deleted overlays |
| --- | --- | ---: | ---: |
| `LJ083` | Arrival | 154 | 154 |
| `LJ084` | Departure | 154 | 154 |
| `Z26826` | Arrival | 153 | 153 |
| `Z26827` | Departure | 153 | 153 |
| `Z2826` | Arrival | 153 | 153 |
| `Z2827` | Departure | 153 | 153 |

The production workspace-window RPC returned `action=deleted` for all six
linked flights in the 2027-01-04 probe.

## Recurrence guard

- `SeasonSyncProvider` now invokes the latest registered pre-sync callback,
  closing the passive-effect re-registration window.
- Seasonal and Detailed Save compact draft operations before mutation; a
  deletion remains terminal over a later stale modification for the same leg.
- Save commits the compacted draft directly instead of resolving operations
  through a potentially stale current-record map.
- Seasonal Save no longer drops a draft commit solely because the component's
  `syncInProgress` render is stale; the sync scheduler remains responsible for
  serialization.
- Migration `20260723143000_guard_deleted_schedule_overlays.sql` prevents
  `allocation`, `checkin`, `daily`, and `gate` mutations from changing an
  existing deleted overlay back to modified.
- `seasonal` and `detailed` sources retain their explicit Undo path.

## Production database verification

- Migration rollback canary passed before deployment.
- Production migration applied successfully and contains marker
  `terminal_deleted_overlay_guard_v1`.
- A stale Check-in modification against deleted `Z2827` was rejected.
- The rejected mutation created no mutation receipt and left the overlay
  deleted.
- A Seasonal-source modification was accepted inside a transaction, proving
  the Undo path remains available; the transaction was rolled back and the
  production overlay remained deleted.

## Application verification

| Gate | Result |
| --- | --- |
| Focused delete/save tests | PASS, 36/36 |
| Full TypeScript/Node regression suite | PASS, 384/384 |
| TypeScript | PASS |
| Rule regression suite | PASS |
| ESLint | PASS with four pre-existing warnings |
| Updater tests | PASS, 8/8 |
| Next.js production build | PASS |
| Cargo check | PASS for `seasonal-management v0.1.14` |

Verification covered the mutation and RPC boundaries. No manual desktop UI
smoke was performed for this hotfix.

## Updater release

- Fix commit: `8fefd99`.
- Release commit: `4cc14be`.
- GitHub Actions run
  [29984927760](https://github.com/nijukyu11/SeasonalManagement/actions/runs/29984927760)
  completed successfully.
- Public release
  [app-v0.1.14](https://github.com/nijukyu11/SeasonalManagement/releases/tag/app-v0.1.14)
  is neither draft nor prerelease.
- Published assets:
  - `latest.json`: 756 bytes,
    SHA-256 `947c49f7dbecc496ecf38290295accd7d340823e29ce6bf3d2b0e9bdbf1ffcab`
  - `SeasonalManagement_0.1.14_x64-setup.exe`: 22,646,703 bytes,
    SHA-256 `c0d3208f42b240888932db0e4eb5491c8f3a780009f5ee79b0fd7ddfcfc56b99`
  - `SeasonalManagement_0.1.14_x64-setup.exe.sig`: 432 bytes,
    SHA-256 `6adfc3273e89abcf81a3e758627556aede08bf3271f2b7bb47bf74bc12e65d04`
- The public latest-updater endpoint returned version `0.1.14`, the
  `windows-x86_64` installer URL under tag `app-v0.1.14`, and a non-empty
  432-character signature.
