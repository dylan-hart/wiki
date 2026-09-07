# Cardinal wiki — handoff 4: navigation editing

Two surfaces, each in both aesthetics: the **Edit navigation** popover (`NavEditMenu.vue`) and the
**Edit menu items** overlay (`NavEditOverlay.vue` hosting `NavItemEditor.vue`). Behaviour, data model
and API calls are unchanged from `scarlett`; this pass restyles them into Ledger and Cobalt and
tightens the popover's layout. Nothing here adds a feature.

The `.dc.html` files are **design references built in HTML**, not code to ship. Recreate them in the
Vue 3 + Tailwind frontend with the `W*` component library and the token layer from handoff 3
(`body--ledger` / `body--cobalt` custom properties). Open any file in a browser; `support.js` and
`_ds/` beside it are what it loads. Fidelity is **high**: match colours, sizes and spacing exactly.

## Files

| File | What it is |
| --- | --- |
| `Cardinal Wiki - Edit Navigation 3x - Ledger.dc.html` | Options board. **1a is locked** (badged). 1b and 1c are rejected takes kept for record; ignore them. |
| `Cardinal Wiki - Edit Navigation 3x - Cobalt.dc.html` | 1a in Cobalt, standalone. |
| `Cardinal Wiki - Edit Menu Items 3x - Ledger.dc.html` | The overlay, Ledger. |
| `Cardinal Wiki - Edit Menu Items 3x - Cobalt.dc.html` | The overlay, Cobalt. |

Every file has Tweaks (top-right of the preview) that switch states: `isRoot` on the popover;
`menuSource` (manual / mixed / auto), `isInherited`, `selectedIsParent` on the overlay. Check each
state, not just the default render.

Source of truth for behaviour: `frontend/src/components/NavEditMenu.vue`, `NavEditOverlay.vue`,
`NavItemEditor.vue`, `NavSidebar.vue`; strings from `backend/locales/en.json` under `navEdit.*`.

---

## 1. Edit navigation popover (`NavEditMenu.vue`)

### Anchor and shape

- Opens from the sidebar's **Edit navigation** footer row (`MainLayout` action bar, 38px Ledger /
  40px Cobalt). It is a `w-menu` popup anchored to that row, rising upward: bottom edge 8px above the
  footer, left edge 8px in from the sidebar's left edge. **Not a dialog** — the page stays visible
  and the footer that opened it stays marked.
- Width **344px** (was `min-width: 350px`). Height is content; `updatePositionHandler` still runs on
  mode change and after `loadInheritedNav`, as today.
- While open, the footer row takes the "live" mark: Ledger — white ground, `inset 0 2px 0 #e4676b`
  top edge, label `#1c2233` 500, icon stroke `#c14a52`. Cobalt — ground `#141c4f`, `inset 0 3px 0
  #ff4d5a`, label white 600, icon stroke `#ff8f97`.

| | Ledger | Cobalt |
| --- | --- | --- |
| Card | `#fff`, `1px solid #dbe1ec`, `0 10px 28px rgba(28,34,51,.16)`, square, two corner marks (7px `+`, `#8a99b8`) at top-left and bottom-right only | `#fff`, radius 8px, `0 10px 28px rgba(16,25,74,.18)`, `overflow:hidden`, no marks |
| Header | 11px 14px 9px; eyebrow `Edit navigation` Roboto Mono 600 10px `.2em` caps `#c14a52`; page path right-aligned Roboto Mono 10.5px `#57668a`; rule below `#eef1f7` | same; eyebrow `#c8303c`, path `#5a6699`, rule `#eef1fb` |
| Section labels | Roboto Mono 600 10px `.2em` caps `#57668a`, padding 2px 14px 6px | `#5a6699` |
| Hairline between sections | 1px `#eef1f7`, margin 4px 14px | `#eef1fb` |
| Footer | `#f8f9fc`, top rule `#dbe1ec`, 10px 14px, buttons right-aligned gap 8 | `#f6f8ff`, rule `#eef1fb` |

### Section: "Sidebar for this page" (cascade mode)

One row per mode. `isRoot` (path `''` or `home`) shows Show / Hide; otherwise the five below.
Copy is deliberately shorter than the current `navEdit.mode*` strings — update `en.json`:

