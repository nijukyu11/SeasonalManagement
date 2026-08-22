import type { TrafficReportBundle, TrafficTimelinePoint } from './trafficReportContract';

type Cell = string | number | boolean | null;
export type TrafficWorkbookData = Record<string, Cell[][]>;

export function buildTrafficWorkbookData(bundle: TrafficReportBundle, timeline: TrafficTimelinePoint[]): TrafficWorkbookData {
  const filter = bundle.metadata.normalized_filter;
  const overview: Cell[][] = [
    ['BÁO CÁO SẢN LƯỢNG KHAI THÁC — AGGREGATE ONLY'],
    ['Contract', bundle.contract_version],
    ['Request hash', bundle.request_hash],
    ['Data as of', bundle.data_as_of],
    ['Từ Ops Date', filter.from],
    ['Đến Ops Date', filter.to],
    ['Loại chuyến', filter.type],
    ['Hãng bay', filter.airline.join(', ')],
    ['Đường bay', filter.route.join(', ')],
    ['Quốc gia', filter.country.join(', ')],
    ['Múi giờ', filter.tz],
    [],
    ['Chỉ số', 'Giá trị'],
    ['Tổng chuyến', bundle.kpis.current.flights],
    ['ARR', bundle.kpis.current.arrivals],
    ['DEP', bundle.kpis.current.departures],
    ['Pax đã báo cáo', bundle.kpis.current.reported_pax],
    ['Pax coverage (%)', bundle.kpis.pax_coverage.percent],
    ['Leg Pax đã báo cáo', bundle.kpis.pax_coverage.reported_legs],
    ['Leg Pax đến hạn', bundle.kpis.pax_coverage.due_legs],
  ];
  const timelineRows: Cell[][] = [
    ['Ops Date', 'Tổng chuyến', 'ARR', 'DEP', 'Pax đã báo cáo', 'Completeness', 'Trạng thái'],
    ...timeline.map((row) => [row.ops_date, row.flights, row.arrivals, row.departures, row.reported_pax, row.completeness, row.status ?? 'complete']),
  ];
  const breakdownRows: Cell[][] = [['Chiều phân tích', 'Nhóm', 'Chuyến', 'ARR', 'DEP', 'Pax đã báo cáo', 'Tỷ trọng', 'Đã ẩn']];
  for (const [dimension, rows] of Object.entries({
    'Hãng bay': bundle.breakdowns.airline,
    'Đường bay': bundle.breakdowns.route,
    'Quốc gia': bundle.breakdowns.country,
    'Nhóm tàu bay': bundle.breakdowns.aircraft_group,
  })) {
    for (const row of rows) breakdownRows.push([dimension, row.label, row.flights, row.arrivals, row.departures, row.reported_pax, row.share, row.suppressed]);
  }
  const peakHourRows: Cell[][] = [
    ['Khung giờ', 'Múi giờ', 'ARR tổng', 'DEP tổng', 'ARR TB/ngày', 'DEP TB/ngày', 'Đã ẩn'],
    ...bundle.breakdowns.peak_hour.map((row) => [
      row.hour_bucket,
      row.time_basis,
      row.arrivals,
      row.departures,
      row.arrivals == null ? null : row.arrivals / bundle.metadata.day_count,
      row.departures == null ? null : row.departures / bundle.metadata.day_count,
      row.suppressed,
    ]),
  ];
  const dayOfWeekRows: Cell[][] = [
    ['ISO DOW', 'Số ngày', 'Tổng chuyến', 'TB chuyến/ngày', 'Min', 'Max', 'ARR', 'DEP', 'Đã ẩn'],
    ...bundle.breakdowns.day_of_week.map((row) => [row.day_index, row.calendar_days, row.total_flights, row.average_flights, row.min_flights, row.max_flights, row.arrivals, row.departures, row.suppressed]),
  ];
  return {
    'Tổng quan': overview,
    'Timeline': timelineRows,
    'Cơ cấu': breakdownRows,
    '24 khung giờ': peakHourRows,
    'Thứ trong tuần': dayOfWeekRows,
  };
}

export async function downloadTrafficReportWorkbook(bundle: TrafficReportBundle, timeline: TrafficTimelinePoint[]): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.utils.book_new();
  const data = buildTrafficWorkbookData(bundle, timeline);
  for (const [sheetName, rows] of Object.entries(data)) {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!cols'] = rows[0]?.map((_, columnIndex) => ({
      wch: Math.min(42, Math.max(12, ...rows.map((row) => String(row[columnIndex] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }
  const generatedAt = new Date().toISOString().replaceAll(':', '').slice(0, 15);
  const filename = `traffic-report-aggregate-${bundle.metadata.normalized_filter.from}-${bundle.metadata.normalized_filter.to}-${generatedAt}.xlsx`;
  XLSX.writeFile(workbook, filename, { compression: true });
  return filename;
}
