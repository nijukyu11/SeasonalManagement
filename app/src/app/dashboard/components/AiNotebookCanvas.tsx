'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  DashboardAiExportAction,
  DashboardAiNotebook,
  DashboardAiNotebookCell,
  DashboardAiToolName,
} from '@/lib/dashboardAiAnalysis';
import { isDashboardAiToolTraceVisible } from '@/lib/dashboardAiAnalysis';
import {
  AiNotebookBlockCard,
  renderRichMarkdown,
  type AiNotebookBlockActions,
  type AiNotebookRendererData,
} from './AiNotebookBlockRenderers';

export type AiNotebookLoadingStep = 'context' | 'provider' | 'query' | 'render';

export interface AiNotebookActionHandlers extends AiNotebookBlockActions {
  submitPrompt: (prompt?: string, options?: { preferredTool?: DashboardAiToolName | null }) => void | Promise<void>;
  retryPrompt: (prompt: string) => void | Promise<void>;
  tryDifferentModel: (prompt: string) => void | Promise<void>;
  deleteCell: (cellId: string) => void;
  duplicatePrompt: (cell: DashboardAiNotebookCell) => void;
  onPinContext: (cell: DashboardAiNotebookCell) => void;
  downloadExport: (exportAction: DashboardAiExportAction) => void;
}

export interface AiNotebookCanvasProps {
  notebook: DashboardAiNotebook | null;
  aiPrompt: string;
  setAiPrompt: (value: string) => void;
  aiLoading: boolean;
  aiLoadingMessage: string;
  aiLoadingStep: AiNotebookLoadingStep;
  aiLoadingStartedAt: number | null;
  aiError: string | null;
  lastAiPrompt: string;
  aiConfigured: boolean;
  canTryDifferentModel: boolean;
  selectedSeasonCount: number;
  rendererData: AiNotebookRendererData;
  actions: AiNotebookActionHandlers;
  onCancel: () => void;
}

const QUICK_START_PROMPTS = [
  'Tìm ngày cao điểm của tháng 6 và điểm bất thường so với các ngày còn lại.',
  'Top 10 route có PAX cao nhất trong tháng 3.',
  'So sánh tần suất VN Airlines giữa S25 và S26.',
];

const PLACEHOLDERS = [
  'Ví dụ: tìm ngày cao điểm của tháng 6 và điểm bất thường',
  'Ví dụ: top 10 route có PAX cao nhất trong tháng 3',
  'Ví dụ: so sánh tần suất VN Airlines giữa S25 và S26',
];

const LOADING_STEPS: Array<{ id: AiNotebookLoadingStep; label: string; icon: string }> = [
  { id: 'context', label: 'Chuẩn bị context', icon: 'dataset' },
  { id: 'provider', label: 'Gọi AI', icon: 'auto_awesome' },
  { id: 'query', label: 'Truy vấn dữ liệu', icon: 'database' },
  { id: 'render', label: 'Render chat', icon: 'dashboard_customize' },
];

function formatRelativeTime(timestamp: number): string {
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return 'vừa xong';
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `${days} ngày trước`;
}

function friendlyAiError(message: string): string {
  const normalized = message.toLowerCase();
  if (/auth|jwt|permission|unauthorized|forbidden|operator/.test(normalized)) {
    return 'Tài khoản hiện tại chưa có quyền chạy AI hoặc phiên đăng nhập đã hết hạn.';
  }
  if (/rate|429|quota|limit/.test(normalized)) {
    return 'Provider AI đang giới hạn lượt gọi. Hãy thử lại sau hoặc dùng model khác.';
  }
  if (/network|fetch|failed to fetch|timeout|timed out|503|504/.test(normalized)) {
    return 'Kết nối tới AI hoặc Supabase đang chậm. Hãy thử lại yêu cầu này.';
  }
  if (/schema|reporting|query|database|invalid schema/.test(normalized)) {
    return 'Truy vấn dữ liệu dashboard gặp lỗi. Kiểm tra migration/reporting view rồi thử lại.';
  }
  if (/model|provider|api key|key/.test(normalized)) {
    return 'Cấu hình model hoặc provider AI chưa sẵn sàng.';
  }
  return message || 'AI chưa xử lý được yêu cầu này.';
}

