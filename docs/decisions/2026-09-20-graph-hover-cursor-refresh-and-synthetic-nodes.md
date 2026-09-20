# Decision: graph hover state is re-derived from the last pointer position, and synthetic nodes show no pointer cursor

**Date:** 2026-09-20 · **Context:** OpenProject #3494 (Knowledge graph node hover cursor is not pointer in some case)

## Background

`Graph.vue` computed `hoveredNode` only in `onCanvasMouseMove`. The simulation, a filter change or a
wheel zoom can put a node under (or take one from under) a stationary pointer, so the cursor lagged
until the next mouse move, and a hovered node removed by a filter left the pointer over empty canvas.

## Decision

- The last pointer client position is remembered (cleared on `mouseleave`) and `refreshHoverFromPointer()`
  re-hit-tests it at the end of `relayout()` and on every zoom/pan. A hovered node no longer in
  `nodes` is released first, including its `fx`/`fy` pin.
- The `graph-view-canvas--hover` class follows `showsPointerCursor`: a hovered node that is not
  synthetic. Synthetic folder/root nodes still set `hoveredNode` (tooltip, hover pin) but keep the
  default cursor, because `navigateToNode()` ignores them and a pointer promises a click target.

## Rejected

- Pointer cursor on every hovered node, as before: advertises a click that does nothing.
- Re-testing only inside `onTick`: misses filter changes and zooms while the simulation is at rest.
