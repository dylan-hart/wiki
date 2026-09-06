# Decision: the `<html lang>`/`dir` contract — content locale or interface locale?

Status: **Decided — content locale (`pageStore.locale`) drives `<html lang>`/`dir`; the interface
locale (`commonStore.locale`) stays a separate axis, 2026-08-31**
Date: 2026-08-31
Author: Claude (OpenProject #1656, child of #1655)
Related: #1655 ("Resolve `<html lang>`/`dir` from the page's content locale, not the interface
locale"), #1660 (implements this in `App.vue#applyLocale`), #1662 (`e2e/tests/rtl.spec.js`
coverage); `docs/decisions/locale-architecture.md` §3.A item 5 ("the known leak list"); the
Feature 413 note in `docs/variances.md` ("Admin chrome direction: mirrors with the rest of the
app"); the 2026-08-24 audit, `docs/audit-2026-08-24/accessibility-i18n.md` §1.

## 0. The verdict up front

**`document.documentElement.lang` and `dir` follow the page's content locale
(`pageStore.locale`), not the reader's interface locale (`commonStore.locale`).** On `/_`-prefixed
routes, where there is no page to derive a content locale from, they fall back to
`siteStore.locales.primary` — exactly the resolution `backend/helpers/appShell.ts`'s
`resolveAppShellLocale` already performs server-side. The interface locale keeps driving
`i18n.locale.value` (UI strings) and nothing else. This is contract **(a)** as posed in #1656's
description; the alternative, **(b)** — leaving `<html>` on the UI locale and moving `lang`/`dir`
onto the `.page-contents` container instead — is rejected. Reasoning in §2.

This closes the actual defect #1655 exists to fix: the server stamps the shell with the
**content** locale's `lang`/`dir` to prevent an RTL-translation FOUC, then the client's
`App.vue#applyLocale` overwrites both with the **interface** locale the instant it runs. The two
control points were never deciding the same question — one had it right, and the other now
matches it instead of a third, hybrid option being invented.

## 1. Why this was ambiguous, briefly

`docs/variances.md`'s Feature 413 note ("Admin chrome direction") recorded, in 2026-08-23, that
the app has "exactly one document-wide direction control point (`App.vue#applyLocale`,
`composables/direction.js`) and one `commonStore.locale`" — true of the client in isolation at
the time, but never true of the whole system: `backend/helpers/appShell.ts:44` had already stamped
the pre-hydration shell from the _content_ locale before that note was written, and
`resolveAppShellLocale` (`appShell.ts:63-64`) explicitly resolves from the URL path, not from any
UI-language setting. The variance recorded a real decision about admin-chrome direction (whether
the admin area should mirror the active locale rather than force LTR — see §3) using a premise
(the client's own single-axis-for-everything read) that the backend contradicted from day one.
That contradiction is what #1655 identifies as the actual bug: a reader whose interface is English
opening `/ar/guide` gets `<html lang="ar" dir="rtl">` from the server, then `lang="en" dir="ltr"`
after hydration — Arabic prose renders LTR permanently, and every logical property in
`_page-contents.scss` resolves backwards.

## 2. The two contracts, costed

### (a) `<html lang>`/`dir` follow content locale (chosen)

- **Matches the server exactly.** `App.vue`'s post-hydration write becomes a no-op correction of
  an already-correct value instead of an overwrite — no more first-paint-correct,
  post-hydration-wrong flash on any RTL page regardless of which interface language the reader has
  chosen.
- **Matches how the rest of the app already talks about these two axes.**
  `components/LocaleSelectorMenu.vue:73-76`'s own header comment states the locale switcher
  "Switches the CONTENT locale being read -- the interface language (`commonStore.locale` /
  vue-i18n) is a separate concern this menu does not touch." `<html lang>`/`dir` describing the
  _document_ — i.e. the content — is the same axis that comment is already drawing a line around.
