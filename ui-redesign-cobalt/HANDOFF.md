# Cardinal wiki — handoff 3: the Cobalt aesthetic

Cardinal ships two aesthetics and will only ever ship two. **Ledger** is the brand and the default;
**Cobalt** is the alternate. Every screen in this folder exists in both, and the two sets are
one-to-one: same components, same layout, same behaviour, different tokens and a few shape rules.
Nothing in Cobalt is a new feature; it is the existing 3.x UI wearing a different skin.

Open any `.dc.html` in a browser. `support.js` and `_ds/` sit beside them and are what they load.
Read `DESIGN-DECISIONS.md` beside this file for the locked decisions; the Cobalt paragraph there is
the short form of this document.

## What is being asked

1. An **Aesthetic** setting, `ledger | cobalt`, at two levels:
   - **Site** (admin): `sites.config.theme.aesthetic`, default `ledger`. Rendered as the FIRST row of
     the Appearance card on `pages/AdminTheme.vue`, directly above the existing Dark mode toggle.
     Mockup: `Cardinal Wiki - Aesthetic Setting 3x.dc.html`, option 1a (Ledger) and 1b (Cobalt).
   - **User** (profile): `users.prefs.aesthetic`, `site | ledger | cobalt`, default `site`. Rendered
     in the existing Appearance row of `pages/ProfileInfo.vue` as a second `w-btn-toggle` sitting
     beside the light/dark one — two sibling radio sets in one row, aesthetic first. The hint copy
     changes to: "Aesthetic, then light or dark. Site follows the administrator's choice." Same row
     appears in `UserEditOverlay.vue` (admin editing a user), with the same two toggles.
     Mockups: `Cardinal Wiki - Profile 3x - Ledger.dc.html` / `… - Cobalt.dc.html`, and the lower
     block of each option on the Aesthetic Setting board.
2. **Resolution** mirrors `appearance` exactly: `user.aesthetic === 'site' ? site.theme.aesthetic :
   user.aesthetic`. Guests get the site value.
3. **Dark mode is orthogonal.** Cobalt has no dark token set yet (see "Not yet designed"), so
   `cobalt + dark` renders Cobalt light for now — never Ledger dark. The two axes stay independent
   in the data model and the class model so the dark set can be added later without a migration.

## Architecture — keep it to one class and one token layer

The dark mode implementation is the template. `composables/dark.js` puts `body--dark` /
`body--light` on `<body>` and Tailwind keys `dark:` off it. Do the same:

- `composables/aesthetic.js` — same shape as `dark.js` (module-level ref seeded from the DOM,
  `withoutTransitions()` around the flip, `reactive({ current, set })`). Writes exactly one of
  `body--ledger` / `body--cobalt` on `<body>`.
- `App.vue` — where `userStore.appearance` is watched and `dark.set()` is called (~line 254), add
  the parallel watch on `userStore.aesthetic` + `siteStore.theme.aesthetic` and call
  `aesthetic.set(resolved)`. Also re-run it inside `applyTheme`, which already fires on save from
  AdminTheme.
- `css/tailwind.css` — the Cobalt values are a second block of the SAME custom properties, scoped
  to `body.body--cobalt`. Do not add a `cobalt:` variant, and do not touch component SFCs to add
  per-aesthetic branches. If a component needs to look different in Cobalt, the difference has to
  be expressible as a token (a colour, a radius, a shadow, a border width) or it is out of scope
  for the aesthetic system. That constraint is what makes this lightweight; hold it.
- `css/_theme.scss` — the SCSS face stays Ledger only. Any SFC still drawing from a literal
  `$primary` / `$hairline` etc. will not follow the aesthetic; the fix is to move that rule onto the
  custom property, not to add a Cobalt SCSS map. Feedback from the Ledger passes flagged padding
  restated per caller and background changes not cross-checked against foreground tokens — both
  are symptoms of literals bypassing the token layer. This is the pass to hunt them down.
- `helpers/cssVars.js` — the admin-editable `--q-primary` / `--q-accent` / `--q-header` /
  `--q-sidebar` keep working. When the admin changes the aesthetic, `resetColors()` must reset
  those to the aesthetic's own defaults (the "Reset defaults" button does the same), otherwise a
  site that saved Ledger's `#f0f2f7` sidebar carries it into Cobalt's indigo. Store the per-aesthetic
  defaults in one place (`helpers/aestheticDefaults.js`) and have both `AdminTheme.vue` and the
  backend seed read it.

### Shape tokens Cobalt needs that Ledger never had

Ledger is hairlines and corner marks; Cobalt is shadows and radii. Add these properties to the
token layer with Ledger values of `0` / `none` / the hairline so Ledger renders unchanged:

