# WP 3578: recommended comments for `frontend/src/renderers/markdown.js`

No comments were added by the implementation; the `highlight` option's existing comments were moved
verbatim into `codeBlock()`. Recommended additions (the rubric's "why" cases only):

- `FENCE_ATTRIBUTE`: a key with no value does not match, so a fence with extra words and no
  `key=value` parses to `{}` and renders exactly as it did before attributes existed. A quoted value
  may contain its own quote when backslash-escaped.
- `parseFenceInfo`: values are unescaped one by one after being cut out of the info string, never over
  the whole string, because unescaping first lets `\"` close the value it was written into.
- `parseLineRanges`: ranges stay as `[from, to]` pairs rather than expanded sets, so `1-40000000` costs
  nothing. Malformed entries are dropped rather than thrown: this render is the editor preview and what
  is saved. `8-5` is read as 5-8.
- `lineRows` / `codeBlock`: highlighting is the row's own background, so the highlighted HTML is never
  split on newlines. A single-line block gets no gutter class but a highlight on it still needs its row.
- `data-line-start` in `codeBlock`: an attribute, not an inline `--code-line-start` custom property,
  because `backend/helpers/htmlSanitizePolicy.ts`'s `ALLOWED_STYLES` whitelist would strip the property
  for an author without `write:styles`, while `class` and `data-*` survive
  (`backend/models/rendering.test.ts` pins both halves). Omitted at the default of 1.
- `md.renderer.rules.fence`: owned here because markdown-it's `highlight` option is handed only the
  first word of the info string. The output is unchanged for a fence without attributes.
