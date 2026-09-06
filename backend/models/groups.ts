import crypto from 'node:crypto'
import { and, count, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { uniq } from 'es-toolkit/array'
import { groups as groupsTable, userGroups, users as usersTable } from '../db/schema.ts'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { CustomError, escapeLikePattern, normalizePagePath } from '../helpers/common.ts'
import { clearPageRuleRegexCache, resolvePageRule, type RulePageRef } from '../helpers/pageRules.ts'
import { paginate } from '../helpers/pagination.ts'
import { resolveSiteRule, ruleMatchesSite } from '../helpers/siteRules.ts'
import { userSelection } from './users.ts'
import type { UserPage } from './users.ts'
import type { SystemIds } from './types.ts'
import type { FastifyRequest } from 'fastify'

/** The permission that bypasses every check, and the one the guards below exist to protect. */
export const SYSTEM_PERMISSION = 'manage:system'

/**
 * How a rule's `path` is compared against the page path. `CLASSIFICATION` is the odd one out
 * (OpenProject #1079): it does not read `path` at all, and matches page metadata that survives a
 * move/rename rather than the page's address -- see `classifications` on `GroupRule` and
 * `ruleMatchesPage` in `helpers/pageRules.ts`.
 *
 * A runtime `as const` array rather than a bare union (no `enum` -- erasable syntax only, see
 * CLAUDE.md's TypeScript section). Module-private: it exists purely to derive `GroupRuleMatch` below,
 * and nothing outside this file reads it. What `api/schemas/group.ts`'s `GroupRule#` JSON Schema
 * imports is `GROUP_RULE_MATCH_VALUES` further down, which ajv can consume as a literal array -- see
 * `GROUP_RULE_MATCH_MEMBERS`'s own doc comment for how that one is pinned to this union at compile
 * time, and `api/schemas/group.test.ts` for the runtime half.
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
 * Every `GroupRuleMatch` member, derived from the type rather than restated as a bare array.
 * `api/schemas/group.ts`'s ajv `enum` needs a literal array -- ajv cannot read a TS union -- so this
 * is that array's single source of truth. The `Record<GroupRuleMatch, true>` literal is what pins the
 * two together: TypeScript's excess-property check on an object literal rejects both a missing member
 * and an extra one, so adding (or renaming) a `GroupRuleMatch` member without updating this literal is
 * a compile error rather than a silently-out-of-sync ajv enum -- which is exactly the drift task 2116
 * found (`CLASSIFICATION` was added to the type but never to the schema's `enum`).
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
 * say, and regardless of `manage:system` (OpenProject #2119: checked ABOVE that bypass, not below
 * it — a credential narrowing is not a page rule, and an administrator opting a token into this is
 * asking for it to hold even over their own admin rights). Checked by `checkAccess()` only: it is
 * page-blind everywhere else (`mayHoldPermissionSomewhere()`, `checkSiteAccess()`) so there is no
 * single page's classification to compare the allow-set against — see `mayHoldPermissionSomewhere()`'s
 * own doc comment for why widening there is safe rather than an oversight.
 *
 * `siteId`, when present and non-null, is an API key's own site pin (`ApiKeyIdentity.siteId`,
 * `models/apiKeys.ts`) — undefined/null means unrestricted (a session, or an instance-wide key).
 * OpenProject #2189/#2199: this is the engine-level half of the site-pin fix, closing
 * `checkAccess()`/`checkSiteAccess()` themselves rather than relying only on the routing-layer
 * `preHandler` (`helpers/apiKeySite.ts#apiKeySitePinHook`) to have already refused a mismatched
 * `:siteId`. Unlike `scope`/`allowedClassifications`, this is not a narrowing consulted alongside the
 * pooled rules: it is a hard boundary `checkAccess()` and `checkSiteAccess()` enforce BEFORE any rule
 * is resolved, refusing outright a `RulePageRef`/site id that differs from the pin — for the identical
 * reason the classification allow-set sits above `manage:system`, since a site pin is the
 * administrator's own choice at mint time, not a page rule `manage:system` is entitled to override.
 * Where the matching groups' rules carry an empty `rule.sites` (the default, granting every site),
 * nothing else inside the engine holds a pinned credential inside its own site — this is what closes
 * that gap centrally, rather than relying on every route to re-derive and check a `:siteId` path
 * parameter itself.
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
 * Memoised pool of `rulesForGroups()`, keyed on the sorted, comma-joined group id set.
 * `checkAccess`, `checkSiteAccess` and `mayHoldPermissionSomewhere` each call `rulesForGroups()` at
 * least once per request -- often once per item when a caller filters a list -- and pooling was a
 * fresh `flatMap` allocation on every single call. Rule order within the pooled array carries no
 * meaning (`helpers/pageRules.ts`'s module doc: "Order in the array means nothing"), so sorting the
 * key is safe and makes the same group set, passed in any order, share one memo entry.
 *
 * Cleared in `reloadCache()`, alongside `rulesCache` -- both `broadcastReload()` (this instance's own
 * writes) and the inbound `reloadGroups` event handler (another cluster instance's writes, see
 * `subscribeToEvents()`) call `reloadCache()` directly and exclusively, so clearing it there covers
 * both paths: a rule change is visible on the very next `checkAccess`, not just on this instance's own
 * writes.
 */
let rulesPoolCache: Record<string, GroupRule[]> = {}

/**
 * Groups model
 */
class Groups extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadGroups'

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
    rulesPoolCache = {}
    for (const row of rows) {
      rulesCache[row.id] = (row.rules ?? []) as GroupRule[]
    }
    // -> Compiled REGEX rule patterns are keyed by pattern text, not by rule identity -- dropping
    //    them here (rather than leaving them to accumulate) is what makes an edited pattern get
    //    recompiled promptly instead of the cache growing across every group edit an instance sees.
    clearPageRuleRegexCache()
    WIKI.logger.debug('config', 'reloaded the group page rules', { groups: rows.length })
  }

  /**
   * The pooled rules of a set of groups, which is what a permission is decided against.
   *
   * Memoised in `rulesPoolCache`, keyed on the sorted group id set -- see that variable's doc comment
   * for why the sort is safe and why `reloadCache()` alone is enough to invalidate it. The returned
   * array is shared across callers with the same group set: never mutate it.
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
      // -> A session has no site pin either (null = unrestricted); an API key's own pin, if any -- see
      //    the `AccessActor.siteId` doc comment for the hard boundary this enforces (OpenProject #2199).
      siteId: req.apiKey?.siteId ?? null
    }
  }

  /**
   * The actor for a caller that speaks for no specific requester (OpenProject #1127) — the one caller
   * today is `models/renderQueue.ts`'s background re-render job, which reprocesses already-published
   * content generically rather than on behalf of any one reader. It resolves permission-gated content
   * (a glossary term's canonical-page link) the same way an anonymous visitor's own request would,
   * rather than skipping the check entirely.
   */
  guestActor(): AccessActor {
    return { groupIds: [WIKI.data.systemIds.guestsGroupId], permissions: [] }
  }

  /**
   * The actor a specific user speaks for, resolved fresh from their CURRENT group membership rather
   * than from a session, a cached row, or an API key — for a caller that has only a stored `userId`
   * and nothing more, and needs today's answer rather than whatever it was when the caller last had a
   * session. Two motivating cases: OpenProject #2173, a page-watch notification queued once, at
   * CHANGE time, but sent — and re-read from the inbox — much later, where a watcher who has since
   * lost their group membership, or `read:pages` on the path specifically, must not go on receiving
   * or seeing it just because they were still a member when they first subscribed; and OpenProject
   * #2187, a caller that has to check what SOMEBODY ELSE is allowed, not the caller making the
   * request — `approveSubmission` resolving `write:scripts`/`write:styles` against the submitter who
   * wrote the markup, not the reviewer whose browser rendered it, since the submitter has no request
   * of their own for `actorForRequest()` to read.
   *
   * A user in no group at all (never assigned one, or every membership since removed) gets the empty
   * actor — no groups, no permissions — same as `checkAccess` would resolve for them directly.
   *
   * No `scope`/`allowedClassifications` narrowing here — those exist only for a session/API-key
   * caller's own narrowing (see `AccessActor`'s doc comment), and a user resolved by id has neither.
   */
  async actorForUserId(userId: string): Promise<AccessActor> {
    const groupIds = await WIKI.models.users.getUserGroupIds(userId)
    if (groupIds.length < 1) {
      return { groupIds: [], permissions: [] }
    }
    const rows = await WIKI.db
      .select({ permissions: groupsTable.permissions })
      .from(groupsTable)
      .where(inArray(groupsTable.id, groupIds))
    return {
      groupIds,
      permissions: uniq(rows.flatMap((row) => (row.permissions ?? []) as string[]))
    }
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
   * Whether `siteId` survives this actor's site pin, if it has one.
   *
   * `null`/absent `actor.siteId` is unrestricted (a session, or a key issued with no pin). A pin that
   * IS set refuses every OTHER site outright — see the `AccessActor.siteId` doc comment. `siteId` is
   * `null` for a page ref with no site context at all (a caller that generically has none — see
   * `RulePageRef`'s own doc comment on failing closed); a pinned actor fails closed there too, the
   * same as a site-scoped rule would against the same `null`.
   */
  private withinSitePin(actor: AccessActor, siteId: string | null): boolean {
    return !actor.siteId || actor.siteId === siteId
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
      OpenProject #2119 (moved above the `manage:system` short-circuit below; was #1205, replacing the
      earlier #1055 single-value ceiling): checked ABOVE the `manage:system` bypass below,
      deliberately -- a classification-scoped key/token may never be granted a page permission on a
      page whose classification is not in its `allowedClassifications` allow-set, regardless of what
      its groups' rules say, AND regardless of whether the holder is an administrator. A credential
      narrowing is not a page rule an administrator overrides by virtue of being an administrator: an
      admin who mints a classification-scoped token is asking for that scope to hold even over their
      own admin rights, so this has to sit ahead of the bypass below, not behind it. Skipped when the
      page's own classification is unknown (`null` — an asset, a folder, a not-yet-existing page)
      rather than treated as a denial: there is nothing to compare the allow-set against, and this is a
      narrowing on top of the rules, not a rule itself, so it has no fail-closed obligation of its own
      the way a CLASSIFICATION rule match does in `helpers/pageRules.ts`.
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
      without going through that hook. Delegates to `withinSitePin()`, which fails closed for a page
      ref with no site context at all (`null`) rather than treating it as nothing to compare against
      -- see that method's own doc comment for why an unknown site is not a pass for a pinned actor.
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
   * and path-blind, for a caller that spans many pages at once (the search route's
   * `includeDrafts`/`hideProtectedContent` switches; the icon picker's access gate, `api/icons.ts`)
   * and so has no single page to ask `checkAccess()` about.
   *
   * Site-scoped, unlike path: `siteId` is filtered the same fail-closed way
   * `helpers/pageRules.ts#ruleMatchesPage` filters a rule against one page's site — a rule whose own
   * `sites` is non-empty and does not name `siteId` is not counted, so a rule scoped to site A no
   * longer reads as "holds it somewhere" for a question asked about site B. An empty `sites` still
   * matches every site, same as everywhere else `rule.sites` is read. Pass `null` only when the
   * caller itself has no one site to ask about — `api/icons.ts`'s `mayUseIconPicker()` is the only
   * one today, since `/_api/icons` is not a site-scoped route — which skips the `sites` filter
   * entirely, same as before this method took a site at all.
   *
   * Page permissions are granted by rules, not by the group-wide `permissions` list (same caveat as
   * `checkAccess()` above) — so this pools every rule across the actor's groups and asks whether any
   * non-DENY, site-matching one grants the permission somewhere, rather than reading
   * `actor.permissions` for a page permission's name, which it never legitimately holds.
   *
   * Ignoring DENY (rather than resolving each rule the way `checkAccess()` does) is deliberate: the
   * question here is "is this actor generally the kind of person who holds `permission`", not "may
   * they use it on a particular page" — a rule that denies it under one subtree does not change the
   * answer for the rest of the site.
   *
   * `siteId`, unlike `path`, is NOT blind by design (OpenProject #2146/#2162): everywhere else
   * `rule.sites` is a fail-closed match filter (`helpers/pageRules.ts`'s `ruleMatchesPage`,
   * `helpers/siteRules.ts`'s `ruleMatchesSite`, reused below) — skipping it here let an actor whose
   * only `write:pages` rule was scoped to one site read as a writer for every other site it could
   * search at all, unlocking that other site's drafts and password-protected excerpts. Pass `null`
   * only when the caller genuinely has no site to ask about, the way the icon picker doesn't — icon
   * sets are instance-wide, not per-site (see CLAUDE.md's Icons section) — which reproduces the old,
   * always-site-blind behaviour for that one caller rather than silently narrowing it to nothing.
   *
   * OpenProject #2121: unlike `checkAccess()` (#2119), the `manage:system` short-circuit below is NOT
   * narrowed by `allowedClassifications`, and that is a decision, not an oversight — this method has
   * no page ref to compare the allow-set against (it is path- and page-blind by design, see above), so
   * the only options were widen (answer as if unrestricted) or refuse outright for any actor carrying
   * a non-null allow-set. Widening was chosen because every caller re-checks per row against a real
   * page with `checkAccess()` before that page's content is ever exposed, making this method's answer
   * a cheap upstream hint rather than the actual gate: `api/pages/read.ts`'s search route uses it only to
   * decide the coarse `includeDrafts`/`hideProtectedContent` flags, while the page-by-page visibility
   * filter every search backend applies (each `modules/search/<engine>/search.ts`'s own `visible`
   * filter) already calls `checkAccess(actor, 'read:pages', ...)` per candidate — so a
   * classification-restricted actor
   * still never sees a page outside its allow-set in a result, regardless of what this method answered
   * upstream. `mcp/auth.ts`'s `maySeeEverything()` mirrors that same search route. `api/icons.ts`'s
   * `mayUseIconPicker()` is the other caller, and gates something un-classified in the first place (an
   * icon search/materialize call, not a page read) — there is no page for the allow-set to narrow at
   * all. Refusing here instead would only make a classification-scoped actor's coarse pre-filter more
   * conservative than it needs to be, with no security difference, since the per-row check downstream
   * still holds the real line.
   *
   * @param siteId The site to scope the answer to, or `null` for a caller with no site in play at all
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
    //    choice, not an oversight. If a future caller ever uses this as the SOLE gate before
    //    returning page content — with no per-page `checkAccess()`/`mayOnPage()` following it —
    //    that caller is not safe under this decision and needs its own page-blind classification
    //    narrowing (or a per-row check) added.
    const inScope = permissions.filter((permission) => this.withinScope(actor, permission))
    if (inScope.length === 0) {
      return false
    }
    const rules = this.rulesForGroups(actor.groupIds).filter(
      (rule) => siteId == null || ruleMatchesSite(rule, siteId)
    )
    // -> No second site check here: the `ruleMatchesSite` filter above is that check, and repeating
    //    it inline can only ever agree with itself.
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
    /*
      OpenProject #2189/#2199 (OpenProject #2338: consolidated onto the single guard below -- this
      used to also be re-checked AFTER the `manage:system` bypass, which was dead code once this
      guard was in place ahead of it: by the time that second check ran, `actor.siteId` was already
      guaranteed either null or equal to `siteId`, so it could never actually refuse anything).
      Same site-pin guard as `checkAccess()`, ahead of `manage:system` for the same reason -- see
      that method's own comment. Delegates to `withinSitePin()`, matching `checkAccess()`'s shape.
    */
    if (!this.withinSitePin(actor, siteId)) {
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

  /**
   * Whether this request may administer one delegable settings surface of one site: the older,
   * site-blind global permission, OR the narrower `site:*` delegation a rule can grant per site.
   *
   * The one place that "or" is written. Every site-scoped admin surface answers the same shape of
   * question, and five route files each carried their own byte-identical copy of it —
   * `mayAdministerApprovals`, `mayManageBlocks`, `mayManageCredentials`, `canManageNavigation`,
   * `maySaveSiteImage` — each with its own paragraph saying the same thing (finding API-F3).
   *
   * `globalPermission` is checked first and site-blind, because that is what makes delegation
   * additive rather than a migration: an administrator who held `manage:sites` (or
   * `manage:navigation`) before any `site:*` permission existed keeps reaching every site's surface
   * exactly as they did, and a rule only ever hands the same surface to somebody narrower. Nothing
   * here can take a grant away — a DENY on a `site:*` rule stops that delegation, not the global
   * permission it sits beside. Because the global half is a group-wide permission it is not a rule,
   * and `siteId` therefore has nothing to say about it.
   *
   * The site half is `checkSiteAccess()` unchanged, so the site pin, the API-key scope boundary and
   * the `manage:system` bypass all apply to it exactly as they do everywhere else.
   *
   * @param globalPermission The pre-delegation group-wide permission, e.g. `manage:sites`
   * @param sitePermission The delegable `SITE_PERMISSIONS` entry, e.g. `site:blocks`
   * @param siteId The site being administered
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
    WIKI.logger.debug('config', 'seeding the default groups')

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
        // -> `permissions` is the GLOBAL, `GlobalPermission#`-validated list (OpenProject #1658) --
        //    page access for this group comes from `rules.roles` below, not from here. Seeding
        //    page-permission strings into this column (OpenProject #2555) made every fetch-then-PUT
        //    round trip of this group 400 the moment the schema was tightened.
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
        // -> Same as the Users group above -- global permissions, not page permissions, live here.
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
   * Create a new (non-system) group, seeded with the same default page-permission rule as the
   * `Users` group. `permissions` (the GLOBAL, `GlobalPermission#`-validated list) starts empty --
   * page access comes entirely from the seeded rule's `roles`, never from this column (OpenProject
   * #2555: these are two different closed vocabularies, and seeding page-permission strings into
   * `permissions` made every fetch-then-PUT round trip of a fresh group 400 once that column's
   * schema was tightened to the `GlobalPermission#` enum).
   *
   * @param name Group name
   * @returns The new group's ID
   */
  async createGroup(name: string): Promise<string> {
    const startingPageRoles = ['read:pages', 'read:assets', 'read:comments']
    const result = await WIKI.db
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
   * Whether any of the given ids does not name a real group on this instance.
   *
   * The one owner of "are these real group ids", asked from three places that each had their own
   * spelling: assigning a user's groups (`api/users/admin.ts`), naming the groups an API key draws its
   * permissions from (`api/apiKeys.ts`), and naming an approval rule's submitter/reviewer groups
   * (`api/approvals.ts`, which asked `models/approvals.ts` for the unknown ids and then only ever
   * checked whether the list was empty).
   *
   * A route handler asks this because `setUserGroups` and friends resolve their input with `inArray`
   * and silently keep only the rows that came back — deliberately lenient there, since IdP enrolment
   * maps provider groups that may not exist locally. A stale client naming a deleted group should be
   * told, not have the id quietly dropped, especially on a `PUT` that replaces membership wholesale.
   *
   * Duplicates are collapsed and an empty list is trivially all-known, so neither costs a query.
   */
  async hasUnknownGroupIds(groupIds: string[]): Promise<boolean> {
    const wanted = [...new Set(groupIds)]
    if (wanted.length < 1) {
      return false
    }
    const found = await WIKI.db
      .select({ id: groupsTable.id })
      .from(groupsTable)
      .where(inArray(groupsTable.id, wanted))
    return found.length < wanted.length
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
      .set({ ...this.clampGuestPatch(id, this.normalizeRulePaths(patch)), updatedAt: sql`now()` })
      .where(eq(groupsTable.id, id))
    await this.broadcastReload()
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Belt and braces alongside `helpers/pageRules.ts#ruleMatchesPage`'s own case-fold (OpenProject
   * #2182): fold a rule's `path` through the same normalization a page's own path is stored under
   * (`normalizePagePath`), for the match kinds that compare directly against it. TAG/TAGALL already
   * lowercase their own comma list at match time (`helpers/pageRules.ts#ruleTags`); REGEX addresses a
   * pattern rather than a literal path, and CLASSIFICATION does not read `path` at all -- both are
   * left untouched here for the same reason `ruleMatchesPage` leaves REGEX out of its fold.
   */
  private normalizeRulePaths(patch: GroupPatch): GroupPatch {
    if (!patch.rules) {
      return patch
    }
    return {
      ...patch,
      rules: patch.rules.map((rule) =>
        rule.match === 'START' || rule.match === 'END' || rule.match === 'EXACT'
          ? { ...rule, path: normalizePagePath(rule.path) }
          : rule
      )
    }
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
      WIKI.logger.warn('auth', 'dropped permissions that may not be granted to the guests group', {
        dropped
      })
    }
    return { ...patch, rules }
  }

  /**
   * Delete a group. Assignments in `userGroups` are removed by the FK cascade.
   *
   * Deleting a group is the strongest revocation an administrator can perform, so member
   * sessions are ended the same way a `permissions` change already is (OpenProject #936) --
   * and it has to happen BEFORE the delete, not after: `clearSessionsForGroup` resolves
   * members by reading `userGroups`, whose rows cascade away with the group itself. Doing
   * this here rather than in the `DELETE /:groupId` route handler means the invariant holds
   * for every caller (the MCP server included), not just that one route.
   *
   * @param id Group ID
   * @returns Whether a group was deleted
   */
  async deleteGroup(id: string): Promise<boolean> {
    await WIKI.models.sessions.clearSessionsForGroup(id)
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
  ): Promise<UserPage> {
    const conditions = [eq(userGroups.groupId, groupId)]
    if (filter) {
      const pattern = `%${escapeLikePattern(filter)}%`
      conditions.push(or(ilike(usersTable.name, pattern), ilike(usersTable.email, pattern))!)
    }
    const where = and(...conditions)

    const { total, rows } = await paginate({
      rows: () =>
        WIKI.db
          .select(userSelection)
          .from(userGroups)
          .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
          .where(where)
          .orderBy(usersTable.name)
          .limit(limit)
          .offset((page - 1) * limit),
      total: () =>
        WIKI.db
          .select({ total: count() })
          .from(userGroups)
          .innerJoin(usersTable, eq(usersTable.id, userGroups.userId))
          .where(where)
    })

    return { total, users: rows }
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

  /**
   * The ids of every group carrying `manage:system`, plus the root administrators group itself
   * (`WIKI.config.auth.rootAdminGroupId`) even on the off chance it is ever queried before that
   * permission is flattened onto it — losing the ability to grant `manage:system` back is
   * unrecoverable, so this list is the single shared definition of "never touch this group without
   * already holding `manage:system`" that both `api/users/admin.ts`'s membership-change guard and
   * `models/users.ts#syncProviderGroups`'s provider-group sync read from.
   */
  async systemGroupIds(): Promise<string[]> {
    const rows = await WIKI.db
      .select({ id: groupsTable.id, permissions: groupsTable.permissions })
      .from(groupsTable)
    const ids = new Set(
      rows
        .filter((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
        .map((row) => row.id)
    )
    const rootAdminGroupId = WIKI.config?.auth?.rootAdminGroupId
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
    const rows = await WIKI.db
      .select({ permissions: groupsTable.permissions })
      .from(userGroups)
      .innerJoin(groupsTable, eq(groupsTable.id, userGroups.groupId))
      .where(eq(userGroups.userId, userId))
    return rows.some((row) => ((row.permissions ?? []) as string[]).includes(SYSTEM_PERMISSION))
  }
}

export const groups = new Groups()
