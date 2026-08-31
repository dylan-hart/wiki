# Decision: rename the three measurement admin labels, don't regroup them

Status: **Decided — rename only (option a)**
Date: 2026-08-31
Related: Epic 2086 ("Settle two admin conventions..."), Work Package 2091

## Context

Three admin screens deal with measurement, and their labels used to read as near-duplicates of
each other despite covering different things and living in different sidebar sections:

- `AdminAnalytics.vue` — **"Analytics"** — configures third-party tracking providers (Google
  Analytics, Matomo, ...) for a page's own site. Per-site, listed under the **Site** sidebar
  section (`frontend/src/router/routes.js:79`, rendered at `AdminLayout.vue:153`), gated on
  `manage:sites`.
- `AdminPageviews.vue` — **"Page View Tracking"** — toggles the wiki's own built-in page-visit
  logging, used to size nodes in the knowledge graph. Instance-level, listed under **System**
  (`routes.js:103`, rendered at `AdminLayout.vue:361`), gated on `manage:system`.
- `AdminMetrics.vue` — **"Metrics"** — the Prometheus scrape endpoint. Instance-level, also under
  **System** (`routes.js:104`, rendered at `AdminLayout.vue:352`), gated on `manage:system`.

The sidebar split is not cosmetic: `AdminLayout.vue:155` gates the analytics link on
`userStore.can('manage:sites')`, while the entire System block at `AdminLayout.vue:292` is gated
on `userStore.can('manage:system')`. A site-delegated admin (has `manage:sites`, not
`manage:system`) can see "Analytics" and can never see "Page View Tracking" or "Metrics" — the two
groups are genuinely different audiences, not an arbitrary filing choice.

Given that, "Analytics" reading almost identically to "Page View Tracking" was actively
misleading: an admin skimming either section for "the traffic thing" had no label-level signal
that they're different systems (third-party tracking vs. this wiki's own visit counter) let alone
that they're gated differently.

## Options considered

**(a) Rename the labels, leave the sidebar grouping alone.** Make the scope explicit in the label
text itself — "Analytics Providers" and "Page Views" — while leaving `routes.js` and
`AdminLayout.vue`'s Site/System sections exactly as they are.

**(b) Group the three under a shared sub-heading.** The sidebar already renders section headers
via `w-item-label header` rows, so a "Measurement" sub-heading could visually cluster all three —
but only by moving `AdminAnalytics.vue`'s route out of **Site** and into **System**, or by
duplicating/faking a cross-section heading, either of which would either break or obscure the
`manage:sites` vs. `manage:system` permission boundary the current sections encode.

## Decision

**Option (a).** Renamed in `backend/locales/en.json`:

- `admin.analytics.title`: "Analytics" → **"Analytics Providers"**
- `admin.pageviews.title`: "Page View Tracking" → **"Page Views"**
- `admin.metrics.title`: unchanged ("Metrics" was already unambiguous once its sibling read
  "Page Views" rather than "Page View Tracking").

No changes to `frontend/src/router/routes.js` or `AdminLayout.vue`'s sidebar structure.

## Reasoning

- **The permission split is real, not incidental.** `AdminAnalytics.vue` is a **per-site** setting
  (it configures tracking for the site whose admin area you're in); `AdminPageviews.vue` and
  `AdminMetrics.vue` are **instance-wide**. Grouping them under one visual heading would either
  require moving Analytics into the System section (wrong — it would then imply `manage:system`
  is required to reach it, silently taking the setting away from every site-delegated admin who
  can use it today) or would need a cosmetic-only heading spanning two permission-gated sidebar
  blocks, which Vue's conditional rendering (`v-if="userStore.can(...)"` per section) doesn't
  support without restructuring the template around a boundary that doesn't otherwise exist.
- **The rename alone resolves the actual confusion.** The complaint was never "these should be
  adjacent," it was "these read like the same feature." Once the labels say "Analytics
  **Providers**" (third-party tools you configure) and "Page **Views**" (this wiki's own visit
  count), a reader distinguishes them from the label text alone, in either sidebar section,
  without needing them side by side.
- **A future regroup is one label rename away from a permission bug.** Keeping the routes as-is
  means the site/instance boundary can't accidentally drift while someone is only trying to fix
  wording. If a genuine case for regrouping ever comes up, it has to be argued on its own terms —
  restructuring `AdminLayout.vue`'s permission-gated sections — not smuggled in under a labels-only
  WP.

## Non-goal fixed in passing

While locating `admin.analytics.title`, `backend/locales/en.json` was found to have the entire
`admin.analytics.*` key block accidentally duplicated verbatim (an old copy/paste artifact
unrelated to this decision). Since `JSON.parse` keeps the _last_ occurrence of a repeated key, the
duplicate was removed as a prerequisite for the rename to take effect at all — otherwise the
second, stale copy would have silently won and the served label would still have read "Analytics".
This is a mechanical fix, not a scope decision.
