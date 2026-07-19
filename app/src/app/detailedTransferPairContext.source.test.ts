import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

test('detailed multi-date paste builds and reuses one transfer pair context', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/detailed/page.tsx'), 'utf8');
  const pasteStart = source.indexOf("if ((e.ctrlKey || e.metaKey) && e.key === 'v')");
  const pasteEnd = source.indexOf("if ((e.ctrlKey || e.metaKey) && e.key === 'a')", pasteStart);

  assert.ok(pasteStart >= 0 && pasteEnd > pasteStart, 'expected the detailed Ctrl+V handler');
  const pasteBlock = source.slice(pasteStart, pasteEnd);
  const contextBuilds = pasteBlock.match(/buildDetailedTransferPairContext\(allLegs\)/g) ?? [];
  const contextBuildIndex = pasteBlock.indexOf('buildDetailedTransferPairContext(allLegs)');
  const targetLoopIndex = pasteBlock.indexOf('sweepSelectedDates.forEach');

  assert.equal(contextBuilds.length, 1, 'multi-date paste must build exactly one pair context');
  assert.ok(contextBuildIndex < targetLoopIndex, 'pair context must be built before the target-date loop');
  assert.match(pasteBlock.slice(targetLoopIndex), /pairContext:\s*transferPairContext/);
  assert.doesNotMatch(source, /resolveSeasonalPairs/);
});
