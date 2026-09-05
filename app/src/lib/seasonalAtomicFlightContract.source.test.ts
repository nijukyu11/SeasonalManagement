import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');
const seasonalPage = readFileSync(resolve(root, 'src/app/(desktop)/SeasonalSchedulePage.tsx'), 'utf8');
const detailedPage = readFileSync(resolve(root, 'src/app/(desktop)/detailed/page.tsx'), 'utf8');
const aggregator = readFileSync(resolve(root, 'src/lib/seasonalDisplayAggregator.ts'), 'utf8');
const exportPageStart = seasonalPage.indexOf('const handleExportUpdated');
const exportPage = seasonalPage.slice(exportPageStart, seasonalPage.indexOf('const handleAddToDraft', exportPageStart));

test('Season export and render share the canonical effective atomic-flight resolver', () => {
  assert.match(exportPage, /materializeEffectiveSeasonalLegs\(\s*exportSnapshot\.records,\s*exportSnapshot\.modifications/);
  assert.match(seasonalPage, /const activeDisplayLegs = useMemo\(\s*\(\) => materializeEffectiveSeasonalLegs\(flightRecords, modifications\)/);
  assert.doesNotMatch(seasonalPage, /function applyModificationsToLegs/);
  assert.match(aggregator, /materializeEffectiveSeasonalLegs\(records, modifications\)/);
  assert.doesNotMatch(aggregator, /next\.push\(\{ \.\.\.mod\.addedLeg/);
});

test('Detailed render and Save address active canonical record ids only', () => {
  assert.match(detailedPage, /applyModificationsToFlightLegs\(baseAllLegs, nextMods\)/);
  assert.match(detailedPage, /const baseRecordIds = activeCanonicalFlightRecordIds\(draftState\.baseRecords\)/);
  assert.match(detailedPage, /selectedLegs\.map\(\(leg\) => \(\{ legId: leg\.id, action: 'deleted'/);
  assert.match(detailedPage, /new Map\(flightRecords\.map\(\(record\) => \[record\.id, record\]\)\)/);
});
