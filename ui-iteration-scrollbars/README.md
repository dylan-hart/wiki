# Cardinal wiki — handoff 8: scrollbars, Ledger + Cobalt, light + dark

**Repo:** `dylan-hart/wiki`, branch `scarlett`. Scope: scrollbars only — the gutter, track and thumb drawn on every scrolling region (page, sidebar, overlays, code blocks, tables, editor panes) under `body.body--ledger` and `body.body--cobalt`, each with its `.body--dark` variant. No layout or colour changes elsewhere.

Read: this README → `scrollbars.md` (the CSS, ready to paste) → `Cardinal Wiki - Scrollbars 3x.dc.html` as the live reference. Open it in Chromium with scrollbars set to "always show"; every pane scrolls, hover and drag show the state colours. `support.js` and `_ds/` beside it are what it loads. It is a design reference built in HTML, not code to ship.

## Contents

```
handoff-8/
  README.md                                this file
  scrollbars.md                            the spec + CSS
  Cardinal Wiki - Scrollbars 3x.dc.html    1a Ledger light · 1b Ledger dark · 1c Cobalt light · 1d Cobalt dark
  support.js, _ds/                         runtime the board loads; ignore
```

## In one paragraph

No arrow buttons in either theme. Ledger draws the scrollbar as a ruled margin: 12px gutter, filled track with a 1px hairline on its inner edge, a square thumb filling the gutter edge to edge — slate #8a99b8 on #f0f2f7 in light, #3a4256 on #14171f in dark and on ink surfaces (code blocks) — one tone stronger on hover, cardinal (#e4676b / #f08287) only while dragging. Cobalt is an overlay pill: 14px gutter, no track fill, no rule, an 8px pill thumb that grows to 10px and deepens on hover and drag — cobalt tint on light ground, white tint on dark ground (sidebar, code blocks, dark mode). Colours come from the existing palettes; nothing new was introduced.

## Start here

One engine gotcha, spelled out in `scrollbars.md`: Chromium ignores every `::-webkit-scrollbar*` rule on an element where `scrollbar-width` or `scrollbar-color` is non-auto. The standard properties are wrapped in `@supports not selector(::-webkit-scrollbar)` so only Firefox/Safari see them. Keep that wrapper when porting.

## Fidelity

High. Match gutter widths, thumb colours and the three states exactly; the board's panes are the pixel reference. Firefox and Safari get the thin bar in the same colours through `scrollbar-color` and no hover growth or drag colour — accepted degradation.
