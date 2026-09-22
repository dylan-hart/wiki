import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AccessActor } from '../models/groups.ts'
import type { Page, PageActor } from '../models/pages.ts'
import { PAGE_PERMISSIONS } from './permissions.ts'

/** Comma-separated query lists, which is how the browser sends a multi-valued filter here. */
export function splitList(value?: string): string[] {
  return (
    value
      ?.split(',')
      .map((v) => v.trim())
      .filter(Boolean) ?? []
  )
}

/**
 * Who is saving, and what they may embed.
 *
 * A page records an author, so this needs a real user: a session, or a personal access token
 * (`req.apiKey.userId` set) acting as its owner. An admin-issued key has no user to attribute a page
 * to and resolves to `null`. `groupIds` and `siteId` travel along because `write:scripts`/
 * `write:styles` are resolved against group rules (`models/pages.ts`'s `hasPermission()`), and a
 * token pinned to one site must not gain them on another site's page.
 */
export function actorFrom(req: FastifyRequest): PageActor | null {
  if (req.apiKey?.userId) {
    return {
      id: req.apiKey.userId,
      permissions: req.apiKey.permissions,
      groupIds: req.apiKey.groupIds,
      scope: req.apiKey.scope,
      allowedClassifications: req.apiKey.allowedClassifications,
      siteId: req.apiKey.siteId
    }
  }
  if (!req.session?.authenticated || !req.session.user?.id) {
    return null
  }
  return {
    id: req.session.user.id,
    permissions: req.session.permissions ?? [],
    groupIds: CARDINAL.models.groups.groupIdsForRequest(req),
    scope: null
  }
}

/**
 * The caller's own user id, or `null` once a 401 has been sent (`if (!userId) { return reply }`).
 * Being logged in is the whole check; any page permission is the caller's own, separate one.
 */
export function requireActorId(
  req: FastifyRequest,
  reply: FastifyReply,
  message = 'This requires a logged in user.'
): string | null {
  const actor = actorFrom(req)
  if (!actor) {
    reply.unauthorized(message)
    return null
  }
  return actor.id
}

/**
 * Whether this requester may read a page's SOURCE, not just its rendered HTML.
 *
 * `write:pages` and `manage:pages` each imply `read:source`: an editor who cannot read the source
 * cannot open the editor at all. Every place that hands raw page content back asks this rather than
 * `mayOnPage(req, 'read:source', ...)` directly.
 */
export function mayReadSource(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): boolean {
  return mayReadSourceAs(CARDINAL.models.groups.actorForRequest(req), siteId, page)
}

export function mayReadSourceAs(
  actor: AccessActor,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): boolean {
  const ref = { ...page, classification: page.classification ?? null, siteId }
  return (
    CARDINAL.models.groups.checkAccess(actor, 'read:source', ref) ||
    CARDINAL.models.groups.checkAccess(actor, 'write:pages', ref) ||
    CARDINAL.models.groups.checkAccess(actor, 'manage:pages', ref)
  )
}

/**
 * Whether this requester's page permissions make a page's password irrelevant to them ON THIS PAGE:
 * an author or manager of the page is not asked for the password they themselves could remove.
 *
 * `PAGE_PASSWORD_BYPASS_ROLES` in `api/pages/read.ts` is the same two names asked site-wide, for
 * search, which has no single page to judge. With one page in hand, use this.
 */
export function mayBypassPassword(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): boolean {
  return mayOnPage(req, 'write:pages', siteId, page) || mayOnPage(req, 'manage:pages', siteId, page)
}

/**
 * Whether a page's password is already satisfied for this request. The unlock is recorded on the
 * server-side session, by page id, so nothing the browser can set decides this.
 */
export function unlockedFor(
  req: FastifyRequest,
  siteId: string,
  page: {
    id: string
    path: string
    locale: string | null
    tags?: string[]
    classification?: string | null
  }
): boolean {
  return (
    mayBypassPassword(req, siteId, page) || Boolean(req.session?.unlockedPages?.includes(page.id))
  )
}

/**
 * Whether this requester holds a page permission ON THIS PAGE.
 *
 * Page permissions come from a group's rules (`helpers/pageRules.ts`), not its group-wide permission
 * list, so the route-level `config.permissions` hook cannot answer this.
 *
 * `siteId` is a separate parameter rather than a field on `page` so a site-scoped rule is enforced
 * even when the caller builds its page ref inline.
 */
export function mayOnPage(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  page: {
    path: string
    locale: string | null
    tags?: string[]
    /** Absent for a page that does not exist yet (a create-permission check) -- see `RulePageRef`. */
    classification?: string | null
  }
): boolean {
  return CARDINAL.models.groups.checkAccess(
    CARDINAL.models.groups.actorForRequest(req),
    permission,
    {
      ...page,
      classification: page.classification ?? null,
      siteId
    }
  )
}

/**
 * Every page permission this requester holds at a path — what the interface hides its controls by.
 *
 * Resolved one at a time because each may be decided by a different rule. Anonymous included: the
 * guests group has rules of its own, and an empty list would hide controls a wiki deliberately
 * opened to everyone.
 */
export function pagePermissionsFor(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): string[] {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  if (actor.permissions.includes('manage:system')) {
    return PAGE_PERMISSIONS
  }
  return PAGE_PERMISSIONS.filter((permission) =>
    CARDINAL.models.groups.checkAccess(actor, permission, {
      ...page,
      classification: page.classification ?? null,
      siteId
    })
  )
}

