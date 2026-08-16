import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateClampedGanttScroll,
  calculateGanttEdgeScrollVelocity,
  normalizeGanttWheelDelta,
} from './ganttDragScroll.ts';

const rect = { left: 10, right: 210, top: 20, bottom: 220 };

test('edge velocity accelerates toward the edge and respects vertical locking', () => {
  assert.deepEqual(calculateGanttEdgeScrollVelocity({ pointer: { clientX: 110, clientY: 120 }, rect }), { x: 0, y: 0 });
  assert.deepEqual(calculateGanttEdgeScrollVelocity({ pointer: { clientX: 12, clientY: 22 }, rect, threshold: 40, maxSpeed: 20 }), { x: -19, y: -19 });
  assert.deepEqual(calculateGanttEdgeScrollVelocity({ pointer: { clientX: 208, clientY: 218 }, rect, threshold: 40, maxSpeed: 20 }), { x: 19, y: 19 });
  assert.deepEqual(calculateGanttEdgeScrollVelocity({ pointer: { clientX: 12, clientY: 22 }, rect, axis: 'vertical' }), { x: 0, y: -27 });
  assert.deepEqual(calculateGanttEdgeScrollVelocity({ pointer: { clientX: 5, clientY: 120 }, rect }), { x: 0, y: 0 });
});

test('normalizes high-resolution, line, and page wheel deltas', () => {
  assert.deepEqual(normalizeGanttWheelDelta({ deltaX: 1.5, deltaY: 2.5, deltaMode: 0, pageHeight: 500 }), { x: 1.5, y: 2.5 });
  assert.deepEqual(normalizeGanttWheelDelta({ deltaX: 1, deltaY: -2, deltaMode: 1, pageHeight: 500 }), { x: 16, y: -32 });
  assert.deepEqual(normalizeGanttWheelDelta({ deltaX: 1, deltaY: 1, deltaMode: 2, pageHeight: 500, axis: 'vertical' }), { x: 0, y: 500 });
});

test('clamps scroll positions and reports whether the element moved', () => {
  assert.deepEqual(calculateClampedGanttScroll({ scrollLeft: 20, scrollTop: 30, scrollWidth: 400, scrollHeight: 500, clientWidth: 100, clientHeight: 200, deltaX: -50, deltaY: 500 }), { scrollLeft: 0, scrollTop: 300, changed: true });
  assert.deepEqual(calculateClampedGanttScroll({ scrollLeft: 0, scrollTop: 300, scrollWidth: 400, scrollHeight: 500, clientWidth: 100, clientHeight: 200, deltaX: -5, deltaY: 5 }), { scrollLeft: 0, scrollTop: 300, changed: false });
});
