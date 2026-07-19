import {
  closeSeasonalSelectionOverPairs,
  resolveSeasonalPairs,
  type SeasonalPairIssue,
} from './seasonalPairing.ts';
import type { FlightLeg } from './types.ts';

export interface SeasonalExportSelection {
  seasonId: string;
  dataVersion: number;
  mode: 'ids' | 'all';
  recordIds: string[];
}

export type SeasonalExportSelectionIssueCode =
  | 'season-mismatch'
  | 'version-mismatch'
  | 'unknown-record-id'
  | 'zero-selection'
  | SeasonalPairIssue['code'];

export interface SeasonalExportSelectionIssue {
  code: SeasonalExportSelectionIssueCode;
  message: string;
  recordId?: string;
}

export interface SeasonalExportSelectionResult {
  valid: boolean;
  legs: FlightLeg[];
  recordIds: string[];
  issues: SeasonalExportSelectionIssue[];
}

function stableLegOrder(left: FlightLeg, right: FlightLeg): number {
  return left.date.localeCompare(right.date)
    || left.type.localeCompare(right.type)
    || left.schedule.localeCompare(right.schedule)
    || left.airline.localeCompare(right.airline)
    || left.flightNumber.localeCompare(right.flightNumber)
    || left.id.localeCompare(right.id);
}

function invalid(issue: SeasonalExportSelectionIssue): SeasonalExportSelectionResult {
  return { valid: false, legs: [], recordIds: [], issues: [issue] };
}

export function validateSeasonalExportSelection(input: {
  selection: SeasonalExportSelection;
  snapshotSeasonId: string;
  snapshotDataVersion: number;
  effectiveLegs: FlightLeg[];
}): SeasonalExportSelectionResult {
  if (input.selection.seasonId !== input.snapshotSeasonId) {
    return invalid({
      code: 'season-mismatch',
      message: `Selection season ${input.selection.seasonId} does not match snapshot season ${input.snapshotSeasonId}.`,
    });
  }
  if (input.selection.dataVersion !== input.snapshotDataVersion) {
    return invalid({
      code: 'version-mismatch',
      message: `Selection version ${input.selection.dataVersion} does not match snapshot version ${input.snapshotDataVersion}.`,
    });
  }

  const activeLegs = input.effectiveLegs.filter((leg) => leg.action !== 'deleted');
  const byId = new Map<string, FlightLeg>();
  for (const leg of activeLegs) {
    if (!byId.has(leg.id)) byId.set(leg.id, leg);
  }

  const requestedIds = input.selection.mode === 'all'
    ? activeLegs.map((leg) => leg.id)
    : [...new Set(input.selection.recordIds.map((id) => id.trim()).filter(Boolean))];
  if (requestedIds.length === 0) {
    return invalid({
      code: 'zero-selection',
      message: input.selection.mode === 'all'
        ? 'The complete server snapshot contains no effective flights to export.'
        : 'Select at least one flight before export.',
    });
  }

  if (input.selection.mode === 'ids') {
    const unknownIssues = requestedIds
      .filter((id) => !byId.has(id))
      .map((recordId): SeasonalExportSelectionIssue => ({
        code: 'unknown-record-id',
        recordId,
        message: `Selected flight ${recordId} is not present in the complete server snapshot.`,
      }));
    if (unknownIssues.length > 0) {
      return { valid: false, legs: [], recordIds: [], issues: unknownIssues };
    }
  }

  const resolution = resolveSeasonalPairs(activeLegs);
  const requested = new Set(requestedIds);
  const pairIssues = resolution.issues
    .filter((issue) => requested.has(issue.legId))
    .map((issue): SeasonalExportSelectionIssue => ({
      code: issue.code,
      recordId: issue.legId,
      message: issue.message,
    }));
  if (pairIssues.length > 0) {
    return { valid: false, legs: [], recordIds: [], issues: pairIssues };
  }

  const closedIds = closeSeasonalSelectionOverPairs(requestedIds, resolution);
  const closedSet = new Set(closedIds);
  const legs = activeLegs.filter((leg) => closedSet.has(leg.id)).sort(stableLegOrder);
  if (legs.length === 0) {
    return invalid({
      code: 'zero-selection',
      message: 'The selected server snapshot contains no effective flights to export.',
    });
  }

  return {
    valid: true,
    legs,
    recordIds: legs.map((leg) => leg.id),
    issues: [],
  };
}
