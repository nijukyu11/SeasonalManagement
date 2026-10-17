import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  persistSeasonalRestoreAttempt,
  loadSeasonalRestoreAttempt,
  clearSeasonalRestoreAttempt,
  markSeasonalRestoreAttemptStatus,
  getSeasonalRestoreAttemptStorageKey,
  setSeasonalRestoreExecuting,
  getExecutingSeasonalRestoreAttempt,
  isSeasonalRestoreBlockedSync,
  SeasonalRestoreStorageError,
  type SeasonalRestoreAttemptPayload,
} from './seasonalRestoreJournal.ts';
import { advanceOperatorSessionEpochAndClearRegisteredCaches } from './operatorSessionCacheRegistry.ts';
class MockStorage implements Storage {
  private store = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('QuotaExceededError: LocalStorage quota exceeded');
    }
    this.store.set(key, value);
  }
}

const mockAttempt: SeasonalRestoreAttemptPayload = {
  contractVersion: 1,
  ownerUserId: 'operator-alice',
  seasonId: 'season-w26',
  seasonCode: 'W26',
  versionId: 'ver-1234',
  versionTag: 'W26-20261008-01',
  requestId: 'req-uuid-9999',
  expectedRevision: '42',
  expectedEpoch: 'epoch-uuid-1111',
  startedAt: 1728380000000,
  status: 'executing',
};

test('anonymous operator rejection: persist fails without authenticated operator', () => {
  const storage = new MockStorage();
  const invalidAttempt = { ...mockAttempt, ownerUserId: '   ' };

  assert.throws(
    () => persistSeasonalRestoreAttempt(storage, invalidAttempt),
    SeasonalRestoreStorageError,
  );
  assert.throws(
    () => getSeasonalRestoreAttemptStorageKey(''),
    SeasonalRestoreStorageError,
  );
});

test('anonymous operator rejection: load returns null without authenticated operator', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  const loaded = loadSeasonalRestoreAttempt(storage, { ownerUserId: '' });
  assert.equal(loaded, null);
});

test('other-user isolation: operator-bob cannot load operator-alice restore attempt', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  // Bob tries to hydrate
  const bobLoaded = loadSeasonalRestoreAttempt(storage, { ownerUserId: 'operator-bob' });
  assert.equal(bobLoaded, null);

  // Alice hydrates her own attempt
  const aliceLoaded = loadSeasonalRestoreAttempt(storage, { ownerUserId: 'operator-alice' });
  assert.ok(aliceLoaded);
  assert.equal(aliceLoaded.requestId, 'req-uuid-9999');
  assert.equal(aliceLoaded.ownerUserId, 'operator-alice');
  assert.equal(aliceLoaded.versionTag, 'W26-20261008-01');
});

test('storage write failure throws SeasonalRestoreStorageError and does not proceed silently', () => {
  const storage = new MockStorage();
  storage.failWrites = true;

  assert.throws(
    () => persistSeasonalRestoreAttempt(storage, mockAttempt),
    (err) => {
      assert.ok(err instanceof SeasonalRestoreStorageError);
      assert.match(err.message, /Failed to persist seasonal restore attempt/);
      return true;
    },
  );
});

test('status transition: markSeasonalRestoreAttemptStatus updates status and error while keeping immutable tokens', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  const updated = markSeasonalRestoreAttemptStatus(
    storage,
    'season-w26',
    'req-uuid-9999',
    'unresolved',
    'Network timeout occurred',
    { ownerUserId: 'operator-alice' },
  );

  assert.ok(updated);
  assert.equal(updated.status, 'unresolved');
  assert.equal(updated.error, 'Network timeout occurred');
  assert.equal(updated.requestId, 'req-uuid-9999');
  assert.equal(updated.expectedRevision, '42');
  assert.equal(updated.expectedEpoch, 'epoch-uuid-1111');

  const reloaded = loadSeasonalRestoreAttempt(storage, { ownerUserId: 'operator-alice' });
  assert.ok(reloaded);
  assert.equal(reloaded.status, 'unresolved');
  assert.equal(reloaded.error, 'Network timeout occurred');
});

