import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/hooks/useGanttDragScroll.ts'), 'utf8');

test('drag scroll installs a non-passive wheel listener only used while active', () => {
  assert.match(source, /if \(!activeRef\.current\) return/);
  assert.match(source, /addEventListener\('wheel',\s*handleWheel,\s*\{ passive: false, capture: true \}\)/);
  assert.match(source, /!element\.contains\(event\.target\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /removeEventListener\('wheel',\s*handleWheel,\s*\{ capture: true \}\)/);
});

test('edge scroll uses requestAnimationFrame and cleans it up', () => {
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /window\.cancelAnimationFrame/);
  assert.match(source, /useEffect\(\(\) => stop, \[stop\]\)/);
  assert.match(source, /onAfterScrollRef\.current\?\.\(pointer\)/);
});
