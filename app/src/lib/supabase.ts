import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
const AUTH_STORAGE_KEY = 'seasonal-management-supabase-auth-token';
const LEGACY_AUTH_STORAGE_KEYS = [
  'sb-rhmehiinfchiiuqmdukz-auth-token',
  'sb-supabase-auth-token',
];

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function boundSupabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function createAuthStorage() {
  return {
    getItem(key: string): string | null {
      if (typeof window === 'undefined') return null;
      const current = window.localStorage.getItem(key);
      if (current) return current;
      if (key !== AUTH_STORAGE_KEY) return null;
      for (const legacyKey of LEGACY_AUTH_STORAGE_KEYS) {
        const legacy = window.localStorage.getItem(legacyKey);
        if (legacy) return legacy;
      }
      return null;
    },
    setItem(key: string, value: string): void {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(key, value);
      if (key === AUTH_STORAGE_KEY) {
        for (const legacyKey of LEGACY_AUTH_STORAGE_KEYS) {
          window.localStorage.removeItem(legacyKey);
        }
      }
    },
    removeItem(key: string): void {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(key);
      if (key === AUTH_STORAGE_KEY) {
        for (const legacyKey of LEGACY_AUTH_STORAGE_KEYS) {
          window.localStorage.removeItem(legacyKey);
        }
      }
    },
  };
}

export async function invokeSupabaseFunction<T>(functionName: string, body?: unknown): Promise<T> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }

  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token ?? anonKey;
  const functionUrl = `${url.replace(/\/+$/, '')}/functions/v1/${functionName}`;
  const response = await boundSupabaseFetch(functionUrl, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');

  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? response.statusText)
      : String(payload || response.statusText);
    throw new Error(`${functionName}: ${message}`);
  }

  return (payload ?? {}) as T;
}

export function getSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.');
  }
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: AUTH_STORAGE_KEY,
        storage: createAuthStorage(),
      },
      global: {
        fetch: boundSupabaseFetch,
      },
    });
  }
  return client;
}
