'use client';

import type { Dispatch, SetStateAction } from 'react';
import type {
  AiAnalysisContextDocument,
  AiAnalysisContextDocumentKind,
  AiAnalysisModelSetting,
  AiAnalysisProvider,
  OperationalSettings,
} from '@/lib/types';
import { 
  AI_ANALYSIS_DEFAULT_CONTEXT_DOCUMENT_TEMPLATES, 
  AI_CONTEXT_DOCUMENT_MAX_CHARS, 
  AI_CONTEXT_DOCUMENT_MAX_COUNT, 
  buildDefaultAiAnalysisContextDocuments, 
} from '@/lib/settingsRules'; 
import { DeleteIconButton } from './SettingsTabControls';

type AiAnalysisTabProps = {
  settings: OperationalSettings;
  setSettings: Dispatch<SetStateAction<OperationalSettings>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  currentTimestamp: () => number;
  aiModelLabel: string;
  setAiModelLabel: Dispatch<SetStateAction<string>>;
  aiModelProvider: AiAnalysisProvider;
  setAiModelProvider: Dispatch<SetStateAction<AiAnalysisProvider>>;
  aiModelName: string;
  setAiModelName: Dispatch<SetStateAction<string>>;
  aiModelBaseUrl: string;
  setAiModelBaseUrl: Dispatch<SetStateAction<string>>;
  aiKeyProvider: AiAnalysisProvider;
  setAiKeyProvider: Dispatch<SetStateAction<AiAnalysisProvider>>;
  aiKeyValue: string;
  setAiKeyValue: Dispatch<SetStateAction<string>>;
  aiKeyRotating: boolean;
  canManageAi: boolean;
  canUseAi: boolean;
  defaultModelNameForAiProvider: (provider: AiAnalysisProvider) => string;
  defaultBaseUrlForAiProvider: (provider: AiAnalysisProvider) => string;
  addAiModel: () => void;
  updateAiModel: (modelId: string, patch: Partial<AiAnalysisModelSetting>) => void;
  deleteAiModel: (modelId: string) => void;
  rotateAiProviderKey: () => Promise<void>;
};

const DOCUMENT_KIND_LABELS: Record<AiAnalysisContextDocumentKind, string> = {
  rule: 'Rules',
  skill: 'Skills',
};

function markdownTitleFromFileName(fileName: string): string {
  return fileName.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled markdown';
}

function sortContextDocuments(documents: AiAnalysisContextDocument[]): AiAnalysisContextDocument[] {
  return [...documents].sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.sortOrder - b.sortOrder ||
    a.title.localeCompare(b.title)
  );
}

