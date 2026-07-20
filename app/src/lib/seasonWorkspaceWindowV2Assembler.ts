import {
  WORKSPACE_WINDOW_V2_PAGE_SIZE,
  parseWorkspaceWindowV2Page,
  type WorkspaceWindowV2OkPage,
  type WorkspaceWindowV2RootCursor,
  type WorkspaceWindowV2SnapshotToken,
} from './seasonWorkspaceWindowRpcV2Contract.ts';

export interface WorkspaceWindowV2Query {
  seasonId: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  resourceType?: string | null;
  limit?: number | null;
}

export interface WorkspaceWindowV2Request {
  query: WorkspaceWindowV2Query;
  pageSize: number;
  cursor: WorkspaceWindowV2RootCursor | null;
  expectedSnapshot: WorkspaceWindowV2SnapshotToken | null;
  signal?: AbortSignal;
}

export interface WorkspaceWindowV2LoadOptions {
  signal?: AbortSignal;
  expectedSnapshot?: WorkspaceWindowV2SnapshotToken;
  requestPage: (request: WorkspaceWindowV2Request) => Promise<unknown>;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class WorkspaceWindowV2Error extends Error {
  readonly code: 'SNAPSHOT_CHANGED' | 'WINDOW_LIMIT_EXCEEDED' | 'INVALID_PAGE_SEQUENCE';

  constructor(
    code: 'SNAPSHOT_CHANGED' | 'WINDOW_LIMIT_EXCEEDED' | 'INVALID_PAGE_SEQUENCE',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceWindowV2Error';
    this.code = code;
  }
}

const ROW_KEYS = {
  flightRecords: (row: Record<string, unknown>) => String(row.record_id),
  flightRecordCounters: (row: Record<string, unknown>) => `${row.record_id}\u0000${row.counter_group}\u0000${row.item_index}`,
  flightRecordWindows: (row: Record<string, unknown>) => `${row.record_id}\u0000${row.counter_key}`,
  modifications: (row: Record<string, unknown>) => String(row.leg_id),
  modificationCounters: (row: Record<string, unknown>) => `${row.leg_id}\u0000${row.counter_group}\u0000${row.item_index}`,
  modificationWindows: (row: Record<string, unknown>) => `${row.leg_id}\u0000${row.counter_key}`,
  modificationAddedLegs: (row: Record<string, unknown>) => String(row.leg_id),
} as const;

type RowArrayName = keyof typeof ROW_KEYS;

function snapshotsMatch(left: WorkspaceWindowV2SnapshotToken, right: WorkspaceWindowV2SnapshotToken): boolean {
  return left.dataVersion === right.dataVersion && left.serverHighWater === right.serverHighWater;
}

function cursorsMatch(left: WorkspaceWindowV2RootCursor, right: WorkspaceWindowV2RootCursor): boolean {
  return left.effectiveDate === right.effectiveDate && left.rootId === right.rootId && left.rootKind === right.rootKind;
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryDelay(random: () => number): number {
  return 250 + Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, random())) * 751);
}

function validatePageIdentity(page: WorkspaceWindowV2OkPage, query: WorkspaceWindowV2Query): void {
  if (
    page.seasonId !== query.seasonId ||
    page.startDate !== (query.dateFrom ?? null) ||
    page.endDate !== (query.dateTo ?? null) ||
    page.resourceType !== (query.resourceType ?? 'all')
  ) {
    throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', 'Workspace V2 page identity changed during pagination.');
  }
}

