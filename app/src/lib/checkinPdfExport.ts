import {
  buildCheckInAllocationView,
  buildCheckInTimelineTicks,
  getCheckInColorToken,
  type CheckInAllocationView,
  type CheckInResourceBar,
  type CheckInTimelineTicks,
} from './checkinAllocation';
import { saveExportBlob, type ExportSaveResult } from './exportSave';
import type { FlightModification, FlightRecord, OperationalSettings } from './types';

export interface CheckInPdfExportRange {
  from: string;
  to: string;
}

export interface CheckInPdfPagePlan {
  pageIndex: number;
  sectionId: string;
  sectionName: string;
  bhs: string | null;
  pageInGroup: number;
  groupPageCount: number;
  rowIndexes: number[];
  startRowIndex: number;
  endRowIndex: number;
  bodyHeightPx: number;
}

export interface CheckInPdfScale {
  orientation: 'landscape';
  pageWidthMm: number;
  pageHeightMm: number;
  marginMm: number;
  printableWidthMm: number;
  printableHeightMm: number;
  scale: number;
  scaleMode: 'width' | 'height';
  outputWidthMm: number;
  outputHeightMm: number;
}

export interface CheckInPdfPreviewGroup {
  id: string;
  name: string;
  bhs: string | null;
  rowCount: number;
}

export interface CheckInPdfPreviewPage extends CheckInPdfPagePlan, CheckInPdfScale {
  sourceWidthPx: number;
  sourceHeightPx: number;
  rowCount: number;
  barFontSizePt: number;
  warning: string | null;
}

export interface CheckInPdfPreviewPlan {
  range: CheckInPdfExportRange;
  settings: OperationalSettings;
  availableGroups: CheckInPdfPreviewGroup[];
  selectedGroupIds: string[];
  view: CheckInAllocationView;
  pagePlan: CheckInPdfPagePlan[];
  pages: CheckInPdfPreviewPage[];
  timelineTicks: CheckInTimelineTicks;
  timelineWidthPx: number;
  sourceWidthPx: number;
  rowMetrics: CheckInPdfRowMetrics;
}

export interface CheckInPdfBarLabelOverlay {
  text: string;
  xMm: number;
  yMm: number;
  maxWidthMm: number;
  textColor: string;
  fontSizePt: number;
  align: 'left' | 'center' | 'right';
}

export interface RenderCheckInPdfPageElementInput {
  preview: CheckInPdfPreviewPlan;
  page: CheckInPdfPagePlan;
  records: FlightRecord[];
  seasonCode: string;
  showBarLabels?: boolean;
}

export interface CheckInPdfBarTextInput {
  widthPx: number;
  startLabel: string;
  flightNumber: string;
  endLabel: string;
  fontSizePx?: number;
  timeFontSizePx?: number;
}

export interface CheckInPdfBarLabelSegment {
  role: 'start' | 'flight' | 'end';
  text: string;
  anchor: 'start' | 'center' | 'end';
  align: 'left' | 'center' | 'right';
  fontSizePx: number;
}

export interface CheckInPdfRowMetrics {
  resourceRowHeightPx: number;
  barHeightPx: number;
  rowGapPx: number;
  rowPaddingPx: number;
}

interface BuildCheckInPdfPagePlanInput extends Partial<CheckInPdfRowMetrics> {
  view: CheckInAllocationView;
  maxBodyHeightPx: number;
  selectedGroupIds?: string[];
}

interface BuildCheckInPdfPreviewPlanInput {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  range: CheckInPdfExportRange;
  selectedGroupIds?: string[];
  pixelsPerMinute?: number;
}

interface ExportCheckInAllocationPdfInput {
  records: FlightRecord[];
  modifications: Map<string, FlightModification>;
  settings: OperationalSettings;
  range: CheckInPdfExportRange;
  seasonCode: string;
  fileName: string;
  pixelsPerMinute?: number;
  selectedGroupIds?: string[];
}

interface CheckInPdfTextWriter {
  setFont: (fontName: string, fontStyle?: string) => CheckInPdfTextWriter;
  setFontSize: (size: number) => CheckInPdfTextWriter;
  setTextColor: (color: string) => CheckInPdfTextWriter;
  text: (
    text: string,
    x: number,
    y: number,
    options?: {
      align?: 'left' | 'center' | 'right';
      baseline?: 'middle';
      maxWidth?: number;
    }
  ) => CheckInPdfTextWriter;
}

interface CheckInPdfRenderContext {
  view: CheckInAllocationView;
  settings: OperationalSettings;
  range: CheckInPdfExportRange;
  seasonCode: string;
  page: CheckInPdfPagePlan;
  timelineTicks: CheckInTimelineTicks;
  timelineWidthPx: number;
  sourceWidthPx: number;
  recordById: Map<string, FlightRecord>;
  rowMetrics: CheckInPdfRowMetrics;
  showBarLabels: boolean;
}

