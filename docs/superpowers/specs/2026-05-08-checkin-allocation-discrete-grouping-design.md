# Check-in Allocation - Discrete Grouping Design

## Status

Approved design direction from Stitch:

- Project: `projects/7514393519742172456`
- Screen title: `Check-in Allocation - Discrete Grouping`
- Screen id: `projects/7514393519742172456/screens/b2e163977c214311badffd6b7aedbd02`

This spec defines the `/checkin` tab for interactive check-in counter allocation. It must follow the existing SeasonalManagement local-first architecture: IndexedDB first, manual Sync to Firestore, and no direct Firestore writes during normal allocation edits.

## Scope

Build a desktop operational Gantt view for departure check-in counter allocation.

The feature covers:

- Date/time controller for the Gantt x-axis.
- Split-pane view with an unallocated flight pool and a resource grid.
- Rule-based counter demand using the existing Counter Rule engine.
- Drag/drop allocation to physical counter rows.
- Grouped allocation behavior with discrete row-confined bar rendering.
- Break Shape, Add Counter, Remove Counter, Override Times, and Unallocate operations.
- Local-first persistence of counter assignments and check-in time overrides.

The feature does not cover:

- A separate terminal/counter settings module.
- Auto-optimization of counter assignments.
- Multi-user realtime collaboration beyond the existing manual Sync conflict model.
- Mobile layout.

## Route And Navigation

Add a new route at `/checkin`.

Navigation should include:

- Seasonal Schedule
- Daily Schedule
- Detailed Schedule
- Check-in Allocation
- Settings

The active tab is `Check-in Allocation`. The route should use the same season selector, unsynced status, and manual Sync pattern as `/daily`.

## Data Source

The tab works over canonical `FlightRecord` records plus local `FlightModification` overlays.

Only departure records are shown because check-in allocation binds to departures.

A departure is in scope when its effective check-in allocation window intersects the selected date/time range.

The base allocation window is:

- Start: `STD - 3 hours`
- End: `STD - 50 minutes`

If a user overrides times, the override window replaces the STD-derived window for display and persistence. The underlying `schedule` / STD is not changed by resizing or Override Times.

## Data Model

Use the existing `counter` field for the Y-axis allocation payload.

Examples:

- Grouped contiguous allocation: `counter: [1, 2, 3]`
- Broken non-contiguous allocation: `counter: [1, 2, 5]`
- Mixed counter names: `counter: ["M1", "M2"]`

Add check-in-specific fields to `FlightRecord` and `FlightModification`:

- `checkInStart?: string | null`
- `checkInEnd?: string | null`
- `checkInAllocationMode?: "grouped" | "broken" | null`

`checkInStart` and `checkInEnd` store exact local datetime values in `yyyy-mm-ddTHH:mm` format. Drag and resize operations snap to 15-minute ticks. Manual Override Times may enter exact minute values, which are preserved.

`checkInAllocationMode` controls interaction behavior:

- `grouped`: bars are logically bound and move together.
- `broken`: counter blocks can be moved independently to non-contiguous counter rows, while the time window remains shared by the flight.
- `null`: unallocated or not explicitly set; allocated records default to grouped behavior when the counter list is contiguous.

The persistence schema must accept these new optional fields for records, modifications, and history entries.

## Counter Rule Initialization

On load, each in-scope departure evaluates existing operational settings through `evaluateCounterRules(record, settings)`.

The required counter count is:

- The matched rule `counterValue` when a rule matches.
- `1` when no rule matches.

The unallocated pool label uses this count:

- `VJ827 (3)`
- `5J5757 (2)`
- `TW026 (4)`

The applied rule name appears as compact metadata in the unallocated pool and tooltip surfaces.

## Counter Roster

The initial counter roster is derived from:

- Existing assigned `counter` values in the local workspace.
- A fallback roster when no assigned counters exist: `1-20`, `M1-M5`.

The roster order is numeric counters first in ascending order, then alpha-prefixed counters sorted by prefix and numeric suffix.

## Layout

The route uses a full-height operational workspace:

- Top app navigation and season/sync controls.
- Toolbar with title, date/time range, quick range buttons, zoom/density controls, 15-minute snap indicator, and summary metrics.
- Split-pane Gantt:
  - Top pane: Unallocated Pool.
  - Bottom pane: Resource Grid.

The timeline is shared between panes so unallocated and allocated bars align to the same x-axis.

## Timeline

The x-axis uses a hierarchical header:

- Macro: date/day grouping.
- Major ticks: one-hour intervals.
- Minor ticks: 15-minute intervals.

Drag/drop and visual resize operations snap to 15-minute minor ticks.

The time controller changes the visible x-axis and reloads the in-scope projection from the current local workspace. It does not mutate records by itself.

## Unallocated Pool

Flights without a usable `counter` assignment render in the top pane.

Each unallocated flight renders as one consolidated bar spanning its effective allocation window. The label shows flight identifier and required counter count, for example `VJ827 (3)`.

Unallocated pool ordering is chronological by allocation start, then STD, then flight number.

Dragging an unallocated bar to a counter row allocates the required number of counters starting at the drop row. The system chooses contiguous rows downward from the drop row. If there is not enough contiguous capacity or the target window conflicts with existing allocations, the drop is rejected with the shared app dialog.

## Resource Grid

Each physical counter is one row. Bars must be strictly confined within their row.

