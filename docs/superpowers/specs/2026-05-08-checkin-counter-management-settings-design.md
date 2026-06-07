# Check-in Counter Management Settings Design

## Status

Approved design direction for adding a dedicated settings module to manage physical check-in counter inventory, counter groups, BHS mapping, and counter locks/outages.

This spec extends the existing `/settings` route and `/checkin` Gantt route. It must preserve the current SeasonalManagement architecture:

- Flight allocation edits are local-first through IndexedDB season workspaces.
- Firestore flight records and modifications are written only through manual Sync.
- Global operational settings remain Firestore-backed through `appSettings/operational`.

## Scope

Build operational settings for physical check-in counter resources and enforce those resources inside Check-in Allocation.

The feature covers:

- Dynamic counter inventory with custom alphanumeric counter labels.
- Counter group/island definitions.
- BHS mapping from counter group to allocated departure records.
- A Check-in Allocation toolbar toggle to cluster the resource grid by counter group.
- Counter locks and outage windows with start/end datetime values.
- Blocking new allocations, moves, add-counter actions, and reshapes into active locked counters.
- Keeping existing allocations on newly locked counters visible and marking them as lock conflicts.

The feature does not cover:

- Automatic optimization or rebalancing of existing allocations.
- Deleting or rewriting historical flight assignments when a lock is created.
- Per-season counter inventories. Counter inventory is global operational configuration.
- Firestore realtime collaboration for settings changes beyond the current global settings load/save pattern.

## Data Model

Extend `OperationalSettings` with:

```ts
export interface CheckInCounterResource {
  id: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterGroup {
  id: string;
  name: string;
  bhs: string;
  counterIds: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CheckInCounterLock {
  id: string;
  name: string;
  counterIds: string[];
  start: string;
  end: string;
  reason: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OperationalSettings {
  aircraftGroups: AircraftGroup[];
  counterAllocationRules: CounterAllocationRule[];
  checkInCounters: CheckInCounterResource[];
  checkInCounterGroups: CheckInCounterGroup[];
  checkInCounterLocks: CheckInCounterLock[];
  updatedAt: number | null;
}
```

`CheckInCounterResource.label` stores the visible resource label, such as `1`, `54`, `M1`, `M7`, or `Transit`. The label is also the value written to `FlightRecord.counter` and `FlightModification.counter`.

Datetime lock fields use the existing local datetime format: `yyyy-mm-ddTHH:mm`.

## Validation Rules

Operational settings validation must enforce:

- Counter IDs are unique.
- Counter labels are non-empty and unique case-insensitively.
- Enabled counters can be used by the Gantt.
- Counter groups have unique names case-insensitively.
- A counter can belong to at most one counter group.
- Group `counterIds` must reference existing counters.
- Lock `counterIds` must reference existing counters.
- Enabled lock windows must have valid datetimes and `start < end`.
- Disabled locks can remain saved but do not block allocation.

If settings are missing the new fields, hydration returns empty arrays and Check-in Allocation falls back to the current default roster behavior.

## Settings UI

Add a third tab to `/settings`: `Check-in Counters`.

The tab contains three work areas:

1. `Counter Inventory`
   - Add single counter by label.
   - Add numeric range, for example `1-54`.
   - Add prefixed range, for example `M1-M7`.
   - Add custom labels, for example `Transit`.
   - Rename labels inline.
   - Enable/disable counters.
   - Delete counters that are not referenced by groups or active locks.
   - Reorder counters with numeric `sortOrder` controls.

2. `Counter Groups / BHS`
   - Create and rename group/island.
   - Edit BHS value.
   - Assign counters using checkboxes or multi-select controls.
   - Show assigned counters as chips.
   - Prevent assigning one counter to multiple groups.

3. `Locks / Outages`
   - Create lock with name, counters, start datetime, end datetime, reason, and enabled toggle.
   - Edit/delete lock rows.
   - Disabled locks are visible but ignored by allocation validation.

The existing Save Settings button persists all three areas together through `saveOperationalSettings`.

## Gantt Resource Roster

Check-in Allocation builds its resource roster in this order:

1. Enabled counters from `settings.checkInCounters`, sorted by `sortOrder`, then natural counter label.
2. Any counters already assigned to visible records but missing from settings are appended so legacy data remains visible.
3. If no settings counters exist, use the existing fallback roster (`1-20`, `M1-M5`, plus assigned counters).

The Gantt must continue to display rows for disabled or missing legacy assigned counters when needed to avoid hiding existing flight assignments. New drops should target only enabled, configured counters unless the fallback roster is active.

## Grouped Resource View

Add a toolbar switch on `/checkin`: `Group by island`.

When off:

- Resource rows use the flat roster order.
- Group metadata is still available for BHS mapping and lock warnings.

When on:

- Rows are clustered by `CheckInCounterGroup.sortOrder`, then counter order inside the group.
- Group header bands label each group and BHS value.
- Ungrouped enabled counters appear in an `Ungrouped` cluster after named groups.
- Legacy assigned counters not in settings appear in a `Legacy / Unmapped` cluster.

The toggle only changes Y-axis ordering and grouping display. It must not mutate flight records or pending Sync state.

## BHS Mapping

When a flight is allocated to counters that belong to a group, the generated `FlightModification` must include:

```ts
{
  counter: ["1", "2", "3"],
  bhs: "BHS-A"
}
```

For grouped contiguous allocations, the BHS value comes from the group of the assigned counter set.

For broken allocations:

- If all assigned counters are in the same group, write that group's `bhs`.
- If assigned counters span multiple groups, write a comma-separated unique BHS list in group order, for example `BHS-A,BHS-C`.
- If no group has BHS, write `null`.

All BHS writes are local-first modifications, saved to IndexedDB and later pushed by manual Sync with other modification fields.

## Lock Enforcement

An active lock applies when:

- The lock is enabled.
- The counter is in `lock.counterIds`.
- The flight's check-in allocation window overlaps the lock window.

Allocation actions must reject active locks:

- Drag from Unallocated Pool to a locked counter window.
- Move grouped or broken bars into locked counter windows.
- Add Counter into a locked counter window.
- Reshape a broken allocation into locked counters.
- Manual time override or resize that would make the existing counters overlap a lock.

The rejection uses the shared app dialog. It must name the counter and lock where possible.

Creating a lock does not auto-unallocate flights. Existing allocations that overlap active locks remain visible and get warning styling:

- Counter row shows a lock indicator.
- Affected bars show a warning border or icon.
- Tooltip includes the lock name/reason and lock period.

## Interaction With Overlap Stacking

Counter overlaps between flights remain allowed. Lock validation is separate from flight overlap stacking.

When a locked counter row has multiple overlapping flights, the row still expands into lanes. Each violating bar gets the warning style independently.

## Error Handling

Settings validation errors appear through the existing `AppDialog` alert flow.

Check-in Allocation lock rejections use the same dialog pattern as existing allocation, move, resize, and override errors.

If a settings document contains invalid counter metadata, `/settings` should show the validation message. `/checkin` should continue to show an allocation error instead of silently using bad settings.

## Testing

Regression coverage must include:

- Settings hydration accepts missing counter fields.
- Settings validation rejects duplicate labels, duplicate group ownership, and invalid lock windows.
- Inventory range parsing creates `1-54`, `M1-M7`, and custom labels.
- Check-in roster uses configured counters before fallback defaults.
- Grouped resource ordering clusters by counter group without changing allocations.
- Allocating to a grouped counter writes mapped `bhs`.
- Broken allocations spanning groups write a unique comma-separated BHS list.
- Active locks block new allocations/moves/add-counter/reshape/resize/override when windows overlap.
- Existing locked allocations remain visible and are marked as violations.
- The `/settings` page exposes the `Check-in Counters` tab.
- The `/checkin` toolbar exposes the `Group by island` switch.

## Documentation Updates

Update `context.md` after implementation to record:

- `OperationalSettings` owns global check-in counter inventory, groups, and locks.
- Counter groups map allocated counters to departure `bhs`.
- `/checkin` can reorder the resource grid by group.
- Active locks block new allocation edits but do not auto-unallocate existing flights.
