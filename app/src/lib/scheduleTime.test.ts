import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  hydrateFlightModificationFromPersistence,
  serializeFlightModificationForPersistence,
} from './persistenceSchema.ts';
import { normalizeScheduleTime, requireScheduleTime } from './scheduleTime.ts';

test('schedule time normalization accepts canonical and compact user input', () => {
  assert.equal(normalizeScheduleTime('10:25'), '10:25');
  assert.equal(normalizeScheduleTime('1025'), '10:25');
  assert.equal(normalizeScheduleTime('9:25'), '09:25');
  assert.equal(normalizeScheduleTime('925'), '09:25');
  assert.equal(normalizeScheduleTime(' 1025 '), '10:25');
});

test('schedule time normalization rejects invalid local times', () => {
  assert.equal(normalizeScheduleTime('24:00'), null);
  assert.equal(normalizeScheduleTime('1260'), null);
  assert.equal(normalizeScheduleTime('10:2'), null);
  assert.throws(() => requireScheduleTime('invalid'), /schedule must use HH:mm format/);
});

test('server-authoritative persistence canonicalizes compact modification schedules', () => {
  const persisted = serializeFlightModificationForPersistence({
    legId: 'LEG_D_2027-01-07_TEST',
    action: 'modified',
    schedule: '1025',
  });
  assert.equal(persisted.schedule, '10:25');

  const hydrated = hydrateFlightModificationFromPersistence({
    legId: 'LEG_D_2027-01-07_TEST',
    action: 'modified',
    schedule: '1025',
  });
  assert.equal(hydrated.schedule, '10:25');
});

test('persistence rejects schedule values that cannot be canonicalized', () => {
  assert.throws(
    () => serializeFlightModificationForPersistence({
      legId: 'LEG_D_INVALID',
      action: 'modified',
      schedule: '2500',
    }),
    /schedule must use HH:mm format/,
  );
});

test('Seasonal import V3 canonicalizes compact source times before V2 validation', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260724090000_seasonal_partial_import_v3.sql'),
    'utf8',
  );
  assert.match(migration, /normalize_seasonal_import_time_v3/);
  assert.match(migration, /\^\(\[01\]\[0-9\]\|2\[0-3\]\)\[0-5\]\[0-9\]\$/);
  assert.match(migration, /\^\[0-9\]\[0-5\]\[0-9\]\$/);
  assert.match(migration, /'sta',\s*public\.normalize_seasonal_import_time_v3\(source_row\.value->'sta'\)/);
  assert.match(migration, /'std',\s*public\.normalize_seasonal_import_time_v3\(source_row\.value->'std'\)/);
});
