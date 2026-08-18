# Variances

Genuine, justified deviations from spec, and follow-up findings surfaced during implementation that
are out of the originating task's own scope to fix. Not a changelog — an entry is removed once
resolved, not left behind as history.

## Feature 413 ("RTL support end-to-end")

### No real Arabic/Hebrew locale data (task 727)

`backend/locales/metadata.js` (Localazy-generated) lists only de/en/fr/pt-BR/ru/zh — none RTL — and
only `en.json` exists on disk. Getting real Arabic or Hebrew strings requires enabling those
languages on the Localazy project and re-running the download, which is an external/ops dependency
outside this feature's engineering scope.

**Workaround**: `backend/scripts/seed-rtl-test-locale.ts` inserts a synthetic `ar` locale directly
into the `locales` table (`isRTL: true`, hand-translated strings across `common.*`/`editor.markup.*`/
`admin.*`/`auth.*`/`welcome.*`) for validation purposes. Not a substitute for real Localazy-sourced
Arabic/Hebrew — a follow-up for whoever owns the Localazy project.

### Admin chrome direction: mirrors with the rest of the app (task 727)

Decided, not left ambiguous: the admin area's own chrome (`AdminLayout.vue` and everything under
`/_admin`) inherits `dir="rtl"` along with the rest of the document rather than being forced to stay
LTR. Reasoning:

- The app has exactly one document-wide direction control point (`App.vue#applyLocale`,
  `composables/direction.js`) and one `commonStore.locale` — there is no separate "admin UI language"
  concept to hang a different direction off of.
- `AdminLayout.vue`'s own header carries a locale switcher (`commonStore.setLocale(lang.code)`) that
  lets an operator pick *any* installed locale, RTL ones included, directly from within the admin
  area — the admin UI is evidently meant to render in whatever locale is active, not assumed
  English/LTR-only.
- Forcing LTR chrome around genuinely RTL-translated `admin.*` label text (which does render in
  Arabic once `ar` is the active locale, per the same `t()` mechanism as everywhere else) would
  produce mismatched, not merely conservative, layout — worse than mirroring, not safer.
- **Not independently verified against Wiki.js 2.5.x**: no 2.5.x source tree was available in this
  sandbox to check what the prior version actually did here, as the task asked where unclear. If a
  2.5.x precedent surfaces later that disagrees, this decision should be revisited by the parent
  Feature/Epic — it was made from this fork's own architecture, not a ported behavior.

### Further RTL mirroring bugs found while validating (task 727)

Two were fixed directly (`AdminLayout.vue`, both covered by `AdminLayout.test.js`), since they were
small, safe, and directly encountered while walking the admin area this task's brief calls out:

- The header's own language-switcher menu had a hardcoded `anchor="bottom right" self="top right"` —
  the same class of bug task 721 fixed in `PageHeader.vue`'s review-queue menu, fixed the same way via
  `helpers/directionalAnchor.js`.
- `.count-badge`'s accent border (the nav sidebar's unread/empty-section indicator) used physical
  `border-right`/`border-right-color` instead of `border-inline-end`/`border-inline-end-color` — the
  same class of bug task 721 fixed in `NavSidebar.vue`'s open-group rail.

One was **not** fixed, foundational rather than cosmetic, and outside RTL-mirroring scope to fix here:

- **`stores/site.js#describeLocales()`'s `isRTL` resolution was silently broken in real Chromium.**
  Task 716 chose `new Intl.Locale(code).textInfo.direction === 'rtl'`. This sandbox's Node (the only
  runtime the existing Vitest suite ever ran against) happens to implement `.textInfo` as a getter, so
  every unit test passed — but a real, recent Chromium build (verified live via Playwright during this
  task, not assumed) implements `Intl.Locale.prototype.getTextInfo()` as a **method** instead and has
  no `.textInfo` getter at all. Reading `.textInfo.direction` throws there, silently caught, and
  defaulted every single locale to `isRTL: false` — meaning `dir="rtl"` never actually applied for a
  real reader on Chrome, regardless of anything built on top of it in tasks 716/721/723. **Fixed** in
  this task (`textDirection()` feature-detects `getTextInfo()` vs. `.textInfo`, preferring the method),
  with a regression test (`site.test.js`) that simulates the Chrome-shaped `Intl.Locale` rather than
  relying on whichever shape the CI runner's own Node happens to expose. Recorded here rather than
  silently fixed because of its severity and because it was caught only by running against a real
  browser end-to-end, which is worth the parent Feature knowing explicitly.