| value | Label | Hint |
| --- | --- | --- |
| `inherit` | Inherit | Use the menu and settings from the parent path. |
| `override` | Override, this page and below | Set menu items and settings for this path and all descendants. |
| `overrideExact` | Override, this page only | Set menu items and settings only for this path. |
| `hide` | Hide, this page and below | No sidebar for this path and all descendants. |
| `hideExact` | Hide, this page only | No sidebar only for this path. |
| root `inherit` | Show | Show the sidebar menu across the site. |
| root `hide` | Hide | Completely hide the sidebar menu. |

Row anatomy (`display:flex; align-items:center; gap:10px; padding:5px 14px`):

1. **Radio** — Ledger 13px square, `1px solid #a9b7d0`; selected `1px solid #e4676b` with a 7px
   `#e4676b` square inside. Cobalt 14px circle `1px solid #c5cff5`; selected `#c8303c` ring with an
   8px `#c8303c` dot. Native `w-radio` restyled via tokens, not a new component.
2. **Cascade glyph plate** — Ledger 28px square, `1px solid #dbe1ec`, white. Cobalt 30px, radius 8px,
   white, `0 2px 10px rgba(16,25,74,.08)`. Inside: an 18px SVG of three stacked bars (viewBox 20×20,
   bars at y 1.5 / 8.25 / 15, x 1.5 / 5.5 / 9.5, widths 17 / 13 / 9, height 3.5, stroke-width 1.2;
   Cobalt adds `rx="1"`) reading top-to-bottom as **parent / this page / descendants**:
   - affected rows **filled** accent (`#e4676b` Ledger, `#ff4d5a` Cobalt);
   - inherit: parent bar filled slate (`#64789f` Ledger, `#1f4fd6` Cobalt), others outlined;
   - hidden rows **dashed** outline (`stroke-dasharray="1.6 1.4"`), stroke `#8a99b8` / `#7f8ed1`;
   - untouched rows plain outline, same stroke.
   Ship this as one small SVG component with a `mode` prop; it is reused by the overlay header icon
   in spirit (same bar language) but is not the same glyph.
3. **Text** — label Barlow 13px, `#2f3a4f` / `#1a2038`; hint Barlow 11.5px/1.35 `#57668a` / `#5a6699`.

Selected row: Ledger ground `#f0f2f7`, `inset 2px 0 0 #e4676b`, label 500 `#1c2233`. Cobalt ground
`#e6edff`, `inset 3px 0 0 #ff4d5a`, label 600 `#10194a`, hint `#4a5580`. Hover: Ledger `#f5f6f9`,
Cobalt `#f2f5ff`. Focus-visible: 2px accent ring, offset 2px, on the row.

### Section: "Menu source" (`state.menuMode`)

A **segmented control** (`w-btn-toggle`), three equal segments filling 316px, 30px tall, replacing the
three radio rows. Manual / Automatic / Mixed. Selected: Ledger `#e4676b` fill, white 500 12px;
Cobalt `#c8303c` fill, `0 4px 14px rgba(200,48,60,.35)`, outer corners 6px. Unselected: `1px solid
#dbe1ec` / `#dfe5f5`, no left border between segments, text `#38465f` / `#1e2a5e` 400 12px.
Below it one hint line (11.5px/1.4, `#57668a` / `#5a6699`) that changes with the selection:

- Manual — "Menu items are entered by hand."
- Automatic — "Menu items are generated automatically from the page tree below this menu."
- Mixed — "Automatically-generated items are combined with the items entered by hand."

The whole section and the button below it render only while `canEditMenuItems` is true (existing
computed); the popup re-anchors when it appears.

### "Edit menu items…" hand-off

Outlined button, full width inside the 14px padding, 32px: Ledger `1px solid #dbe1ec`, list-details
glyph `#64789f`, label 500 12.5px `#38465f`, trailing chevron `#8a99b8`. Cobalt `1px solid #dfe5f5`,
radius 6px, glyph and label `#1f4fd6`, chevron `#7f8ed1`. Calls `startEditing()` unchanged (opens
the `NavEdit` overlay with `mode`, `menuMode` and, for inherit away from root, `navId`).

