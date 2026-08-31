import type { GroupRule, GroupRuleMatch, GroupRuleMode } from '../models/groups.ts'

/**
 * How a page rule is matched against a page, and which rule wins when several match.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RULES OF PAGE PERMISSIONS
 * ---------------------------------------------------------------------------------------------
 *
 * A group grants page permissions through rules, never as a blanket. Every rule names a set of
 * permissions (`roles`), a way of addressing pages (`match` + `path`), and what it does with them
 * (`mode`). A user's rules are all of their groups' rules pooled together — belonging to a second
 * group can therefore both widen and narrow what the first one said.
 *
 * **Nothing is granted by default.** A permission nobody wrote a rule for is denied: no rules at all
 * is the same as one DENY rule covering the whole site. This is why an empty group can read nothing.
 *
 * When more than one rule names the permission being asked about and matches the page, exactly one
 * of them decides the answer — the most specific. Order in the array means nothing.
 *
 *   1. SPECIFICITY, highest first. A rule addressing `geography/countries` beats one addressing
 *      `geography`, because it says something about a smaller part of the site. Measured as the
 *      length of the path the rule addresses, so the deeper of two paths always wins, and a rule for
 *      the whole site (empty path) is the least specific thing there is. Tag rules address no path
 *      at all and are therefore never more specific than a path rule.
 *
 *   2. MATCH TYPE, when two rules are equally specific. From weakest to strongest:
 *
 *        Has Any Tag  <  Has All Tags  <  Path Starts With  <  Path Ends With  <
 *        Path Matches Regex  <  Path Is Exactly
 *
 *      The order runs from the vaguest way of naming pages to the most precise: a tag is a property
 *      a page happens to have, a prefix is a whole branch of the tree, and an exact path is one page
 *      and nothing else.
 *
 *   3. MODE, when two rules are equally specific and of the same kind:
 *
 *        ALLOW  <  DENY  <  FORCE ALLOW
 *
 *      An ALLOW grants the permission. A DENY overrides any ALLOW. A FORCE ALLOW overrides any DENY,
 *      which is what makes a hole in an otherwise closed branch possible.
 *
 * The three are applied in that order: mode only settles a tie between rules of the same kind at the
 * same specificity, so a DENY on `geography` does NOT override an ALLOW on `geography/countries` —
 * the deeper rule was more specific and had already won.
 *
 * A rule may also be scoped to particular **locales** and/or particular **sites** — an empty list on
 * either means every one of them. Both are match filters, applied before any of the ranking above: a
 * rule whose locales or sites don't include the page's simply does not match, exactly as if its path
 * or tags didn't either. Neither one is a specificity axis, so a rule scoped to one locale or one
 * site is not thereby more specific than an unscoped rule addressing the same path.
 *
 * Locale and site scoping fail CLOSED, not open: a ref that genuinely has no locale (or site)
 * context must say so explicitly (`locale: null` / `siteId: null` on `RulePageRef`), and a
 * locale-scoped (site-scoped) rule then does NOT match that ref, the same as if it named a
 * different locale/site outright. A caller with no known locale/site is not exempt from scoping —
 * it is scoped out. Locale comparison is case-insensitive.
 *
 * ---------------------------------------------------------------------------------------------
 * CLASSIFICATION (OpenProject #1079)
 * ---------------------------------------------------------------------------------------------
 *
 * A `CLASSIFICATION` rule addresses page metadata rather than a page's address: it matches when the
 * page's `classification` is one of the level ids listed in the rule's `classifications`. It gains a
 * fourth tier above the three already described, evaluated FIRST rather than folded into
 * specificity: **any matching CLASSIFICATION rule outranks every path/tag rule, regardless of how
 * specific the path rule is.** A classification-based DENY therefore overrides a path/tag ALLOW no
 * matter how deep the path rule addresses — a stronger guarantee than the ordinary most-specific-wins
 * rule between two path/tag rules, which is exactly the point: classification survives a page
 * move/rename, and a rule written against it should not lose to one written against wherever the
 * page happens to live today. Two CLASSIFICATION rules matching the same page still break their own
 * tie by MODE (tier 3 below) — there is no path/match-type axis within this tier to break it first.
 *
 * Like locale/site scoping, this fails CLOSED: a ref with no known classification (`classification:
 * null` on `RulePageRef` — a page that does not exist yet, most commonly) matches no CLASSIFICATION
 * rule at all, the same as if the page held a level the rule doesn't name.
 *
 * ---------------------------------------------------------------------------------------------
 *
 * `manage:system` is not evaluated here: it bypasses this entirely, and does so before any rule is
 * read. See `models/groups.ts`.
 */

