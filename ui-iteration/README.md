# Cardinal wiki — handoff 5: theme corrections, new surfaces, and the blocks

**Repo:** `dylan-hart/wiki`, branch `scarlett` (Wiki.js 3.x fork: Vue 3 + Vite + Tailwind, in-repo `W*` component library, Lit web components under `blocks/`).

This is the fifth handoff and supersedes the visual rules in handoffs 3 and 4 wherever they disagree. Read in this order: this README → `CLAUDE.md` (the locked decisions, short form) → `tabset-block.md` and `blocks.md` (the block specs) → the `.dc.html` files as the pixel reference. `github.md` maps every screen to the source files it was built from.

## About the design files

Every `.dc.html` is a **design reference built in HTML** — open it in a browser (Chromium; `support.js` and `_ds/` beside the folders are what it loads). They are not code to ship. The job is to recreate them in the existing Vue 3 + Tailwind frontend using the `W*` library and the `body--ledger` / `body--cobalt` × `body--light` / `body--dark` token layer from handoff 3, and, for the blocks, in each Lit component's `static get styles()`.

Fidelity is **high**: match colours, sizes, radii and spacing exactly. Every `<svg>` in the screens carries `data-icon="tabler:<name>"` and its body is pasted verbatim from `frontend/src/assets/icons.generated.js` (a copy is in this folder), so an icon in a mock is exactly the icon to render.

## Contents

```
handoff-5/
  README.md               this file
  CLAUDE.md               locked design decisions (project notes, short form)
  github.md               screen → source-file map, sync receipts
  tabset-block.md         block-tabs spec + custom-property table
  blocks.md               the other blocks: ground rules + per-block spec
  icons.generated.js      the repo's Tabler bundle, for reference
  ledger/                 25 Ledger screens (light + dark page view, primitives)
  cobalt/                 24 Cobalt screens (light + dark page view, primitives)
  blocks/                 9 block boards (Tabset, Infobox, Spoiler, Checklist, Index,
                          Countdown, Live Data, Gallery, Figures) — each 1a Ledger / 1b Cobalt
  support.js, _ds/        runtime the .dc.html files load; ignore
```

---

## Part 1 — Global corrections (apply everywhere)

### 1.1 Cobalt is matte: no shadows, no hairline rules, hairline *borders* on low-contrast plates

Locked from the "matte" take. Changes against the current `body--cobalt` token set:

- **Remove every drop shadow.** Card shadows (`0 2px 10px rgba(16,25,74,.08)` and friends), the red glow under Edit / Add / primary buttons (`0 4px 14px rgba(200,48,60,.35)`), the glow under the page banner, menu/popover shadows, overlay shadows. Keep only `inset` bars (`inset 3px 0 0 #ff4d5a`) and 0-blur rings (`0 0 0 2px …`) — those are outlines.
- **Remove every hairline *rule*.** No `border-top/bottom/left/right: 1px` between rows, panels, toolbars, sidebar bands, table rows; no 1px separator `<span>`s (the top-bar divider before the avatar, the tags/revision divider, the sidebar strip separators). Separation inside a card comes from fill (`#e6edff`, `#f2f5ff`) and gap.
- **Add a hairline *border*** — `1px solid #dfe5f5` (dark: `rgba(255,255,255,.1)`) — to top-level plates that sit low-contrast on the `#f2f5ff` ground: page content card, contents (TOC) card, tags/revision card, actions rail, admin cards, editor panes, search result cards. Dark-ground elements (sidebar, top bar, overlays on the scrim) get none.
- Banner is **flat `#1f4fd6`** (no gradient).
- Radii: cards/fields 8px, buttons/toasts/banners/callouts 6px, chips/tags/toggle pill, badges/checkboxes/code marks 3–4px. Nothing square-cornered in Cobalt.
- Toggle knob is a **circle** (was square in some screens).
- Table editor: the grid is one 8px plate (`border-collapse: separate; border-spacing: 2px` on an `#e6edff` ground) — cells are flat squares, header cells `#eef2ff`, the active cell a 2px `#1f4fd6` inset ring. Cells are never individually rounded or shadowed.
- Adjacent buttons in a group (Cancel / Update, Save changes / Save and close, Side by side / Inline, A / B compare chips) take a **gap** (8–10px) and each keeps its own radius — never a rounded button butted against a square one.
- Editor formatting toolbar (B / I / S …) is a full-width square band, not a rounded pill.

