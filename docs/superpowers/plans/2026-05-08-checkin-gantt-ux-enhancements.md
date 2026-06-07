# Check-in Gantt UX Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the existing `/checkin` Gantt with flight color coding, edge auto-scroll, packed unallocated layout, frozen panes, and drag/resize feedback.

**Architecture:** Keep domain-neutral calculations in `app/src/lib/checkinAllocation.ts` and route-specific pointer/scroll behavior in `app/src/app/checkin/page.tsx`. Preserve the local-first persistence path already used by allocation edits.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, existing rule regression harness.

---

### Task 1: Pure Helper Coverage

**Files:**
- Modify: `app/scripts/rule-regression-tests.cjs`
- Modify: `app/src/lib/checkinAllocation.ts`

- [ ] Add regressions for deterministic carrier colors, timeline masonry lane packing, and edge-scroll velocity calculation.
- [ ] Run `npm run test:rules` and verify the new tests fail before implementation.
- [ ] Add helper exports for `getCheckInColorToken`, `buildCheckInPackedRows`, and `calculateCheckInEdgeScroll`.
- [ ] Run `npm run test:rules` and verify all rule regressions pass.

### Task 2: Route Interaction Wiring

**Files:**
- Modify: `app/src/app/checkin/page.tsx`

- [ ] Apply deterministic color styles to unallocated and allocated bars.
- [ ] Replace one-row-per-flight unallocated rendering with packed rows from the helper.
- [ ] Add drag splitter and collapse/expand state for the unallocated pool.
- [ ] Keep timeline and unallocated pool above the resource grid while only the resource rows scroll vertically.
- [ ] Add edge auto-scroll during drag/resize, target row highlighting, animated bar transitions, and resize snap guideline.
- [ ] Run targeted ESLint and TypeScript checks.

### Task 3: Verification

**Files:**
- Verify touched files only unless build requires more.

- [ ] Run `npm run test:rules`.
- [ ] Run `npx eslint src/app/checkin/page.tsx src/lib/checkinAllocation.ts scripts/rule-regression-tests.cjs`.
- [ ] Run `npx tsc --noEmit --pretty false`.
- [ ] Run `npm run build`.
- [ ] Check `http://localhost:3000/checkin` returns `200`.
