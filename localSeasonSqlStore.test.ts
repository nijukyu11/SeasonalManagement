import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  LOCAL_SEASON_SQL_CONNECTION,
  loadLocalSeasonSqlWorkspace,
  migrateLocalSeasonSqlDatabase,
  readLocalSeasonSqlDeltaState,
  replaceLocalSeasonSqlPendingState,
  restoreLatestLocalSeasonSqlBackup,
  saveLocalSeasonIndexedDbBackup,
  saveLocalSeasonSqlWorkspace,
  type LocalSeasonSqlDatabase,
  type SqlStoredWorkspace,
} from './localSeasonSqlStore.ts';
import type { LocalPendingOp, LocalSyncMeta } from './localSeasonStore.ts';
import type { SeasonConflictItem } from './seasonChangeEvents.ts';
import type { FlightModification, FlightRecord, ParsedRow, Season } from './types.ts';

class NodeSqliteTestDatabase implements LocalSeasonSqlDatabase {
  supportsExplicitTransactions?: boolean = true;

  private readonly db = new DatabaseSync(':memory:');

  async execute(sql: string, values: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...values);
  }

  async select<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...values) as T[];
  }

  close(): void {
    this.db.close();
  }
}

class NoExplicitTransactionDatabase extends NodeSqliteTestDatabase {
  override supportsExplicitTransactions = false;

  async execute(sql: string, values: unknown[] = []): Promise<void> {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql.trim())) {
      return Promise.reject('transaction control rejected by pooled SQL bridge');
    }
    return super.execute(sql, values);
  }
}

class BusyOnceDatabase extends NodeSqliteTestDatabase {
  busyFailuresRemaining = 0;

  async execute(sql: string, values: unknown[] = []): Promise<void> {
    if (this.busyFailuresRemaining > 0 && /^INSERT INTO local_seasons\b/i.test(sql.trim())) {
      this.busyFailuresRemaining -= 1;
      return Promise.reject('database is locked');
    }
    return super.execute(sql, values);
  }
}

class DefaultTransactionDatabase extends NodeSqliteTestDatabase {
  override supportsExplicitTransactions = undefined;
  statements: string[] = [];

  async execute(sql: string, values: unknown[] = []): Promise<void> {
    this.statements.push(sql.trim());
    return super.execute(sql, values);
  }
}

const season: Season = {
  id: 'season-s26',
  seasonCode: 'S26',
  name: 'Summer 2026',
  fileName: 'S26.xlsx',
  uploadedAt: 1,
  effectiveStart: '2026-04-01',
  effectiveEnd: '2026-04-01',
  totalLegs: 2,
  totalSourceRows: 1,
  dataVersion: 7,
};

const row: ParsedRow = {
  rowIndex: 1,
  effective: '01-Apr-26',
  discontinue: '01-Apr-26',
  airline: 'VN',
  aircraft: '321',
  daysOfWeek: [false, false, true, false, false, false, false],
  sta: '08:00',
  arrFlight: 'VN100',
  arrFlightType: 'PAX',
  arrRoute: 'HAN',
  arrFlightCategory: 'INT',
  arrCodeShares: null,
  arrIntDomInd: 'I',
  std: '09:00',
  depFlight: 'VN101',
  depFlightType: 'PAX',
  depRoute: 'HAN',
  depFlightCategory: 'INT',
  depCodeShares: null,
  depIntDomInd: 'I',
};

function record(overrides: Partial<FlightRecord>): FlightRecord {
  return {
    id: overrides.id ?? 'leg-1',
    linkId: 'link-1',
    type: overrides.type ?? 'D',
    airline: 'VN',
    flightNumber: '101',
    rawFlightNumber: 'VN101',
    requestStatusCode: null,
    route: 'HAN',
    schedule: overrides.schedule ?? '09:00',
    aircraft: '321',
    category: 'INT',
    flightType: 'PAX',
    codeShares: null,
    intDomInd: 'I',
    pax: 180,
    gate: overrides.gate ?? null,
    stand: null,
    counter: null,
    carousel: null,
    mct: null,
    fb: null,
    lb: null,
    bhs: null,
    ghs: null,
    date: '2026-04-01',
    dayOfWeek: 3,
    action: null,
    sourceRowIndex: 1,
    sourceKind: 'imported',
    sourceSide: overrides.sourceSide ?? 'DEP',
    status: 'active',
    ...overrides,
  };
}

