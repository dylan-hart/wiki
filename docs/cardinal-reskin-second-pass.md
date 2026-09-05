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
- Page-actions rail glyphs matched (pencil, history, export, more).

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

1. **Graph.** The panels and the notice are done; the control shapes inside them (the joined
   segmented rows, the 13px square checkboxes, the depth field beside its slider) are not.
2. **Inbox.** The rail and the frame match; `InboxWatching`/`InboxReview`'s own content — the banded
   section marker, the `16px 20px` body, the framed notification list with its 36px accent plates —
   does not.
3. **Page history.** The A/B markers and the mode toggle are done. The panel/rail/diff grounds
   (`#1b1f2a` / `#171b24` / `#14171f`, gutter `#11141b`), the `12.5px/1.9` mono and the timeline
   entry's own layout are not.
4. **Profile**, against `Cardinal Wiki - Profile 3x.dc.html` — not yet compared at all.
5. **Editor**, **File manager**, **Tags**, **Login/Auth**, **Table editor**, **Admin blocks** — each
   has its own design file and none has been compared against it in this pass.
6. **Padding, everywhere.** The recurring note in review has been "odd padding not matching the
   mockups". The section-header rhythm is fixed in the page-properties panel; the same treatment
   needs applying wherever `.w-section-header` is used.

## Known flaky

Neither is a product defect, and neither is in code this pass touched — but both cost a re-run, so
they are worth pinning down separately.

- `frontend/src/components/ProfileApiKeyCreateDialog.test.js`'s "real layout" describe drives a real
  headless Chromium and fails intermittently under the full suite's parallelism. Passes alone.
- `backend/mcp/http.test.ts`'s "an active session is not evicted while it is still being used" is
  timing-sensitive and fails intermittently under the full `node --test` run. Passes alone, twice.
