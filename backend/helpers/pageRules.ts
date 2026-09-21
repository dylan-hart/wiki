import type { GroupRule, GroupRuleMatch, GroupRuleMode } from '../models/groups.ts'

/**
 * How a page rule is matched against a page, and which rule wins when several match.
 *
 * A group grants page permissions through rules, never as a blanket: each names permissions
 * (`roles`), a way of addressing pages (`match` + `path`, tags or classifications) and a `mode`. A
 * user's rules are all of their groups' rules pooled, so a second group can both widen and narrow
 * what the first said. **Nothing is granted by default**: no rule naming a permission means denied.
 *
 * When several rules name the permission and match the page, exactly one decides. Array order means
 * nothing; the tiers apply in this order, each only breaking a tie left by the one before:
 *
 *   1. BAND — which kind of thing the rule addresses:
 *
 *        START / SUBTREE / END / REGEX  <  TAG / TAGALL  <  EXACT  <  CLASSIFICATION
 *
 *      A page's tags describe what it IS, a stronger claim than where it currently lives in the
 *      tree; naming one page exactly is stronger than a property several pages share.
 *      CLASSIFICATION tops everything, so a classification DENY overrides a path/tag ALLOW however
 *      deep: classification survives a move or rename, and a rule written against it must not lose
 *      to one written against wherever the page lives today.
 *
 *   2. SPECIFICITY — the length of the path the rule addresses, so `geography/countries` beats
 *      `geography` and a whole-site rule (empty path) is weakest. Tag and CLASSIFICATION rules
 *      score zero, so this only separates path-shaped rules.
 *
 *   3. MATCH TYPE — START < SUBTREE < END < REGEX, TAG < TAGALL.
 *
 *   4. MODE — ALLOW < DENY < FORCEALLOW. A DENY overrides any ALLOW; a FORCEALLOW overrides any
 *      DENY, which is what makes a hole in an otherwise closed branch possible.
 *
 * Mode comes last, so a DENY on `geography` does NOT override an ALLOW on `geography/countries`:
 * the deeper rule had already won.
 *
 * A rule may also be scoped to `locales` and/or `sites`; an empty list means all. Both are match
 * filters applied before ranking, not specificity axes. They, and CLASSIFICATION matching, fail
 * CLOSED: a ref with `null` for locale, site or classification matches no rule scoped on it.
 * Locale comparison is case-insensitive.
 *
 * `manage:system` is not evaluated here: `models/groups.ts` bypasses the rules before any is read.
 */

/**
 * A page as a rule sees it. `locale`, `siteId` and `classification` are REQUIRED rather than
 * optional: a caller with no such context says `null` explicitly, and a rule scoped on that field
 * then does not match. A page that does not exist yet (a create-permission check) has no
 * classification either.
 */
export interface RulePageRef {
  path: string
  locale: string | null
  siteId: string | null
  /** Classification level id, or null when unknown or not yet decided. */
  classification: string | null
  tags?: string[]
}

/**
 * Band per match kind, weakest first; `rankOf` checks it before specificity. Typed as a
 * `Record<GroupRuleMatch, number>` so a missing or extra member is a compile error.
 */
const MATCH_BAND: Record<GroupRuleMatch, number> = {
  START: 0,
  SUBTREE: 0,
  END: 0,
  REGEX: 0,
  TAG: 1,
  TAGALL: 1,
  EXACT: 2,
  CLASSIFICATION: 3
}

/**
 * Match kinds weakest to strongest; the index IS the priority. Only breaks a tie within a band at
 * equal specificity, since `rankOf` checks band first.
 */
const MATCH_PRIORITY: GroupRuleMatch[] = [
  'START',
  'SUBTREE',
  'END',
  'REGEX',
  'TAG',
  'TAGALL',
  'EXACT',
  'CLASSIFICATION'
]

/** Modes weakest to strongest. Exported so `helpers/siteRules.ts` applies the identical ordering. */
export const MODE_PRIORITY: GroupRuleMode[] = ['ALLOW', 'DENY', 'FORCEALLOW']

/**
 * Compiled REGEX rule patterns, keyed by normalized pattern text: `ruleMatchesPage` runs per row on
 * hot paths, and the compiled form depends only on the text. `null` marks a pattern that failed to
 * compile, so it keeps failing closed without being recompiled.
 */