| Property | Ledger | Cobalt |
| --- | --- | --- |
| `--radius-card` | `0` | `8px` |
| `--radius-control` (buttons, inputs, segments, plates) | `0` | `6px` |
| `--radius-dialog` | `0` | `12px` |
| `--radius-pill` (tags, count badges, avatars) | `0` | `12px` / `50%` |
| `--shadow-card` | `none` | `0 2px 10px rgba(16,25,74,.08)` |
| `--shadow-primary` (the one filled button) | `none` | `0 4px 14px rgba(200,48,60,.35)` |
| `--shadow-dialog` | `0 0 30px rgba(0,0,0,.4)` | same |
| `--border-card` | `1px solid var(--color-hairline)` | `0` |
| `--corner-marks` (display of the `+` registration marks) | `block` | `none` |
| `--nav-active-inset` (sidebar active-item bar) | `2px` left border, accent | `3px` inset box-shadow, `#ff4d5a` |

Cards in Cobalt have no border and no marks; they are white on the tinted `#f2f5ff` ground with the
card shadow. Dialogs and overlays (inbox, profile, history, file manager, table editor, block picker,
menus, confirm) take `--radius-dialog` with `overflow:hidden`; the side dialog rounds only its outer
edge (`12px 0 0 12px`). Ledger's dark eyebrow bar on dialog tops does not exist in Cobalt — the
rounded corner is the edge.

## Cobalt tokens

Colour, with the Ledger value beside it so the mapping is mechanical. Every Cobalt value listed
clears 4.5:1 against the surface it is specified for; the exceptions are marked.

**Chrome**

| Role | Ledger | Cobalt | Notes |
| --- | --- | --- | --- |
| Header bar | `#fff`, hairline below | `#1f4fd6`, no border, 60px | White type and icon strokes. |
| Header eyebrow ("Platform wiki") | `#4e5d7d` | `#dfe6ff` | 5.4:1 on cobalt. NOT `#b9c8ff` (4.1:1). |
| Header search field | `#f5f6f9` + hairline | `rgba(255,255,255,.16)`, 6px radius | Placeholder `#e6ecff`. |
| Sidebar ground | `#f0f2f7` | `#10194a` | |
| Sidebar text / secondary / kicker | `#38465f` / `#4e5d7d` / `#57668a` | `#d7deff` / `#a7b3ea` / `#7f8ed1` | 8.1:1 and 5.3:1 on indigo. |
| Sidebar icon stroke | `#8a99b8` | `#7f8ed1` | |
| Sidebar active item | white, 2px accent left border | `#1f4fd6` fill, white text, 3px `#ff4d5a` inset bar, 6px radius, 10px side margin | |
| Sidebar hairline | `#dbe1ec` | `rgba(255,255,255,.08)` | |
| Admin sidebar (already dark in Ledger) | `#1c2233` / `#242b3a` / `#2a3040` | `#10194a` / `#1c2a70` / `#27337a` | Text `#c5cff5`, icon `#7f8ed1`. |
| Footer strip | `#eef1f7`, text `#57668a` | `#10194a`, text `#a7b3ea`, link `#ff7a84` | |

**Paper and text**

| Role | Ledger | Cobalt |
| --- | --- | --- |
| App ground | `#f5f6f9` | `#f2f5ff` |
| Card / surface | `#fff` | `#fff` |
| Tinted strip (section headers, code chips) | `#eef1f7` / `#f0f2f7` | `#e6edff` |
| Hairline (where one survives: table rules, inner rows) | `#dbe1ec` | `#dfe5f5` |
| Inner rule | `#e4e9f2` | `#e6edff` |
| Ink / headings | `#1c2233` | `#10194a` |
| Body / secondary / caption | `#2f3a4f` / `#4e5d7d` / `#57668a` | `#1a2038` / `#4a5580` / `#5a6699` |
| h2 | ink, hairline rule below | `#1f4fd6`, no rule |
| Avatar plate | `#e9edf5` + hairline, ink text | `#dbe5ff`, `#1a3fb0` text, circle |

**The live edge — accent and links**

