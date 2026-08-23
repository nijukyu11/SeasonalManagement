import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');

test('gate settles local acknowledgements and queued remote events by server sequence', () => {
  assert.match(source, /appliedEvents\?:\s*SeasonChangeEvent\[\]/);
  assert.match(source, /acknowledgedServerSeq\?:\s*number/);
  assert.match(source, /acknowledgedServerSeq:\s*nativeResult\.nextServerSeq/);
  assert.match(source, /const submittedModsByLegId = new Map\(entry\.mods\.map/);
  assert.match(source, /findLatestSequencedModificationPatch\(\s*result\.appliedEvents,\s*legId,\s*'local-ack',\s*submittedModsByLegId\.get\(legId\),\s*result\.acknowledgedServerSeq,\s*\)/);
  assert.match(source, /ganttInteractionArbiter\.settle\(/);
  assert.match(source, /applyServerModificationPatch\(/);
});

test('gate locks each target before the debounced server commit', () => {
  assert.match(source, /for \(const legId of legIds\) \{\s*ganttInteractionArbiter\.begin/);
  assert.match(source, /ganttInteractionArbiter\.cancel/);
});

test('gate emits direct refreshes for canonical patches and reconciles incomplete acknowledgements', () => {
  assert.match(source, /refreshMode:\s*SeasonWorkspaceChangeEvent\['refreshMode'\]/);
  assert.match(source, /'direct'/);
  assert.match(source, /markSeasonWorkspaceStale\([\s\S]*?'mutation'/);
  assert.match(source, /'revalidate'/);
});