/** A page as a rule sees it. `locale`, `siteId` and `path` place it; `tags` are what tag rules match on.
 *
 * `locale`, `siteId` and `classification` are REQUIRED: a caller that genuinely has no locale (or
 * site, or classification) context says `null` explicitly — and a locale-scoped (site-scoped,
 * CLASSIFICATION-matched) rule then does not match, i.e. the rules fail CLOSED. The old optional
 * fields let a dozen call sites silently skip locale scoping. `classification` is a page that does
 * not exist yet's genuine answer (a create-permission check, before any classification has been
 * computed for it) as much as it is a caller that forgot to fetch one — both fail closed the same
 * way. */
export interface RulePageRef {
  path: string
  locale: string | null
  siteId: string | null
  /** Classification level id (OpenProject #1079), or null when genuinely unknown/not-yet-decided. */
  classification: string | null
  tags?: string[]
}

/**
 * Match kinds from weakest to strongest, used to break a tie between equally specific rules. The
 * index IS the priority, so the order of this array is the order documented above.
 */
// -> CLASSIFICATION never reaches this tie-break in practice (it never ties on specificity with a
//    path/tag rule -- see the tier in `resolvePageRule`), but is listed for completeness of the
//    closed `GroupRuleMatch` union.
const MATCH_PRIORITY: GroupRuleMatch[] = [
  'TAG',
  'TAGALL',
  'START',
  'END',
  'REGEX',
  'EXACT',
  'CLASSIFICATION'
]

/**
 * Modes from weakest to strongest, used to break a tie between rules of the same kind. Exported so
 * `helpers/siteRules.ts` can apply the identical ordering to site-admin rules, which have no
 * specificity/match-type tier of their own to break a tie first.
 */
export const MODE_PRIORITY: GroupRuleMode[] = ['ALLOW', 'DENY', 'FORCEALLOW']

/** Tags are written on a rule as a comma-separated list, in the field a path would otherwise use. */
function ruleTags(rule: GroupRule): string[] {
  return rule.path
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
}

/** Compared without leading slashes on either side, since neither is stored with one. */
function normalizePath(value: string): string {
  return value.replace(/^\/+/, '')
}

/**
 * How much of the site a rule is talking about, as a number where higher is narrower.
 *
 * The length of the path it addresses. A tag rule addresses no path, so it scores zero and can never
 * out-specify a rule that names one — matching the ordering above, where tags are the vaguest way of
 * naming a page.
 */
function specificityOf(rule: GroupRule): number {
  if (rule.match === 'TAG' || rule.match === 'TAGALL' || rule.match === 'CLASSIFICATION') {
    return 0
  }
  return normalizePath(rule.path).length
}

/** Whether a rule addresses this page at all, ignoring what it then says about it. */
export function ruleMatchesPage(rule: GroupRule, page: RulePageRef): boolean {
  // -> A rule may be limited to particular locales; an empty list means every one of them. A ref
  //    with an unknown locale (`null`) fails closed: the rule does not match. Case-insensitive,
  //    matching how URL parsing recognizes locale codes (`stripLocalePrefix`).
  if (rule.locales?.length > 0) {
    const refLocale = page.locale?.toLowerCase()
    if (!refLocale || !rule.locales.some((code) => code.toLowerCase() === refLocale)) {
      return false
    }
  }

  // -> Same fail-closed treatment for sites
  if (rule.sites?.length > 0 && (!page.siteId || !rule.sites.includes(page.siteId))) {
    return false
  }

  // -> CLASSIFICATION reads none of path/tags below -- it matches page metadata, not the page's
  //    address. Same fail-closed treatment: an unknown classification matches nothing.
  if (rule.match === 'CLASSIFICATION') {
    return (
      Boolean(page.classification) && (rule.classifications ?? []).includes(page.classification!)
    )
  }

  const pagePath = normalizePath(page.path)
  const rulePath = normalizePath(rule.path)
  const pageTags = (page.tags ?? []).map((tag) => tag.toLowerCase())

  switch (rule.match) {
    case 'START':
      return pagePath.startsWith(rulePath)
    case 'EXACT':
      return pagePath === rulePath
    case 'END':
      return pagePath.endsWith(rulePath)
    case 'REGEX':
      try {
        return new RegExp(rulePath).test(pagePath)
      } catch {
        // -> A rule that cannot compile addresses nothing, rather than everything
        return false
      }
    case 'TAG':
      return ruleTags(rule).some((tag) => pageTags.includes(tag))
    case 'TAGALL': {
      const tags = ruleTags(rule)
      return tags.length > 0 && tags.every((tag) => pageTags.includes(tag))
    }
    default:
      return false
  }
}

