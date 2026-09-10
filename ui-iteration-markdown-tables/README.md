# Cardinal wiki — handoff 6: rendered markdown tables

**Repo:** `dylan-hart/wiki`, branch `scarlett`. Scope: one surface — GFM tables rendered inside `.page-contents` (article column and editor preview pane), in both aesthetics, light and dark.

Read: this README → `markdown-tables.md` (spec + token table + removals) → `Cardinal Wiki - Markdown Tables 3x.dc.html` as the pixel reference. Open the `.dc.html` in Chromium; `support.js` and `_ds/` beside it are what it loads. It is a design reference built in HTML, not code to ship.

## Contents

```
handoff-6/
  README.md                                     this file
  markdown-tables.md                            spec, --content-table-* token table, removals, tests
  Cardinal Wiki - Markdown Tables 3x.dc.html    the board: 1a Ledger / 1b Cobalt, light + dark,
                                                hover (light + dark) and 300px wide-table tiles
  design-decisions.md                           locked decisions (project CLAUDE.md; the Markdown tables entry is new)
  support.js, _ds/                              runtime the board loads; ignore
```

## In one paragraph

The current table in `_page-contents.scss` is headed by a dark gradient bar under a drop shadow with both rows tinted. Neither aesthetic draws that. Both become a **tinted-strip head over a ruled, banded body inside the theme's own frame**: Ledger a square hairline plate with two corner marks, mono eyebrow header, hairline row rules with fainter column rules, `#f7f8fb` bands, accent-inset hover; Cobalt an 8px matte card, Barlow cobalt header, rules drawn in the strip tint `#e6edff`, `#f6f8ff` bands, cobalt-tint hover. Rules + banding are required in both — readability, not style. Right-aligned (`---:`) columns are set in Roboto Mono with tabular figures.

## Fidelity

High: match colours, sizes and spacing exactly as listed in `markdown-tables.md`. Where a value already exists as a global token (`--color-hairline`, `--color-tint`, `--color-heading-h2`, the Cobalt card border), reference the token rather than the literal.
