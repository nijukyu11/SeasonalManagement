import { buildOperationalFlightMetadata } from './iataSeason.ts';
import type { FlightLeg, FlightModification, FlightRecord } from './types.ts';

function hasField<K extends keyof FlightModification>(
  modification: FlightModification,
  field: K,
): modification is FlightModification & Required<Pick<FlightModification, K>> {
  return Object.prototype.hasOwnProperty.call(modification, field);
}

function applyModifiedFields(leg: FlightLeg, modification: FlightModification): FlightLeg {
  const next: FlightLeg = {
    ...leg,
    schedule: modification.schedule ?? leg.schedule,
    aircraft: modification.aircraft ?? leg.aircraft,
    route: modification.route ?? leg.route,
    codeShares: hasField(modification, 'codeShares') ? modification.codeShares ?? null : leg.codeShares,
    pax: hasField(modification, 'pax') ? modification.pax ?? null : leg.pax,
    gate: hasField(modification, 'gate') ? modification.gate ?? null : leg.gate,
    stand: hasField(modification, 'stand') ? modification.stand ?? null : leg.stand,
    counter: hasField(modification, 'counter') ? modification.counter ?? null : leg.counter,
    checkInStart: hasField(modification, 'checkInStart') ? modification.checkInStart ?? null : leg.checkInStart,
    checkInEnd: hasField(modification, 'checkInEnd') ? modification.checkInEnd ?? null : leg.checkInEnd,
    checkInAllocationMode: hasField(modification, 'checkInAllocationMode')
      ? modification.checkInAllocationMode ?? null
      : leg.checkInAllocationMode,
    checkInCounterWindows: hasField(modification, 'checkInCounterWindows')
      ? modification.checkInCounterWindows ?? null
      : leg.checkInCounterWindows,
    carousel: hasField(modification, 'carousel') ? modification.carousel ?? null : leg.carousel,
    mct: hasField(modification, 'mct') ? modification.mct ?? null : leg.mct,
    fb: hasField(modification, 'fb') ? modification.fb ?? null : leg.fb,
    lb: hasField(modification, 'lb') ? modification.lb ?? null : leg.lb,
    bhs: hasField(modification, 'bhs') ? modification.bhs ?? null : leg.bhs,
    ghs: hasField(modification, 'ghs') ? modification.ghs ?? null : leg.ghs,
    action: 'modified',
  };
  return next.schedule !== leg.schedule || next.route !== leg.route
    ? withRecomputedOperationalMetadata(next)
    : next;
}

function withRecomputedOperationalMetadata(leg: FlightLeg): FlightLeg {
  const metadata = buildOperationalFlightMetadata({
    scheduledDate: leg.date,
    scheduledTime: leg.schedule,
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

export function materializeEffectiveSeasonalLegs(
  records: FlightRecord[],
  modifications: Map<string, FlightModification>,
): FlightLeg[];
export function materializeEffectiveSeasonalLegs(
  records: FlightLeg[],
  modifications: Map<string, FlightModification>,
): FlightLeg[];
export function materializeEffectiveSeasonalLegs(
  records: FlightLeg[],
  modifications: Map<string, FlightModification>,
): FlightLeg[] {
  const byId = new Map<string, FlightLeg>();
  const persistedDeletedIds = new Set<string>();

  for (const record of records) {
    if (!byId.has(record.id)) byId.set(record.id, { ...record });
    if (
      record.action === 'deleted'
      || ('status' in record && (record as FlightRecord).status === 'deleted')
    ) {
      persistedDeletedIds.add(record.id);
    }
  }

  for (const modification of modifications.values()) {
    if (modification.action !== 'added' || !modification.addedLeg) continue;
    const added = modification.addedLeg;
    if (!byId.has(added.id)) {
      byId.set(added.id, { ...added, action: 'added' });
    }
  }

  const effective: FlightLeg[] = [];
  for (const [id, leg] of byId) {
    const modification = modifications.get(id);
    if (persistedDeletedIds.has(id) || modification?.action === 'deleted') {
      effective.push({ ...leg, action: 'deleted' });
      continue;
    }
    if (modification?.action === 'modified') {
      effective.push(applyModifiedFields(leg, modification));
      continue;
    }
    effective.push(leg.action === 'added' ? withRecomputedOperationalMetadata(leg) : leg);
  }

  return effective.filter((leg) => leg.action !== 'deleted');
}