### 1.2 Cobalt dialog corner fringe

A dark header clipped by a filled panel's `overflow:hidden` radius leaves a light antialias fringe at the two top corners; worse when the panel is also `overflow:auto` (Chromium clips a scroll container to the padding box). Confirmed in the deployed app.

Fix, applied to all 12 Cobalt dialogs in `cobalt/`:
- Panel: `background: transparent`, no `overflow:auto`.
- Header: `border-radius: 12px 12px 0 0` (side dialog `12px 0 0 0`).
- Body wrapper: carries the surface fill, `border-radius: 0 0 12px 12px` (side dialog `0 0 0 12px`) and the `overflow:auto`.

In the repo: `.body--cobalt .main-overlay .w-dialog-panel { background: transparent }`, then round the header slot on top and the body slot on the bottom with the surface fill and the scroll. Same for `SideDialog`.

### 1.3 Ledger

Unchanged from handoffs 1–4 except:
- The sidebar actions strip (1.4 below).
- Separators in the strip are `border-right` on the cells, not freestanding 1px spans (a 1px span at fractional zoom smears to two device pixels).

### 1.4 Sidebar actions strip + Back to top (`MainLayout.vue` `.sidebar-actions`, `WPageScroller`)

Board: `ledger/Cardinal Wiki - Back To Top 3x - Ledger.dc.html` (turn 2 is locked; turn 1 is rejected history). Applied to Page View, Page View Dark, Graph, Tags in both themes.

- The strip becomes **locale | browse | top**. Row is a true **40px interior** (`height: 41px` border-box with the Ledger 1px bottom hairline, or 40px content-box); the current 38px/37px is gone.
- **Locale** is a fixed **72px** cell (Cobalt: 68px tile). **Browse** takes the remainder (`flex:1`). The trailing **40×40 cell is always reserved**, so EN and Browse never shift when Top appears.
- **Top** and (Ledger) its leading separator fade in together (opacity, 150ms) once `.page-container-scrl` has scrolled past 150px; it scrolls that column to top. At page top the cell is empty and its separator hidden.
- Ledger: white plate, Tabler `arrow-up` 15px + `TOP` in Roboto Mono 600 7.5px `.18em`, both `#c14a52`; hover `#fdeced`. Cells separated by `border-right: 1px solid #dbe1ec` on EN and Browse. Dark: plate `#242b3a`, glyph `#f08287`, hover `rgba(240,130,135,.14)`, rules `#2a3040`.
- Cobalt: **no rules at all**. EN and Browse are flat tiles (`margin: 4px 0 4px 4px; border-radius: 6px`), hover `rgba(255,255,255,.08)`; Top is a 32×32 6px tile inside its 40px cell, glyph `#ff8f97`, hover `rgba(255,77,90,.18)`. Label colour `#c5cff5`, icon `#7f8ed1`.
- `WPageScroller`'s corner disc goes away in wide mode (≥1200px). Below 1200px, where the sidebar overlays, the existing corner button stays. Below 750px the TOC-panel opener keeps the corner, as today.
- Icons: locale `language`, browse `sitemap`, edit nav `list-tree`.

### 1.5 Icons