function LoadingNotebookCell({
  message,
  step,
  startedAt,
  onCancel,
}: {
  message: string;
  step: AiNotebookLoadingStep;
  startedAt: number | null;
  onCancel: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const activeIndex = Math.max(0, LOADING_STEPS.findIndex((item) => item.id === step));

  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <article className="rounded-lg border border-surface-variant bg-surface-container-low p-4 text-sm text-on-surface">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase text-on-surface-variant">AI</div>
          <div aria-live="polite" className="mt-1 flex items-center gap-2 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin text-[18px]">sync</span>
            {message}
            <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold">{elapsedSeconds}s</span>
          </div>
        </div>
        <button
          type="button"
          data-testid="ai-notebook-cancel"
          onClick={onCancel}
          className="inline-flex min-h-10 items-center gap-1 rounded-md border border-outline-variant bg-surface px-3 py-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container"
        >
          <span className="material-symbols-outlined text-[15px]">cancel</span>
          Hủy
        </button>
      </div>
      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        {LOADING_STEPS.map((item, index) => {
          const isDone = index < activeIndex;
          const isActive = index === activeIndex;
          return (
            <div key={item.id} className={`rounded-md border px-3 py-2 text-xs font-semibold ${isDone || isActive ? 'border-primary bg-primary-container/40 text-on-surface' : 'border-outline-variant bg-surface text-on-surface-variant'}`}>
              <span className="material-symbols-outlined mr-1 align-[-3px] text-[15px]">{isDone ? 'check_circle' : item.icon}</span>
              {item.label}
            </div>
          );
        })}
      </div>
      <div className="grid gap-3 animate-pulse">
        <div className="grid gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <span key={index} className="h-14 rounded-md bg-surface-variant/70" />)}
        </div>
        <span className="h-40 rounded-md bg-surface-variant/70" />
        <div className="rounded-md border border-surface-variant bg-surface">
          {Array.from({ length: 4 }).map((_, index) => <span key={index} className="block h-9 border-b border-surface-variant last:border-b-0" />)}
        </div>
      </div>
    </article>
  );
}

