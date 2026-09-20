import crypto from 'node:crypto'
import { and, count, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { uniq } from 'es-toolkit/array'
import { groups as groupsTable, userGroups, users as usersTable } from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import {
  CustomError,
  escapeLikePattern,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'
import { clearPageRuleRegexCache, resolvePageRule, type RulePageRef } from '../helpers/pageRules.ts'
import { paginate } from '../helpers/pagination.ts'
import { resolveSiteRule, ruleMatchesSite } from '../helpers/siteRules.ts'
import { userSelection } from './users.ts'
import type { UserPage } from './users.ts'
import type { SystemIds } from './types.ts'
import type { FastifyRequest } from 'fastify'

/** Bypasses every permission check. */
export const SYSTEM_PERMISSION = 'manage:system'

const GROUP_NAME_MAX_LENGTH = 255
const MAX_IMPORT_NAME_ATTEMPTS = 1000

function groupNameTaken(name: string): CustomError {
  return new CustomError(
    'groupNameTaken',
    `A group named "${name.trim()}" already exists. Group names are compared ignoring case and surrounding spaces.`,
    409
  )
}

function suffixedGroupName(name: string, attempt: number): string {
  const suffix = ` (${attempt})`
  const base = name
    .trim()
    .slice(0, GROUP_NAME_MAX_LENGTH - suffix.length)
    .trimEnd()
  return `${base}${suffix}`
}

/**
 * How a rule's `path` is compared against the page path. `CLASSIFICATION` does not read `path` at
 * all: it matches page metadata (`classifications` on `GroupRule`), which survives a move/rename.
 */
const GROUP_RULE_MATCH_KINDS = [
  'START',
  'END',
  'REGEX',
  'TAG',
  'TAGALL',
  'EXACT',
  'CLASSIFICATION'
] as const

export type GroupRuleMatch = (typeof GROUP_RULE_MATCH_KINDS)[number]

/**
 * ajv needs a literal array for its `enum` and cannot read a TS union. Typing this literal as
 * `Record<GroupRuleMatch, true>` makes a missing or extra member a compile error, so the schema
 * cannot drift from the type.
 */
const GROUP_RULE_MATCH_MEMBERS: Record<GroupRuleMatch, true> = {
  START: true,
  END: true,
  REGEX: true,
  TAG: true,
  TAGALL: true,
  EXACT: true,
  CLASSIFICATION: true
}
export const GROUP_RULE_MATCH_VALUES = Object.keys(GROUP_RULE_MATCH_MEMBERS) as GroupRuleMatch[]

export type GroupRuleMode = 'ALLOW' | 'DENY' | 'FORCEALLOW'

/**
 * Shared with the 2.5.x importer (`migration/importers/users-groups.ts`) so both write paths agree
 * on what a normalized tag is.
 */
export function normalizeRuleTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    const trimmed = tag.trim().toLowerCase()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      normalized.push(trimmed)
    }
  }
  return normalized
}

export interface GroupRule {
  id: string
  name: string
  roles: string[]
  match: GroupRuleMatch
  mode: GroupRuleMode
  path: string
  locales: string[]
  sites: string[]
  /** Read only when `match` is `TAG` or `TAGALL`. Normalized at write time by `updateGroup`. */
  tags?: string[]
  /**
   * Level ids from `CARDINAL.models.classificationLevels`, read only when
   * `match === 'CLASSIFICATION'`.
   */
  classifications?: string[]
}

export interface GroupWithUserCount {
  id: string
  name: string
  permissions: string[]
  rules: GroupRule[]
  redirectOnLogin: string
  redirectOnFirstLogin: string
  redirectOnLogout: string
  isSystem: boolean
  userCount: number
  createdAt: Date
  updatedAt: Date
}

/** `isSystem` is deliberately absent. */
export interface GroupPatch {
  name?: string
  redirectOnLogin?: string
  redirectOnFirstLogin?: string
  redirectOnLogout?: string
  permissions?: string[]
  rules?: GroupRule[]
}

