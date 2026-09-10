# block-infobox — Cobalt (light + dark)

Board: `Cardinal Wiki - Block Infobox 3x.dc.html`, option 1b. Ledger side and the shared ground rules are in `blocks.md`.

## Scope

Only `static get styles()` and the `:host` custom-property block of `block-infobox` change. DOM (`aside > .name, figure, dl`), YAML parsing, `.group` / `.is-group-end` classes, ARIA and the masked external-link mark stay as they are. Cobalt is reached through `:host-context(.body--cobalt)` and `:host-context(.body--cobalt[dark])` (or inherited properties set on `body` in `tailwind.css`).

## Remove

- `box-shadow` on the card.
- `linear-gradient` on `.group` (`--infobox-head-top` goes).
- The 3px `.is-group-end` rule and every 1px row rule. Cobalt has no rules inside a card; separation is fill and gap.
- `var(--q-primary)`, `var(--q-positive)`, `var(--q-negative)`; Material tick/cross paths → Tabler `check` / `x` from `icons.generated.js`.

## Light

| Part | Value |
| --- | --- |
| Card | `#fff`, `1px solid #c9d6fb` (blue hairline — deliberately bluer than the `#dfe5f5` page-card border), `border-radius: 8px`, `overflow: hidden`, float right, 320px, margin `4px 0 14px 22px` |
| `.name` | band `#1f4fd6`, 9px 12px, Barlow Condensed 600 15px, letter-spacing .04em, `#fff`, centred |
| Image well | `#e6edff`, 6px radius, inside 12px padding; placeholder glyph Tabler `photo` 26px `#5a6699` |
| `figcaption` | Barlow 400 11.5px `#5a6699`, centred, 6px 0 4px |
| `dl` | `grid-template-columns: minmax(6em, auto) 1fr`; cells 7px 12px; `overflow-wrap: anywhere` |
| `dt` | Barlow 500 12.5px/1.45 `#4a5580` |
| `dd` | Barlow 400 12.5px/1.45 `#1a2038` |
| Row banding | every second row `#f2f5ff` (`dl > :nth-child(4n+3), dl > :nth-child(4n+4)`); banding restarts after a `.group` heading |
| `.group` | spans both columns, `#e6edff`, 6px 12px, Barlow 600 12px `#1f4fd6` |
| `.is-group-end` | no rule; the next group's tint is the break |
| Yes / No | Tabler `check` `#16795d`, `x` `#c8303c`, 15px, stroke 1.5 |
| Links | `#1f4fd6` 500, no underline, existing 12px external mark in the same colour |

## Dark (`.body--cobalt[dark]`)

| Part | Value |
| --- | --- |
| Card | `#141c4f`, `1px solid rgba(143,176,255,.28)` (blue-tinted; not the grey `rgba(255,255,255,.1)`) |
| `.name` | band `#3d6df7`, white |
| Image well | `#0e1540`; glyph and caption `#8b98d6` |
| `dt` / `dd` | `#a7b3ea` / `#e8ecff` |
| Row banding | `rgba(255,255,255,.04)` |
| `.group` | `#0e1540`, text `#8fb0ff` |
| Yes / No | `check` `#7be79a`, `x` `#ff8f97` |
| Links | `#7fa0ff` |

## Custom properties (suggested)

```css
body.body--cobalt {
  --infobox-border: #c9d6fb;
  --infobox-radius: 8px;
  --infobox-bg: #fff;
  --infobox-name-bg: #1f4fd6;
  --infobox-name-fg: #fff;
  --infobox-well: #e6edff;
  --infobox-caption: #5a6699;
  --infobox-dt: #4a5580;
  --infobox-dd: #1a2038;
  --infobox-band: #f2f5ff;
  --infobox-group-bg: #e6edff;
  --infobox-group-fg: #1f4fd6;
  --infobox-yes: #16795d;
  --infobox-no: #c8303c;
  --infobox-link: #1f4fd6;
  --infobox-rule: transparent;
  --infobox-group-end: 0;
}
body.body--cobalt[dark] {
  --infobox-border: rgba(143,176,255,.28);
  --infobox-bg: #141c4f;
  --infobox-name-bg: #3d6df7;
  --infobox-well: #0e1540;
  --infobox-caption: #8b98d6;
  --infobox-dt: #a7b3ea;
  --infobox-dd: #e8ecff;
  --infobox-band: rgba(255,255,255,.04);
  --infobox-group-bg: #0e1540;
  --infobox-group-fg: #8fb0ff;
  --infobox-yes: #7be79a;
  --infobox-no: #ff8f97;
  --infobox-link: #7fa0ff;
}
```
