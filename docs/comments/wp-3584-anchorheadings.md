# WP 3584: comment recommendations

## `backend/models/rendering.ts`

- `anchorHeadings` docblock: extend to say a `block-tab[header]` with a bare-digit level and a
  non-empty `label` is anchored and listed in the same document-order pass as `h1`-`h6`, with the
  `id` set on the `block-tab` element itself; any other `header` value leaves an ordinary tab.
- `tabHeadingLevel`: no comment needed; the regex says it. Optionally note that digits 1-6 only is
  deliberate, matching the block's `header` prop contract shared with the panel scroll-margin rule.
