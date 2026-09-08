# Blocks — Ledger and Cobalt restyle

Boards: `Cardinal Wiki - Block <Name> 3x.dc.html` (1a Ledger, 1b Cobalt; light + dark in each; spec paragraph under each column). Tabset has its own note in `tabset-block.md`.

## Ground rules (every block)

- Behaviour, DOM, ARIA, keyboard handling, `static definition`, light-DOM slotting: unchanged. Only `static get styles()` and the `:host` custom-property block change.
- Blocks live in a shadow root, so the theme reaches them through custom properties inherited from `body` (`body.body--cobalt`, `body.body--dark`). Declare Ledger-light defaults on `:host`, the other three sets on `:host([dark])`, `:host-context(.body--cobalt)` and `:host-context(.body--cobalt[dark])` (or set the properties on `body` in `tailwind.css` and let them inherit — preferred, since the page already owns the aesthetic switch).
- Remove everywhere: `box-shadow` on cards, `linear-gradient` backgrounds, `border-radius: 5px/6px`, `var(--q-primary, #1976d2)`, `var(--q-positive/negative …)`, Material path SVGs (tick, cross, eye-off, arrow, chevrons) → Tabler via `fetchIcon` / inline bodies from `icons.generated.js`.
- Ledger: 1px `#dbe1ec` hairline, square, two 7px `#64789f` corner marks at top-left and bottom-right (an `aria-hidden` element with four background gradients, as `.page-header-icon__marks` draws them; `display: var(--corner-marks)`). Small labels are Roboto Mono 600 9.5–10.5px, .16–.18em, uppercase, `#57668a`. Numerals and headings Barlow Condensed. Accent `#e4676b` fills / `#c14a52` text only on the live edge.
- Cobalt: 1px `#dfe5f5`, 8px card radius, 6px inner tiles, no rules; separation by tint (`#e6edff`, `#f2f5ff`) and gap. Titles and numerals `#1f4fd6`; red (`#ff4d5a` fill, `#c8303c` text) only for status and errors.
- Dark palettes: Ledger `#14171f / #1b1f2a / #242b3a`, rules `#2a3040`, text `#e6eaf2 / #9aa6bd / #8792ab`, accent `#f08287` (dark ink on fills). Cobalt `#0a0f2c / #141c4f`, border `rgba(255,255,255,.1)`, tint `#0e1540`, text `#e8ecff / #a7b3ea / #8b98d6`, cobalt `#8fb0ff` (fills `#3d6df7`), red text `#ff8f97` on `rgba(255,77,90,.16)`.

## Shared fragments (`blocks/shared/styles.js`, `figure.js`) — board: Block Figures

- `captionStyles`: Barlow 12.5px, `#4e5d7d` (Cobalt `#4a5580`; dark `#9aa6bd` / `#a7b3ea`), 8px above.
- `errorBox`: Ledger — `1px dashed #e4676b`, square, `#e4676b` corner marks, on the card colour; a Roboto Mono eyebrow "Block error" in `#c14a52` above the message (Barlow 13.5px body colour, `pre-wrap`). Cobalt — `1px dashed #ff4d5a`, 6px radius, on `#ffe9eb`; first line Barlow 600 12.5px `#c8303c`, hint 12.5px body. Dark as per palettes. `errorBoxInline` (block-include) follows automatically.
- Embed frame (youtube, vimeo, dailymotion, m365-video, media-player, asciinema, pdf, map, openapi): Ledger `1px #dbe1ec` square with corner marks; Cobalt `1px #dfe5f5`, 8px radius, `overflow:hidden`. Play affordance: Ledger 56px square `1px rgba(255,255,255,.5)`; Cobalt 56px round on `rgba(255,255,255,.14)`.
- Diagram/formula figures (kroki, plantuml, diagram, drawio, katex, mathjax, qr-code) carry no frame; when a block draws an image well it is the tint (`#f0f2f7` / `#e6edff`) with the hairline.

## block-infobox

Ledger: card hairline + marks. `.name` on `#f0f2f7` with a 1px rule under, Barlow Condensed 600 16px `#1c2233` centred. `dt`/`dd` 7px 12px with 1px `#dbe1ec` top rules; dt Barlow 500 12.5px `#4e5d7d`, dd 400 `#2f3a4f`. `.group` spans both columns: `#f0f2f7`, Roboto Mono 600 9.5px .18em uppercase `#57668a`, no gradient (`--infobox-head-top` goes). `.is-group-end` bottom rule 2px `#dbe1ec` (was 3px). Yes/No: Tabler `check` `#3f7a66`, `x` `#c14a52`, 15px. Links `#a83f45` 500 + the existing masked external mark. Image well `#f0f2f7`, `figcaption` 11.5px `#57668a`.
Cobalt: card `1px #dfe5f5` 8px, `overflow:hidden`. `.name` band `#1f4fd6` (dark `#3d6df7`), Barlow Condensed 600 15px white. No rules: rows alternate `#fff` / `#f2f5ff` (`dl > :nth-child(4n+3), :nth-child(4n+4)`), `.group` on `#e6edff` Barlow 600 12px `#1f4fd6`, no group-end rule. Check `#16795d`, x `#c8303c`, links `#1f4fd6`. Image well `#e6edff` 6px.

## block-spoiler

