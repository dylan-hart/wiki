import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Page, PageActor } from '../models/pages.ts'
import { PAGE_PERMISSIONS } from './permissions.ts'

/**
 * Page, asset and folder access helpers.
 *
 * Every page-scoped route answers the same handful of questions before it does anything else: who is
 * asking, what a group's RULES let them do on THIS page (not what their group-wide permission list
 * says — see CLAUDE.md's Permissions section), whether a password still stands between them and the
 * body, and what to reply when the answer is no. These used to live in `api/pages.ts`, `api/assets.ts`
 * and `api/tree.ts`, which meant `api/comments.ts`, `api/checklists.ts`, `api/watching.ts`,
 * `api/approvals.ts`, `api/tags.ts`, `api/notifications.ts`, `api/tree.ts` and `controllers/collab.ts`
 * all imported a route file to get at them. They are plain functions over `WIKI.models.groups`, not
 * routes, so they belong here — where a route file importing one no longer couples itself to another
 * route file's plugin.
 */

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
 * A page records an author, so this takes a real user — a session, or a personal access token
 * (`req.apiKey.userId` set), which acts as its owner for exactly this reason (see the design decision
 * in `models/apiKeys.ts`'s doc comment). An admin-issued key has no user behind it to attribute a page
 * to, so it still resolves to `null` here exactly as before — unchanged, not a regression: minting one
 * never granted page-saving either, since this returned `null` for every API key until personal
 * tokens existed to fill it with something real. `write:scripts`/`write:styles` are page-rule-scoped
 * (see CLAUDE.md's Permissions section), so `groupIds` travels along too — it is what
 * `models/pages.ts`'s `hasPermission()` resolves a page rule against, the same way `mayOnPage()` does
 * here. `siteId` travels along for the same reason (OpenProject #2189): a personal token pinned to
 * one site must not gain a `write:scripts`/`write:styles` grant on another's page through this path.
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
    groupIds: WIKI.models.groups.groupIdsForRequest(req),
    scope: null
  }
}

/**
 * The caller's own user id, or a refusal.
 *
 * For anything that belongs to an account rather than to a page: a watch is a list somebody comes back
 * to, a notification has to point at a recipient, a checklist run log has to attribute a check to
 * someone. There is no permission beyond being logged in — the page permission, where there is one, is
 * a separate check the caller makes itself.
 *
 * Follows the same "returns null once a reply is sent" convention as `requireReadablePage` below, so a
 * route's whole check is `const userId = requireActorId(req, reply); if (!userId) { return reply }`.
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
 * Whether this requester's page permissions make a page's password irrelevant to them ON THIS PAGE:
 * an author or manager of the page is not asked for the password they themselves could remove.
 *
 * Asked per page, through `mayOnPage`, which is what distinguishes it from `PAGE_PASSWORD_BYPASS_ROLES`
 * in `api/pages/read.ts` — the same two permission names, but asked site-wide via
 * `mayHoldPermissionSomewhere()` because search spans many pages with no single rule to consult. Where
 * there IS one page to judge, this is the check to use; see that constant's own doc comment for why
 * search deliberately settles for the coarser answer.
 */
export function mayBypassPassword(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): boolean {
  return mayOnPage(req, 'write:pages', siteId, page) || mayOnPage(req, 'manage:pages', siteId, page)
}

/**
 * Whether the password on a page has already been satisfied for this request.
 *
 * The unlock is recorded on the session — server side, by page id — so that reading a page the reader
 * unlocked a moment ago does not ask again, and so that nothing the browser can set decides this.
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
 * Page permissions are granted by a group's rules, not by the group-wide permission list, so this is
 * a different question from the one the route-level `config.permissions` hook answers — and the only
 * correct one for anything page-scoped. `helpers/pageRules.ts` sets out how a rule is chosen.
 *
 * `siteId` is a separate parameter rather than a field the caller sets on `page`, so that a rule
 * scoped to one site (see `RulePageRef` in `helpers/pageRules.ts`) is enforced even from a call site
 * that builds its page ref inline instead of passing along an already-fetched page.
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
  return WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), permission, {
    ...page,
    classification: page.classification ?? null,
    siteId
  })
}

/**
 * Every page permission this requester holds at a path.
 *
 * What the interface hides its controls by, and the reason it is a list rather than a question: each
 * permission may be decided by a different rule — a branch can be readable but not writable, and one
 * page within it neither — so they are resolved one at a time.
 *
 * Anonymous included: the guests group has rules of its own, and what the public may do is exactly
 * what they say. Answering an empty list for a reader without a session would hide controls a wiki had
 * deliberately opened to everyone.
 *
 * `siteId` is a separate parameter for the same reason as in `mayOnPage`: not every caller has a
 * fetched page with a `siteId` field on hand.
 */
export function pagePermissionsFor(
  req: FastifyRequest,
  siteId: string,
  page: { path: string; locale: string | null; tags?: string[]; classification?: string | null }
): string[] {
  const actor = WIKI.models.groups.actorForRequest(req)
  /*
    An administrator holds all of them, and holds them here too. Deriving the list from their
    permissions instead would answer `manage:system` → nothing ending in `:pages` → that an
    administrator has no rights over any page, which is the opposite of true.
  */
  if (actor.permissions.includes('manage:system')) {
    return PAGE_PERMISSIONS
  }
  return PAGE_PERMISSIONS.filter((permission) =>
    WIKI.models.groups.checkAccess(actor, permission, {
      ...page,
      classification: page.classification ?? null,
      siteId
    })
  )
}

/**
 * A page, as this requester is allowed to see it — or null when they are not allowed to see it at all.
 *
 * The gate for anything that hangs off a page but is not the page itself. An anonymous requester only
 * ever reaches a published page, and a password-protected one comes back with `isLocked` set until the
 * session has satisfied the unlock, which the caller is expected to refuse on.
 *
 * `withContent` asks the model to also load raw `content` — off by default, since most callers only
 * need `render` (already loaded either way). Loading it does not by itself grant anything: a caller
 * that turns it on is still responsible for checking `read:source` before handing `content` back, the
 * same way the GET route does.
 *
 * `withPassword` narrows what `getPage` would otherwise hand back unconditionally: left off, the
 * stored password travels with the row (`getPage`'s own default), which is what every caller that
 * never looks at it gets. Turned on, the password is included only for a requester who may bypass it
 * anyway — what the suggest-an-edit routes (`api/approvals.ts`) want, since they hand the page's
 * source to somebody who is about to edit it.
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
  const page = await WIKI.models.pages.getPage({
    siteId,
    id: pageId,
    withContent,
    publicOnly: !actor,
    unlocked: (page) => unlockedFor(req, siteId, page),
    // -> `getPage`'s own default is `true`: the stored password travels with the row, which is what
    //    every caller that never looks at it gets. `withPassword` narrows that to "only for a
    //    requester who may bypass it anyway", and is opt-in for exactly that reason.
    withPassword: withPassword ? (page) => mayBypassPassword(req, siteId, page) : true
  })
  // -> Not readable is indistinguishable from not there, for anything hanging off the page
  if (!page || !mayOnPage(req, 'read:pages', siteId, page)) {
    return null
  }
  return page
}

/**
 * `requireReadablePage`'s options, shaped so that a `permission` with no `forbiddenMessage` cannot be
 * written at all: the two travel together or not at all. `reply.forbidden()` with no message answers
 * a bare `'Forbidden'`, which for a page-permission refusal is exactly the unhelpful reply the
 * thirteen hand-written preambles this replaced each avoided by naming what was refused — a default
 * this helper has no way to supply, since only the caller knows what the caller was trying to do.
 *
 * The first member types `permission` as `string | undefined` rather than `string` so a caller that
 * decides the permission from the request (`api/pages/export.ts`'s export route asks for `read:source` only
 * when `format=markdown`) still writes one call rather than two — the key is still REQUIRED there, so
 * naming it at all is what obliges the message.
 */
type RequireReadablePageOptions = {
  withContent?: boolean
  allowLocked?: boolean
} & (
  | { permission: string | undefined; forbiddenMessage: string }
  | { permission?: undefined; forbiddenMessage?: undefined }
)

/**
 * `loadReadablePage`, plus the refusals every page-scoped route made by hand.
 *
 * The preamble this replaces was written out thirteen times, always in the same order and always with
 * the same two of its three messages: a page that is missing OR unreadable is 404 `'This page does not
 * exist.'` (never 403 — that would confirm the page exists to somebody who may not see it), a second,
 * different permission on top of `read:pages` is 403 with the caller's own wording, and a page still
 * behind its password is 403 `'This page is password protected.'`.
 *
 * That order is the contract, not an accident: the permission check runs on a page already known to be
 * readable, and the password check runs last so a caller who fails the permission never learns whether
 * the page is locked. A route needing a different order (`api/checklists.ts`'s check-off route, which
 * refuses a locked page before asking about `write:pages`) calls this without `permission` and makes
 * its own check afterwards, rather than bending the option.
 *
 * `permission` omitted means `read:pages` alone, which `loadReadablePage` has already enforced.
 * `allowLocked` is for the one route that deliberately does not care (`api/pages/read.ts`'s backlinks
 * listing, which reveals no page body).
 *
 * @returns The page, or `null` once a reply has been sent — so a route's whole preamble is
 *          `const page = await requireReadablePage(...); if (!page) { return reply }`.
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
 * Whether the caller holds an asset permission on an asset, judged on where it sits.
 *
 * Assets live in the same tree as pages and are addressed by the same rules — a rule over a branch
 * covers the files in it as well as the pages, which is why the asset permissions are offered
 * alongside the page ones in the group editor.
 */
export function mayOnAsset(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  asset: { folderPath?: string | null; fileName: string; locale: string }
): boolean {
  const folder = asset.folderPath ?? ''
  return WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), permission, {
    path: folder ? `${folder}/${asset.fileName}` : asset.fileName,
    siteId,
    locale: asset.locale,
    // -> An asset carries no classification of its own (OpenProject #1079 is a page metadata
    //    field) — a CLASSIFICATION rule never matches an asset, the same as any other unknown
    //    classification fails closed.
    classification: null
  })
}

