export const ANNUAL_KPI_API_BASE = '/api/report/v1';
export const ANNUAL_KPI_VERSION_POLL_MS = 5 * 60 * 1000;

export type AnnualKpiPeriodState = 'past' | 'current' | 'future';
export type AnnualKpiStatus = 'unknown' | 'not_started' | 'not_achieved' | 'at_risk' | 'on_track' | 'ahead' | 'achieved' | 'exceeded';

export type AnnualKpiMonth = {
  month: string;
  reported_pax: number | null;
  reported_legs: number;
  due_legs: number;
  pax_coverage_pct: number | null;
};

export type AnnualKpiProjection = {
  projection_status: 'fresh' | 'stale' | 'failed' | 'empty';
  source_data_version: number | null;
  source_watermark: number | null;
  refreshed_at: string | null;
};

export type AnnualPassengerKpiSnapshot = {
  contract_version: 'annual-passenger-kpi-v1';
  year: number;
  period_state: AnnualKpiPeriodState;
  period_from: string;
  period_to: string | null;
  target_reported_pax: number | null;
  kpi_updated_at: string | null;
  reported_pax: number | null;
  arrival_reported_pax: number | null;
  departure_reported_pax: number | null;
  reported_legs: number;
  due_legs: number;
  pax_coverage_pct: number | null;
  data_ready: boolean;
  elapsed_days: number;
  remaining_days: number | null;
  average_reported_pax_per_day: number | null;
  required_reported_pax_today: number | null;
  completion_pct: number | null;
  forecast_reported_pax: number | null;
  forecast_pct: number | null;
  status: AnnualKpiStatus;
  monthly: AnnualKpiMonth[];
  projection: AnnualKpiProjection;
};

export type AnnualKpiConfig = {
  year: number;
  target_reported_pax: number;
  updated_at: string;
};

export function currentHcmYear(now = new Date()): number {
  const yearPart = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' })
    .formatToParts(now)
    .find((part) => part.type === 'year')?.value;
  return Number(yearPart ?? now.getUTCFullYear());
}

export function parseAnnualKpiYear(value: string | null | undefined): number | null {
  if (!/^\d{4}$/u.test(value ?? '')) return null;
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : null;
}

export function annualKpiSnapshotUrl(year: number): string {
  return `${ANNUAL_KPI_API_BASE}/annual-kpi?year=${year}`;
}

export function annualKpiVersionUrl(year: number): string {
  return `${ANNUAL_KPI_API_BASE}/dashboard-version?year=${year}`;
}

export function isAnnualPassengerKpiSnapshot(value: unknown): value is AnnualPassengerKpiSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<AnnualPassengerKpiSnapshot>;
  return item.contract_version === 'annual-passenger-kpi-v1'
    && Number.isInteger(item.year)
    && ['past', 'current', 'future'].includes(String(item.period_state))
    && Array.isArray(item.monthly)
    && Boolean(item.projection && typeof item.projection === 'object');
}
