# Decision: Locale architecture — harden, demote, or re-key?

Status: **Decided — Option A (make locale structural), 2026-08-21, by Dylan**
Date: 2026-08-21 (drafted and decided)
Author: Claude (follow-up to the 2026-08-20 comprehensive review)
Related: bugs #932, #949; `docs/fable-review.md` uncertain items 1, 2, 4, 5; the end-to-end locale
survey summarized in §1–2 below.

## 0. The verdict up front

Locales are worth a redesign — **but of the enforcement layer, not the URL scheme.** The recurring
failure mode is not "the locale prefix is hard to parse"; it is that locale is a _parallel,
optional_ dimension that every query, permission check, link generator, and serializer must
independently remember — and a dozen of them forgot. A query parameter would relocate that burden,
not remove it: every one of those call sites would still have to thread `?locale=` instead of a
prefix, and the worst bugs (locale-blind folder cascades, fail-open rules, no uniqueness
constraints) live below the URL entirely.

Recommendation: **Option A (make locale structural) now**, with **Option B (locale-as-site) as the
question to answer honestly first** — because if per-site multi-locale isn't actually needed, B
deletes more code than A fixes. **Option C (query param) rejected** for reading URLs; it is already
the (half-wired) mechanism for `/_`-prefixed system routes and should stay exactly there.

## 1. What exists today (survey highlights)

The full survey is long; these are the load-bearing facts:

- **Model**: `locale` columns on `pages`, `pageHistory`, `tree`, `navigation` (nullable), plus the
  UI-strings `locales` catalogue (a separate axis — interface language vs. content locale).
  Folders are per-locale rows. Translations of "the same" page are linked **only implicitly by
  sharing a path** — there is no translation-group id anywhere; the locale switcher just
  re-prefixes the current path and hopes (`LocaleSelectorMenu.vue:95-102`, documented as
  deliberate).
- **No database enforcement.** `pages` and `tree` have **zero unique indexes**
  (`db/migrations/20260820142525_main/snapshot.json`). "Path unique within (site, locale)" is
  enforced by select-then-insert probes in four places (`models/pages.ts:588,904`;
  `models/tree.ts:898,1337`) — racy, and nothing stops direct writers. There is also no index
  supporting the hottest read (`getPage` by `(siteId, hash)` + locale).
- **Rules fail open.** `helpers/pageRules.ts:110`: a locale-scoped rule is skipped whenever the
  checked ref carries no locale — and `api/tree.ts:95-130,326-332` (folder permissions, file
  manager, reader browse) and `api/assets.ts:30-41` build exactly such refs. A DENY rule scoped to
  a locale constrains none of those surfaces.
- **Fourteen distinct sites parse or compose a locale-prefixed path string** (7 parse, 7 compose)
  instead of passing `{locale, path}` — and **four incompatible serialization conventions**
  coexist: URLs (primary bare unless `forcePrefix`), git (primary bare, always), disk (always
  prefixed), sftp (primary bare only when >1 active).
- **URL-side parsing is validated against `locales.active`** (`helpers/common.ts:268`,
  `pagePaths.js:61`) — but git's reverse-sync regex is a shape guess that also lowercases
  (`git/sync.ts:126,138`): any two-letter folder becomes a locale, and `pt-BR/` round-trips to a
  second, unreachable `pt-br` locale. Nothing reserves locale codes as folder/page names, so on a
  site with `fr` active, a genuine root folder `fr/` is unreachable (shadowed by the prefix rule).