/**
 * Whether the caller holds a page permission over a folder, judged on the folder's own path.
 *
 * A folder is not a page and has no permissions of its own, so what governs it is what governs the
 * branch it opens: a rule denying `read:pages` under `geography` hides the folder as well as the
 * pages in it, and only somebody who may reorganise pages there may rename or remove it.
 */
export function mayOnFolder(
  req: FastifyRequest,
  permission: string,
  siteId: string,
  path: string,
  locale: string
): boolean {
  return WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), permission, {
    path,
    siteId,
    locale,
    // -> A folder is not a page and carries no classification of its own -- same treatment as
    //    `mayOnAsset` above.
    classification: null
  })
}

/**
 * The entries of a tree listing this caller may see, and the folders leading to them.
 *
 * Filtered here rather than in the query for the same reason as everywhere else: a page rule can be a
 * regular expression or a set of tags, so which rule decides an entry is only knowable per entry.
 *
 * A folder is judged on its own path, so a DENY over a branch hides the branch itself rather than
 * leaving an empty folder to walk into. The consequence worth knowing is the other way round: a
 * folder stays listed when the rules deny everything inside it but say nothing about the folder, and
 * a reader opening it finds it empty. Hiding those would mean resolving every descendant of every
 * folder on every listing, which is not worth what it costs.
 */
export function visibleTreeItems<
  T extends {
    type?: string
    folderPath?: string
    fileName?: string
    classification?: string | null
  }
>(req: FastifyRequest, siteId: string, locale: string, items: T[]): T[] {
  const actor = WIKI.models.groups.actorForRequest(req)
  return items.filter((item) => {
    const path = item.folderPath ? `${item.folderPath}/${item.fileName}` : (item.fileName ?? '')
    const permission = item.type === 'asset' ? 'read:assets' : 'read:pages'
    return WIKI.models.groups.checkAccess(actor, permission, {
      path,
      siteId,
      locale,
      tags: (item as any).tags ?? [],
      // -> `getTree()` (OpenProject #1128) joins `pages.classification` in for a page-type item;
      //    a folder or asset carries none, the same "no CLASSIFICATION rule matches" null it always
      //    had.
      classification: item.classification ?? null
    })
  })
}