async function loadAttempt(
  query: WorkspaceWindowV2Query,
  expectedSnapshot: WorkspaceWindowV2SnapshotToken | null,
  options: WorkspaceWindowV2LoadOptions,
): Promise<WorkspaceWindowV2OkPage | { snapshotChanged: WorkspaceWindowV2SnapshotToken }> {
  const rowSets = Object.fromEntries(Object.keys(ROW_KEYS).map((key) => [key, new Set<string>()])) as Record<RowArrayName, Set<string>>;
  const rows = Object.fromEntries(Object.keys(ROW_KEYS).map((key) => [key, []])) as unknown as Pick<WorkspaceWindowV2OkPage, RowArrayName>;
  let acceptedSnapshot = expectedSnapshot;
  let cursor: WorkspaceWindowV2RootCursor | null = null;
  let returnedCount = 0;
  let lastPage: WorkspaceWindowV2OkPage | null = null;

  while (true) {
    options.signal?.throwIfAborted();
    const remaining = query.limit == null ? WORKSPACE_WINDOW_V2_PAGE_SIZE : query.limit - returnedCount;
    if (remaining <= 0) {
      throw new WorkspaceWindowV2Error('WINDOW_LIMIT_EXCEEDED', `Workspace window exceeds the logical limit of ${query.limit} roots.`);
    }
    const page = parseWorkspaceWindowV2Page(await options.requestPage({
      query,
      pageSize: Math.min(WORKSPACE_WINDOW_V2_PAGE_SIZE, remaining),
      cursor,
      expectedSnapshot: acceptedSnapshot,
      signal: options.signal,
    }));
    if (page.status === 'snapshot_changed') return { snapshotChanged: page.snapshot };

    validatePageIdentity(page, query);
    if (acceptedSnapshot && !snapshotsMatch(page.snapshot, acceptedSnapshot)) {
      throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', 'Workspace V2 snapshot token changed without snapshot_changed status.');
    }
    acceptedSnapshot ??= page.snapshot;
    if (page.page.returnedCount === 0 && page.page.hasMore) {
      throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', 'Workspace V2 returned an empty non-terminal page.');
    }
    if (cursor && page.page.nextCursor && cursorsMatch(cursor, page.page.nextCursor)) {
      throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', 'Workspace V2 cursor did not advance.');
    }

    for (const name of Object.keys(ROW_KEYS) as RowArrayName[]) {
      for (const row of page[name] as Array<Record<string, unknown>>) {
        const key = ROW_KEYS[name](row);
        if (rowSets[name].has(key)) {
          throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', `Workspace V2 repeated ${name} key ${key} across pages.`);
        }
        rowSets[name].add(key);
        (rows[name] as Array<Record<string, unknown>>).push(row);
      }
    }

    returnedCount += page.page.returnedCount;
    lastPage = page;
    if (!page.page.hasMore) break;
    if (query.limit != null && returnedCount >= query.limit) {
      throw new WorkspaceWindowV2Error('WINDOW_LIMIT_EXCEEDED', `Workspace window exceeds the logical limit of ${query.limit} roots.`);
    }
    cursor = page.page.nextCursor;
  }

  if (!lastPage || !acceptedSnapshot) {
    throw new WorkspaceWindowV2Error('INVALID_PAGE_SEQUENCE', 'Workspace V2 returned no terminal page.');
  }
  return {
    ...lastPage,
    ...rows,
    snapshot: acceptedSnapshot,
    page: { returnedCount, hasMore: false, nextCursor: null },
  };
}

export async function loadWorkspaceWindowV2(
  query: WorkspaceWindowV2Query,
  options: WorkspaceWindowV2LoadOptions,
): Promise<WorkspaceWindowV2OkPage> {
  let expectedSnapshot = options.expectedSnapshot ?? null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await loadAttempt(query, expectedSnapshot, options);
    if (!('snapshotChanged' in result)) return result;
    if (attempt === 1) {
      throw new WorkspaceWindowV2Error('SNAPSHOT_CHANGED', 'Schedule data changed repeatedly while loading.');
    }
    expectedSnapshot = result.snapshotChanged;
    await (options.delay ?? defaultDelay)(retryDelay(options.random ?? Math.random), options.signal);
  }
  throw new WorkspaceWindowV2Error('SNAPSHOT_CHANGED', 'Schedule data changed repeatedly while loading.');
}
