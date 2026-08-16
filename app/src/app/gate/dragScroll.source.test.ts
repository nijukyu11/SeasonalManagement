import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/gate/page.tsx'), 'utf8');

test('gate allocation uses pointer capture with the shared drag scroll controller', () => {
  assert.match(source, /useGanttDragScroll\(/);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /startGateDragScroll\([\s\S]*?drag\.kind === 'allocated' \? 'vertical' : 'both'/);
  assert.match(source, /updateGateDragScrollPointer\(\{ clientX: event\.clientX, clientY: event\.clientY \}\)/);
  assert.doesNotMatch(source, /\bdraggable=/);
  assert.doesNotMatch(source, /\bonDragOver=/);
});

test('gate drag scroll recomputes targets and supports pool and row drops', () => {
  assert.match(source, /onAfterScroll:[\s\S]*?updateGatePointerPreview\(clientX, clientY, drag\)/);
  assert.match(source, /data-gate-pool-drop="true"/);
  assert.match(source, /data-gate-drop-index=\{rowIndex\}/);
  assert.match(source, /touch-none/);
});

test('gate pointer cancellation stops scrolling and releases queued server state', () => {
  assert.match(source, /onPointerCancel=\{handleGatePointerCancel\}/);
  assert.match(source, /stopGateDragScroll\(\)/);
  assert.match(source, /releaseGateInteraction\(drag\.recordId\)/);
  assert.match(source, /event\.key === 'Escape'/);
});
