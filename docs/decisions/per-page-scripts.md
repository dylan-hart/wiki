# Decision Record: Per-Page Scripts/Styles (the unused `scriptJsLoad`/`scriptJsUnload`/`scriptCss` fields)

**Date:** 2026-08-26
**Status:** Decided — executed in the same change (WP #2154/#2171/#2175)
**Author:** WP #2171 (part of #2154, Epic #1360 "Security: content injection, XSS & untrusted file
serving")
**Produces code.** This change both decides and executes.

## 0. Correcting the audit's framing before deciding anything

The audit that raised this (`docs/audit-2026-08-24/security/08-frontend-client.md` §11) describes
`write:scripts`/`write:styles` themselves as meaningless — "an operator granting `write:scripts`...
believes they have delegated something that in fact does nothing." **That is not accurate, and the
decision below would be wrong if it were true.**

There are two, independent things sharing the word "scripts" here:

1. **Three stored fields — `jsLoad`/`jsUnload`/`css` (API: `scriptJsLoad`/`scriptJsUnload`/
   `scriptCss`)** — a single `jsonb` column (`pages.scripts`) written by
   `backend/models/pages.ts`'s `buildScripts`, exposed on the API, carried by
   `frontend/src/stores/page.js`, and edited by (the now-deleted) `PageScriptsDialog.vue`. **This
   part is genuinely dead**: nothing outside this store/edit path ever reads `jsLoad`, `jsUnload`
   or `css` back out and does anything with them. `App.vue`'s injection path
   (`siteStore.theme.injectCSS`/`injectHead`/`injectBody`) is the *site* theme's own, unrelated
   injection feature, driven by entirely different state.
2. **The permission names `write:scripts`/`write:styles` themselves** — checked in FOUR places in
   `backend/models/pages.ts` (`createPage`, `updatePage`, `queueRerender`, *and* `buildScripts`),
   but only the last of those four feeds the dead fields above. The other three feed
   `WIKI.models.rendering.postProcess()`'s `RenderPermissions` (`backend/models/rendering.ts`),
   which is very much alive: it is the flag that decides whether an author's own raw `<script>`
   tags, inline event handlers, `<style>` tags and inline `style` attributes — typed directly into
   page markdown/HTML content — survive `sanitize-html` at save/render time
   (`allowVulnerableTags: permissions.scripts || permissions.styles`, and the two `allowScripts`
   sites in the same file). This is a core, currently-correct piece of *this very epic's* subject
   matter (content injection / stored XSS), not a stub.

So the real state is: **one dead feature (the three fields) sharing two permission names with one
live, load-bearing feature (content sanitization) that must not be touched.** The decision below is
scoped to the dead feature only.

## 1. The yes/no call

**Decision: delete the three fields.** Reject "implement execution" for them.

Reasoning:

- **This branch's own standing policy is unambiguous for a half-present feature.** CLAUDE.md:
  "Nothing here has to stay compatible with an existing installation... do not write migration
  shims, legacy-value fallbacks, deprecated aliases... Change the shape, change the callers, and
  delete the old path." The three fields are not a shipped, load-bearing capability with users
  depending on it — they are one stored column and a dialog with a wired-up store and API surface,
  and *zero* lines of code anywhere that ever read them back out and do anything with them. That is
  exactly what "half-built" means here, not a judgment call.
- **Implementing execution for these three fields specifically would be a bigger, riskier feature
  than the fields alone suggest**, and would additionally *conflict* with the sanitizer's existing,
  correct behavior: `write:scripts`/`write:styles` already mean "this author's raw `<script>`/
  `<style>` HTML in the page body is trusted, subject to the CSP." Wiring the SAME permission names
  to a SECOND, independent execution mechanism (injecting stored `jsLoad`/`jsUnload`/`css` on every
  page view, unconditionally of what content the page body happens to contain) would be confusing
  at best — two different things both gated by "you may use scripts on pages," doing different
  things at different times — and does not obviously need to exist now that raw inline `<script>`/
  `<style>` already works for an author who holds the permission.
- **The feature has no independent product case in front of it.** No linked Feature/Epic asks for
  a *second*, dedicated per-page-load/unload script mechanism; the fields exist because a column,
  an API surface and a dialog were built at some point and never finished, not because of a live
  user-facing requirement distinct from what raw inline `<script>`/`<style>` already covers.
- **Deleting is the lower-risk direction to be wrong in.** If a real, distinct product need for a
  page-load/unload script hook (as opposed to inline content the sanitizer already allows) shows up
  later, it is a clean, from-scratch feature addition, built with its own considered design and its
  own scoped review — not an old, already-half-wrong shape resurrected.

**Not part of this decision, and deliberately untouched:** `write:scripts`/`write:styles` as
permission names, `PAGE_PERMISSIONS`, `backend/models/rendering.ts`'s sanitizer gating, and every
one of `createPage`/`updatePage`/`queueRerender`'s three `RenderPermissions` call sites. CLAUDE.md's
"Page rule permissions" list is unchanged — both names remain real, active permissions.

## 2. What gets touched to execute this

All same-commit, per CLAUDE.md's delete-the-old-path policy (no migration shim, no deprecated
alias — this fork has no upgrade path to preserve):

