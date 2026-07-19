import type { FlightLeg } from './types.ts';

export type FlightPairLinkType = 'overnight' | 'sameday';

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

export function shiftIsoDate(isoDate: string, offsetDays: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

export function expectedDateForLinkedLeg(
  anchorDate: string,
  legType: FlightLeg['type'],
  linkType: FlightPairLinkType,
): string {
  if (linkType !== 'overnight') return anchorDate;
  return legType === 'D' ? shiftIsoDate(anchorDate, 1) : anchorDate;
}

export function inferLinkedPairType(left: FlightLeg, right: FlightLeg): FlightPairLinkType {
  if (left.linkType) return left.linkType;
  if (right.linkType) return right.linkType;
  const arrival = left.type === 'A' ? left : right.type === 'A' ? right : null;
  const departure = left.type === 'D' ? left : right.type === 'D' ? right : null;
  return arrival && departure && departure.date > arrival.date ? 'overnight' : 'sameday';
}

export function pairAnchorForLinkedLegs(
  left: FlightLeg,
  right: FlightLeg,
  linkType = inferLinkedPairType(left, right),
): string {
  if (left.pairAnchorDate) return left.pairAnchorDate;
  if (right.pairAnchorDate) return right.pairAnchorDate;
  const arrival = left.type === 'A' ? left : right.type === 'A' ? right : null;
  if (arrival) return arrival.date;
  return linkType === 'overnight' && left.type === 'D' ? shiftIsoDate(left.date, -1) : left.date;
}

function hasValidLegType(leg: FlightLeg): boolean {
  return leg.type === 'A' || leg.type === 'D';
}

function pairMembers(left: FlightLeg, right: FlightLeg): { arrival: FlightLeg; departure: FlightLeg } | null {
  if (left.id === right.id || !hasValidLegType(left) || !hasValidLegType(right) || left.type === right.type) {
    return null;
  }
  return left.type === 'A'
    ? { arrival: left, departure: right }
    : { arrival: right, departure: left };
}

function pairMetadataIsCompatible(
  left: FlightLeg,
  right: FlightLeg,
  options: { allowDistinctLinkIds?: boolean } = {},
): boolean {
  const pair = pairMembers(left, right);
  if (!pair) return false;
  if (
    !options.allowDistinctLinkIds
    && (!left.linkId || !right.linkId || left.linkId !== right.linkId)
  ) {
    return false;
  }
  if (left.linkType && right.linkType && left.linkType !== right.linkType) return false;
  if (left.pairAnchorDate && right.pairAnchorDate && left.pairAnchorDate !== right.pairAnchorDate) return false;

  const linkType = inferLinkedPairType(left, right);
  const anchorDate = pairAnchorForLinkedLegs(left, right, linkType);
  return pair.arrival.date === expectedDateForLinkedLeg(anchorDate, 'A', linkType)
    && pair.departure.date === expectedDateForLinkedLeg(anchorDate, 'D', linkType);
}

function anchorKey(leg: FlightLeg): string | null {
  return leg.linkId && leg.pairAnchorDate && leg.linkType
    ? `${leg.linkId}|${leg.pairAnchorDate}|${leg.linkType}`
    : null;
}

function addToGroup(index: Map<string, FlightLeg[]>, key: string, leg: FlightLeg): void {
  const group = index.get(key) ?? [];
  group.push(leg);
  index.set(key, group);
}

function hasPairingIntent(leg: FlightLeg): boolean {
  return !!leg.linkedRecordId || !!leg.turnaroundId || !!leg.linkType || !!leg.pairAnchorDate;
}

export function resolveSeasonalPairs(legs: FlightLeg[]): SeasonalPairResolution {
  const activeLegs = legs.filter((leg) => leg.action !== 'deleted');
  const processed = new Set<string>();
  const blocked = new Set<string>();
  const pairs: SeasonalPairResolution['pairs'] = [];
  const issues: SeasonalPairIssue[] = [];
  const issueKeys = new Set<string>();
  const issueLegIds = new Set<string>();
  const counterpartByLegId = new Map<string, string>();

  const addIssue = (code: SeasonalPairIssue['code'], leg: FlightLeg, message: string): void => {
    const key = `${code}:${leg.id}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issueLegIds.add(leg.id);
    issues.push({ code, legId: leg.id, message });
  };

  const legsById = new Map<string, FlightLeg[]>();
  for (const leg of activeLegs) addToGroup(legsById, leg.id, leg);
  for (const [id, group] of legsById) {
    if (group.length > 1) {
      blocked.add(id);
      addIssue(
        'ambiguous-pair',
        group[0],
        `Duplicate active leg ID ${id} appears ${group.length} times and cannot be paired safely.`,
      );
      continue;
    }
    if (!hasValidLegType(group[0])) {
      blocked.add(id);
      addIssue(
        'ambiguous-pair',
        group[0],
        `${group[0].flightNumber} on ${group[0].date} has invalid flight type ${String(group[0].type)}.`,
      );
    }
  }

  const eligibleLegs = activeLegs.filter((leg) => !blocked.has(leg.id));
  const byId = new Map(eligibleLegs.map((leg) => [leg.id, leg]));
  const addPair = (
    left: FlightLeg,
    right: FlightLeg,
    options?: { allowDistinctLinkIds?: boolean },
  ): boolean => {
    if (
      left.id === right.id
      || processed.has(left.id)
      || processed.has(right.id)
      || blocked.has(left.id)
      || blocked.has(right.id)
    ) {
      return false;
    }
    const pair = pairMembers(left, right);
    if (!pair || !pairMetadataIsCompatible(left, right, options)) return false;
    pairs.push(pair);
    processed.add(left.id);
    processed.add(right.id);
    counterpartByLegId.set(left.id, right.id);
    counterpartByLegId.set(right.id, left.id);
    return true;
  };

  for (const leg of eligibleLegs) {
    if (processed.has(leg.id) || blocked.has(leg.id) || !leg.linkedRecordId) continue;
    if (leg.linkedRecordId === leg.id) {
      blocked.add(leg.id);
      addIssue('ambiguous-pair', leg, `${leg.flightNumber} on ${leg.date} links to itself.`);
      continue;
    }

    const counterpart = byId.get(leg.linkedRecordId);
    if (!counterpart) {
      blocked.add(leg.id);
      const knownCounterpart = legsById.has(leg.linkedRecordId);
      addIssue(
        knownCounterpart ? 'ambiguous-pair' : 'missing-counterpart',
        leg,
        knownCounterpart
          ? `${leg.flightNumber} on ${leg.date} links to an invalid or duplicate counterpart.`
          : `${leg.flightNumber} on ${leg.date} links to a missing counterpart.`,
      );
      continue;
    }
    if (processed.has(counterpart.id) || blocked.has(counterpart.id)) {
      blocked.add(leg.id);
      addIssue(
        'ambiguous-pair',
        leg,
        `${leg.flightNumber} on ${leg.date} links to a counterpart that is already consumed or invalid.`,
      );
      continue;
    }
    if (counterpart.linkedRecordId !== leg.id) {
      blocked.add(leg.id);
      addIssue('non-reciprocal-link', leg, `${leg.flightNumber} on ${leg.date} has a non-reciprocal linked record ID.`);
      continue;
    }
    if (!addPair(leg, counterpart)) {
      blocked.add(leg.id);
      blocked.add(counterpart.id);
      addIssue('non-reciprocal-link', leg, `${leg.flightNumber} on ${leg.date} has incompatible reciprocal pair metadata.`);
      addIssue(
        'non-reciprocal-link',
        counterpart,
        `${counterpart.flightNumber} on ${counterpart.date} has incompatible reciprocal pair metadata.`,
      );
    }
  }

  const turnaroundGroups = new Map<string, FlightLeg[]>();
  for (const leg of eligibleLegs) {
    if (!processed.has(leg.id) && !blocked.has(leg.id) && leg.turnaroundId) {
      addToGroup(turnaroundGroups, leg.turnaroundId, leg);
    }
  }
  for (const [turnaroundId, group] of turnaroundGroups) {
    if (group.length > 2) {
      for (const leg of group) {
        blocked.add(leg.id);
        addIssue(
          'ambiguous-pair',
          leg,
          `${leg.flightNumber} on ${leg.date} belongs to ambiguous turnaround ${turnaroundId} with ${group.length} legs.`,
        );
      }
      continue;
    }
    if (group.length === 2 && !addPair(group[0], group[1], { allowDistinctLinkIds: true })) {
      for (const leg of group) {
        blocked.add(leg.id);
        addIssue(
          'ambiguous-pair',
          leg,
          `${leg.flightNumber} on ${leg.date} belongs to turnaround ${turnaroundId} without one compatible A/D pair.`,
        );
      }
    }
  }

  const anchorGroups = new Map<string, FlightLeg[]>();
  for (const leg of eligibleLegs) {
    if (processed.has(leg.id) || blocked.has(leg.id)) continue;
    const key = anchorKey(leg);
    if (key) addToGroup(anchorGroups, key, leg);
  }
  for (const [key, group] of anchorGroups) {
    if (group.length > 2) {
      for (const leg of group) {
        blocked.add(leg.id);
        addIssue(
          'ambiguous-pair',
          leg,
          `${leg.flightNumber} on ${leg.date} belongs to ambiguous pair anchor ${key} with ${group.length} legs.`,
        );
      }
      continue;
    }
    if (group.length === 2 && !addPair(group[0], group[1])) {
      for (const leg of group) {
        blocked.add(leg.id);
        addIssue(
          'ambiguous-pair',
          leg,
          `${leg.flightNumber} on ${leg.date} belongs to pair anchor ${key} without one compatible A/D pair.`,
        );
      }
    }
  }

  for (const leg of activeLegs) {
    if (processed.has(leg.id) || issueLegIds.has(leg.id)) continue;
    if (hasPairingIntent(leg)) {
      addIssue('missing-counterpart', leg, `${leg.flightNumber} on ${leg.date} has no unique active counterpart.`);
    }
  }

  return {
    pairs,
    unpaired: activeLegs.filter((leg) => !processed.has(leg.id)),
    issues,
    byLegId: counterpartByLegId,
  };
}

export function closeSeasonalSelectionOverPairs(
  selectedIds: string[],
  resolution: SeasonalPairResolution,
): string[] {
  const closed: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (!seen.has(id)) {
      seen.add(id);
      closed.push(id);
    }
    const counterpartId = resolution.byLegId.get(id);
    if (counterpartId && !seen.has(counterpartId)) {
      seen.add(counterpartId);
      closed.push(counterpartId);
    }
  }
  return closed;
}
