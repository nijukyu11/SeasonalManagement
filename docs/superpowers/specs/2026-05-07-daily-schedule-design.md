# Daily Schedule Design

## Goal

Create a Daily Schedule tab that lets users view and manage all arrival and departure flight records inside a user-selected datetime range from one dense, editable grid.

## Approved UI Direction

The Daily Schedule screen is a new operational tab alongside Seasonal Schedule and Detailed Schedule. The Stitch design is in project `projects/7514393519742172456`, revised screen `projects/7514393519742172456/screens/cf1ce896f22046a3b7cd18a49d06219a`.

The screen uses the existing dense aviation operations style: compact neutral layout, active Daily Schedule tab, season selector, unsynced status, manual Sync button, teal/blue primary accents, amber warnings, red destructive states, sticky table headers, tabular numeric text, and 8px or smaller radii.

There is no turnaround details side panel. Editing happens directly in the table cells.

## Date Range Behavior

The toolbar has `From` and `To` date+time controls. The time portion defaults to `05:00` only as a convenience so the user does not need to reselect the hour after loading the screen.

The default time does not create a separate operational-day ownership rule. Flights are included strictly by their real record datetime:

- Arrival records use `FlightRecord.date + STA`.
- Departure records use `FlightRecord.date + STD`.
- A record is included when its real datetime is inside the selected range.
- A flight from `00:00` to `04:59` is not reassigned to the previous day unless the selected datetime range explicitly includes it.

The implementation should use a half-open range, `from <= flightDateTime < to`, to avoid double-counting records when adjacent ranges share a boundary.

## Toolbar Summary

The toolbar summary shows three compact metrics for the selected datetime range:

- `ARR <count>`: number of included arrival records.
- `DEP <count>`: number of included departure records.
- `TOTAL <count>`: `ARR + DEP`.

The summary must not show record count plus turnaround count.

## Grid Columns

The table renders these user-facing columns:

- A/C Type
- Arr Flight
- STA
- From
- ARR PAX
- Carousel
- Arr Stand
- Arr Code Share
- Dep Flight
- STD
- To
- DEP PAX
- Gate
- Counters

The grid also includes selection checkboxes and compact row action controls for operations. Every listed data column supports inline filtering and click-to-sort.

Flight display format is carrier code plus a 3-digit flight number, for example `TW018`.

## Row Consolidation

Rows are derived from canonical `FlightRecord` data plus local modification overlays.

Linked ARR and DEP records are consolidated into one visible grid row when they represent the same turnaround relationship. The row shows the arrival-side values in arrival columns and departure-side values in departure columns.

Unlinked or one-sided records remain visible as single-side rows with the opposite side cells empty. This lets the user link, unlink, edit, or delete them without moving to another screen.

Consolidation is a display projection only. `FlightRecord` remains the editable and exportable truth.

## Direct Inline Editing

All editable values are edited directly inside the grid. The first implementation should support inline editing for:

- A/C Type
- STA
- From
- ARR PAX
- Carousel
- Arr Stand
- Arr Code Share
- STD
- To
- DEP PAX
- Gate
- Counters

Edits are committed through the existing local-first model:

1. Update IndexedDB/local workspace first.
2. Update React/cache state without full page reload.
3. Show unsynced count from local pending operations.
4. Push to Firestore only when the user presses Sync.

The UI should provide clear cell focus, dirty, saving, and error states. Validation messages belong in the affected cell or row, not in a side panel.

## Validation

The grid must enforce the app's core validation rules before accepting a local edit that changes the effective schedule identity.

Required validation for this feature:

- Duplicate flight numbers are prohibited within the same calendar day.
- Edits must not create two active records with the same airline, flight number, and record date.
- Linked rows must maintain valid ARR to DEP relationships after link/unlink operations.
- Time fields must be valid `HH:MM`.
- Numeric fields such as PAX, gate, and stand must parse to the existing domain type without corrupting saved data.

When validation fails, the edit remains uncommitted or is reverted to the last valid local value, and the row shows an inline validation error.

## Operations

The Daily Schedule tab supports the full operation set directly in the tab:

- Add flight
- Edit fields inline
- Delete selected flight records
- Link selected ARR/DEP records
- Unlink selected linked records

Add can reuse the existing detailed-mode new flight flow if it can be invoked with the selected date range, but the resulting records must still be saved through the same local-first workspace path.

Delete should mark records as deleted through local modifications or record-level changes consistent with existing Detailed Schedule behavior. Link and unlink should use existing `FlightRecord` relationship mutation helpers and record-level undo history.

## Architecture

The preferred architecture is a new `/daily` route with a small set of focused helpers:

- A route/page component for loading season data, rendering the toolbar, grid, and action controls.
- A daily row builder that applies modifications, filters by selected datetime range, and consolidates linked records into row view models.
- Sort/filter helpers for native grid filtering and click-to-sort.
- Inline edit helpers that map a grid cell edit back to the correct `FlightModification` or `FlightRecord` mutation.
- Validation helpers that reuse existing duplicate-flight checks and add cell-specific validation for the new editable fields.

The implementation should reuse existing local-first APIs:

- `loadLocalSeasonWorkspace`
- `saveLocalSeasonWorkspace`
- `applyLocalModificationBatch`
- `applyLocalFlightRecordMutation`
- `rebuildPendingOpsFromBaseline`
- `markDerivedSeasonalDirty`
- `syncSeasonWorkspace`

It should not write Firestore during normal grid edits and should not call `window.location.reload()`.

## Testing Strategy

Regression coverage should focus on helper behavior before UI wiring:

- Date range filtering uses real STA/STD datetimes and does not reassign early-morning flights.
- The `05:00` default is applied only to empty date/time inputs.
- ARR/DEP/TOTAL summary counts match filtered records.
- Linked ARR/DEP records consolidate into one row.
- Unlinked single-side records remain visible.
- Duplicate flight-number validation blocks invalid inline edits.
- Inline edit mapping creates the correct local modification or record mutation payload.

Verification should include:

- `npm run test:rules`
- Targeted ESLint for touched files
- `npm run build`

If the implementation changes documented app behavior, update `context.md`.