- **`lang` is not just a direction switch.** Even on an LTR-to-LTR translation (French content
  under an English UI), announcing the document as `lang="en"` is wrong for a screen reader's
  pronunciation regardless of `dir`. Contract (a) fixes this case too; (b) would need a second,
  separate mechanism for it if `<html lang>` stayed pinned to the UI locale.
- **One control point, correctly scoped.** `composables/direction.js`'s existing design (a single
  reactive mirror of the `dir` attribute, written by one function on every navigation) needs no
  restructuring — only what feeds it changes, from `commonStore.locale` to `pageStore.locale` with
  the `/_`-route primary-locale fallback `resolveAppShellLocale` already uses. `_page-contents.scss`
  and every other logical-property consumer keeps resolving off the same, single `dir` on `<html>`
  they always have.
- **Cost:** `App.vue#applyLocale` needs re-running from a `pageStore.locale` watcher, not just
  `commonStore.locale`'s (#1660's scope) — a small, well-contained change to one function's inputs.

### (b) `<html>` stays on interface locale; content `lang`/`dir` move to `.page-contents`

- **Would require a second control point**, not a reuse of the existing one:
  `pages/Index.vue:152`'s `.page-contents` container currently carries neither attribute, so this
  adds a _second_ place direction has to be computed and kept in sync with page navigation,
  alongside whatever (if anything) still reads `<html dir>` for chrome-level RTL mirroring — the
  admin sidebar, toolbars, and every `WMenu`/`WTooltip` anchor pair in `helpers/directionalAnchor.js`
  that reads `document.documentElement.dir` today would need to keep doing so for _chrome_ while a
  _second_ signal drives content, doubling the surface `docs/decisions/locale-architecture.md`
  already flags as leaking (§3.A item 5).
- **`_page-contents.scss`'s logical properties already resolve off the nearest `dir`** — which
  today is `<html>`'s, since nothing closer sets one. Under (b) they'd resolve correctly for
  content but the _document_ itself (`<html>`) would still misdescribe an RTL page as `dir="ltr"`
  to anything above `.page-contents` that isn't scoped to it: browser chrome, the page's own
  `<title>`/reading-order defaults for assistive tech that inspects the document root rather than
  the specific container, `window.print()` layout, and any future component that isn't
  `.page-contents`-scoped.
- **Contradicts the server half unnecessarily.** The backend has stamped `<html lang>`/`dir` from
  content locale since before this decision was ever ambiguous; (b) would mean deliberately
  re-diverging server and client after having just found the divergence and named it a bug.
- **Genuinely defensible only if chrome and content are meant to disagree** — e.g. a reader whose
  UI is pinned English while browsing exclusively RTL content, who specifically wants the toolbar
  chrome mirroring to stay off. Nothing in this codebase's UX asks for that today, and the admin
  chrome variance (§3) already decided the opposite for the one surface where the question came
  up.

## 3. What this does _not_ reopen

The Feature 413 "Admin chrome direction: mirrors with the rest of the app" decision in
`docs/variances.md` stands — admin chrome should still mirror the active document direction rather
than force LTR. Only its stated justification changes: it is no longer "there is only one
direction control point and one locale," it is "the document's direction is the content locale's
direction, and admin chrome inherits `dir` off `<html>` like everything else that isn't
`.page-contents`-scoped" — which is the same conclusion contract (a) reaches, not a different one.
See `docs/variances.md`'s Feature 413 section for the updated wording.

## 4. Resolution of `locale-architecture.md` §3.A item 5

Item 5's "known leak list" named "app shell uses the request's resolved locale for lang/dir" as an
open leak with only its server half landed. That leak is now closed by decision: the client half
adopts the same resolution the server already performs (content locale, `siteStore.locales.primary`
fallback on `/_` routes), recorded here and implemented in #1660. `locale-architecture.md` is
updated in the same commit to point at this document instead of describing the leak as still open.

## 5. What #1660 and #1662 inherit from this decision

