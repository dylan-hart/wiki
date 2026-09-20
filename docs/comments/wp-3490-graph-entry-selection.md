# Comment changes recommended by OpenProject #3490

Comments were not edited in the code; apply these by hand.

## `frontend/src/components/HeaderNav.vue`, doc comment above `onGraphNavClick`

Add one sentence: from a content page the viewed page is also written to `useGraphStore().select()`
before the push, so the graph opens with that page selected under its folder anchor. Keep it before
the `router.push` paragraph.

## `frontend/src/stores/graph.js`, header comment

- "A selected node is drawn by the nav SIDEBAR row, not by the graph canvas, which has no
  selected-node treatment of its own." is wrong: `Graph.vue#selectedNodeId` rings the selected node
  on the canvas. Replace with "A selected node is drawn by both the nav sidebar row and a ring on
  the graph canvas."
- Add that `HeaderNav.vue#onGraphNavClick` sets it on entry (the viewed page), besides the sidebar's
  in-graph clicks.

## `frontend/src/pages/Graph.vue`, doc comment above `selectedNodeId`

"Selection lives entirely in the sidebar ... the canvas has no click state of its own" should say the
selection is written by the sidebar and by the header's graph button on entry from a page; the
canvas still has no click state of its own.

## `frontend/src/pages/Graph.anchor.test.js`, comment in the "root-anchored ?path= (the home page)" test

"An empty `?path=` resolves to nothing (`resolveFocusNode`'s own falsy-path no-op)" is inaccurate:
`resolveFocusNode` no-ops only on `null`/`undefined`, and an empty string resolves to the synthetic
root node (see the #3490 test beside it). Replace with "An empty `?path=` anchors on the root, which
restricts nothing, so the whole locale stays visible."