/**
 * The rule that decides a permission for a page, out of everything the caller's groups say.
 *
 * @param rules Every rule from every group the caller belongs to, pooled
 * @param permission The single permission being asked about, e.g. `read:pages`
 * @returns The deciding rule, or null when nothing addresses this — which means denied
 */
export function resolvePageRule(
  rules: GroupRule[],
  permission: string,
  page: RulePageRef
): GroupRule | null {
  let winner: GroupRule | null = null
  let winnerRank: [number, number, number, number] = [-1, -1, -1, -1]

  for (const rule of rules) {
    if (!rule.roles?.includes(permission) || !ruleMatchesPage(rule, page)) {
      continue
    }
    // -> CLASSIFICATION gets its own tier, evaluated before specificity rather than folded into it
    //    (tier 0 for every path/tag rule, tier 1 for a matching CLASSIFICATION rule) -- see the
    //    module doc comment's CLASSIFICATION section for why this outranks path specificity
    //    unconditionally rather than merely tying for it.
    const rank: [number, number, number, number] = [
      rule.match === 'CLASSIFICATION' ? 1 : 0,
      specificityOf(rule),
      MATCH_PRIORITY.indexOf(rule.match),
      MODE_PRIORITY.indexOf(rule.mode)
    ]
    // -> Strictly greater, so the first rule of an otherwise identical pair wins and the outcome
    //    does not depend on the order they happen to arrive in
    if (
      rank[0] > winnerRank[0] ||
      (rank[0] === winnerRank[0] &&
        (rank[1] > winnerRank[1] ||
          (rank[1] === winnerRank[1] &&
            (rank[2] > winnerRank[2] || (rank[2] === winnerRank[2] && rank[3] > winnerRank[3])))))
    ) {
      winner = rule
      winnerRank = rank
    }
  }

  return winner
}

/**
 * Whether the caller's rules grant a permission on a page.
 *
 * @returns False when no rule addresses it, which is the default for everything.
 */
export function rulesAllow(rules: GroupRule[], permission: string, page: RulePageRef): boolean {
  const rule = resolvePageRule(rules, permission, page)
  return rule ? rule.mode !== 'DENY' : false
}

/**
 * ---------------------------------------------------------------------------------------------
 * SQL-NARROWING (OpenProject #1872)
 * ---------------------------------------------------------------------------------------------
 *
 * `listAllForGraph` (`models/pages.ts`) used to fetch every page on a site and let
 * `assembleGraph`'s `canRead` predicate (`rulesAllow`/`mayOnPage`, exact and unchanged) discard
 * what the caller may not read -- so a low-privilege reader on a large site paid exactly what an
 * admin does. `deriveReadScope` computes a cheap, SQL-pushable *necessary* condition for
 * `canRead(page)` to hold: "does some non-DENY rule for this permission even address this page at
 * all". A page failing this can never be granted (there is nothing left for `resolvePageRule` to
 * pick as a winner), so excluding it from the fetch is always safe. A page passing it might still
 * be denied by a more specific rule once `resolvePageRule` actually runs -- this is a superset,
 * not the answer -- which is why the exact JS resolution still runs, unchanged, over whatever rows
 * come back.
 *
 * DENY rules contribute nothing here: they only ever remove a page from what a more specific ALLOW
 * already granted, never add one, so a page matched by nothing but DENY rules was already going to
 * read false and needs no clause of its own.
 *
 * Not every rule can be pushed into SQL without risk. TAG/TAGALL matching lower-cases both sides
 * before comparing (see `ruleTags`/`ruleMatchesPage` above); reproducing that fold as SQL would
 * mean maintaining two descriptions of the same case-insensitive comparison that could quietly
 * drift apart, so both fall back to "matches anything" instead. REGEX is worse: Postgres's `~`
 * operator is POSIX, not the `RegExp` this file actually evaluates against, so a pattern that
 * compiles under both can still match different strings. Both cases -- and a START/END rule whose
 * path is empty, which already matches every path in JS (`''.startsWith`/`endsWith` are always
 * true) -- collapse the WHOLE scope to `'all'` rather than just skipping their own clause: once one
 * rule can match anywhere, no `WHERE` can safely exclude any row, so there is nothing left to gain
 * by describing the other rules at all.
 */

