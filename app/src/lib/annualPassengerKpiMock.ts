import type { AnnualPassengerKpiSnapshot } from './annualPassengerKpiContract';

// Local UI testing only. Double-guarded: Next statically replaces NODE_ENV at
// build time, so production/staging builds eliminate this branch entirely even
// if app/.env.local (also read by `next build`) still carries the opt-in flag.
// Without both conditions the dashboard keeps its fail-closed error behavior.
export function mockAnnualPassengerKpiSnapshot(year: number): AnnualPassengerKpiSnapshot | null {
  if (process.env.NODE_ENV !== 'development') return null;
  if (process.env.NEXT_PUBLIC_TRAFFIC_DASHBOARD_MOCK !== '1') return null;
  return {
    contract_version: 'annual-passenger-kpi-v1',
    year,
    period_state: 'current',
    period_from: `${year}-01-01`,
    period_to: `${year}-09-07`,
    target_reported_pax: 7487168,
    kpi_updated_at: `${year}-08-31T12:31:02+00:00`,
    reported_pax: 5291010,
    arrival_reported_pax: 2614233,
    departure_reported_pax: 2676777,
    reported_legs: 30162,
    due_legs: 30318,
    pax_coverage_pct: 99.49,
    data_ready: true,
    elapsed_days: 250,
    remaining_days: 115,
    average_reported_pax_per_day: 21164,
    forecast_method: 'rolling_completed_ops_dates_30',
    forecast_window_days: 30,
    forecast_average_reported_pax_per_day: 21200,
    required_reported_pax_today: 19157,
    completion_pct: 70.66,
    forecast_reported_pax: 7740000,
    forecast_pct: 103.38,
    status: 'on_track',
    monthly: [
      { month: `${year}-01`, reported_pax: 695972, reported_legs: 4011, due_legs: 4016, pax_coverage_pct: 99.88 },
      { month: `${year}-02`, reported_pax: 644166, reported_legs: 3584, due_legs: 3586, pax_coverage_pct: 99.94 },
      { month: `${year}-03`, reported_pax: 695022, reported_legs: 3802, due_legs: 3805, pax_coverage_pct: 99.92 },
      { month: `${year}-04`, reported_pax: 616695, reported_legs: 3580, due_legs: 3583, pax_coverage_pct: 99.92 },
      { month: `${year}-05`, reported_pax: 590000, reported_legs: 3518, due_legs: 3521, pax_coverage_pct: 99.91 },
      { month: `${year}-06`, reported_pax: 580000, reported_legs: 3400, due_legs: 3410, pax_coverage_pct: 99.7 },
      { month: `${year}-07`, reported_pax: 600000, reported_legs: 3500, due_legs: 3510, pax_coverage_pct: 99.72 },
      { month: `${year}-08`, reported_pax: 610000, reported_legs: 3550, due_legs: 3560, pax_coverage_pct: 99.72 },
      { month: `${year}-09`, reported_pax: 259155, reported_legs: 1617, due_legs: 2327, pax_coverage_pct: 69.5 },
    ],
    projection: {
      projection_status: 'fresh',
      source_data_version: 16587,
      source_watermark: 51144,
      refreshed_at: `${year}-09-07T07:00:00+00:00`,
    },
  };
}
