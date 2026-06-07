'use client';

import { useMemo, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardAiWorkspaceBlock } from '@/lib/dashboardAiAnalysis';

export type AiWorkspaceTableRow = Record<string, string | number | boolean | null>;

export interface AiNotebookRendererData {
  formatValue: (value: number) => string;
  materializeTableRows: (block: DashboardAiWorkspaceBlock) => AiWorkspaceTableRow[];
  materializeChartRows: (block: DashboardAiWorkspaceBlock) => Array<Record<string, string | number>>;
  fallbackKpis: {
    totalFlights: number;
    totalPax: number;
    avgFlightsPerDay: number;
    selectedSeasonCount: number;
  };
}

export interface AiNotebookBlockActions {
  moveBlock: (cellId: string, blockId: string, direction: -1 | 1) => void;
  deleteBlock: (cellId: string, blockId: string) => void;
  exportBlockExcel: (block: DashboardAiWorkspaceBlock) => void;
}

export const AI_CHART_PALETTE = ['#2563eb', '#0ea5e9', '#f59e0b', '#059669', '#7c3aed', '#db2777', '#0891b2', '#64748b'];

const BLOCK_TYPE_LABELS: Record<string, string> = {
  kpi: 'KPI',
  table: 'Bảng',
  chart: 'Biểu đồ',
  'insight-list': 'Nhận định',
  'data-quality-notes': 'Ghi chú dữ liệu',
  'rich-markdown': 'Nội dung rich text',
  'html-preview': 'HTML sandbox',
};

const SOURCE_LABELS: Record<string, string> = {
  overview: 'Tổng quan',
  comparison: 'So sánh',
  seasonCatalog: 'Danh mục mùa',
  resolvedDataRequest: 'Dữ liệu đã truy vấn',
  multiSeason: 'Nhiều mùa',
};

const COLUMN_LABELS: Record<string, string> = {
  Season: 'Mùa',
  Name: 'Tên',
  Flights: 'Chuyến bay',
  Pax: 'Khách',
  ARR: 'ARR',
  DEP: 'DEP',
  From: 'Từ',
  To: 'Đến',
  Source: 'Nguồn',
  Driver: 'Tác nhân',
  Current: 'Kỳ hiện tại',
  Previous: 'Kỳ trước',
  Delta: 'Thay đổi',
  'Delta %': '% thay đổi',
  CTG: 'Đóng góp',
  'Share shift': 'Dịch chuyển tỷ trọng',
  Month: 'Tháng',
  Airline: 'Hãng bay',
  Share: 'Tỷ trọng',
  Country: 'Quốc gia',
  Route: 'Đường bay',
  Bucket: 'Khung giờ',
  'Ops days': 'Ngày khai thác',
  'Avg/day': 'TB/ngày',
  Value: 'Giá trị',
};

function formatCellValue(value: string | number | boolean | null, formatValue: (value: number) => string): string {
  if (typeof value === 'number') return formatValue(value);
  if (typeof value === 'boolean') return value ? 'Có' : 'Không';
  if (value == null) return '-';
  return String(value);
}