/** One necessary condition for `canRead` — every page passing this clause is a *candidate*; pages
 *  failing every clause across every rule can be excluded before the fetch. `locales` mirrors the
 *  rule's own scoping (empty = every locale). */
export type ReadScopeClause =
  | { kind: 'exact'; path: string; locales: string[] }
  | { kind: 'prefix'; path: string; locales: string[] }
  | { kind: 'suffix'; path: string; locales: string[] }
  | { kind: 'classification'; ids: string[]; locales: string[] }
  /** A rule that cannot be reduced to anything narrower than its own locale scope (REGEX,
   *  TAG/TAGALL) — see the module doc comment above for why. */
  | { kind: 'localeOnly'; locales: string[] }

export type ReadScope =
  /** No non-DENY rule addresses this permission at all — nothing on the site can ever be granted. */
  | { kind: 'none' }
  /** At least one rule could match anywhere — no `WHERE` can safely narrow this; fetch everything,
   *  exactly as before this optimization existed. */
  | { kind: 'all' }
  /** The OR of every clause below is a safe superset of what `canRead` would actually grant. */
  | { kind: 'clauses'; clauses: ReadScopeClause[] }

/**
 * Reduce an actor's pooled rules to a `ReadScope` for one permission on one site — see the module
 * doc comment above for the safety argument and what does/doesn't get pushed into SQL.
 */
export function deriveReadScope(rules: GroupRule[], siteId: string, permission: string): ReadScope {
  const clauses: ReadScopeClause[] = []

  for (const rule of rules) {
    if (rule.mode === 'DENY' || !rule.roles?.includes(permission)) {
      continue
    }
    // -> A rule scoped to other sites can never match a row from THIS site's query at all --
    //    `listAllForGraph` already filters by siteId, so this rule contributes nothing here.
    if (rule.sites?.length > 0 && !rule.sites.includes(siteId)) {
      continue
    }

    const locales = rule.locales ?? []

    switch (rule.match) {
      case 'EXACT':
        clauses.push({ kind: 'exact', path: normalizePath(rule.path), locales })
        break
      case 'START':
      case 'END': {
        const path = normalizePath(rule.path)
        if (path === '') {
          // -> An empty START/END path matches every page in JS -- see the module doc comment.
          if (locales.length === 0) {
            return { kind: 'all' }
          }
          clauses.push({ kind: 'localeOnly', locales })
        } else {
          clauses.push({ kind: rule.match === 'START' ? 'prefix' : 'suffix', path, locales })
        }
        break
      }
      case 'CLASSIFICATION': {
        const ids = rule.classifications ?? []
        if (ids.length === 0) {
          // -> Matches no page at all (same as `ruleMatchesPage`'s own empty-list case) -- no
          //    clause needed.
          continue
        }
        clauses.push({ kind: 'classification', ids, locales })
        break
      }
      // -> TAG/TAGALL and REGEX: not safely reducible -- see the module doc comment.
      default:
        if (locales.length === 0) {
          return { kind: 'all' }
        }
        clauses.push({ kind: 'localeOnly', locales })
    }
  }

  if (clauses.length === 0) {
    return { kind: 'none' }
  }
  return { kind: 'clauses', clauses }
}
