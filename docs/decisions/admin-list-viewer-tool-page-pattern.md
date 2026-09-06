# Decision Record: What an Admin List, Viewer or Tool Page Takes From the Settings Pattern

**Date:** 2026-09-06
**Status:** Decided — OpenProject #2702 (Feature #2693, the Cardinal re-skin's handoff-2 epic)
**Author:** Task #2702

## The question

`Cardinal Wiki - Admin General 3x.dc.html` is, in the handoff's own words, "the pattern reference
for the remaining settings pages", and Task #2699 turned it into two shared components:

- **`WSettingsCard`** — a mono uppercase header strip on `--color-tint-alt` over a stack of rows;
- **`WSettingsRow`** — a 34px hairline plate, a label over its hint, one control at the trailing
  edge, and a `--color-tint` rule between rows.

Twenty-one settings pages adopt both (#2700), and five profile sections adopt them too (#2701).
**Thirteen admin pages are not settings pages at all**, and the handoff never drew them:

`AdminAuditLog`, `AdminClassification`, `AdminCluster`, `AdminExtensions`, `AdminGroups`,
`AdminIcons`, `AdminPages`, `AdminScheduler`, `AdminSites`, `AdminTerminal`, `AdminUsers`,
`AdminUtilities`, `AdminWebhooks`.

(21 + 13 + `AdminGeneral` + `AdminBlocks` + `AdminDashboard` = 37, which is every admin page.)

`AdminUsers` is a table, `AdminAuditLog` a log viewer, `AdminTerminal` a terminal, `AdminScheduler`
a job monitor. What, if anything, do they take from the pattern?

## Decision

**They take the card and its heading band. They take the row only where a row genuinely is a named
setting or action. They take nothing for a data-driven collection row.**

Concretely, three shapes, and which treatment each gets:

### 1. The card, and its heading band — yes

Every list, viewer and tool on these pages sits in a `WCard`, as it already did. Where a card needs
a heading, that heading is **`<w-card-header>`** — the app-wide `.w-section-header` band — and not
a `text-subtitle1` div inside a `WCardSection`, which is the hand-written treatment `WCardHeader`
was extracted to replace and which had drifted back onto two of these pages.

**A card takes a heading when its content is not what the page header already announces.** Every
admin page now carries a header band — a framed 64px icon plate, the `ADMIN · SECTION` overline,
the title and the subtitle — so a page whose single card *is* the page (the tool list on
`AdminUtilities`, the site list on `AdminSites`, the table on `AdminUsers`, the terminal) needs no
strip repeating the page's own title inside its only card. A card the page header does not name —
`AdminIcons`' Storage/Cache readout, `AdminClassification`'s Coverage panel, `AdminUtilities`' scan
results — takes one.

**It is `WCardHeader`, not `WSettingsCard`.** The settings strip is inseparable from the settings
card, and the two bands really do differ (`--color-tint-alt` at 10px/14px in 11px mono tracked
0.18em with no trailing margin, against `--color-tint` at 6px/16px in 10px mono tracked 0.2em with
a 12px `margin-block-end`). Whether they should converge is a real question and belongs to the Task
that owns `.w-section-header` (#2631), not to a call site — restating five metrics from a call site
is exactly the drift that band exists to undo. If #2631 converges them, these pages inherit it with
no further edit.

### 2. The settings row, where a row *is* a named setting or action — yes

A row qualifies when all three of these hold:

- it is **written at design time**, not produced by `v-for` over server data;
- it **names one thing** — a label, and a sentence of hint under it;
- it carries **one control at the trailing edge** that acts on that one thing.

That describes `AdminUtilities`' ten-row tool list exactly (each row: a plate, a name, a sentence,
and a Proceed button), and `AdminAuditLog`'s embedded retention setting. Both were already written
out by hand as the `WItem` + `BlueprintIcon` + two `WItemSection` + two `WItemLabel` stack that
`WSettingsRow`'s own docblock says it replaces, so adopting it is a subtraction, not a new
treatment. An action row is a settings row whose control happens to be a button: the design's own
note is that "a menu and a settings list are the same material", and the plate is what says so.

Such a row keeps the card-local save affordance
`docs/decisions/embedded-setting-save-affordance.md` already settled — the pattern changes the
row's shape, not where it commits from.

### 3. A data-driven collection row — no

A `WTable` row (`AdminUsers`, `AdminPages`, `AdminGroups`, `AdminCluster`, `AdminAuditLog`,
`AdminScheduler`), a catalogue or entity row (`AdminSites`, `AdminWebhooks`, `AdminExtensions`,
`AdminIcons`' set list, `AdminClassification`'s level list), a log line, and the terminal keep the
shape they have. The settings row is a triple — one label, one hint, one control — and these rows
are not triples: a site row carries a title, a hostname chip, an enabled toggle and three buttons;
an extension row carries a title, a description, a link and a five-way button group. Fitting them
to the triple would mean dropping columns, which is precisely why these thirteen pages were carved
out of the roll-out rather than folded into it.

A third shape turns up on two of them and is neither: the **stat readout** (`AdminIcons`' storage
card, label over value, no plate and no control). It is a definition list, it is undesigned, and
this decision does not invent a treatment for it — see below.

## Consequence for the next list page

When a new admin page is a list, a viewer or a tool: put it in a `WCard`; give that card a
`<w-card-header>` only if the page header does not already name what is in it; reach for
`<w-settings-row>` for a fixed, named setting or action; and leave a data-driven row as a table or
a `WItem` list. Do not hand-write a `text-subtitle1` heading, and do not tint a card to separate it
from the ground — Cardinal separates with a hairline, and reserves tint for the strip.

## What applying it changed, 2026-09-06

Two of the thirteen. `AdminUtilities`' ten-row tool list became ten `WSettingsRow`s (its scan-results
card's `text-subtitle1` heading became a `WCardHeader`), and `AdminAuditLog`'s retention setting
became one (its own `text-subtitle1` heading became the row's label, and the `bg-grey-2` wash under
it came off, since a settings row sits on paper).

The other eleven were audited and needed nothing under this decision, which is the result worth
recording rather than the absence of a diff:

- `AdminClassification` and `AdminIcons` already head their non-obvious cards with `WCardHeader`
  (Coverage; Sets and Storage) and leave their main list unheaded.
- `AdminCluster`, `AdminExtensions`, `AdminGroups`, `AdminSites`, `AdminTerminal`, `AdminUsers` and
  `AdminWebhooks` are each one card that IS the page.
- `AdminScheduler`'s three cards are mutually exclusive by `displayMode`, each already named by the
  tab that selected it.
- `AdminPages`' filter and re-tag panels are toolbars of labelled controls, named by the control
  that opened them.

`pages/adminPageShape.test.js` re-derives the thirteen by grep and fails if this record stops naming
exactly them, so a new admin page cannot land without being classified.

## What this decision does not cover, and is genuinely still undesigned

The handoff's claim that "the General page plus the primitives sheet from handoff 1 should carry
all of them without another design pass" was made about *settings pages*. It does not hold for
these thirteen, and four surfaces on them have no design to conform to:

1. **The table.** `WTable`'s header row, row rhythm, zebra/hairline treatment, sort affordance and
   pagination footer are pre-Cardinal, and six of these pages are mostly table. Nothing in either
   handoff draws one.
2. **The empty state.** The same block — a tinted card, an info glyph, one caption — is written out
   verbatim on `AdminAuditLog`, `AdminPages`, `AdminWebhooks` and three times on `AdminScheduler`.
   It wants one shared primitive and a drawn treatment; it has neither.
3. **The stat readout.** `AdminIcons`' storage card, and anything like it: a label-over-value list
   with no plate and no control.
4. **The terminal and the job monitor.** `AdminTerminal`'s xterm chrome (its own colours, its own
   type) and `AdminScheduler`'s tab-plus-table monitor are the two surfaces furthest from anything
   the design language has drawn.

Separately, 34 `bg-grey-2` / `bg-grey-3` / `bg-dark-5` card washes survive across 21 files —
elevation-by-tint from before Cardinal, which separates a card from its ground with a hairline. It
is a repo-wide sweep, not a thirteen-page one, and it is recorded here rather than done piecemeal.
