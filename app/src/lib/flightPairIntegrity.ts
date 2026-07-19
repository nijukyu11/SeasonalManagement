import { resolveSeasonalPairs } from './seasonalPairing.ts';
import type { FlightLeg } from './types.ts';

export {
  expectedDateForLinkedLeg,
  inferLinkedPairType,
  pairAnchorForLinkedLegs,
  shiftIsoDate,
} from './seasonalPairing.ts';
export type { FlightPairLinkType } from './seasonalPairing.ts';

/** @deprecated Use resolveSeasonalPairs once for the full active leg set. */
export function isValidLinkedFlightPair(left: FlightLeg, right: FlightLeg): boolean {
  const resolution = resolveSeasonalPairs([left, right]);
  return resolution.issues.length === 0
    && resolution.byLegId.get(left.id) === right.id
    && resolution.byLegId.get(right.id) === left.id;
}

/** @deprecated Use resolveSeasonalPairs once and read byLegId. */
export function findValidLinkedCounterpart(leg: FlightLeg, allLegs: FlightLeg[]): FlightLeg | null {
  const candidates = allLegs.some((candidate) => candidate.id === leg.id)
    ? allLegs
    : [...allLegs, leg];
  const resolution = resolveSeasonalPairs(candidates);
  const counterpartId = resolution.byLegId.get(leg.id);
  if (!counterpartId) return null;
  return new Map(candidates.map((candidate) => [candidate.id, candidate])).get(counterpartId) ?? null;
}
