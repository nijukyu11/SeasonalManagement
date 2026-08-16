'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import {
  calculateClampedGanttScroll,
  calculateGanttEdgeScrollVelocity,
  normalizeGanttWheelDelta,
  type GanttDragPointer,
  type GanttDragScrollAxis,
} from '@/lib/ganttDragScroll';

interface UseGanttDragScrollOptions {
  scrollRef: RefObject<HTMLElement | null>;
  edgeThreshold?: number;
  maxEdgeSpeed?: number;
  onAfterScroll?: (pointer: GanttDragPointer) => void;
}

export function useGanttDragScroll({ scrollRef, edgeThreshold = 64, maxEdgeSpeed = 30, onAfterScroll }: UseGanttDragScrollOptions) {
  const activeRef = useRef(false);
  const axisRef = useRef<GanttDragScrollAxis>('both');
  const pointerRef = useRef<GanttDragPointer | null>(null);
  const frameRef = useRef<number | null>(null);
  const onAfterScrollRef = useRef(onAfterScroll);

  useEffect(() => {
    onAfterScrollRef.current = onAfterScroll;
  }, [onAfterScroll]);

  const applyDelta = useCallback((deltaX: number, deltaY: number): boolean => {
    const element = scrollRef.current;
    if (!element) return false;
    const next = calculateClampedGanttScroll({
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      deltaX,
      deltaY,
    });
    if (!next.changed) return false;
    element.scrollLeft = next.scrollLeft;
    element.scrollTop = next.scrollTop;
    const pointer = pointerRef.current;
    if (pointer) onAfterScrollRef.current?.(pointer);
    return true;
  }, [scrollRef]);

  const stopFrame = useCallback(() => {
    if (frameRef.current == null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const scheduleEdgeFrameRef = useRef<() => void>(() => undefined);
  const runEdgeFrame = useCallback(() => {
    frameRef.current = null;
    const element = scrollRef.current;
    const pointer = pointerRef.current;
    if (!activeRef.current || !element || !pointer) return;
    const velocity = calculateGanttEdgeScrollVelocity({
      pointer,
      rect: element.getBoundingClientRect(),
      threshold: edgeThreshold,
      maxSpeed: maxEdgeSpeed,
      axis: axisRef.current,
    });
    if (velocity.x === 0 && velocity.y === 0) return;
    const moved = applyDelta(velocity.x, velocity.y);
    if (moved) frameRef.current = window.requestAnimationFrame(scheduleEdgeFrameRef.current);
  }, [applyDelta, edgeThreshold, maxEdgeSpeed, scrollRef]);

  const scheduleEdgeFrame = useCallback(() => {
    if (!activeRef.current || frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(runEdgeFrame);
  }, [runEdgeFrame]);
  scheduleEdgeFrameRef.current = scheduleEdgeFrame;

  const start = useCallback((pointer: GanttDragPointer, axis: GanttDragScrollAxis = 'both') => {
    activeRef.current = true;
    axisRef.current = axis;
    pointerRef.current = pointer;
    scheduleEdgeFrame();
  }, [scheduleEdgeFrame]);

  const updatePointer = useCallback((pointer: GanttDragPointer) => {
    if (!activeRef.current) return;
    pointerRef.current = pointer;
    scheduleEdgeFrame();
  }, [scheduleEdgeFrame]);

  const stop = useCallback(() => {
    activeRef.current = false;
    pointerRef.current = null;
    stopFrame();
  }, [stopFrame]);

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!activeRef.current) return;
      const element = scrollRef.current;
      if (!element || !(event.target instanceof Node) || !element.contains(event.target)) return;
      const delta = normalizeGanttWheelDelta({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        pageHeight: element.clientHeight,
        axis: axisRef.current,
      });
      event.preventDefault();
      applyDelta(delta.x, delta.y);
      scheduleEdgeFrame();
    };
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleWheel, { capture: true });
  }, [applyDelta, scheduleEdgeFrame, scrollRef]);

  useEffect(() => stop, [stop]);

  return { start, updatePointer, stop };
}
