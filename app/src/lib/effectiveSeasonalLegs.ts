import { flightRecordsToLegs } from './atomicSchedule.ts';
import { buildOperationalFlightMetadata } from './iataSeason.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types';

function applyMetadata(leg: FlightLeg): FlightLeg {
  const scheduledDate = leg.scheduledDate ?? leg.date;
  const scheduledTime = leg.schedule;
  const metadata = buildOperationalFlightMetadata({
    scheduledDate,
    scheduledTime,
    type: leg.type,
    airline: leg.airline,
    flightNumber: leg.flightNumber,
    route: leg.route,
  });
  return {
    ...leg,
    ...metadata,
    date: metadata.scheduledDate,
    dayOfWeek: new Date(`${metadata.scheduledDate}T00:00:00Z`).getUTCDay(),
  };
}

export function applyEffectiveSeasonalLegModifications(
  baseLegs: FlightLeg[],
  modifications: Map<string, FlightModification>,
): FlightLeg[] {
  const byId = new Map<string, FlightLeg>();
  for (const leg of baseLegs) byId.set(leg.id, applyMetadata(leg));

  for (const [legId, modification] of modifications) {
    const base = byId.get(legId);
    if (modification.action === 'added') {
      if (!base && modification.addedLeg) byId.set(legId, applyMetadata({ ...modification.addedLeg, action: 'added' }));
      continue;
    }
    if (!base) continue;
    if (modification.action === 'deleted') {
      byId.delete(legId);
      continue;
    }
    const next: FlightLeg = {
      ...base,
      schedule: modification.schedule ?? base.schedule,
      aircraft: modification.aircraft ?? base.aircraft,
      route: modification.route ?? base.route,
      codeShares: 'codeShares' in modification ? modification.codeShares ?? null : base.codeShares,
      pax: 'pax' in modification ? modification.pax ?? null : base.pax,
      gate: 'gate' in modification ? modification.gate ?? null : base.gate,
      stand: 'stand' in modification ? modification.stand ?? null : base.stand,
      counter: 'counter' in modification ? modification.counter ?? null : base.counter,
      carousel: 'carousel' in modification ? modification.carousel ?? null : base.carousel,
      mct: 'mct' in modification ? modification.mct ?? null : base.mct,
      fb: 'fb' in modification ? modification.fb ?? null : base.fb,
      lb: 'lb' in modification ? modification.lb ?? null : base.lb,
      bhs: 'bhs' in modification ? modification.bhs ?? null : base.bhs,
      ghs: 'ghs' in modification ? modification.ghs ?? null : base.ghs,
      action: 'modified',
    };
    byId.set(legId, applyMetadata(next));
  }
  return [...byId.values()];
}

export function materializeEffectiveSeasonalLegs(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>,
): FlightLeg[] {
  return applyEffectiveSeasonalLegModifications(flightRecordsToLegs(records), modifications);
}
