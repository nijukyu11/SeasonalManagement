import type { FlightRecord } from './types';

export interface SeasonalLinkActionState {
  canLink: boolean;
  canUnlink: boolean;
}

export interface SeasonalLinkGroup {
  airline: string;
  arrFlightNumber: string | null;
  depFlightNumber: string | null;
}

export interface SeasonalLinkCandidateGroup extends SeasonalLinkGroup {
  side: 'A' | 'D';
  recordIds: Iterable<string>;
}

export interface SeasonalLinkFilters {
  dateFrom?: string;
  dateTo?: string;
}

export interface SeasonalLinkCandidate {
  key: string;
  label: string;
  flightNumber: string;
  route: string;
  schedule: string;
  aircraft: string;
  linkType: 'overnight' | 'sameday';
  arrIds: string[];
  depIds: string[];
  matchCount: number;
  effective: string;
  discontinue: string;
}

export function getSeasonalLinkActionState({
  recordCount,
  linkedPartnerCount,
}: {
  recordCount: number;
  linkedPartnerCount: number;
}): SeasonalLinkActionState {
  return {
    canLink: recordCount > 0,
    canUnlink: recordCount > 0 && linkedPartnerCount > 0,
  };
}

function cleanRouteFlightNumber(raw: string): string {
  return /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw;
}

function shiftIsoDate(iso: string, offsetDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function isUnlinked(record: FlightRecord): boolean {
  return record.status !== 'deleted' && !record.linkType && !record.linkedRecordId && !record.turnaroundId;
}

function dateBounds(dates: string[]): { effective: string; discontinue: string } {
  const sorted = [...dates].sort();
  return {
    effective: sorted[0] ?? '',
    discontinue: sorted[sorted.length - 1] ?? '',
  };
}

export function buildSeasonalLinkCandidates(
  records: FlightRecord[],
  group: SeasonalLinkCandidateGroup
): SeasonalLinkCandidate[] {
  const groupRecordIds = new Set(group.recordIds);
  const selectedType = group.side;
  const oppositeType = selectedType === 'A' ? 'D' : 'A';
  const selectedByDate = new Map<string, FlightRecord>();

  for (const record of records) {
    if (!groupRecordIds.has(record.id)) continue;
    if (record.type !== selectedType) continue;
    if (!isUnlinked(record)) continue;
    if (record.airline !== group.airline) continue;
    selectedByDate.set(record.date, record);
  }

  if (selectedByDate.size === 0) return [];

  const groups = new Map<string, {
    sample: FlightRecord;
    linkType: 'overnight' | 'sameday';
    pairs: Array<{ arr: FlightRecord; dep: FlightRecord }>;
  }>();

  for (const candidate of records) {
    if (candidate.type !== oppositeType) continue;
    if (!isUnlinked(candidate)) continue;
    if (candidate.airline !== group.airline) continue;

    const selectedSample = selectedType === 'A'
      ? selectedByDate.get(candidate.date) ?? selectedByDate.get(shiftIsoDate(candidate.date, -1))
      : selectedByDate.get(candidate.date) ?? selectedByDate.get(shiftIsoDate(candidate.date, 1));
    if (!selectedSample) continue;

    const arrTime = selectedType === 'A' ? selectedSample.schedule : candidate.schedule;
    const depTime = selectedType === 'A' ? candidate.schedule : selectedSample.schedule;
    const linkType = timeToMinutes(depTime) < timeToMinutes(arrTime) ? 'overnight' as const : 'sameday' as const;
    const selectedDate = selectedType === 'A'
      ? linkType === 'overnight' ? shiftIsoDate(candidate.date, -1) : candidate.date
      : linkType === 'overnight' ? shiftIsoDate(candidate.date, 1) : candidate.date;
    const selected = selectedByDate.get(selectedDate);
    if (!selected) continue;
    if (selected.aircraft !== candidate.aircraft) continue;

    const key = [
      candidate.airline,
      candidate.type,
      candidate.flightNumber,
      candidate.route,
      candidate.schedule,
      candidate.aircraft,
      linkType,
    ].join('|');
    const existing = groups.get(key) ?? { sample: candidate, linkType, pairs: [] };
    existing.pairs.push(selectedType === 'A'
      ? { arr: selected, dep: candidate }
      : { arr: candidate, dep: selected }
    );
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .map(([key, candidateGroup]) => {
      const pairs = candidateGroup.pairs.sort((a, b) => a.arr.date.localeCompare(b.arr.date));
      const { effective, discontinue } = dateBounds(pairs.map((pair) => pair.arr.date));
      return {
        key,
        label: `${candidateGroup.sample.flightNumber} ${candidateGroup.sample.route} ${candidateGroup.sample.schedule}`,
        flightNumber: candidateGroup.sample.flightNumber,
        route: candidateGroup.sample.route,
        schedule: candidateGroup.sample.schedule,
        aircraft: candidateGroup.sample.aircraft,
        linkType: candidateGroup.linkType,
        arrIds: pairs.map((pair) => pair.arr.id),
        depIds: pairs.map((pair) => pair.dep.id),
        matchCount: pairs.length,
        effective,
        discontinue,
      };
    })
    .filter((candidate) => candidate.matchCount > 0)
    .sort((a, b) =>
      b.matchCount - a.matchCount ||
      a.flightNumber.localeCompare(b.flightNumber) ||
      a.schedule.localeCompare(b.schedule)
    );
}

export function buildSeasonalLinkRoute(
  seasonId: string,
  group: SeasonalLinkGroup,
  filters: SeasonalLinkFilters = {}
): string {
  const params = new URLSearchParams();
  params.set('season', seasonId);

  if (group.arrFlightNumber) {
    params.set('arrFlight', `${group.airline}${cleanRouteFlightNumber(group.arrFlightNumber)}`);
  }
  if (group.depFlightNumber) {
    params.set('depFlight', `${group.airline}${cleanRouteFlightNumber(group.depFlightNumber)}`);
  }
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);

  return `/detailed?${params.toString()}`;
}
