# Cardinal wiki — handoff 7: Cobalt typography, light + dark

**Repo:** `dylan-hart/wiki`, branch `scarlett`. Scope: type only — face, size, weight, line-height, tracking, case and text colour for every role the Cobalt aesthetic draws, under `body.body--cobalt` and `body.body--cobalt.body--dark`. No shape, layout or surface-colour changes; those landed in earlier handoffs and are not re-specified here.

Read: this README → `cobalt-typography.md` (the spec: role table, colour map, removals, tests) → the `.dc.html` screens as the pixel reference. Open a `.dc.html` in Chromium; `support.js` and `_ds/` beside it are what it loads. They are design references built in HTML, not code to ship.

## Contents

```
handoff-7/
  README.md                                          this file
  cobalt-typography.md                               the spec
  cobalt/
    Cardinal Wiki - Page View 3x - Cobalt.dc.html         canonical page view, light — every prose + chrome role
    Cardinal Wiki - Page View Dark 3x - Cobalt.dc.html    same screen, dark — same metrics, dark colour map
    Cardinal Wiki - Primitives 3x - Cobalt.dc.html        buttons, fields, toasts, confirm, marks, section header — light
    Cardinal Wiki - Primitives Dark 3x - Cobalt.dc.html   same, dark
    Cardinal Wiki - Editor 3x - Cobalt.dc.html            editable title/description, toolbar glyphs, source pane, preview
    Cardinal Wiki - Admin 3x - Cobalt.dc.html             admin nav labels, dashboard counters, page title
    Cardinal Wiki - Search 3x - Cobalt.dc.html            result titles, snippets, filter kickers, count line
  ledger/
    Cardinal Wiki - Page View 3x - Ledger.dc.html         for comparison only: the same roles in Ledger
  support.js, _ds/                                   runtime the screens load; ignore
```

## Start here

Two reported defects, both in the page view — see `cobalt-typography.md` §0: (1) the rendered article is set on a 16px base with a 24px h2 where the mockups draw 15.5px and 26px; (2) the in-content h1 takes `--color-ink`, which under Cobalt is navy `#10194a`, so h1 and h2 together read as "all blue" — only h2 is cobalt; h1 and h3+ are body ink. (3) The sidebar cards render too small in the live build even though their declared sizes read right — something else in the cascade is winning; §0.3 gives the absolute targets and how to trace it. Also there: tag chips at weight 500, and no `#` hash on Cobalt's pill.

## In one paragraph

Cobalt does not have its own type scale. It sets the same three faces at the same sizes, weights and tracking as Ledger — Barlow Condensed for headings and short display labels, Barlow for body and controls, Roboto Mono for metadata and eyebrows — and changes only the colour each role is drawn in, plus four role swaps listed in the spec (table head, numbered steps, tag chips, contents active row). Anything in the Cobalt build that differs from Ledger in size, weight, line-height, tracking or case is a defect unless it is one of those four. Dark is a colour map on top of light; no metric changes.

## Fidelity

High. The role table in `cobalt-typography.md` is exhaustive for the screens included; match it exactly and reference the existing `--font-sans` / `--font-display` / `--font-mono` stacks rather than literal family names. Where a value already exists as a token (`--color-text-body`, `--color-heading-h2`, `--color-accent-strong`, the `--content-table-head-*` set), use the token.
