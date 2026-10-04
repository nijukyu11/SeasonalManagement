import { create } from 'zustand';
import type { FlightRecord } from './types';
import {
  type OperationalPreset,
  type OperationalWindowSnapshot,
  type OperationalLegChangeInput,
  type OperationalMutationReceipt,
  buildOperationalDateRange,
  loadFullOperationalScheduleWindow,
} from './operationalScheduleContract';
import {
  getOperationalScheduleAllocationWindowV1,
  applyOperationalResourceChangesV1,
  applyOperationalFlightScheduleChangesV1,
  createOperationalFlightLegsV1,
} from './remoteStore';
import { registerOperatorSessionCacheClearer } from './operatorSessionCacheRegistry';

export interface OperationalMutationResult {
  receipt: OperationalMutationReceipt;
  refreshError: string | null;
}

export interface OperationalScheduleWindowState {
  startDate: string;
  endDate: string;
  preset: OperationalPreset;
  resourceType: string;
  records: FlightRecord[];
  resources: Record<string, unknown[]>;
  snapshot: OperationalWindowSnapshot;
  loading: boolean;
  mutating: boolean;
  importing: boolean;
  error: string | null;
  lastLoadedAt: number | null;
  generation: number;
  unresolvedAttempt: UnresolvedMutationAttempt | null;

  // Actions
  retryPendingMutation: () => Promise<OperationalMutationResult | { receipt: OperationalMutationReceipt; refreshError: string | null } | null>;
  setPreset: (preset: OperationalPreset, customStart?: string, customEnd?: string) => Promise<void>;
  setDateRange: (startDate: string, endDate: string) => Promise<void>;
  setResourceType: (resourceType: string) => Promise<void>;
  loadWindow: (options?: { force?: boolean }) => Promise<FlightRecord[]>;
  applyMutations: (
    changes: OperationalLegChangeInput[],
    options?: { requestId?: string },
  ) => Promise<OperationalMutationResult>;
  createFlightLegs: (
    legs: Array<Record<string, unknown>>,
    options?: { requestId?: string },
  ) => Promise<{ receipt: OperationalMutationReceipt; refreshError: string | null }>;
  invalidateDates: (dates: string[], options?: { requestId?: string }) => void;
  reset: () => void;
}

const initialDates = buildOperationalDateRange('today');

let requestGeneration = 0;

export const OPERATIONAL_PENDING_MUTATION_STORAGE_KEY = 'operational:pending-mutation:v2';

function extractUserIdFromSupabaseAuthPayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const directUserId = parsed.user?.id ?? parsed.currentSession?.user?.id ?? (Array.isArray(parsed) ? parsed[2]?.id : null);
    if (typeof directUserId === 'string' && directUserId.trim().length > 0) {
      return directUserId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function getSynchronousOperatorUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const storage = window.localStorage;
  if (!storage) return null;
  const candidateKeys = [
    'seasonal-management-supabase-auth-token',
    'sb-rhmehiinfchiiuqmdukz-auth-token',
    'sb-supabase-auth-token',
  ];
  for (const k of candidateKeys) {
    const raw = storage.getItem(k);
    const userId = extractUserIdFromSupabaseAuthPayload(raw);
    if (userId) return userId;
  }
  return null;
}

export function getOperationalPendingMutationStorageKey(operatorId: string): string {
  return `${OPERATIONAL_PENDING_MUTATION_STORAGE_KEY}:${operatorId}`;
}

export type UnresolvedMutationKind = 'apply_schedule' | 'apply_resource' | 'create_legs';

export interface UnresolvedMutationAttempt {
  kind: UnresolvedMutationKind;
  requestId: string;
  expectedRevision: string;
  serializedPayload: string;
  timestamp: number;
  ownerUserId: string | null;
}

const recentMutationRequestIds = new Set<string>();
const pendingInvalidatedDates = new Set<string>();

function rememberMutationRequestId(requestId: string): void {
  recentMutationRequestIds.add(requestId);
  if (recentMutationRequestIds.size > 100) {
    const oldest = recentMutationRequestIds.values().next().value;
    if (oldest !== undefined) recentMutationRequestIds.delete(oldest);
  }
}

export function rememberOperationalMutationRequestId(requestId: string): void {
  rememberMutationRequestId(requestId);
}