const PDF_PAGE_WIDTH_MM = 297;
const PDF_PAGE_HEIGHT_MM = 210;
const PDF_MARGIN_MM = 5;
const PDF_MM_PER_CSS_PX = 25.4 / 96;
const PDF_LABEL_COLUMN_WIDTH_PX = 96;
const PDF_TITLE_HEIGHT_PX = 40;
const PDF_TIMELINE_HEADER_HEIGHT_PX = 36;
const PDF_GROUP_HEADER_HEIGHT_PX = 22;
const PDF_RESOURCE_ROW_HEIGHT_PX = 23;
const PDF_BAR_HEIGHT_PX = 18;
const PDF_ROW_GAP_PX = 1;
const PDF_ROW_PADDING_PX = 4;
const PDF_MIN_TIMELINE_WIDTH_PX = 720;
const PDF_PIXELS_PER_MINUTE = 2;
const PDF_CANVAS_SCALE = 1.5;
const PDF_EXPORT_IMAGE_MIME_TYPE = 'image/jpeg';
const PDF_EXPORT_IMAGE_QUALITY = 0.82;
const PDF_EXPORT_IMAGE_FORMAT = 'JPEG';
const PDF_EXPORT_IMAGE_COMPRESSION = 'FAST';
const PDF_BAR_FONT_SIZE_PX = 7;
const PDF_BAR_TIME_FONT_SIZE_PX = 6;
const PDF_MIN_READABLE_BAR_FONT_SIZE_PT = 8;
const PDF_BAR_TEXT_HORIZONTAL_PADDING_PX = 1;
const PDF_BAR_LABEL_SEGMENT_GAP_PX = 1;
const PDF_TEXT_AVERAGE_WIDTH_RATIO = 0.58;

