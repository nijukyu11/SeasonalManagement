import type { TrafficReportBundle, TrafficTimelinePoint } from './trafficReportContract';
import { orderTrafficPeakHours } from './trafficReportOperationalHours.ts';

type Cell = string | number | boolean | null;
export type TrafficWorkbookData = Record<string, Cell[][]>;

export function buildTrafficWorkbookData(bundle: TrafficReportBundle, timeline: TrafficTimelinePoint[]): TrafficWorkbookData {
  const filter = bundle.metadata.normalized_filter;
  const overview: Cell[][] = [
    ['BÁO CÁO SẢN LƯỢNG KHAI THÁC'],
    ['Cập nhật lúc', bundle.data_as_of],
    ['Từ ngày khai thác', filter.from],
    ['Đến ngày khai thác', filter.to],
    ['Hãng hàng không', filter.airline.join(', ')],
    ['Chặng bay', filter.route.join(', ')],
    ['Quốc gia', filter.country.join(', ')],
    ['Múi giờ', filter.tz],
    [],
    ['Chỉ số', 'Giá trị'],
    ['Tổng chuyến', bundle.kpis.current.flights],
    ['Chuyến bay đến', bundle.kpis.current.arrivals],
    ['Chuyến bay đi', bundle.kpis.current.departures],
    ['Sản lượng khách - Tổng', bundle.kpis.current.reported_pax],
    ['Sản lượng khách - Chuyến bay đến', bundle.kpis.current.arrival_reported_pax ?? null],
    ['Sản lượng khách - Chuyến bay đi', bundle.kpis.current.departure_reported_pax ?? null],
  ];
  const timelineRows: Cell[][] = [
    ['Ngày khai thác', 'Tổng chuyến', 'Chuyến bay đến', 'Chuyến bay đi', 'Sản lượng khách'],
    ...timeline.map((row) => [row.ops_date, row.flights, row.arrivals, row.departures, row.reported_pax]),
  ];
  const breakdownRows: Cell[][] = [['Chiều phân tích', 'Nhóm', 'Chuyến', 'Chuyến bay đến', 'Chuyến bay đi', 'Sản lượng khách', 'Tỷ trọng chuyến']];
  for (const [dimension, rows] of Object.entries({
    'Hãng hàng không': bundle.breakdowns.airline,
    'Chặng bay': bundle.breakdowns.route,
    'Quốc gia': bundle.breakdowns.country,
    'Nhóm tàu bay': bundle.breakdowns.aircraft_group,
  })) {
    for (const row of rows) breakdownRows.push([dimension, row.label, row.flights, row.arrivals, row.departures, row.reported_pax, row.share]);
  }
  const orderedPeakHours = orderTrafficPeakHours(bundle.breakdowns.peak_hour, filter.tz);
  const peakHourRows: Cell[][] = [
    ['Khung giờ', 'Múi giờ', 'Chuyến bay đến trong kỳ', 'Chuyến bay đi trong kỳ'],
    ...orderedPeakHours.map((row) => [
      row.hour_bucket,
      row.time_basis,
      row.arrivals,
      row.departures,
    ]),
  ];
  const dayOfWeekRows: Cell[][] = [
    ['Thứ trong tuần', 'Số ngày', 'Tổng chuyến', 'TB chuyến/ngày', 'Thấp nhất', 'Cao nhất', 'Chuyến đến', 'Chuyến đi'],
    ...bundle.breakdowns.day_of_week.map((row) => [row.day_index, row.calendar_days, row.total_flights, row.average_flights == null ? null : Math.round(row.average_flights), row.min_flights, row.max_flights, row.arrivals, row.departures]),
  ];
  const monthlyPeakRows: Cell[][] = [
    ['Tháng', 'Múi giờ', 'Giờ cao điểm chuyến đến', 'Số chuyến đến', 'Giờ cao điểm chuyến đi', 'Số chuyến đi'],
    ...(bundle.breakdowns.peak_hour_monthly ?? []).map((row) => [
      row.month,
      row.time_basis,
      row.arrival_suppressed ? null : row.arrival_hour,
      row.arrival_suppressed ? null : row.arrival_flights,
      row.departure_suppressed ? null : row.departure_hour,
      row.departure_suppressed ? null : row.departure_flights,
    ]),
  ];
  return {
    'Tổng quan': overview,
    'Theo ngày': timelineRows,
    'Cơ cấu': breakdownRows,
    '24 khung giờ': peakHourRows,
    'Giờ cao điểm tháng': monthlyPeakRows,
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
  const filename = `bao-cao-san-luong-${bundle.metadata.normalized_filter.from}-${bundle.metadata.normalized_filter.to}-${generatedAt}.xlsx`;
  XLSX.writeFile(workbook, filename, { compression: true });
  return filename;
}
