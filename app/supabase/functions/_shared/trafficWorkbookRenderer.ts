import type { WorkbookDimensionRow, WorkbookMetricSet, WorkbookReportModel } from './trafficWorkbookCore.ts';

type CellValue = string | number | boolean | null;
type CellKind = 'text' | 'integer' | 'decimal' | 'percent' | 'date' | 'status';

interface ColumnSpec {
  header: string;
  key: string;
  kind?: CellKind;
  width?: number;
}

interface ChartSpec {
  title: string;
  categoryColumn: number;
  series: Array<{ name: string; column: number; color: string }>;
  maxRows?: number;
}

interface SheetSpec {
  name: string;
  title: string;
  note: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, CellValue>>;
  chart?: ChartSpec;
  table?: boolean;
}

const textEncoder = new TextEncoder();
const INTEGER_FORMAT = '#,##0';
const DECIMAL_FORMAT = '#,##0.0';
const PERCENT_FORMAT = '0.0%';
const DATE_FORMAT = 'dd/mm/yyyy';

function xml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function safeText(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+@]/u.test(text) || /^-\D/u.test(text) ? `'${text}` : text;
}

function columnName(index: number): string {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function excelDate(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000) + 25569;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

function delta(current: number | null | undefined, baseline: number | null | undefined): number | null {
  return current == null || baseline == null ? null : current - baseline;
}

function deltaPercent(current: number | null | undefined, baseline: number | null | undefined): number | null {
  return current == null || baseline == null || baseline === 0 ? null : (current - baseline) / baseline;
}

function reportDisplayName(reportType: WorkbookReportModel['metadata']['reportType']): string {
  if (reportType === 'MASTER_OPERATIONS') return 'Báo cáo tổng hợp khai thác';
  if (reportType === 'MONTHLY_OVERVIEW_L2') return 'Báo cáo khai thác tháng';
  if (reportType === 'WEEKLY_DETAIL') return 'Báo cáo tuần chi tiết';
  if (reportType === 'PERIOD_ANALYSIS') return 'Báo cáo phân tích theo kỳ';
  return 'Báo cáo sản lượng';
}

function metricRows(model: WorkbookReportModel): Array<Record<string, CellValue>> {
  const sets: Array<[string, WorkbookMetricSet | null, { from: string; to: string } | undefined]> = [
    ['Kỳ hiện tại', model.kpis.current, model.metadata],
    ['Kỳ trước', model.kpis.previous, model.metadata.comparisonPeriods.find((period) => period.mode === 'previous')],
    ['Cùng kỳ năm trước', model.kpis.yearAgo, model.metadata.comparisonPeriods.find((period) => period.mode === 'year_ago')],
  ];
  return sets.flatMap(([period, value, range]) => value == null ? [] : [{
    period,
    flights: value.flights,
    arrivals: value.arrivals,
    departures: value.departures,
    reportedPax: value.reportedPax,
    days: range ? daysBetween(range.from, range.to) : null,
    averageFlights: value.flights == null || !range ? null : value.flights / daysBetween(range.from, range.to),
  }]);
}

function dimensionRows(rows: WorkbookDimensionRow[]): Array<Record<string, CellValue>> {
  return rows.map((row) => ({
    label: row.label,
    arrivals: row.arrivals,
    departures: row.departures,
    flights: row.flights,
    reportedPax: row.reportedPax,
    flightShare: row.flightShare,
    paxShare: row.paxShare,
    reportedLegs: row.reportedLegs,
    dueLegs: row.dueLegs,
    paxCoverage: row.paxCoverage == null ? null : row.paxCoverage / 100,
    previousFlights: row.previous?.flights ?? null,
    previousDelta: delta(row.flights, row.previous?.flights),
    previousDeltaPercent: deltaPercent(row.flights, row.previous?.flights),
    yearAgoFlights: row.yearAgo?.flights ?? null,
    yearAgoDelta: delta(row.flights, row.yearAgo?.flights),
    yearAgoDeltaPercent: deltaPercent(row.flights, row.yearAgo?.flights),
    paxStatus: row.paxStatus ?? '',
  }));
}

function weeklyDimensionRows(rows: WorkbookDimensionRow[]): Array<Record<string, CellValue>> {
  return rows.map((row) => ({
    label: row.label,
    previousFlights: row.previous?.flights ?? null,
    currentFlights: row.flights,
    nextFlights: row.next?.flights ?? null,
    currentVsPrevious: delta(row.flights, row.previous?.flights),
    currentVsPreviousPercent: deltaPercent(row.flights, row.previous?.flights),
    nextVsCurrent: delta(row.next?.flights, row.flights),
    nextVsCurrentPercent: deltaPercent(row.next?.flights, row.flights),
    arrivals: row.arrivals,
    departures: row.departures,
    reportedPax: row.reportedPax,
    flightShare: row.flightShare,
    paxCoverage: row.paxCoverage == null ? null : row.paxCoverage / 100,
    paxStatus: row.paxStatus ?? '',
  }));
}

const WEEKLY_DIMENSION_COLUMNS: ColumnSpec[] = [
  { header: 'Nhóm', key: 'label', width: 26 },
  { header: 'Tuần trước', key: 'previousFlights', kind: 'integer', width: 14 },
  { header: 'Kỳ đã chọn', key: 'currentFlights', kind: 'integer', width: 15 },
  { header: 'Tuần sau', key: 'nextFlights', kind: 'integer', width: 14 },
  { header: 'Chênh kỳ chọn/tuần trước', key: 'currentVsPrevious', kind: 'integer', width: 23 },
  { header: '% kỳ chọn/tuần trước', key: 'currentVsPreviousPercent', kind: 'percent', width: 21 },
  { header: 'Chênh tuần sau/kỳ chọn', key: 'nextVsCurrent', kind: 'integer', width: 22 },
  { header: '% tuần sau/kỳ chọn', key: 'nextVsCurrentPercent', kind: 'percent', width: 20 },
  { header: 'ARR kỳ chọn', key: 'arrivals', kind: 'integer', width: 14 },
  { header: 'DEP kỳ chọn', key: 'departures', kind: 'integer', width: 14 },
  { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 },
  { header: 'Tỷ trọng chuyến', key: 'flightShare', kind: 'percent', width: 17 },
];

const DIMENSION_COLUMNS: ColumnSpec[] = [
  { header: 'Nhóm', key: 'label', width: 24 },
  { header: 'ARR', key: 'arrivals', kind: 'integer', width: 12 },
  { header: 'DEP', key: 'departures', kind: 'integer', width: 12 },
  { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 },
  { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 },
  { header: 'Tỷ trọng chuyến', key: 'flightShare', kind: 'percent', width: 17 },
  { header: 'Tỷ trọng Pax', key: 'paxShare', kind: 'percent', width: 15 },
  { header: 'Kỳ trước', key: 'previousFlights', kind: 'integer', width: 14 },
  { header: 'Chênh kỳ trước', key: 'previousDelta', kind: 'integer', width: 16 },
  { header: '% kỳ trước', key: 'previousDeltaPercent', kind: 'percent', width: 15 },
  { header: 'Cùng kỳ năm trước', key: 'yearAgoFlights', kind: 'integer', width: 19 },
  { header: 'Chênh cùng kỳ', key: 'yearAgoDelta', kind: 'integer', width: 16 },
  { header: '% cùng kỳ', key: 'yearAgoDeltaPercent', kind: 'percent', width: 15 },
];

function guideRows(model: WorkbookReportModel): Array<Record<string, CellValue>> {
  return [
    { item: 'Phạm vi', detail: `${model.metadata.from}–${model.metadata.to}` },
    { item: 'Pax', detail: 'Ô trống nghĩa là chưa có số liệu hành khách.' },
    { item: 'Tuần lịch', detail: 'Thứ Hai–Chủ Nhật.' },
    { item: 'Tuần nghiệp vụ', detail: 'Thứ Sáu–Thứ Năm.' },
    { item: 'So sánh', detail: 'Các cột chênh lệch được tính so với kỳ ghi trên tiêu đề cột.' },
  ];
}

function businessInfoRows(model: WorkbookReportModel): Array<Record<string, CellValue>> {
  const metadata: Array<[string, CellValue]> = [
    ['Tên báo cáo', reportDisplayName(model.metadata.reportType)],
    ['Từ ngày', model.metadata.from],
    ['Đến ngày', model.metadata.to],
    ['Mùa', model.metadata.seasonCode],
    ['Tháng', model.metadata.month],
    ['Từ tháng', model.metadata.monthFrom],
    ['Đến tháng', model.metadata.monthTo],
    ['Năm', model.metadata.year],
    ['Ngày tạo', model.metadata.generatedAt.slice(0, 10)],
  ];
  for (const comparison of model.metadata.comparisonPeriods) metadata.push(['Kỳ so sánh', `${comparison.from}–${comparison.to}`]);
  for (const context of model.metadata.contextPeriods) metadata.push(['Kỳ liền kề', `${context.from}–${context.to}`]);
  return metadata.filter(([, value]) => value != null && value !== '').map(([field, value]) => ({ field, value }));
}

function commonPeriodColumns(): ColumnSpec[] {
  return [
    { header: 'Kỳ', key: 'key', width: 18 }, { header: 'Từ ngày', key: 'from', kind: 'date', width: 14 }, { header: 'Đến ngày', key: 'to', kind: 'date', width: 14 },
    { header: 'Số ngày', key: 'calendarDays', kind: 'integer', width: 12 }, { header: 'ARR', key: 'arrivals', kind: 'integer', width: 12 }, { header: 'DEP', key: 'departures', kind: 'integer', width: 12 },
    { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 },
    { header: 'TB chuyến/ngày', key: 'averageFlights', kind: 'decimal', width: 18 },
  ];
}

function masterSheets(model: WorkbookReportModel): SheetSpec[] {
  const timelineRows = model.timelineDaily.map((row) => ({
    opsDate: row.opsDate, weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${row.opsDate}T00:00:00Z`)),
    arrivals: row.arrivals, departures: row.departures, flights: row.flights, reportedPax: row.reportedPax,
    reportedLegs: row.reportedLegs, dueLegs: row.dueLegs, paxCoverage: row.paxCoverage == null ? null : row.paxCoverage / 100,
    completeness: row.completeness, paxStatus: row.paxStatus,
  }));
  const weekRows = [
    ...model.timelineIsoWeek.map((row) => ({ standard: 'ISO (Thứ Hai–Chủ Nhật)', ...row })),
    ...model.timelineBusinessWeek.map((row) => ({ standard: 'Nghiệp vụ (Thứ Sáu–Thứ Năm)', ...row })),
  ];
  return [
    { name: 'Hướng dẫn', title: 'HƯỚNG DẪN ĐỌC BÁO CÁO', note: 'Các sheet trình bày sản lượng chuyến bay và hành khách theo kỳ đã chọn.', columns: [{ header: 'Nội dung', key: 'item', width: 24 }, { header: 'Giải thích', key: 'detail', width: 92 }], rows: guideRows(model) },
    { name: 'Thông tin báo cáo', title: 'THÔNG TIN BÁO CÁO', note: 'Phạm vi và các kỳ được sử dụng trong báo cáo.', columns: [{ header: 'Nội dung', key: 'field', width: 28 }, { header: 'Giá trị', key: 'value', width: 92 }], rows: businessInfoRows(model) },
    { name: 'Tổng quan', title: 'TỔNG QUAN KHAI THÁC', note: 'Ô Pax để trống khi chưa có số liệu hành khách.', columns: [{ header: 'Kỳ', key: 'period', width: 22 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 15 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'TB chuyến/ngày', key: 'averageFlights', kind: 'decimal', width: 18 }], rows: metricRows(model), table: true },
    { name: 'Theo ngày', title: 'SẢN LƯỢNG THEO NGÀY KHAI THÁC', note: 'Ô Pax để trống khi chưa có số liệu hành khách.', columns: [{ header: 'Ngày khai thác', key: 'opsDate', kind: 'date', width: 16 }, { header: 'Thứ', key: 'weekday', width: 18 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }], rows: timelineRows, table: true },
    { name: 'Theo tháng', title: 'SẢN LƯỢNG THEO THÁNG', note: 'Bình quân được tính theo số ngày trong từng kỳ.', columns: commonPeriodColumns(), rows: model.timelineMonthly.map((row) => ({ ...row })), table: true },
    { name: 'Theo tuần', title: 'SẢN LƯỢNG THEO TUẦN', note: 'Báo cáo trình bày riêng tuần lịch và tuần nghiệp vụ.', columns: [{ header: 'Loại tuần', key: 'standard', width: 32 }, ...commonPeriodColumns()], rows: weekRows, table: true },
    { name: 'Hãng hàng không', title: 'PHÂN TÍCH HÃNG HÀNG KHÔNG', note: 'So sánh kỳ hiện tại với kỳ trước và cùng kỳ năm trước.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.airlines), table: true },
    { name: 'Thị trường', title: 'PHÂN TÍCH THỊ TRƯỜNG', note: 'Các chuyến chưa xác định quốc gia được giữ thành một nhóm riêng.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.countries), table: true },
    { name: 'Chặng bay', title: 'PHÂN TÍCH CHẶNG BAY', note: 'Sản lượng được tổng hợp theo từng chặng bay.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.routes), table: true },
    { name: 'Giờ khai thác', title: '24 KHUNG GIỜ KHAI THÁC', note: 'Số chuyến theo từng khung giờ và bình quân mỗi ngày.', columns: [{ header: 'Khung giờ', key: 'hour', width: 14 }, { header: 'ARR trong kỳ', key: 'arrivals', kind: 'integer', width: 16 }, { header: 'DEP trong kỳ', key: 'departures', kind: 'integer', width: 16 }, { header: 'TB ARR/ngày', key: 'averageArrivals', kind: 'decimal', width: 16 }, { header: 'TB DEP/ngày', key: 'averageDepartures', kind: 'decimal', width: 16 }], rows: model.peakHours, table: true },
    { name: 'Tần suất', title: 'TẦN SUẤT CHUYẾN BAY THƯỜNG LỆ', note: 'Tổng hợp các chuyến xuất hiện thường xuyên trong kỳ báo cáo.', columns: [{ header: 'A/D', key: 'direction', width: 10 }, { header: 'Hãng', key: 'airline', width: 14 }, { header: 'Số hiệu', key: 'flightNumber', width: 14 }, { header: 'Chặng', key: 'route', width: 16 }, { header: 'Giờ điển hình', key: 'typicalTime', width: 16 }, { header: 'Ngày khai thác', key: 'operatingDays', width: 20 }, { header: 'Ngày xuất hiện', key: 'occurrenceDays', kind: 'integer', width: 16 }, { header: 'Ngày đủ điều kiện', key: 'eligibleDays', kind: 'integer', width: 18 }, { header: 'Độ nhất quán', key: 'consistency', kind: 'percent', width: 16 }], rows: model.frequency.map((row) => ({ ...row, consistency: typeof row.consistency === 'number' ? row.consistency / 100 : null })), table: true },
    { name: 'Tàu bay', title: 'CƠ CẤU TÀU BAY', note: 'Sản lượng được tổng hợp theo nhóm và loại tàu bay.', columns: [{ header: 'Cấp', key: 'level', width: 18 }, { header: 'Nhóm tàu bay', key: 'group', width: 20 }, { header: 'Loại tàu bay', key: 'type', width: 20 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'Tỷ trọng', key: 'share', kind: 'percent', width: 14 }], rows: model.aircraft, table: true },
  ];
}

function monthlySheets(model: WorkbookReportModel): SheetSpec[] {
  const summaryRows: Array<Record<string, CellValue>> = [
    { metric: 'Tổng chuyến', current: model.kpis.current.flights, previous: model.kpis.previous?.flights ?? null, yearAgo: model.kpis.yearAgo?.flights ?? null, mom: deltaPercent(model.kpis.current.flights, model.kpis.previous?.flights), yoy: deltaPercent(model.kpis.current.flights, model.kpis.yearAgo?.flights) },
    { metric: 'ARR', current: model.kpis.current.arrivals, previous: model.kpis.previous?.arrivals ?? null, yearAgo: model.kpis.yearAgo?.arrivals ?? null, mom: deltaPercent(model.kpis.current.arrivals, model.kpis.previous?.arrivals), yoy: deltaPercent(model.kpis.current.arrivals, model.kpis.yearAgo?.arrivals) },
    { metric: 'DEP', current: model.kpis.current.departures, previous: model.kpis.previous?.departures ?? null, yearAgo: model.kpis.yearAgo?.departures ?? null, mom: deltaPercent(model.kpis.current.departures, model.kpis.previous?.departures), yoy: deltaPercent(model.kpis.current.departures, model.kpis.yearAgo?.departures) },
    { metric: 'Pax đã báo cáo', current: model.kpis.current.reportedPax, previous: model.kpis.previous?.reportedPax ?? null, yearAgo: model.kpis.yearAgo?.reportedPax ?? null, mom: deltaPercent(model.kpis.current.reportedPax, model.kpis.previous?.reportedPax), yoy: deltaPercent(model.kpis.current.reportedPax, model.kpis.yearAgo?.reportedPax) },
  ];
  const productionRows = metricRows(model);
  const peakDays = [...model.timelineDaily].filter((row) => row.flights != null).sort((left, right) => (right.flights ?? 0) - (left.flights ?? 0)).slice(0, 10).map((row) => ({
    opsDate: row.opsDate, weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${row.opsDate}T00:00:00Z`)),
    arrivals: row.arrivals, departures: row.departures, flights: row.flights,
    versusAverage: model.kpis.current.flights == null ? null : row.flights! - model.kpis.current.flights / daysBetween(model.metadata.from, model.metadata.to),
  }));
  const peakHours = [...model.peakHours].sort((left, right) => Math.max(right.averageArrivals ?? 0, right.averageDepartures ?? 0) - Math.max(left.averageArrivals ?? 0, left.averageDepartures ?? 0));
  const annotationRows = model.annotations.map((row) => ({ ...row }));
  return [
    { name: 'Tóm tắt tháng', title: `TÓM TẮT KHAI THÁC THÁNG ${model.metadata.month ?? ''}`, note: 'So sánh với tháng trước và cùng kỳ năm trước.', columns: [{ header: 'Chỉ số', key: 'metric', width: 26 }, { header: 'Hiện tại', key: 'current', kind: 'integer', width: 16 }, { header: 'Tháng trước', key: 'previous', kind: 'integer', width: 16 }, { header: 'Cùng kỳ năm trước', key: 'yearAgo', kind: 'integer', width: 19 }, { header: '% so tháng trước', key: 'mom', kind: 'percent', width: 18 }, { header: '% so cùng kỳ', key: 'yoy', kind: 'percent', width: 16 }], rows: summaryRows, table: true },
    { name: 'Sản lượng chuyến bay', title: 'SẢN LƯỢNG CHUYẾN BAY THEO KỲ', note: 'Mỗi kỳ được tính theo đúng phạm vi ngày hiển thị.', columns: [{ header: 'Kỳ', key: 'period', width: 22 }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 15 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'Số ngày', key: 'days', kind: 'integer' }, { header: 'TB chuyến/ngày', key: 'averageFlights', kind: 'decimal', width: 18 }], rows: productionRows, table: true, chart: { title: 'So sánh sản lượng chuyến bay theo kỳ', categoryColumn: 0, series: [{ name: 'Tổng chuyến', column: 1, color: '1D4ED8' }, { name: 'ARR', column: 2, color: '0891B2' }, { name: 'DEP', column: 3, color: 'F59E0B' }] } },
    { name: 'Ngày cao điểm', title: 'NGÀY CAO ĐIỂM', note: 'Xếp hạng theo tổng chuyến; chênh lệch dùng bình quân ngày trong tháng.', columns: [{ header: 'Ops Date', key: 'opsDate', kind: 'date', width: 14 }, { header: 'Thứ', key: 'weekday', width: 18 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Chênh TB tháng', key: 'versusAverage', kind: 'decimal', width: 18 }], rows: peakDays, table: true },
    { name: 'Giờ cao điểm', title: 'GIỜ CAO ĐIỂM', note: 'Các khung giờ được xếp theo sản lượng bình quân mỗi ngày.', columns: [{ header: 'Khung giờ', key: 'hour', width: 14 }, { header: 'ARR trong kỳ', key: 'arrivals', kind: 'integer', width: 16 }, { header: 'DEP trong kỳ', key: 'departures', kind: 'integer', width: 16 }, { header: 'TB ARR/ngày', key: 'averageArrivals', kind: 'decimal', width: 16 }, { header: 'TB DEP/ngày', key: 'averageDepartures', kind: 'decimal', width: 16 }], rows: peakHours, table: true },
    { name: 'Chuyến bay sớm', title: 'CHUYẾN BAY KHAI THÁC SỚM', note: 'Chỉ hiển thị khi có dữ liệu nghiệp vụ được xác nhận.', columns: [{ header: 'Nội dung', key: 'status', width: 44 }, { header: 'Ghi chú', key: 'missing', width: 72 }], rows: [{ status: 'Chưa có dữ liệu được xác nhận', missing: 'Chưa có thông tin để lập danh sách chuyến bay khai thác sớm.' }] },
    { name: 'Hãng hàng không', title: 'HÃNG HÀNG KHÔNG', note: 'So sánh sản lượng theo từng hãng.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.airlines), table: true },
    { name: 'Thị trường', title: 'THỊ TRƯỜNG VÀ THỊ PHẦN', note: 'Các chuyến chưa xác định quốc gia được giữ thành một nhóm riêng.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.countries), table: true, chart: { title: 'Thị phần chuyến bay hiện tại và cùng kỳ năm trước', categoryColumn: 0, series: [{ name: 'Hiện tại', column: 3, color: '1D4ED8' }, { name: 'Cùng kỳ năm trước', column: 10, color: '94A3B8' }], maxRows: 12 } },
    { name: 'Chặng bay', title: 'CHẶNG BAY', note: 'So sánh sản lượng theo từng chặng bay.', columns: DIMENSION_COLUMNS, rows: dimensionRows(model.routes), table: true },
    { name: 'Ghi chú nghiệp vụ', title: 'GHI CHÚ NGHIỆP VỤ', note: 'Các ghi chú đã được xác nhận cho kỳ báo cáo.', columns: [{ header: 'Loại sự kiện', key: 'eventType', width: 20 }, { header: 'Hãng', key: 'airline', width: 16 }, { header: 'Chặng', key: 'route', width: 16 }, { header: 'Giai đoạn', key: 'period', width: 20 }, { header: 'Tần suất', key: 'frequency', width: 16 }, { header: 'Nguồn xác nhận', key: 'confirmedSource', width: 28 }, { header: 'Người duyệt', key: 'reviewer', width: 20 }, { header: 'Trạng thái', key: 'status', kind: 'status', width: 42 }], rows: annotationRows, table: true },
  ];
}

function weeklySheets(model: WorkbookReportModel): SheetSpec[] {
  const periodLabels = { previous: 'Tuần trước', selected: 'Kỳ đã chọn', next: 'Tuần sau' } as const;
  const contextByMode = new Map(model.metadata.contextPeriods.map((period) => [period.mode, period]));
  const metricsByMode = {
    previous: model.kpis.previous,
    selected: model.kpis.current,
    next: model.kpis.next,
  } as const;
  const periodRows = (['previous', 'selected', 'next'] as const).map((mode) => {
    const period = contextByMode.get(mode)!;
    const metrics = metricsByMode[mode];
    const days = daysBetween(period.from, period.to);
    return {
      period: periodLabels[mode], from: period.from, to: period.to, days,
      arrivals: metrics?.arrivals ?? null, departures: metrics?.departures ?? null, flights: metrics?.flights ?? null,
      reportedPax: metrics?.reportedPax ?? null,
      averageFlights: metrics?.flights == null ? null : metrics.flights / days,
    };
  });
  const summaryMetrics: Array<[string, number | null, number | null, number | null]> = [
    ['Tổng chuyến', model.kpis.previous?.flights ?? null, model.kpis.current.flights, model.kpis.next?.flights ?? null],
    ['ARR', model.kpis.previous?.arrivals ?? null, model.kpis.current.arrivals, model.kpis.next?.arrivals ?? null],
    ['DEP', model.kpis.previous?.departures ?? null, model.kpis.current.departures, model.kpis.next?.departures ?? null],
    ['Pax đã báo cáo', model.kpis.previous?.reportedPax ?? null, model.kpis.current.reportedPax, model.kpis.next?.reportedPax ?? null],
  ];
  const summaryRows = summaryMetrics.map(([metric, previous, current, next]) => ({
    metric, previous, current, next,
    currentVsPrevious: delta(current, previous),
    currentVsPreviousPercent: deltaPercent(current, previous),
    nextVsCurrent: delta(next, current),
    nextVsCurrentPercent: deltaPercent(next, current),
  }));
  const timelineRows = model.timelineDaily.map((row) => ({
    context: row.contextPeriod ? periodLabels[row.contextPeriod] : '',
    opsDate: row.opsDate,
    weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${row.opsDate}T00:00:00Z`)),
    arrivals: row.arrivals, departures: row.departures, flights: row.flights, reportedPax: row.reportedPax,
    reportedLegs: row.reportedLegs, dueLegs: row.dueLegs, paxCoverage: row.paxCoverage == null ? null : row.paxCoverage / 100,
    completeness: row.completeness, paxStatus: row.paxStatus,
  }));
  const aircraftRowsFor = (level: string) => model.aircraft.filter((row) => row.level === level).map((row) => ({
    group: row.group, type: row.type, previousFlights: row.previousFlights, currentFlights: row.flights, nextFlights: row.nextFlights,
    currentVsPrevious: row.previousDelta, nextVsCurrent: row.nextDelta,
    arrivals: row.arrivals, departures: row.departures, reportedPax: row.reportedPax, flightShare: row.share,
  }));
  const aircraftColumns: ColumnSpec[] = [
    { header: 'Nhóm tàu bay', key: 'group', width: 22 }, { header: 'Loại tàu bay', key: 'type', width: 20 },
    { header: 'Tuần trước', key: 'previousFlights', kind: 'integer', width: 14 }, { header: 'Kỳ đã chọn', key: 'currentFlights', kind: 'integer', width: 15 }, { header: 'Tuần sau', key: 'nextFlights', kind: 'integer', width: 14 },
    { header: 'Chênh kỳ chọn/tuần trước', key: 'currentVsPrevious', kind: 'integer', width: 23 }, { header: 'Chênh tuần sau/kỳ chọn', key: 'nextVsCurrent', kind: 'integer', width: 22 },
    { header: 'ARR kỳ chọn', key: 'arrivals', kind: 'integer', width: 14 }, { header: 'DEP kỳ chọn', key: 'departures', kind: 'integer', width: 14 },
    { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'Tỷ trọng chuyến', key: 'flightShare', kind: 'percent', width: 17 },
  ];
  return [
    { name: 'Tổng quan', title: 'BÁO CÁO TUẦN CHI TIẾT', note: `Kỳ đã chọn ${model.metadata.from}–${model.metadata.to}, kèm 7 ngày trước và 7 ngày sau.`, columns: [{ header: 'Chỉ số', key: 'metric', width: 24 }, { header: 'Tuần trước', key: 'previous', kind: 'integer', width: 15 }, { header: 'Kỳ đã chọn', key: 'current', kind: 'integer', width: 15 }, { header: 'Tuần sau', key: 'next', kind: 'integer', width: 15 }, { header: 'Chênh kỳ chọn/tuần trước', key: 'currentVsPrevious', kind: 'integer', width: 23 }, { header: '% kỳ chọn/tuần trước', key: 'currentVsPreviousPercent', kind: 'percent', width: 21 }, { header: 'Chênh tuần sau/kỳ chọn', key: 'nextVsCurrent', kind: 'integer', width: 22 }, { header: '% tuần sau/kỳ chọn', key: 'nextVsCurrentPercent', kind: 'percent', width: 20 }], rows: summaryRows, table: true },
    { name: 'Theo ngày', title: 'CHI TIẾT THEO NGÀY KHAI THÁC', note: 'Ô Pax để trống khi chưa có số liệu hành khách.', columns: [{ header: 'Giai đoạn', key: 'context', width: 16 }, { header: 'Ngày khai thác', key: 'opsDate', kind: 'date', width: 16 }, { header: 'Thứ', key: 'weekday', width: 18 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }], rows: timelineRows, table: true },
    { name: 'Theo tuần', title: 'SO SÁNH BA GIAI ĐOẠN', note: 'Tuần trước và tuần sau là hai khoảng 7 ngày liền kề kỳ đã chọn.', columns: [{ header: 'Giai đoạn', key: 'period', width: 18 }, { header: 'Từ ngày', key: 'from', kind: 'date', width: 14 }, { header: 'Đến ngày', key: 'to', kind: 'date', width: 14 }, { header: 'Số ngày', key: 'days', kind: 'integer', width: 12 }, { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'TB chuyến/ngày', key: 'averageFlights', kind: 'decimal', width: 18 }], rows: periodRows, table: true },
    { name: 'Chi tiết Airline', title: 'CHI TIẾT THEO AIRLINE', note: 'So sánh theo hãng giữa tuần trước, kỳ đã chọn và tuần sau.', columns: WEEKLY_DIMENSION_COLUMNS, rows: weeklyDimensionRows(model.airlines), table: true },
    { name: 'Chi tiết Country', title: 'CHI TIẾT THEO COUNTRY', note: 'Các chuyến chưa xác định quốc gia được giữ thành một nhóm riêng.', columns: WEEKLY_DIMENSION_COLUMNS, rows: weeklyDimensionRows(model.countries), table: true },
    { name: 'Chi tiết Route', title: 'CHI TIẾT THEO ROUTE', note: 'So sánh sản lượng theo từng chặng bay.', columns: WEEKLY_DIMENSION_COLUMNS, rows: weeklyDimensionRows(model.routes), table: true },
    { name: 'AC Group', title: 'CHI TIẾT THEO AIRCRAFT GROUP', note: 'So sánh sản lượng theo nhóm tàu bay.', columns: aircraftColumns, rows: aircraftRowsFor('Nhóm tàu bay'), table: true },
    { name: 'AC Type', title: 'CHI TIẾT THEO AIRCRAFT TYPE', note: 'Loại tàu bay được đối chiếu qua ba giai đoạn; giá trị thiếu được để trống.', columns: aircraftColumns, rows: aircraftRowsFor('Loại tàu bay'), table: true },
  ];
}

const PERIOD_DIMENSION_COLUMNS: ColumnSpec[] = [
  { header: 'Kỳ', key: 'period', width: 20 },
  { header: 'Năm so sánh', key: 'comparisonYear', kind: 'integer', width: 16 },
  { header: 'Từ ngày', key: 'from', kind: 'date', width: 14 }, { header: 'Đến ngày', key: 'to', kind: 'date', width: 14 },
  { header: 'Nhóm', key: 'label', width: 28 },
  { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' },
  { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 }, { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 },
  { header: 'Tỷ trọng chuyến', key: 'flightShare', kind: 'percent', width: 17 }, { header: 'Tỷ trọng Pax', key: 'paxShare', kind: 'percent', width: 15 },
  { header: 'Chênh với hiện tại', key: 'delta', kind: 'integer', width: 18 }, { header: '% so với hiện tại', key: 'deltaPercent', kind: 'percent', width: 18 },
];

function periodDimensionRows(model: WorkbookReportModel, dimension: 'airlines' | 'countries' | 'routes'): Array<Record<string, CellValue>> {
  const current = model.periods[0];
  const allKeys = [...new Set(model.periods.flatMap((period) => period[dimension].map((row) => row.key)))];
  const currentMap = new Map(current[dimension].map((row) => [row.key, row]));
  return model.periods.flatMap((period) => {
    const rows = new Map(period[dimension].map((row) => [row.key, row]));
    return allKeys.map((key) => {
      const row = rows.get(key);
      const baseline = currentMap.get(key);
      const complete = period.metrics.status === 'complete';
      const flights = row?.flights ?? (complete ? 0 : null);
      const baselineFlights = baseline?.flights ?? (current.metrics.status === 'complete' ? 0 : null);
      return {
        periodId: period.id, period: period.label, comparisonYear: period.comparisonYear,
        from: period.from, to: period.to, dimensionKey: key, label: row?.label ?? baseline?.label ?? key,
        arrivals: row?.arrivals ?? (complete ? 0 : null), departures: row?.departures ?? (complete ? 0 : null), flights,
        reportedPax: row?.reportedPax ?? null, flightShare: row?.flightShare ?? (complete ? 0 : null), paxShare: row?.paxShare ?? null,
        reportedLegs: row?.reportedLegs ?? (complete ? 0 : null), dueLegs: row?.dueLegs ?? (complete ? 0 : null),
        paxCoverage: row?.paxCoverage == null ? null : row.paxCoverage / 100, paxStatus: row?.paxStatus ?? '',
        delta: period.role === 'current' ? null : delta(flights, baselineFlights),
        deltaPercent: period.role === 'current' ? null : deltaPercent(flights, baselineFlights),
      };
    });
  });
}

function periodAircraftRows(model: WorkbookReportModel, dimension: 'aircraftGroups' | 'aircraftTypes'): Array<Record<string, CellValue>> {
  const keyOf = (row: Record<string, string | number | boolean | null>) => dimension === 'aircraftGroups'
    ? String(row.group ?? '')
    : `${String(row.group ?? '')}|${String(row.type ?? '')}`;
  const current = model.periods[0];
  const currentMap = new Map(current[dimension].map((row) => [keyOf(row), row]));
  const keys = [...new Set(model.periods.flatMap((period) => period[dimension].map(keyOf)))];
  return model.periods.flatMap((period) => {
    const rows = new Map(period[dimension].map((row) => [keyOf(row), row]));
    return keys.map((key) => {
      const row = rows.get(key);
      const baseline = currentMap.get(key);
      const complete = period.metrics.status === 'complete';
      const flights = typeof row?.flights === 'number' ? row.flights : complete ? 0 : null;
      const baselineFlights = typeof baseline?.flights === 'number' ? baseline.flights : current.metrics.status === 'complete' ? 0 : null;
      return {
        periodId: period.id, period: period.label, comparisonYear: period.comparisonYear, from: period.from, to: period.to,
        dimensionKey: key, label: dimension === 'aircraftGroups' ? String(row?.group ?? baseline?.group ?? key) : String(row?.type ?? baseline?.type ?? key),
        arrivals: typeof row?.arrivals === 'number' ? row.arrivals : complete ? 0 : null,
        departures: typeof row?.departures === 'number' ? row.departures : complete ? 0 : null,
        flights, reportedPax: typeof row?.reportedPax === 'number' ? row.reportedPax : null,
        flightShare: typeof row?.share === 'number' ? row.share : complete ? 0 : null,
        paxShare: null, reportedLegs: null, dueLegs: null, paxCoverage: null, paxStatus: '',
        delta: period.role === 'current' ? null : delta(flights, baselineFlights),
        deltaPercent: period.role === 'current' ? null : deltaPercent(flights, baselineFlights),
      };
    });
  });
}

function periodAnalysisSheets(model: WorkbookReportModel): SheetSpec[] {
  const current = model.periods[0];
  const summaryRows = model.periods.map((period) => ({
    role: period.role === 'current' ? 'Hiện tại' : 'So sánh', period: period.label, comparisonYear: period.comparisonYear,
    from: period.from, to: period.to, days: period.calendarDays,
    arrivals: period.metrics.arrivals, departures: period.metrics.departures, flights: period.metrics.flights,
    reportedPax: period.metrics.reportedPax,
    averageFlights: period.metrics.flights == null ? null : period.metrics.flights / period.calendarDays,
    delta: period.role === 'current' ? null : delta(period.metrics.flights, current.metrics.flights),
    deltaPercent: period.role === 'current' ? null : deltaPercent(period.metrics.flights, current.metrics.flights),
  }));
  const timelineRows = model.periods.flatMap((period) => period.timelineDaily.map((row) => ({
    periodId: period.id, period: period.label, comparisonYear: period.comparisonYear, opsDate: row.opsDate,
    weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${row.opsDate}T00:00:00Z`)),
    dayNumber: Math.round((Date.parse(row.opsDate) - Date.parse(period.from)) / 86_400_000) + 1,
    arrivals: row.arrivals, departures: row.departures, flights: row.flights, reportedPax: row.reportedPax,
    reportedLegs: row.reportedLegs, dueLegs: row.dueLegs, paxCoverage: row.paxCoverage == null ? null : row.paxCoverage / 100,
    completeness: row.completeness, paxStatus: row.paxStatus,
  })));
  return [
    { name: 'Tổng quan', title: 'PHÂN TÍCH THEO KỲ', note: 'Mỗi kỳ được tính theo đúng phạm vi ngày hiển thị và so sánh với kỳ hiện tại.', columns: [
      { header: 'Loại kỳ', key: 'role', width: 14 }, { header: 'Kỳ', key: 'period', width: 20 }, { header: 'Năm so sánh', key: 'comparisonYear', kind: 'integer', width: 16 },
      { header: 'Từ ngày', key: 'from', kind: 'date', width: 14 }, { header: 'Đến ngày', key: 'to', kind: 'date', width: 14 }, { header: 'Số ngày', key: 'days', kind: 'integer', width: 12 },
      { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 },
      { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 }, { header: 'TB chuyến/ngày', key: 'averageFlights', kind: 'decimal', width: 18 },
      { header: 'Chênh với hiện tại', key: 'delta', kind: 'integer', width: 18 }, { header: '% so với hiện tại', key: 'deltaPercent', kind: 'percent', width: 18 },
    ], rows: summaryRows, table: true },
    { name: 'Theo thời gian', title: 'CHI TIẾT THEO NGÀY VÀ KỲ', note: 'Mỗi ngày được trình bày trong đúng kỳ tương ứng.', columns: [
      { header: 'Kỳ', key: 'period', width: 20 }, { header: 'Năm so sánh', key: 'comparisonYear', kind: 'integer', width: 16 },
      { header: 'Ngày khai thác', key: 'opsDate', kind: 'date', width: 16 }, { header: 'Thứ', key: 'weekday', width: 18 }, { header: 'Ngày thứ N', key: 'dayNumber', kind: 'integer', width: 13 },
      { header: 'ARR', key: 'arrivals', kind: 'integer' }, { header: 'DEP', key: 'departures', kind: 'integer' }, { header: 'Tổng chuyến', key: 'flights', kind: 'integer', width: 14 },
      { header: 'Pax đã báo cáo', key: 'reportedPax', kind: 'integer', width: 18 },
    ], rows: timelineRows, table: true },
    { name: 'Chi tiết Airline', title: 'CHI TIẾT THEO AIRLINE', note: 'So sánh sản lượng theo từng hãng giữa các kỳ.', columns: PERIOD_DIMENSION_COLUMNS, rows: periodDimensionRows(model, 'airlines'), table: true },
    { name: 'Chi tiết Country', title: 'CHI TIẾT THEO COUNTRY', note: 'Các chuyến chưa xác định quốc gia được giữ thành một nhóm riêng.', columns: PERIOD_DIMENSION_COLUMNS, rows: periodDimensionRows(model, 'countries'), table: true },
    { name: 'Chi tiết Route', title: 'CHI TIẾT THEO ROUTE', note: 'So sánh sản lượng theo từng chặng bay giữa các kỳ.', columns: PERIOD_DIMENSION_COLUMNS, rows: periodDimensionRows(model, 'routes'), table: true },
    { name: 'AC Group', title: 'CHI TIẾT THEO AIRCRAFT GROUP', note: 'Không suy diễn cấu hình ghế.', columns: PERIOD_DIMENSION_COLUMNS, rows: periodAircraftRows(model, 'aircraftGroups'), table: true },
    { name: 'AC Type', title: 'CHI TIẾT THEO AIRCRAFT TYPE', note: 'Giá trị chưa có được để trống.', columns: PERIOD_DIMENSION_COLUMNS, rows: periodAircraftRows(model, 'aircraftTypes'), table: true },
  ];
}

