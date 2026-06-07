import type { DisplayRow, FlightLeg, PatternGroup } from './types';

export interface LinkDisplayGroup {
  airline: string;
  arrFlightNumber: string | null;
  depFlightNumber: string | null;
  patterns?: Array<Pick<PatternGroup, 'airline' | 'arrFlightNumber' | 'depFlightNumber'>>;
}

type LinkType = 'overnight' | 'sameday';

export interface SourceUnlinkTarget {
  mode: 'manual' | 'sameRow';
  rowIndex: number;
  linkedRowIndex?: number;
  linkType: LinkType;
}

function cleanGroupFlight(airline: string, raw: string | null): string | null {
  if (!raw) return null;
  const rawStr = String(raw).trim();
  if (!rawStr) return null;
  const flightPart = rawStr.toUpperCase().startsWith(airline.toUpperCase())
    ? rawStr.slice(airline.length)
    : rawStr;
  const normalized = /^\d+$/.test(flightPart) ? flightPart.padStart(3, '0') : flightPart;
  return `${airline}${normalized}`;
}

function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function inferLinkType(row: DisplayRow, partner: DisplayRow): LinkType {
  if (row.linkType === 'sameday' || partner.linkType === 'sameday') return 'sameday';
  if (row.linkType === 'overnight' || partner.linkType === 'overnight') return 'overnight';

  const arrRow = row.arrCleanFlight ? row : partner.arrCleanFlight ? partner : null;
  const depRow = row.depCleanFlight ? row : partner.depCleanFlight ? partner : null;
  const arrTime = timeToMinutes(arrRow?.sta);
  const depTime = timeToMinutes(depRow?.std);
  if (arrTime != null && depTime != null && depTime >= arrTime) return 'sameday';
  return 'overnight';
}

function withLinkType(row: DisplayRow, linkType: LinkType): DisplayRow {
  return row.linkType === linkType ? row : { ...row, linkType };
}

function flightPairsForGroup(group: LinkDisplayGroup): Array<{ arr: string | null; dep: string | null }> {
  const pairs: Array<{ arr: string | null; dep: string | null }> = [];
  const addPair = (airline: string, arrRaw: string | null, depRaw: string | null) => {
    const pair = {
      arr: cleanGroupFlight(airline, arrRaw),
      dep: cleanGroupFlight(airline, depRaw),
    };
    if (!pair.arr && !pair.dep) return;
    if (pairs.some((p) => p.arr === pair.arr && p.dep === pair.dep)) return;
    pairs.push(pair);
  };

  for (const pattern of group.patterns ?? []) {
    addPair(pattern.airline, pattern.arrFlightNumber, pattern.depFlightNumber);
  }
  addPair(group.airline, group.arrFlightNumber, group.depFlightNumber);

  return pairs;
}

export function findLinkedSourceRowForDisplayGroup(
  displayRows: DisplayRow[],
  group: LinkDisplayGroup
): DisplayRow | null {
  const target = findUnlinkTargetForDisplayGroup(displayRows, group);
  if (!target) return null;
  return displayRows.find((row) => row.rowIndex === target.rowIndex) ?? null;
}

export function findUnlinkTargetForDisplayGroup(
  displayRows: DisplayRow[],
  group: LinkDisplayGroup
): SourceUnlinkTarget | null {
  const rowsByIndex = new Map(displayRows.map((row) => [row.rowIndex, row]));
  const linkedRows = displayRows.filter((row) =>
    row.airline === group.airline && row.overnightLinkRowIndex != null
  );
  const targetPairs = flightPairsForGroup(group);

  for (const row of linkedRows) {
    if (row.overnightLinkRowIndex == null) continue;
    const partner = rowsByIndex.get(row.overnightLinkRowIndex);
    if (!partner || partner.airline !== row.airline) continue;

    const linkType = inferLinkType(row, partner);
    const arrRow = row.arrCleanFlight ? row : partner.arrCleanFlight ? partner : null;
    const depRow = row.depCleanFlight ? row : partner.depCleanFlight ? partner : null;

    for (const target of targetPairs) {
      if (target.arr && target.dep) {
        if (
          linkType === 'sameday' &&
          arrRow?.arrCleanFlight === target.arr &&
          depRow?.depCleanFlight === target.dep
        ) {
          return {
            mode: 'manual',
            rowIndex: arrRow.rowIndex,
            linkedRowIndex: arrRow.overnightLinkRowIndex ?? depRow.overnightLinkRowIndex,
            linkType: 'sameday',
          };
        }
        continue;
      }

      if (target.arr && arrRow?.arrCleanFlight === target.arr) {
        return {
          mode: 'manual',
          rowIndex: arrRow.rowIndex,
          linkedRowIndex: arrRow.overnightLinkRowIndex,
          linkType,
        };
      }
      if (target.dep && depRow?.depCleanFlight === target.dep) {
        return {
          mode: 'manual',
          rowIndex: depRow.rowIndex,
          linkedRowIndex: depRow.overnightLinkRowIndex,
          linkType,
        };
      }
    }
  }

  for (const target of targetPairs) {
    if (!target.arr || !target.dep) continue;
    const row = displayRows.find((candidate) =>
      candidate.airline === group.airline &&
      candidate.overnightLinkRowIndex == null &&
      candidate.arrFlight &&
      candidate.depFlight &&
      candidate.arrCleanFlight === target.arr &&
      candidate.depCleanFlight === target.dep
    );
    if (row) {
      return {
        mode: 'sameRow',
        rowIndex: row.rowIndex,
        linkType: inferLinkType(row, row),
      };
    }
  }

  return null;
}

export function findSourceUnlinkTargetsForLegs(
  displayRows: DisplayRow[],
  legs: Array<Pick<FlightLeg, 'sourceRowIndex'>>
): SourceUnlinkTarget[] {
  const rowsByIndex = new Map(displayRows.map((row) => [row.rowIndex, row]));
  const targets: SourceUnlinkTarget[] = [];
  const seen = new Set<string>();

  for (const leg of legs) {
    const row = rowsByIndex.get(leg.sourceRowIndex);
    if (!row) continue;

    if (row.overnightLinkRowIndex != null) {
      const partner = rowsByIndex.get(row.overnightLinkRowIndex);
      const [a, b] = [row.rowIndex, row.overnightLinkRowIndex].sort((x, y) => x - y);
      const key = `manual:${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        mode: 'manual',
        rowIndex: a,
        linkedRowIndex: b,
        linkType: partner ? inferLinkType(row, partner) : row.linkType ?? 'overnight',
      });
      continue;
    }

    if (row.arrFlight && row.depFlight) {
      const key = `sameRow:${row.rowIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        mode: 'sameRow',
        rowIndex: row.rowIndex,
        linkType: inferLinkType(row, row),
      });
    }
  }

  return targets;
}
