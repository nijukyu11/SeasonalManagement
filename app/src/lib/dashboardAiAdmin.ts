import { getSupabaseClient } from './supabase';
import type { AiAnalysisProvider, AiAnalysisProviderKeyStatus } from './types';

export interface DashboardAiOperatorAccess {
  canManageAi: boolean;
  canUseAi: boolean;
}

export interface DashboardAiProviderKeySyncInput {
  provider: AiAnalysisProvider;
  apiKey: string;
}

export interface DashboardAiProviderKeySyncResult {
  provider: AiAnalysisProvider;
  keyUpdatedAt: number;
  keyFingerprint: string;
}

export type DashboardAiKeyRotationInput = DashboardAiProviderKeySyncInput;
export type DashboardAiKeyRotationResult = DashboardAiProviderKeySyncResult;

export async function getDashboardAiOperatorAccess(): Promise<DashboardAiOperatorAccess> {
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  if (!userData.user) return { canManageAi: false, canUseAi: false };

  const { data, error } = await supabase
    .from('app_operators')
    .select('can_manage_ai,can_use_ai')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const canManageAi = data?.can_manage_ai === true;
  return { canManageAi, canUseAi: canManageAi || data?.can_use_ai === true };
}

export async function syncDashboardAiProviderKey(input: DashboardAiProviderKeySyncInput): Promise<DashboardAiProviderKeySyncResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error('Provider API key is required.');
  const supabase = getSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  if (!userData.user) throw new Error('Operator login is required to sync AI provider keys.');
  const keyUpdatedAt = Date.now();
  const keyFingerprint = await buildProviderKeyFingerprint(apiKey);
  const { data: rpcData, error: rpcError } = await supabase.rpc('sync_ai_provider_key', {
    p_provider: input.provider,
    p_secret_value: apiKey,
    p_key_fingerprint: keyFingerprint,
    p_updated_at: keyUpdatedAt,
  });
  if (rpcError && !isMissingRpcError(rpcError.message)) throw new Error(rpcError.message);
  if (!rpcError) {
    const payload = parseRpcObject(rpcData);
    if (payload.ok !== true) throw new Error(providerKeyRpcReason(payload.reason, input.provider));
  } else {
    const { error } = await supabase
      .from('operational_ai_provider_keys')
      .upsert(
        {
          provider: input.provider,
          secret_value: apiKey,
          key_fingerprint: keyFingerprint,
          updated_at: keyUpdatedAt,
          updated_by: userData.user.id,
        },
        { onConflict: 'provider' }
      );
    if (error) throw new Error(error.message);
  }
  return {
    provider: input.provider,
    keyUpdatedAt,
    keyFingerprint,
  };
}

export async function listDashboardAiProviderKeyStatus(): Promise<AiAnalysisProviderKeyStatus[]> {
  const supabase = getSupabaseClient();
  const { data: rpcData, error: rpcError } = await supabase.rpc('list_ai_provider_key_status');
  if (!rpcError) {
    const payload = parseRpcObject(rpcData);
    if (payload.ok !== true) throw new Error(providerKeyRpcReason(payload.reason, 'gemini'));
    return normalizeProviderKeyStatusRows(payload.items);
  }
  if (!isMissingRpcError(rpcError.message)) throw new Error(rpcError.message);
  const { data, error } = await supabase
    .from('operational_ai_provider_keys')
    .select('provider,key_fingerprint,updated_at,updated_by')
    .order('provider', { ascending: true });
  if (error) throw new Error(error.message);
  return normalizeProviderKeyStatusRows((data ?? []).map((row) => ({
    provider: row.provider,
    keyFingerprint: row.key_fingerprint,
    keyUpdatedAt: row.updated_at,
    updatedBy: row.updated_by,
  })));
}

