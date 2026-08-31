import type { TrafficPeakHourRow, TrafficTimeBasis } from './trafficReportContract';

const OPERATIONAL_DAY_START_HOUR: Record<TrafficTimeBasis, number> = {
  local: 5,
  utc: 22,
};

function parseHourBucketMinutes(hourBucket: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hourBucket);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function getOperationalHourOffset(hourBucket: string, timeBasis: TrafficTimeBasis): number {
  const minutes = parseHourBucketMinutes(hourBucket);
  if (minutes == null) return Number.POSITIVE_INFINITY;
  const startMinutes = OPERATIONAL_DAY_START_HOUR[timeBasis] * 60;
  return (minutes - startMinutes + 1440) % 1440;
}

export function orderTrafficPeakHours<T extends Pick<TrafficPeakHourRow, 'hour_bucket'>>(
  rows: readonly T[],
  timeBasis: TrafficTimeBasis,
): T[] {
  return rows
    .map((row, index) => ({ row, index, offset: getOperationalHourOffset(row.hour_bucket, timeBasis) }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index)
    .map(({ row }) => row);
}

export function getAverageFlightsPerSelectedDay(
  totalFlights: number | null,
  selectedDayCount: number,
): number | null {
  if (totalFlights == null || !Number.isInteger(selectedDayCount) || selectedDayCount <= 0) return null;
  return totalFlights / selectedDayCount;
}

export function getSelectedDayCountForMonth(month: string, fromDate: string, toDate: string): number {
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(month);
  const fromMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromDate);
  const toMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toDate);
  if (!monthMatch || !fromMatch || !toMatch) return 0;

  const year = Number(monthMatch[1]);
  const monthIndex = Number(monthMatch[2]) - 1;
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11) return 0;

  const toUtc = (parts: RegExpExecArray) => Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  const rangeStart = toUtc(fromMatch);
  const rangeEnd = toUtc(toMatch);
  const monthStart = Date.UTC(year, monthIndex, 1);
  const monthEnd = Date.UTC(year, monthIndex + 1, 0);
  const intersectionStart = Math.max(rangeStart, monthStart);
  const intersectionEnd = Math.min(rangeEnd, monthEnd);
  if (intersectionStart > intersectionEnd) return 0;
  return Math.floor((intersectionEnd - intersectionStart) / 86_400_000) + 1;
}
