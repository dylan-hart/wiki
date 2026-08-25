import crypto from 'node:crypto'
import { and, count, eq, ilike, or, sql } from 'drizzle-orm'
import { groups as groupsTable, userGroups, users as usersTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { resolvePageRule, type RulePageRef } from '../helpers/pageRules.ts'
import { resolveSiteRule } from '../helpers/siteRules.ts'
import type { SystemIds } from './types.ts'
import type { FastifyRequest } from 'fastify'

/** The permission that bypasses every check, and the one the guards below exist to protect. */
export const SYSTEM_PERMISSION = 'manage:system'

/**
 * How a rule's `path` is compared against the page path. `CLASSIFICATION` is the odd one out
 * (OpenProject #1079): it does not read `path` at all, and matches page metadata that survives a
 * move/rename rather than the page's address -- see `classifications` on `GroupRule` and
 * `ruleMatchesPage` in `helpers/pageRules.ts`.
 */
export type GroupRuleMatch =
  | 'START'
  | 'END'
  | 'REGEX'
  | 'TAG'
  | 'TAGALL'
  | 'EXACT'
  | 'CLASSIFICATION'

/** Whether a matching rule grants, denies, or unconditionally grants its roles. */
export type GroupRuleMode = 'ALLOW' | 'DENY' | 'FORCEALLOW'

/** A single page-rule entry within a group. */
export interface GroupRule {
  id: string
  name: string
  roles: string[]
  match: GroupRuleMatch
  mode: GroupRuleMode
  path: string
  locales: string[]
  sites: string[]
  /**
   * Classification level ids this rule addresses -- read only when `match === 'CLASSIFICATION'`, the
   * same way `path` is read as a comma list only for `TAG`/`TAGALL`. A separate field rather than
   * reusing `path`, because a level is an id from the admin-configurable
   * `WIKI.models.classificationLevels` list, not free text a rule author types.
   */
  classifications?: string[]
}

/** A group row, joined with the number of users assigned to it. */
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

/** The subset of group fields that may be modified. `isSystem` is deliberately absent. */
export interface GroupPatch {
  name?: string
  redirectOnLogin?: string
  redirectOnFirstLogin?: string
  redirectOnLogout?: string
  permissions?: string[]
  rules?: GroupRule[]
}

/**
 * Selection shared by getAllGroups() / getGroupById().
 *
 * `userCount` comes from a left join on `userGroups` aggregated per group, so groups with no members
 * count 0 rather than dropping out of the result.
 */
/** A member of a group, mirroring the `UserCore` API schema. */
export interface GroupUser {
  id: string
  name: string
  email: string
  hasAvatar: boolean
  isSystem: boolean
  isActive: boolean
  isVerified: boolean
  createdAt: Date
  updatedAt: Date
  lastLoginAt: Date | null
}

export interface GroupUserPage {
  total: number
  users: GroupUser[]
}

/**
 * Escape the LIKE wildcards `%` and `_` (and the escape character itself) so that a user-supplied
 * filter is matched literally. Values are still parameterized by the driver — this is about a `%`
 * in the filter silently matching everything, not about injection.
 */
function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

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

/**
 * Who is asking, and what they hold outside the page rules.
 *
 * `permissions` is the group-wide list — `manage:system`, `access:admin` and the rest — which is a
 * different thing from the page permissions the rules decide.
 *
 * `scope`, when present, is an API key's own scope narrowing (`ApiKeyIdentity.scope`,
 * `models/apiKeys.ts`) — `null`/absent means unrestricted (a session, or an unscoped key). It is
 * consulted directly by `checkAccess()`/`mayHoldPermissionSomewhere()`/`checkSiteAccess()` below,
 * on top of (not instead of) narrowing `permissions` itself: a scope narrows the GLOBAL permission
 * union that `narrowToScope()` already intersects before this actor is built, but `groupIds` is
 * still the key's full, unnarrowed group membership — the rule-pooling those three methods do from
 * `groupIds` would otherwise hand back every page/site permission the groups grant regardless of
 * scope (OpenProject #930). A scope can only take a permission away, never grant one the groups
 * didn't already hold, so a permission absent from `scope` is refused before any rule is even
 * resolved.
 *
 * `allowedClassifications`, when present, is the same key's per-level classification allow-set
 * (OpenProject #1205, replacing the earlier #1055 single-value ceiling) — a page permission is never
 * granted on a page whose classification is not in this set, regardless of what the groups' rules
 * say. Checked by `checkAccess()` only: it is page-blind everywhere else
 * (`mayHoldPermissionSomewhere()`, `checkSiteAccess()`) so there is no single page's classification to
 * compare the allow-set against.
 *
 * `siteId`, when present, is the same key's own site pin (`ApiKeyIdentity.siteId`,
 * `models/apiKeys.ts`) — `null`/absent means instance-wide (a session, or an unpinned key).
 * OpenProject #2189/#2199: this is the engine-level half of the site-pin fix, closing
 * `checkAccess()`/`checkSiteAccess()` themselves rather than relying only on the routing-layer
 * `preHandler` (`helpers/apiKeySite.ts#apiKeySitePinPreHandler`) to have already refused a
 * mismatched `:siteId`. Checked the same way `allowedClassifications` is: a ref whose own `siteId`
 * disagrees with the pin is refused before `manage:system` is even consulted, for the identical
 * reason -- a site pin is the administrator's own choice at mint time, not a page rule
 * `manage:system` is entitled to override.
 */
export interface AccessActor {
  groupIds: string[]
  permissions: string[]
  scope?: string[] | null
  allowedClassifications?: string[] | null
  siteId?: string | null
}

/**
 * The page permissions a rule on the GUESTS group may grant.
 *
 * Reading, and saying something in a comment. Everything else — writing or deleting a page, managing
 * assets or comments, reviewing suggestions — is an action attributable to somebody, and the guests
 * group is precisely the absence of a somebody.
 *
 * Mirrored in `GroupEditOverlay.vue`, which offers exactly these when the guests group is open. This
 * copy is the one that decides.
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
 * Every group's rules, by group id.
 *
 * Cached because a page permission is checked on every page read, and reading three rows out of the
 * database to answer it would put a query in front of every request. Reloaded whenever a group
 * changes, the same way the site configurations are.
 */
let rulesCache: Record<string, GroupRule[]> = {}

/**
 * Groups model
 */
class Groups {
  /**
   * Reload the page rules of every group into memory.
   *
   * Called at boot, after any local change to a group (see `broadcastReload()`), and on every other
   * cluster instance's `reloadGroups` event (see `subscribeToEvents()`) — so a group edit takes
   * effect on the next request rather than on the next login, everywhere, which matters: rules are
   * the whole of page access, and a revoked permission that waits for a logout is not revoked.
   */
  async reloadCache(): Promise<void> {
    const rows = await WIKI.db
      .select({ id: groupsTable.id, rules: groupsTable.rules })
      .from(groupsTable)
    rulesCache = {}
    for (const row of rows) {
      rulesCache[row.id] = (row.rules ?? []) as GroupRule[]
    }
    WIKI.logger.info(`Loaded page rules for ${rows.length} groups [ OK ]`)
  }

  /**
   * Reload this instance's own cache, then tell every other instance in the cluster to do the same.
   *
   * The write already happened in the database by the time a caller reaches this — what's left is
   * making every instance's in-memory cache agree with it, this one included. Never call
   * `WIKI.events.outbound.emit('reloadGroups')` directly, and never call it from inside
   * `reloadCache()` itself: `reloadCache()` also runs when `subscribeToEvents()`'s handler answers
   * *another* instance's event, and broadcasting from there would echo the event back around the
   * cluster forever.
   */
  private async broadcastReload(): Promise<void> {
    await this.reloadCache()
    WIKI.events.outbound.emit('reloadGroups')
  }

  /**
   * Subscribe to HA propagation events
   */
  subscribeToEvents(): void {
    WIKI.events.inbound.on('reloadGroups', async () => {
      await this.reloadCache()
    })
  }

  /** The pooled rules of a set of groups, which is what a permission is decided against. */
  rulesForGroups(groupIds: string[]): GroupRule[] {
    return groupIds.flatMap((id) => rulesCache[id] ?? [])
  }

  /**
   * Which groups a request speaks for.
   *
   * A verified API key carries its own `groupIds` (`ApiKeyIdentity`, `models/apiKeys.ts`) — an
   * admin-issued key's own `groups`, or a personal token owner's CURRENT groups, resolved live at
   * verification time — and is checked first. It stands in for a session, but it is never
   * `req.session.authenticated` (bearer tokens deliberately never touch the session, see `index.ts`'s
   * API-key hook), so before this, an API-key-authenticated request fell through to the `session`
   * branch (never true for one), landing on the guests-group fallback below regardless of what groups
   * the key actually carried: every page-rule check `checkAccess()`/`mayOnPage()` makes for an API key
   * was silently deciding against the PUBLIC's rules rather than the key's own. That was OpenProject
   * #827's bug: a key scoped to a group holding only `read:pages` (via a page rule, not the group-wide
   * list) still failed every GET, because this method hoisted it up to the guests group's rules
   * instead of its own.
   *
   * Absent both, an anonymous request is not group-less either: it is the guests group, whose rules
   * are how a wiki says what the public may see. Treating it as no groups at all would deny
   * everything, which is a different answer from the one the administrator configured.
   */
  groupIdsForRequest(req: FastifyRequest): string[] {
    if (req.apiKey) {
      return req.apiKey.groupIds
    }
    if (req.session?.authenticated && req.session.user?.id) {
      return req.session.groups ?? []
    }
    return [WIKI.data.systemIds.guestsGroupId]
  }

  /** The actor a request speaks for: its groups, and the group-wide permissions it holds. */
  actorForRequest(req: FastifyRequest): AccessActor {
    return {
      groupIds: this.groupIdsForRequest(req),
      // -> An API key stands in for a session and carries its own permissions, as it does in the
      //    route-level check
      permissions: req.apiKey?.permissions ?? req.session?.permissions ?? [],
      // -> A session has no scope concept at all (null = unrestricted); an API key's own narrowing,
      //    if any -- see the `AccessActor.scope` doc comment for what this gates.
      scope: req.apiKey?.scope ?? null,
      allowedClassifications: req.apiKey?.allowedClassifications ?? null,
      // -> Same treatment: a session has no site pin, only an API key can carry one
      siteId: req.apiKey?.siteId ?? null
    }
  }

  /**
   * The actor for a caller that speaks for no specific requester (OpenProject #1127) — the one caller
   * today is `models/rendering.ts`'s background re-render job, which reprocesses already-published
   * content generically rather than on behalf of any one reader. It resolves permission-gated content
   * (a glossary term's canonical-page link) the same way an anonymous visitor's own request would,
   * rather than skipping the check entirely.
   */
  guestActor(): AccessActor {
    return { groupIds: [WIKI.data.systemIds.guestsGroupId], permissions: [] }
  }

  /**
   * Whether `permission` survives this actor's scope narrowing, if it has one.
   *
   * `null`/absent scope is unrestricted (a session, or a key issued with no scope). A scope that IS
   * set can only take permissions away, so a permission missing from it is refused outright, before
   * any rule is even resolved — see the `AccessActor.scope` doc comment for why this has to sit
   * ahead of `rulesForGroups()` rather than trusting `permissions`/`groupIds` alone.
   */
  private withinScope(actor: AccessActor, permission: string): boolean {
    return !actor.scope || actor.scope.includes(permission)
  }

  /**
   * Whether this caller may do this to this page.
   *
   * The one place page permissions are decided. Everything page-scoped asks this rather than reading
   * the session's permission list, because that list says what a group was granted GLOBALLY and page
   * permissions are not granted that way — see `helpers/pageRules.ts` for how a rule is chosen.
   *
   * @param permission A single page permission, e.g. `read:pages` or `read:history`
   */
  checkAccess(actor: AccessActor, permission: string, page: RulePageRef): boolean {
    /*
      OpenProject #1205 (replacing the earlier #1055 single-value ceiling): a classification-scoped
      key/token may never be granted a page permission on a page whose classification is not in its
      `allowedClassifications` allow-set, regardless of what its groups' rules say, and regardless of
      whether the identity also happens to hold `manage:system` -- checked ahead of the
      `manage:system` bypass below on purpose. A credential narrowing is not a page rule an
      administrator can override by fiat; it is the administrator's OWN choice, made when the
      key/token was minted, and an administrator opting into a classification-scoped credential is
      asking for it to actually hold. Skipped when the page's own classification is unknown (`null`
      — an asset, a folder, a not-yet-existing page) rather than treated as a denial: there is
      nothing to compare the allow-set against, and this is a narrowing on top of the rules, not a
      rule itself, so it has no fail-closed obligation of its own the way a CLASSIFICATION rule
      match does in `helpers/pageRules.ts`.
    */
    if (
      actor.allowedClassifications != null &&
      page.classification != null &&
      !WIKI.models.classificationLevels.isAllowed(page.classification, actor.allowedClassifications)
    ) {
      return false
    }
    /*
      OpenProject #2189/#2199: the engine-level half of the API key site-pin fix -- a key pinned to
      one site may never be granted a page permission on a page belonging to another, regardless of
      what its groups' rules say and regardless of `manage:system`, for the identical reason the
      classification check above already runs ahead of that bypass. The routing-layer `preHandler`
      (`helpers/apiKeySite.ts`) already refuses a mismatched `:siteId` on every `/sites/:siteId/...`
      route, but this closes the engine itself for any call path that reaches `checkAccess()`
      without going through that hook. Skipped when the page's own `siteId` is unknown (`null`) for
      the same reason the classification check is: there is nothing to compare the pin against.
    */
    if (actor.siteId != null && page.siteId != null && actor.siteId !== page.siteId) {
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
   * Whether this actor holds any of these page permissions ANYWHERE — deliberately coarse and
   * path-blind, for a caller that spans many pages at once (search is the only one today) and so
   * has no single page to ask `checkAccess()` about.
   *
   * Page permissions are granted by rules, not by the group-wide `permissions` list (same caveat as
   * `checkAccess()` above) — so this pools every rule across the actor's groups and asks whether any
   * non-DENY one grants the permission somewhere, rather than reading `actor.permissions` for a page
   * permission's name, which it never legitimately holds.
   *
   * Ignoring DENY (rather than resolving each rule the way `checkAccess()` does) is deliberate: the
   * question here is "is this actor generally the kind of person who holds `permission`", not "may
   * they use it on a particular page" — a rule that denies it under one subtree does not change the
   * answer for the rest of the site.
   *
   * @param siteId (OpenProject #2162) The site the answer is being asked FOR, or `null` when the
   *   caller genuinely has none (the icon picker's `mayUseIconPicker()` is the one caller today —
   *   it is asking "is this actor generally an author anywhere on the instance", not about one
   *   site). A concrete `siteId` applies the same `rule.sites` match filter `ruleMatchesPage()`
   *   applies for a real page: a rule scoped to other sites only does not count. `null` applies NO
   *   site filter at all — every rule counts, regardless of its own `sites` list — which is the
   *   opposite of `ruleMatchesPage()`'s fail-closed treatment of an unknown site on purpose: there
   *   this is a narrowing applied to a concrete page whose site really is unknown, whereas here
   *   `null` means the question itself is legitimately global, not that the site is unknown.
   */
  mayHoldPermissionSomewhere(
    actor: AccessActor,
    permissions: string[],
    siteId: string | null
  ): boolean {
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    // -> Same scope narrowing as `checkAccess()`, applied before any rule is read rather than after —
    //    a scoped key must not read as "generally holds `permission`" for a name outside its own
    //    scope, whatever its groups' rules say.
    //
    //    DECISION (OpenProject #2121): `allowedClassifications` deliberately applies NO narrowing
    //    here, and `manage:system` deliberately stays a full bypass, unlike the reordering
    //    `checkAccess()` now applies. The two methods differ in what they are answering:
    //    `checkAccess()` decides whether a permission may be used on ONE concrete page, so a
    //    classification-scoped credential can be compared against that page's actual
    //    classification and correctly refused even for a `manage:system` holder. This method
    //    answers a page-blind, structurally coarser question ("does this identity generally hold
    //    this kind of role at all") with no page to compare a classification against — an empty
    //    `allowedClassifications` allow-set does NOT imply "denied on every page", because
    //    `checkAccess()`'s classification narrowing only applies when the page's own
    //    classification is non-null, so an unclassified page stays reachable regardless of how
    //    narrow the allow-set is. Any page-blind approximation here would therefore either produce
    //    false negatives (blocking a generically-held capability flag a real page could still
    //    grant) or no real security benefit, since actual content access is always re-checked
    //    per-page by `checkAccess()`, which DOES apply the narrowing correctly. Leaving this
    //    method coarse and letting `checkAccess()` be the sole enforcement point is the considered
    //    choice, not an oversight.
    const inScope = permissions.filter((permission) => this.withinScope(actor, permission))
    if (inScope.length === 0) {
      return false
    }
    const rules = this.rulesForGroups(actor.groupIds).filter(
      (rule) => siteId === null || !rule.sites?.length || rule.sites.includes(siteId)
    )
    return inScope.some((permission) =>
      rules.some((rule) => rule.mode !== 'DENY' && rule.roles.includes(permission))
    )
  }

  /**
   * Whether this caller may administer this site.
   *
   * The site-scoped counterpart to `checkAccess()`: the same rule rows, the same pooling across an
   * actor's groups, but addressed by `sites` alone instead of `path`/`match`/`locales` — see
   * `helpers/siteRules.ts` for how a rule is chosen. `permission` is one of `SITE_PERMISSIONS`.
   *
   * @param permission A single site-admin permission, e.g. `site:theme`
   * @param siteId The site being administered
   */
  checkSiteAccess(actor: AccessActor, permission: string, siteId: string): boolean {
    // -> Same site-pin guard as checkAccess(), ahead of manage:system for the same reason -- see
    //    that method's own comment (OpenProject #2189/#2199)
    if (actor.siteId != null && actor.siteId !== siteId) {
      return false
    }
    // -> Above the rules entirely, same guard as checkAccess()
    if (actor.permissions.includes('manage:system')) {
      return true
    }
    if (!this.withinScope(actor, permission)) {
      return false
    }
    const rule = resolveSiteRule(this.rulesForGroups(actor.groupIds), permission, siteId)
    return rule ? rule.mode !== 'DENY' : false
  }

  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.info('Inserting default groups...')

    await WIKI.db.insert(groupsTable).values([
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
        permissions: ['read:pages', 'read:assets', 'read:comments'],
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
        permissions: ['read:pages', 'read:assets', 'read:comments'],
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
   * Create a new (non-system) group, seeded with the same starting permissions and default rule as
   * the `Users` group.
   *
   * @param name Group name
   * @returns The new group's ID
   */
  async createGroup(name: string): Promise<string> {
    const startingPermissions = ['read:pages', 'read:assets', 'read:comments']
    const result = await WIKI.db
      .insert(groupsTable)
      .values({
        name,
        permissions: startingPermissions,
        rules: [
          {
            id: crypto.randomUUID(),
            name: 'Default Rule',
            roles: startingPermissions,
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
    await this.broadcastReload()
    return result[0].id
  }

  /**
   * Create a group from an already-converted 2.x source record (Feature 414, Task 730).
   *
   * Mirrors `createGroup()`'s insert-then-`reloadCache()` shape, but — unlike `createGroup()`, which
   * always seeds the same starting `permissions`/default rule for a brand-new group — takes the
   * caller's own `permissions` and `rules`, already converted from a 2.x source group's flat
   * `permissions` array and `pageRules` array by the Users/Groups importer
   * (`migration/importers/users-groups.ts`'s `createGroupConverter()`).
   *
   * Always non-system: 3.0's own system groups (Administrators/Users/Guests) are seeded once by
   * `init()`, and a 2.x source's own Administrators/Users/Guests groups are never routed through this
   * method — `createGroupConverter()` skips them before a row is ever built.
   *
   * @returns The new group's ID
   */
  async createGroupFromImport(input: {
    name: string
    permissions: string[]
    rules: GroupRule[]
  }): Promise<string> {
    const result = await WIKI.db
      .insert(groupsTable)
      .values({
        name: input.name,
        permissions: input.permissions,
        rules: input.rules,
        isSystem: false
      })
      .returning({ id: groupsTable.id })
    await this.broadcastReload()
    return result[0].id
  }

  /**
   * Fetch all groups, ordered by name
   */
  async getAllGroups(): Promise<GroupWithUserCount[]> {
    const results = await WIKI.db
      .select(groupSelection)
      .from(groupsTable)
      .leftJoin(userGroups, eq(userGroups.groupId, groupsTable.id))
      .groupBy(groupsTable.id)
      .orderBy(groupsTable.name)
    return results as GroupWithUserCount[]
  }

  /**
   * Fetch a single group by ID
   *
   * @param id Group ID
   * @returns The group, or null if no such group exists
   */
  async getGroupById(id: string): Promise<GroupWithUserCount | null> {
    const results = await WIKI.db
      .select(groupSelection)
      .from(groupsTable)
      .leftJoin(userGroups, eq(userGroups.groupId, groupsTable.id))
      .where(eq(groupsTable.id, id))
      .groupBy(groupsTable.id)
      .limit(1)
    return (results[0] as GroupWithUserCount) ?? null
  }

  /**
   * Update a group
   *
   * @param id Group ID
   * @param patch Fields to change — must not be empty
   * @returns Whether a group was updated
   */
  async updateGroup(id: string, patch: GroupPatch): Promise<boolean> {
    const result = await WIKI.db
      .update(groupsTable)
      .set({ ...this.clampGuestPatch(id, patch), updatedAt: sql`now()` })
      .where(eq(groupsTable.id, id))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Hold the guests group to what the public may be given.
   *
   * The guests group is every anonymous reader at once, so a rule on it is a rule about the open
   * internet: writing a page, deleting one, reading its source history — none of those are things to
   * hand out to nobody in particular, and several of them cannot be undone. So the set is fixed here,
   * beside the rules themselves, rather than only in the admin screen that edits them: what a group
   * may hold is not something a browser should be the only one deciding.
   *
   * Roles outside the set are dropped rather than refused. An administrator saving a group edited
   * before this existed — or through the API — gets the group they asked for minus what may not be
   * granted, instead of a form that cannot be saved and does not say which rule is at fault.
   */
  private clampGuestPatch(id: string, patch: GroupPatch): GroupPatch {
    if (id !== WIKI.data.systemIds.guestsGroupId || !patch.rules) {
      return patch
    }
    let dropped = 0
    const rules = patch.rules.map((rule) => {
      const roles = (rule.roles ?? []).filter((role) => GUEST_ROLES.includes(role))
      dropped += (rule.roles ?? []).length - roles.length
      return { ...rule, roles }
    })
    if (dropped > 0) {
      WIKI.logger.warn(
        `Dropped ${dropped} permission(s) from the guests group that may not be granted to it.`
      )
    }
    return { ...patch, rules }
  }

  /**
   * Delete a group. Assignments in `userGroups` are removed by the FK cascade.
   *
   * @param id Group ID
   * @returns Whether a group was deleted
   */
  async deleteGroup(id: string): Promise<boolean> {
    const result = await WIKI.db.delete(groupsTable).where(eq(groupsTable.id, id))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Assign a user to a group. Idempotent.
   *
   * @returns False if the user was already a member
   */
  /**
   * Why this user may not be a member of this group, if they may not.
   *
   * The guests group and the guest account belong to each other and to nothing else:
   *
   *   - the group IS anonymous access, so a real user in it would be granted whatever the public is
   *     granted regardless of their own groups, and would keep it after every other group was taken
   *     away from them;
   *   - the account IS the anonymous visitor, so putting it in another group hands that group's
   *     permissions to everybody who never logged in.
   *
   * The pair is also why neither half can be taken apart: removing the account from the group would
   * leave anonymous access resolving against nothing, with no way back through the interface.
   *
   * One definition, used by the routes that assign a single membership and by `setUserGroups`, which
   * sets them all at once.
   *
   * @returns The reason, or null when the membership is fine
   */
  guestMembershipViolation(groupId: string, user: { isSystem?: boolean } | null): string | null {
    const isGuestsGroup = groupId === WIKI.data.systemIds.guestsGroupId
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
    const user = await WIKI.models.users.getById(userId)
    const violation = this.guestMembershipViolation(groupId, user)
    if (violation) {
      throw new CustomError('groupMembershipForbidden', violation)
    }
    const result = await WIKI.db
      .insert(userGroups)
      .values({ userId, groupId })
      .onConflictDoNothing()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Remove a user from a group
   *
   * @returns False if the user was not a member
   */
  async unassignUserFromGroup(groupId: string, userId: string): Promise<boolean> {
    /*
      The one membership that cannot be taken apart: anonymous access resolves against the guests
      group's rules, and the guest account is what resolves it. Removed, every anonymous visitor would
      hold nothing at all — and nothing in the interface puts a system user back into a group.
    */
    if (groupId === WIKI.data.systemIds.guestsGroupId) {
      const user = await WIKI.models.users.getById(userId)
      if (user?.isSystem) {
        throw new CustomError(
          'groupMembershipForbidden',
          'The guest account cannot be removed from the guests group.'
        )
      }
    }
    const result = await WIKI.db
      .delete(userGroups)
      .where(and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Fetch a page of the users assigned to a group, ordered by name.
   *
   * @param groupId Group ID
   * @param filter Optional case-insensitive substring matched against name and email
   * @param page 1-based page number
   * @param limit Page size
   */
  async getGroupUsers(
    groupId: string,
    { filter = '', page = 1, limit = 20 }: { filter?: string; page?: number; limit?: number } = {}
  ): Promise<GroupUserPage> {
    const conditions = [eq(userGroups.groupId, groupId)]
    if (filter) {
      const pattern = `%${escapeLikePattern(filter)}%`
      conditions.push(or(ilike(usersTable.name, pattern), ilike(usersTable.email, pattern))!)
    }
    const where = and(...conditions)

    const totals = await WIKI.db
      .select({ total: count() })
      .from(userGroups)
      .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
      .where(where)

    const users = await WIKI.db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        hasAvatar: usersTable.hasAvatar,
        isSystem: usersTable.isSystem,
        isActive: usersTable.isActive,
        isVerified: usersTable.isVerified,
        createdAt: usersTable.createdAt,
        updatedAt: usersTable.updatedAt,
        lastLoginAt: usersTable.lastLoginAt
      })
      .from(userGroups)
      .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
      .where(where)
      .orderBy(usersTable.name)
      .limit(limit)
      .offset((page - 1) * limit)

    return {
      total: totals[0]?.total ?? 0,
      users
    }
  }

  /**
   * Count the users assigned to a group
   */
  async countUsersInGroup(groupId: string): Promise<number> {
    return WIKI.db.$count(userGroups, eq(userGroups.groupId, groupId))
  }

  /**
   * Whether a user is currently assigned to a group
   */
  async isUserInGroup(groupId: string, userId: string): Promise<boolean> {
    const total = await WIKI.db.$count(
      userGroups,
      and(eq(userGroups.groupId, groupId), eq(userGroups.userId, userId))
    )
    return total > 0
  }

  /**
   * Whether the caller itself holds `manage:system`.
   *
   * `manage:system` is the permission that bypasses every route check, so a `manage:users` /
   * `manage:groups` holder who could hand it out — or take it away, or edit the account of somebody
   * who has it — would hold it in all but name. The guards built on this answer say so in their own
   * words rather than as a bare 403, because "you may manage users, but not THIS user" is not
   * something the caller can work out from a generic refusal.
   */
  holdsSystemPermission(req: FastifyRequest): boolean {
    return this.actorForRequest(req).permissions.includes(SYSTEM_PERMISSION)
  }

  /** The ids of every group carrying `manage:system`. */
  async systemGroupIds(): Promise<string[]> {
    const rows = await WIKI.db
      .select({ id: groupsTable.id, permissions: groupsTable.permissions })
      .from(groupsTable)
    return rows
      .filter((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
      .map((row) => row.id)
  }

  /**
   * Whether a user is protected by `manage:system` — i.e. belongs to any group carrying it.
   *
   * Membership rather than the session's own list, because the question is asked ABOUT somebody who
   * is not the caller and may not be logged in at all.
   */
  async userHoldsSystemPermission(userId: string): Promise<boolean> {
    const rows = await WIKI.db
      .select({ permissions: groupsTable.permissions })
      .from(userGroups)
      .innerJoin(groupsTable, eq(groupsTable.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
    return rows.some((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
  }
}

export const groups = new Groups()