function parseLocalDateTime(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid export datetime ${value}.`);
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`Invalid export datetime ${value}.`);
  }
  return date;
}

function minutesBetween(from: string, to: string): number {
  return Math.round((parseLocalDateTime(to).getTime() - parseLocalDateTime(from).getTime()) / 60000);
}

function assertExportRange(range: CheckInPdfExportRange): void {
  if (!range.from || !range.to) throw new Error('Choose both From and To before exporting.');
  if (minutesBetween(range.from, range.to) <= 0) throw new Error('Export To must be later than From.');
}

function printableWidthPx(pageWidthMm = PDF_PAGE_WIDTH_MM, marginMm = PDF_MARGIN_MM): number {
  return (pageWidthMm - marginMm * 2) / PDF_MM_PER_CSS_PX;
}

function printableHeightPx(pageHeightMm = PDF_PAGE_HEIGHT_MM, marginMm = PDF_MARGIN_MM): number {
  return (pageHeightMm - marginMm * 2) / PDF_MM_PER_CSS_PX;
}

function buildTimelineWidth(range: CheckInPdfExportRange, pixelsPerMinute: number): number {
  const requestedWidthPx = Math.max(PDF_MIN_TIMELINE_WIDTH_PX, Math.ceil(minutesBetween(range.from, range.to) * pixelsPerMinute));
  const printableTimelineWidthPx = Math.max(320, Math.floor(printableWidthPx() - PDF_LABEL_COLUMN_WIDTH_PX));
  return Math.min(printableTimelineWidthPx, requestedWidthPx);
}

function resolveRowMetrics(input: Partial<CheckInPdfRowMetrics>): CheckInPdfRowMetrics {
  return {
    resourceRowHeightPx: input.resourceRowHeightPx ?? PDF_RESOURCE_ROW_HEIGHT_PX,
    barHeightPx: input.barHeightPx ?? PDF_BAR_HEIGHT_PX,
    rowGapPx: input.rowGapPx ?? PDF_ROW_GAP_PX,
    rowPaddingPx: input.rowPaddingPx ?? PDF_ROW_PADDING_PX,
  };
}

function rowHeightsByIndex(view: CheckInAllocationView, metrics: CheckInPdfRowMetrics): Map<number, number> {
  const laneCounts = new Map<number, number>();
  for (const bar of view.resourceBars) {
    laneCounts.set(bar.counterIndex, Math.max(laneCounts.get(bar.counterIndex) ?? 1, bar.stackLaneCount));
  }
  const rowHeights = new Map<number, number>();
  view.resourceRows.forEach((_, index) => {
    const laneCount = laneCounts.get(index) ?? 1;
    rowHeights.set(index, Math.max(metrics.resourceRowHeightPx, metrics.rowPaddingPx + laneCount * (metrics.barHeightPx + metrics.rowGapPx)));
  });
  return rowHeights;
}

function formatExportDateTime(value: string): string {
  return value.replace('T', ' ');
}

function appendText(parent: HTMLElement, text: string, style: Partial<CSSStyleDeclaration> = {}): HTMLElement {
  const element = document.createElement('span');
  element.textContent = text;
  Object.assign(element.style, style);
  parent.appendChild(element);
  return element;
}

function styleElement<T extends HTMLElement>(element: T, style: Partial<CSSStyleDeclaration>): T {
  Object.assign(element.style, style);
  return element;
}

function barsForRow(view: CheckInAllocationView, rowIndex: number): CheckInResourceBar[] {
  return view.resourceBars.filter((bar) => bar.counterIndex === rowIndex);
}

function estimatedTextWidthPx(text: string, fontSizePx: number): number {
  return Math.ceil(text.length * fontSizePx * PDF_TEXT_AVERAGE_WIDTH_RATIO);
}

export function chooseCheckInPdfBarText({
  widthPx,
  startLabel,
  flightNumber,
  endLabel,
  fontSizePx = PDF_BAR_FONT_SIZE_PX,
  timeFontSizePx = PDF_BAR_TIME_FONT_SIZE_PX,
}: CheckInPdfBarTextInput): string {
  const segments = buildCheckInPdfBarLabelSegments({
    widthPx,
    startLabel,
    flightNumber,
    endLabel,
    fontSizePx,
    timeFontSizePx,
  });
  if (segments.length === 3) return `${startLabel} ${flightNumber} ${endLabel}`;
  return segments[0]?.text ?? '';
}

export function buildCheckInPdfBarLabelSegments({
  widthPx,
  startLabel,
  flightNumber,
  endLabel,
  fontSizePx = PDF_BAR_FONT_SIZE_PX,
  timeFontSizePx = PDF_BAR_TIME_FONT_SIZE_PX,
}: CheckInPdfBarTextInput): CheckInPdfBarLabelSegment[] {
  const usableWidthPx = Math.max(0, widthPx - PDF_BAR_TEXT_HORIZONTAL_PADDING_PX * 2);
  const startWidthPx = estimatedTextWidthPx(startLabel, timeFontSizePx);
  const flightWidthPx = estimatedTextWidthPx(flightNumber, fontSizePx);
  const endWidthPx = estimatedTextWidthPx(endLabel, timeFontSizePx);
  const threeSegmentWidthPx = startWidthPx + flightWidthPx + endWidthPx + PDF_BAR_LABEL_SEGMENT_GAP_PX * 2;

  if (startLabel && endLabel && threeSegmentWidthPx <= usableWidthPx) {
    return [
      { role: 'start', text: startLabel, anchor: 'start', align: 'left', fontSizePx: timeFontSizePx },
      { role: 'flight', text: flightNumber, anchor: 'center', align: 'center', fontSizePx },
      { role: 'end', text: endLabel, anchor: 'end', align: 'right', fontSizePx: timeFontSizePx },
    ];
  }

  if (estimatedTextWidthPx(flightNumber, fontSizePx) <= usableWidthPx) {
    return [{ role: 'flight', text: flightNumber, anchor: 'center', align: 'center', fontSizePx }];
  }

  return [];
}

function barLabelSegmentMaxWidthPx(segment: CheckInPdfBarLabelSegment, widthPx: number, segmentCount: number): number {
  const usableWidthPx = Math.max(1, widthPx - PDF_BAR_TEXT_HORIZONTAL_PADDING_PX * 2);
  if (segmentCount === 1) return usableWidthPx;
  return Math.max(1, Math.min(usableWidthPx, estimatedTextWidthPx(segment.text, segment.fontSizePx) + 2));
}

function barLabelSegmentAnchorOffsetPx(segment: CheckInPdfBarLabelSegment, widthPx: number): number {
  if (segment.anchor === 'start') return PDF_BAR_TEXT_HORIZONTAL_PADDING_PX;
  if (segment.anchor === 'end') return Math.max(PDF_BAR_TEXT_HORIZONTAL_PADDING_PX, widthPx - PDF_BAR_TEXT_HORIZONTAL_PADDING_PX);
  return widthPx / 2;
}

function appendBarLabelSegments(
  barElement: HTMLElement,
  segments: CheckInPdfBarLabelSegment[],
  widthPx: number,
  contentHeightPx: number
): void {
  for (const segment of segments) {
    const maxWidthPx = barLabelSegmentMaxWidthPx(segment, widthPx, segments.length);
    const label = appendText(barElement, segment.text, {
      position: 'absolute',
      top: '0',
      height: `${contentHeightPx}px`,
      width: `${maxWidthPx}px`,
      boxSizing: 'border-box',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      fontFamily: 'Arial, sans-serif',
      fontSize: `${segment.fontSizePx}px`,
      lineHeight: `${contentHeightPx}px`,
      textAlign: segment.align,
    });
    if (segment.anchor === 'start') {
      label.style.left = `${PDF_BAR_TEXT_HORIZONTAL_PADDING_PX}px`;
    } else if (segment.anchor === 'end') {
      label.style.right = `${PDF_BAR_TEXT_HORIZONTAL_PADDING_PX}px`;
    } else {
      label.style.left = '50%';
      label.style.transform = 'translateX(-50%)';
    }
  }
}

function renderTimelineHeader(context: CheckInPdfRenderContext): HTMLElement {
  const wrapper = styleElement(document.createElement('div'), {
    display: 'flex',
    height: `${PDF_TIMELINE_HEADER_HEIGHT_PX}px`,
    borderBottom: '1px solid #cbd5e1',
    color: '#475569',
    fontSize: '11px',
    fontFamily: 'Arial, sans-serif',
  });
  styleElement(wrapper.appendChild(document.createElement('div')), {
    width: `${PDF_LABEL_COLUMN_WIDTH_PX}px`,
    flexShrink: '0',
    borderRight: '1px solid #cbd5e1',
    background: '#f1f5f9',
    boxSizing: 'border-box',
    padding: '14px 8px 0',
    fontWeight: '700',
    textTransform: 'uppercase',
  }).textContent = 'Timeline';

  const timeline = styleElement(wrapper.appendChild(document.createElement('div')), {
    position: 'relative',
    width: `${context.timelineWidthPx}px`,
    height: `${PDF_TIMELINE_HEADER_HEIGHT_PX}px`,
    background: '#f8fafc',
  });
  for (const tick of context.timelineTicks.major) {
    styleElement(timeline.appendChild(document.createElement('span')), {
      position: 'absolute',
      left: `${tick.leftPercent}%`,
      top: '0',
      bottom: '0',
      borderLeft: '1px solid rgba(71, 85, 105, 0.5)',
    });
  }
  for (const tick of context.timelineTicks.macro) {
    appendText(timeline, tick.label, {
      position: 'absolute',
      left: `${tick.leftPercent}%`,
      top: '4px',
      paddingLeft: '3px',
      fontWeight: '700',
      whiteSpace: 'nowrap',
    });
  }
  for (const tick of context.timelineTicks.major) {
    appendText(timeline, tick.label, {
      position: 'absolute',
      left: `${tick.leftPercent}%`,
      bottom: '4px',
      paddingLeft: '3px',
      fontFamily: 'Consolas, monospace',
      whiteSpace: 'nowrap',
    });
  }
  return wrapper;
}

function renderBar(
  context: CheckInPdfRenderContext,
  bar: CheckInResourceBar,
  rowElement: HTMLElement,
  options: { showLabel?: boolean } = {}
): void {
  const record = context.recordById.get(bar.recordId);
  const color = getCheckInColorToken(record ?? {
    airline: bar.flightNumber.slice(0, 2),
    flightNumber: bar.flightNumber,
    rawFlightNumber: bar.flightNumber,
  }, context.settings);
  const left = (bar.leftPercent / 100) * context.timelineWidthPx;
  const width = Math.max(2, (bar.widthPercent / 100) * context.timelineWidthPx);
  const labelSegments = buildCheckInPdfBarLabelSegments({
    widthPx: width,
    startLabel: bar.startLabel,
    flightNumber: bar.flightNumber,
    endLabel: bar.endLabel,
  });
  const showLabel = options.showLabel ?? context.showBarLabels;
  const barContentHeightPx = Math.max(1, context.rowMetrics.barHeightPx - 2);
  const barElement = styleElement(rowElement.appendChild(document.createElement('div')), {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    left: `${left}px`,
    top: `${4 + bar.stackIndex * (context.rowMetrics.barHeightPx + context.rowMetrics.rowGapPx)}px`,
    width: `${width}px`,
    height: `${context.rowMetrics.barHeightPx}px`,
    borderRadius: '4px',
    border: '1px solid #FFFFFF',
    background: color.backgroundColor,
    color: color.textColor,
    boxSizing: 'border-box',
    overflow: 'hidden',
    fontFamily: 'Arial, sans-serif',
    fontSize: `${PDF_BAR_FONT_SIZE_PX}px`,
    fontWeight: '700',
    lineHeight: `${barContentHeightPx}px`,
    textAlign: 'center',
  });
  if (showLabel && labelSegments.length > 0) {
    appendBarLabelSegments(barElement, labelSegments, width, barContentHeightPx);
  }
  if (bar.lockConflict) {
    appendText(barElement, 'lock', {
      position: 'absolute',
      right: '3px',
      bottom: '0',
      color: '#b91c1c',
      fontSize: '8px',
      lineHeight: '10px',
    });
  }
}

function renderPdfPage(context: CheckInPdfRenderContext): HTMLElement {
  const page = styleElement(document.createElement('div'), {
    width: `${context.sourceWidthPx}px`,
    background: '#ffffff',
    color: '#0f172a',
    fontFamily: 'Arial, sans-serif',
    boxSizing: 'border-box',
  });
  const title = styleElement(page.appendChild(document.createElement('div')), {
    height: `${PDF_TITLE_HEIGHT_PX}px`,
    padding: '4px 8px',
    borderBottom: '1px solid #cbd5e1',
    background: '#ffffff',
    boxSizing: 'border-box',
  });
  appendText(title, 'Check-in Allocation', {
    display: 'block',
    fontSize: '16px',
    fontWeight: '700',
    color: '#0f172a',
  });
  appendText(title, `${context.seasonCode} | ${formatExportDateTime(context.range.from)} - ${formatExportDateTime(context.range.to)} | ${context.page.sectionName} ${context.page.pageInGroup}/${context.page.groupPageCount}`, {
    display: 'block',
    marginTop: '3px',
    fontSize: '11px',
    color: '#475569',
  });
  page.appendChild(renderTimelineHeader(context));

  const groupHeader = styleElement(page.appendChild(document.createElement('div')), {
    display: 'flex',
    height: `${PDF_GROUP_HEADER_HEIGHT_PX}px`,
    borderBottom: '1px solid #cbd5e1',
    background: '#e2e8f0',
    fontSize: '12px',
    fontWeight: '700',
    color: '#334155',
  });
  styleElement(groupHeader.appendChild(document.createElement('div')), {
    display: 'flex',
    alignItems: 'center',
    width: `${PDF_LABEL_COLUMN_WIDTH_PX}px`,
    flexShrink: '0',
    borderRight: '1px solid #cbd5e1',
    padding: '0 8px',
    boxSizing: 'border-box',
  }).textContent = context.page.sectionName;
  styleElement(groupHeader.appendChild(document.createElement('div')), {
    display: 'flex',
    alignItems: 'center',
    width: `${context.timelineWidthPx}px`,
    padding: '0 8px',
    boxSizing: 'border-box',
    fontFamily: 'Consolas, monospace',
  }).textContent = context.page.bhs ? `BHS ${context.page.bhs}` : 'No BHS';

  const rowHeights = rowHeightsByIndex(context.view, context.rowMetrics);
  for (const rowIndex of context.page.rowIndexes) {
    const resource = context.view.resourceRows[rowIndex];
    const rowHeight = rowHeights.get(rowIndex) ?? context.rowMetrics.resourceRowHeightPx;
    const isEven = rowIndex % 2 === 0;
    const row = styleElement(page.appendChild(document.createElement('div')), {
      display: 'flex',
      height: `${rowHeight}px`,
      borderBottom: '1px solid #e2e8f0',
      background: isEven ? '#ffffff' : '#f8fafc',
      boxSizing: 'border-box',
    });
    const label = styleElement(row.appendChild(document.createElement('div')), {
      display: 'flex',
      alignItems: 'center',
      width: `${PDF_LABEL_COLUMN_WIDTH_PX}px`,
      flexShrink: '0',
      borderRight: '1px solid #cbd5e1',
      background: isEven ? '#ffffff' : '#f1f5f9',
      padding: '0 8px',
      boxSizing: 'border-box',
      fontSize: '11px',
      fontWeight: '700',
      color: resource.activeLocks.length > 0 ? '#b91c1c' : '#0f172a',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    label.textContent = resource.activeLocks.length > 0 ? `${resource.label} lock` : resource.label;
    const timelineCell = styleElement(row.appendChild(document.createElement('div')), {
      position: 'relative',
      width: `${context.timelineWidthPx}px`,
      height: `${rowHeight}px`,
      boxSizing: 'border-box',
    });
    for (const bar of barsForRow(context.view, rowIndex)) {
      renderBar(context, bar, timelineCell, { showLabel: context.showBarLabels });
    }
  }
  return page;
}

export function renderCheckInPdfPageElement({
  preview,
  page,
  records,
  seasonCode,
  showBarLabels = true,
}: RenderCheckInPdfPageElementInput): HTMLElement {
  return renderPdfPage({
    view: preview.view,
    settings: preview.settings,
    range: preview.range,
    seasonCode,
    page,
    timelineTicks: preview.timelineTicks,
    timelineWidthPx: preview.timelineWidthPx,
    sourceWidthPx: preview.sourceWidthPx,
    recordById: new Map(records.map((record) => [record.id, record])),
    rowMetrics: preview.rowMetrics,
    showBarLabels,
  });
}

function fixedPageHeightPx(): number {
  return PDF_TITLE_HEIGHT_PX + PDF_TIMELINE_HEADER_HEIGHT_PX + PDF_GROUP_HEADER_HEIGHT_PX;
}

function buildCheckInPdfPreviewPages({
  pagePlan,
  sourceWidthPx,
}: {
  pagePlan: CheckInPdfPagePlan[];
  sourceWidthPx: number;
}): CheckInPdfPreviewPage[] {
  return pagePlan.map((page) => {
    const sourceHeightPx = fixedPageHeightPx() + page.bodyHeightPx;
    const scale = calculateCheckInPdfScale({
      sourceWidthPx,
      sourceHeightPx,
    });
    const barFontSizePt = cssPxAtPdfScaleToPt(PDF_BAR_FONT_SIZE_PX, scale.scale);
    return {
      ...page,
      ...scale,
      sourceWidthPx,
      sourceHeightPx,
      rowCount: page.rowIndexes.length,
      barFontSizePt,
      warning: barFontSizePt < PDF_MIN_READABLE_BAR_FONT_SIZE_PT
        ? `Preview text is ${barFontSizePt.toFixed(1)}pt on this page; narrow the export timeframe to improve legibility.`
        : null,
    };
  });
}

export function selectCheckInPdfPreviewGroups(
  preview: CheckInPdfPreviewPlan,
  selectedGroupIds: string[]
): CheckInPdfPreviewPlan {
  const normalizedSelectedGroupIds = normalizeSelectedGroupIds(preview.view, selectedGroupIds);
  const pagePlan = buildCheckInPdfPagePlan({
    view: preview.view,
    maxBodyHeightPx: Math.max(PDF_RESOURCE_ROW_HEIGHT_PX, Math.floor(printableHeightPx() - fixedPageHeightPx())),
    selectedGroupIds: normalizedSelectedGroupIds,
    ...preview.rowMetrics,
  });
  return {
    ...preview,
    selectedGroupIds: normalizedSelectedGroupIds,
    pagePlan,
    pages: buildCheckInPdfPreviewPages({
      pagePlan,
      sourceWidthPx: preview.sourceWidthPx,
    }),
  };
}

export function buildCheckInPdfBarLabelOverlays({
  preview,
  page,
  scale,
  records = [],
}: {
  preview: CheckInPdfPreviewPlan;
  page: CheckInPdfPagePlan;
  scale: CheckInPdfScale;
  records?: FlightRecord[];
}): CheckInPdfBarLabelOverlay[] {
  const rowIndexSet = new Set(page.rowIndexes);
  const rowHeights = rowHeightsByIndex(preview.view, preview.rowMetrics);
  const rowTopByIndex = new Map<number, number>();
  const recordById = new Map(records.map((record) => [record.id, record]));
  let rowOffsetPx = fixedPageHeightPx();
  for (const rowIndex of page.rowIndexes) {
    rowTopByIndex.set(rowIndex, rowOffsetPx);
    rowOffsetPx += rowHeights.get(rowIndex) ?? preview.rowMetrics.resourceRowHeightPx;
  }

  return preview.view.resourceBars.flatMap((bar) => {
    if (!rowIndexSet.has(bar.counterIndex)) return [];
    const widthPx = Math.max(2, (bar.widthPercent / 100) * preview.timelineWidthPx);
    const segments = buildCheckInPdfBarLabelSegments({
      widthPx,
      startLabel: bar.startLabel,
      flightNumber: bar.flightNumber,
      endLabel: bar.endLabel,
    });
    if (segments.length === 0) return [];
    const color = getCheckInColorToken(recordById.get(bar.recordId) ?? {
      airline: bar.flightNumber.slice(0, 2),
      flightNumber: bar.flightNumber,
      rawFlightNumber: bar.flightNumber,
    }, preview.settings);
    const rowTopPx = rowTopByIndex.get(bar.counterIndex);
    if (rowTopPx == null) return [];
    const leftPx = PDF_LABEL_COLUMN_WIDTH_PX + (bar.leftPercent / 100) * preview.timelineWidthPx;
    const barTopPx = rowTopPx + 4 + bar.stackIndex * (preview.rowMetrics.barHeightPx + preview.rowMetrics.rowGapPx);
    return segments.map((segment) => ({
      text: segment.text,
      xMm: scale.marginMm + (leftPx + barLabelSegmentAnchorOffsetPx(segment, widthPx)) * scale.scale,
      yMm: scale.marginMm + (barTopPx + preview.rowMetrics.barHeightPx / 2) * scale.scale,
      maxWidthMm: Math.max(1, barLabelSegmentMaxWidthPx(segment, widthPx, segments.length) * scale.scale),
      textColor: color.textColor,
      fontSizePt: cssPxAtPdfScaleToPt(segment.fontSizePx, scale.scale),
      align: segment.align,
    }));
  });
}

function drawCheckInPdfBarLabels(pdf: CheckInPdfTextWriter, overlays: CheckInPdfBarLabelOverlay[]): void {
  pdf.setFont('helvetica', 'bold');
  for (const overlay of overlays) {
    pdf.setFontSize(overlay.fontSizePt);
    pdf.setTextColor(overlay.textColor);
    pdf.text(overlay.text, overlay.xMm, overlay.yMm, {
      align: overlay.align,
      baseline: 'middle',
      maxWidth: overlay.maxWidthMm,
    });
  }
}

export function buildCheckInPdfPagePlan({
  view,
  maxBodyHeightPx,
  selectedGroupIds,
  ...metricInput
}: BuildCheckInPdfPagePlanInput): CheckInPdfPagePlan[] {
  if (!Number.isFinite(maxBodyHeightPx) || maxBodyHeightPx <= 0) throw new Error('PDF page body height must be positive.');
  const metrics = resolveRowMetrics(metricInput);
  const rowHeights = rowHeightsByIndex(view, metrics);
  const pages: CheckInPdfPagePlan[] = [];
  const selectedGroupSet = selectedGroupIds === undefined ? null : new Set(selectedGroupIds);

  for (const section of view.resourceSections) {
    if (selectedGroupSet && !selectedGroupSet.has(section.id)) continue;
    const rowIndexes: number[] = [];
    let bodyHeightPx = 0;

    for (let rowIndex = section.startIndex; rowIndex <= section.endIndex; rowIndex += 1) {
      const rowHeight = rowHeights.get(rowIndex) ?? metrics.resourceRowHeightPx;
      rowIndexes.push(rowIndex);
      bodyHeightPx += rowHeight;
    }
    if (rowIndexes.length > 0) {
      pages.push({
        sectionId: section.id,
        sectionName: section.name,
        bhs: section.bhs,
        pageIndex: pages.length,
        pageInGroup: 1,
        groupPageCount: 1,
        rowIndexes,
        startRowIndex: rowIndexes[0],
        endRowIndex: rowIndexes[rowIndexes.length - 1],
        bodyHeightPx,
      });
    }
  }
  return pages;
}

function normalizeSelectedGroupIds(view: CheckInAllocationView, selectedGroupIds: string[] | undefined): string[] {
  const availableIds = view.resourceSections.map((section) => section.id);
  if (selectedGroupIds === undefined) return availableIds;
  const availableSet = new Set(availableIds);
  const selectedSet = new Set<string>();
  for (const groupId of selectedGroupIds) {
    if (availableSet.has(groupId)) selectedSet.add(groupId);
  }
  return availableIds.filter((groupId) => selectedSet.has(groupId));
}

function cssPxAtPdfScaleToPt(fontSizePx: number, scale: number): number {
  return (fontSizePx * scale * 72) / 25.4;
}

export function calculateCheckInPdfScale({
  sourceWidthPx,
  sourceHeightPx,
  pageWidthMm = PDF_PAGE_WIDTH_MM,
  pageHeightMm = PDF_PAGE_HEIGHT_MM,
  marginMm = PDF_MARGIN_MM,
}: {
  sourceWidthPx: number;
  sourceHeightPx: number;
  pageWidthMm?: number;
  pageHeightMm?: number;
  marginMm?: number;
}): CheckInPdfScale {
  if (!Number.isFinite(sourceWidthPx) || sourceWidthPx <= 0) throw new Error('PDF source width must be positive.');
  if (!Number.isFinite(sourceHeightPx) || sourceHeightPx <= 0) throw new Error('PDF source height must be positive.');
  const printableWidthMm = pageWidthMm - marginMm * 2;
  const printableHeightMm = pageHeightMm - marginMm * 2;
  const widthScale = printableWidthMm / sourceWidthPx;
  const heightScale = printableHeightMm / sourceHeightPx;
  const scale = Math.min(widthScale, heightScale);
  const scaleMode = heightScale < widthScale ? 'height' : 'width';
  const outputWidthMm = sourceWidthPx * scale;
  const outputHeightMm = sourceHeightPx * scale;
  return {
    orientation: 'landscape',
    pageWidthMm,
    pageHeightMm,
    marginMm,
    printableWidthMm,
    printableHeightMm,
    scale,
    scaleMode,
    outputWidthMm,
    outputHeightMm,
  };
}

export function buildCheckInPdfPreviewPlan({
  records,
  modifications,
  settings,
  range,
  selectedGroupIds,
  pixelsPerMinute = PDF_PIXELS_PER_MINUTE,
}: BuildCheckInPdfPreviewPlanInput): CheckInPdfPreviewPlan {
  assertExportRange(range);
  const timelineWidthPx = buildTimelineWidth(range, pixelsPerMinute);
  const sourceWidthPx = PDF_LABEL_COLUMN_WIDTH_PX + timelineWidthPx;
  const maxBodyHeightPx = Math.max(PDF_RESOURCE_ROW_HEIGHT_PX, Math.floor(printableHeightPx() - fixedPageHeightPx()));
  const exportPixelsPerMinute = timelineWidthPx / minutesBetween(range.from, range.to);
  const view = buildCheckInAllocationView({
    records,
    modifications,
    settings,
    from: range.from,
    to: range.to,
    groupByCounterGroup: true,
    pixelsPerMinute: exportPixelsPerMinute,
  });
  const normalizedSelectedGroupIds = normalizeSelectedGroupIds(view, selectedGroupIds);
  const pagePlan = buildCheckInPdfPagePlan({
    view,
    maxBodyHeightPx,
    selectedGroupIds: normalizedSelectedGroupIds,
  });
  const timelineTicks = buildCheckInTimelineTicks(range.from, range.to);
  const rowMetrics = resolveRowMetrics({});
  const availableGroups = view.resourceSections.map((section) => ({
    id: section.id,
    name: section.name,
    bhs: section.bhs,
    rowCount: Math.max(0, section.endIndex - section.startIndex + 1),
  }));
  const pages = buildCheckInPdfPreviewPages({ pagePlan, sourceWidthPx });
  return {
    range,
    settings,
    availableGroups,
    selectedGroupIds: normalizedSelectedGroupIds,
    view,
    pagePlan,
    pages,
    timelineTicks,
    timelineWidthPx,
    sourceWidthPx,
    rowMetrics,
  };
}

export async function exportCheckInAllocationPdf({
  records,
  modifications,
  settings,
  range,
  seasonCode,
  fileName,
  pixelsPerMinute = PDF_PIXELS_PER_MINUTE,
  selectedGroupIds,
}: ExportCheckInAllocationPdfInput): Promise<{ pageCount: number; fileName: string; saveResult: ExportSaveResult }> {
  const previewPlan = buildCheckInPdfPreviewPlan({
    records,
    modifications,
    settings,
    range,
    pixelsPerMinute,
    selectedGroupIds,
  });
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const { pagePlan, sourceWidthPx } = previewPlan;
  if (pagePlan.length === 0) throw new Error('No check-in counter groups are available to export.');

  const pdf = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });
  const host = styleElement(document.createElement('div'), {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${sourceWidthPx}px`,
    background: '#ffffff',
    zIndex: '-1',
  });
  document.body.appendChild(host);

  try {
    for (const page of pagePlan) {
      const pageElement = renderCheckInPdfPageElement({
        preview: previewPlan,
        page,
        records,
        seasonCode,
        showBarLabels: false,
      });
      host.replaceChildren(pageElement);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const canvas = await html2canvas(pageElement, {
        backgroundColor: '#ffffff',
        scale: PDF_CANVAS_SCALE,
        useCORS: true,
        logging: false,
      });
      const sourceHeightPx = pageElement.getBoundingClientRect().height || pageElement.scrollHeight;
      const scale = calculateCheckInPdfScale({
        sourceWidthPx,
        sourceHeightPx,
      });
      if (page.pageIndex > 0) pdf.addPage('a4', 'landscape');
      pdf.addImage(
        canvas.toDataURL(PDF_EXPORT_IMAGE_MIME_TYPE, PDF_EXPORT_IMAGE_QUALITY),
        PDF_EXPORT_IMAGE_FORMAT,
        scale.marginMm,
        scale.marginMm,
        scale.outputWidthMm,
        scale.outputHeightMm,
        undefined,
        PDF_EXPORT_IMAGE_COMPRESSION
      );
      drawCheckInPdfBarLabels(pdf, buildCheckInPdfBarLabelOverlays({
        preview: previewPlan,
        page,
        scale,
        records,
      }));
    }
    const blob = pdf.output('blob') as Blob;
    const saveResult = await saveExportBlob({ blob, fileName, mimeType: 'application/pdf' });
    return { pageCount: pagePlan.length, fileName: saveResult.fileName, saveResult };
  } finally {
    host.remove();
  }
}
