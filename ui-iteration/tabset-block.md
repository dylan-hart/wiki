# Tabset block (`block-tabs`) — Ledger and Cobalt

Board: `Cardinal Wiki - Tabset Block 3x.dc.html` (1a Ledger, 1b Cobalt; light + dark + states in each).
Source: `blocks/block-tabs/component.js`, `blocks/block-tab/component.js` on `scarlett`.

## What changes

The block's DOM, keyboard handling, `active` property, `block-reveal` and hash reveal all stay. Only `static get styles()` and the `:host` custom properties change. The block lives in a shadow root, so the app theme reaches it through custom properties set on `block-tabs` (or inherited from `body.body--cobalt` / `body.body--dark`). The current `--tabs-*` set is not enough; extend it:

| property | Ledger light | Ledger dark | Cobalt light | Cobalt dark |
|---|---|---|---|---|
| `--tabs-border` | `#dbe1ec` | `#2a3040` | `#dfe5f5` | `rgba(255,255,255,.1)` |
| `--tabs-radius` | `0` | `0` | `8px` | `8px` |
| `--tabs-shadow` | `none` | `none` | `none` | `none` |
| `--tabs-corner-marks` | `block` | `block` | `none` | `none` |
| `--tabs-strip-bg` | `#f0f2f7` | `#14171f` | `#e6edff` | `#0e1540` |
| `--tabs-strip-padding` | `0` | `0` | `4px 4px 0` | `4px 4px 0` |
| `--tabs-strip-gap` | `0` | `0` | `4px` | `4px` |
| `--tabs-strip-rule` | `1px solid var(--tabs-border)` | same | `none` | `none` |
| `--tabs-tab-padding` | `9px 16px` | same | `8px 14px` | same |
| `--tabs-tab-radius` | `0` | `0` | `6px 6px 0 0` | same |
| `--tabs-tab-rule` | `1px solid var(--tabs-border)` (right) | same | `none` | `none` |
| `--tabs-inactive-fg` | `#4e5d7d` | `#9aa6bd` | `#4a5580` | `#a7b3ea` |
| `--tabs-inactive-icon` | `#64789f` | `#8ea6cf` | `#5a6699` | `#8b98d6` |
| `--tabs-hover-bg` | `rgba(255,255,255,.6)` | `rgba(255,255,255,.05)` | `rgba(31,79,214,.08)` | `rgba(255,255,255,.08)` |
| `--tabs-hover-fg` | `#38465f` | `#e6eaf2` | `#1a2038` | `#e8ecff` |
| `--tabs-active-fg` | `#c14a52` | `#f08287` | `#1f4fd6` | `#8fb0ff` |
| `--tabs-active-weight` | `500` | `500` | `600` | `600` |
| `--tabs-active-cap` | `inset 0 2px 0 #e4676b` | `inset 0 2px 0 #f08287` | `inset 0 3px 0 #ff4d5a` | same |
| `--tabs-focus-ring` | `inset 0 0 0 2px #e4676b` | `inset 0 0 0 2px #f08287` | `inset 0 0 0 2px #1f4fd6` | `inset 0 0 0 2px #8fb0ff` |
| `--tabs-panel-bg` | `#fff` | `#1b1f2a` | `#fff` | `#141c4f` |
| `--tabs-panel-padding` | `18px 20px` (12px under 600px) | same | same | same |

Type: tab labels Barlow 13.5px, line-height 1.4, icon 15px (`1.15em` is fine). Gap between icon and label 7px.

## Ledger specifics

- The frame is a hairline, square, no shadow; two opposite corner marks (7px, `#64789f`) at top-left and bottom-right — the same marks the page header plate draws. Drawn with background gradients on an `aria-hidden` element as `.page-header-icon__marks` does; `display: var(--tabs-corner-marks)`.
- Active tab paints `--tabs-panel-bg`, gets the 2px accent cap (box-shadow inset, replaces the current `border-top: 3px`), and paints its bottom rule in the panel colour so it opens into the panel (`margin-bottom:-1px` stays).
- Every tab keeps a 1px right rule. Wrapped rows keep the strip's bottom rule under them.
- No gradient anywhere. Drop the `.tabs` box-shadow entirely, including the `[dark]` variant.

## Cobalt specifics

- The card is `overflow:hidden` with the 8px radius; the strip has no bottom rule and no tab rules — separation is the 4px gap and the tint.
- Tabs are tiles: 6px top radius; the active one is white (dark: `#141c4f`) with a 3px `#ff4d5a` cap (box-shadow inset so it follows the rounded corners). Hover is a flat tint on a 6px tile.
- Tabs on a wrapped upper row don't touch the panel: give them the full 6px radius and `margin-bottom:4px` (`.strip` has `row-gap:4px`, or match on `:not(:last-row)` by measuring, whichever the component prefers).
- Active label weight 600.

## Removals from the current stylesheet

`.tabs` box-shadow (both), `--tabs-strip-bg` gradient, `.tab { border-top: 3px solid transparent }` (replaced by the cap shadow), `--tabs-active-fg: var(--q-primary, #1976d2)` fallback.
