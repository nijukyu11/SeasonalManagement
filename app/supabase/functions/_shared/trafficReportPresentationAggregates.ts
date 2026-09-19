export type TrafficAggregateRow = Record<string, unknown>;

const COMPLETE_STATUSES = new Set(['complete', 'zero']);

function isRecord(value: unknown): value is TrafficAggregateRow {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.round(value));
}

function isoWeekday(opsDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(opsDate)) return null;
  const weekday = new Date(`${opsDate}T00:00:00Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function statusOf(row: TrafficAggregateRow): string {
  return typeof row.status === 'string' ? row.status : 'missing';
}

function aggregateValues(rows: TrafficAggregateRow[], field: string): {
  total: number | null;
  average: number | null;
  min: number | null;
  max: number | null;
} {
  const values = rows.flatMap((row) => {
    const value = finiteNumber(row[field]);
    return value === null ? [] : [value];
  });
  if (values.length === 0) return { total: null, average: null, min: null, max: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    total: nonNegativeInteger(total),
    average: nonNegativeInteger(total / values.length),
    min: nonNegativeInteger(Math.min(...values)),
    max: nonNegativeInteger(Math.max(...values)),
  };
}

function weekdayStatus(calendarDays: number, completeDays: number): 'complete' | 'partial' | 'missing' {
  if (completeDays === 0) return 'missing';
  return completeDays === calendarDays ? 'complete' : 'partial';
}

export function buildV2WeekdayBreakdowns(timelineValue: unknown): {
  summary: TrafficAggregateRow[];
  monthly: TrafficAggregateRow[];
} {
  const timeline = Array.isArray(timelineValue) ? timelineValue.filter(isRecord) : [];
  const datedRows = timeline.flatMap((row) => {
    const opsDate = typeof row.ops_date === 'string' ? row.ops_date : '';
    const dayIndex = isoWeekday(opsDate);
    return dayIndex === null ? [] : [{ ...row, ops_date: opsDate, day_index: dayIndex }];
  });

  const summary = Array.from({ length: 7 }, (_, offset) => {
    const dayIndex = offset + 1;
    const rows = datedRows.filter((row) => row.day_index === dayIndex);
    const completeRows = rows.filter((row) => COMPLETE_STATUSES.has(statusOf(row)));
    const flights = aggregateValues(completeRows, 'flights');
    const arrivals = aggregateValues(completeRows, 'arrivals');
    const departures = aggregateValues(completeRows, 'departures');
    return {
      day_index: dayIndex,
      calendar_days: rows.length,
      complete_day_count: completeRows.length,
      total_flights: flights.total,
      average_flights: flights.average,
      min_flights: flights.min,
      max_flights: flights.max,
      arrivals: arrivals.total,
      average_arrivals: arrivals.average,
      min_arrivals: arrivals.min,
      max_arrivals: arrivals.max,
      departures: departures.total,
      average_departures: departures.average,
      min_departures: departures.min,
      max_departures: departures.max,
      status: weekdayStatus(rows.length, completeRows.length),
      suppressed: false,
    };
  });

  const months = [...new Set(datedRows.map((row) => String(row.ops_date).slice(0, 7)))].sort();
  const rawMonthly = months.flatMap((month) => Array.from({ length: 7 }, (_, offset) => {
    const dayIndex = offset + 1;
    const rows = datedRows.filter((row) => String(row.ops_date).startsWith(`${month}-`) && row.day_index === dayIndex);
    const completeRows = rows.filter((row) => COMPLETE_STATUSES.has(statusOf(row)));
    const flights = aggregateValues(completeRows, 'flights');
    const arrivals = aggregateValues(completeRows, 'arrivals');
    const departures = aggregateValues(completeRows, 'departures');
    return {
      month,
      day_index: dayIndex,
      selected_day_count: rows.length,
      complete_day_count: completeRows.length,
      average_flights: flights.average,
      average_arrivals: arrivals.average,
      average_departures: departures.average,
      raw_average_flights: flights.total === null ? null : flights.total / Math.max(1, completeRows.length),
      raw_average_arrivals: arrivals.total === null ? null : arrivals.total / Math.max(1, completeRows.length),
      raw_average_departures: departures.total === null ? null : departures.total / Math.max(1, completeRows.length),
      status: weekdayStatus(rows.length, completeRows.length),
    };
  }));

  const monthly = rawMonthly.map((row) => {
    const monthRows = rawMonthly.filter((candidate) => candidate.month === row.month);
    const peak = (field: 'raw_average_flights' | 'raw_average_arrivals' | 'raw_average_departures') => {
      const value = finiteNumber(row[field]);
      const maximum = Math.max(0, ...monthRows.flatMap((candidate) => {
        const candidateValue = finiteNumber(candidate[field]);
        return candidateValue === null ? [] : [candidateValue];
      }));
      return value !== null && value > 0 && value === maximum;
    };
    return {
      month: row.month,
      day_index: row.day_index,
      selected_day_count: row.selected_day_count,
      complete_day_count: row.complete_day_count,
      average_flights: row.average_flights,
      average_arrivals: row.average_arrivals,
      average_departures: row.average_departures,
      status: row.status,
      is_peak_all: peak('raw_average_flights'),
      is_peak_arrivals: peak('raw_average_arrivals'),
      is_peak_departures: peak('raw_average_departures'),
    };
  });

  return { summary, monthly };
}

function monthlyStatus(rows: TrafficAggregateRow[], flights: number | null): string {
  if (rows.length > 0 && rows.every((row) => statusOf(row) === 'future')) return 'future';
  if (flights === null) return 'missing';
  if (rows.some((row) => !COMPLETE_STATUSES.has(statusOf(row)))) return 'partial';
  return flights === 0 ? 'zero' : 'complete';
}

function monthlyPeriodStatus(month: string, rows: TrafficAggregateRow[]): 'complete' | 'partial' {
  const [yearValue, monthValue] = month.split('-').map(Number);
  const lastDay = Number.isInteger(yearValue) && Number.isInteger(monthValue)
    ? new Date(Date.UTC(yearValue, monthValue, 0)).getUTCDate()
    : 0;
  const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;
  const coversFullMonth = lastDay > 0
    && rows.length === lastDay
    && rows.at(0)?.ops_date === `${month}-01`
    && rows.at(-1)?.ops_date === monthEnd;
  const containsFutureDay = rows.some((row) => statusOf(row) === 'future');
  return coversFullMonth && !containsFutureDay ? 'complete' : 'partial';
}

export function buildV2MonthlyTimeline(timelineValue: unknown): TrafficAggregateRow[] {
  const timeline = Array.isArray(timelineValue) ? timelineValue.filter(isRecord) : [];
  const months = [...new Set(timeline.flatMap((row) => {
    const opsDate = typeof row.ops_date === 'string' ? row.ops_date : '';
    return /^\d{4}-\d{2}-\d{2}$/u.test(opsDate) ? [opsDate.slice(0, 7)] : [];
  }))].sort();

  return months.map((month) => {
    const rows = timeline.filter((row) => typeof row.ops_date === 'string' && row.ops_date.startsWith(`${month}-`));
    const completeDayCount = rows.filter((row) => COMPLETE_STATUSES.has(statusOf(row))).length;
    const partialDayCount = rows.filter((row) => statusOf(row) === 'partial').length;
    const missingDayCount = rows.filter((row) => statusOf(row) === 'missing').length;
    const sum = (field: string): number | null => {
      const values = rows.flatMap((row) => {
        const value = finiteNumber(row[field]);
        return value === null ? [] : [value];
      });
      return values.length === 0 ? null : nonNegativeInteger(values.reduce((total, value) => total + value, 0));
    };
    const flights = sum('flights');
    return {
      month,
      from: String(rows.at(0)?.ops_date ?? `${month}-01`),
      to: String(rows.at(-1)?.ops_date ?? `${month}-01`),
      selected_day_count: rows.length,
      complete_day_count: completeDayCount,
      partial_day_count: partialDayCount,
      missing_day_count: missingDayCount,
      flights,
      arrivals: sum('arrivals'),
      departures: sum('departures'),
      reported_pax: sum('reported_pax'),
      reported_legs: sum('reported_legs') ?? 0,
      due_legs: sum('due_legs') ?? 0,
      missing_due_legs: sum('missing_due_legs') ?? 0,
      true_zero_reported_legs: sum('true_zero_reported_legs') ?? 0,
      period_status: monthlyPeriodStatus(month, rows),
      status: monthlyStatus(rows, flights),
    };
  });
}

export function buildV2DimensionShare(
  rowsValue: unknown,
  dimension: 'route' | 'country' | 'airline',
  metric: 'flights' | 'reported_pax',
  limit = 10,
): TrafficAggregateRow {
  const rows = Array.isArray(rowsValue) ? rowsValue.filter(isRecord) : [];
  const valued = rows.flatMap((row) => {
    const value = finiteNumber(row[metric]);
    if (value === null || value < 0) return [];
    return [{
      key: String(row.key ?? row.label ?? ''),
      label: String(row.label ?? row.key ?? ''),
      value,
    }];
  });
  const totalValue = valued.length === 0 ? null : nonNegativeInteger(valued.reduce((sum, row) => sum + row.value, 0));
  if (totalValue === null || totalValue <= 0) {
    return { dimension, metric, limit, total_value: totalValue, top_rows: [], other: null };
  }
  const sorted = valued
    .filter((row) => row.value > 0)
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'vi'));
  const topRows = sorted.slice(0, limit).map((row) => ({ ...row, share: row.value / totalValue }));
  const topTotal = topRows.reduce((sum, row) => sum + row.value, 0);
  const otherValue = Math.max(0, totalValue - topTotal);
  return {
    dimension,
    metric,
    limit,
    total_value: totalValue,
    top_rows: topRows,
    other: otherValue > 0
      ? { label: 'Khác', value: otherValue, share: otherValue / totalValue }
      : null,
  };
}

export function enrichV2OverviewBreakdowns(bundle: TrafficAggregateRow): TrafficAggregateRow {
  const report = isRecord(bundle.report) ? bundle.report : {};
  const breakdowns = isRecord(report.breakdowns) ? report.breakdowns : {};
  const weekday = buildV2WeekdayBreakdowns(bundle.timeline);
  return {
    ...bundle,
    report: {
      ...report,
      breakdowns: {
        ...breakdowns,
        day_of_week: weekday.summary,
        day_of_week_monthly: weekday.monthly,
      },
    },
  };
}
