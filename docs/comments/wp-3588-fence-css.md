# WP 3588: recommended comments for the code-fence CSS and start-number helper

No comments were added by the implementation. Recommended additions (the rubric's "why" cases only):

## `frontend/src/css/_page-contents.css`

- `pre.codeblock { isolation: isolate; ... }`: isolated so the rows' `z-index: -1` paints above the
  panel's own background but below the code text, which keeps the wash from tinting the tokens on it.
- `.line-numbers-rows > span.is-highlighted`: the wash is the row's own background plus a full-bleed
  `box-shadow`, clipped back to the row's own height by `clip-path`. An outer shadow is not painted
  inside its own box, hence both. It reaches the panel's edges without adding to `scrollWidth`, which a
  wide absolutely positioned box would, and the gutter geometry above stays untouched (pinned by
  `_page-contents.test.js`).
- `pre.codeblock:not(.line-numbers) > code > .line-numbers-rows`: a fence with `linesHighlight` but a
  single line gets rows and no gutter class, so the rows are taken out of flow here; otherwise their
  empty spans would add blank height below the code. `height: 1lh` because an empty span has no line box.
- `--codeline-offset` in `counter-reset`: set by `helpers/renderedContent.js`'s `tagCodeLineStart` from
  `data-line-start`. A typed `attr(data-line-start type(<integer>))` is not supported in every browser
  the app targets, and an inline `--code-line-start` from the renderer would be stripped by the style
  whitelist for an author without `write:styles`.
- `.codeblock-titled`: carries `hljs`, so an administrator-chosen highlight theme colours the wrapper;
  `.codeblock-title` takes `background-color: inherit` from it so bar and panel cannot drift. The
  wrapper's own background is restated under Cobalt for the same reason `pre`'s is (the theme's `.hljs`
  rule outranks an element selector). The wrapper's `border-radius` keeps its background from showing
  square behind the bar's rounded corners. `direction: ltr` matches the panel's pin so the edge stays on
  the same side in RTL.
- `--content-code-highlight`: derived from `--content-code-keyword` so the wash follows whichever code
  palette the aesthetic, mode or print block selects; the row's 2px `::after` edge uses the keyword
  colour itself so a highlight still reads on paper, where backgrounds are dropped.

## `frontend/src/helpers/renderedContent.js`

- `tagCodeLineStart`: same reason as `tagCodeLanguage` (the render is stored, and the pass runs over
  every page as displayed). Digits only and at most nine of them, because the value is author-controlled
  and lands in a CSS counter. Sets nothing for a block with no `data-line-start`.
