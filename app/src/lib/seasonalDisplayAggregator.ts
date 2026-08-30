import { materializeEffectiveSeasonalLegs } from './effectiveSeasonalLegs.ts';
import type { FlightModification, FlightRecord } from './types';

export interface SeasonalDisplayGroupSnapshot {
  key: string;
  airline: string;
  side: 'A' | 'D';
  arrFlightNumber: string | null;
  depFlightNumber: string | null;
  routes: string[];
  aircrafts: string[];
  times: string[];
  validityPeriods: string[];
  daysOfWeek: boolean[];
  recordIds: string[];
  linkedPartners: string[];
  linkTypes: Array<'overnight' | 'sameday'>;
}

function dayIndex(iso: string): number {
  const date = new Date(`${iso}T00:00:00Z`);
  return (date.getUTCDay() + 6) % 7;
}

function addPeriod(periods: Set<string>, dates: string[]): void {
  if (dates.length === 0) return;
  const sorted = [...dates].sort();
  periods.add(`${sorted[0]} - ${sorted[sorted.length - 1]}`);
}

export function buildSeasonalDisplayGroups(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>
): SeasonalDisplayGroupSnapshot[] {
  const legs = materializeEffectiveSeasonalLegs(records, modifications);
  const legsById = new Map(legs.map((leg) => [leg.id, leg]));
  const groups = new Map<string, SeasonalDisplayGroupSnapshot & { _dates: string[] }>();

  for (const leg of legs) {
    const key = `${leg.airline}|${leg.type}|${leg.rawFlightNumber}`;
    const existing = groups.get(key) ?? {
      key,
      airline: leg.airline,
      side: leg.type,
      arrFlightNumber: leg.type === 'A' ? leg.rawFlightNumber : null,
      depFlightNumber: leg.type === 'D' ? leg.rawFlightNumber : null,
      routes: [],
      aircrafts: [],
      times: [],
      validityPeriods: [],
      daysOfWeek: [false, false, false, false, false, false, false],
      recordIds: [],
      linkedPartners: [],
      linkTypes: [],
      _dates: [],
    };

    if (leg.route && !existing.routes.includes(leg.route)) existing.routes.push(leg.route);
    if (leg.aircraft && !existing.aircrafts.includes(leg.aircraft)) existing.aircrafts.push(leg.aircraft);
    if (leg.schedule && !existing.times.includes(leg.schedule)) existing.times.push(leg.schedule);
    if (!existing.recordIds.includes(leg.id)) existing.recordIds.push(leg.id);
    existing.daysOfWeek[dayIndex(leg.date)] = true;
    existing._dates.push(leg.date);

    const linked = leg.linkedRecordId ? legsById.get(leg.linkedRecordId) : null;
    if (linked && leg.linkType) {
      const suffix = leg.linkType === 'overnight' ? (leg.type === 'A' ? ' +1' : ' -1') : '';
      const partnerLabel = `${linked.flightNumber}${suffix}`;
      if (!existing.linkedPartners.includes(partnerLabel)) existing.linkedPartners.push(partnerLabel);
      if (!existing.linkTypes.includes(leg.linkType)) existing.linkTypes.push(leg.linkType);
    }

    groups.set(key, existing);
  }

  return Array.from(groups.values()).map((group) => {
    const periods = new Set<string>();
    addPeriod(periods, group._dates);
    return {
      key: group.key,
      airline: group.airline,
      side: group.side,
      arrFlightNumber: group.arrFlightNumber,
      depFlightNumber: group.depFlightNumber,
      routes: group.routes,
      aircrafts: group.aircrafts,
      times: group.times,
      daysOfWeek: group.daysOfWeek,
      recordIds: group.recordIds,
      linkedPartners: group.linkedPartners,
      linkTypes: group.linkTypes,
      validityPeriods: Array.from(periods),
    };
  });
}
