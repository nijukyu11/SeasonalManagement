import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'src/app/checkin/page.tsx'), 'utf8');

test('check-in allocation uses pointer capture instead of native drag and drop', () => {
  assert.match(source, /useGanttDragScroll\(/);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /onPointerMove=\{handleCheckInPointerMove\}/);
  assert.match(source, /onPointerUp=\{handleCheckInPointerUp\}/);
  assert.match(source, /onPointerCancel=\{handleCheckInPointerCancel\}/);
  assert.doesNotMatch(source, /\bdraggable=/);
  assert.doesNotMatch(source, /\bonDragOver=/);
});

test('check-in drag scroll preserves group geometry and recomputes drop targets', () => {
  assert.match(source, /startCheckInDragScroll\([\s\S]*?next\.kind === 'allocated' \? 'vertical' : 'both'/);
  assert.match(source, /updateCheckInDragScrollPointer\(\{ clientX: event\.clientX, clientY: event\.clientY \}\)/);
  assert.match(source, /onAfterScroll:[\s\S]*?updateCheckInPointerPreview\(clientX, clientY\)/);
  assert.match(source, /data-checkin-pool-drop="true"/);
  assert.match(source, /data-checkin-drop-index=\{rowIndex\}/);
  assert.match(source, /touch-none/);
});

test('check-in drag cancellation stops scrolling and releases queued server state', () => {
  assert.match(source, /const handleCheckInPointerCancel/);
  assert.match(source, /stopCheckInDragScroll\(\)/);
  assert.match(source, /releaseCheckInInteraction\(drag\.recordId\)/);
  assert.match(source, /event\.key === 'Escape'/);
});