| Role | Ledger | Cobalt | Contrast |
| --- | --- | --- | --- |
| Accent FILL, no text or dark ink over it (badge dots, inset bars, TOC marker) | `#e4676b` | `#ff4d5a` | untexted |
| Accent fill carrying WHITE text (Edit button, count badges, Draft badge, selected segment, avatar) | `#c14a52` | `#c8303c` | 5.3:1 under white |
| Accent TEXT on white (active TOC entry, "New comment", Reset defaults) | `#c14a52` | `#c8303c` | 5.3:1 |
| Accent wash | `#fdeced` | `#ffe9eb` | |
| Links | `#a83f45` | `#1f4fd6` (hover `#1a3fb0`) | 6.7:1 on white |
| Primary color (admin default `colorPrimary`) | `#c14a52` | `#1f4fd6` | |
| Positive text / fill | `#3f7a66` / `#5f9c86` | `#177a5e` / `#22a37f` | |
| Tag chip | hairline, `#` in accent | `#dbe5ff` pill, `#1a3fb0` text; an accent tag is `#ffe9eb` / `#c8303c` | |

The mockups were drawn with `#ff4d5a` under white labels and were corrected to `#c8303c` in this
folder before handoff — the same fill/text split Ledger already enforces with `$accent-fill` vs
`$primary` (see `_theme.scss`). If any screen in this folder still shows `#ff4d5a` under white type,
that is a defect in the mockup, not a spec; use `#c8303c`. `Cardinal Wiki - Theme Takes 3x.dc.html`
is the original options board and still carries the uncorrected value — it is history, not a spec.

**Page header banner** — Cobalt only. Where Ledger's page header is a white band with a 64px
corner-marked icon plate, Cobalt's is a card: `linear-gradient(120deg,#1f4fd6,#3d6df7)`, 8px radius,
`0 8px 24px rgba(31,79,214,.28)` shadow, 24px side margin, white title and `#dbe4ff` subtitle, icon
in a `rgba(255,255,255,.16)` plate. Actions inside it sit on `rgba(255,255,255,.14)` plates; the
Edit button is `#c8303c`. In the token model this is `--page-header-bg`, `--page-header-fg`,
`--page-header-radius`, `--page-header-shadow`, `--page-header-margin` (Ledger: white / ink / 0 /
none / 0 with the hairline below).

**Code blocks** — Ledger `#1c2233` with a 2px accent left border, square. Cobalt `#10194a`, 8px
radius, no border, a `bash` mono label top-right in `#7f8ed1`; syntax tokens `#ff7a84` (6.6:1) and
`#8fb0ff` (7.7:1) on the indigo. `codeBlocksTheme` stays a separate admin setting; Cobalt's default
is the same `github-dark`. Cross-check every highlighted token colour against `#10194a` before
shipping — this is exactly the background-change-without-foreground-check the Ledger feedback
called out.

**Page actions rail** — Ledger: 56px strip on `#eef1f7` with a hairline. Cobalt: a floating white
card (card shadow, 8px radius) 64px wide, top-aligned with the TOC and content cards at the same
28px offset, primary action as a 40px `#c8303c` rounded plate with the primary shadow, other actions
as cobalt strokes. Same buttons, same order, same more-menu contents.

## Data and migration

- `backend/api/schemas/site.ts` — add `theme.aesthetic: enum('ledger','cobalt')` beside `dark`.
  `backend/api/schemas/user.ts` — add `aesthetic: enum('site','ledger','cobalt')` beside
  `appearance` in both places `appearance` appears (174, 240). `profile.ts` picks and returns it
  with the other prefs (219, 260). `stores/user.js` gets `aesthetic: 'site'` in state,
  `applyProfile` and `setToGuest`.
- Seed: `DEFAULT_THEME` gains `aesthetic: 'ledger'`.
- Migration: existing rows have no `theme.aesthetic`. Treat a missing key as `ledger` in code
  (`site.theme.aesthetic ?? 'ledger'`) AND write it with a one-line `jsonb_set … WHERE config #>>
  '{theme,aesthetic}' IS NULL`, so no instance depends on the fallback. The Ledger feedback noted
  that new CSS defaults never reached existing installs until a migration was written; this time
  the migration ships with the feature.
- Per-aesthetic admin colour defaults (`colorPrimary` etc.) are NOT migrated. A site keeps the
  colours it saved; switching aesthetic in the admin resets them to the new aesthetic's defaults via
  `resetColors()` — visibly, in the same form, before the admin saves.
- i18n: `admin.theme.aesthetic`, `admin.theme.aestheticHint`, `admin.theme.aestheticLedger`,
  `admin.theme.aestheticCobalt`, `profile.aesthetic*` mirroring the `profile.appearance*` keys, and
  the revised `profile.appearanceHint`. English strings are in the mockups.

## Verification — do this before calling it done

Every Cobalt screen has a Ledger twin with the identical filename minus the suffix. For each pair:

1. Render the real app in both aesthetics and set the Cobalt render beside the Cobalt mockup at the
   same width. The Ledger feedback said several screens were never diffed against their mockup
   until a later pass; do the diff in this pass, per screen, and record it.
