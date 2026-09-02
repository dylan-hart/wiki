import { MODE_PRIORITY } from './pageRules.ts'
import type { FastifyRequest } from 'fastify'
import type { GroupRule } from '../models/groups.ts'

/**
 * How a site-admin rule is matched against a site, and which rule wins when several match.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RULES OF SITE-ADMIN PERMISSIONS
 * ---------------------------------------------------------------------------------------------
 *
 * A group grants site-admin permissions through the same rule rows page permissions use
 * (`GroupRule.roles` is one shared vocabulary space — see the decision record at
 * `docs/decisions/delegated-per-site-administration.md`), just read a different way: instead of
 * `path`/`match`/`locales`, a site-admin rule is addressed by `sites` alone. An empty `sites` array
 * means every site; a populated one means only those site ids.
 *
 * **Nothing is granted by default.** A permission nobody wrote a rule for is denied: no rules at all
 * is the same as one DENY rule covering every site. This mirrors `helpers/pageRules.ts` exactly.
 *
 * There is no path to be more specific about, so when more than one rule names the permission and
 * addresses the site being asked about, MODE alone decides — the same `MODE_PRIORITY` order
 * `resolvePageRule` uses to break its own final tie:
 *
 *   ALLOW  <  DENY  <  FORCEALLOW
 *
 * An ALLOW grants the permission. A DENY overrides any ALLOW from elsewhere (e.g. a second group the
 * actor belongs to). A FORCEALLOW overrides any DENY. Ties between rules of the identical mode go to
 * whichever appears first in the pooled array, so the outcome does not depend on which group happened
 * to be listed first.
 *
 * `manage:system` is not evaluated here: it bypasses this entirely, and does so before any rule is
 * read. See `models/groups.ts`'s `checkSiteAccess`.
 */

/**
 * The closed vocabulary of site-scoped administration permissions — one per delegable settings
 * surface. Parallel to `PAGE_PERMISSIONS` in `helpers/permissions.ts`, but namespaced `site:*` so the strings
 * cannot collide with the global `manage:*` tier or with `PAGE_PERMISSIONS`'s `verb:pages` shape.
 * Nothing outside this list may be invented ad hoc — see CLAUDE.md's Permissions section.
 */
export const SITE_PERMISSIONS = [
  'site:general',
  'site:theme',
  'site:navigation',
  'site:blocks',
  'site:approvals',
  'site:login',
  'site:locale',
  'site:editors'
]

/**
 * Whether a rule addresses this site at all, ignoring what it then says about it.
 *
 * Exported for `models/groups.ts`'s `mayHoldPermissionSomewhere()`, which pools rules the same
 * fail-closed way `resolveSiteRule` below does, just without a single permission-mode winner to
 * pick — it only needs to know whether a rule is in play for the site being asked about.
 */
export function ruleMatchesSite(rule: GroupRule, siteId: string): boolean {
  return !rule.sites || rule.sites.length === 0 || rule.sites.includes(siteId)
}

/**
 * The rule that decides a site-admin permission for a site, out of everything the caller's groups
 * say.
 *
 * @param rules Every rule from every group the caller belongs to, pooled
 * @param permission A single site-admin permission, e.g. `site:theme`
 * @param siteId The site being administered
 * @returns The deciding rule, or null when nothing addresses this — which means denied
 */
export function resolveSiteRule(
  rules: GroupRule[],
  permission: string,
  siteId: string
): GroupRule | null {
  let winner: GroupRule | null = null
  let winnerRank = -1

  for (const rule of rules) {
    if (!rule.roles?.includes(permission) || !ruleMatchesSite(rule, siteId)) {
      continue
    }
    const rank = MODE_PRIORITY.indexOf(rule.mode)
    // -> Strictly greater, so the first rule of an otherwise identical pair wins and the outcome
    //    does not depend on the order they happen to arrive in
    if (rank > winnerRank) {
      winner = rule
      winnerRank = rank
    }
  }

  return winner
}

/**
 * Shorthand for `WIKI.models.groups.checkSiteAdminAccess` — see that method for the whole rationale
 * (why the global half is site-blind, and why the site half is `checkSiteAccess()` unchanged).
 *
 * Purely a shorter name at the twenty-two route call sites: spelled out in full, the check is 107
 * columns inside an `if (!…)`, so oxfmt breaks every one of them across five lines and buries a
 * one-line permission gate in the middle of a handler. No logic of its own — it resolves
 * `WIKI.models.groups` at CALL time, never captured at module load, so a route test that stubs the
 * model still decides the answer.
 *
 * The one `WIKI` touch in this otherwise WIKI-free file, and deliberately the only one: the
 * resolution algorithm above stays a pure function of its arguments, testable with no global at all
 * (`helpers/siteRules.test.ts`). This sits here rather than in `helpers/common.ts` because
 * `SITE_PERMISSIONS` — the vocabulary its `sitePermission` argument is drawn from — is declared in
 * this file.
 */
export function maySiteAdmin(
  req: FastifyRequest,
  globalPermission: string,
  sitePermission: string,
  siteId: string
): boolean {
  return WIKI.models.groups.checkSiteAdminAccess(req, globalPermission, sitePermission, siteId)
}
