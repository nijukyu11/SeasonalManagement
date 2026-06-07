import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('main Seasonal import uses scoped patch and does not call full baseline replace', () => {
  const source = readFileSync(join(root, 'app', 'SeasonalSchedulePage.tsx'), 'utf8');
  assert.match(source, /buildSeasonalImportPatch/);
  assert.match(source, /deleteModifications\(seasonId, modificationDeleteRecordIds\)/);
  assert.match(source, /sourceRows: \[\]/);
  assert.match(source, /totalSourceRows: 0/);
  assert.doesNotMatch(source, /clearSeasonBaseline/);
  assert.doesNotMatch(source, /batchWriteSourceRows/);
});

test('Settings keeps the explicit full-season repair import path', () => {
  const settingsSource = readFileSync(join(root, 'app', 'settings', 'page.tsx'), 'utf8');
  const repairSource = readFileSync(join(root, 'app', 'settings', 'components', 'SeasonRepairTab.tsx'), 'utf8');
  assert.match(settingsSource, /handleSeasonRepairImport/);
  assert.match(settingsSource, /clearSeasonBaseline\(seasonId\)/);
  assert.match(settingsSource, /sourceRows: \[\]/);
  assert.match(settingsSource, /totalSourceRows: 0/);
  assert.doesNotMatch(settingsSource, /batchWriteSourceRows/);
  assert.match(repairSource, /Seasonal Full Replace/);
});

test('remote source-row mutation APIs remain disabled for seasonal atomic data', () => {
  const source = readFileSync(join(root, 'lib', 'remoteStore.ts'), 'utf8');
  assert.match(source, /return \[\]/);
  assert.match(source, /Source row writes are disabled\. Seasonal data is stored as atomic flight records\./);
  assert.match(source, /export async function addSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function deleteSourceRow[\s\S]*throw sourceRowWritesDisabled\(\)/);
  assert.match(source, /export async function linkSourceRows[\s\S]*throw sourceRowWritesDisabled\(\)/);
});