/**
 * `userCount` needs the caller to left-join `userGroups` and group by group id; the left join is
 * what keeps a member-less group in the result, counting 0.
 */
const groupSelection = {
  id: groupsTable.id,
  name: groupsTable.name,
  permissions: groupsTable.permissions,
  rules: groupsTable.rules,
  redirectOnLogin: groupsTable.redirectOnLogin,
  redirectOnFirstLogin: groupsTable.redirectOnFirstLogin,
  redirectOnLogout: groupsTable.redirectOnLogout,
  isSystem: groupsTable.isSystem,
  createdAt: groupsTable.createdAt,
  updatedAt: groupsTable.updatedAt,
  userCount: count(userGroups.userId)
}

/** Who is asking, and what they hold outside the page rules. */
export interface AccessActor {
  groupIds: string[]
  /** The group-wide list (`manage:system`, `access:admin`, …), not what the page rules grant. */
  permissions: string[]
  /**
   * An API key's scope narrowing; null/absent is unrestricted. `permissions` arrives already
   * intersected with it, but `groupIds` is the key's full membership — so every rule-pooling check
   * must refuse a permission absent from `scope` itself, or the pooled rules would grant it anyway.
   */
  scope?: string[] | null
  /**
   * An API key's classification allow-set; null/absent is unrestricted. Enforced by `checkAccess()`
   * only — the page-blind checks have no classification to compare it against.
   */
  allowedClassifications?: string[] | null
  /**
   * An API key's site pin; null/absent is unrestricted. A hard boundary rather than a rule: a rule
   * with an empty `sites` grants every site, so nothing else holds a pinned key inside its site.
   */
  siteId?: string | null
}

/**
 * The page permissions a rule on the guests group may grant: reading, and commenting. Everything
 * else is an action attributable to somebody, and the guests group is the absence of a somebody.
 *
 * Mirrored in `GroupRulesEditor.vue`; this copy is the one that decides.
 */
export const GUEST_ROLES = [
  'read:pages',
  'read:source',
  'read:history',
  'read:assets',
  'read:comments',
  'write:comments'
]

/**
 * Every group's rules, by group id. Cached because a page permission is checked on every page read.
 */
let rulesCache: Record<string, GroupRule[]> = {}

/**
 * Memoised `rulesForGroups()` pools, keyed on the sorted group id set -- order within a pool means
 * nothing (see `helpers/pageRules.ts`), so the same groups in any order share one entry. Cleared
 * with `rulesCache` in `reloadCache()`.
 */
let rulesPoolCache: Record<string, GroupRule[]> = {}

