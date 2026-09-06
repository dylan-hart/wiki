# Cardinal re-skin — second pass

The first pass moved the tokens and the shared primitives. It did not move the screens, so the app
kept disagreeing with `ui-redesign/*.dc.html` in a long list of ways. This document is the plan for
the second pass and the record of what it has done, written against one rule:

> **The mockup is the source of truth.** Where this repo and a design file disagree about a colour, a
> measurement, a glyph or a shape, the design file wins, and the code changes.

`ui-redesign/HANDOFF.md` maps each screen to the source files that draw it; `ui-redesign/CLAUDE.md`
carries the locked decisions (the token pairs, the overlay sizings, the four behavioural changes).
Read both before touching anything here.

## What changed structurally, and why it is worth knowing

Four of the fixes are not per-screen edits. They are the reason a long tail of individual complaints
went away at once, and the reason a future edit will not quietly reintroduce them.

**A theme lives in the database, not in the code.** `sites.config` carries `colorPrimary`,
`colorHeader`, `colorSidebar`, the fonts and the rest, and the frontend writes them onto `--q-*` at
runtime. Shipping new *defaults* therefore reaches a fresh install and nothing else — which is why an
existing instance still had a black header, a blue sidebar and a blue accent after the first pass.
`backend/db/migrations/20260905180000_main` moves each value that still holds its pre-Cardinal
default onto the Cardinal one, and leaves a site that has been deliberately re-themed alone.

**Icons are Tabler, and only Tabler.** 1,009 references across 180 files moved off `la:`/`mdi:`;
`frontend/src/assets/icons.generated.js` is 303 Tabler icons and nothing else; `tabler` leads
`DEFAULT_SETS` so the picker offers it first; and `20260905190000_main` repoints icon references
already stored on pages, blocks and navigation items through the same name-for-name table the source
sweep used. A new `la:`/`mdi:` reference in app chrome is a regression.

**Square is a scale, not a call site.** The `--radius-*` scale is zeroed in `css/tailwind.css` and 52
hardcoded radii were removed. `--radius-full` stays, because a radio's dot and a spinner are shapes
rather than corner treatments. Squaring 138 `rounded` call sites one at a time would have left the
next one somebody writes drawing a corner nothing else has.

**One accent, one chrome tone.** Cardinal has no secondary brand colour. 42 `color="secondary"` call
sites (a green) became `slate`, and the places that mean *this one is selected* — the history diff
mode, the two locale menus — took the accent fill the design gives a segmented control.

## Done

Page view, against `Cardinal Wiki - Ledger 3x.dc.html`:

- White header band, tinted sidebar, cardinal accent (via the migration above).
- The Cardinal placeholder mark replaces the Wiki.js logo everywhere, backend fallback included.
- Header icon buttons back to 64x64, square, flush.
- Account button draws the reader's initials in a slate plate.
- Rendered content: ink headings in the display face over flat hairline rules, a blockquote that is a
  framed box with a tinted gutter and corner marks, a square inline-code chip, an ink code block with
  an accent edge. The gutter is a `::before` sized in `inset-inline-start`, so it still follows `dir`.
- `Last modified Tue 4:12 PM` (`userStore.formatRecent`), the breadcrumb band's fixed height and mono
  treatment, the article's `32px 28px 44px`, the masthead's height/subtitle weight, the icon plate's
  corner marks.
- The metadata rail is inset `28px 20px` with its rules inside that inset and mono overlines for its
  section headings.
- The footer reads the design's colophon and links to this project.
- Header and sidebar glyphs matched to the design; nav section headings take the chrome overline.
- Page-actions rail glyphs matched against the design: history, export and more (the three dots)
  all still draw what `Cardinal Wiki - Ledger 3x.dc.html` draws. The rail's primary square is the
  exception, and no longer a match on purpose: the design draws a pencil there, and #2618 replaced
  it with `tabler:tag` on Dylan's call, since the panel it opens is Page Properties — contents,
  tags, ratings, comments — not an edit action. A deliberate departure from the mockup, not drift.