### Footer actions

Cancel: outlined 32px, `1px solid #dbe1ec` / `#dfe5f5`, white, text `#4e5d7d` / `#4a5580`. Save:
**slate**, not red — `#38465f` Ledger / `#1e2a5e` Cobalt, white 500 12.5px, check glyph. Red is
reserved for the one page-level primary action; a settings commit is slate everywhere in Cardinal.
Save spins on `state.loading` as today and calls `save()` unchanged.

---

## 2. Edit menu items overlay (`NavEditOverlay.vue` + `NavItemEditor.vue`)

Full-bleed overlay through `MainOverlayDialog`, same chrome as the table editor overlay:

| | Ledger | Cobalt |
| --- | --- | --- |
| Scrim | 24px margin, `rgba(20,23,31,.72)` over the hatched backdrop | same |
| Sheet | `#f5f6f9`, `border-top: 10px solid #14171f`, square, `0 0 30px rgba(0,0,0,.4)` | `#f2f5ff`, radius 12px, `overflow:hidden`, no eyebrow bar |
| Header | `#242b3a`, 10px 14px; icon `#f08287` sidebar glyph; title Barlow Condensed 600 15px `.08em` caps white; path Roboto Mono 11px `#9aa6bd` | `#1c2a70`; icon `#ff7a84`; path `#a7b3ea` |
| Header notices | `isEditingInherited` → "Inherited menu — shared with every page using it" with an info glyph; `menuMode === 'auto'` → "Generated from the page tree — read only". Ledger: 11.5px `#e6eaf2`, `1px solid #4e5d7d`, 3px 8px. Cobalt: pill, `rgba(255,255,255,.12)`, 3px 10px | |
| Header actions | help plate (28px, `#9aa6bd`), then Cancel (white, `#38465f`) + Save (`#5f9c86` green; disabled `#a9b7d0`) as one 28px button group, square | Cancel white `#1e2a5e`, Save `#22a37f` (disabled `#5a6699`), 6px radius, 6px gap |

Save stays disabled while `isBusy || menuMode === 'auto'`.

### Left column — the item list (`NavItemEditor`'s drawer)

**295px**, full height. Ledger ground `#f0f2f7` with `1px solid #dbe1ec` right edge (the sidebar's
own tint — the drawer is no longer `bg-dark-6` in Ledger). Cobalt ground `#10194a` (the sidebar
indigo), no border.

- Column header 38px / 40px: eyebrow `Menu items` Roboto Mono 600 10px `.2em` caps (`#38465f` /
  `#7f8ed1`), item count at right (Ledger: mono 10.5px `#38465f` on white with `#dbe1ec` border;
  Cobalt: `#d7deff` on `rgba(255,255,255,.1)` pill).
- Mixed hint (`isMixed`) under the header: Barlow 11.5px/1.45, `#57668a` / `#a7b3ea`, 10px 18px 0.
- List padding: Ledger 12px 0 0; Cobalt 14px 10px 0 with 2px row gap and 6px row radius (matches
  `NavSidebar` in Cobalt).

Row types (all carry a trailing **grip** handle, two horizontal lines 14px, `#8a99b8` / `#5a6699`;
omitted on generated rows):

| Row | Ledger | Cobalt |
| --- | --- | --- |
| Header | Roboto Mono 600 10px `.2em` caps `#57668a`, padding 6px 10px 6px 18px | `#7f8ed1`, 6px 10px |
| Link | Barlow 13.5px `#38465f`, icon 15px stroke `#8a99b8`, padding 7px 10px 7px 18px | `#d7deff`, icon `#7f8ed1`, 8px 10px |
| Link, selected (`is-active`) | white ground, `border-left: 2px solid #e4676b` (padding-left drops to 16), 500 `#1c2233`, icon stroke `#e4676b`, grip `#64789f` | `#1f4fd6` ground, `inset 3px 0 0 #ff4d5a`, 600 white, icon white, grip `#c9d6ff` |
| Nested run (`is-nested`) | block indented 18px, `border-left: 10px solid #dbe1ec`, ground `#e8ecf4`, elbow triangle at top-left continuing the rail; rows 13px `#38465f`, icon 14px, padding 7px 10px 7px 14px | indented 10px, rail `rgba(255,255,255,.08)`, ground `rgba(255,255,255,.04)`, radius 0 6px 6px 0; rows `#a7b3ea` |
| Separator | 1px `#c9d2e2` line filling the row, padding 9px 10px 9px 18px | `rgba(255,255,255,.18)` |
| Generated block (mixed) | `border-top: 2px dashed #a9b7d0`, margin-top 8px; eyebrow "From the page tree" `#8a99b8`; rows text `#8a99b8`, icons `#a9b7d0`, no grip, `cursor:default` | dashed `rgba(255,255,255,.22)`; eyebrow `#5a6699`; rows `#5a6699`, icons `#3a4680` |
| Orphaned nested row (existing `$negative` rule) | keep the red flag: ground `#fdeced`, rail `#e4676b` | ground `rgba(255,77,90,.16)`, rail `#ff4d5a` |