class Groups extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadGroups'

  /**
   * Rules are the whole of page access, so a group edit takes effect on the next request rather
   * than the next login, on every instance: a revoked permission that waits for a logout is not
   * revoked.
   */
  async reloadCache(): Promise<void> {
    const rows = await CARDINAL.db
      .select({ id: groupsTable.id, rules: groupsTable.rules })
      .from(groupsTable)
    rulesCache = {}
    rulesPoolCache = {}
    for (const row of rows) {
      rulesCache[row.id] = (row.rules ?? []) as GroupRule[]
    }
    // -> Compiled REGEX patterns are keyed by pattern text, not by rule: without this the cache
    //    grows with every edited pattern.
    clearPageRuleRegexCache()
    CARDINAL.logger.debug('config', 'reloaded the group page rules', { groups: rows.length })
  }

  /**
   * The pooled rules of a set of groups, which is what a permission is decided against. The
   * returned array is memoised and shared across callers: never mutate it.
   */
  rulesForGroups(groupIds: string[]): GroupRule[] {
    const key = [...groupIds].sort().join(',')
    const cached = rulesPoolCache[key]
    if (cached) {
      return cached
    }
    const pooled = groupIds.flatMap((id) => rulesCache[id] ?? [])
    rulesPoolCache[key] = pooled
    return pooled
  }

  /**
   * Which groups a request speaks for.
   *
   * An API key is checked first: a bearer token never touches the session, so without its own
   * branch it would fall through to the guests group and be decided against the public's rules.
   *
   * An anonymous request is the guests group, not group-less: its rules are how a wiki says what
   * the public may see, and no groups at all would deny everything.
   */
  groupIdsForRequest(req: FastifyRequest): string[] {
    if (req.apiKey) {
      return req.apiKey.groupIds
    }
    if (req.session?.authenticated && req.session.user?.id) {
      return req.session.groups ?? []
    }
    return [CARDINAL.data.systemIds.guestsGroupId]
  }

  actorForRequest(req: FastifyRequest): AccessActor {
    return {
      groupIds: this.groupIdsForRequest(req),
      permissions: req.apiKey?.permissions ?? req.session?.permissions ?? [],
      scope: req.apiKey?.scope ?? null,
      allowedClassifications: req.apiKey?.allowedClassifications ?? null,
      siteId: req.apiKey?.siteId ?? null
    }
  }

  /**
   * The actor for a caller that speaks for no specific requester (a background job): it resolves
   * permission-gated content the way an anonymous visitor's request would, rather than skipping the
   * check entirely.
   */
  guestActor(): AccessActor {
    return { groupIds: [CARDINAL.data.systemIds.guestsGroupId], permissions: [] }
  }

  /**
   * The actor a user speaks for, resolved from their CURRENT group membership — for a caller with
   * only a stored `userId` (a notification sent long after it was queued, a check made about
   * somebody other than the requester) that needs today's answer rather than a session's.
   *
   * No `scope`/`allowedClassifications`/`siteId`: those are an API key's own narrowings.
   */
  async actorForUserId(userId: string): Promise<AccessActor> {
    const groupIds = await CARDINAL.models.users.getUserGroupIds(userId)
    if (groupIds.length < 1) {
      return { groupIds: [], permissions: [] }
    }
    const rows = await CARDINAL.db
      .select({ permissions: groupsTable.permissions })
      .from(groupsTable)
      .where(inArray(groupsTable.id, groupIds))
    return {
      groupIds,
      permissions: uniq(rows.flatMap((row) => (row.permissions ?? []) as string[]))
    }
  }

  private withinScope(actor: AccessActor, permission: string): boolean {
    return !actor.scope || actor.scope.includes(permission)
  }

  /**
   * `siteId` is `null` for a page ref with no site context at all; a pinned actor fails closed
   * there, the same as a site-scoped rule would.
   */
  private withinSitePin(actor: AccessActor, siteId: string | null): boolean {
    return !actor.siteId || actor.siteId === siteId
  }

  /**
   * Whether this caller may do this to this page — the one place page permissions are decided.
   * Everything page-scoped asks this rather than reading the session's permission list, which holds
   * only what a group was granted GLOBALLY; see `helpers/pageRules.ts` for how a rule is chosen.
   */
  checkAccess(actor: AccessActor, permission: string, page: RulePageRef): boolean {
    /*
      Above the `manage:system` bypass, deliberately: a credential narrowing is not a page rule, and
      an administrator who mints a classification-scoped token is asking for that scope to hold even
      over their own admin rights. An unknown classification (`null` — an asset, a folder, a page
      that does not exist yet) is skipped rather than denied: this narrows on top of the rules and
      has no fail-closed obligation of its own, unlike a CLASSIFICATION rule match.
    */
    if (
      actor.allowedClassifications != null &&
      page.classification != null &&
      !CARDINAL.models.classificationLevels.isAllowed(
        page.classification,
        actor.allowedClassifications
      )
    ) {
      return false
    }
    /*
      The site pin, above `manage:system` for the same reason. The routing-layer hook
      (`helpers/apiKeySite.ts`) already refuses a mismatched `:siteId`; this closes the engine for
      any call path that reaches here without going through it.
    */
    if (!this.withinSitePin(actor, page.siteId)) {
      return false
    }
    // -> Above the rules entirely: an administrator is not something a rule can lock out, and a
    //    wiki whose only administrator had denied themselves would have nobody left to fix it
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    if (!this.withinScope(actor, permission)) {
      return false
    }
    const rule = resolvePageRule(this.rulesForGroups(actor.groupIds), permission, page)
    return rule ? rule.mode !== 'DENY' : false
  }

  /**
   * Whether this actor holds any of these page permissions ANYWHERE ON A SITE — deliberately coarse
   * and path-blind, for a caller that spans many pages at once and so has no single page to ask
   * `checkAccess()` about. DENY rules are ignored: the question is whether the actor is generally a
   * holder, and a rule denying it under one subtree does not change that for the rest of the site.
   *
   * NOT site-blind: a rule whose `sites` is non-empty and does not name `siteId` is not counted, or
   * a grant scoped to one site would unlock another's drafts and protected excerpts. Pass `null`
   * only when the caller has no site in play at all (the icon picker: icon sets are instance-wide),
   * which skips that filter.
   *
   * `allowedClassifications` is deliberately NOT applied, and `manage:system` stays a full bypass:
   * there is no page to compare the allow-set against. That is safe only because every caller
   * re-checks each page with `checkAccess()` before exposing it, making this a coarse upstream hint
   * rather than the gate. A caller using it as the SOLE gate before returning page content is not
   * safe, and needs a per-page check of its own.
   */
  mayHoldPermissionSomewhere(
    actor: AccessActor,
    permissions: string[],
    siteId: string | null
  ): boolean {
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    // -> Same scope narrowing as `checkAccess()`, before any rule is read: a scoped key must not
    //    read as a holder of a name outside its own scope, whatever its groups' rules say.
    const inScope = permissions.filter((permission) => this.withinScope(actor, permission))
    if (inScope.length === 0) {
      return false
    }
    const rules = this.rulesForGroups(actor.groupIds).filter(
      (rule) => siteId == null || ruleMatchesSite(rule, siteId)
    )
    return inScope.some((permission) =>
      rules.some((rule) => rule.mode !== 'DENY' && rule.roles.includes(permission))
    )
  }

  /**
   * The site-scoped counterpart to `checkAccess()`: the same rule rows, the same pooling across an
   * actor's groups, but addressed by `sites` alone instead of `path`/`match`/`locales` — see
   * `helpers/siteRules.ts` for how a rule is chosen. `permission` is one of `SITE_PERMISSIONS`.
   */
  checkSiteAccess(actor: AccessActor, permission: string, siteId: string): boolean {
    // -> The site pin sits ahead of `manage:system`, for the reason given in `checkAccess()`
    if (!this.withinSitePin(actor, siteId)) {
      return false
    }
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    if (!this.withinScope(actor, permission)) {
      return false
    }
    const rule = resolveSiteRule(this.rulesForGroups(actor.groupIds), permission, siteId)
    return rule ? rule.mode !== 'DENY' : false
  }

  /**
   * Whether this request may administer one delegable settings surface of one site: the site-blind
   * global permission, OR the narrower `site:*` delegation a rule can grant per site. The one place
   * that "or" is written.
   *
   * `globalPermission` is checked first and site-blind, which is what makes delegation additive: a
   * rule only ever hands the surface to somebody narrower, and a DENY on a `site:*` rule stops that
   * delegation, never the global permission beside it. The site half is `checkSiteAccess()`
   * unchanged, so the site pin, the API-key scope and the `manage:system` bypass all apply to it.
   */
  checkSiteAdminAccess(
    req: FastifyRequest,
    globalPermission: string,
    sitePermission: string,
    siteId: string
  ): boolean {
    const actor = this.actorForRequest(req)
    return (
      actor.permissions.includes(globalPermission) ||
      this.checkSiteAccess(actor, sitePermission, siteId)
    )
  }

  async init(ids: SystemIds): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the default groups')

    await CARDINAL.db.insert(groupsTable).values([
      {
        id: ids.groupAdminId,
        name: 'Administrators',
        permissions: ['manage:system'],
        rules: [],
        isSystem: true
      },
      {
        id: ids.groupUserId,
        name: 'Users',
        // -> The GLOBAL, `GlobalPermission#`-validated list: page access comes from `rules.roles`
        //    below, and a page-permission string here makes every later PUT of this group 400.
        permissions: [],
        rules: [
          {
            id: crypto.randomUUID(),
            name: 'Default Rule',
            roles: ['read:pages', 'read:assets', 'read:comments'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: []
          }
        ],
        isSystem: true
      },
      {
        id: ids.groupGuestId,
        name: 'Guests',
        permissions: [],
        rules: [
          {
            id: crypto.randomUUID(),
            name: 'Default Rule',
            roles: ['read:pages', 'read:assets', 'read:comments'],
            match: 'START',
            mode: 'DENY',
            path: '',
            locales: [],
            sites: []
          }
        ],
        isSystem: true
      }
    ])
  }

  /**
   * Seeded with the `Users` group's default rule. `permissions` starts empty for the reason given
   * in `init()`: page access comes from the rule's `roles`, never from that column.
   */
  async createGroup(name: string): Promise<string> {
    const startingPageRoles = ['read:pages', 'read:assets', 'read:comments']
    let result
    try {
      result = await CARDINAL.db
        .insert(groupsTable)
        .values({
          name,
          permissions: [],
          rules: [
            {
              id: crypto.randomUUID(),
              name: 'Default Rule',
              roles: startingPageRoles,
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ],
          isSystem: false
        })
        .returning({ id: groupsTable.id })
    } catch (err: any) {
      throw this.nameTakenError(err, name)
    }
    await this.broadcastReload()
    return result[0].id
  }

  private nameTakenError(err: unknown, name: string): unknown {
    return isUniqueViolation(err) ? groupNameTaken(name) : err
  }

  /**
   * For the 2.5.x importer (`migration/importers/users-groups.ts`): takes already-converted
   * `permissions` and `rules` instead of seeding defaults. Always non-system — the importer skips a
   * source's own system groups, which `init()` has already seeded.
   */
  async createGroupFromImport(input: {
    name: string
    permissions: string[]
    rules: GroupRule[]
  }): Promise<string> {
    for (let attempt = 1; attempt <= MAX_IMPORT_NAME_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? input.name : suffixedGroupName(input.name, attempt)
      try {
        const result = await CARDINAL.db
          .insert(groupsTable)
          .values({
            name,
            permissions: input.permissions,
            rules: input.rules,
            isSystem: false
          })
          .returning({ id: groupsTable.id })
        await this.broadcastReload()
        return result[0].id
      } catch (err: any) {
        if (!isUniqueViolation(err)) {
          throw err
        }
      }
    }
    throw groupNameTaken(input.name)
  }

  async getAllGroups(): Promise<GroupWithUserCount[]> {
    const results = await CARDINAL.db
      .select(groupSelection)
      .from(groupsTable)
      .leftJoin(userGroups, eq(userGroups.groupId, groupsTable.id))
      .groupBy(groupsTable.id)
      .orderBy(groupsTable.name)
    return results as GroupWithUserCount[]
  }

  /**
   * Whether any of the given ids does not name a real group on this instance.
   *
   * A route handler asks this because `setUserGroups` and friends resolve their input with
   * `inArray` and silently keep only the rows that came back — deliberately lenient there, since
   * IdP enrolment maps provider groups that may not exist locally. A stale client naming a deleted
   * group should be told, not have the id quietly dropped.
   */
  async hasUnknownGroupIds(groupIds: string[]): Promise<boolean> {
    const wanted = [...new Set(groupIds)]
    if (wanted.length < 1) {
      return false
    }
    const found = await CARDINAL.db
      .select({ id: groupsTable.id })
      .from(groupsTable)
      .where(inArray(groupsTable.id, wanted))
    return found.length < wanted.length
  }

  async getGroupById(id: string): Promise<GroupWithUserCount | null> {
    const results = await CARDINAL.db
      .select(groupSelection)
      .from(groupsTable)
      .leftJoin(userGroups, eq(userGroups.groupId, groupsTable.id))
      .where(eq(groupsTable.id, id))
      .groupBy(groupsTable.id)
      .limit(1)
    return (results[0] as GroupWithUserCount) ?? null
  }

  async updateGroup(id: string, patch: GroupPatch): Promise<boolean> {
    let result
    try {
      result = await CARDINAL.db
        .update(groupsTable)
        .set({ ...this.clampGuestPatch(id, this.normalizeRulePaths(patch)), updatedAt: sql`now()` })
        .where(eq(groupsTable.id, id))
    } catch (err: any) {
      throw this.nameTakenError(err, patch.name ?? '')
    }
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Belt and braces alongside `helpers/pageRules.ts#ruleMatchesPage`'s own case-fold: a rule's
   * `path` goes through the normalization a page's own path is stored under, for the match kinds
   * that compare directly against it. REGEX addresses a pattern rather than a literal path, and
   * CLASSIFICATION does not read `path` at all, so both are left untouched.
   *
   * `tags` are normalized whatever the `match`, so a rule switched away from TAG/TAGALL keeps a
   * clean array.
   */
  private normalizeRulePaths(patch: GroupPatch): GroupPatch {
    if (!patch.rules) {
      return patch
    }
    return {
      ...patch,
      rules: patch.rules.map((rule) => {
        const withPath =
          rule.match === 'START' || rule.match === 'END' || rule.match === 'EXACT'
            ? { ...rule, path: normalizePagePath(rule.path) }
            : rule
        return rule.tags ? { ...withPath, tags: normalizeRuleTags(rule.tags) } : withPath
      })
    }
  }

  /**
   * Hold the guests group to `GUEST_ROLES`. Enforced here rather than only in the admin screen that
   * edits the rules: what a group may hold is not something a browser should be the only one
   * deciding.
   *
   * Roles outside the set are dropped rather than refused, so a save yields the group asked for
   * minus what may not be granted, instead of a form that cannot be saved and does not say which
   * rule is at fault.
   */
  private clampGuestPatch(id: string, patch: GroupPatch): GroupPatch {
    if (id !== CARDINAL.data.systemIds.guestsGroupId || !patch.rules) {
      return patch
    }
    let dropped = 0
    const rules = patch.rules.map((rule) => {
      const roles = (rule.roles ?? []).filter((role) => GUEST_ROLES.includes(role))
      dropped += (rule.roles ?? []).length - roles.length
      return { ...rule, roles }
    })
    if (dropped > 0) {
      CARDINAL.logger.warn(
        'auth',
        'dropped permissions that may not be granted to the guests group',
        {
          dropped
        }
      )
    }
    return { ...patch, rules }
  }

  /**
   * Member sessions are ended BEFORE the delete, not after: `clearSessionsForGroup` resolves
   * members by reading `userGroups`, whose rows cascade away with the group. Done here rather than
   * in the route handler so it holds for every caller.
   */
  async deleteGroup(id: string): Promise<boolean> {
    await CARDINAL.models.sessions.clearSessionsForGroup(id)
    const result = await CARDINAL.db.delete(groupsTable).where(eq(groupsTable.id, id))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Why this user may not be a member of this group, or null when the membership is fine.
   *
   * The guests group and the guest account belong to each other and to nothing else:
   *
   *   - the group IS anonymous access, so a real user in it would be granted whatever the public is
   *     granted regardless of their own groups;
   *   - the account IS the anonymous visitor, so putting it in another group hands that group's
   *     permissions to everybody who never logged in.
   */
  guestMembershipViolation(groupId: string, user: { isSystem?: boolean } | null): string | null {
    const isGuestsGroup = groupId === CARDINAL.data.systemIds.guestsGroupId
    // -> The guest account is the only system user; see the seeding in `models/users.ts`
    if (user?.isSystem) {
      return isGuestsGroup
        ? null
        : 'The guest account cannot be a member of any group other than the guests group.'
    }
    return isGuestsGroup
      ? 'The guests group holds the guest account and nothing else — it is what anonymous visitors are.'
      : null
  }

  async assignUserToGroup(groupId: string, userId: string): Promise<boolean> {
    const user = await CARDINAL.models.users.getById(userId)
    const violation = this.guestMembershipViolation(groupId, user)
    if (violation) {
      throw new CustomError('groupMembershipForbidden', violation)
    }
    const result = await CARDINAL.db
      .insert(userGroups)
      .values({ userId, groupId })
      .onConflictDoNothing()
    return (result.rowCount ?? 0) > 0
  }

  async unassignUserFromGroup(groupId: string, userId: string): Promise<boolean> {
    /*
      The one membership that cannot be taken apart: anonymous access resolves against the guests
      group's rules, and the guest account is what resolves it. Removed, every anonymous visitor would
      hold nothing at all — and nothing in the interface puts a system user back into a group.
    */
    if (groupId === CARDINAL.data.systemIds.guestsGroupId) {
      const user = await CARDINAL.models.users.getById(userId)
      if (user?.isSystem) {
        throw new CustomError(
          'groupMembershipForbidden',
          'The guest account cannot be removed from the guests group.'
        )
      }
    }
    const result = await CARDINAL.db
      .delete(userGroups)
      .where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)))
    return (result.rowCount ?? 0) > 0
  }

  async getGroupUsers(
    groupId: string,
    { filter = '', page = 1, limit = 20 }: { filter?: string; page?: number; limit?: number } = {}
  ): Promise<UserPage> {
    const conditions = [eq(userGroups.groupId, groupId)]
    if (filter) {
      const pattern = `%${escapeLikePattern(filter)}%`
      conditions.push(or(ilike(usersTable.name, pattern), ilike(usersTable.email, pattern))!)
    }
    const where = and(...conditions)

    const { total, rows } = await paginate({
      rows: () =>
        CARDINAL.db
          .select(userSelection)
          .from(userGroups)
          .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
          .where(where)
          .orderBy(usersTable.name)
          .limit(limit)
          .offset((page - 1) * limit),
      total: () =>
        CARDINAL.db
          .select({ total: count() })
          .from(userGroups)
          .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
          .where(where)
    })

    return { total, users: rows }
  }

  async countUsersInGroup(groupId: string): Promise<number> {
    return CARDINAL.db.$count(userGroups, eq(userGroups.groupId, groupId))
  }

  async isUserInGroup(groupId: string, userId: string): Promise<boolean> {
    const total = await CARDINAL.db.$count(
      userGroups,
      and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId))
    )
    return total > 0
  }

  /**
   * `manage:system` bypasses every route check, so a `manage:users` / `manage:groups` holder who
   * could hand it out — or take it away, or edit the account of somebody who has it — would hold it
   * in all but name. The guards built on this answer are what stop that.
   */
  holdsSystemPermission(req: FastifyRequest): boolean {
    return this.actorForRequest(req).permissions.includes(SYSTEM_PERMISSION)
  }

  /**
   * Every group carrying `manage:system`, plus the root administrators group
   * (`CARDINAL.config.auth.rootAdminGroupId`) whether or not its row carries it: losing the ability
   * to grant `manage:system` back is unrecoverable, so this is the one definition of "never touch
   * this group without already holding `manage:system`".
   */
  async systemGroupIds(): Promise<string[]> {
    const rows = await CARDINAL.db
      .select({ id: groupsTable.id, permissions: groupsTable.permissions })
      .from(groupsTable)
    const ids = new Set(
      rows
        .filter((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
        .map((row) => row.id)
    )
    const rootAdminGroupId = CARDINAL.config?.auth?.rootAdminGroupId
    if (rootAdminGroupId) {
      ids.add(rootAdminGroupId)
    }
    return [...ids]
  }

  /**
   * Whether a user is protected by `manage:system` — i.e. belongs to any group carrying it.
   *
   * Membership rather than the session's own list, because the question is asked ABOUT somebody who
   * is not the caller and may not be logged in at all.
   */
  async userHoldsSystemPermission(userId: string): Promise<boolean> {
    const rows = await CARDINAL.db
      .select({ permissions: groupsTable.permissions })
      .from(userGroups)
      .innerJoin(groupsTable, eq(groupsTable.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
    return rows.some((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
  }
}

export const groups = new Groups()