const compiledRegexCache = new Map<string, RegExp | null>()

/**
 * Call whenever the underlying rules are reloaded (`models/groups.ts#reloadCache()`), so an edited
 * pattern is recompiled and the map does not grow across edits.
 */
export function clearPageRuleRegexCache(): void {
  compiledRegexCache.clear()
}

function compiledRegexFor(normalizedPath: string): RegExp | null {
  if (compiledRegexCache.has(normalizedPath)) {
    return compiledRegexCache.get(normalizedPath)!
  }
  let compiled: RegExp | null
  try {
    compiled = new RegExp(normalizedPath)
  } catch {
    // -> A rule that cannot compile addresses nothing, rather than everything
    compiled = null
  }
  compiledRegexCache.set(normalizedPath, compiled)
  return compiled
}

/**
 * Read off `rule.tags` alone, never parsed out of `path`. Already normalized at write time
 * (`models/groups.ts#normalizeRuleTags`); the fold here covers a row that arrived some other way.
 */
function ruleTags(rule: GroupRule): string[] {
  return (rule.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean)
}

/** Strips leading slashes only; case stays, since REGEX must see its pattern exactly as written. */
function normalizePath(value: string): string {
  return value.replace(/^\/+/, '')
}

/**
 * How narrow a rule is: the length of the path it addresses. A tag or CLASSIFICATION rule addresses
 * no path and scores zero; `MATCH_BAND` is what ranks it against path rules.
 */
function specificityOf(rule: GroupRule): number {
  if (rule.match === 'TAG' || rule.match === 'TAGALL' || rule.match === 'CLASSIFICATION') {
    return 0
  }
  return normalizePath(rule.path).length
}

/** Whether a rule addresses this page at all, ignoring what it then says about it. */
export function ruleMatchesPage(rule: GroupRule, page: RulePageRef): boolean {
  // -> An empty list means every locale; an unknown locale (`null`) fails closed. Case-insensitive,
  //    as URL parsing of locale codes is.
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

  // -> Matches page metadata, not its address; an unknown classification matches nothing
  if (rule.match === 'CLASSIFICATION') {
    return (
      Boolean(page.classification) && (rule.classifications ?? []).includes(page.classification!)
    )
  }

  const pagePath = normalizePath(page.path)
  const rulePath = normalizePath(rule.path)
  // -> Page paths are stored lowercased (`normalizePagePath`), so START/SUBTREE/EXACT/END fold the rule's
  //    path to match. REGEX is excluded: lowercasing a pattern, or adding the `i` flag, would
  //    rewrite an author's intentional character class (`[A-Z]`).
  const pagePathLower = pagePath.toLowerCase()
  const rulePathLower = rulePath.toLowerCase()
  const pageTags = (page.tags ?? []).map((tag) => tag.toLowerCase())

  switch (rule.match) {
    case 'START':
      return pagePathLower.startsWith(rulePathLower)
    case 'SUBTREE': {
      // -> START is a raw prefix, so `foo/bar` also matches `foo/barometer`; this is the folder
      //    boundary kind, and an empty path addresses the whole site like START.
      const root = rulePathLower.replace(/\/+$/, '')
      return root === '' || pagePathLower === root || pagePathLower.startsWith(`${root}/`)
    }
    case 'EXACT':
      return pagePathLower === rulePathLower
    case 'END':
      return pagePathLower.endsWith(rulePathLower)
    case 'REGEX': {
      // -> Case-sensitive (see above), so a pattern meant for ordinary path segments must be written
      //    in lowercase.
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

/** `[band, specificity, match type, mode]`, compared lexicographically; the higher tuple wins. */
function rankOf(rule: GroupRule): [number, number, number, number] {
  return [
    MATCH_BAND[rule.match],
    specificityOf(rule),
    MATCH_PRIORITY.indexOf(rule.match),
    MODE_PRIORITY.indexOf(rule.mode)
  ]
}

/**
 * The rule that decides `permission` for a page, out of every rule of every group the caller belongs
 * to, pooled. Null when nothing addresses it, which means denied.
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

/** Whether the caller's rules grant a permission on a page. False when no rule addresses it. */
export function rulesAllow(rules: GroupRule[], permission: string, page: RulePageRef): boolean {
  const rule = resolvePageRule(rules, permission, page)
  return rule ? rule.mode !== 'DENY' : false
}
