import { registerOperatorSessionCacheClearer } from './operatorSessionCacheRegistry.ts';
import type { FlightLeg } from './types';

export interface DetailedRowScope {
  seasonId: string;
  recordIds: string[];
  dateFrom: string;
  dateTo: string;
}

// Navigation handoff, not a flight cache. Direct URLs and expired sessions fail closed.
let active: { token: string; scope: DetailedRowScope } | null = null;
registerOperatorSessionCacheClearer('detailed-row-scope', () => { active = null; });

export function openDetailedRowScope(seasonId: string, rowIds: Set<string>, legs: FlightLeg[]) {
  const byId = new Map(legs.map(leg => [leg.id, leg]));
  const ids = new Set<string>();
  let dateFrom = '', dateTo = '';
  const include = (leg: FlightLeg) => {
    ids.add(leg.id);
    if (!dateFrom || leg.date < dateFrom) dateFrom = leg.date;
    if (leg.date > dateTo) dateTo = leg.date;
  };
  for (const id of rowIds) {
    const leg = byId.get(id);
    if (!leg) return null;
    include(leg);
    if (leg.linkedRecordId) {
      const partner = byId.get(leg.linkedRecordId);
      if (!partner || partner.linkedRecordId !== id) return null;
      include(partner);
    }
  }
  if (!ids.size || !dateFrom || !seasonId) return null;
  const token = crypto.randomUUID();
  active = { token, scope: { seasonId, recordIds: [...ids], dateFrom, dateTo } };
  return { token, dateFrom, dateTo };
}

export function readDetailedRowScope(token: string | null): DetailedRowScope | null {
  return active && token === active.token ? active.scope : null;
}

export function extendDetailedRowScope(token: string, recordIds: string[]): void {
  const scope = readDetailedRowScope(token);
  if (scope) scope.recordIds = [...new Set([...scope.recordIds, ...recordIds])];
}
