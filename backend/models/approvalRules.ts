import { and, asc, eq, sql } from 'drizzle-orm'
import { approvalRules as approvalRulesTable } from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { approvalMatchModes } from '../helpers/approvalMatch.ts'
import type { ApprovalMatchMode } from '../helpers/approvalMatch.ts'

// Declared in `helpers/approvalMatch.ts` so `db/schema.ts` can type `approvalRules.match` against it
// without importing a model into the schema module.
export { approvalMatchModes }
export type { ApprovalMatchMode }

export interface ApprovalPageMatch {
  path: string
  tags: string[]
}

export interface ApprovalPageRef extends ApprovalPageMatch {
  id: string
  /**
   * The page's own switch: contributions turned off takes no suggestions whatever the rules say,
   * which is how a single page is exempted without writing a rule around it.
   */
  allowContributions: boolean
  /** Passed through to `groups.checkAccess()`'s `RulePageRef`, nowhere else. */
  locale: string | null
  /** Likewise passed through to `RulePageRef` -- see `helpers/pageRules.ts`. */
  classification: string | null
}

export type ApprovalRule = Omit<typeof approvalRulesTable.$inferSelect, 'siteId'>

export interface ApprovalRulePatch {
  name?: string
  isEnabled?: boolean
  match?: ApprovalMatchMode
  path?: string
  submitterGroups?: string[]
  reviewerGroups?: string[]
  minApprovals?: number
}

/**
 * A tag-mode rule keeps its tags comma-separated in the one pattern field, lower-cased here to match
 * how page tags are stored.
 */
function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)
}

const ruleSelection = {
  id: approvalRulesTable.id,
  name: approvalRulesTable.name,
  isEnabled: approvalRulesTable.isEnabled,
  match: approvalRulesTable.match,
  path: approvalRulesTable.path,
  submitterGroups: approvalRulesTable.submitterGroups,
  reviewerGroups: approvalRulesTable.reviewerGroups,
  minApprovals: approvalRulesTable.minApprovals,
  createdAt: approvalRulesTable.createdAt,
  updatedAt: approvalRulesTable.updatedAt
}

/**
 * Every site's rules, by site id, in the order `getRules` promises. Cached because whether a page
 * takes suggestions and who reviews it are asked of every page the view draws, which would otherwise
 * be two queries in front of every page read. Process-local, like the group and site caches beside
 * it: a rule changed on one node reaches the others when they reload.
 */
let rulesCache: Record<string, ApprovalRule[]> = {}

/**
 * Which pages accept edit suggestions, from whom, and who reviews them. The half of approvals that
 * answers questions about PAGES: the submission lifecycle is `models/approvals.ts`, and the mail it
 * sends is `models/approvalNotifications.ts`.
 */
class ApprovalRules extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadApprovals'

  async reloadCache(): Promise<void> {
    const rows = await CARDINAL.db
      .select({ ...ruleSelection, siteId: approvalRulesTable.siteId })
      .from(approvalRulesTable)
      .orderBy(asc(sql`lower(${approvalRulesTable.name})`), asc(approvalRulesTable.createdAt))
    rulesCache = {}
    for (const { siteId, ...rule } of rows) {
      rulesCache[siteId] ??= []
      rulesCache[siteId].push(rule)
    }
    CARDINAL.logger.debug('pages', 'reloaded the approval rules cache', { rules: rows.length })
  }

  /**
   * Order carries no meaning — a page is covered if any enabled rule matches — so the name sort is
   * for the reader alone. Returns the cached array itself: read it, never sort or splice it.
   */
  async getRules(siteId: string): Promise<ApprovalRule[]> {
    return rulesCache[siteId] ?? []
  }

  /** Scoped to the site so an id belonging to another one cannot be reached through it. */
  async getRule(siteId: string, id: string): Promise<ApprovalRule | null> {
    const rows = await CARDINAL.db
      .select(ruleSelection)
      .from(approvalRulesTable)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  async createRule(siteId: string, patch: ApprovalRulePatch): Promise<ApprovalRule> {
    const rows = await CARDINAL.db
      .insert(approvalRulesTable)
      .values({
        siteId,
        name: patch.name ?? '',
        isEnabled: patch.isEnabled ?? true,
        match: patch.match ?? 'START',
        // -> Trimmed so a pattern typed with a stray space matches what it reads as, and so a
        //    `START` path of nothing but spaces is the whole site rather than no page at all.
        path: (patch.path ?? '').trim(),
        submitterGroups: patch.submitterGroups ?? [],
        reviewerGroups: patch.reviewerGroups ?? [],
        minApprovals: patch.minApprovals ?? 1
      })
      .returning(ruleSelection)
    // -> Every later read comes from the cache, so it has to learn about this rule.
    await this.broadcastReload()
    return rows[0]
  }

  async updateRule(
    siteId: string,
    id: string,
    patch: ApprovalRulePatch
  ): Promise<ApprovalRule | null> {
    const values: Record<string, any> = { updatedAt: new Date() }
    for (const key of [
      'name',
      'isEnabled',
      'match',
      'path',
      'submitterGroups',
      'reviewerGroups',
      'minApprovals'
    ] as const) {
      if (patch[key] !== undefined) {
        // -> Trimmed for the reason it is on create.
        values[key] = key === 'path' ? String(patch[key]).trim() : patch[key]
      }
    }

    const rows = await CARDINAL.db
      .update(approvalRulesTable)
      .set(values)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
      .returning(ruleSelection)
    await this.broadcastReload()
    return rows[0] ?? null
  }

  /**
   * Paths are compared with no leading slash on either side, which is how both are stored. A regular
   * expression that will not compile matches nothing rather than throwing: the API already refuses
   * one, so this is only reached by a rule that was valid when written and stopped being so.
   */
  matchesPage(rule: ApprovalRule, page: ApprovalPageMatch): boolean {
    const pagePath = page.path.replace(/^\/+/, '')
    const rulePath = rule.path.replace(/^\/+/, '')
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
          return false
        }
      case 'TAG':
        return parseTags(rule.path).some((tag) => page.tags.includes(tag))
      case 'TAGALL': {
        const wanted = parseTags(rule.path)
        return wanted.length > 0 && wanted.every((tag) => page.tags.includes(tag))
      }
      default:
        return false
    }
  }

  /**
   * The same rules `getReviewableSubmissions` filters by, read from the other direction: it starts
   * from a reviewer's groups and asks which submissions they cover, this starts from a page and asks
   * which groups cover it.
   */
  async reviewerGroupIdsForPage(siteId: string, page: ApprovalPageMatch): Promise<string[]> {
    const rules = await this.getRules(siteId)
    const groupIds = new Set<string>()
    for (const rule of rules) {
      if (rule.isEnabled && this.matchesPage(rule, page)) {
        for (const id of rule.reviewerGroups) {
          groupIds.add(id)
        }
      }
    }
    return [...groupIds]
  }

  async deleteRule(siteId: string, id: string): Promise<boolean> {
    const result = await CARDINAL.db
      .delete(approvalRulesTable)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }
}

export const approvalRules = new ApprovalRules()
