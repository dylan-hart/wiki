import { and, asc, eq, sql } from 'drizzle-orm'
import { approvalRules as approvalRulesTable } from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { approvalMatchModes } from '../helpers/approvalMatch.ts'
import type { ApprovalMatchMode } from '../helpers/approvalMatch.ts'

// `helpers/approvalMatch.ts` so `db/schema.ts` can type `approvalRules.match` against it without
// importing a model into the schema module.
export { approvalMatchModes }
export type { ApprovalMatchMode }

/** The part of a page a rule is matched against. */
/** What a rule is matched against: where the page is, and what it is tagged with. */
export interface ApprovalPageMatch {
  path: string
  tags: string[]
}

export interface ApprovalPageRef extends ApprovalPageMatch {
  id: string
  /**
   * The page's own switch, from its properties. A page with contributions turned off takes no
   * suggestions whatever the rules say — which is how a single page is exempted without writing a
   * rule around it.
   */
  allowContributions: boolean
  /** Passed through to `groups.checkAccess()`'s `RulePageRef` in `pageViewerState`, nowhere else. */
  locale: string | null
  /** Likewise passed through to `RulePageRef` -- see `helpers/pageRules.ts` (OpenProject #1079). */
  classification: string | null
}

/** An approval rule as the API exposes it. */
export type ApprovalRule = Omit<typeof approvalRulesTable.$inferSelect, 'siteId'>

/** The fields a rule is created or updated with. */
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
 * The tags of a tag-mode rule, as they are written into the one pattern field: comma-separated, and
 * compared in lower case the way page tags are stored.
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
 * Every site's rules, by site id, in the order `getRules` promises.
 *
 * Cached for the reason the group rules are (`models/groups.ts`): whether a page takes suggestions
 * and who reviews it are questions the page view asks about every page it draws, and answering them
 * from the database would put two queries in front of every page read. Rules change from one admin
 * screen, and the cache is reloaded there.
 *
 * A single instance's memory, like the group and site caches beside it: a rule changed on one node of
 * a cluster reaches the others when they next reload.
 */
let rulesCache: Record<string, ApprovalRule[]> = {}

/**
 * Approval rules model
 *
 * Which pages accept edit suggestions, from whom, and who reviews them — the rules themselves, their
 * in-memory per-site cache, and the one question every other caller asks of them: does this rule
 * match this page.
 *
 * Split out of `models/approvals.ts` (MOD-F13) because it is the half that answers questions about
 * PAGES; the submission lifecycle those rules govern is `models/approvals.ts`, and the mail it sends
 * is `models/approvalNotifications.ts`.
 */
class ApprovalRules extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadApprovals'

  /**
   * Reload every site's rules into memory.
   *
   * Called at boot, after any local change to a rule (see `broadcastReload()`), and on every other
   * cluster instance's `reloadApprovals` event (see `subscribeToEvents()`) — so an administrator's
   * edit takes effect on the next request everywhere, the same contract `models/groups.ts` gives
   * page rules.
   */
  async reloadCache(): Promise<void> {
    const rows = await WIKI.db
      .select({ ...ruleSelection, siteId: approvalRulesTable.siteId })
      .from(approvalRulesTable)
      .orderBy(asc(sql`lower(${approvalRulesTable.name})`), asc(approvalRulesTable.createdAt))
    rulesCache = {}
    for (const { siteId, ...rule } of rows) {
      rulesCache[siteId] ??= []
      rulesCache[siteId].push(rule)
    }
    WIKI.logger.info(`Loaded ${rows.length} approval rules [ OK ]`)
  }

  /**
   * Every rule configured for a site, by name.
   *
   * Order carries no meaning — a page is covered if any enabled rule matches it — so the list is
   * sorted for the reader: alphabetically, ignoring case, since `Zoo` sorting before `apple` is not
   * what alphabetical means to anyone. Two rules sharing a name keep a stable order by age.
   *
   * From `rulesCache`, so this costs nothing to ask; async because every caller awaits it and because
   * where the rules come from is this model's business. The array is the cached one — read it, do not
   * sort or splice it.
   */
  async getRules(siteId: string): Promise<ApprovalRule[]> {
    return rulesCache[siteId] ?? []
  }

  /**
   * A single rule, scoped to its site so that an ID from another site cannot be reached through it.
   *
   * @returns The rule, or null if this site has no such rule
   */
  async getRule(siteId: string, id: string): Promise<ApprovalRule | null> {
    const rows = await WIKI.db
      .select(ruleSelection)
      .from(approvalRulesTable)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
      .limit(1)
    return rows[0] ?? null
  }

  /**
   * Create a rule for a site.
   *
   * @returns The rule as stored
   */
  async createRule(siteId: string, patch: ApprovalRulePatch): Promise<ApprovalRule> {
    const rows = await WIKI.db
      .insert(approvalRulesTable)
      .values({
        siteId,
        name: patch.name ?? '',
        isEnabled: patch.isEnabled ?? true,
        match: patch.match ?? 'START',
        // -> Trimmed, so a pattern typed with a stray space still matches what it reads as -- and so
        //    that a `START` path of nothing but spaces is the whole site rather than a rule that
        //    quietly covers no page at all
        path: (patch.path ?? '').trim(),
        submitterGroups: patch.submitterGroups ?? [],
        reviewerGroups: patch.reviewerGroups ?? [],
        minApprovals: patch.minApprovals ?? 1
      })
      .returning(ruleSelection)
    // -> Every rule read afterwards comes from the cache, so it has to know about this one
    await this.broadcastReload()
    return rows[0]
  }

  /**
   * Update a rule, leaving out fields alone.
   *
   * @returns The updated rule, or null if this site has no such rule
   */
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
        // -> Trimmed for the same reason it is on create
        values[key] = key === 'path' ? String(patch[key]).trim() : patch[key]
      }
    }

    const rows = await WIKI.db
      .update(approvalRulesTable)
      .set(values)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
      .returning(ruleSelection)
    await this.broadcastReload()
    return rows[0] ?? null
  }

  /**
   * Whether a rule covers a page.
   *
   * Paths are compared without a leading slash on either side, which is how they are stored and how
   * the rule is written. A regular expression that will not compile matches nothing rather than
   * throwing: the rule is already refused at the API, so this is only reached by one that was valid
   * when it was written and stopped being so.
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
   * The reviewer group ids of every enabled rule that matches this page, unioned across rules.
   *
   * The same rules `getReviewableSubmissions` filters by, read from the other direction: that method
   * starts from a reviewer's own groups and asks which submissions they cover; this starts from a page
   * and asks which groups cover it, so their members can be resolved and told. `getRules` is the same
   * in-memory cache either way, so this costs nothing beyond the loop.
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

  /**
   * Delete a rule.
   *
   * @returns Whether a rule was deleted
   */
  async deleteRule(siteId: string, id: string): Promise<boolean> {
    const result = await WIKI.db
      .delete(approvalRulesTable)
      .where(and(eq(approvalRulesTable.siteId, siteId), eq(approvalRulesTable.id, id)))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }
}

export const approvalRules = new ApprovalRules()
