# Comment recommendations: OpenProject #3494 (frontend/src/pages/Graph.vue)

- `lastPointer` (next to `hoveredNode`): add `// Last pointer client position, re-tested by refreshHoverFromPointer() because nodes move and zoom changes without a mousemove; null once the pointer leaves.`
- `showsPointerCursor`: add `// Synthetic folder/root nodes hover (tooltip) but are not links: navigateToNode() ignores them.`
- `relayout()`'s doc comment: append that it also re-derives the hover from the last pointer position, so callers need no separate hover refresh.
- The `attachZoom` callback comment ("no node moved -- repaint, never relayout") still holds; note that the hover is re-tested there because the transform moves the graph under a stationary pointer.
