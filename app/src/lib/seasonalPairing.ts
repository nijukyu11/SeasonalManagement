import type { FlightLeg } from './types';
import { isValidLinkedFlightPair } from './flightPairIntegrity.ts';

export interface SeasonalPairIssue {
  code: 'missing-counterpart' | 'non-reciprocal-link' | 'ambiguous-pair';
  legId: string;
  message: string;
}

export interface SeasonalPairResolution {
  pairs: Array<{ arrival: FlightLeg; departure: FlightLeg }>;
  unpaired: FlightLeg[];
  issues: SeasonalPairIssue[];
  byLegId: Map<string, string>;
}

function pairOf(left: FlightLeg, right: FlightLeg) {
  if (left.type === right.type) return null;
  return left.type === 'A' ? { arrival: left, departure: right } : { arrival: right, departure: left };
}

export function resolveSeasonalPairs(legs: FlightLeg[]): SeasonalPairResolution {
  const active = legs.filter((leg) => leg.action !== 'deleted');
  const byId = new Map(active.map((leg) => [leg.id, leg]));
  const paired = new Set<string>();
  const pairs: SeasonalPairResolution['pairs'] = [];
  const issues: SeasonalPairIssue[] = [];
  const counterpartByLegId = new Map<string, string>();

  const accept = (left: FlightLeg, right: FlightLeg, validateDirectMetadata = false) => {
    if (paired.has(left.id) || paired.has(right.id)) return false;
    const pair = pairOf(left, right);
    if (!pair) return false;
    if (validateDirectMetadata && (left.linkId || right.linkId) && !isValidLinkedFlightPair(left, right)) return false;
    paired.add(left.id);
    paired.add(right.id);
    counterpartByLegId.set(left.id, right.id);
    counterpartByLegId.set(right.id, left.id);
    pairs.push(pair);
    return true;
  };

  for (const leg of active) {
    if (paired.has(leg.id) || !leg.linkedRecordId) continue;
    const counterpart = byId.get(leg.linkedRecordId);
    if (!counterpart) {
      issues.push({ code: 'missing-counterpart', legId: leg.id, message: `${leg.flightNumber} is missing linked record ${leg.linkedRecordId}.` });
      continue;
    }
    if (counterpart.linkedRecordId !== leg.id) {
      issues.push({ code: 'non-reciprocal-link', legId: leg.id, message: `${leg.flightNumber} has a non-reciprocal linked record.` });
      continue;
    }
    if (!accept(leg, counterpart, true)) {
      issues.push({ code: 'ambiguous-pair', legId: leg.id, message: `${leg.flightNumber} cannot form a unique arrival/departure pair.` });
    }
  }

  const resolveGroups = (groups: Map<string, FlightLeg[]>) => {
    for (const group of groups.values()) {
      const candidates = group.filter((leg) => !paired.has(leg.id));
      if (candidates.length === 0) continue;
      if (candidates.length === 2 && accept(candidates[0], candidates[1])) continue;
      if (candidates.length > 1) {
        for (const leg of candidates) {
          issues.push({ code: 'ambiguous-pair', legId: leg.id, message: `${leg.flightNumber} belongs to an ambiguous ${candidates.length}-leg pair group.` });
        }
      }
    }
  };

  const turnaroundGroups = new Map<string, FlightLeg[]>();
  for (const leg of active) {
    if (!leg.turnaroundId || paired.has(leg.id)) continue;
    const group = turnaroundGroups.get(leg.turnaroundId) ?? [];
    group.push(leg);
    turnaroundGroups.set(leg.turnaroundId, group);
  }
  resolveGroups(turnaroundGroups);

  const anchorGroups = new Map<string, FlightLeg[]>();
  for (const leg of active) {
    if (!leg.linkId || !leg.pairAnchorDate || !leg.linkType || paired.has(leg.id)) continue;
    const key = `${leg.linkId}|${leg.pairAnchorDate}|${leg.linkType}`;
    const group = anchorGroups.get(key) ?? [];
    group.push(leg);
    anchorGroups.set(key, group);
  }
  resolveGroups(anchorGroups);

  for (const leg of active) {
    if (paired.has(leg.id)) continue;
    if ((leg.linkedRecordId || leg.turnaroundId || (leg.linkId && leg.pairAnchorDate && leg.linkType)) &&
        !issues.some((issue) => issue.legId === leg.id)) {
      issues.push({ code: 'missing-counterpart', legId: leg.id, message: `${leg.flightNumber} has no unique active counterpart.` });
    }
  }

  return {
    pairs,
    unpaired: active.filter((leg) => !paired.has(leg.id)),
    issues,
    byLegId: counterpartByLegId,
  };
}

export function closeSeasonalSelectionOverPairs(
  selectedIds: string[],
  resolution: SeasonalPairResolution,
): string[] {
  const selected = new Set(selectedIds);
  for (const id of selectedIds) {
    const counterpart = resolution.byLegId.get(id);
    if (counterpart) selected.add(counterpart);
  }
  return [...selected];
}
