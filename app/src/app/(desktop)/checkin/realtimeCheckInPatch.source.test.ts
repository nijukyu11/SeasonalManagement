import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/(desktop)/checkin/page.tsx'), 'utf8');
const nativeStore = readFileSync(join(process.cwd(), 'src/lib/nativeLocalSeasonStore.ts'), 'utf8');

test('check-in retains canonical mutation events and settles per target by server sequence', () => {
  assert.match(nativeStore, /appliedEvents:\s*result\.appliedEvents/);
  assert.match(source, /appliedEvents\?:\s*SeasonChangeEvent\[\]/);
  assert.match(source, /const submittedModsByLegId = new Map\(entry\.mods\.map/);
  assert.match(source, /findLatestSequencedModificationPatch\(\s*result\.appliedEvents,\s*legId,\s*'local-ack',\s*submittedModsByLegId\.get\(legId\),\s*\)/);
  assert.match(source, /ganttInteractionArbiter\.settle\(/);
  assert.match(source, /applyServerModificationPatch\(/);
});

test('check-in registers target locks before debounced commit and lets direct changes through', () => {
  assert.match(source, /for \(const legId of legIds\) \{\s*ganttInteractionArbiter\.begin/);
  assert.match(source, /event\.refreshMode !== 'direct'/);
  assert.match(source, /refreshMode:\s*SeasonWorkspaceChangeEvent\['refreshMode'\]/);
});

test('check-in falls back to server revalidation when no sequenced acknowledgement exists', () => {
  assert.match(source, /let needsRevalidation = false/);
  assert.match(source, /markSeasonWorkspaceStale\([\s\S]*?'mutation'/);
  assert.match(source, /'revalidate'/);
});
