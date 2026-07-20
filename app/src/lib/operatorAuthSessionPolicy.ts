import type { AuthChangeEvent } from '@supabase/supabase-js';

export type OperatorAuthSessionEvent = AuthChangeEvent | 'BOOTSTRAP';

export type OperatorAuthSessionAction =
  | { kind: 'sign-out' }
  | { kind: 'verify-operator'; blocking: boolean };

export function resolveOperatorAuthSessionAction(
  event: OperatorAuthSessionEvent,
  sessionUserId: string | null,
  authorizedUserId: string | null,
): OperatorAuthSessionAction {
  if (event === 'SIGNED_OUT' || !sessionUserId) return { kind: 'sign-out' };
  if (sessionUserId !== authorizedUserId) return { kind: 'verify-operator', blocking: true };
  return { kind: 'verify-operator', blocking: false };
}

export function createOperatorVerificationSingleFlight<T>(
  load: (userId: string) => Promise<T>,
): { verify(userId: string): Promise<T>; clear(): void } {
  const inFlight = new Map<string, Promise<T>>();
  return {
    verify(userId) {
      const existing = inFlight.get(userId);
      if (existing) return existing;
      const promise = load(userId);
      inFlight.set(userId, promise);
      void promise.then(
        () => { if (inFlight.get(userId) === promise) inFlight.delete(userId); },
        () => { if (inFlight.get(userId) === promise) inFlight.delete(userId); },
      );
      return promise;
    },
    clear() {
      inFlight.clear();
    },
  };
}