- **The plumbing forgets locale wherever it isn't forced**: folder rename/delete/count cascades
  are locale-blind (bug #932); `getTree`'s locale filter is optional and no frontend caller sends
  it, so the file manager shows all locales merged; `movePage` has no locale parameter at all;
  `/_edit/<path>` cannot address a non-primary translation; the sitemap drops locale and emits
  duplicate unprefixed URLs with no hreflang; the app shell always renders the primary locale's
  `lang`/`dir` (an RTL translation flashes LTR); ~10 link-generation sites build `/${path}` links
  that lose the locale; breadcrumbs hardcode `locale: 'en'`; deactivating a locale silently
  orphans its content.

## 2. Diagnosis

Three separable defect classes, and they have different fixes:

| Class                                                    | Examples                                                                                                                           | Fixed by URL change? |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Data integrity** — invariant exists only by convention | no unique indexes; locale-blind cascades (#932); movePage can't change locale; deactivation orphans                                | No                   |
| **Plumbing** — locale optional, so call sites omit it    | fail-open rules; locale-less tree/asset refs; getTree unfiltered; /_edit; link generators dropping locale; sitemap; app-shell lang | No                   |
| **Parsing/serialization** — string round-trips           | #949 (unstripped path); git two-letter/lowercase; four on-disk conventions; `fr/` folder shadowing                                 | Partly               |

A URL redesign addresses at most the third class — roughly 4 of the ~20 known locale defects. The
first two classes are the expensive, data-corrupting ones, and they are indifferent to how the
locale rides the URL.

## 3. Options

### Option A — keep per-page locale, make it structural (recommended)

Keep the model (per-page locale, path-prefix URLs) and remove every place where correctness
depends on a developer remembering:

1. **Constraints**: unique indexes `pages(siteId, locale, path)` (or hash) and
   `tree(siteId, locale, folderPath, fileName)`; supporting index for the hash lookup. The racy
   probes become defense-in-depth instead of the only line.
2. **Non-optional plumbing**: `RulePageRef.locale` required (rules fail _closed_ or the caller
   must say `locale: null` explicitly and knowingly); `getTree` requires locale; every tree/nav
   cascade predicate carries `locale = folder.locale` (#932's fix); `movePage` gains a locale
   parameter (git cross-locale renames need it anyway).
3. **One parser/composer pair**: `helpers/common.ts` + `pagePaths.js` stay the mirrored canonical
   pair; the other 12 parse/compose sites are ported onto them. Storage modules pin **one**
   on-disk convention (disk's always-prefixed scheme is the unambiguous one; git can keep
   primary-bare for repo friendliness _if_ its parser validates against `locales.active` and
   preserves case).
4. **Reserved names**: creating a page/folder whose first segment equals an installed locale code
   is rejected — kills the `fr/` shadowing class permanently and cheaply.
5. **The known leak list**: /_edit threads `?locale=` (the mechanism already exists for `/_`
   routes); sitemap emits localized URLs + hreflang; app shell uses the request's resolved locale
   for `lang`/`dir` **(closed — decided 2026-08-31, see `docs/decisions/lang-dir-contract.md`: the
   client derives `<html lang>`/`dir` from the locale the URL addresses, the same resolution the
   server-side shell template already performed, instead of overwriting it from the interface
   locale post-hydration. Implemented 2026-09-06 per that document's §6 amendment, which also
   records the one case still on the interface locale: an unprefixed URL whose page is not in the
   site's primary locale)**;
   the ~10 bare-path link sites go through `localizedPagePath`; locale deactivation validates (or
   migrates) existing content.
6. Optional but worth deciding here: a **translation-group link** (nullable `translationGroupId`
   on `pages`) if real multilingual use is intended — today the switcher navigates on faith.
7. **Canonical URLs**: today `/en/page` and `/page` are duplicate URLs for the same page (the
   prefix parser accepts an explicit primary prefix, and nothing canonicalizes). Add a 302 from
   the non-canonical form to the canonical one (prefixed→bare normally; bare→prefixed under
   `forcePrefix`), so every page has exactly one URL — which is also what the sitemap/hreflang
   work (item 5) needs to emit.

URL semantics under A (site with `en` primary, `fr` active):

| URL                                 | Today                              | After A                                        |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `/page`                             | primary (en) page                  | same — unchanged                               |
| `/fr/page`                          | French translation                 | same — unchanged                               |
| `/en/page`                          | duplicate URL for the same en page | 302 → `/page`                                  |
| `/fr/…` where `fr` is a real folder | folder unreachable (shadowed)      | cannot occur — locale codes are reserved names |
| `/_edit/guides/x` on a fr page      | silently opens the en version      | carries `?locale=fr`                           |
| `/page` with `forcePrefix: true`    | 302 → `/en/page`                   | same — stays an opt-in                         |

Effort: an epic of roughly 10–14 tasks, several already filed (#932, #949) or listed in
`fable-review.md`. No migration-compat concerns per CLAUDE.md's own charter. Preserves the
"native per-page locale" feature 3.0 advertises over 2.5.x.

### Option B — demote locale to the site level ("locale-as-site")

Delete in-site content locales entirely: one content tree per site, and a locale is just another
hostname-routed site (`de.wiki.example.com`), with the existing (well-tested, e2e-covered)
multi-site machinery doing all the isolation. UI language stays per-user as today.

- **What it deletes**: the locale columns and their cascades, the rule locale axis, all 14
  parse/compose sites, all four serialization conventions, the switcher ambiguity — essentially
  the entire defect surface of §2, structurally.
- **What it costs**: per-locale asset duplication (assets are site-scoped); the locale switcher
  becomes cross-site navigation and needs an explicit translation mapping to land on the right
  page (though note: today's implicit same-path link is barely stronger); per-locale groups/rules
  must be granted per site (arguably a feature); mixed-locale trees within one site become
  impossible.
- **When it wins**: if the honest answer to "will any single site here ever run more than one
  content locale?" is no or "one, maybe, someday". The default config is `active: ['en']`; both
  the homelab and the process-control-department lenses are effectively single-locale with at
  most a second full-tree translation — which is exactly the shape locale-as-site models well and
  the current design models expensively.

### Option C — query parameter (`/some/page?locale=fr`) — rejected for reading URLs

Considered because Dylan raised it, and it _would_ dissolve the prefix-parsing ambiguity (no
segment stripping, no `fr/` folder shadowing, `/_edit` gets easier). But:

- It fixes only the parsing class (§2) — cascades, rules, uniqueness, serialization are untouched.
- It doesn't reduce the N-call-sites problem: every link generator that today forgets the prefix
  would instead forget the param — the same 10 sites currently emitting bare `/${path}` links
  would emit bare links still.
- It weakens URL identity for the one artifact a wiki exists to produce: a locale-qualified page
  is a distinct document with a distinct canonical URL (sitemap, hreflang, sharing, caching all
  key off it). Locale is part of content identity in this data model (path uniqueness is _per
  locale_); moving identity into view-state-shaped syntax fights the model rather than fixing it.
- The storage/git serialization question doesn't go away — files on disk still need a locale
  encoding, so the parse/compose count barely drops.

Where a query param _is_ right — `/_`-prefixed system routes (`/_edit`, `/_create`, `/_search`) —
`resolveRouteLocale` already reads `?locale=`; the bug is that nothing sets it. Keep that design,
finish wiring it (part of Option A, item 5).

### Option D — always-prefix (`forcePrefix` mandatory when >1 locale) — fold into A, don't pursue alone

Making every locale explicit in the URL (or a reserved sentinel like `/l/fr/…`) removes the
"primary is bare" special case and some ambiguity, at the cost of uglier URLs and a redirect tax.
Not worth it as a standalone move; A item 4 (reserved names) buys the same safety cheaper. Worth
revisiting only if hreflang/SEO work later wants fully canonical per-locale URLs.

## 4. What I'd do

1. **Answer the Option B question first** — one sentence, no code: _will one site ever need
   multiple content locales here?_ If no → B is the better redesign and most of A's work
   evaporates; the migration importer's 2.x locale-namespace → site mapping is actually cleaner
   than its current mapping.
2. If per-site multi-locale stays → **run Option A as an epic**, sequenced: constraints (A.1) and
   cascade fixes (#932) first — they stop data corruption; then plumbing (A.2, A.5); then
   serialization unification (A.3–A.4).
3. Either way, **don't file the ~10 additional locale defects the survey surfaced as individual
   bugs yet** (sitemap locale drop, app-shell lang/dir, /_edit, bare-path link sites, breadcrumb
   hardcoding, FileManager's mislabeled locale button, PageHeader's `locale === 'en'` welcome
   gate, pt-BR case round-trip, deactivation orphans, mail.ts's false "no locale segment"
   comment) — under Option B most are moot, and under Option A they are the epic's task list.
   They are recorded here so they aren't lost.

## 5. Open questions — resolution status

1. Will any single site here realistically run more than one content locale? — **Answered yes
   (Dylan, 2026-08-21), which selects Option A** and rules out B.
2. Is a translation-group link wanted (real multilingual), or is same-path-by-convention
   acceptable? — **Resolved (spike #996, decided by Dylan 2026-08-21): same-path-by-convention,
   hardened by a movePage "include translations" cascade.** Full record and revisit triggers:
   `docs/decisions/locale-translation-linking.md`.
3. Git on-disk convention — primary-bare with strict active-locale, case-preserving validation, or
   disk's always-prefixed scheme? — **Resolved (this epic, A.3): primary-bare kept for git and
   sftp** (`content.ts`'s `localeNamespace`, `sftp/pages.ts`'s `remotePathForPage` — they already
   agree); the parser now validates against `locales.active`, case-preserving, which was the
   actual ambiguity. **Disk stays always-prefixed** (`disk/storage.ts` `dump`/`importAll`) — it is
   a backup format that round-trips only with itself and the unambiguous scheme is right there;
   divergence documented in each module's header comment.
4. Locale codes as globally reserved top-level names? — **Yes, adopted as part of A** (item 4).
