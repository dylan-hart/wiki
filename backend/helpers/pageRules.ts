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
 * of them decides the answer. Order in the array means nothing.
 *
 *   1. BAND, highest first. Which *kind* of thing the rule addresses matters before how much of it
 *      does:
 *
 *        Path Starts With / Path Ends With / Path Matches Regex  <  Has Any Tag / Has All Tags  <
 *        Path Is Exactly
 *
 *      A tag rule now outranks every path-shaped rule (START/END/REGEX) regardless of how deep the
 *      path rule's path is — a page's tags describe what it IS, which is judged a stronger claim than
 *      a rule about where it currently happens to live in the tree. An EXACT rule still outranks a
 *      tag rule: naming one page precisely is stronger than naming a property several pages might
 *      share. CLASSIFICATION sits in its own band above all of these — see the section below.
 *
 *   2. SPECIFICITY, when two rules share a band. A rule addressing `geography/countries` beats one
 *      addressing `geography`, because it says something about a smaller part of the site. Measured
 *      as the length of the path the rule addresses, so the deeper of two paths always wins, and a
 *      rule for the whole site (empty path) is the least specific thing there is. This only ever
 *      breaks a tie WITHIN the path-shaped band (START vs START, START vs END, …) — tag rules and
 *      CLASSIFICATION rules always score zero specificity, since band already places them relative
 *      to everything else.
 *
 *   3. MATCH TYPE, when two rules share a band and are equally specific — e.g. two rules addressing
 *      the same path, or TAG vs TAGALL naming the same tags. Weakest to strongest within a band:
 *      START < END < REGEX (path-shaped), TAG < TAGALL (tag-shaped).
 *
 *   4. MODE, when two rules are otherwise fully tied:
 *
 *        ALLOW  <  DENY  <  FORCE ALLOW
 *
 *      An ALLOW grants the permission. A DENY overrides any ALLOW. A FORCE ALLOW overrides any DENY,
 *      which is what makes a hole in an otherwise closed branch possible.
 *
 * The four are applied in that order: mode only settles a tie between rules of the same band, same
 * specificity and same match type, so a DENY on `geography` does NOT override an ALLOW on
 * `geography/countries` — the deeper rule was more specific within the same band and had already won.
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
 * page's `classification` is one of the level ids listed in the rule's `classifications`. It occupies
 * its own band at the very top, above path-shaped rules, tag rules AND `EXACT`: **any matching
 * CLASSIFICATION rule outranks every path/tag rule, regardless of how specific the path rule is.** A
 * classification-based DENY therefore overrides a path/tag ALLOW no matter how deep the path rule
 * addresses — a stronger guarantee than the ordinary band-then-specificity ordering between two
 * path/tag rules, which is exactly the point: classification survives a page move/rename, and a rule
 * written against it should not lose to one written against wherever the page happens to live today.
 * Two CLASSIFICATION rules matching the same page still break their own tie by MODE (tier 4 above) —
 * there is no specificity/match-type axis within this band to break it first (both always score zero
 * specificity, and CLASSIFICATION is the only match kind in its own band).
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
 * Which band a match kind sits in, weakest first — checked BEFORE specificity in `rankOf`, so a tag
 * rule (TAG/TAGALL) now beats any path-shaped rule (START/END/REGEX) no matter how deep the path
 * rule's path is, and an EXACT rule beats any tag rule no matter how many tags it names.
 * CLASSIFICATION keeps its own standalone top band, unconditionally above everything else — see the
 * module doc comment's CLASSIFICATION section for why.
 *
 *   Path Starts With / Path Ends With / Path Matches Regex  (band 0)
 *     <  Has Any Tag / Has All Tags                          (band 1)
 *     <  Path Is Exactly                                      (band 2)
 *     <  Classification                                       (band 3)
 *
 * A `Record<GroupRuleMatch, number>` rather than a bare mapping, so TypeScript's excess/missing
 * property check keeps this pinned to the full `GroupRuleMatch` union the same way
 * `models/groups.ts`'s `GROUP_RULE_MATCH_MEMBERS` pins `GROUP_RULE_MATCH_VALUES`.
 */
const MATCH_BAND: Record<GroupRuleMatch, number> = {
  START: 0,
  END: 0,
  REGEX: 0,
  TAG: 1,
  TAGALL: 1,
  EXACT: 2,
  CLASSIFICATION: 3
}

/**
 * Match kinds from weakest to strongest WITHIN a band (see `MATCH_BAND` above), used to break a tie
 * between two rules of the same band at equal specificity — e.g. TAG vs TAGALL (both always score
 * zero specificity), or two path-shaped rules whose paths happen to be the same length. The index IS
 * the priority, so the order of this array is the order documented above; it plays no role ACROSS
 * bands, since `rankOf` checks band first.
 */
const MATCH_PRIORITY: GroupRuleMatch[] = [
  'START',
  'END',
  'REGEX',
  'TAG',
  'TAGALL',
  'EXACT',
  'CLASSIFICATION'
]

/**
 * Modes from weakest to strongest, used to break a tie between rules of the same kind. Exported so
 * `helpers/siteRules.ts` can apply the identical ordering to site-admin rules, which have no
 * specificity/match-type tier of their own to break a tie first.
 */