- `App.vue#applyLocale` splits into two independently-triggered effects: `i18n.locale.value` (and
  the locale-strings fetch) stays keyed on `commonStore.locale`'s watcher; `direction.set()` and
  `document.documentElement.setAttribute('lang', …)` move to a `pageStore.locale` watcher, falling
  back to `siteStore.locales.primary` when there is no current page (i.e. on `/_`-prefixed routes)
  — the same condition `resolveAppShellLocale` branches on.
- A unit test should assert `document.documentElement.lang`/`dir` follow `pageStore.locale` across
  a route change independent of `commonStore.locale`, per #1655's own scope note.
- `e2e/tests/rtl.spec.js` gets the end-to-end case: an English-interface reader opening a seeded
  RTL page should see `dir="rtl"` survive past hydration, not flash back to `ltr`.

## 6. Amendment, 2026-09-06 (OpenProject #2596): the URL's locale segment, with an interface-locale fallback

§0's verdict stands in substance — the document's direction is the direction of the locale being
_addressed_, not of the reader's chrome — but the input named there (`pageStore.locale`, with
`siteStore.locales.primary` on `/_` routes) is not what `App.vue` resolves it from. Two things came
out of #2596 that this section records:

1. **What was actually shipped for #1660 is not in the tree.** That WP's own comment describes an
   `applyContentLocale()` driven by a `pageStore.locale` watcher, closed as landed in PR #26 — but
   no such function has ever existed in `App.vue` at any commit (`git log -S applyContentLocale`
   finds the identifier only in a squash commit's message and in two doc comments that were written
   against it). The client half of §4's "closed leak" was therefore still open: `applyLocale` went
   on deriving both attributes from `commonStore.locale`, exactly as §0 describes the bug.
2. **The resolution implemented instead is the URL's own leading locale segment, falling back to the
   interface locale** — `App.vue#applyDocumentLocale`, off
   `parseLocalePrefix(to.path, siteStore.locales.active…)`, written synchronously by the router
   guard on every navigation. On a locale-prefixed URL this agrees exactly with
   `resolveAppShellLocale`'s own answer, which is what §2(a) actually asks for — the server-stamped
   shell is confirmed rather than overwritten.

Where this differs from §5, and why:

- **It fires for a destination with no page behind it.** #2596's defect: with the reader-facing
  switcher navigating rather than setting the interface locale
  (`LocaleSelectorMenu.vue#switchLocale`), picking an RTL locale on a path that has no page pushed
  `/ar/<path>` and left the document LTR. A `pageStore.locale` watcher does not close that on its
  own — the guard resolves that store field for a 404 destination too, but nothing was reading it
  for `dir`. Deriving from the URL means "which translation is being addressed" is answered by the
  only thing that exists on a 404: the URL. A not-found screen under an RTL prefix reads
  right-to-left, which is the product decision #2596 resolved.
- **A `/_` route keeps following the interface locale rather than the site's primary.** §5 would
  have the admin area and the editors render LTR chrome for an operator who has deliberately picked
  an RTL interface language from `AdminLayout.vue`'s own switcher — a regression against the
  Feature 413 "Admin chrome direction" decision in `docs/variances.md` and against
  `e2e/tests/rtl.spec.js`'s own assertion that `/_admin/dashboard` and `/_create/markdown` stay
  `dir="rtl"`. There is no content locale on those routes to speak for, so the reader's own is the
  better answer, not merely the compatible one.
- **An unrecognised leading segment changes nothing.** `parseLocalePrefix` matches only against
  `siteStore.locales.active`, so `/xx/some/page` cannot set `dir`/`lang` to a locale the site does
  not have; it falls through to the interface locale.

Still open, and NOT covered by this amendment: an unprefixed URL whose page's own content locale is
not the interface locale (primary-locale content read under a non-primary interface, or a site with
`forcePrefix` off). `lang` there still reports the interface locale. Closing that needs the page's
own locale to feed `applyDocumentLocale()` once a page has loaded — a `pageStore.locale` watcher
after all, but as an addition to the URL resolution rather than a replacement for it.