const syncMeta: LocalSyncMeta = {
  seasonId: season.id,
  baseServerVersion: 7,
  lastServerSeq: 10,
  clientId: 'client-1',
  localRevision: 3,
  pendingCount: 1,
  lastLocalChangeAt: 1000,
  syncStatus: 'dirty',
};

const conflict = {
  id: 'conflict-1',
  targetType: 'modification',
  targetId: 'leg-1',
  overlappingFields: ['gate'],
  localFields: { gate: 12 },
  remoteFields: { gate: 14 },
  createdAt: 1000,
  message: 'Gate conflict',
  event: {
    id: 'event-1',
    seasonId: season.id,
    clientId: 'client-2',
    serverSeq: 11,
    targetType: 'modification',
    targetId: 'leg-1',
    operation: 'upsert',
    payload: { gate: 14 },
    createdAt: '2026-05-26T00:00:00.000Z',
  },
} as unknown as SeasonConflictItem;

function workspace(): SqlStoredWorkspace {
  const modification: FlightModification = { legId: 'leg-1', action: 'modified', gate: 12 };
  const pendingOps: LocalPendingOp[] = [{ type: 'modification', mod: modification }];
  return {
    season,
    rows: [row],
    records: [record({ id: 'leg-1', gate: 12 }), record({ id: 'leg-2', gate: 14, sourceSide: 'ARR', type: 'A' })],
    modificationEntries: [['leg-1', modification]],
    modHistory: [{
      id: 'hist-1',
      timestamp: 1000,
      description: 'Move gate',
      changes: [{ legId: 'leg-1', previousMod: null, newMod: modification }],
    }],
    baseRows: [row],
    baseRecords: [record({ id: 'leg-1' }), record({ id: 'leg-2', sourceSide: 'ARR', type: 'A' })],
    baseModificationEntries: [],
    baseModHistory: [],
    pendingOps,
    derivedSeasonal: { groups: [{ id: 'cached' }], builtAt: 1000, revision: 3 },
    entityVersions: { flight_record: { 'leg-1': 4 } },
    syncMeta,
  };
}

async function createMigratedDb(): Promise<NodeSqliteTestDatabase> {
  const db = new NodeSqliteTestDatabase();
  await migrateLocalSeasonSqlDatabase(db);
  return db;
}

test('defines the native SQLite connection used by the Tauri SQL plugin', () => {
  assert.equal(LOCAL_SEASON_SQL_CONNECTION, 'sqlite:seasonal-management-local.db');
});

test('migrates relational local storage tables and indexes', async () => {
  const db = await createMigratedDb();
  const tables = await db.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  );
  const tableNames = tables.map((entry) => entry.name);

  assert.deepEqual(
    tableNames.filter((name) => name.startsWith('local_')),
    [
      'local_derived_seasonal',
      'local_entity_versions',
      'local_flight_records',
      'local_indexeddb_backup',
      'local_kv',
      'local_mod_history_entries',
      'local_modifications',
      'local_pending_ops',
      'local_schema_version',
      'local_seasons',
      'local_source_rows',
      'local_sync_meta',
    ]
  );

  const indexes = await db.select<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  assert.ok(indexes.some((entry) => entry.name === 'idx_local_flight_records_lookup'));
  assert.ok(indexes.some((entry) => entry.name === 'idx_local_modifications_lookup'));
  db.close();
});

test('round-trips a season workspace through SQLite rows', async () => {
  const db = await createMigratedDb();
  await saveLocalSeasonSqlWorkspace(db, workspace());

  const loaded = await loadLocalSeasonSqlWorkspace(db, season.id);

  assert.equal(loaded?.season.id, season.id);
  assert.equal(loaded?.records.length, 2);
  assert.equal(loaded?.modificationEntries[0]?.[0], 'leg-1');
  assert.deepEqual(loaded?.pendingOps, workspace().pendingOps);
  assert.deepEqual(loaded?.entityVersions, { flight_record: { 'leg-1': 4 } });
  assert.equal(loaded?.syncMeta.lastServerSeq, 10);
  db.close();
});

test('saves a workspace when the SQL bridge rejects explicit transaction statements', async () => {
  const db = new NoExplicitTransactionDatabase();
  await migrateLocalSeasonSqlDatabase(db);

  await saveLocalSeasonSqlWorkspace(db, workspace());
  const loaded = await loadLocalSeasonSqlWorkspace(db, season.id);

  assert.equal(loaded?.season.id, season.id);
  assert.equal(loaded?.records.length, 2);
  db.close();
});