Box: hairline, `min-height:76px`, 16px 20px; Ledger square + marks, `#f0f2f7` covered / `#fff` revealed; Cobalt 8px, `#e6edff` covered / `#fff` revealed. Cover: Tabler `eye-off` 26px (Ledger `#64789f`, Cobalt `#1f4fd6`); label Barlow 500 14px (Cobalt 600) body colour; hint Ledger Roboto Mono eyebrow, Cobalt Barlow 12px `#4a5580`. Hover Ledger `#fdeced`, Cobalt `rgba(31,79,214,.08)` on a 6px inner radius. Focus-visible: 2px inset ring in the accent (Ledger `#e4676b`, Cobalt `#1f4fd6`).

## block-checklist

Card hairline (Ledger square + marks, Cobalt 8px), 16px 18px. Heading Barlow Condensed 600 19px. Summary: Ledger Roboto Mono 500 10.5px `#57668a` (completed `#3f7a66`); Cobalt Barlow 12.5px `#4a5580` (completed `#16795d` 500). Checkbox: custom 16px box (drop `accent-color`): Ledger square `1px #64789f`, checked fills `#e4676b` with a 12px white Tabler `check`; Cobalt 4px radius `1px #5a6699`, checked `#1f4fd6`. Checked label secondary colour, line-through; meta Ledger Roboto Mono 10.5px `#57668a`, Cobalt Barlow 12px `#5a6699`. History toggle: Ledger Roboto Mono 600 10px .16em uppercase `#c14a52`; Cobalt Barlow 500 12.5px `#1f4fd6`. History list 12px secondary; Ledger over a 1px rule, Cobalt on an `#e6edff` 6px band with no rule.

## block-index

`li`: `1px` hairline on the card colour, no gradient, no shadow, no 5px left border. Ledger square; Cobalt 6px. `a` 10px 14px, gap 12. Icon 18px (Ledger `#64789f`, Cobalt `#1f4fd6`). Title Barlow 500 14.5px `#1c2233` (Cobalt 600 `#1f4fd6`); description 12.5px secondary. Trailing glyph: Tabler `arrow-right` 16px `#64789f` (Ledger) / `chevron-right` `#5a6699` (Cobalt) — replaces the 48px Material arrow. Hover: Ledger `#fdeced` + `box-shadow: inset 2px 0 0 #e4676b`, arrow `#c14a52`; Cobalt `#e6edff` fill + border `#1f4fd6`. `--depth` indent 24px per level. Empty state uses `errorBox`.

## block-countdown

Card hairline, 18px 20px, centred; Ledger marks. Label Barlow Condensed 600 19px. Segments: Ledger no fill, `border-left: 1px #dbe1ec` between, value Barlow Condensed 700 40px `#1c2233` tabular, unit Roboto Mono eyebrow; Cobalt tiles `#e6edff` 6px 8px 12px, gap 8, value `#1f4fd6`, unit Barlow 600 10px .12em uppercase `#4a5580`. Target line Ledger Roboto Mono 10.5px `#57668a`, Cobalt Barlow 12px `#5a6699`. Ended message Barlow 500 14px positive (`#3f7a66` / `#16795d`).

## block-live-data

Card hairline, 14px 18px; Ledger marks. Label: Ledger Roboto Mono eyebrow, Cobalt Barlow 500 12px `#4a5580`. Value Barlow Condensed 700 36px tabular (Ledger `#1c2233`, Cobalt `#1f4fd6`), unit Barlow 14px secondary; fetched-at Ledger Roboto Mono 10.5px, Cobalt Barlow 11.5px, faint. Sparkline: Ledger stroke `#e4676b` 1.5px butt/miter; Cobalt `#1f4fd6` 2px round/round. Status: Ledger square chip 5px 11px Barlow 500 13px with an 8px square dot; Cobalt 999 pill Barlow 600 with a 9px round dot. Colours — ok `rgba(95,156,134,.16)` / text `#3f7a66` (Cobalt `#16795d`) / dot `#5f9c86` (`#22a37f`); warning `rgba(217,164,65,.18)` / `#8a5a12` / `#d9a441` (Cobalt `rgba(242,192,55,.22)` / `#8a6416` / `#f2c037`); critical accent tint / accent text / accent fill; unknown tint / secondary / icon colour. Dark text: ok `#7fbfa5` / `#7be79a`, warning `#e0b25a` / `#f6da8a`, critical `#f08287` / `#ff8f97`.

## block-gallery

Tiles: hairline on the tint well, gap 8; Ledger square, Cobalt 6px. Hover/focus: Ledger `inset 0 0 0 2px #e4676b` + `#e4676b` corner marks, no transform; Cobalt border `#1f4fd6` and the existing 1.03 zoom (kept off under reduced motion). Lightbox: backdrop unchanged. Chrome: Ledger 40px square, `1px rgba(255,255,255,.35)`, hover `rgba(255,255,255,.12)`, Tabler `chevron-left` / `chevron-right` / `x` 20px; Cobalt 44px round on `rgba(255,255,255,.12)` hover `.25`, 22px glyphs. Counter: Ledger Roboto Mono 500 11px .12em `rgba(255,255,255,.85)` bare; Cobalt Barlow 12px on `rgba(0,0,0,.5)` 12px pill.