The nested rail + elbow is the same 10px construction `NavSidebar.vue` draws for an open group; use
the same two pieces so both views of the tree look like one tree.

Bottom bar (hidden when `isAuto`): top rule (`#dbe1ec` / `rgba(255,255,255,.08)`), padding 10px 14px
(Cobalt 12px 14px). **Add item** fills the row: Ledger `#e4676b` 32px, white 500 12.5px, plus glyph,
trailing chevron, two 5px corner marks; opens the existing Header / Link / Separator `w-menu`. Cobalt
`#c8303c` 34px, radius 6px, `0 4px 14px rgba(200,48,60,.35)`, 600. Beside it the **more** plate
(34px / 36px, vertical dots) opens Clear all items / Copy from… — unchanged menu.

### Right column — the detail panel

Padding 20px 24px 28px; cards max-width 760px; 16px gap between cards.

**Read-only notice** (`editingDisabled`), above the card: Ledger callout — `1px solid #dbe1ec`
white, 44px `#eef1f7` icon gutter with info glyph, text 13.5px/1.55 `#38465f`. Cobalt — `#e6edff`,
`border-left: 3px solid #1f4fd6`, radius 6px, text `#1e2a5e`. Copy: "This menu is generated
automatically from the page tree. Switch the menu source to Mixed or Manual to edit items directly."
The card below drops to `opacity:.55` and `pointer-events:none` (existing `.nav-edit-readonly`).

**Property card** — the settings-row primitive from the primitives sheet:

| | Ledger | Cobalt |
| --- | --- | --- |
| Card | `1px solid #dbe1ec`, white, four 7px corner marks `#64789f` | white, radius 8px, `0 2px 10px rgba(16,25,74,.08)`, `overflow:hidden` |
| Card header | 38px `#eef1f7`, rule `#dbe1ec`; type name (Header / Link / Separator) Roboto Mono 600 10px `.2em` caps `#38465f`; parent badge at right "Parent · 2 children" mono 9.5px caps, `1px solid #5f78a8`, `#38465f` | 40px white, rule `#eef1fb`; type name Barlow Condensed 600 16px `#1f4fd6`; badge `#e6edff` / `#1a3fb0`, radius 4px |
| Row | 12px 14px, rule `#eef1f7` between rows; 34px plate `1px solid #dbe1ec` on `#f5f6f9` with glyph `#38465f`; label Barlow 500 14px `#1c2233`; hint 12.5px `#57668a`; control column `flex:1 1 220px` | 12px 16px, rule `#eef1fb`; plate radius 8px `#e6edff`, glyph `#1f4fd6`; label `#10194a`; hint `#5a6699` |
| Text field | 34px, `1px solid #dbe1ec`, focused `#38465f` with a 1px `#e4676b` caret; 13.5px `#1c2233`; mono values (icon name, target) Roboto Mono 12.5px `#2f3a4f` | radius 8px, `#dfe5f5`, focused `#1e2a5e`, caret `#ff4d5a`; values `#1a2038` |
| Field trailing action (icon picker search, target browse) | 32px plate inside the field's right edge, `border-left #dbe1ec`, glyph `#c14a52` | `#dfe5f5`, glyph `#1f4fd6` |
| Toggle | 34×18 square; off `1px solid #a9b7d0` on `#eef1f7` with 14px `#a9b7d0` knob; on `#e4676b` with white knob | radius 9px; off `#c5cff5` / `#e6edff`; on `#ff4d5a` |
| Visibility segmented | 30px, Everyone / Selected groups; selected `#e4676b` white 500, other `1px solid #dbe1ec` `#38465f` | selected `#c8303c` with shadow, 6px outer radius; other `#dfe5f5` `#1e2a5e` |
| Group multi-select (when limited) | indented under the control (padding-left 60px / 62px); 34px min field with chips `#38465f` white 12px + ✕, "Add a group…" placeholder `#57668a`, chevron | chips `#dbe5ff` / `#1a3fb0` pill 12px radius; placeholder `#5a6699` |

