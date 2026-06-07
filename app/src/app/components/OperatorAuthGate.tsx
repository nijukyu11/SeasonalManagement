'use client';

import type { Session } from '@supabase/supabase-js';
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getSupabaseClient } from '@/lib/supabase';

type OperatorAuthStatus = 'checking' | 'signedOut' | 'authorized' | 'unauthorized';

type OperatorAuthContextValue = {
  enabled: boolean;
  email: string | null;
  signingOut: boolean;
  signOut: () => Promise<void>;
};

const OperatorAuthContext = createContext<OperatorAuthContextValue>({
  enabled: false,
  email: null,
  signingOut: false,
  signOut: async () => {},
});

function isSupabaseBackendEnabled(): boolean {
  const backend = process.env.NEXT_PUBLIC_REMOTE_BACKEND?.toLowerCase();
  return backend === 'supabase';
}

export function useOperatorAuth(): OperatorAuthContextValue {
  return useContext(OperatorAuthContext);
}

function OperatorAuthScreen({
  status,
  errorMessage,
  onSubmit,
  onSignOut,
  busy,
}: {
  status: Exclude<OperatorAuthStatus, 'authorized'>;
  errorMessage: string | null;
  onSubmit: (email: string, password: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  busy: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSubmit(email.trim(), password);
  }, [email, onSubmit, password]);

  if (status === 'checking') {
    return (
      <main className="operator-auth-screen flex items-center justify-center bg-slate-950 px-6 text-white">
        <div className="operator-auth-card rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-[28px] text-cyan-300">flight_takeoff</span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Seasonal Management</h1>
              <p className="text-sm text-slate-400">Checking operator session</p>
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-cyan-300" />
          </div>
        </div>
      </main>
    );
  }

  if (status === 'unauthorized') {
    return (
      <main className="operator-auth-screen flex items-center justify-center bg-slate-950 px-6 text-white">
        <section className="operator-auth-card-wide rounded-lg border border-amber-400/30 bg-slate-900 p-6 shadow-2xl">
          <div className="mb-5 flex items-start gap-3">
            <span className="material-symbols-outlined mt-0.5 text-[26px] text-amber-300">lock</span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Operator access required</h1>
              <p className="mt-1 text-sm leading-6 text-slate-300">
                Operator access is not enabled for this account. Add this Auth user to public.app_operators, then sign in again.
              </p>
            </div>
          </div>
          {errorMessage && (
            <p className="mb-4 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
              {errorMessage}
            </p>
          )}
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
          >
            <span className="material-symbols-outlined text-[19px]">logout</span>
            Sign out
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="operator-auth-screen flex items-center justify-center bg-slate-950 px-6 text-white">
      <section className="operator-auth-card rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-6">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-cyan-300 text-slate-950">
            <span className="material-symbols-outlined text-[26px]">flight_takeoff</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Seasonal Management</h1>
          <p className="mt-1 text-sm text-slate-400">Sign in with your operator account</p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-200">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="operator-auth-control h-11 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-300"
              placeholder="operator@example.com"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-200">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="operator-auth-control h-11 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-300"
              placeholder="Password"
            />
          </label>

          {errorMessage && (
            <p className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            className="operator-auth-control inline-flex h-11 items-center justify-center gap-2 rounded-md bg-cyan-300 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
          >
            <span className="material-symbols-outlined text-[19px]">login</span>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

export default function OperatorAuthGate({ children }: { children: ReactNode }) {
  const enabled = isSupabaseBackendEnabled();
  const refreshIdRef = useRef(0);
  const [status, setStatus] = useState<OperatorAuthStatus>(enabled ? 'checking' : 'authorized');
  const [email, setEmail] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const refreshSession = useCallback(async (session: Session | null) => {
    if (!enabled) return;

    const refreshId = refreshIdRef.current + 1;
    refreshIdRef.current = refreshId;
    setErrorMessage(null);

    if (!session?.user) {
      setEmail(null);
      setStatus('signedOut');
      return;
    }

    setStatus('checking');
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('app_operators')
      .select('user_id,email')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (refreshId !== refreshIdRef.current) return;

    if (error) {
      setEmail(session.user.email ?? null);
      setErrorMessage(error.message);
      setStatus('unauthorized');
      return;
    }

    if (!data) {
      setEmail(session.user.email ?? null);
      setStatus('unauthorized');
      return;
    }

    setEmail(data.email ?? session.user.email ?? null);
    setStatus('authorized');
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    const supabase = getSupabaseClient();
    let active = true;

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) {
        setErrorMessage(error.message);
        setStatus('signedOut');
        return;
      }
      void refreshSession(data.session);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      void refreshSession(session);
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [enabled, refreshSession]);

  const signIn = useCallback(async (nextEmail: string, password: string) => {
    setBusy(true);
    setErrorMessage(null);

    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.auth.signInWithPassword({
        email: nextEmail,
        password,
      });
      if (error) {
        setErrorMessage(error.message);
        setStatus('signedOut');
        return;
      }
      await refreshSession(data.session);
    } finally {
      setBusy(false);
    }
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    setBusy(true);
    try {
      const supabase = getSupabaseClient();
      await supabase.auth.signOut();
      setEmail(null);
      setStatus('signedOut');
    } finally {
      setBusy(false);
      setSigningOut(false);
    }
  }, []);

  const contextValue = useMemo<OperatorAuthContextValue>(() => ({
    enabled,
    email,
    signingOut,
    signOut,
  }), [email, enabled, signOut, signingOut]);

  if (!enabled) {
    return (
      <OperatorAuthContext.Provider value={contextValue}>
        {children}
      </OperatorAuthContext.Provider>
    );
  }

  if (status !== 'authorized') {
    return (
      <OperatorAuthContext.Provider value={contextValue}>
        <OperatorAuthScreen
          status={status}
          errorMessage={errorMessage}
          onSubmit={signIn}
          onSignOut={signOut}
          busy={busy}
        />
      </OperatorAuthContext.Provider>
    );
  }

  return (
    <OperatorAuthContext.Provider value={contextValue}>
      {children}
    </OperatorAuthContext.Provider>
  );
}
