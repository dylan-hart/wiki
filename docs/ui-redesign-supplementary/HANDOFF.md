# Cardinal wiki — handoff 2

Four screens, all grounded in the `scarlett` branch of `dylan-hart/wiki`. Nothing here re-treads the
first handoff; these are the surfaces that had no Ledger treatment yet.

Open any `.dc.html` in a browser. `support.js` and `_ds/` sit beside them and are what they load.

| File | Rebuilds | Repo source |
| --- | --- | --- |
| `Cardinal Wiki - Menus 3x.dc.html` | create menu, sidebar context menu, up-one-level button, Save as… dialog | `PageNewMenu.vue`, `NavBrowseMenu.vue`, `NavSidebarItem.vue`, `TreeBrowserDialog.vue`, `BlueprintIcon.vue` |
| `Cardinal Wiki - Search 3x.dc.html` | search results page | `pages/Search.vue`, `HeaderNav.vue`, `FooterNav.vue` |
| `Cardinal Wiki - Block Picker 3x.dc.html` | block picker overlay | `BlockPickerOverlay.vue`, `BlockPropsForm.vue`, `helpers/blocks.js` |
| `Cardinal Wiki - Admin General 3x.dc.html` | admin General settings page | `pages/AdminGeneral.vue`, `AdminLayout.vue`, `BlueprintIcon.vue` |

## Tokens (unchanged from handoff 1)

Light: ground `#f5f6f9`, paper `#fff`, tinted strip `#eef1f7` / `#f0f2f7`, hairline `#dbe1ec`
(inner rules `#e4e9f2`, stronger edge `#c9d2e2`), icon stroke `#64789f` / `#8a99b8`, dark chrome
`#1c2233` / `#242b3a` / `#38465f`.

Text: body `#2f3a4f`, secondary `#4e5d7d`, caption `#57668a`. Nothing lighter than `#57668a` carries
text on paper.

Accent: `#e4676b` fills, `#c14a52` accent text on white, `#a83f45` links and accent text on the
tinted strips. Positive text `#3f7a66`. Custom-block purple `#7a4a86`.

Type: Barlow Condensed (headings, uppercase eyebrows), Barlow (body, UI), Roboto Mono (paths, codes,
counts, kickers). Kickers are `600 10px` mono, `.2em` tracking, uppercase, in `#a83f45` on a tinted
strip or `#c14a52` on paper.

## Screen notes

### Menus

Menu rows carry the 34px hairline plate — `BlueprintIcon.vue` already exists and `PageNewMenu` uses
it on every row, so a menu and a settings list are the same material. The pointer-anchored context
menu drops plates to 28px and trims the import rows; a menu at the finger should not be taller than
the tree it covers. It also carries a mono line naming the target folder, because right-clicking a
page creates a sibling and that is otherwise invisible.

Corner marks: two opposite corners on a menu, all four on a dialog. A menu is a light object.

The up-one-level control is a 28px plate, absent at the root rather than disabled, glyph at 70%
opacity at rest and full strength on hover, accent focus ring 2px clear of the plate. It is the one
control in the Browse panel's 52px header, and the same plate carries the same meaning in the file
manager and the tree-browser dialog.

Save as… keeps the source's geometry: 860px card, tree column at 1/3 tinted `#eef1f7`, file list at
2/3, both scrolling inside the same fixed 300px. The path bar between the browser and the fields is
what the tree and the leaf field add up to. Selection in the tree is the one accent fill on the
sheet. Tweak `mode` switches the header and the translations checkbox for duplicate / rename.

### Search

Two deliberate removals from 2.x: the dark radial band behind the card, and the floating circular
Back button in the left gutter. The card sits on the same light ground as every other screen, held
by a hairline instead of a shadow; the header's own search field is what brought the reader here and
is still on screen.

Matched terms take `background:#fdeced;color:#a83f45;font-weight:600` — the same treatment the
header's preview panel uses. Result rows are icon plate, title, description, mono path, then the
highlight; date and tags sit in a 150px trailing column.

The Sort by, Filters and Results header strips are pinned to a fixed height with `line-height:1`, so
the result count cannot make the Results bar taller than the panel beside it.

Responsive behaviour from the source, unchanged: below 900px the filter column becomes a disclosure
strip above the results, closed to start with; below 600px the card becomes the screen and a result
row stacks, date and tags wrapping under the title inset 56px to clear the plate.

### Block picker

Near-full-bleed overlay, 24px scrim margin. Catalog at two cards per row however wide the overlay
gets (`minmax(max(280px, calc(50% - 6px)), 1fr)`), dropping to one below that.

Selection changed materially: 2.x drew a coloured glow, which a line-drawing card cannot wear.
Selection here is the accent hairline plus corner marks plus a tinted icon plate — drawn in line
weight, and nothing reflows as it moves between cards.

Insert takes the accent rather than the source's green: it is the primary action, and the accent is
reserved for the live edge. A required prop is marked with an accent dot, and Insert stays disabled
until every one is filled.

### Admin General

The pattern reference for the remaining settings pages. A page is a 7/5 column split of cards; a
card is a mono uppercase header strip on `#f0f2f7` over settings rows; a row is 34px plate, label
over hint, control at the trailing edge, `#eef1f7` rule between rows.

Controls in use, all reusable as-is: single-line input, select, toggle (accent fill on, `#eef1f7`
with `#a9b7d0` knob off), three-option segmented control with the active option accent-filled, and a
two-handle range with tick markers for the contents depth. The logo and favicon rows stack their
preview under the row rather than beside it.

## Still undesigned

Profile sections other than Identity (avatar, authentication, groups, API keys, notifications), and
the admin settings pages other than dashboard, blocks and general. The General page plus the
primitives sheet from handoff 1 should carry all of them without another design pass.