/**
 * A page as this requester may see it, or null when they may not see it at all.
 *
 * An anonymous requester only reaches a published page. A password-protected page comes back with
 * `isLocked` set until the session has unlocked it, which the caller is expected to refuse on.
 *
 * `withContent` also loads raw `content`, which grants nothing by itself: the caller must still
 * check `mayReadSource` before handing it back. `withPassword` limits `hasPassword` to a requester
 * who may bypass the password anyway.
 */
export async function loadReadablePage(
  req: FastifyRequest,
  siteId: string,
  pageId: string,
  {
    withContent = false,
    withPassword = false
  }: { withContent?: boolean; withPassword?: boolean } = {}
): Promise<Page | null> {
  const actor = actorFrom(req)
  const page = await CARDINAL.models.pages.getPage({
    siteId,
    id: pageId,
    withContent,
    publicOnly: !actor,
    unlocked: (page) => unlockedFor(req, siteId, page),
    // -> `true` is `getPage`'s own default: `hasPassword` comes back for anyone, which is harmless
    //    only to a caller that never hands it on.
    withPassword: withPassword ? (page) => mayBypassPassword(req, siteId, page) : true
  })
  // -> Not readable is indistinguishable from not there, for anything hanging off the page
  if (!page || !mayOnPage(req, 'read:pages', siteId, page)) {
    return null
  }
  return page
}

/**
 * Shaped so a `permission` cannot be written without a `forbiddenMessage`: a bare
 * `reply.forbidden()` answers `'Forbidden'`, and only the caller knows what was refused. The first
 * member's `permission` is `string | undefined` yet REQUIRED, so a caller deciding it per request
 * still writes one call and still owes the message.
 */
type RequireReadablePageOptions = {
  withContent?: boolean
  allowLocked?: boolean
} & (
  | { permission: string | undefined; forbiddenMessage: string }
  | { permission?: undefined; forbiddenMessage?: undefined }
)

/**
 * `loadReadablePage`, plus the refusals of a page-scoped route, in a load-bearing order: missing OR
 * unreadable is 404 (never 403, which would confirm the page exists), then the caller's `permission`
 * is 403 with its own message, then a still-locked page is 403 — last, so a caller who fails the
 * permission never learns whether the page is locked.
 *
 * A route needing a different order calls this without `permission` and checks afterwards.
 * `allowLocked` is for a route that reveals no page body.
 *
 * Returns `null` once a reply has been sent: `if (!page) { return reply }`.
 */
export async function requireReadablePage(
  req: FastifyRequest,
  reply: FastifyReply,
  siteId: string,
  pageId: string,
  {
    permission,
    forbiddenMessage,
    withContent = false,
    allowLocked = false
  }: RequireReadablePageOptions = {}
): Promise<Page | null> {
  const page = await loadReadablePage(req, siteId, pageId, { withContent })
  if (!page) {
    reply.notFound('This page does not exist.')
    return null
  }
  if (permission && !mayOnPage(req, permission, siteId, page)) {
    reply.forbidden(forbiddenMessage)
    return null
  }
  if (!allowLocked && page.isLocked) {
    reply.forbidden('This page is password protected.')
    return null
  }
  return page
}

/**
 * Whether the caller holds an asset permission on an asset, judged on where it sits: assets live in
 * the same tree as pages, so a rule over a branch covers the files in it too.
 */
export function mayOnAsset(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  asset: { folderPath?: string | null; fileName: string; locale: string }
): boolean {
  return mayActorOnAsset(CARDINAL.models.groups.actorForRequest(req), permission, siteId, asset)
}

export function mayActorOnAsset(
  actor: AccessActor,
  permission: string,
  siteId: string,
  asset: { folderPath?: string | null; fileName: string; locale: string }
): boolean {
  const folder = asset.folderPath ?? ''
  return CARDINAL.models.groups.checkAccess(actor, permission, {
    path: folder ? `${folder}/${asset.fileName}` : asset.fileName,
    siteId,
    locale: asset.locale,
    // -> An asset carries no classification, so a CLASSIFICATION rule never matches one.
    classification: null
  })
}

/**
 * Whether the caller holds a page permission over a folder. A folder has no permissions of its own,
 * so its path is judged as a page's would be: a rule denying `read:pages` under a branch hides the
 * folder as well as the pages in it.
 */
export function mayOnFolder(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  path: string,
  locale: string
): boolean {
  return CARDINAL.models.groups.checkAccess(
    CARDINAL.models.groups.actorForRequest(req),
    permission,
    {
      path,
      siteId,
      locale,
      // -> No classification, as in `mayOnAsset`.
      classification: null
    }
  )
}

/**
 * The entries of a tree listing this caller may see.
 *
 * Filtered here rather than in the query: a page rule can be a regular expression or a set of tags,
 * so which rule decides an entry is only knowable per entry. A folder is judged on its own path, so
 * one whose contents are all denied but which no rule names stays listed and opens empty; hiding it
 * would mean resolving every descendant of every folder on every listing.
 */
export function visibleTreeItems<
  T extends {
    type?: string
    folderPath?: string
    fileName?: string
    classification?: string | null
  }
>(req: FastifyRequest, siteId: string, locale: string, items: T[]): T[] {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  return items.filter((item) => {
    const path = item.folderPath ? `${item.folderPath}/${item.fileName}` : (item.fileName ?? '')
    const permission = item.type === 'asset' ? 'read:assets' : 'read:pages'
    return CARDINAL.models.groups.checkAccess(actor, permission, {
      path,
      siteId,
      locale,
      tags: (item as any).tags ?? [],
      // -> Only a page-type item carries one.
      classification: item.classification ?? null
    })
  })
}