test('uses explicit transactions when the SQL bridge does not opt out', async () => {
  const db = new DefaultTransactionDatabase();
  await migrateLocalSeasonSqlDatabase(db);

  await saveLocalSeasonSqlWorkspace(db, workspace());

  assert.ok(db.statements.some((statement) => /^BEGIN IMMEDIATE$/i.test(statement)));
  assert.ok(db.statements.some((statement) => /^COMMIT$/i.test(statement)));
  db.close();
});

test('retries transient SQLite busy failures during workspace saves', async () => {
  const db = new BusyOnceDatabase();
  await migrateLocalSeasonSqlDatabase(db);
  db.busyFailuresRemaining = 1;

  await saveLocalSeasonSqlWorkspace(db, workspace());
  const loaded = await loadLocalSeasonSqlWorkspace(db, season.id);

  assert.equal(loaded?.season.id, season.id);
  assert.equal(db.busyFailuresRemaining, 0);
  db.close();
});

test('reads only affected delta state for allocation hot-path writes', async () => {
  const db = await createMigratedDb();
  await saveLocalSeasonSqlWorkspace(db, workspace());

  const deltaState = await readLocalSeasonSqlDeltaState(db, season.id, new Set(['leg-1']));

  assert.equal(deltaState?.season.id, season.id);
  assert.deepEqual(deltaState?.modificationEntries.map(([legId]) => legId), ['leg-1']);
  assert.deepEqual(deltaState?.baseRecords.map((entry) => entry.id), ['leg-1']);
  assert.equal(deltaState?.pendingOps.length, 1);
  db.close();
});

test('replaces pending state without losing conflict review status', async () => {
  const db = await createMigratedDb();
  await saveLocalSeasonSqlWorkspace(db, {
    ...workspace(),
    syncMeta: {
      ...syncMeta,
      conflicts: [conflict],
      syncStatus: 'needs_review',
    },
  });

  const nextMeta: LocalSyncMeta = {
    ...syncMeta,
    pendingCount: 0,
    lastLocalChangeAt: null,
    conflicts: [conflict],
    syncStatus: 'needs_review',
  };
  await replaceLocalSeasonSqlPendingState(db, season.id, [], nextMeta);

  const loaded = await loadLocalSeasonSqlWorkspace(db, season.id);

  assert.equal(loaded?.pendingOps.length, 0);
  assert.equal(loaded?.syncMeta.syncStatus, 'needs_review');
  assert.equal(loaded?.syncMeta.conflicts?.length, 1);
  db.close();
});

test('rejects workspace saves that shrink below source-generated flight records', async () => {
  const db = await createMigratedDb();
  const shrunken = {
    ...workspace(),
    records: [record({ id: 'leg-1', gate: 12 })],
    baseRecords: [record({ id: 'leg-1' })],
  };

  await assert.rejects(
    () => saveLocalSeasonSqlWorkspace(db, shrunken),
    /would shrink generated flight records/i
  );
  db.close();
});

test('rejects workspace saves when season totalLegs has already been shrunken below generated rows', async () => {
  const db = await createMigratedDb();
  const shrunken = {
    ...workspace(),
    season: {
      ...season,
      totalLegs: 1,
    },
    records: [record({ id: 'leg-1', gate: 12 })],
    baseRecords: [record({ id: 'leg-1' })],
  };

  await assert.rejects(
    () => saveLocalSeasonSqlWorkspace(db, shrunken),
    /would shrink generated flight records/i
  );
  db.close();
});

test('restores the latest valid IndexedDB backup into live SQLite tables', async () => {
  const db = await createMigratedDb();
  const good = workspace();
  await saveLocalSeasonSqlWorkspace(db, good);
  await saveLocalSeasonIndexedDbBackup(db, season.id, good);
  await saveLocalSeasonSqlWorkspace(db, {
    ...good,
    records: [record({ id: 'leg-1', gate: 12 })],
    baseRecords: [record({ id: 'leg-1' })],
  }, { allowGeneratedRecordShrink: true });

  const restored = await restoreLatestLocalSeasonSqlBackup(db, season.id);
  const loaded = await loadLocalSeasonSqlWorkspace(db, season.id);

  assert.equal(restored?.records, 2);
  assert.equal(restored?.pendingOps, 1);
  assert.equal(loaded?.records.length, 2);
  assert.equal(loaded?.baseRecords.length, 2);
  assert.equal(loaded?.syncMeta.lastServerSeq, 10);
  db.close();
});