Allocated shapes render as row-level blocks:

- One bar per assigned counter.
- A bar never spans multiple counter rows.
- Horizontal row grid lines stay visible and continuous.

## Discrete Group Rendering

Grouped allocations are logical groups, not merged rectangles.

For a grouped flight assigned to counters `C1`, `C2`, and `C3`, render three separate bars:

- One in `C1`
- One in `C2`
- One in `C3`

All bars in the group share:

- Fill color.
- Border color.
- Hover state.
- Selection state.
- Resize handle styling.
- Drag affordance styling.

A subtle group indicator appears in the row-label gutter, such as a left-side bracket or rail. It may connect the grouped rows visually, but it must not cover or erase row grid lines.

Hovering or selecting any bar in a grouped allocation highlights every bar in the same group simultaneously.

Dragging any bar in grouped mode moves the whole group:

- Horizontal drag shifts the shared start/end window.
- Vertical drag shifts the counter set together by row delta.

## Broken Shape Rendering

The Break Shape action changes `checkInAllocationMode` to `broken`.

Broken blocks remain associated with the same flight, but individual counter blocks can move to non-contiguous counter rows. Example payload:

```json
{ "counter": [1, 2, 5], "checkInAllocationMode": "broken" }
```

Broken blocks still share the same allocation time window. Resizing or Override Times on any block updates the shared flight window for every block.

Broken allocations render with:

- One row-confined bar per counter.
- Repeated label and edge times on each bar when width allows.
- A small split marker or dashed gutter indicator, not a merged background.

## Bar Labels And Time Markers

Normal-width allocated bars show:

- Left edge: start time, for example `04:45`.
- Center: flight identifier, for example `VJ827`.
- Right edge: end time, for example `07:15`.

Every discrete bar repeats the flight identifier and time markers. Labels are not limited to the first row of a group.

When bar width is constrained:

1. Keep the flight identifier visible.
2. Hide start/end time text.
3. Expose start/end time through the hover tooltip.

Text must never overlap neighboring bars, grid lines, or resize handles.

## Context Menu

Right-clicking an allocated bar opens a context menu with:

- Break Shape
- Add Counter
- Remove Counter
- Override Times
- Unallocate

Behavior:

- Break Shape changes mode to `broken`.
- Add Counter appends one counter block. In grouped mode it chooses the next available contiguous counter row. In broken mode it chooses the next available row after the clicked block and the user can move it afterward.
- Remove Counter removes one block. In grouped mode it removes the lowest row in the group. In broken mode it removes the clicked block.
- Override Times opens a compact popover with exact Start and End datetime inputs.
- Unallocate clears the `counter` value and check-in allocation mode but preserves time overrides only when the user confirms. The default action clears time overrides too, returning the flight to rule-derived default timing.

## Validation

Validation must run before local persistence.

Reject changes when:

- Start is not before End.
- A drag or resize creates an invalid datetime.
- A counter value is not in the roster.
- A grouped move would go outside the roster.
- An allocated block overlaps another flight on the same counter row for the same time interval.
- Add Counter cannot find an available row.
- Remove Counter would leave the allocation with zero counters; use Unallocate for that.

Validation failures use the shared app dialog UI, not native `alert()` or `confirm()`.

## Local-First Persistence

All changes are saved to the local IndexedDB workspace first through existing local mutation helpers.

Normal operations create `FlightModification` overlays:

- `counter`
- `checkInStart`
- `checkInEnd`
- `checkInAllocationMode`

Each operation records a `ModHistoryEntry` for undo compatibility.

The Sync button pushes pending local changes to Firestore through the existing manual Sync flow. The Check-in Allocation tab must not call Firestore writes directly during allocation edits.

## Rendering Architecture

Create `src/lib/checkinAllocation.ts` as a focused pure-logic helper module responsible for:

- Build timeline ticks.
- Compute default and effective allocation windows.
- Normalize counter payloads.
- Sort counter roster.
- Evaluate rule-derived required counter count.
- Build unallocated pool items.
- Build resource grid bar models.
- Apply allocation, move, resize, break, add, remove, override, and unallocate transformations.
- Detect same-counter time overlaps.
- Decide label visibility for a given bar width.

The React route should stay focused on:

- Loading local workspace and settings.
- Rendering controls and Gantt panes.
- Capturing pointer/context-menu interactions.
- Calling helper functions and local persistence helpers.

## Testing Strategy

Add rule regression coverage for:

- Default window calculation from STD.
- Date/time range intersection.
- Counter roster sorting and counter payload normalization.
- Counter rule count fallback and matched-rule count.
- Allocation from unallocated pool to contiguous counters.
- Grouped vertical/horizontal moves.
- Break Shape and non-contiguous counter payloads.
- Add Counter and Remove Counter.
- Override Times validation.
- Same-counter overlap rejection.
- Discrete bar model generation: one bar per assigned counter, never one merged multi-row bar.
- Label visibility fallback: full label at sufficient width, flight-only at narrow width.

Run:

```text
npm run test:rules
npx eslint src/app/checkin/page.tsx src/lib/checkinAllocation.ts src/lib/types.ts src/lib/persistenceSchema.ts
npm run build
```

## Implementation Notes

Use the existing Material Symbols icon pattern already present in the app. Keep the UI dense and operational: no feature explanation blocks, no landing-page composition, no native browser dialogs, and no full reload after local mutations.
