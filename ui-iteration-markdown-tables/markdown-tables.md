# Rendered markdown tables — Ledger and Cobalt

Board: `Cardinal Wiki - Markdown Tables 3x.dc.html` (1a Ledger, 1b Cobalt; each light + dark in the article column, then a hover-row tile light + dark and a 300px wide-table tile).
Source: `frontend/src/css/_page-contents.scss` on `scarlett` — the `--content-table-*` tokens in the palette block (~L130–160), the Cobalt override (~L445–530) and the `// TABLES` section (~L1918–2075).

## What changes

The table markup, `renderers/markdown.js` and the three author classes (`table-leading-col`, `table-code-nohighlight`, `table-vertical-middle`) stay. Three things in the current stylesheet are not in either aesthetic and go:

1. **The dark title-bar head.** `thead` is painted `#292f39 → #0d1117` as a radial gradient with white ink. Both aesthetics head the table with a *tinted strip* in the theme's own tint, not a dark bar. Delete `--content-table-head-grade`, `--content-table-head-ink` as white, `--content-table-head-rule` as white-alpha, and the `background-image: radial-gradient(...)` on `thead`.
2. **The drop shadow.** `--content-table-shadow` goes to `none` in both aesthetics (Cobalt's global rule; Ledger draws no shadows on content plates either).
3. **The "both rows tinted" body.** The plain row is the surface (`#fff` / panel), and only every second row is banded.

Both aesthetics keep **row rules, column rules and banding** — this is a readability rule, not a style choice. They differ in how they're drawn.

## Token table

Add to the palette block (Ledger light defaults on `.page-contents`, then the three override blocks that already exist):

| property | Ledger light | Ledger dark | Cobalt light | Cobalt dark |
|---|---|---|---|---|
| `--content-table-frame` | `#dbe1ec` | `#2a3040` | `#dfe5f5` | `rgba(255,255,255,.1)` |
| `--content-table-radius` | `0` | `0` | `8px` | `8px` |
| `--content-table-corner-marks` | `block` | `block` | `none` | `none` |
| `--content-table-shadow` | `none` | `none` | `none` | `none` |
| `--content-table-head` | `#f0f2f7` | `#14171f` | `#e6edff` | `#0e1540` |
| `--content-table-head-ink` | `#4e5d7d` | `#9aa6bd` | `#1f4fd6` | `#8fb0ff` |
| `--content-table-head-font` | `600 0.65625rem/1.4 var(--font-mono)` (10.5px) | same | `600 0.8125rem/1.4 var(--font-sans)` (13px) | same |
| `--content-table-head-tracking` | `.14em` | `.14em` | `normal` | `normal` |
| `--content-table-head-transform` | `uppercase` | `uppercase` | `none` | `none` |
| `--content-table-head-rule` (below + between head cells) | `#dbe1ec` | `#2a3040` | `#d3ddfb` | `rgba(255,255,255,.08)` |
| `--content-table-rule` (row rules) | `#dbe1ec` | `#2a3040` | `#e6edff` | `rgba(255,255,255,.07)` |
| `--content-table-col-rule` (column rules in the body) | `#e9edf3` | `#232838` | `#e6edff` | `rgba(255,255,255,.07)` |
| `--content-table-row` | `transparent` | `transparent` | `transparent` | `transparent` |
| `--content-table-row-alt` | `#f7f8fb` | `rgba(255,255,255,.025)` | `#f6f8ff` | `rgba(255,255,255,.035)` |
| `--content-table-row-hover` | `#eef1f7` | `rgba(255,255,255,.05)` | `rgba(31,79,214,.1)` | `rgba(255,255,255,.08)` |
| `--content-table-hover-edge` | `inset 2px 0 0 #e4676b` | `inset 2px 0 0 #f08287` | `none` | `none` |
| `--content-table-cell-padding` | `9px 14px` | same | `10px 14px` | same |

Where a value equals an existing global token, use it: Ledger frame/rules are `--color-hairline` / `--color-hairline-dark`; Cobalt frame is the card border token; Cobalt head ink is `--color-heading-h2` (light) and the dark `#8fb0ff` it already uses for h2; head strips are `--color-tint` in each aesthetic.

## Shared rules (both aesthetics)

- **Wrapper.** The frame, radius, corner marks and shadow belong to a wrapper that owns `overflow-x:auto`; the `<table>` inside is `width:max-content; min-width:100%`. The current `table { display:block; overflow-x:auto }` trick cannot carry the Ledger corner marks (they sit *outside* the frame by 4px and would be clipped) or Cobalt's `overflow:hidden` radius without the scrollbar painting over the rounded corners. If the renderer can't wrap, keep `display:block` and accept no corner marks in Ledger — flag it.
- **Margin** `20px 0` (was `1.5em`).
- **Cells** top-aligned, `text-align:start`; body type Barlow `0.90625rem/1.5` (14.5px), colour `--content-ink`.
- **Alignment.** The renderer's inline `text-align` from `:---:` / `---:` still wins. Add: `td[style*="text-align:right"]` (and `th`) switch to `var(--font-mono)` `0.84375rem/1.6` (13.5px) with `font-variant-numeric: tabular-nums` and `white-space:nowrap` — right-aligned columns are numeric by convention. Centre columns stay in Barlow.
- **Rules.** Head cells: `border-bottom` and `border-inline-end` in `--content-table-head-rule`. Body cells: `border-bottom` in `--content-table-rule`, `border-inline-end` in `--content-table-col-rule`. `tr > :last-child` drops `border-inline-end`; `tbody:last-child tr:last-child > *` drops `border-bottom` (both already in the file) — the frame closes the grid.
- **Banding.** `tbody > tr:nth-child(even)` → `--content-table-row-alt`; odd rows are the surface (`--content-table-row: transparent`). Head is not counted.
- **Hover.** `tbody > tr:hover > td { background: var(--content-table-row-hover) }`, painted over the band; `tbody > tr:hover > td:first-child { box-shadow: var(--content-table-hover-edge) }`. Hover is `@media (hover:hover)` only.
- **Inline content** (code chips, links, `strong`) inherit the article's own rules — nothing table-specific.
- **Wide tables** scroll inside the frame. Scrollbar `scrollbar-width:thin`, colour `#c9d2e2 #f0f2f7` (Ledger) / `#c5cff5 #f2f5ff` (Cobalt); dark: `#2a3040 #14171f` / `rgba(255,255,255,.14) #0e1540`.
- The three author classes keep working unchanged: `table-leading-col` (first column 600), `table-code-nohighlight` (drop chip wash), `table-vertical-middle`.

## Ledger specifics

- Frame is a square 1px hairline, no shadow, two opposite corner marks — 7px, `#64789f`, top-left and bottom-right, drawn 4px outside the frame — the same marks the page header plate and the tabset block draw (`.page-header-icon__marks` pattern, `display: var(--content-table-corner-marks)`).
- Head is a mono eyebrow: Roboto Mono 600 10.5px, `.14em`, uppercase, `#4e5d7d` on `#f0f2f7`, `white-space:nowrap`.
- Row rules and column rules are both hairlines, but the column rule is one step fainter (`#e9edf3`) than the row rule (`#dbe1ec`) so the grid reads as a ledger sheet rather than a spreadsheet. Banding is `#f7f8fb` — the strip colour one step lighter.
- Hover: `#eef1f7` with the 2px `#e4676b` inset on the first cell — accent only on the live edge.
- Dark: frame and rules `#2a3040`, column rules `#232838`, head `#14171f` with `#9aa6bd` type, body on `#1b1f2a`, text `#e6eaf2`, band `rgba(255,255,255,.025)`, hover `rgba(255,255,255,.05)` with a `#f08287` inset.

## Cobalt specifics

- Card: 1px `#dfe5f5`, 8px radius, `overflow:hidden`, no shadow, no corner marks.
- Head is Barlow 600 13px `#1f4fd6` on `#e6edff`, sentence case, no tracking.
- Rules are *soft*: row and column rules in the strip colour `#e6edff`, so they read as tint edges rather than hairlines (Cobalt's no-hairline rule is about 1px separators in chrome; inside a data grid the rules are required for readability and are drawn in tint to stay matte). Head column rules step to `#d3ddfb` so they show on the strip.
- Banding `#f6f8ff`. Hover `rgba(31,79,214,.1)` over the band, no inset edge.
- Dark: card `#141c4f` with `rgba(255,255,255,.1)` border, head `#0e1540` with `#8fb0ff` type, text `#e8ecff`, rules `rgba(255,255,255,.07)` (head columns `.08`), band `rgba(255,255,255,.035)`, hover `rgba(255,255,255,.08)`, links `#7fa0ff`.

## Removals from the current stylesheet

- `--content-table-head-grade`, the `radial-gradient` on `thead`, and the white-alpha `--content-table-head-ink` / `--content-table-head-rule` values.
- `--content-table-shadow` values (both themes) → `none`.
- `--content-table-row` as a tint → `transparent`.
- `th { background-color: var(--content-surface-alt) }` for a *body* row header can stay (author HTML only), but `thead th` must take `--content-table-head` / `--content-table-head-ink`.
- Cobalt block: `--content-table-head: var(--color-dialog-header-bg)` and `--content-table-head-grade: #0b1238` → replaced by the Cobalt column above.

## Tests to update

`frontend/src/css/_page-contents.test.js` asserts the dark head bar and shadow; `helpers/accessibility.test.js` pins `--content-table-head-ink` against the near-black. Re-pin: Ledger head `#4e5d7d` on `#f0f2f7` (5.6:1), Cobalt head `#1f4fd6` on `#e6edff` (5.5:1), dark Ledger `#9aa6bd` on `#14171f` (7.9:1), dark Cobalt `#8fb0ff` on `#0e1540` (8.6:1).
