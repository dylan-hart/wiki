# Decision Record: Where an Embedded Setting on a Viewer Page Saves From

**Date:** 2026-08-31
**Status:** Decided — gates OpenProject #2089 (Epic #2086)
**Author:** Task #2089

## The question

Thirteen of the admin area's pages are pure settings forms — the whole page is one form, and it
commits from a single `unelevated` primary `common.actions.apply` button in the page header
(`AdminGeneral.vue:37`, `AdminTheme.vue:39`, `AdminLocale.vue:37`, `AdminLogin.vue:39`,
`AdminAuth.vue:37`, `AdminMail.vue:39`, `AdminEditors.vue:37`, `AdminStorage.vue:42`,
`AdminSecurity.vue:37`, `AdminBlocks.vue:54`, `AdminComments.vue:40`, `AdminAnalytics.vue:27`,
`AdminFlags.vue:39`). A fourteenth, `AdminRendering.vue`, once followed the same pattern but has
since been deleted outright as dead scaffolding (empty `load`/`save`, fake data) rather than kept as
an example of it.

Not every admin page is that shape. `AdminAuditLog.vue` is primarily a **viewer** — a filtered,
paginated list of audit-log entries — with a retention-days setting embedded in a card near the
bottom. Should that embedded setting commit from the same page-header Apply affordance as the
fourteen settings pages, or from a save control local to its own card?

## Decision

**Card-local save is the sanctioned pattern for a setting embedded in a viewer page.**
`AdminAuditLog.vue` keeps its in-card `flat` `common.actions.save` button
(`AdminAuditLog.vue:174-180`), unchanged, rather than growing a header Apply.

## Reasoning

- **`AdminAuditLog.vue` already has a card-local save model for its other embedded settings
  surface, and the two would conflict otherwise.** The filter bar (actor/event/date-range) is its
  own card with its own `t('admin.audit.applyFilters')` / `t('admin.audit.resetFilters')` buttons,
  committed independently of the retention card below it. Moving _only_ retention to a page-header
  Apply would leave one page with two different save models side by side, and would raise a
  question neither affordance answers on its own: does the header Apply also re-run the filter
  apply? A single page mixing both conventions is a worse outcome than picking one and using it
  for both of the page's embedded settings.
- **There is already a precedent for a card-local Apply/save button outside the fourteen pure
  settings forms**: `AdminSearch.vue:105`'s engine-config panel commits via an `unelevated`
  `common.actions.apply` button inside the config card's own `w-card-header`, not the page header
  — because `AdminSearch.vue` is a list-beside-panel management page (pick an engine, configure
  it), not a single top-to-bottom form. `AdminAuditLog.vue` is the same shape of exception: a page
  whose primary content is something other than one form, with a settings card living inside it.
- **The page-header Apply pattern reads, to a user, as "commit everything on this page."** That
  reading is correct for the fourteen settings-only pages (there is nothing else on the page to
  disambiguate from) and would be actively misleading on a page like `AdminAuditLog.vue`, where
  "everything on this page" also includes a live, already-loaded list of log entries with no
  pending edits to commit.
- **Rejected alternative — move retention to a header Apply and drop the in-card button.** This is
  formally consistent with the fourteen pure-settings pages, but only by ignoring the fact that
  `AdminAuditLog.vue` and `AdminSearch.vue` are not that shape of page to begin with. The fourteen
  pages don't establish "every admin page saves from its header" — they establish "a page that
  _is_ one settings form saves from its header." `AdminAuditLog.vue` isn't one; extending the rule
  to it would be over-generalizing from an accident of what those fourteen pages happen to have in
  common (being pure forms), not from the actual thing the convention is about (a page-wide commit
  vs. a section-local one).

## Consequence for future pages

When a future admin page is itself one settings form top to bottom, follow the fourteen-page
header-Apply convention. When a setting is embedded inside a page whose primary content is
something else (a list, a viewer, a picker-plus-panel like `AdminSearch.vue`), give it its own
card-local save control, scoped to just that card's fields — do not promote it to a page-header
Apply, and do not let it silently piggyback on some other section's commit action.