Recorded, not fixed, because they are not RTL-mirroring bugs (they would affect any non-English,
complete-or-not locale, direction aside) and each needs its own design pass:

- **vue-i18n's `fallbackLocale: 'en'` is configured but its dictionary is never guaranteed to be
  loaded.** `App.vue#applyLocale()` only ever fetches/sets messages for the locale being switched TO,
  never also for the fallback. A reader whose persisted `desiredLocale` (`localStorage`) is a non-`en`
  locale, on a fresh page load, never gets `en` messages loaded at all in that session — so any string
  missing from that locale (which describes essentially any real, incomplete community translation,
  not just this task's deliberately-partial seed) renders as the **raw i18n key** (`editor.props.icon`,
  `inbox.title`, …) instead of falling back to English. Reproduced live while walking this task's
  seeded locale across a fresh navigation. Needs a design decision (always eager-load `en` alongside
  any non-`en` locale? Gate it on `locales.completeness` to avoid an extra request for a 100%-complete
  locale?) rather than a one-line patch under this task.
- **`AdminLocale.vue`'s `load()` can silently revert an in-flight edit.** It re-fires on its own
  `watch(() => adminStore.currentSiteId, ...)`, which resolves asynchronously shortly after
  `AdminLayout.vue`'s mount — a toggle clicked before that resolves can be wiped out by the server's
  still-unchanged response landing after the click. Worked around in `e2e/tests/rtl.spec.js` (an
  explicit "Refresh" + wait for its own `aria-busy` to clear, before touching the toggle); not fixed in
  app code since it is a pre-existing timing issue unrelated to RTL.
- **`EditorWysiwyg.vue` is not reachable at all right now.** `pages/Index.vue`'s `editorComponents` map
  has its `wysiwyg` entry commented out (only `markdown` and `redirect` are registered), so
  `/_create/wysiwyg` never mounts the component — under any locale or direction, with no console error
  to say so. Discovered live during this task's walk (task 727's brief asks to validate "both the
  Markdown and WYSIWYG editors"); not something this task can validate under RTL as a result, since
  there is currently nothing there to validate. Wiring up a whole editor mode is outside an RTL task's
  scope — `e2e/tests/rtl.spec.js` only asserts `dir` survives the navigation, with a comment explaining
  why it stops there.
- **The Markdown editor's toolbar buttons carry no `aria-label`.** `t('editor.markup.bold')` and its
  siblings only ever render into a `<w-tooltip>` (hover-only) — there is no accessible name on the
  buttons themselves for a screen reader, RTL or not. `e2e/tests/rtl.spec.js` checks the translated
  string by hovering instead of by role/name for this reason.
- **`LocaleSelectorMenu.vue` and several `w-menu` anchors in `MainLayout.vue`'s sidebar are not yet
  audited for RTL mirroring.** `LocaleSelectorMenu.vue`'s own default `anchor`/`self` props, and the
  `nav-browse-menu`/`nav-edit-menu` anchors `MainLayout.vue` passes explicitly, are all still
  hardcoded physical pairs (`"top right"`, `"bottom left"`, …) not run through
  `helpers/directionalAnchor.js`. Not fixed here: task 721's audit named `NavSidebar.vue`/
  `PageToc.vue`/`PageHeader.vue`/the editor toolbars specifically, and `MainLayout.vue`'s own sidebar
  chrome was missed by that pass entirely — a real gap worth a dedicated small follow-up (the same
  mechanical fix as the two `AdminLayout.vue` instances above), not something to fold into this task's
  "seed and validate" brief.
