import { flightRecordsToLegs } from './atomicSchedule';
import type { FlightLeg, FlightModification, FlightRecord } from './types';

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

function applyMods(legs: FlightLeg[], mods: Map<string, FlightModification>): FlightLeg[] {
  const next = legs
    .map((leg) => {
      const mod = mods.get(leg.id);
      if (!mod) return leg;
      if (mod.action === 'deleted') return { ...leg, action: 'deleted' as const };
      if (mod.action === 'modified') {
        return {
          ...leg,
          schedule: mod.schedule ?? leg.schedule,
          aircraft: mod.aircraft ?? leg.aircraft,
          route: mod.route ?? leg.route,
          codeShares: 'codeShares' in mod ? mod.codeShares ?? null : leg.codeShares,
          pax: 'pax' in mod ? mod.pax ?? null : leg.pax,
          gate: 'gate' in mod ? mod.gate ?? null : leg.gate,
          stand: 'stand' in mod ? mod.stand ?? null : leg.stand,
          counter: 'counter' in mod ? mod.counter ?? null : leg.counter,
          carousel: 'carousel' in mod ? mod.carousel ?? null : leg.carousel,
          mct: 'mct' in mod ? mod.mct ?? null : leg.mct,
          fb: 'fb' in mod ? mod.fb ?? null : leg.fb,
          lb: 'lb' in mod ? mod.lb ?? null : leg.lb,
          bhs: 'bhs' in mod ? mod.bhs ?? null : leg.bhs,
          ghs: 'ghs' in mod ? mod.ghs ?? null : leg.ghs,
          action: 'modified' as const,
        };
      }
      return leg;
    })
    .filter((leg) => leg.action !== 'deleted');

  for (const mod of mods.values()) {
    if (mod.action === 'added' && mod.addedLeg) {
      next.push({ ...mod.addedLeg, action: 'added' });
    }
  }
  return next;
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
  const legs = applyMods(flightRecordsToLegs(records), modifications);
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