Admin, against `Cardinal Wiki - Admin 3x.dc.html`:

- Every page opens on a white band: a framed 64px icon plate with corner marks, the `ADMIN . SECTION`
  overline (derived from the route by `components/AdminPageEyebrow.vue`, so the 37 pages cannot
  disagree with the sidebar), the title, the subtitle.
- Dashboard cards on the design's auto-fit track with flat tinted footers; the recent-logins panel
  capped at its readable measure under a banded head.
- Sidebar type and icon tones; the Contribute button's accent edge; an upper-cased locale code; a
  dashboard that describes itself instead of saying "Wiki.js".

Overlays and dialogs:

- The overlay panel is a solid ink top edge over a flat surface, as the design draws it. Profile and
  Inbox sit at `50vw`/`50vh` with a `min(560px, 100%)` / `420px` floor and no ceiling.
- Eleven dialog headers stopped overriding the shared band's padding with `px-4 py-2`.
- Page properties: the design's section rhythm (a full-bleed 34px band, then `14px 16px`), fields
  that carry their label as a placeholder, a slate "Add relation", square A/B markers in the accent.
- `WRange` is the design's slider: a 2px hairline rail, an accent span, square 12px handles and ticks
  under the rail rather than dots on it.
- Page tags are hairline plates with the accent on the `#` alone.

Graph, against `Cardinal Wiki - Graph 3x.dc.html`:

- Both control panels are opaque hairline panels rather than frosted glass, with the language's mono
  overlines; the legend is a tinted block inside the rail; the tooltip is a solid ink plate.
- The truncation notice is the design's plate with an accent edge, and its text is a locale key.

## Still to do

Ordered by how far each is from the design file it should match.

1. **Graph.** The panels, the notice, the segmented rows, the checkboxes, the filter overlines and
   the depth readout are done. Nothing outstanding that a comparison has turned up.
2. **Inbox.** The rail, the frame and the notifications body match; `InboxReview`'s own content does
   not, and neither does the framed list's 36px accent plate.
3. **Page history.** The A/B markers, the mode toggle and the panel/rail/diff grounds are done. The
   timeline entry's own layout — the 28px round action dot, the wrapped reason/fields row — is not.
4. **Profile.** The rail matches. `ProfileInfo` and the sections under it have not been compared.
5. **Editor**, **File manager**, **Tags**, **Login/Auth**, **Table editor**, **Admin blocks** — each
   has its own design file and none has been compared against it in this pass.
   - **Editor** has now been compared. The insert rail and the markup bar are light slate chrome
     rather than a dark block and a cardinal-red band, both toolbars are the design's 40px, the pane
     seam is a hairline, the preview renders onto paper at its 22/24 inset, and Monaco's theme takes
     the design's ground/gutter (which were swapped), its current-line band, caret, code lens and
     markdown token ramp. The page-actions rail fills while editing — in `#c14a52`, per the
     divergence below, since it carries white glyphs and a white overline. Not done here and handed
     on: the preview's own rendered content (item 6), `.w-section-header` padding (item 7), and
     `CollabPresence`'s initials derivation, which belongs to the `helpers/initials.js` consolidation.
6. **Rendered content beyond prose.** Admonitions now take the language's status tones; task lists,
   footnotes, keyboard keys and the code-token palette have not been looked at.
7. **Padding, everywhere.** The recurring note in review has been "odd padding not matching the
   mockups". `.w-section-header` now rules on both edges and the page-properties panel takes the
   design's 14/16 rhythm; every other caller of that class still needs walking through.

## One deliberate divergence

The design fills a selected segment, an A/B cursor and a primary button with `#e4676b` and puts a
white label on it. That pair is 2.9:1, and the brief that opened this work set a hard floor of 4.5:1
for body text. Where a fill carries white text the app therefore uses `#c14a52` — the same hue, the
tone `css/tailwind.css` and `helpers/accessibility.test.js` already reserve for exactly this job —
and keeps `#e4676b` for fills that carry no text, or ink: the active-nav bar, an icon, a plate edge.