export default function AiAnalysisTab({
  settings,
  setSettings,
  setStatus,
  currentTimestamp,
  aiModelLabel,
  setAiModelLabel,
  aiModelProvider,
  setAiModelProvider,
  aiModelName,
  setAiModelName,
  aiModelBaseUrl,
  setAiModelBaseUrl,
  aiKeyProvider,
  setAiKeyProvider,
  aiKeyValue,
  setAiKeyValue,
  aiKeyRotating,
  canManageAi,
  canUseAi,
  defaultModelNameForAiProvider,
  defaultBaseUrlForAiProvider,
  addAiModel,
  updateAiModel,
  deleteAiModel,
  rotateAiProviderKey,
}: AiAnalysisTabProps) {
  const contextDocuments = sortContextDocuments(settings.aiAnalysis.contextDocuments ?? []);
  const updateContextDocuments = (nextDocuments: AiAnalysisContextDocument[], status: string) => {
    const now = currentTimestamp();
    setSettings((current) => ({
      ...current,
      aiAnalysis: {
        ...current.aiAnalysis,
        contextDocuments: nextDocuments.map((document, index) => ({
          ...document,
          sortOrder: document.sortOrder ?? index,
          updatedAt: document.updatedAt || now,
        })),
        updatedAt: now,
      },
      updatedAt: now,
    }));
    setStatus(status);
  };
  const updateContextDocument = (documentId: string, patch: Partial<AiAnalysisContextDocument>) => {
    const now = currentTimestamp();
    updateContextDocuments(
      contextDocuments.map((document) =>
        document.id === documentId ? { ...document, ...patch, updatedAt: now } : document
      ),
      'Unsaved AI Rules/Skills change'
    );
  };
  const addContextDocument = (kind: AiAnalysisContextDocumentKind) => {
    if (contextDocuments.length >= AI_CONTEXT_DOCUMENT_MAX_COUNT) {
      setStatus(`Rules/Skills limit reached (${AI_CONTEXT_DOCUMENT_MAX_COUNT} documents)`);
      return;
    }
    const now = currentTimestamp();
    const sameKindCount = contextDocuments.filter((document) => document.kind === kind).length;
    const document: AiAnalysisContextDocument = {
      id: `ai-${kind}-${now}`,
      kind,
      title: kind === 'rule' ? `Rule ${sameKindCount + 1}` : `Skill ${sameKindCount + 1}`,
      contentMd: '',
      enabled: true,
      sortOrder: sameKindCount,
      createdAt: now,
      updatedAt: now,
    };
    updateContextDocuments([...contextDocuments, document], `Unsaved new AI ${kind}`);
  };
  const deleteContextDocument = (documentId: string) => {
    updateContextDocuments(contextDocuments.filter((document) => document.id !== documentId), 'Unsaved AI Rules/Skills deletion');
  };
  const moveContextDocument = (documentId: string, direction: -1 | 1) => {
    const target = contextDocuments.find((document) => document.id === documentId);
    if (!target) return;
    const sameKind = contextDocuments.filter((document) => document.kind === target.kind);
    const currentIndex = sameKind.findIndex((document) => document.id === documentId);
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= sameKind.length) return;
    const reorderedSameKind = [...sameKind];
    [reorderedSameKind[currentIndex], reorderedSameKind[nextIndex]] = [reorderedSameKind[nextIndex], reorderedSameKind[currentIndex]];
    const reordered = contextDocuments.map((document) => {
      if (document.kind !== target.kind) return document;
      const index = reorderedSameKind.findIndex((entry) => entry.id === document.id);
      return { ...document, sortOrder: index };
    });
    updateContextDocuments(reordered, 'Unsaved AI Rules/Skills order change');
  };
  const importMarkdownDocuments = async (kind: AiAnalysisContextDocumentKind, files: FileList | null) => { 
    if (!files || files.length === 0) return;
    const now = currentTimestamp();
    const nextDocuments = [...contextDocuments];
    let rejected = 0;
    for (const file of Array.from(files)) {
      if (nextDocuments.length >= AI_CONTEXT_DOCUMENT_MAX_COUNT) {
        rejected += 1;
        continue;
      }
      if (!file.name.toLowerCase().endsWith('.md') || file.size > AI_CONTEXT_DOCUMENT_MAX_CHARS) {
        rejected += 1;
        continue;
      }
      const contentMd = (await file.text()).replace(/\u0000/g, '').slice(0, AI_CONTEXT_DOCUMENT_MAX_CHARS);
      const sameKindCount = nextDocuments.filter((document) => document.kind === kind).length;
      nextDocuments.push({
        id: `ai-${kind}-${now}-${sameKindCount}`,
        kind,
        title: markdownTitleFromFileName(file.name),
        contentMd,
        enabled: true,
        sortOrder: sameKindCount,
        createdAt: now,
        updatedAt: now,
      });
    }
    updateContextDocuments(nextDocuments, rejected > 0 ? `Imported markdown with ${rejected} rejected file(s)` : 'Unsaved imported AI markdown documents'); 
  }; 
  const installDefaultContextDocuments = () => { 
    const now = currentTimestamp(); 
    const existingIds = new Set(contextDocuments.map((document) => document.id)); 
    const defaults = buildDefaultAiAnalysisContextDocuments(now).filter((document) => !existingIds.has(document.id)); 
    if (defaults.length === 0) { 
      setStatus('Default AI EDA skill pack is already installed'); 
      return; 
    } 
    const availableSlots = Math.max(0, AI_CONTEXT_DOCUMENT_MAX_COUNT - contextDocuments.length); 
    const nextDefaults = defaults.slice(0, availableSlots); 
    updateContextDocuments([...contextDocuments, ...nextDefaults], availableSlots < defaults.length ? 'Unsaved default AI skill pack install; some documents skipped by limit' : 'Unsaved default AI EDA skill pack install'); 
  }; 
  const resetDefaultContextDocuments = () => { 
    const now = currentTimestamp(); 
    const defaultIds = new Set(AI_ANALYSIS_DEFAULT_CONTEXT_DOCUMENT_TEMPLATES.map((document) => document.id)); 
    const customDocuments = contextDocuments.filter((document) => !defaultIds.has(document.id)); 
    const defaults = buildDefaultAiAnalysisContextDocuments(now); 
    updateContextDocuments([...customDocuments, ...defaults].slice(0, AI_CONTEXT_DOCUMENT_MAX_COUNT), 'Unsaved default AI EDA skill pack reset'); 
  }; 
 
  const renderContextDocumentSection = (kind: AiAnalysisContextDocumentKind) => { 
    const documents = contextDocuments.filter((document) => document.kind === kind);
    return (
      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-surface-variant px-4 py-3">
          <div>
            <h2 className="font-title-md text-title-md text-on-surface">{DOCUMENT_KIND_LABELS[kind]}</h2>
            <p className="mt-1 text-sm text-on-surface-variant">
              {kind === 'rule'
                ? 'Markdown rules are injected as custom AI instructions for every provider.'
                : 'Markdown skills describe domain workflows the Dashboard AI can reference.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => addContextDocument(kind)} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container">
              <span className="material-symbols-outlined text-[18px]">add</span>
              {kind === 'rule' ? 'New Rule' : 'New Skill'}
            </button>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">upload_file</span>
              Import .md
              <input
                type="file"
                accept=".md,text/markdown,text/plain"
                multiple
                className="hidden"
                onChange={(event) => {
                  void importMarkdownDocuments(kind, event.target.files);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-outline-variant bg-surface-container px-3 py-2 text-xs font-semibold text-on-surface-variant">
            Max {AI_CONTEXT_DOCUMENT_MAX_COUNT} documents, {Math.round(AI_CONTEXT_DOCUMENT_MAX_CHARS / 1024)}KB per markdown file. Markdown is used only as prompt context; it does not create tools or permissions.
          </div>
          {documents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-outline-variant px-4 py-8 text-center text-sm text-on-surface-variant">
              No {DOCUMENT_KIND_LABELS[kind].toLowerCase()} yet. Create a blank markdown document or import a .md file.
            </div>
          ) : (
            documents.map((document, index) => (
              <div key={document.id} className="rounded-lg border border-outline-variant bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
                    <input type="checkbox" checked={document.enabled} onChange={(event) => updateContextDocument(document.id, { enabled: event.target.checked })} />
                    Enabled
                  </label>
                  <span className="rounded-full border border-outline-variant px-2 py-1 text-[10px] font-bold uppercase text-on-surface-variant">
                    {document.contentMd.length.toLocaleString()} chars
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" aria-label={`Move ${document.title} up`} onClick={() => moveContextDocument(document.id, -1)} disabled={index === 0} className="inline-flex size-9 items-center justify-center rounded-lg border border-outline-variant text-on-surface hover:bg-surface-container disabled:opacity-40">
                      <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                    </button>
                    <button type="button" aria-label={`Move ${document.title} down`} onClick={() => moveContextDocument(document.id, 1)} disabled={index === documents.length - 1} className="inline-flex size-9 items-center justify-center rounded-lg border border-outline-variant text-on-surface hover:bg-surface-container disabled:opacity-40">
                      <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
                    </button>
                    <DeleteIconButton label={`Delete ${document.title || DOCUMENT_KIND_LABELS[kind]}`} onClick={() => deleteContextDocument(document.id)} />
                  </div>
                </div>
                <label className="mt-3 block text-sm font-semibold text-on-surface">
                  Title
                  <input value={document.title} onChange={(event) => updateContextDocument(document.id, { title: event.target.value })} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                </label>
                <label className="mt-3 block text-sm font-semibold text-on-surface">
                  Markdown editor
                  <textarea
                    value={document.contentMd}
                    onChange={(event) => updateContextDocument(document.id, { contentMd: event.target.value.slice(0, AI_CONTEXT_DOCUMENT_MAX_CHARS) })}
                    rows={8}
                    spellCheck={false}
                    placeholder={kind === 'rule' ? 'Write durable AI rules in markdown...' : 'Describe a reusable analysis skill in markdown...'}
                    className="mt-1 min-h-48 w-full rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-sm leading-6 text-on-surface focus:border-primary focus:outline-none"
                  />
                </label>
              </div>
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="grid gap-5 xl:grid-cols-[360px_1fr]">
      <div className="space-y-5">
        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Add AI Model</h2>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Label
              <input value={aiModelLabel} onChange={(event) => setAiModelLabel(event.target.value)} placeholder="Gemini Flash" className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Provider
              <select
                value={aiModelProvider}
                onChange={(event) => {
                  const provider = event.target.value as AiAnalysisProvider;
                  setAiModelProvider(provider);
                  setAiModelName(defaultModelNameForAiProvider(provider));
                  setAiModelBaseUrl(defaultBaseUrlForAiProvider(provider));
                }}
                className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
              >
                <option value="gemini">Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              Provider model
              <input value={aiModelName} onChange={(event) => setAiModelName(event.target.value)} placeholder={defaultModelNameForAiProvider(aiModelProvider)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
            </label>
            {aiModelProvider !== 'gemini' && (
              <label className="block text-sm font-semibold text-on-surface">
                Base URL
                <input value={aiModelBaseUrl} onChange={(event) => setAiModelBaseUrl(event.target.value)} placeholder={defaultBaseUrlForAiProvider(aiModelProvider)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
              </label>
            )}
            <button type="button" onClick={addAiModel} className="inline-flex w-fit items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container">
              <span className="material-symbols-outlined text-[18px]">add</span>
              Add AI Model
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-surface-variant bg-surface-container-lowest p-4 shadow-sm">
          <h2 className="font-title-md text-title-md text-on-surface">Save & Sync Local Provider Key</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            Requires app_operators.can_manage_ai. Users with app_operators.can_use_ai can sync this key to local cache so the desktop Python agent calls providers directly from this machine.
          </p>
          <p className="mt-2 text-xs font-semibold text-on-surface-variant">
            Current operator: {canManageAi ? 'can_manage_ai' : 'no can_manage_ai'} · {canUseAi ? 'can_use_ai' : 'no can_use_ai'}
          </p>
          <div className="mt-4 grid gap-3">
            <label className="block text-sm font-semibold text-on-surface">
              Provider
              <select value={aiKeyProvider} onChange={(event) => setAiKeyProvider(event.target.value as AiAnalysisProvider)} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none">
                <option value="gemini">Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </label>
            <label className="block text-sm font-semibold text-on-surface">
              New API key
              <input type="password" value={aiKeyValue} onChange={(event) => setAiKeyValue(event.target.value)} disabled={!canManageAi || aiKeyRotating} placeholder={canManageAi ? 'Paste provider key for sync' : 'can_manage_ai required'} className="mt-1 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50" />
            </label>
            <button type="button" onClick={() => void rotateAiProviderKey()} disabled={!canManageAi || aiKeyRotating || aiKeyValue.trim().length === 0} className="inline-flex w-fit items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container disabled:cursor-not-allowed disabled:opacity-50">
              <span className={`material-symbols-outlined text-[18px] ${aiKeyRotating ? 'animate-spin' : ''}`}>{aiKeyRotating ? 'progress_activity' : 'key'}</span>
              {aiKeyRotating ? 'Syncing' : 'Save & Sync Key'}
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-surface-variant bg-surface-container-lowest shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-surface-variant px-4 py-3">
          <div>
            <h2 className="font-title-md text-title-md text-on-surface">AI Analysis Models</h2>
            <p className="mt-1 text-sm text-on-surface-variant">Dashboard desktop AI uses enabled runtime models through the local Python agent. The dashboard-ai-analysis Edge Function remains a legacy/web fallback.</p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
            <input
              type="checkbox"
              checked={settings.aiAnalysis.enabled}
              onChange={(event) => {
                const now = currentTimestamp();
                setSettings((current) => ({
                  ...current,
                  aiAnalysis: { ...current.aiAnalysis, enabled: event.target.checked, updatedAt: now },
                  updatedAt: now,
                }));
                setStatus('Unsaved AI Analysis change');
              }}
            />
            Enabled
          </label>
        </div>
        <div className="border-b border-surface-variant px-4 py-3">
          <label className="grid w-full max-w-md min-w-0 gap-1 text-sm font-semibold text-on-surface">
            Default dashboard model
            <select
              value={settings.aiAnalysis.activeModelId}
              onChange={(event) => {
                const now = currentTimestamp();
                setSettings((current) => ({
                  ...current,
                  aiAnalysis: { ...current.aiAnalysis, activeModelId: event.target.value, updatedAt: now },
                  updatedAt: now,
                }));
                setStatus('Unsaved AI Analysis default model change');
              }}
              className="block min-h-10 w-full min-w-[260px] max-w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
            >
              {settings.aiAnalysis.models.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="hidden grid-cols-[120px_160px_170px_minmax(180px,1fr)_100px_96px] gap-3 border-b border-surface-variant bg-surface-container px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-on-surface-variant xl:grid">
          <span>Label</span>
          <span>Provider</span>
          <span>Model</span>
          <span>Base URL</span>
          <span>Status</span>
          <span>Action</span>
        </div>
        {settings.aiAnalysis.models.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-on-surface-variant">No AI models configured</div>
        ) : (
          <div className="divide-y divide-surface-variant">
            {settings.aiAnalysis.models.map((model) => (
              <div key={model.id} className="grid gap-3 p-4 xl:grid-cols-[120px_160px_170px_minmax(180px,1fr)_100px_96px] xl:items-center">
                <input value={model.label} onChange={(event) => updateAiModel(model.id, { label: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm font-semibold focus:border-primary focus:outline-none" />
                <select
                  value={model.provider}
                  onChange={(event) => {
                    const provider = event.target.value as AiAnalysisProvider;
                    updateAiModel(model.id, {
                      provider,
                      baseUrl: provider === 'gemini' ? null : model.baseUrl ?? defaultBaseUrlForAiProvider(provider),
                    });
                  }}
                  className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none"
                >
                  <option value="gemini">Gemini</option>
                  <option value="openai-compatible">OpenAI-compatible</option>
                  <option value="deepseek">DeepSeek</option>
                </select>
                <input value={model.model} onChange={(event) => updateAiModel(model.id, { model: event.target.value })} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none" />
                <input value={model.baseUrl ?? ''} onChange={(event) => updateAiModel(model.id, { baseUrl: event.target.value })} disabled={model.provider === 'gemini'} placeholder={model.provider === 'gemini' ? 'Not used' : defaultBaseUrlForAiProvider(model.provider)} className="rounded-lg border border-outline-variant bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50" />
                <label className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface">
                  <input type="checkbox" checked={model.enabled} onChange={(event) => updateAiModel(model.id, { enabled: event.target.checked })} />
                  Enabled
                </label>
                <div className="flex items-center justify-end gap-2">
                  <span className="rounded-full border border-outline-variant px-2 py-1 text-[10px] font-bold uppercase text-on-surface-variant">{model.keyUpdatedAt ? 'Key set' : 'No key'}</span>
                  <DeleteIconButton label={`Delete ${model.label || 'AI model'}`} onClick={() => deleteAiModel(model.id)} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-5 xl:col-span-2 xl:grid-cols-2"> 
        <div className="rounded-lg border border-primary/30 bg-primary-container/20 p-4 shadow-sm xl:col-span-2"> 
          <div className="flex flex-wrap items-start justify-between gap-3"> 
            <div> 
              <h2 className="font-title-md text-title-md text-on-surface">Default AI EDA Skill Pack</h2> 
              <p className="mt-1 max-w-3xl text-sm text-on-surface-variant"> 
                Cài bộ Rules/Skills mặc định cho query-first EDA: schema contract, validated SQL, data quality, driver decomposition, visualization grammar, answer verification và safe rendering. Người dùng vẫn có thể sửa markdown trực tiếp sau khi cài. 
              </p> 
            </div> 
            <div className="flex flex-wrap gap-2"> 
              <button type="button" onClick={installDefaultContextDocuments} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:bg-primary-container hover:text-on-primary-container"> 
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span> 
                Install default pack 
              </button> 
              <button type="button" onClick={resetDefaultContextDocuments} className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-sm font-semibold text-on-surface hover:bg-surface-container"> 
                <span className="material-symbols-outlined text-[18px]">restart_alt</span> 
                Reset default pack 
              </button> 
            </div> 
          </div> 
        </div> 
        {renderContextDocumentSection('rule')} 
        {renderContextDocumentSection('skill')} 
      </div> 
    </section>
  );
}
