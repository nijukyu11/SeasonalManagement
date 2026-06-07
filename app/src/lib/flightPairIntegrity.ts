import type { FlightLeg } from './types';

export type FlightPairLinkType = 'overnight' | 'sameday';

export function shiftIsoDate(isoDate: string, offsetDays: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

export function expectedDateForLinkedLeg(anchorDate: string, legType: FlightLeg['type'], linkType: FlightPairLinkType): string {
  if (linkType !== 'overnight') return anchorDate;
  return legType === 'D' ? shiftIsoDate(anchorDate, 1) : anchorDate;
}

export function inferLinkedPairType(left: FlightLeg, right: FlightLeg): FlightPairLinkType {
  if (left.linkType) return left.linkType;
  if (right.linkType) return right.linkType;
  const arr = left.type === 'A' ? left : right.type === 'A' ? right : null;
  const dep = left.type === 'D' ? left : right.type === 'D' ? right : null;
  return arr && dep && dep.date > arr.date ? 'overnight' : 'sameday';
}

export function pairAnchorForLinkedLegs(left: FlightLeg, right: FlightLeg, linkType = inferLinkedPairType(left, right)): string {
  if (left.pairAnchorDate) return left.pairAnchorDate;
  if (right.pairAnchorDate) return right.pairAnchorDate;
  const arr = left.type === 'A' ? left : right.type === 'A' ? right : null;
  if (arr) return arr.date;
  return linkType === 'overnight' && left.type === 'D' ? shiftIsoDate(left.date, -1) : left.date;
}

export function isValidLinkedFlightPair(left: FlightLeg, right: FlightLeg): boolean {
  if (left.id === right.id) return false;
  if (left.action === 'deleted' || right.action === 'deleted') return false;
  if (!left.linkId || !right.linkId || left.linkId !== right.linkId) return false;
  if (left.type === right.type) return false;
  if (left.linkedRecordId !== right.id || right.linkedRecordId !== left.id) return false;
  if (left.linkType && right.linkType && left.linkType !== right.linkType) return false;

  const linkType = inferLinkedPairType(left, right);
  const anchorDate = pairAnchorForLinkedLegs(left, right, linkType);
  const leftAnchor = left.pairAnchorDate ?? anchorDate;
  const rightAnchor = right.pairAnchorDate ?? anchorDate;
  if (leftAnchor !== anchorDate || rightAnchor !== anchorDate) return false;

  return left.date === expectedDateForLinkedLeg(anchorDate, left.type, linkType) &&
    right.date === expectedDateForLinkedLeg(anchorDate, right.type, linkType);
}

export function findValidLinkedCounterpart(leg: FlightLeg, allLegs: FlightLeg[]): FlightLeg | null {
  if (!leg.linkId || leg.action === 'deleted') return null;
  const allById = new Map(allLegs.map((candidate) => [candidate.id, candidate]));
  const linkedById = leg.linkedRecordId ? allById.get(leg.linkedRecordId) : null;
  if (linkedById && isValidLinkedFlightPair(leg, linkedById)) return linkedById;

  return allLegs.find((candidate) =>
    candidate.id !== leg.id &&
    candidate.linkId === leg.linkId &&
    candidate.type !== leg.type &&
    isValidLinkedFlightPair(leg, candidate)
  ) ?? null;
}