Rows by item type, in order:

- **Header**: Label, Visibility.
- **Link, parent** (`currentIsParent`): Label, Icon, Expand by default (toggle; hint: "Open this
  group when the sidebar loads. A parent row opens its children instead of going anywhere, so it has
  no target."), Visibility.
- **Link, leaf**: Label, Icon, Target (field + browse plate → `browseTarget()`), Open in a new window
  (toggle), Visibility.
- **Separator**: Visibility.

Row copy: Label / "The text shown in the sidebar." · Icon / "Shown before the label." · Target / "A
page path or any URL." · Open in a new window / "Leave the wiki open behind the link." · Visibility /
"Who sees this item in the sidebar."

**Structure card** (links only; hidden when `editingDisabled`), same card material, 12px 14px:
left — outlined 32px buttons **Nest under the item above** / **Un-nest** (only the applicable one
is enabled; the other renders at the disabled tone `#a9b7d0` on `#eef1f7` border / `#c5cff5` on
`#e6edff`), glyphs indent-increase / indent-decrease, text `#38465f` / `#1f4fd6`; caption below
12px/1.5 "Only one level of nesting. A nested item with no link above it is flagged red in the list
and blocks Save." Right — **Delete item** as a flat red text button (`#c14a52` / `#c8303c`) with the
trash glyph; calls `removeItem`. Header and separator items get the same card with only Delete.

### States to verify

- `menuSource=auto`: header notice, list hint absent, Add row hidden, panel notice + dimmed card,
  structure card hidden, Save disabled (`#a9b7d0` / `#5a6699`).
- `menuSource=mixed`: list hint, dashed generated block at the bottom, generated rows dimmed with no
  grip; selecting a generated row shows the panel notice and dims the card.
- `isInherited`: header notice only; everything else as manual.
- Empty list / nothing selected: keep the existing `emptyMenuText` / `noSelection` cards, styled as
  the Ledger callout / Cobalt banner above.

---

## Tokens introduced or confirmed here

Ledger: hairline `#dbe1ec`, faint rule `#eef1f7`, tint `#f0f2f7` / `#eef1f7`, paper `#f5f6f9`,
ink `#1c2233`, body `#2f3a4f`, secondary `#4e5d7d` / `#38465f`, caption `#57668a`, icon stroke
`#64789f` / `#8a99b8`, disabled `#a9b7d0`, accent fill `#e4676b`, accent text `#c14a52`, slate
button `#38465f`, positive `#5f9c86`, overlay header `#242b3a`, overlay edge `#14171f`.

Cobalt: ground `#f2f5ff`, card white, hairline `#dfe5f5`, faint rule `#eef1fb`, tint `#e6edff`,
ink `#10194a`, body `#1a2038`, secondary `#4a5580` / `#1e2a5e`, caption `#5a6699`, icon `#7f8ed1`,
disabled `#c5cff5`, cobalt `#1f4fd6`, cobalt text on tint `#1a3fb0`, accent fill `#ff4d5a`, accent
with white text `#c8303c`, slate button `#1e2a5e`, positive `#22a37f`, sidebar `#10194a`, sidebar
raised `#141c4f`, overlay header `#1c2a70`, on-dark text `#d7deff` / `#a7b3ea` / `#5a6699`.

Type: Barlow (body), Barlow Condensed (overlay title, Cobalt card h2), Roboto Mono (eyebrows, paths,
icon names, counts). Icons: Lucide/Tabler at stroke 1.5–1.6.