export function readStoredUnresolvedMutationAttempt(expectedOperatorId?: string | null): UnresolvedMutationAttempt | null {
  if (typeof window === 'undefined') return null;
  const currentOperatorId = expectedOperatorId !== undefined ? expectedOperatorId : getSynchronousOperatorUserId();
  if (!currentOperatorId) return null;
  const key = getOperationalPendingMutationStorageKey(currentOperatorId);
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.requestId !== 'string' || !parsed.requestId) return null;
    if (typeof parsed.expectedRevision !== 'string') return null;
    if (typeof parsed.serializedPayload !== 'string') return null;
    if (typeof parsed.timestamp !== 'number' || !Number.isFinite(parsed.timestamp) || parsed.timestamp <= 0) return null;
    if (parsed.kind !== 'apply_schedule' && parsed.kind !== 'apply_resource' && parsed.kind !== 'create_legs') return null;

    // Strict identity binding: never let a different operator recover a prior operator's request
    const storedOwner = typeof parsed.ownerUserId === 'string' ? parsed.ownerUserId : null;
    if (!storedOwner || storedOwner !== currentOperatorId) {
      return null;
    }

    // Validate discriminated payload structure: OperationalLegChangeInput is { legId, patch, expected }
    const payload = JSON.parse(parsed.serializedPayload);
    if (parsed.kind === 'apply_schedule' || parsed.kind === 'apply_resource') {
      if (!Array.isArray(payload) || payload.length === 0) return null;
      for (const item of payload) {
        if (!item || typeof item !== 'object') return null;
        if (typeof item.legId !== 'string' || !item.legId) return null;
        if (!item.patch || typeof item.patch !== 'object' || Array.isArray(item.patch)) return null;
        if (!item.expected || typeof item.expected !== 'object' || Array.isArray(item.expected)) return null;
      }
    } else if (parsed.kind === 'create_legs') {
      if (!Array.isArray(payload) || payload.length === 0) return null;
      for (const item of payload) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      }
    }

    return {
      kind: parsed.kind,
      requestId: parsed.requestId,
      expectedRevision: parsed.expectedRevision,
      serializedPayload: parsed.serializedPayload,
      timestamp: parsed.timestamp,
      ownerUserId: storedOwner,
    };
  } catch {
    return null;
  }
}

export function persistStoredUnresolvedMutationAttempt(attempt: UnresolvedMutationAttempt | null): void {
  if (typeof window === 'undefined') return;
  const operatorId = attempt?.ownerUserId ?? getSynchronousOperatorUserId();
  if (!operatorId) return;
  const key = getOperationalPendingMutationStorageKey(operatorId);
  try {
    if (attempt) {
      window.localStorage?.setItem(key, JSON.stringify(attempt));
    } else {
      window.localStorage?.removeItem(key);
    }
  } catch {
    // Storage preservation is best-effort.
  }
}

const initialUnresolvedAttempt = readStoredUnresolvedMutationAttempt();
let unresolvedAttempt: UnresolvedMutationAttempt | null = initialUnresolvedAttempt;
if (initialUnresolvedAttempt) {
  rememberMutationRequestId(initialUnresolvedAttempt.requestId);
}

export function getPendingOperationalMutation(expectedOperatorId?: string | null): UnresolvedMutationAttempt | null {
  const currentOperatorId = expectedOperatorId !== undefined ? expectedOperatorId : getSynchronousOperatorUserId();
  if (!currentOperatorId) return null;

  if (unresolvedAttempt) {
    if (unresolvedAttempt.ownerUserId && unresolvedAttempt.ownerUserId !== currentOperatorId) {
      unresolvedAttempt = null;
      return readStoredUnresolvedMutationAttempt(currentOperatorId);
    }
    return unresolvedAttempt;
  }
  return readStoredUnresolvedMutationAttempt(currentOperatorId);
}

export function setPendingOperationalMutation(attempt: Omit<UnresolvedMutationAttempt, 'timestamp' | 'ownerUserId'> & { timestamp?: number; ownerUserId?: string | null }): void {
  const currentOperatorId = attempt.ownerUserId ?? getSynchronousOperatorUserId();
  if (!currentOperatorId) {
    throw new Error('An authorized operator session is required to record pending operational mutations.');
  }
  const fullAttempt: UnresolvedMutationAttempt = {
    ...attempt,
    timestamp: attempt.timestamp ?? Date.now(),
    ownerUserId: currentOperatorId,
  };
  unresolvedAttempt = fullAttempt;
  persistStoredUnresolvedMutationAttempt(fullAttempt);
  rememberMutationRequestId(fullAttempt.requestId);
  useOperationalScheduleStore.setState({
    unresolvedAttempt: fullAttempt,
    mutating: true,
  });
}

