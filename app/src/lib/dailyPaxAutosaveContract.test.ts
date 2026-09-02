import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { flightModificationChangedFields } from './persistenceSchema.ts';

test('Daily Pax cells share the nullable numeric mapping for ARR, DEP and generic Pax', async () => {
  const source = await readFile(new URL('./dailySchedule.ts', import.meta.url), 'utf8');
  assert.match(source, /case 'pax':\s*\n\s*case 'arrPax':\s*\n\s*case 'depPax':\s*\n\s*mod\.pax = nullableNumber\(value\)/u);
  assert.match(source, /if \(trimmed === ''\) return null;[\s\S]*Number\(trimmed\)/u);
});

test('server-authoritative Pax operations declare pax as the changed field', () => {
  assert.deepEqual(flightModificationChangedFields({
    legId: 'LEG-1',
    action: 'modified',
    pax: 212,
  }), ['pax']);
  assert.deepEqual(flightModificationChangedFields({
    legId: 'LEG-1',
    action: 'modified',
    pax: null,
  }), ['pax']);
});

test('server-authoritative mutation sends declared changedFields through the RPC seam', async () => {
  const source = await readFile(new URL('./nativeLocalSeasonStore.ts', import.meta.url), 'utf8');
  assert.match(source, /changedFields:\s*flightModificationChangedFields\(persistedMod\)/u);
  assert.match(source, /applySeasonServerMutationV1\([\s\S]*operations/u);
});
