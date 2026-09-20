# Comment recommendations: WP 3527 (graph filter rows fill width)

Comments were not edited in this change; these are the recommended edits.

## `frontend/src/components/GraphClientTypeFilter.vue`

Stale after this change: the comment above `.graph-client-type-filter-options` says
`justify-content: flex-end` keeps a wrapped remainder aligned with the right-aligned panel. Both are
gone (rows are left-aligned and each checkbox is `flex: 1 1 0`). Replace with:

> `flex-wrap` is a fallback for a locale whose labels overflow the panel width. Each checkbox takes an
> equal share of the row (`1fr`-like); a long label keeps its minimum.

## `frontend/src/pages/Graph.vue`

Add above `.graph-view-control-group`'s `:deep(.w-btn-toggle__segment)`:

> Segments share their toggle equally, like `1fr` tracks; a long label keeps its minimum.

Add above `.graph-view-control-row > .w-btn-toggle`:

> `--option-count` (set in the template) makes each toggle grow in proportion to its option count, so
> every option across both toggles ends up the same width; the zero basis lets that count, not the
> labels' natural widths, decide the split.

The existing comment on `.graph-view-control-row` stays accurate.

## `frontend/src/pages/Graph.controlLayout.test.js`

- Header: "tell whether this row wraps" could read "tell whether these rows wrap or fill their width".
- Above the `combined` assertions: "Within a pixel of the content width: a stretch that stops short
  fails, and so does a toggle pair that overflows the panel."
- Above the segment-width assertion: "3px, not 0: the selected segment is bold and so has a wider
  minimum, and the first segment of a toggle carries one more border pixel."
