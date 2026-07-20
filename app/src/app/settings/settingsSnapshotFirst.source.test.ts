import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('page.tsx', import.meta.url), 'utf8');

test('Settings initializes from the operator-scoped snapshot and revalidates in the background', () => {
  assert.match(source, /readOperationalSettingsState\(\)/);
  assert.match(source, /snapshotState\.snapshot/);
  assert.match(source, /revalidateOperationalSettings\(\)/);
  assert.match(source, /getOperatorSessionEpoch\(\)/);
});

test('Settings writes are epoch fenced', () => {
  assert.match(source, /saveOperationalSettings\(normalized, \{ operatorSessionEpoch \}\)/);
});