2. Flip dark mode on under Cobalt and confirm it renders Cobalt light, not Ledger dark and not a
   broken hybrid.
3. Run the contrast check the codebase already has (`helpers/accessibility.js`, `WCAG_AA_CONTRAST`)
   over the Cobalt token block programmatically — every text token against every surface it is
   specified for in the tables above. Add it as a test beside `accessibility.test.js` so the floor
   is pinned for both aesthetics.
4. Grep for `#e4676b`, `#c14a52`, `#dbe1ec`, `#38465f`, `#f0f2f7`, `#1c2233` in `frontend/src`
   outside `_theme.scss` and `tailwind.css`. Each hit is a literal that will not follow the
   aesthetic. Move it onto the property or document why it must not (file-type colour glyphs are
   the known exception).

## Screens in this folder

Both aesthetics, one row per screen. The Ledger files are the locked set from handoffs 1 and 2 and
are included as the diff baseline; they are unchanged except Profile (the new Appearance row).

| Screen | Ledger | Cobalt | Source |
| --- | --- | --- | --- |
| Page view (canonical) | `Cardinal Wiki - Page View 3x - Ledger.dc.html` | `… - Cobalt.dc.html` | MainLayout, HeaderNav, NavSidebar, PageHeader, PageToc, PageTags, PageActionsCol, FooterNav, Index.vue |
| Editor | `… Editor 3x - Ledger` | `… Editor 3x - Cobalt` | EditorMarkdown, PageHeader (edit), CollabPresence, PageActionsCol |
| History | `… History 3x - Ledger` | `… History 3x - Cobalt` | PageHistoryOverlay, MainOverlayDialog |
| File manager | `… File Manager 3x - Ledger` | `… File Manager 3x - Cobalt` | FileManager |
| Graph | `… Graph 3x - Ledger` | `… Graph 3x - Cobalt` | Graph.vue, GraphClientTypeFilter |
| Inbox / Inbox review | `… Inbox 3x - Ledger`, `… Inbox Review 3x - Ledger` | `… - Cobalt` | InboxOverlay, InboxWatching, InboxReview |
| Tags | `… Tags 3x - Ledger` | `… Tags 3x - Cobalt` | TagsBrowse, PageTags |
| Search | `… Search 3x - Ledger` | `… Search 3x - Cobalt` | pages/Search.vue |
| Login / Auth screens | `… Login 3x - Ledger`, `… Auth Screens 3x - Ledger` | `… - Cobalt` | Login.vue, AuthLoginPanel, AuthLayout, AuthRegisterScreen, AuthTfaScreens |
| Profile | `… Profile 3x - Ledger` | `… Profile 3x - Cobalt` | ProfileOverlay, ProfileInfo — carries the new Appearance row |
| Admin dashboard / General / Blocks | `… Admin 3x`, `… Admin General 3x`, `… Admin Blocks 3x - Ledger` | `… - Cobalt` | AdminLayout, AdminDashboard, AdminGeneral, AdminBlocks |
| Page properties | `… Page Properties 3x - Ledger` | `… - Cobalt` | SideDialog, PagePropertiesDialog |
| Table editor | `… Table Editor 3x - Ledger` | `… - Cobalt` | TableEditorOverlay |
| Block picker | `… Block Picker 3x - Ledger` | `… - Cobalt` | BlockPickerOverlay, BlockPropsForm |
| Menus | `… Menus 3x - Ledger` | `… - Cobalt` | PageNewMenu, NavBrowseMenu, NavSidebarItem, TreeBrowserDialog |
| Primitives | `… Primitives 3x - Ledger` | `… Primitives 3x - Cobalt` | shared/W*, notify.js |
| Aesthetic setting | `Cardinal Wiki - Aesthetic Setting 3x.dc.html` (1a Ledger, 1b Cobalt) | | AdminTheme.vue Appearance card; ProfileInfo / UserEditOverlay Appearance row |

The Cobalt page view is the authoritative Cobalt screen (it was designed by hand). The other Cobalt
screens were derived from their Ledger twins by a systematic token substitution and then corrected
by hand for dialogs and contrast. Where a derived screen and the page view disagree on a shared
primitive, the page view wins; where a derived screen and this document disagree, this document
wins. Log the disagreement rather than guessing.

## Not yet designed

- **Cobalt dark.** `Page View Dark` and `Primitives Dark` exist for Ledger only. Until a Cobalt dark
  set is drawn, `cobalt + dark` resolves to Cobalt light (see above). Do not synthesise one.
- **Cobalt on the public site** (`Cardinal Site - *`). The marketing pages stay Ledger; the
  aesthetic is a product setting, not a brand change.
