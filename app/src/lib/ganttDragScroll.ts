export interface GanttDragPointer {
  clientX: number;
  clientY: number;
}

export interface GanttScrollRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type GanttDragScrollAxis = 'vertical' | 'both';

export function calculateGanttEdgeScrollVelocity(input: {
  pointer: GanttDragPointer;
  rect: GanttScrollRect;
  threshold?: number;
  maxSpeed?: number;
  axis?: GanttDragScrollAxis;
}): { x: number; y: number } {
  const threshold = Math.max(1, input.threshold ?? 56);
  const maxSpeed = Math.max(0, input.maxSpeed ?? 28);
  const axisSpeed = (distanceToStart: number, distanceToEnd: number): number => {
    if (distanceToStart < 0 || distanceToEnd < 0) return 0;
    if (distanceToStart < threshold) return -Math.ceil(((threshold - distanceToStart) / threshold) * maxSpeed);
    if (distanceToEnd < threshold) return Math.ceil(((threshold - distanceToEnd) / threshold) * maxSpeed);
    return 0;
  };
  return {
    x: input.axis === 'vertical'
      ? 0
      : axisSpeed(input.pointer.clientX - input.rect.left, input.rect.right - input.pointer.clientX),
    y: axisSpeed(input.pointer.clientY - input.rect.top, input.rect.bottom - input.pointer.clientY),
  };
}

export function normalizeGanttWheelDelta(input: {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  pageHeight: number;
  lineHeight?: number;
  axis?: GanttDragScrollAxis;
}): { x: number; y: number } {
  const multiplier = input.deltaMode === 1
    ? input.lineHeight ?? 16
    : input.deltaMode === 2
      ? Math.max(1, input.pageHeight)
      : 1;
  return {
    x: input.axis === 'vertical' ? 0 : input.deltaX * multiplier,
    y: input.deltaY * multiplier,
  };
}

export function calculateClampedGanttScroll(input: {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  deltaX: number;
  deltaY: number;
}): { scrollLeft: number; scrollTop: number; changed: boolean } {
  const maxLeft = Math.max(0, input.scrollWidth - input.clientWidth);
  const maxTop = Math.max(0, input.scrollHeight - input.clientHeight);
  const scrollLeft = Math.max(0, Math.min(maxLeft, input.scrollLeft + input.deltaX));
  const scrollTop = Math.max(0, Math.min(maxTop, input.scrollTop + input.deltaY));
  return {
    scrollLeft,
    scrollTop,
    changed: scrollLeft !== input.scrollLeft || scrollTop !== input.scrollTop,
  };
}