function baoCaoSanLuongSheets(model: WorkbookReportModel): SheetSpec[] {
  const dailyRows = model.timelineDaily.map((row) => ({
    month: row.opsDate.slice(0, 7), opsDate: row.opsDate,
    weekday: new Intl.DateTimeFormat('vi-VN', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${row.opsDate}T00:00:00Z`)),
    arrivals: row.arrivals, departures: row.departures, flights: row.flights,
    arrivalPax: row.arrivalReportedPax ?? null, departurePax: row.departureReportedPax ?? null, reportedPax: row.reportedPax,
    coverage: row.paxCoverage == null ? null : row.paxCoverage / 100, completeness: row.completeness,
  }));
  const dailyColumns: ColumnSpec[] = [
    { header: 'Month', key: 'month', width: 12 }, { header: 'Ops Date', key: 'opsDate', kind: 'date', width: 14 }, { header: 'Day', key: 'weekday', width: 12 },
    { header: 'Flight ARR', key: 'arrivals', kind: 'integer', width: 14 }, { header: 'Flight DEP', key: 'departures', kind: 'integer', width: 14 }, { header: 'Total Flight', key: 'flights', kind: 'integer', width: 14 },
    { header: 'Pax ARR', key: 'arrivalPax', kind: 'integer', width: 14 }, { header: 'Pax DEP', key: 'departurePax', kind: 'integer', width: 14 }, { header: 'Total Pax', key: 'reportedPax', kind: 'integer', width: 14 },
  ];
  const weeklyRows = model.timelineBusinessWeek.map((row) => ({
    ...row,
    completeness: row.from < model.metadata.from || row.to > model.metadata.to ? 'partial' : row.completeness,
  }));
  const analysisColumns: ColumnSpec[] = [
    { header: 'Tuần trước', key: 'previousPeriod', width: 24 }, { header: 'Tuần này', key: 'currentPeriod', width: 24 },
    { header: 'Nhóm', key: 'label', width: 28 }, { header: 'Sản lượng tuần trước', key: 'previousFlights', kind: 'integer', width: 21 },
    { header: 'Sản lượng tuần này', key: 'currentFlights', kind: 'integer', width: 20 }, { header: 'Chênh lệch', key: 'difference', kind: 'integer', width: 14 },
    { header: '% chênh lệch', key: 'differencePercent', kind: 'percent', width: 16 }, { header: 'Đóng góp (%)', key: 'contribution', kind: 'percent', width: 15 },
  ];
  const analysisRows = (dimension: 'airlines' | 'countries') => model.businessWeekDimensions.slice(1).flatMap((currentPeriod, index) => {
    const previousPeriod = model.businessWeekDimensions[index];
    const previous = new Map(previousPeriod[dimension].map((row) => [row.key, row]));
    const current = new Map(currentPeriod[dimension].map((row) => [row.key, row]));
    const keys = [...new Set([...previous.keys(), ...current.keys()])];
    const currentTotal = currentPeriod[dimension].reduce((sum, row) => sum + (row.flights ?? 0), 0);
    return keys.map((key) => {
      const previousRow = previous.get(key);
      const currentRow = current.get(key);
      const previousFlights = previousRow?.flights ?? 0;
      const currentFlights = currentRow?.flights ?? 0;
      const difference = currentFlights - previousFlights;
      return {
        previousPeriod: previousPeriod.label, currentPeriod: currentPeriod.label,
        label: currentRow?.label ?? previousRow?.label ?? key,
        previousFlights, currentFlights, difference,
        differencePercent: previousFlights === 0 ? null : difference / previousFlights,
        contribution: currentTotal === 0 ? null : difference / currentTotal,
        status: previousPeriod.partial || currentPeriod.partial ? 'partial' : 'complete',
      };
    });
  });
  const summer = model.metadata.seasonCode?.startsWith('S');
  const monthCodes = summer ? ['04', '05', '06', '07', '08', '09', '10'] : ['11', '12', '01', '02', '03'];
  const monthNames: Record<string, string> = { '01': 'JAN', '02': 'FEB', '03': 'MAR', '04': 'APR', '05': 'MAY', '06': 'JUN', '07': 'JUL', '08': 'AUG', '09': 'SEP', '10': 'OCT', '11': 'NOV', '12': 'DEC' };
  return [
    { name: 'TOTAL', title: `BÁO CÁO SẢN LƯỢNG ${model.metadata.seasonCode ?? ''}`, note: `Phạm vi ${model.metadata.from}–${model.metadata.to}. Ô Pax để trống khi chưa có số liệu hành khách.`, columns: dailyColumns, rows: dailyRows, table: true },
    { name: 'WEEKLY', title: 'SẢN LƯỢNG THEO TUẦN NGHIỆP VỤ', note: 'Tuần nghiệp vụ được tính từ Thứ Sáu đến Thứ Năm.', columns: commonPeriodColumns(), rows: weeklyRows, table: true },
    ...monthCodes.map((monthCode): SheetSpec => ({
      name: monthNames[monthCode], title: `SẢN LƯỢNG THÁNG ${monthCode}`, note: `Chỉ gồm ngày khai thác thuộc phạm vi ${model.metadata.from}–${model.metadata.to}.`,
      columns: dailyColumns, rows: dailyRows.filter((row) => String(row.month).slice(5, 7) === monthCode), table: true,
      chart: { title: `Sản lượng ${monthNames[monthCode]}`, categoryColumn: 1, series: [{ name: 'ARR', column: 3, color: '1D4ED8' }, { name: 'DEP', column: 4, color: 'F59E0B' }] },
    })),
    { name: 'Analysis_Airline', title: 'PHÂN TÍCH THEO HÃNG', note: 'So sánh từng cặp tuần nghiệp vụ từ Thứ Sáu đến Thứ Năm.', columns: analysisColumns, rows: analysisRows('airlines'), table: true },
    { name: 'Analysis_Country', title: 'PHÂN TÍCH THEO QUỐC GIA', note: 'Các chuyến chưa xác định quốc gia được giữ thành một nhóm riêng.', columns: analysisColumns, rows: analysisRows('countries'), table: true },
  ];
}

function styleFor(kind: CellKind | undefined, isHeader = false): number {
  if (isHeader) return 3;
  if (kind === 'integer') return 5;
  if (kind === 'decimal') return 6;
  if (kind === 'percent') return 7;
  if (kind === 'date') return 8;
  if (kind === 'status') return 9;
  return 4;
}

function cellXml(ref: string, value: CellValue, kind?: CellKind, header = false): string {
  const style = styleFor(kind, header);
  if (value == null || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (kind === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return `<c r="${ref}" s="${style}"><v>${excelDate(value)}</v></c>`;
  if (typeof value === 'number') return `<c r="${ref}" s="${style}"><v>${Number.isFinite(value) ? value : ''}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${ref}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(safeText(value))}</t></is></c>`;
}

function sheetXml(spec: SheetSpec, tableId: number | null, drawingId: number | null): string {
  const columnCount = Math.max(1, spec.columns.length);
  const endColumn = columnName(columnCount - 1);
  const rows: string[] = [];
  rows.push(`<row r="1" ht="28" customHeight="1"><c r="A1" s="1" t="inlineStr"><is><t>${xml(safeText(spec.title))}</t></is></c></row>`);
  rows.push(`<row r="2" ht="32" customHeight="1"><c r="A2" s="2" t="inlineStr"><is><t>${xml(safeText(spec.note))}</t></is></c></row>`);
  rows.push(`<row r="3" ht="24" customHeight="1">${spec.columns.map((column, index) => cellXml(`${columnName(index)}3`, column.header, column.kind, true)).join('')}</row>`);
  spec.rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 4;
    rows.push(`<row r="${excelRow}">${spec.columns.map((column, columnIndex) => {
      const overrideKind = row[`${column.key}Kind`];
      const kind = typeof overrideKind === 'string' ? overrideKind as CellKind : column.kind;
      return cellXml(`${columnName(columnIndex)}${excelRow}`, row[column.key] ?? null, kind);
    }).join('')}</row>`);
  });
  if (spec.table && spec.rows.length === 0) rows.push(`<row r="4">${spec.columns.map((column, columnIndex) => cellXml(`${columnName(columnIndex)}4`, null, column.kind)).join('')}</row>`);
  const lastRow = Math.max(spec.table ? 4 : 3, spec.rows.length + 3);
  const drawing = drawingId == null ? '' : `<drawing r:id="rId${tableId == null ? 1 : 2}"/>`;
  const tableParts = tableId == null ? '' : `<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`;
  const autoFilter = tableId == null ? `<autoFilter ref="A3:${endColumn}${lastRow}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="A1:${endColumn}${lastRow}"/>
  <sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${spec.columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? 14}" customWidth="1"/>`).join('')}</cols>
  <sheetData>${rows.join('')}</sheetData>
  ${autoFilter}
  <mergeCells count="2"><mergeCell ref="A1:${endColumn}1"/><mergeCell ref="A2:${endColumn}2"/></mergeCells>
  <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>
  <headerFooter><oddFooter>&amp;L${xml(spec.name)}&amp;RTrang &amp;P / &amp;N</oddFooter></headerFooter>
  ${drawing}${tableParts}
</worksheet>`;
}

function tableXml(spec: SheetSpec, tableId: number): string {
  const endColumn = columnName(spec.columns.length - 1);
  const lastRow = Math.max(4, spec.rows.length + 3);
  const name = `BangBaoCao${tableId}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableId}" name="${name}" displayName="${name}" ref="A3:${endColumn}${lastRow}" totalsRowShown="0">
  <autoFilter ref="A3:${endColumn}${lastRow}"/>
  <tableColumns count="${spec.columns.length}">${spec.columns.map((column, index) => `<tableColumn id="${index + 1}" name="${xml(column.header)}"/>`).join('')}</tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`;
}

function sheetRelationships(tableId: number | null, drawingId: number | null): string | null {
  if (tableId == null && drawingId == null) return null;
  const relationships: string[] = [];
  if (tableId != null) relationships.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableId}.xml"/>`);
  if (drawingId != null) relationships.push(`<Relationship Id="rId${tableId == null ? 1 : 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingId}.xml"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join('')}</Relationships>`;
}

function chartXml(spec: SheetSpec): string {
  const chart = spec.chart!;
  const maxRows = Math.min(spec.rows.length, chart.maxRows ?? spec.rows.length);
  const fromRow = 4;
  const toRow = Math.max(fromRow, fromRow + maxRows - 1);
  const sheet = `'${spec.name.replaceAll("'", "''")}'`;
  const series = chart.series.map((item, index) => `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xml(item.name)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${item.color}"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>${sheet}!$${columnName(chart.categoryColumn)}$${fromRow}:$${columnName(chart.categoryColumn)}$${toRow}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${sheet}!$${columnName(item.column)}$${fromRow}:$${columnName(item.column)}$${toRow}</c:f></c:numRef></c:val></c:ser>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="vi-VN" sz="1200" b="1"/><a:t>${xml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:axId val="100001"/><c:axId val="100002"/></c:barChart><c:catAx><c:axId val="100001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="100002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/></c:catAx><c:valAx><c:axId val="100002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="#,##0" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="100001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:layout/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function drawingXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>25</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Biểu đồ báo cáo"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="4"><numFmt numFmtId="164" formatCode="${INTEGER_FORMAT}"/><numFmt numFmtId="165" formatCode="${DECIMAL_FORMAT}"/><numFmt numFmtId="166" formatCode="${PERCENT_FORMAT}"/><numFmt numFmtId="167" formatCode="${DATE_FORMAT}"/></numFmts>
  <fonts count="4"><font><sz val="10"/><name val="Aptos"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Aptos Display"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font><font><b/><sz val="10"/><color rgb="FF92400E"/><name val="Aptos"/></font></fonts>
  <fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF172554"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E3A8A"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF7ED"/></patternFill></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right><top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="10">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

export function buildTrafficWorkbookPackage(model: WorkbookReportModel): Record<string, Uint8Array> {
  const sheets = model.metadata.reportType === 'MASTER_OPERATIONS'
    ? masterSheets(model)
    : model.metadata.reportType === 'MONTHLY_OVERVIEW_L2'
      ? monthlySheets(model)
      : model.metadata.reportType === 'WEEKLY_DETAIL'
        ? weeklySheets(model)
        : model.metadata.reportType === 'PERIOD_ANALYSIS'
          ? periodAnalysisSheets(model)
          : baoCaoSanLuongSheets(model);
  const files: Record<string, Uint8Array> = {};
  let tableId = 0;
  let drawingId = 0;
  const sheetEntries = sheets.map((spec, index) => {
    const currentTableId = spec.table ? ++tableId : null;
    const currentDrawingId = spec.chart ? ++drawingId : null;
    files[`xl/worksheets/sheet${index + 1}.xml`] = textEncoder.encode(sheetXml(spec, currentTableId, currentDrawingId));
    const relationships = sheetRelationships(currentTableId, currentDrawingId);
    if (relationships) files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] = textEncoder.encode(relationships);
    if (currentTableId != null) files[`xl/tables/table${currentTableId}.xml`] = textEncoder.encode(tableXml(spec, currentTableId));
    if (currentDrawingId != null) {
      files[`xl/drawings/drawing${currentDrawingId}.xml`] = textEncoder.encode(drawingXml());
      files[`xl/drawings/_rels/drawing${currentDrawingId}.xml.rels`] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${currentDrawingId}.xml"/></Relationships>`);
      files[`xl/charts/chart${currentDrawingId}.xml`] = textEncoder.encode(chartXml(spec));
    }
    return `<sheet name="${xml(spec.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`;
  });
  const definedNames = sheets.map((spec, index) => {
    const endColumn = columnName(Math.max(0, spec.columns.length - 1));
    const lastRow = Math.max(3, spec.rows.length + 3);
    return `<definedName name="_xlnm.Print_Area" localSheetId="${index}">'${xml(spec.name.replaceAll("'", "''"))}'!$A$1:$${endColumn}$${lastRow}</definedName>`;
  }).join('');
  files['xl/workbook.xml'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews><sheets>${sheetEntries.join('')}</sheets><definedNames>${definedNames}</definedNames><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  files['xl/styles.xml'] = textEncoder.encode(stylesXml());
  files['docProps/core.xml'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(reportDisplayName(model.metadata.reportType))}</dc:title><dc:creator>AHT</dc:creator><dc:description>${xml(model.metadata.from)}–${xml(model.metadata.to)}</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">${xml(model.metadata.generatedAt)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${xml(model.metadata.generatedAt)}</dcterms:modified></cp:coreProperties>`);
  files['docProps/app.xml'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Excel</Application><AppVersion>16.0300</AppVersion><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map((spec) => `<vt:lpstr>${xml(spec.name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`);
  files['_rels/.rels'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ...sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    ...Array.from({ length: tableId }, (_, index) => `<Override PartName="/xl/tables/table${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`),
    ...Array.from({ length: drawingId }, (_, index) => `<Override PartName="/xl/drawings/drawing${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`),
  ];
  files['[Content_Types].xml'] = textEncoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`);
  return files;
}

export function trafficWorkbookFilename(model: WorkbookReportModel): string {
  const generated = model.metadata.generatedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  if (model.metadata.reportType === 'MASTER_OPERATIONS') return `workbook-tong-hop-khai-thac-${model.metadata.from}-${model.metadata.to}-${generated}.xlsx`;
  if (model.metadata.reportType === 'WEEKLY_DETAIL') return `chi-tiet-khai-thac-tuan-${model.metadata.from}-${model.metadata.to}-${generated}.xlsx`;
  if (model.metadata.reportType === 'PERIOD_ANALYSIS') return `phan-tich-theo-ky-${model.metadata.from}-${model.metadata.to}-${generated}.xlsx`;
  if (model.metadata.reportType === 'BAO_CAO_SAN_LUONG') return `bao-cao-san-luong-${model.metadata.seasonCode ?? model.metadata.from}-${generated}.xlsx`;
  return `tong-quan-khai-thac-${model.metadata.month ?? model.metadata.from.slice(0, 7)}-${model.metadata.publishStatus === 'FINAL' ? 'final' : 'draft'}-${generated}.xlsx`;
}
