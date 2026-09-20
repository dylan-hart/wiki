# Recommended comments for WP 3541 (print gaps)

None were added in code. Suggested additions, each a real "why":

## `blocks/block-tabs/component.js`

- Above `@media print` in `static get styles()`: the panels' inline `display: none` (set by
  `_showActive`) can only be beaten by an `!important` author rule, and `::slotted(block-tab)::before`
  draws the label from `data-print-label` because `attr()` reads the light-DOM panel, which is the
  only place the label lives once the strip is hidden.
- Above the `:host` token block inside `@media print`: these are print overrides of body-level theme
  tokens, not fallbacks, so a dark or Cobalt page cannot print a near-black panel.
- At `panel.setAttribute('data-print-label', label)` in `_collectTabs`: stamped rather than read from
  `label` so the "Tab N" fallback prints too.

## `frontend/src/css/_print.css`

- Above `@page`: the margin is the sheet's, not the article's, so it cannot live under `.page-contents`.
- Above the `pre` rules: a wrapped line is acceptable on paper (unlike on screen, see the `pre` rule
  in `_page-contents.css`) because a browser cannot scroll a printed page.
- Above `.line-numbers-rows { display: none }`: the gutter is absolutely positioned per source line, so
  once a line wraps the numbers no longer line up with the code.