function renderRichMarkdown(content: string) {
  const lines = content.split(/\r?\n/);
  const nodes: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      nodes.push(<div key={`space-${index}`} className="h-2" />);
      continue;
    }
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      nodes.push(
        <pre key={`code-${index}`} className="overflow-x-auto rounded-md bg-surface-container-high px-3 py-2 text-xs text-on-surface">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }
    if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] ?? '')) {
      const header = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index] ?? '')) {
        rows.push((lines[index] ?? '').split('|').map((cell) => cell.trim()).filter(Boolean));
        index += 1;
      }
      index -= 1;
      nodes.push(
        <div key={`table-${index}`} className="overflow-x-auto rounded-md border border-surface-variant">
          <table className="min-w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-surface-container-low text-xs uppercase text-on-surface-variant">
              <tr>{header.map((cell) => <th key={cell} className="px-3 py-2 text-left">{cell}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-surface-variant bg-surface">
              {rows.map((row, rowIndex) => (
                <tr key={`row-${rowIndex}`} className="hover:bg-surface-container-low">
                  {header.map((_, cellIndex) => <td key={cellIndex} className="px-3 py-2 text-on-surface">{row[cellIndex] ?? ''}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = heading[1].length <= 2 ? 'h3' : 'h4';
      nodes.push(<Tag key={`heading-${index}`} className="text-sm font-bold text-on-surface">{heading[2]}</Tag>);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      nodes.push(
        <div key={`bullet-${index}`} className="flex gap-2 text-sm text-on-surface">
          <span className="mt-2 h-1.5 w-1.5 rounded-full bg-primary" />
          <span>{bullet[1]}</span>
        </div>
      );
      continue;
    }
    nodes.push(<p key={`p-${index}`} className="text-sm leading-7 text-on-surface">{line}</p>);
  }
  return <div data-testid="ai-rich-markdown" className="space-y-2">{nodes}</div>;
}

function AiWorkspaceTable({ block, rendererData }: { block: DashboardAiWorkspaceBlock; rendererData: AiNotebookRendererData }) {
  const rows = rendererData.materializeTableRows(block);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return (
    <div className="relative overflow-hidden rounded-md border border-surface-variant">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-container-low text-xs uppercase text-on-surface-variant shadow-sm">
            <tr>{columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-2 text-left">{COLUMN_LABELS[column] ?? column}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-surface-variant bg-surface">
            {rows.map((row, rowIndex) => (
              <tr key={`${block.id}-${rowIndex}`} className="hover:bg-surface-container-low">
                {columns.map((column) => {
                  const value = row[column];
                  const isNumber = typeof value === 'number';
                  return (
                    <td key={column} className={`whitespace-nowrap px-3 py-2 ${isNumber ? 'text-right font-semibold tabular-nums' : 'text-left'} text-on-surface`}>
                      {formatCellValue(value, rendererData.formatValue)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, columns.length)} className="px-3 py-6 text-center text-on-surface-variant">
                  Chưa có dòng dữ liệu cho block này.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-container-low to-transparent" />
    </div>
  );
}

function resolveKpiItems(block: DashboardAiWorkspaceBlock, rendererData: AiNotebookRendererData) {
  const rows = block.chart?.rows?.length ? rendererData.materializeChartRows(block) : [];
  if (rows.length > 0) {
    return rows.slice(0, 4).map((row, index) => {
      const label = String(row.label ?? row.name ?? row.metric ?? `KPI ${index + 1}`);
      const numericKey = Object.keys(row).find((key) => key !== 'label' && typeof row[key] === 'number');
      const value = numericKey ? rendererData.formatValue(Number(row[numericKey])) : String(row.value ?? '-');
      return { label, value };
    });
  }
  return [
    { label: 'Chuyến bay', value: rendererData.formatValue(rendererData.fallbackKpis.totalFlights) },
    { label: 'Khách', value: rendererData.formatValue(rendererData.fallbackKpis.totalPax) },
    { label: 'TB/ngày', value: rendererData.fallbackKpis.avgFlightsPerDay.toFixed(1) },
    { label: 'Mùa', value: rendererData.formatValue(rendererData.fallbackKpis.selectedSeasonCount) },
  ];
}

function AiWorkspaceChart({ block, rendererData }: { block: DashboardAiWorkspaceBlock; rendererData: AiNotebookRendererData }) {
  const rows = rendererData.materializeChartRows(block);
  const xKey = block.chart?.x && rows.some((row) => Object.prototype.hasOwnProperty.call(row, block.chart?.x as string))
    ? block.chart.x
    : 'label';
  const dynamicSeries = (block.chart?.series ?? []).filter((series) => rows.some((row) => typeof row[series] === 'number'));
  const seriesKeys = dynamicSeries.length > 0
    ? dynamicSeries
    : rows.some((row) => typeof row.value === 'number')
      ? ['value']
      : ['flights'];

  if (block.chart?.chartType === 'kpi-strip' || block.type === 'kpi') {
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {resolveKpiItems(block, rendererData).map((item) => (
          <div key={item.label} className="rounded-md bg-surface px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-on-surface-variant">{item.label}</div>
            <div className="mt-1 text-lg font-bold text-on-surface">{item.value}</div>
          </div>
        ))}
      </div>
    );
  }

  if (block.chart?.chartType === 'heatmap') {
    const values = rows.map((row) => Number(row.value ?? row[seriesKeys[0]] ?? 0)).filter(Number.isFinite);
    const maxValue = Math.max(1, ...values.map((value) => Math.abs(value)));
    return (
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {rows.slice(0, block.chart.limit ?? 24).map((row, index) => {
          const value = Number(row.value ?? row[seriesKeys[0]] ?? 0);
          const intensity = Math.max(0.12, Math.min(1, Math.abs(value) / maxValue));
          return (
            <div
              key={`${block.id}-heat-${index}`}
              className="rounded-md border border-surface-variant px-3 py-2 text-sm"
              style={{ backgroundColor: `rgba(37, 99, 235, ${intensity})`, color: intensity > 0.55 ? '#fff' : undefined }}
            >
              <div className="text-xs font-semibold">{String(row[xKey] ?? row.label ?? `Ô ${index + 1}`)}</div>
              <div className="mt-1 text-lg font-bold">{rendererData.formatValue(value)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  if (block.chart?.chartType === 'waterfall') {
    const waterfallRows = rows.map((row, rowIndex) => {
      const delta = Number(row.value ?? row[seriesKeys[0]] ?? 0);
      const previousTotal = rows.slice(0, rowIndex).reduce((sum, previousRow) => (
        sum + Number(previousRow.value ?? previousRow[seriesKeys[0]] ?? 0)
      ), 0);
      const base = delta >= 0 ? previousTotal : previousTotal + delta;
      return { ...row, __base: base, __delta: Math.abs(delta), __rawDelta: delta };
    });
    return (
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={waterfallRows} margin={{ top: 8, right: 18, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey="__base" stackId="waterfall" fill="transparent" />
            <Bar dataKey="__delta" stackId="waterfall" radius={[4, 4, 0, 0]}>
              {waterfallRows.map((row, index) => (
                <Cell key={`${block.id}-waterfall-${index}`} fill={Number(row.__rawDelta) >= 0 ? '#059669' : '#dc2626'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (block.chart?.chartType === 'line-trend' || block.chart?.chartType === 'area') {
    return (
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 18, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            {seriesKeys.map((series, index) => (
              <Line key={series} type="monotone" dataKey={series} stroke={AI_CHART_PALETTE[index % AI_CHART_PALETTE.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 18, bottom: 8, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          {seriesKeys.slice(0, 3).map((series, seriesIndex) => (
            <Bar key={series} dataKey={series} radius={[4, 4, 0, 0]} fill={AI_CHART_PALETTE[seriesIndex % AI_CHART_PALETTE.length]}>
              {seriesKeys.length === 1 && rows.map((row, rowIndex) => (
                <Cell key={`${String(row[xKey] ?? row.label)}-${rowIndex}`} fill={Number(row[series]) >= 0 ? '#059669' : '#dc2626'} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function HtmlPreview({ block }: { block: DashboardAiWorkspaceBlock }) {
  const html = block.htmlPreview?.html ?? '';
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;"><style>body{margin:0;padding:16px;font-family:Inter,Arial,sans-serif;color:#1f2937;background:#fff}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}th{background:#f3f4f6}</style></head><body>${html}</body></html>`;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-on-surface-variant">
        <span className="material-symbols-outlined text-[15px]">shield_lock</span>
        Bản xem trước sandbox
        {block.htmlPreview?.sanitized && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-100">Đã sanitize</span>}
      </div>
      {block.htmlPreview?.rejectedReason && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">{block.htmlPreview.rejectedReason}</div>
      )}
      <iframe 
        title={block.title} 
        sandbox="" 
        srcDoc={srcDoc} 
        className="h-[420px] w-full rounded-md border border-surface-variant bg-white" 
      /> 
    </div>
  );
}

export function AiNotebookBlockContent({ block, rendererData }: { block: DashboardAiWorkspaceBlock; rendererData: AiNotebookRendererData }) {
  if (block.type === 'table') return <AiWorkspaceTable block={block} rendererData={rendererData} />;
  if (block.type === 'chart' || block.type === 'kpi') return <AiWorkspaceChart block={block} rendererData={rendererData} />;
  if (block.type === 'rich-markdown') return renderRichMarkdown(block.markdown?.content ?? '');
  if (block.type === 'html-preview') return <HtmlPreview block={block} />;
  return (
    <div className="space-y-2 text-sm text-on-surface">
      {(block.insights ?? []).map((insight) => (
        <div key={insight} className="flex gap-2">
          <span className="material-symbols-outlined text-[16px] text-primary">{block.type === 'data-quality-notes' ? 'database' : 'insights'}</span>
          <span>{insight}</span>
        </div>
      ))}
    </div>
  );
}

export function AiNotebookBlockCard({
  block,
  cellId,
  index,
  totalBlocks,
  rendererData,
  actions,
}: {
  block: DashboardAiWorkspaceBlock;
  cellId: string;
  index: number;
  totalBlocks: number;
  rendererData: AiNotebookRendererData;
  actions: AiNotebookBlockActions;
}) {
  const badge = useMemo(() => `${BLOCK_TYPE_LABELS[block.type] ?? block.type} / ${SOURCE_LABELS[block.source] ?? block.source}`, [block.source, block.type]);
  return (
    <section
      className="rounded-lg border border-surface-variant bg-surface-container-low p-4 opacity-0 motion-safe:animate-[fadeIn_220ms_ease-out_forwards]"
      style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">{badge}</div>
          <h3 className="mt-1 text-sm font-bold text-on-surface">{block.title}</h3>
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" onClick={() => actions.moveBlock(cellId, block.id, -1)} disabled={index === 0} className="rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40" title="Di chuyển block lên" aria-label="Di chuyển block lên">
            <span className="material-symbols-outlined text-[15px]">arrow_upward</span>
          </button>
          <button type="button" onClick={() => actions.moveBlock(cellId, block.id, 1)} disabled={index === totalBlocks - 1} className="rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-40" title="Di chuyển block xuống" aria-label="Di chuyển block xuống">
            <span className="material-symbols-outlined text-[15px]">arrow_downward</span>
          </button>
          {block.type === 'table' && (
            <button type="button" onClick={() => actions.exportBlockExcel(block)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-on-primary focus:outline-none focus:ring-2 focus:ring-primary">
              <span className="material-symbols-outlined text-[15px]">download</span>
              Xuất Excel block
            </button>
          )}
          <button type="button" onClick={() => actions.deleteBlock(cellId, block.id)} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200" title="Xóa block" aria-label="Xóa block">
            <span className="material-symbols-outlined text-[15px]">delete</span>
          </button>
        </div>
      </div>
      <AiNotebookBlockContent block={block} rendererData={rendererData} />
    </section>
  );
}

export { BLOCK_TYPE_LABELS, SOURCE_LABELS, renderRichMarkdown };