function NotebookPromptComposer({
  aiPrompt,
  setAiPrompt,
  disabled,
  aiLoading,
  onSubmit,
  onCancel,
}: {
  aiPrompt: string;
  setAiPrompt: (value: string) => void;
  disabled: boolean;
  aiLoading: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const placeholder = PLACEHOLDERS[placeholderIndex] ?? PLACEHOLDERS[0];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPlaceholderIndex((current) => (current + 1) % PLACEHOLDERS.length);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 42), 132)}px`;
  }, [aiPrompt]);

  return (
    <form
      data-testid="ai-notebook-prompt-composer"
      className="sticky bottom-3 z-20 mt-4 rounded-lg border border-surface-variant bg-surface-container-lowest/95 p-2 shadow-lg backdrop-blur"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex gap-2">
        <textarea
          ref={textareaRef}
          value={aiPrompt}
          onChange={(event) => setAiPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          className="max-h-32 min-h-[42px] min-w-0 flex-1 resize-none rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          aria-label="Nhập yêu cầu AI"
        />
        {aiLoading ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
          >
            Hủy
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || aiPrompt.trim().length === 0}
            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:outline-none focus:ring-2 focus:ring-primary hover:bg-primary-container hover:text-on-primary-container disabled:cursor-not-allowed disabled:opacity-50"
          >
            Gửi
          </button>
        )}
      </div>
      <div className="mt-1 text-[11px] text-on-surface-variant">Ctrl+Enter để gửi, Shift+Enter để xuống dòng.</div>
    </form>
  );
}

function AiNotebookCellView({
  cell,
  index,
  isLatest,
  rendererData,
  actions,
  collapsed,
  promptExpanded,
  onToggleCollapsed,
  onTogglePrompt,
}: {
  cell: DashboardAiNotebookCell;
  index: number;
  isLatest: boolean;
  rendererData: AiNotebookRendererData;
  actions: AiNotebookActionHandlers;
  collapsed: boolean;
  promptExpanded: boolean;
  onToggleCollapsed: () => void;
  onTogglePrompt: () => void;
}) {
  const visibleToolTraces = cell.toolTraceSummary.filter(isDashboardAiToolTraceVisible);
  const continuationLabel = cell.activeArtifact && cell.activeArtifact.sourceCellId !== cell.id
    ? `Tiếp nối #${cell.activeArtifact.sourceCellIndex ?? '?'}: ${cell.activeArtifact.summaryVi}`
    : null;

  return (
    <article data-testid="ai-rich-chat-message" className={`assistant rich rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm ${isLatest ? 'ring-1 ring-primary/20' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-on-surface-variant">
            <span className="rounded-full bg-surface px-2 py-0.5">#{index + 1}</span>
            <span>{formatRelativeTime(cell.createdAt)}</span>
            {cell.modelId && <span>Model: {cell.modelId}</span>}
            {continuationLabel && <span className="rounded-full bg-primary-container px-2 py-0.5 text-on-primary-container">{continuationLabel}</span>}
          </div>
          <button
            type="button"
            onClick={onTogglePrompt}
            className="user bubble mb-2 ml-auto inline-flex min-h-10 max-w-full items-center gap-2 rounded-2xl bg-primary px-3 py-2 text-left text-xs font-semibold text-on-primary shadow-sm focus:outline-none focus:ring-2 focus:ring-primary sm:max-w-[82%]"
          >
            <span className="material-symbols-outlined text-[15px]">person</span>
            <span className={promptExpanded ? 'whitespace-normal' : 'line-clamp-2'}>{cell.prompt}</span>
          </button>
          {!collapsed && cell.assistantText && renderRichMarkdown(cell.assistantText)}
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            title={collapsed ? 'Mở rộng trả lời' : 'Thu gọn trả lời'}
            aria-label={collapsed ? 'Mở rộng trả lời' : 'Thu gọn trả lời'}
          >
            <span className="material-symbols-outlined text-[15px]">{collapsed ? 'expand_more' : 'expand_less'}</span>
          </button>
          <button
            type="button"
            onClick={() => actions.duplicatePrompt(cell)}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            title="Dùng lại prompt"
            aria-label="Dùng lại prompt"
          >
            <span className="material-symbols-outlined text-[15px]">content_copy</span>
          </button>
          <button
            type="button"
            onClick={() => actions.onPinContext(cell)}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-outline-variant bg-surface px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            title="Tiếp tục từ cell này"
            aria-label="Tiếp tục từ cell này"
          >
            <span className="material-symbols-outlined text-[15px]">push_pin</span>
          </button>
          <button
            type="button"
            onClick={() => actions.deleteCell(cell.id)}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
            title="Xóa phản hồi"
            aria-label="Xóa phản hồi"
          >
            <span className="material-symbols-outlined text-[15px]">delete</span>
          </button>
        </div>
      </div>

      {!collapsed && (visibleToolTraces.length > 0 || cell.exportAction) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {visibleToolTraces.map((trace) => (
            <span key={`${cell.id}-${trace.tool}-${trace.status}-${trace.reason ?? ''}`} className="rounded-full border border-outline-variant bg-surface px-2 py-1 font-semibold text-on-surface-variant">
              {trace.tool}: {trace.reason ?? trace.status}
            </span>
          ))}
          {cell.exportAction && (
            <button
              type="button"
            onClick={() => actions.downloadExport(cell.exportAction as DashboardAiExportAction)}
              className="inline-flex min-h-10 items-center gap-1 rounded-md bg-primary px-3 py-2 font-semibold text-on-primary focus:outline-none focus:ring-2 focus:ring-primary hover:bg-primary-container hover:text-on-primary-container"
            >
              <span className="material-symbols-outlined text-[15px]">download</span>
              Tải Excel
            </button>
          )}
        </div>
      )}

      {!collapsed && cell.blocks.length > 0 && (
        <div className="mt-4 grid gap-3">
          {cell.blocks.map((block, blockIndex, blocks) => (
            <AiNotebookBlockCard
              key={block.id}
              block={block}
              cellId={cell.id}
              index={blockIndex}
              totalBlocks={blocks.length}
              rendererData={rendererData}
              actions={actions}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function AiNotebookCanvas({
  notebook,
  aiPrompt,
  setAiPrompt,
  aiLoading,
  aiLoadingMessage,
  aiLoadingStep,
  aiLoadingStartedAt,
  aiError,
  lastAiPrompt,
  aiConfigured,
  canTryDifferentModel,
  selectedSeasonCount,
  rendererData,
  actions,
  onCancel,
}: AiNotebookCanvasProps) {
  const [collapsedCellIds, setCollapsedCellIds] = useState<Set<string>>(new Set());
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(new Set());
  const cells = notebook?.cells ?? [];

  return (
    <section data-testid="ai-rich-chat-canvas" data-render-phase="rendered_rich_chat" className="min-h-[680px] rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
      <style>{'@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}'}</style>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-on-surface">{notebook?.title ?? 'Rich Chat AI'}</h2>
          <p className="mt-1 text-xs text-on-surface-variant">
            {selectedSeasonCount > 0 ? 'Mùa chung toàn app, lưu lịch sử chat local' : 'Chưa có mùa chung toàn app, lưu lịch sử chat local'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void actions.submitPrompt('Tạo rich chat gồm KPI, bảng, biểu đồ và nhận định.'); }}
          disabled={aiLoading || !aiConfigured}
          className="inline-flex min-h-10 items-center gap-1 rounded-md border border-outline-variant bg-surface px-3 py-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-[15px]">dashboard_customize</span>
          Tạo nhanh
        </button>
      </div>

      {aiError && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100">
          <div className="flex gap-2">
            <span className="material-symbols-outlined text-[16px]">warning</span>
            <span>{friendlyAiError(aiError)}</span>
          </div>
          <details className="mt-2 rounded border border-red-200/80 bg-white/60 px-2 py-1.5 dark:border-red-800/70 dark:bg-black/20">
            <summary className="cursor-pointer select-none font-semibold text-red-900 focus:outline-none focus:ring-2 focus:ring-red-500 dark:text-red-100">
              Chi tiết kỹ thuật
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-red-100/70 p-2 font-mono text-[11px] leading-relaxed text-red-950 dark:bg-red-950/70 dark:text-red-50">
              {aiError}
            </pre>
          </details>
          {lastAiPrompt && aiConfigured && (
            <div className="mt-2 flex flex-wrap gap-3">
              <button type="button" onClick={() => { void actions.retryPrompt(lastAiPrompt); }} disabled={aiLoading} className="font-semibold underline disabled:opacity-50">
                Thử lại
              </button>
              <button type="button" onClick={() => { void actions.tryDifferentModel(lastAiPrompt); }} disabled={aiLoading || !canTryDifferentModel} className="font-semibold underline disabled:opacity-50">
                Thử model khác
              </button>
            </div>
          )}
        </div>
      )}

      {!aiConfigured && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          Thêm model đang bật trong Settings &gt; AI Analysis, rồi rotate provider key bằng tài khoản AI admin.
        </div>
      )}

      <div className="grid gap-4">
        {cells.length === 0 && !aiLoading && (
          <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-4 py-8 text-center text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl text-primary">auto_awesome</span>
            <div className="mt-2 font-semibold text-on-surface">Bắt đầu bằng một câu hỏi dữ liệu</div>
            <div className="mt-1">AI có thể tạo bảng, biểu đồ, rich markdown và workbook Excel inline.</div>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {QUICK_START_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => { void actions.submitPrompt(prompt); }}
                  disabled={aiLoading || !aiConfigured}
                  className="min-h-10 rounded-full border border-outline-variant bg-surface px-3 py-2 text-xs font-semibold text-on-surface focus:outline-none focus:ring-2 focus:ring-primary hover:bg-surface-container disabled:opacity-40"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {cells.map((cell, index) => (
          <AiNotebookCellView
            key={cell.id}
            cell={cell}
            index={index}
            isLatest={index === cells.length - 1}
            rendererData={rendererData}
            actions={actions}
            collapsed={collapsedCellIds.has(cell.id)}
            promptExpanded={expandedPromptIds.has(cell.id)}
            onToggleCollapsed={() => setCollapsedCellIds((current) => {
              const next = new Set(current);
              if (next.has(cell.id)) next.delete(cell.id);
              else next.add(cell.id);
              return next;
            })}
            onTogglePrompt={() => setExpandedPromptIds((current) => {
              const next = new Set(current);
              if (next.has(cell.id)) next.delete(cell.id);
              else next.add(cell.id);
              return next;
            })}
          />
        ))}
        {aiLoading && (
          <LoadingNotebookCell
            key={aiLoadingStartedAt ?? 'loading'}
            message={aiLoadingMessage}
            step={aiLoadingStep}
            startedAt={aiLoadingStartedAt}
            onCancel={onCancel}
          />
        )}
      </div>

      <NotebookPromptComposer
        aiPrompt={aiPrompt}
        setAiPrompt={setAiPrompt}
        disabled={aiLoading || !aiConfigured}
        aiLoading={aiLoading}
        onSubmit={() => { void actions.submitPrompt(); }}
        onCancel={onCancel}
      />
    </section>
  );
}
