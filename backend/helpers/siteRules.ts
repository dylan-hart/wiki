import { MODE_PRIORITY } from './pageRules.ts'
import type { FastifyRequest } from 'fastify'
import type { GroupRule } from '../models/groups.ts'

/**
 * A closed vocabulary, one per delegable settings surface. Namespaced `site:*` so the strings
 * cannot collide with the global `manage:*` tier or with `PAGE_PERMISSIONS` in
 * `helpers/permissions.ts`, whose rule rows (`GroupRule.roles`) they share.
 */
export const SITE_PERMISSIONS = [
  'site:general',
  'site:theme',
  'site:navigation',
  'site:blocks',
  'site:approvals',
  'site:login',
  'site:locale',
  'site:editors',
  'site:templates'
]

/** An empty `sites` array means every site. */
export function ruleMatchesSite(rule: GroupRule, siteId: string): boolean {
  return !rule.sites || rule.sites.length === 0 || rule.sites.includes(siteId)
}

/**
 * The rule that decides a site-admin permission for a site, or null when nothing addresses it —
 * which means denied: nothing is granted by default, as in `helpers/pageRules.ts`.
 *
 * A site-admin rule is addressed by `sites` alone, so there is no path to be more specific about
 * and MODE alone decides, in the same `MODE_PRIORITY` order `resolvePageRule` breaks its final tie
 * with:
 *
 *   ALLOW  <  DENY  <  FORCEALLOW
 *
 * A DENY overrides an ALLOW from any other group the actor belongs to; a FORCEALLOW overrides any
 * DENY. `manage:system` is not evaluated here: `models/groups.ts#checkSiteAccess` bypasses this
 * before any rule is read.
 *
 * @param rules Every rule from every group the caller belongs to, pooled
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
    // -> Strictly greater: of two same-mode rules the first wins, which cannot change the decision
    if (rank > winnerRank) {
      winner = rule
      winnerRank = rank
    }
  }

  return winner
}

/**
 * Call-site shorthand for `CARDINAL.models.groups.checkSiteAdminAccess`, with no logic of its own:
 * spelled out in full the check wraps, burying a one-line permission gate. Resolves
 * `CARDINAL.models.groups` at CALL time, never captured at module load, so a route test that stubs
 * the model still decides the answer.
 */
export function maySiteAdmin(
  req: FastifyRequest,
  globalPermission: string,
  sitePermission: string,
  siteId: string
): boolean {
  return CARDINAL.models.groups.checkSiteAdminAccess(req, globalPermission, sitePermission, siteId)
}
