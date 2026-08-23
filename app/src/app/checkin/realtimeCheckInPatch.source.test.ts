import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');
const nativeStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');

test('check-in retains canonical mutation events and settles per target by server sequence', () => {
  assert.match(nativeStore, /appliedEvents:\s*result\.appliedEvents/);
  assert.match(nativeStore, /nextServerSeq:\s*result\.nextServerSeq/);
  assert.match(source, /appliedEvents\?:\s*SeasonChangeEvent\[\]/);
  assert.match(source, /acknowledgedServerSeq\?:\s*number/);
  assert.match(source, /acknowledgedServerSeq:\s*nativeResult\.nextServerSeq/);
  assert.match(source, /const submittedModsByLegId = new Map\(entry\.mods\.map/);
  assert.match(source, /findLatestSequencedModificationPatch\(\s*result\.appliedEvents,\s*legId,\s*'local-ack',\s*submittedModsByLegId\.get\(legId\),\s*result\.acknowledgedServerSeq,\s*\)/);
  assert.match(source, /ganttInteractionArbiter\.settle\(/);
  assert.match(source, /applyServerModificationPatch\(/);
  assert.match(source, /if \(appliedMods\.length > 0\) \{[\s\S]*?applyOptimisticCheckInModifications\(appliedMods\);[\s\S]*?promoteLatestCheckInModificationsForView\(\);[\s\S]*?publishWorkspaceChange\(/);
});

test('check-in registers target locks before debounced commit and lets direct changes through', () => {
  assert.match(source, /for \(const legId of legIds\) \{\s*ganttInteractionArbiter\.begin/);
  assert.match(source, /event\.refreshMode !== 'direct'/);
  assert.match(source, /refreshMode:\s*SeasonWorkspaceChangeEvent\['refreshMode'\]/);
});

test('check-in falls back to server revalidation only when no server acknowledgement exists', () => {
  assert.match(source, /let needsRevalidation = false/);
  assert.match(source, /markSeasonWorkspaceStale\([\s\S]*?'mutation'/);
  assert.match(source, /'revalidate'/);
});
