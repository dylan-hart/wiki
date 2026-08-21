# Decision: Translation linking — same-path-by-convention or a translation-group id?

Status: **Decided — (a) same-path-by-convention, hardened, 2026-08-21, by Dylan**
Date: 2026-08-21 (spike, OpenProject #996)
Author: Claude (deliverable of epic #990's A.6 spike; resolves `locale-architecture.md` §5.2)
Related: `docs/decisions/locale-architecture.md` (§3.A item 6); epic #990 (implemented); features #991–#995.

## 0. The verdict up front

Keep **same-path-by-convention** as the translation link — but harden its one real weakness at
the write path instead of adding a parallel identity axis. Epic #990 quietly changed this
question's ground: shared path is no longer a hope, it is an enforced, canonical, machine-read
key. A `translationGroupId` column would duplicate that key's job, need its own maintenance on
every create/move/delete, and be read by nothing that ships today — while the convention remains
**upgradeable to a group id at any time** by a one-time path-derived backfill. The upgrade only
stays lossless if translations don't drift apart, which is why the hardening (a
move-translations-together option on `movePage`) is part of the recommendation, not an aside.

## 1. What #990 already changed about this question

The original survey called the switcher's same-path navigation "re-prefixes the current path and
hopes." After the epic, the convention is materially stronger than when §5.2 was left open:

- **The tuple is real identity now.** `pages_siteId_locale_path_idx` (unique) means "the fr
  translation of `guides/x`" is a well-defined database fact, not a probe-enforced convention.
- **Reserved locale-code names + canonical URLs** killed the ambiguity classes that used to make
  path-keyed lookups unreliable (`fr/` shadow folders, `/en/page` duplicates, mis-cased prefixes).
- **Machinery already keys on shared path.** The sitemap's hreflang clusters group translations by
  path (`controllers/seo.ts`); the locale switcher composes the same path in the target locale;
  `getPage` resolves (siteId, hash, locale). None of it reads a group id; all of it would have to
  be re-pointed if a group id became the source of truth.
- **Cross-locale moves exist** (`movePage`'s locale parameter) — the write path a translations
  cascade needs is already plumbed.
- Translation discovery is a trivial, reliable query: same `(siteId, path)`, other locales.
  Staleness reporting (the process-control/controlled-documents lens) is
  `translation.updatedAt < primary.updatedAt` over that same join — no schema needed.

## 2. The options, honestly costed

### (a) Same-path-by-convention (recommended)

- **Gets for free:** discovery, hreflang clustering, switcher navigation, staleness comparison —
  all shipped and keyed on path today.
- **The one failure mode: rename drift.** `movePage` moves ONE locale's page. Renaming the `en`
  page strands the `fr` twin at the old path: the hreflang cluster silently splits, the switcher
  lands on the missing-page screen, and a later group-id backfill would mis-group. Nothing warns.
- **Mitigation (the "hardened" part):** an *include translations* option on `movePage` — when
  moving a page whose path is shared by other locales, cascade the same path change to them
  (each through the same collision checks; a 409 on any twin aborts the batch). Offered in the
  move/rename UI whenever twins exist, default on. This is a bounded follow-up feature, not a
  redesign, and it closes the only gap between the convention and a real link.

### (b) Nullable `translationGroupId` on `pages`

- **Gets:** links that survive independent renames; translations at *different* paths per locale
  (localized slugs); a stable key for per-translation workflow state if that ever exists.
- **Costs:** group maintenance on every create/cross-locale move/delete/recover; a partial unique
  index `(translationGroupId, locale) WHERE translationGroupId IS NOT NULL` (a group must not hold
  two pages in one locale); a backfill migration (derivable: group `(siteId, path)` having >1
  locale); and — the real cost — every consumer above re-pointed from path to group, plus the UI
  flows that would make a group meaningful ("translate this page", group membership display),
  none of which exist yet. It is also effectively irreversible once localized slugs diverge.
- **Decisive asymmetry:** (a) upgrades to (b) with one backfill, any time, losslessly *if drift
  has been prevented*. (b) never downgrades to (a). Choosing (a)+hardening keeps the option open
  at near-zero carrying cost; choosing (b) now buys capabilities nothing currently consumes.

## 3. Recommendation

1. **Adopt (a): shared path within a site IS the translation link.** Record it as the contract
   (this document); no schema change.
2. **File and implement the hardening feature:** `movePage` translations cascade + the move/rename
   UI offering it when twins exist. Until it lands, the drift risk is what it was pre-spike —
   known, and now written down.
3. **Revisit triggers for (b)** — re-open this record if any of these becomes real:
   - localized slugs (translations addressed at *different* paths per locale) are wanted;
   - per-translation workflow state (approval/lifecycle per translation, not per page) is wanted;
   - drift keeps occurring despite the cascade (evidence the convention can't be held in practice).
   At that point the backfill in §2(b) is the migration path, and the cascade work is not wasted —
   a group-linked world still wants group-wide renames.

## 4. Resolution of locale-architecture.md §5.2

§5.2 asked: translation-group link, or same-path-by-convention? **Answer: same-path-by-convention,
hardened per §3 — decided by Dylan, 2026-08-21.** `locale-architecture.md` §5.2 is updated in the
same commit; the hardening cascade is tracked as its own feature work package.