- `backend/db/schema.ts` — drop the single `scripts` `jsonb` column from the `pages` table, with a
  generated migration (`npm run db-generate`, committed, never hand-edited).
- `backend/models/pages.ts` — remove `buildScripts` and its two call sites (in `create`/`update`),
  the `scriptJsLoad`/`scriptJsUnload`/`scriptCss` fields on the `Page`/`PageInput` types, and the
  `scripts` read in `toPage()`. The four `hasPermission(actor, 'write:scripts'/'write:styles', ...)`
  call sites that feed `RenderPermissions` are UNCHANGED — three survive as-is (`createPage`,
  `updatePage`, `queueRerender`); the fourth (inside `buildScripts`) goes with the method itself.
- `backend/models/pageHistory.ts` — `recoverDeletedPage` stops reconstructing
  `scriptJsLoad`/`scriptJsUnload`/`scriptCss` from a history row's `meta.scripts` (a leftover key in
  old rows' `meta` JSONB blob is harmless and never read again).
- `backend/api/schemas/page.ts` — drop `scriptJsLoad`/`scriptJsUnload`/`scriptCss` from both the
  request and response page schemas. `PAGE_PERMISSIONS` in `backend/helpers/permissions.ts` is
  UNCHANGED.
- `frontend/src/stores/page.js` — remove the three fields from state/reset/save.
- `frontend/src/components/PageScriptsDialog.vue` — delete the file (and its test), and the
  "Scripts" card section plus quick-access entry in `PagePropertiesDialog.vue` that opened it.
- Test fixtures mirroring the `Page`/`PageInput` shape (`backend/api/pages.test.ts`,
  `backend/migration/page-import.test.ts`) lose the same three fields; `PagePropertiesDialog.test.js`
  loses its "Scripts section" coverage with the section itself.
- `frontend/src/assets/icons.generated.js` — regenerated (`npm run icons`) since `la:js-square`/
  `la:css3-alt` were only ever referenced by the deleted dialog/section; `la:code` (also used by the
  removed quick-access entry) stays, since `PageHistoryOverlay.vue`/`AdminFlags.vue` still use it.
- Locale strings (`backend/locales/en.json`) — drop the now-unused
  `editor.pageScripts.title`/`editor.props.{scripts,jsLoad,jsLoadHint,jsUnload,jsUnloadHint,styles,
  stylesHint}` keys.

## 3. What is deliberately NOT touched

- `write:scripts`/`write:styles` as permission names, `PAGE_PERMISSIONS`, `backend/models/
  rendering.ts`'s sanitizer, and CLAUDE.md's permissions documentation — see §0/§1 above. These
  remain exactly as real and active as they were before this change.
- `siteStore.theme.injectCSS`/`injectHead`/`injectBody` and their execution path in `App.vue` — a
  different, already-implemented feature (site-wide theme HTML/CSS injection, gated on
  `manage:theme`/`site:theme`), unrelated beyond sharing the general "operator trusts injected
  content" shape.
- The shipped `cspDirectives` default (WP #2158) needs no change for this decision: the sanitizer
  path this leaves untouched already runs its output through the same CSP as everything else on the
  page.