export function clearPendingOperationalMutation(requestId?: string): void {
  if (requestId && unresolvedAttempt && unresolvedAttempt.requestId !== requestId) {
    return;
  }
  unresolvedAttempt = null;
  persistStoredUnresolvedMutationAttempt(null);
  useOperationalScheduleStore.setState({
    unresolvedAttempt: null,
    mutating: false,
  });
}

export function isRecentOperationalMutationRequestId(requestId: string): boolean {
  return recentMutationRequestIds.has(requestId);
}

function isAuthoritativeSqlRejection(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err
    && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)
    && !err.code.startsWith('08') && !err.code.startsWith('57');
}
export const useOperationalScheduleStore = create<OperationalScheduleWindowState>((set, get) => ({
  startDate: initialDates.startDate,
  endDate: initialDates.endDate,
  preset: 'today',
  resourceType: 'all',
  records: [],
  resources: {},
  snapshot: { revision: '0', token: '' },
  loading: false,
  mutating: Boolean(initialUnresolvedAttempt),
  importing: false,
  error: null,
  lastLoadedAt: null,
  generation: 0,
  unresolvedAttempt: initialUnresolvedAttempt,

  retryPendingMutation: async () => {
    const attempt = getPendingOperationalMutation();
    if (!attempt) return null;
    if (attempt.kind === 'create_legs') {
      const legs = JSON.parse(attempt.serializedPayload);
      return get().createFlightLegs(legs, { requestId: attempt.requestId });
    }
    const changes = JSON.parse(attempt.serializedPayload);
    return get().applyMutations(changes, { requestId: attempt.requestId });
  },

  setPreset: async (preset: OperationalPreset, customStart?: string, customEnd?: string) => {
    requestGeneration += 1;
    const currentGen = requestGeneration;
    const range = buildOperationalDateRange(preset, customStart, customEnd);
    set({
      preset,
      startDate: range.startDate,
      endDate: range.endDate,
      records: [],
      resources: {},
      snapshot: { revision: '0', token: '' },
      error: null,
      generation: currentGen,
    });
    await get().loadWindow({ force: true });
  },

  setDateRange: async (startDate: string, endDate: string) => {
    requestGeneration += 1;
    const currentGen = requestGeneration;
    set({
      preset: 'custom',
      startDate,
      endDate,
      records: [],
      resources: {},
      snapshot: { revision: '0', token: '' },
      error: null,
      generation: currentGen,
    });
    await get().loadWindow({ force: true });
  },

  setResourceType: async (resourceType: string) => {
    if (get().resourceType === resourceType) return;
    requestGeneration += 1;
    const currentGen = requestGeneration;
    set({
      resourceType,
      records: [],
      resources: {},
      snapshot: { revision: '0', token: '' },
      error: null,
      generation: currentGen,
    });
    await get().loadWindow({ force: true });
  },

  loadWindow: async (options?: { force?: boolean }) => {
    const state = get();
    if (state.loading && !options?.force) {
      return state.records;
    }

    requestGeneration += 1;
    const targetGen = requestGeneration;
    set({ loading: true, error: null, generation: targetGen });

    try {
      const res = await loadFullOperationalScheduleWindow({
        startDate: state.startDate,
        endDate: state.endDate,
        resourceType: state.resourceType,
        pageSize: 500,
        fetchWindowFn: (params) => getOperationalScheduleAllocationWindowV1(params),
      });

      // Discard stale responses from earlier date ranges or presets
      if (get().generation !== targetGen) {
        return get().records;
      }

      set({
        records: res.records,
        resources: res.resources,
        snapshot: res.snapshot,
        loading: false,
        error: null,
        lastLoadedAt: Date.now(),
      });

      return res.records;
    } catch (err) {
      if (get().generation !== targetGen) {
        return get().records;
      }
      const message = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: message });
      throw err;
    }
  },

  applyMutations: async (
    changes: OperationalLegChangeInput[],
    options?: { requestId?: string },
  ): Promise<OperationalMutationResult> => {
    if (changes.length === 0) {
      throw new Error('At least one operational leg change is required');
    }

    const currentPayload = JSON.stringify(changes);
    const explicitRequestId = options?.requestId;

    if (explicitRequestId && unresolvedAttempt && unresolvedAttempt.requestId === explicitRequestId) {
      if (unresolvedAttempt.serializedPayload !== currentPayload) {
        throw new Error('Request ID reused with different payload');
      }
    }

    const state = get();
    if (state.mutating || state.importing) {
      throw new Error('Another operational mutation is already in progress');
    }

    const SCHEDULE_FIELDS = new Set([
      'airline', 'flight_number', 'scheduled_date', 'scheduled_time', 'route',
      'aircraft_type', 'flight_category', 'int_dom_ind', 'code_shares', 'status', 'deletion_reason',
    ]);
    const hasScheduleField = changes.some((c) =>
      Object.keys(c.patch).some((k) => SCHEDULE_FIELDS.has(k)),
    );
    const kind: UnresolvedMutationKind = hasScheduleField ? 'apply_schedule' : 'apply_resource';
    if (unresolvedAttempt && (unresolvedAttempt.kind !== kind
      || unresolvedAttempt.serializedPayload !== currentPayload
      || (explicitRequestId && unresolvedAttempt.requestId !== explicitRequestId))) {
      throw new Error('The previous operational write is unconfirmed. Retry that write unchanged before submitting another.');
    }

    let requestId: string;
    let expectedRevision: string;

    if (explicitRequestId) {
      requestId = explicitRequestId;
      if (unresolvedAttempt && unresolvedAttempt.requestId === explicitRequestId) {
        expectedRevision = unresolvedAttempt.expectedRevision;
      } else {
        expectedRevision = state.snapshot.revision;
      }
    } else if (
      unresolvedAttempt &&
      unresolvedAttempt.kind === kind &&
      unresolvedAttempt.serializedPayload === currentPayload
    ) {
      requestId = unresolvedAttempt.requestId;
      expectedRevision = unresolvedAttempt.expectedRevision;
    } else {
      requestId = globalThis.crypto.randomUUID();
      expectedRevision = state.snapshot.revision;
    }

    setPendingOperationalMutation({
      kind,
      requestId,
      expectedRevision,
      serializedPayload: currentPayload,
    });

    set({ mutating: true, error: null });

    const executeCall = () =>
      hasScheduleField
        ? applyOperationalFlightScheduleChangesV1({
            requestId,
            expectedRevision,
            changes,
          })
        : applyOperationalResourceChangesV1({
            requestId,
            expectedRevision,
            changes,
          });

    let receipt: OperationalMutationReceipt;
    try {
      receipt = await executeCall();
    } catch (firstErr) {
      if (isAuthoritativeSqlRejection(firstErr)) {
        clearPendingOperationalMutation(requestId);
        void get().loadWindow({ force: true }).catch(() => undefined);
        set({ mutating: false });
        throw firstErr;
      }

      // Retry exact original args once on transport/unknown error before returning failure
      try {
        receipt = await executeCall();
      } catch (retryErr) {
        if (isAuthoritativeSqlRejection(retryErr)) {
          clearPendingOperationalMutation(requestId);
        }
        void get().loadWindow({ force: true }).catch(() => undefined);
        set({ mutating: false });
        throw retryErr;
      }
    }

    clearPendingOperationalMutation(requestId);
    set({ snapshot: { revision: receipt.revision, token: '' } });
    let refreshError: string | null = null;
    try {
      await get().loadWindow({ force: true });
    } catch (refreshErr) {
      refreshError = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
    }

    set({ mutating: false });
    if (pendingInvalidatedDates.size > 0) {
      pendingInvalidatedDates.clear();
      void get().loadWindow({ force: true }).catch(() => undefined);
    }
    return { receipt, refreshError };
  },
  createFlightLegs: async (
    legs: Array<Record<string, unknown>>,
    options?: { requestId?: string },
  ): Promise<{ receipt: OperationalMutationReceipt; refreshError: string | null }> => {
    if (legs.length === 0) {
      throw new Error('At least one flight leg is required');
    }

    const currentPayload = JSON.stringify(legs);
    const explicitRequestId = options?.requestId;

    if (explicitRequestId && unresolvedAttempt && unresolvedAttempt.requestId === explicitRequestId) {
      if (unresolvedAttempt.serializedPayload !== currentPayload) {
        throw new Error('Request ID reused with different payload');
      }
    }

    const state = get();
    if (state.mutating || state.importing) {
      throw new Error('Another operational mutation is already in progress');
    }
    if (unresolvedAttempt && (unresolvedAttempt.kind !== 'create_legs'
      || unresolvedAttempt.serializedPayload !== currentPayload
      || (explicitRequestId && unresolvedAttempt.requestId !== explicitRequestId))) {
      throw new Error('The previous operational write is unconfirmed. Retry that write unchanged before submitting another.');
    }

    let requestId: string;
    let expectedRevision: string;

    if (explicitRequestId) {
      requestId = explicitRequestId;
      if (unresolvedAttempt && unresolvedAttempt.requestId === explicitRequestId) {
        expectedRevision = unresolvedAttempt.expectedRevision;
      } else {
        expectedRevision = state.snapshot.revision;
      }
    } else if (
      unresolvedAttempt &&
      unresolvedAttempt.kind === 'create_legs' &&
      unresolvedAttempt.serializedPayload === currentPayload
    ) {
      requestId = unresolvedAttempt.requestId;
      expectedRevision = unresolvedAttempt.expectedRevision;
    } else {
      requestId = globalThis.crypto.randomUUID();
      expectedRevision = state.snapshot.revision;
    }

    setPendingOperationalMutation({
      kind: 'create_legs',
      requestId,
      expectedRevision,
      serializedPayload: currentPayload,
    });

    set({ mutating: true, error: null });

    const executeCall = () =>
      createOperationalFlightLegsV1({
        requestId,
        expectedRevision,
        legs,
      });

    let receipt: OperationalMutationReceipt;
    try {
      receipt = await executeCall();
    } catch (firstErr) {
      if (isAuthoritativeSqlRejection(firstErr)) {
        clearPendingOperationalMutation(requestId);
        void get().loadWindow({ force: true }).catch(() => undefined);
        set({ mutating: false });
        throw firstErr;
      }

      // Retry exact original args once on transport/unknown error before returning failure
      try {
        receipt = await executeCall();
      } catch (retryErr) {
        if (isAuthoritativeSqlRejection(retryErr)) {
          clearPendingOperationalMutation(requestId);
        }
        void get().loadWindow({ force: true }).catch(() => undefined);
        set({ mutating: false });
        throw retryErr;
      }
    }

    clearPendingOperationalMutation(requestId);
    set({ snapshot: { revision: receipt.revision, token: '' } });
    let refreshError: string | null = null;
    try {
      await get().loadWindow({ force: true });
    } catch (refreshErr) {
      refreshError = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
    }
    set({ mutating: false });
    if (pendingInvalidatedDates.size > 0) {
      pendingInvalidatedDates.clear();
      void get().loadWindow({ force: true }).catch(() => undefined);
    }
    return { receipt, refreshError };
  },

  invalidateDates: (dates: string[], options?: { requestId?: string }) => {
    const state = get();
    if (!dates || dates.length === 0) return;

    if (options?.requestId && recentMutationRequestIds.has(options.requestId)) {
      return;
    }

    const hasOverlap = dates.some((d) => d >= state.startDate && d <= state.endDate);
    if (!hasOverlap) return;

    if (state.mutating || state.importing) {
      for (const d of dates) {
        if (d >= state.startDate && d <= state.endDate) {
          pendingInvalidatedDates.add(d);
        }
      }
      return;
    }

    void get().loadWindow({ force: true }).catch(() => undefined);
  },

  reset: () => {
    unresolvedAttempt = null;
    // Clear in-memory mutation state on operator reset without purging persisted journal on initial auth check
    recentMutationRequestIds.clear();
    pendingInvalidatedDates.clear();
    requestGeneration += 1;
    const currentGen = requestGeneration;
    const fresh = buildOperationalDateRange('today');
    set({
      startDate: fresh.startDate,
      endDate: fresh.endDate,
      preset: 'today',
      resourceType: 'all',
      records: [],
      resources: {},
      snapshot: { revision: '0', token: '' },
      loading: false,
      mutating: false,
      importing: false,
      error: null,
      lastLoadedAt: null,
      generation: currentGen,
    });
  },
}));

registerOperatorSessionCacheClearer('operational-schedule', () => useOperationalScheduleStore.getState().reset());