test('clearSeasonalRestoreAttempt removes operator-specific journal', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  const cleared = clearSeasonalRestoreAttempt(storage, 'season-w26', 'req-uuid-9999', {
    ownerUserId: 'operator-alice',
  });
  assert.equal(cleared, true);

  const reloaded = loadSeasonalRestoreAttempt(storage, { ownerUserId: 'operator-alice' });
  assert.equal(reloaded, null);
});

test('inMemoryExecutingAttempt clears on operator session epoch advance', () => {
  setSeasonalRestoreExecuting(true, mockAttempt);
  const active = getExecutingSeasonalRestoreAttempt('operator-alice');
  assert.ok(active);
  assert.equal(active.requestId, 'req-uuid-9999');

  // Advance epoch (simulating auth reset or logout)
  advanceOperatorSessionEpochAndClearRegisteredCaches();

  const afterReset = getExecutingSeasonalRestoreAttempt('operator-alice');
  assert.equal(afterReset, null);
});

test('seasonId isolation: loading with mismatched seasonId returns null', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  const wrongSeason = loadSeasonalRestoreAttempt(storage, {
    ownerUserId: 'operator-alice',
    seasonId: 'season-s27',
  });
  assert.equal(wrongSeason, null);

  const correctSeason = loadSeasonalRestoreAttempt(storage, {
    ownerUserId: 'operator-alice',
    seasonId: 'season-w26',
  });
  assert.ok(correctSeason);
});

test('owner and request fence: markSeasonalRestoreAttemptStatus returns null on mismatch', () => {
  const storage = new MockStorage();
  persistSeasonalRestoreAttempt(storage, mockAttempt);

  // Different operator tries to mark alice's attempt -> returns null
  const bobUpdate = markSeasonalRestoreAttemptStatus(
    storage,
    'season-w26',
    'req-uuid-9999',
    'executing',
    null,
    { ownerUserId: 'operator-bob' },
  );
  assert.equal(bobUpdate, null);

  // Mismatched request ID -> returns null
  const reqMismatch = markSeasonalRestoreAttemptStatus(
    storage,
    'season-w26',
    'different-request-id',
    'executing',
    null,
    { ownerUserId: 'operator-alice' },
  );
  assert.equal(reqMismatch, null);

  // Mismatched season ID -> returns null
  const seasonMismatch = markSeasonalRestoreAttemptStatus(
    storage,
    'different-season',
    'req-uuid-9999',
    'executing',
    null,
    { ownerUserId: 'operator-alice' },
  );
  assert.equal(seasonMismatch, null);

  // Alice's attempt in storage remains intact and unmodified
  const untouched = loadSeasonalRestoreAttempt(storage, { ownerUserId: 'operator-alice' });
  assert.ok(untouched);
  assert.equal(untouched.status, 'executing');
});

test('committed-pending journal guard blocks until clear after successful reload', () => {
  const mockStorage = new MockStorage();
  const originalWindow = (globalThis as Record<string, unknown>).window;

  try {
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: mockStorage },
      writable: true,
      configurable: true,
    });

    // 1. Initially no journal -> not blocked
    assert.equal(isSeasonalRestoreBlockedSync('season-w26', 'operator-alice'), false);

    // 2. Persist committed restore attempt (receipt committed on server, awaiting local reload)
    persistSeasonalRestoreAttempt(mockStorage, {
      ...mockAttempt,
      status: 'committed',
    });

    // 3. Status 'committed' MUST remain blocked for alice on season-w26
    assert.equal(isSeasonalRestoreBlockedSync('season-w26', 'operator-alice'), true);

    // Other operator is NOT blocked
    assert.equal(isSeasonalRestoreBlockedSync('season-w26', 'operator-bob'), false);

    // Other season is NOT blocked
    assert.equal(isSeasonalRestoreBlockedSync('season-s27', 'operator-alice'), false);

    // 4. Authoritative reload succeeds -> journal is cleared
    const cleared = clearSeasonalRestoreAttempt(mockStorage, 'season-w26', 'req-uuid-9999', {
      ownerUserId: 'operator-alice',
    });
    assert.equal(cleared, true);

    // 5. After clear, guard returns false
    assert.equal(isSeasonalRestoreBlockedSync('season-w26', 'operator-alice'), false);
  } finally {
    if (originalWindow !== undefined) {
      Object.defineProperty(globalThis, 'window', {
        value: originalWindow,
        writable: true,
        configurable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  }
});