export const MODE_PRIORITY: GroupRuleMode[] = ['ALLOW', 'DENY', 'FORCEALLOW']

/**
 * Compiled REGEX rule patterns, keyed by the already-normalized path text a rule addresses.
 *
 * `ruleMatchesPage` sits on a hot path shared by every `rulesAllow` caller (the graph,
 * `visibleTreeItems()`, the sitemap build, the admin comment path), and recompiling a REGEX
 * pattern's `RegExp` on every single row it's tested against is pure waste: the compiled output
 * depends only on the pattern text, not on which rule or page it's being asked about. `null` marks a
 * pattern that failed to compile, so an invalid pattern is remembered as failing closed rather than
 * re-thrown-and-caught on every subsequent row.
 *
 * Cleared by `clearPageRuleRegexCache()`, which `models/groups.ts#reloadCache()` calls on every
 * reload (boot, a local group edit, and every other cluster instance's `reloadGroups` event) — the
 * same invalidation path that already rebuilds the pooled rule rows themselves, so an edited pattern
 * is recompiled promptly instead of the map growing forever across repeated edits.
 */
const compiledRegexCache = new Map<string, RegExp | null>()

/** Drops every cached compiled REGEX pattern. Call whenever the underlying rules are reloaded. */
export function clearPageRuleRegexCache(): void {
  compiledRegexCache.clear()
}

/** The compiled pattern for this (already-normalized) path text, compiling and caching it on a miss. */
function compiledRegexFor(normalizedPath: string): RegExp | null {
  if (compiledRegexCache.has(normalizedPath)) {
    return compiledRegexCache.get(normalizedPath)!
  }
  let compiled: RegExp | null
  try {
    compiled = new RegExp(normalizedPath)
  } catch {
    // -> A rule that cannot compile addresses nothing, rather than everything -- cached as such so
    //    every subsequent row against this pattern fails closed without re-attempting compilation
    compiled = null
  }
  compiledRegexCache.set(normalizedPath, compiled)
  return compiled
}

/** Tags are written on a rule as a comma-separated list, in the field a path would otherwise use. */
function ruleTags(rule: GroupRule): string[] {
  return rule.path
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Compared without leading slashes on either side, since neither is stored with one. Case is left
 * untouched here — REGEX must see the pattern and path exactly as written (see below), and
 * START/EXACT/END fold case themselves via `pagePathLower`/`rulePathLower` in `ruleMatchesPage`.
 */
function normalizePath(value: string): string {
  return value.replace(/^\/+/, '')
}

/**
 * How much of the site a rule is talking about, as a number where higher is narrower.
 *
 * The length of the path it addresses. A tag or CLASSIFICATION rule addresses no path, so it scores
 * zero — this no longer decides whether it out-ranks a path rule (that's `MATCH_BAND`'s job, checked
 * first in `rankOf`); specificity here only breaks a tie between two rules that already share a band,
 * such as two path-shaped rules of different depth.
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
  // -> Page paths are always stored lowercased (`normalizePagePath`), so START/EXACT/END compare
  //    lowercased on both sides -- matching the case-insensitivity locale and tag comparisons
  //    already have (OpenProject #2182). REGEX is deliberately excluded from this fold: it addresses
  //    a pattern, not a literal path, and lowercasing it would silently rewrite an author's
  //    intentional character class (`[A-Z]`).
  const pagePathLower = pagePath.toLowerCase()
  const rulePathLower = rulePath.toLowerCase()
  const pageTags = (page.tags ?? []).map((tag) => tag.toLowerCase())

  switch (rule.match) {
    case 'START':
      return pagePathLower.startsWith(rulePathLower)
    case 'EXACT':
      return pagePathLower === rulePathLower
    case 'END':
      return pagePathLower.endsWith(rulePathLower)
    case 'REGEX': {
      // -> Deliberately left OUT of the case-insensitive fold applied to every other match kind
      //    (OpenProject #2182): lowercasing the pattern, or forcing it case-insensitive with the `i`
      //    flag, could silently change a character class an author wrote on purpose (`[A-Z]`).
      //    `rulePath` only ever has its leading slash stripped (see `normalizePath`), so it carries
      //    the pattern's own case sensitivity through unchanged; page paths are always stored
      //    lowercase, so a pattern meant to match ordinary path segments already needs to be written
      //    in lowercase regardless. Compiled through `compiledRegexFor` so a rule that cannot compile
      //    addresses nothing rather than everything, and so its compiled form is memoized (OpenProject
      //    #2267) rather than rebuilt on every page this runs against.
      const compiled = compiledRegexFor(rulePath)
      return compiled ? compiled.test(pagePath) : false
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
 * A rule's rank, compared lexicographically with a higher tuple winning: `[band, specificity,
 * match-type tie-break, mode]`. Band is checked BEFORE specificity — see `MATCH_BAND` — so it
 * dominates unconditionally rather than merely tying with it; specificity and match-type only ever
 * break a tie between two rules that already share a band.
 */
function rankOf(rule: GroupRule): [number, number, number, number] {
  return [
    MATCH_BAND[rule.match],
    specificityOf(rule),
    MATCH_PRIORITY.indexOf(rule.match),
    MODE_PRIORITY.indexOf(rule.mode)
  ]
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
    const rank = rankOf(rule)
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
