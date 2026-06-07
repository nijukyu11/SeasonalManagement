import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, jsonResponse } from '../_shared/cors.ts';

type AiProvider = 'gemini' | 'openai-compatible' | 'deepseek';

interface RotateKeyBody {
  provider?: AiProvider;
  apiKey?: string;
}

const SECRET_BY_PROVIDER: Record<AiProvider, string> = {
  gemini: 'DASHBOARD_AI_GEMINI_API_KEY',
  'openai-compatible': 'DASHBOARD_AI_OPENAI_COMPATIBLE_API_KEY',
  deepseek: 'DASHBOARD_AI_DEEPSEEK_API_KEY',
};
const FUNCTION_NAME = 'rotate-dashboard-ai-key';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const { data: operator, error: operatorError } = await supabase
      .from('app_operators')
      .select('can_manage_ai')
      .eq('user_id', userData.user.id)
      .maybeSingle();
    if (operatorError) return jsonResponse({ error: operatorError.message }, 500);
    if (operator?.can_manage_ai !== true) return jsonResponse({ error: 'can_manage_ai permission is required' }, 403);

    const body = await req.json() as RotateKeyBody;
    const provider = body.provider;
    const apiKey = body.apiKey?.trim() ?? '';
    if (provider !== 'gemini' && provider !== 'openai-compatible' && provider !== 'deepseek') {
      return jsonResponse({ error: 'Unsupported AI provider' }, 400);
    }
    if (!apiKey) return jsonResponse({ error: 'Provider API key is required' }, 400);

    const managementToken = Deno.env.get('DASHBOARD_AI_MANAGEMENT_ACCESS_TOKEN');
    const projectRef = Deno.env.get('DASHBOARD_AI_PROJECT_REF');
    if (!managementToken || !projectRef) {
      return jsonResponse({ error: 'Supabase Management API secret configuration is missing' }, 500);
    }

    const secretName = SECRET_BY_PROVIDER[provider];
    const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${managementToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ name: secretName, value: apiKey }]),
    });
    if (!response.ok) {
      const message = await readManagementApiError(response);
      return jsonResponse({ error: message }, response.status);
    }

    return jsonResponse({
      provider,
      keyUpdatedAt: Date.now(),
      secretName,
      functionName: FUNCTION_NAME,
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'AI key rotation failed' }, 500);
  }
});

async function readManagementApiError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    if (payload && typeof payload === 'object') {
      const root = payload as Record<string, unknown>;
      if (typeof root.message === 'string') return root.message;
      if (typeof root.error === 'string') return root.error;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Supabase Management API returned HTTP ${response.status}`;
}