Every glyph in every screen is now the exact body from `icons.generated.js` (Tabler, stroke 1.5, square caps, mitre joins). Corrections found against the code and applied:
- Page actions rail primary is **`tag`** (page properties), not a pencil; then `photo-cog` (editing only), `history`, `file-export`, `dots`.
- Header actions: `plus`, `folder`, `hierarchy` (graph), **`inbox`** (notifications; was a bell), `tool`. Search field trailing button `tags`.
- Page banner actions are **watch (`bell` / `bell-filled`), `printer`, Edit** — the inbox-with-badge that sat beside Edit is removed (it does not exist in `PageHeader.vue`).
- Sidebar nav defaults `folder` / `file-text`; profile/avatar `user-circle`; drag handle `grip-horizontal`; admin nav as `AdminLayout.vue` (Editors `writing`, Theme `layout-navbar`, Cluster `binary-tree`, …).
- Not in the bundle (regenerate with `npm run icons`): `topology-star` (block-kroki's definition icon).

### 1.6 File organisation

Screens are filed by theme: `ledger/…- Ledger.dc.html`, `cobalt/…- Cobalt.dc.html`. Cross-theme boards (Theme Takes, Aesthetic Setting, Alternate Themes) and the block boards sit at the root of the design project; the block boards are in `blocks/` here.

---

## Part 2 — Screens in this handoff

All 49 themed screens are included because the global corrections in Part 1 touched every one of them. The ones with **new or changed design** since handoff 4:

| Screen | Change |
| --- | --- |
| Page View (Ledger/Cobalt, light/dark) | sidebar strip with Top (1.4); banner actions = watch · print · Edit; icon pass; Cobalt matte |
| Graph, Tags (both) | sidebar strip at page top (Top slot reserved, empty) |
| Editor (both) | banner actions; Cobalt: square format toolbar, 10px gap Save / Save and close |
| Table Editor (Cobalt) | single-plate grid (1.1); Cancel / Update gap |
| History (Cobalt) | Side by side / Inline gap + Inline rounded; A/B chips rounded with 4px gap |
| Block Picker (Cobalt) | Cancel / Insert 8px gap; circular toggle knob; selected block card 8px radius |
| Inbox, Inbox Review, Profile, File Manager, History, Table Editor, Edit Menu Items, Block Picker, Page Properties, Menus, Primitives (Cobalt) | dialog corner fix (1.2) |
| Every Cobalt screen | shadows removed, rules removed, `#dfe5f5` borders on plates (1.1) |
| Every screen | Tabler bodies from the bundle (1.5) |

Behavioural notes carried forward (unchanged): rail more-menu holds duplicate / rename-move / delete; inbox and profile overlays at 50% viewport; Edit navigation is a popover, not a dialog (handoff 4).

---

## Part 3 — Blocks (`blocks/*.dc.html`, `tabset-block.md`, `blocks.md`)

The Lit blocks under `blocks/` each draw their own card inside a shadow root, so nothing from the page theme reaches them — 6px radii, drop shadows, gradient strips, Quasar `--q-primary` blue and Material path glyphs. Each board shows the block in the article column, light and dark, in both aesthetics, with a spec paragraph.

Rules for all of them (details in `blocks.md`):
- Behaviour, DOM, ARIA, keyboard handling, `static definition`, light-DOM slotting: **unchanged**. Only `static get styles()` and the custom-property block change.
- Theme reaches the block through custom properties inherited from `body` (`body.body--cobalt`, `body.body--dark`); declare them in `tailwind.css` next to the other tokens and let them inherit, with Ledger-light defaults on `:host` as the fallback.
- Strip: `box-shadow` on cards, `linear-gradient` grounds, 5/6px radii, `var(--q-*)` fallbacks, inline Material SVGs (→ Tabler).
- Ledger blocks: square 1px `#dbe1ec` plates with two 7px `#64789f` corner marks (top-left, bottom-right), mono eyebrows for small labels, Barlow Condensed numerals/headings, accent only on the live edge.
- Cobalt blocks: 1px `#dfe5f5` 8px cards, 6px inner tiles, no rules, tint fills for separation, `#1f4fd6` titles/numerals, red only for status.

Per block: **Tabset** (`tabset-block.md`, full `--tabs-*` table), **Infobox**, **Spoiler**, **Checklist**, **Index**, **Countdown**, **Live Data**, **Gallery**, and **Figures** — the three shared fragments (`captionStyles`, `errorBox`, embed frame) that cover kroki / plantuml / diagram / drawio / katex / mathjax / qr-code and youtube / vimeo / dailymotion / m365-video / media-player / asciinema / pdf / map / openapi.

---

## Part 4 — Tokens (complete, both aesthetics, both modes)

**Ledger light:** paper `#f5f6f9`, card `#fff`, tint `#f0f2f7` / `#eef1f7`, hairline `#dbe1ec`, faint rule `#eef1f7`, ink `#1c2233`, body `#2f3a4f`, secondary `#4e5d7d` / `#38465f`, caption `#57668a`, icon stroke `#64789f` / `#8a99b8`, disabled `#a9b7d0`, accent fill `#e4676b`, accent text `#c14a52`, link `#a83f45`, accent tint `#fdeced`, slate button `#38465f`, positive fill `#5f9c86` / text `#3f7a66`, warning fill `#d9a441` / text `#8a5a12`, code block `#1c2233`.

**Ledger dark:** ink `#14171f`, panel `#1b1f2a`, raised `#242b3a`, hairline `#2a3040`, text `#e6eaf2` / `#9aa6bd` / `#8792ab`, slate-light `#8ea6cf`, accent `#f08287` (dark ink on fills), accent tint `rgba(240,130,135,.16)`, positive text `#7fbfa5`, warning text `#e0b25a`.

**Cobalt light:** ground `#f2f5ff`, card `#fff`, tint `#e6edff`, alt row `#f2f5ff`, border `#dfe5f5`, ink `#10194a`, body `#1a2038`, secondary `#4a5580` / `#1e2a5e`, caption `#5a6699`, icon `#5a6699` / `#7f8ed1`, disabled `#c5cff5`, cobalt `#1f4fd6`, cobalt on tint `#1a3fb0`, accent fill `#ff4d5a`, accent with white text / accent text `#c8303c`, accent tint `#ffe9eb`, slate button `#1e2a5e`, positive fill `#22a37f` / text `#16795d`, warning fill `#f2c037` / text `#8a6416`, top bar `#1f4fd6`, sidebar `#10194a`, sidebar raised `#141c4f`, overlay header `#1c2a70`, code block `#10194a`, on-dark text `#d7deff` / `#c5cff5` / `#a7b3ea`.

**Cobalt dark:** ground `#0a0f2c`, sidebar `#0e1540`, card `#141c4f`, border `rgba(255,255,255,.1)`, code/footer `#070b22`, top bar `#1a43bd`, text `#e8ecff` / `#a7b3ea` / `#8b98d6`, cobalt `#8fb0ff` (fills `#3d6df7`), body links `#7fa0ff`, accent text `#ff8f97` on `rgba(255,77,90,.16)`, footer link `#ff7a84`, positive text `#7be79a`, warning text `#f6da8a`.

**Type:** Barlow (body), Barlow Condensed (headings, numerals, overlay titles), Roboto Mono (eyebrows, paths, metadata, counts). **Icons:** Tabler via `icons.generated.js`.

---

## Suggested order

1. Token layer: add the missing Cobalt properties (borders, no-shadow, no-rule) and the `--tabs-*` / block properties to `tailwind.css`; strip shadows and rules from `body--cobalt` rules in SFCs.
2. `MainLayout.vue`: `.sidebar-actions` → 40px, three cells, Top; retire `WPageScroller` in wide mode.
3. Dialog corner fix in `MainOverlayDialog` / `SideDialog` for Cobalt.
4. Icon corrections in `HeaderNav`, `PageHeader`, `PageActionsCol`.
5. Per-screen Cobalt polish listed in Part 2.
6. Blocks: `block-tabs` first (it is the template), then the seven boards, then the shared fragments.