export async function fetchDashboardAiProviderKey(provider: AiAnalysisProvider): Promise<string> {
  const supabase = getSupabaseClient();
  const { data: rpcData, error: rpcError } = await supabase.rpc('fetch_ai_provider_key', { p_provider: provider });
  if (!rpcError) {
    const payload = parseRpcObject(rpcData);
    if (payload.ok === true) {
      const value = typeof payload.secretValue === 'string' ? payload.secretValue.trim() : '';
      if (value) return value;
    }
    const statuses = await safeListProviderKeyStatus();
    throw new Error(buildProviderKeyError(provider, payload.reason, statuses));
  }
  if (!isMissingRpcError(rpcError.message)) throw new Error(rpcError.message);
  const { data, error } = await supabase
    .from('operational_ai_provider_keys')
    .select('secret_value')
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const value = typeof data?.secret_value === 'string' ? data.secret_value.trim() : '';
  if (!value) {
    const statuses = await safeListProviderKeyStatus();
    throw new Error(buildProviderKeyError(provider, 'provider_key_not_synced', statuses));
  }
  return value;
}

export async function rotateDashboardAiProviderKey(input: DashboardAiKeyRotationInput): Promise<DashboardAiKeyRotationResult> {
  return syncDashboardAiProviderKey(input);
}

function normalizeProviderKeyStatusRows(rows: unknown): AiAnalysisProviderKeyStatus[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const item = row as Record<string, unknown>;
    const provider = item.provider;
    if (!isAiAnalysisProvider(provider)) return [];
    const keyUpdatedAt = Number(item.keyUpdatedAt ?? 0);
    return [{
      provider,
      keyFingerprint: typeof item.keyFingerprint === 'string' ? item.keyFingerprint : '',
      keyUpdatedAt: Number.isFinite(keyUpdatedAt) ? keyUpdatedAt : 0,
      updatedBy: typeof item.updatedBy === 'string' ? item.updatedBy : null,
    }];
  });
}

async function safeListProviderKeyStatus(): Promise<AiAnalysisProviderKeyStatus[]> {
  try {
    return await listDashboardAiProviderKeyStatus();
  } catch {
    return [];
  }
}

function parseRpcObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isMissingRpcError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('function') && normalized.includes('does not exist');
}

function providerKeyRpcReason(reason: unknown, provider: AiAnalysisProvider): string {
  if (reason === 'operator_missing_can_manage_ai') {
    return 'Operator hiện tại chưa có quyền can_manage_ai để lưu/sync provider key.';
  }
  if (reason === 'operator_missing_can_use_ai') {
    return 'Operator hiện tại chưa có quyền can_use_ai để tải provider key về máy local.';
  }
  if (reason === 'provider_key_not_synced') {
    return `Chưa sync ${providerLabel(provider)} API key. Vào Settings > AI Analysis > Save & Sync Local Provider Key.`;
  }
  if (reason === 'invalid_provider') return `Provider AI không hợp lệ: ${provider}.`;
  if (reason === 'empty_secret') return 'Provider API key is required.';
  return `Không đọc được provider key cho ${providerLabel(provider)}.`;
}

function buildProviderKeyError(
  provider: AiAnalysisProvider,
  reason: unknown,
  statuses: AiAnalysisProviderKeyStatus[]
): string {
  const base = providerKeyRpcReason(reason, provider);
  const syncedProviders = statuses
    .filter((status) => status.keyFingerprint)
    .map((status) => providerLabel(status.provider));
  if (syncedProviders.length === 0 || reason === 'operator_missing_can_use_ai') return base;
  return `${base} Provider đã có key: ${syncedProviders.join(', ')}. Hãy chọn model tương ứng hoặc sync key cho ${providerLabel(provider)}.`;
}

async function buildProviderKeyFingerprint(apiKey: string): Promise<string> {
  const normalized = apiKey.trim();
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex.slice(0, 12)}`;
  } catch {
    return `len${normalized.length}:${normalized.slice(-4)}`;
  }
}

function isAiAnalysisProvider(provider: unknown): provider is AiAnalysisProvider {
  return provider === 'gemini' || provider === 'openai-compatible' || provider === 'deepseek';
}

function providerLabel(provider: AiAnalysisProvider): string {
  if (provider === 'deepseek') return 'DeepSeek';
  return provider === 'openai-compatible' ? 'OpenAI-compatible' : 'Gemini';
}
