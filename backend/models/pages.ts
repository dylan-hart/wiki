import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { pages as pagesTable, tree as treeTable, users as usersTable } from '../db/schema.ts'
import {
  CustomError,
  defaultLocale,
  generatePathHash,
  normalizePagePath,
  timingSafeCompare
} from '../helpers/common.ts'
import { rulesAllow } from '../helpers/pageRules.ts'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'
import type { PageHistoryVia } from './pageHistory.ts'
import type { RenderPermissions, TocNode } from './rendering.ts'
import type { DeletedEntry } from './tree.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { WikiDbOrTx, WikiTx } from '../core/db.ts'

/** What each editor produces, which is what the content column holds. */
const EDITOR_CONTENT_TYPES: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  wysiwyg: 'html',
  code: 'html',
  redirect: 'redirect'
}

/** The inverse of `EDITOR_CONTENT_TYPES`, e.g. `markdown` -> `markdown`, `html` -> `wysiwyg`. */
const CONTENT_TYPE_EDITORS: Record<string, string> = Object.fromEntries(
  Object.entries(EDITOR_CONTENT_TYPES).map(([editor, contentType]) => [contentType, editor])
)

/**
 * The editor a page created from a bare `contentType` (no editor of its own to ask) should be
 * attributed to — a file-backed storage target importing a page it did not create is the one caller
 * of this today: it knows the content type from the file extension, but not which editor produced
 * it. Falls back to `markdown`, the default a brand new page would get from the editor picker too.
 */
export function getEditorForContentType(contentType: string): string {
  return CONTENT_TYPE_EDITORS[contentType] ?? 'markdown'
}

/**
 * The editor whose pages send their reader somewhere else.
 *
 * A redirection is an ordinary page — it has a path, a title, an icon and a place in the tree, and is
 * browsable like any other — with nothing to read: no body, no render, and therefore nothing for the
 * search index to hold. What an author fills in is where it points, and that is what its content
 * column carries. See `normalizeRedirectContent`.
 */
const REDIRECT_EDITOR = 'redirect'

/** A page path is what ends up in a URL, so it is held to what reads and routes cleanly. */
const rePagePath = /^[a-zA-Z0-9-_/]*$/
const reAlias = /^[a-zA-Z0-9-_]*$/

/**
 * What `getPage`'s `unlocked`/`withPassword` callbacks are handed: enough of the row to ask
 * `mayOnPage()` whether a page rule applies, without exposing the whole raw row.
 */
export interface UnlockPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
}

/** Fields kept in the `config` blob rather than as columns, and flattened again on the way out. */
const CONFIG_FIELDS = [
  'allowComments',
  'allowContributions',
  'allowRatings',
  'showSidebar',
  'showTags',
  'showToc',
  'tocDepth'
] as const

/** A page as the API exposes it: the columns and both blobs, flattened into one object. */
export interface Page {
  id: string
  path: string
  hash: string
  alias: string | null
  title: string
  description: string | null
  icon: string | null
  locale: string
  editor: string
  contentType: string
  publishState: 'draft' | 'published' | 'scheduled'
  publishStartDate: Date | null
  publishEndDate: Date | null
  isBrowsable: boolean
  isSearchable: boolean
  /**
   * The page's password, if it has one. Present only for a requester who may edit the page — see
   * `getPage`'s `withPassword`. Absent, rather than null, for everyone else: a reader cannot tell a
   * page with no password from one whose password was withheld, and does not need to.
   */
  password?: string | null
  /** Whether the body was withheld because the page is password protected. See `getPage`. */
  isLocked: boolean
  relations: any[]
  tags: string[]
  toc: TocNode[]
  render: string
  /**
   * The source. Present when the request asked for it, and always for a redirection — see `toPage`,
   * and `RedirectContent` for what a redirection's holds.
   */
  content?: string
  allowComments: boolean
  allowContributions: boolean
  allowRatings: boolean
  showSidebar: boolean
  showTags: boolean
  showToc: boolean
  tocDepth: { min: number; max: number }
  scriptJsLoad: string
  scriptJsUnload: string
  scriptCss: string
  navigationId: string | null
  navigationMode: string
  authorId: string
  authorName: string
  createdAt: Date
  updatedAt: Date
  /** Classification level id (OpenProject #1079) -- never absent, there is no unclassified state. */
  classification: string
}

/** Everything a page can be created with. */
export interface PageInput {
  path: string
  title: string
  editor: string
  content: string
  /** The HTML the editor produced. Post-processed before it is stored — see `models/rendering.ts`. */
  render?: string
  locale?: string
  description?: string
  icon?: string
  alias?: string
  publishState?: 'draft' | 'published' | 'scheduled'
  publishStartDate?: string | null
  publishEndDate?: string | null
  isBrowsable?: boolean
  isSearchable?: boolean
  password?: string
  relations?: any[]
  tags?: string[]
  /**
   * Classification level id (OpenProject #1079). Absent on create defaults to the immediate parent
   * page's own level (or the most-open configured level, with no parent page to inherit from) — see
   * `resolveCreateClassification`. Absent on update leaves the page's classification untouched.
   */
  classification?: string
  allowComments?: boolean
  allowContributions?: boolean
  allowRatings?: boolean
  showSidebar?: boolean
  showTags?: boolean
  showToc?: boolean
  tocDepth?: { min: number; max: number }
  scriptJsLoad?: string
  scriptJsUnload?: string
  scriptCss?: string
  /**
   * Why this save is being made, as the editor's reason-for-change prompt collected it. Not a page
   * field: it belongs to the version this save produces, and is recorded on the history row.
   */
  reasonForChange?: string
  /**
   * Backdates the new page's `createdAt` column instead of stamping the moment `createPage()` runs.
   * The editor UI has no field for this and never sets it, so ordinary saves keep the column's
   * `now()` default; only the migration importer (`backend/migration/page-import.ts`) supplies it, to
   * carry a source page's real creation time across rather than replacing it with import time — the
   * bug upstream requarks/wiki#4631 describes ("Importing from Local File System is ignoring
   * dateCreated and date fields").
   */
  createdAt?: string
  /**
   * Same reasoning as {@link createdAt}, for `updatedAt` — also used as the `versionDate` of the
   * single `pageHistory` row `createPage()` writes for this page's initial state, so that row is
   * dated the source's real last-modified time instead of import time too.
   */
  updatedAt?: string
}

/** One page's worth of raw data for the knowledge graph endpoint (OpenProject #872). */
export interface GraphPageRow {
  /** Real page id -- the join key `pageHistory.pageId` uses for the edit-volume node-sizing counts
   *  (OpenProject #1141), not otherwise surfaced on a `GraphNode`. */
  id: string
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  /** The classification level id this page carries (OpenProject #1079) -- what `mayOnPage()`'s
   *  CLASSIFICATION rule check (OpenProject #1126) and the graph's Classification grouping
   *  (#1217) both key off. */
  classification: string
  relations: {
    pos: 'left' | 'center' | 'right'
    label: string
    caption: string
    icon: string
    target: string
  }[]
  links: string[]
}

/**
 * Who is saving, and what they are allowed to put in a page.
 *
 * `write:scripts` and `write:styles` are page-rule-scoped permissions, not group-wide ones (see
 * CLAUDE.md's Permissions section), so deciding them takes more than the flat `permissions` list:
 * `groupIds` is what `WIKI.models.groups.checkAccess()` resolves a page rule against. See
 * `hasPermission()`.
 *
 * `scope`, when present, is an API key's own scope narrowing (`ApiKeyIdentity.scope`,
 * `models/apiKeys.ts`) — `null`/absent means unrestricted (a session, or an unscoped key). This is
 * structurally an `AccessActor` (`models/groups.ts`) too, and `hasPermission()` passes it straight
 * into `checkAccess()`, so a scoped key's `write:scripts`/`write:styles` grant is narrowed the same
 * way `checkAccess()` narrows every other page-rule permission (OpenProject #930) — omitting it here
 * would leave `api/pages.ts`'s save path as the one caller still trusting `groupIds` unnarrowed.
 */
export interface PageActor {
  id: string
  permissions: string[]
  groupIds: string[]
  /** Threaded through to `checkAccess()`'s `AccessActor` (OpenProject #930/#1205) — see that type. */
  scope?: string[] | null
  allowedClassifications?: string[] | null
  /**
   * What actually made the save: the standard editor (undefined, the default) or an MCP tool call
   * (`mcp/auth.ts`'s `pageActorFor()` sets this to `'mcp'`). Threaded straight through to
   * `pageHistory.record()`'s own `via` — see `PageHistoryVia`'s doc comment
   * (`models/pageHistory.ts`) for why this lives on the actor rather than as a separate argument
   * every write method would have to accept and pass along (OpenProject #1119).
   */
  via?: PageHistoryVia
}

/**
 * Whether this actor may embed scripts/styles ON THIS PAGE.
 *
 * `write:scripts`/`write:styles` are granted by a group's page rules, not by the group-wide
 * permission list (`PageActor.permissions` alone), so this asks `WIKI.models.groups.checkAccess()` —
 * the same per-page decision `mayOnPage()` makes in `api/pages.ts` — rather than scanning
 * `actor.permissions`, which a page-rule-only grant would never appear in.
 */
export function hasPermission(actor: PageActor, permission: string, page: RulePageRef): boolean {
  return WIKI.models.groups.checkAccess(actor, permission, page)
}

/**
 * Normalize a path to the form that gets stored, and refuse it if what is left is not addressable.
 *
 * Casing and spaces are corrected rather than rejected — `My Page` is a path someone meant, and it
 * means `my-page`. Anything else outside the allowed characters is not something to guess at.
 */
function normalizePath(input: string): string {
  const path = normalizePagePath(input)
  if (!rePagePath.test(path)) {
    throw new CustomError(
      'pageInvalidPath',
      'A page path may only contain alphanumeric, hyphen, underscore and slash characters.'
    )
  }
  return path
}

/**
 * Where a redirection points, as its content column holds it.
 *
 * `kind` is stored rather than sniffed off the target, because it is the question the author actually
 * answered: a page of this wiki, or somewhere else. The two are not reliably told apart afterwards —
 * `/help` is a page here and a perfectly good relative URL elsewhere — and the editor has to open on
 * the choice that was made rather than on a guess about it.
 */
export interface RedirectContent {
  kind: 'page' | 'url'
  /** A rooted path within this wiki, or an absolute `http(s)` URL. */
  target: string
  /** Whether the reader is told where they are going before being taken there. */
  showInterstitial: boolean
}

/**
 * Read a redirection's target back out of what the editor sent, and refuse anything that would not
 * send a reader anywhere.
 *
 * Re-serialized rather than stored as it arrived, so that the column holds one canonical spelling: a
 * save that changes nothing then reports no change, and the history rows say what they mean.
 *
 * A URL target is held to `http`/`https` deliberately. This value ends up in a `location` assignment,
 * so any other scheme is either useless (`mailto:` in a redirect that nobody chose to follow) or an
 * invitation (`javascript:`) — and a redirection is followed without the reader clicking anything.
 */
function normalizeRedirectContent(content: string | undefined): string {
  let parsed: any
  try {
    parsed = JSON.parse(content ?? '')
  } catch {
    throw new CustomError('pageRedirectInvalid', 'A redirection needs a target.')
  }
  const kind = parsed?.kind === 'url' ? 'url' : 'page'
  const target = typeof parsed?.target === 'string' ? parsed.target.trim() : ''
  if (target.length < 1) {
    throw new CustomError('pageRedirectMissingTarget', 'A redirection needs a target.')
  }
  if (kind === 'url') {
    if (!/^https?:\/\/\S/i.test(target)) {
      throw new CustomError(
        'pageRedirectInvalidUrl',
        'A redirection to a URL must be a complete http:// or https:// address.'
      )
    }
  } else if (!target.startsWith('/') || target.startsWith('//')) {
    throw new CustomError(
      'pageRedirectInvalidPath',
      'A redirection to a page of this wiki must be a path starting with a slash.'
    )
  }
  const redirect: RedirectContent = {
    kind,
    target,
    showInterstitial: parsed?.showInterstitial === true
  }
  return JSON.stringify(redirect)
}

/**
 * Pages model
 *
 * A page is a row here plus a row in the tree that gives it its place in the site. The markdown is
 * authored and rendered in the browser; what arrives is both the source and the HTML, and the HTML is
 * run through `models/rendering.ts` before being stored — that is where it gets sanitized against what
 * the author is actually allowed to embed, and where the table of contents and the search text come
 * from.
 *
 * Not implemented yet, and deliberately not faked here: version history (there is no table for it),
 * page links, comments, and storage targets.
 */
class Pages {
  /**
   * Flatten a row and its blobs into the shape the API returns.
   *
   * @param locked Withhold the body — the source, the rendered HTML, the table of contents drawn from
   *               it, and the relation links written onto the page. The metadata stays: a reader
   *               looking at the lock screen is told what page they are being asked for a password to.
   * @param withPassword Include the page's own password. Only for a requester who may edit the page,
   *                     which is the one that has to be able to read it back and save it again.
   * @param withContent Include the source. A redirection's comes back either way: its content is not
   *                    a body somebody wrote, it is where the page sends its reader — which every
   *                    reader is about to be shown by being taken there. Withholding it would leave
   *                    the page view unable to do the one thing the page is for, and the page view
   *                    does not ask for content.
   */
  private toPage(
    row: any,
    {
      withContent = false,
      withPassword = false,
      locked = false
    }: { withContent?: boolean; withPassword?: boolean; locked?: boolean } = {}
  ): Page {
    const config = row.config ?? {}
    const scripts = row.scripts ?? {}
    return {
      id: row.id,
      path: row.path,
      hash: row.hash,
      alias: row.alias,
      title: row.title,
      description: row.description,
      icon: row.icon,
      locale: row.locale,
      editor: row.editor,
      contentType: row.contentType,
      publishState: row.publishState,
      publishStartDate: row.publishStartDate,
      publishEndDate: row.publishEndDate,
      isBrowsable: row.isBrowsable,
      isSearchable: row.isSearchable,
      ...(withPassword ? { password: row.password } : {}),
      isLocked: locked,
      relations: locked ? [] : (row.relations ?? []),
      tags: row.tags ?? [],
      toc: locked ? [] : (row.toc ?? []),
      render: locked ? '' : (row.render ?? ''),
      ...((withContent || row.editor === REDIRECT_EDITOR) && !locked
        ? { content: row.content ?? '' }
        : {}),
      allowComments: config.allowComments ?? true,
      allowContributions: config.allowContributions ?? true,
      allowRatings: config.allowRatings ?? true,
      showSidebar: config.showSidebar ?? true,
      showTags: config.showTags ?? true,
      showToc: config.showToc ?? true,
      tocDepth: config.tocDepth ?? { min: 1, max: 2 },
      scriptJsLoad: scripts.jsLoad ?? '',
      scriptJsUnload: scripts.jsUnload ?? '',
      scriptCss: scripts.css ?? '',
      navigationId: row.navigationId ?? null,
      navigationMode: row.navigationMode ?? 'inherit',
      authorId: row.authorId,
      authorName: row.authorName ?? '',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      classification: row.classification
    }
  }

  /**
   * A single page, by ID or by the hash of its path.
   *
   * The hash is what the frontend addresses a page with — see `generatePathHash` — so this is the
   * lookup an ordinary page view goes through.
   *
   * A password-protected page still comes back to a requester who has not unlocked it: the metadata
   * is what the lock screen is drawn from. What the password withholds is the body — see `toPage`'s
   * `locked`. Anything that puts a page's text in front of a reader has to go through here, or
   * through the same check, because the enforcement is this method and not the client.
   *
   * **The defaults hand over the whole page**, `unlocked` and `withPassword` included, the way they do
   * for `publicOnly` beside them: most callers here are a save, a move, a delete or a re-render, and
   * none of those is a reader — a save that got a withheld body back would answer its author with an
   * empty page, and a re-render would store one. A path that serves a reader has to say so, and there
   * are exactly two: the `GET` route, and `unlockPage` below.
   *
   * @param unlocked Whether the password has been satisfied for this requester. Route-level concern:
   *                 see `unlockedFor` in `api/pages.ts`. A function is called with the row's path,
   *                 locale and tags once it is in hand — not just the id — because `unlockedFor` needs
   *                 them to ask `mayOnPage()` whether a page RULE bypasses the password, and the row is
   *                 the only place that has them when the caller only knew a path hash going in.
   * @param withPassword Whether to include the password value, for whoever may edit the page — not for
   *                     a reader who just entered it, who needs it no more after that. Also a function
   *                     for the same reason as `unlocked`: which page it is, and therefore whether this
   *                     requester may edit it, is only known once the row is in hand.
   */
  async getPage({
    siteId,
    id,
    hash,
    locale,
    withContent = false,
    publicOnly = false,
    unlocked = true,
    withPassword = true
  }: {
    siteId: string
    id?: string
    hash?: string
    locale?: string
    withContent?: boolean
    /** Restrict to what a reader with no session may see: published pages. */
    publicOnly?: boolean
    unlocked?: boolean | ((page: UnlockPageRef) => boolean)
    withPassword?: boolean | ((page: UnlockPageRef) => boolean)
  }): Promise<Page | null> {
    const conditions = [eq(pagesTable.siteId, siteId)]
    if (publicOnly) {
      // -> Page-level access rules are not implemented, so this is the whole of it: an anonymous
      //    reader sees published pages, and nothing else. A password does not hide a page from them —
      //    it withholds the body until they enter it, which is what `locked` below does.
      conditions.push(eq(pagesTable.publishState, 'published'))
    }
    if (id) {
      conditions.push(eq(pagesTable.id, id))
    } else if (hash) {
      conditions.push(eq(pagesTable.hash, hash))
      // -> A path is only unique within a locale, so without one this could match more than one page
      conditions.push(eq(pagesTable.locale, locale ?? defaultLocale(siteId)))
    } else {
      return null
    }

    const results = await WIKI.db
      .select({
        page: pagesTable,
        authorName: usersTable.name,
        navigationId: treeTable.navigationId,
        navigationMode: treeTable.navigationMode
      })
      .from(pagesTable)
      .leftJoin(usersTable, eq(usersTable.id, pagesTable.authorId))
      .leftJoin(treeTable, eq(treeTable.id, pagesTable.id))
      .where(and(...conditions))
      .limit(1)

    const row = results[0]
    if (!row) {
      return null
    }
    const unlockRef: UnlockPageRef = {
      id: row.page.id,
      path: row.page.path,
      locale: row.page.locale,
      tags: row.page.tags,
      classification: row.page.classification
    }
    const isUnlocked = typeof unlocked === 'function' ? unlocked(unlockRef) : unlocked
    const includePassword =
      typeof withPassword === 'function' ? withPassword(unlockRef) : withPassword
    return this.toPage(
      {
        ...row.page,
        authorName: row.authorName,
        navigationId: row.navigationId,
        navigationMode: row.navigationMode
      },
      {
        withContent,
        withPassword: includePassword,
        locked: Boolean(row.page.password) && !isUnlocked
      }
    )
  }

  /**
   * Every page of a site, metadata only — no content, no pagination, no publish-state filtering.
   *
   * For a full walk of a site's pages (a file-backed storage target reconciling its repo against the
   * DB, chiefly), not for anything reader-facing: `listPages` on the tree model is that one, and it is
   * unsuitable here precisely because it paginates and hides what a reader may not see. A caller that
   * needs a page's content fetches it per page via `getPage({ withContent: true })`, the same way every
   * write-path handler in `modules/storage/git/content.ts` already does — this only answers "what pages
   * exist", not "what do they contain".
   */
  async listAllForSite(
    siteId: string
  ): Promise<{ id: string; path: string; locale: string; contentType: string }[]> {
    return WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        contentType: pagesTable.contentType
      })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, siteId))
  }

  /**
   * Every page on this site, with what the knowledge graph (OpenProject #872) needs to build
   * nodes and edges from — no content, no render, just enough for `api/graph.ts#assembleGraph`
   * to build and permission-filter the graph once.
   */
  async listAllForGraph(siteId: string): Promise<GraphPageRow[]> {
    return WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        icon: pagesTable.icon,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        relations: pagesTable.relations,
        links: pagesTable.links
      })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, siteId)) as Promise<GraphPageRow[]>
  }

  /**
   * Check a page's password, and hand the page over if it matches.
   *
   * Deliberately the only way past the lock: a reader gets the body from here or from a `getPage` the
   * route has already marked as unlocked, and never from a flag the browser sent.
   *
   * @returns The page, its body included, or null when the password is wrong or the page has none —
   *          the caller cannot tell those apart, and neither can whoever is guessing.
   */
  async unlockPage({
    siteId,
    id,
    hash,
    locale,
    password,
    publicOnly = false
  }: {
    siteId: string
    id?: string
    hash?: string
    locale?: string
    password: string
    publicOnly?: boolean
  }): Promise<Page | null> {
    /*
      Asked for as a reader would see it, for two reasons: a wrong guess must not assemble the body in
      the first place, and `isLocked` is how this knows there is a password to check at all.
    */
    const page = await this.getPage({
      siteId,
      id,
      hash,
      locale,
      publicOnly,
      unlocked: false,
      withPassword: false
    })
    if (!page?.isLocked) {
      return null
    }
    const stored = await WIKI.db
      .select({ password: pagesTable.password })
      .from(pagesTable)
      .where(eq(pagesTable.id, page.id))
      .limit(1)
    const expected = stored[0]?.password
    if (!expected || !timingSafeCompare(password, expected)) {
      return null
    }
    // -> Unlocked, but still without the password itself: entering it is not the same as being able
    //    to change it, and the reader has no further use for the value
    return this.getPage({
      siteId,
      id: page.id,
      publicOnly,
      unlocked: true,
      withPassword: false
    })
  }

  /**
   * The immediate parent PAGE's classification, or null when there is none -- either because `path`
   * is at the root, or because nothing is actually published at the parent path (an empty folder).
   *
   * "Immediate parent only" is the floor invariant's own scope (OpenProject #1080): a page is checked
   * against its immediate parent's classification, not the whole ancestor chain, since a real parent
   * already satisfies the floor against ITS OWN parent by induction.
   *
   * Public rather than private: `api/pages.ts`'s classification-conflicts resolve route needs it to
   * enforce the same floor invariant against an admin-chosen target level (see that route's own
   * comment on why `bulkSetClassification` alone was not enough).
   */
  async parentClassification(
    siteId: string,
    locale: string,
    path: string,
    db: WikiDbOrTx = WIKI.db
  ): Promise<string | null> {
    const parentPath = path.split('/').slice(0, -1).join('/')
    if (!parentPath) {
      return null
    }
    const rows = await db
      .select({ classification: pagesTable.classification })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.locale, locale),
          eq(pagesTable.path, parentPath)
        )
      )
      .limit(1)
    return rows[0]?.classification ?? null
  }

  /**
   * The classification a new page should be created with, and the floor-invariant check on an
   * explicitly requested one (OpenProject #1079/#1080).
   *
   * No parent page to inherit a floor from (root-level, or an empty folder) means no constraint: an
   * explicit request is honored as given, and the default is the most-open configured level.
   */
  private async resolveCreateClassification(
    siteId: string,
    locale: string,
    path: string,
    requested: string | undefined
  ): Promise<string> {
    const floorId = await this.parentClassification(siteId, locale, path)
    if (requested) {
      if (!WIKI.models.classificationLevels.byId(requested)) {
        throw new CustomError(
          'classificationInvalid',
          'This classification level does not exist.',
          400
        )
      }
      if (floorId && !WIKI.models.classificationLevels.meetsFloor(requested, floorId)) {
        throw new CustomError(
          'classificationBelowFloor',
          "A page's classification cannot be more open than its parent page's.",
          400
        )
      }
      return requested
    }
    return floorId ?? WIKI.models.classificationLevels.defaultLevel().id
  }

  /**
   * Every published page under `parentPath` (any depth) whose classification sits below `floorId` --
   * what a retroactive parent-classification raise surfaces for an admin to resolve explicitly rather
   * than cascading silently (OpenProject #1080's "classification resolution dialog").
   */
  async descendantsBelowFloor(
    siteId: string,
    locale: string,
    parentPath: string,
    floorId: string
  ): Promise<{ id: string; path: string; title: string; classification: string }[]> {
    const prefix = `${parentPath}/`
    const rows = await WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        title: pagesTable.title,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.locale, locale),
          sql`${pagesTable.path} LIKE ${prefix + '%'}`
        )
      )
    return rows.filter(
      (row) => !WIKI.models.classificationLevels.meetsFloor(row.classification, floorId)
    )
  }

  /**
   * Bump a set of pages (by id, all on this site) to a classification, in one transaction -- what
   * resolving a classification-resolution-dialog conflict actually does to the descendants an admin
   * chose to bring up to the new floor. No floor/permission checks here: the API route is the one
   * place that decides who may call this and validates the target level, the same layering
   * `updatePage`'s own caller (`api/pages.ts`) already follows for the declassification guardrail.
   */
  async bulkSetClassification(
    siteId: string,
    ids: string[],
    classification: string
  ): Promise<number> {
    if (ids.length < 1) {
      return 0
    }
    const result = await WIKI.db
      .update(pagesTable)
      .set({ classification, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, ids)))
    return result.rowCount ?? 0
  }

  /**
   * Create a page.
   *
   * @param actor Who is saving it. Their permissions decide what survives sanitizing.
   */
  async createPage(siteId: string, input: PageInput, actor: PageActor): Promise<Page> {
    if (!WIKI.sites[siteId]) {
      throw new CustomError('pageInvalidSite', 'This site does not exist.', 404)
    }

    const path = normalizePath(input.path)
    const firstSegment = path.split('/')[0] ?? ''
    if (await WIKI.models.locales.isReservedLocaleCode(firstSegment)) {
      throw new CustomError(
        'pageReservedLocaleSegment',
        `"${firstSegment}" is an installed locale code and cannot begin a page path.`,
        400
      )
    }
    const locale = input.locale || defaultLocale(siteId)
    // -> A locale that used to be enabled and got turned off is not a valid target for a new page,
    //    including one recreated by the deletion-recovery flow (see `pageHistory.recoverDeletedPage`)
    //    into a locale that no longer exists
    const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? [
      defaultLocale(siteId)
    ]
    if (!activeLocales.includes(locale)) {
      throw new CustomError(
        'pageInvalidLocale',
        `This site does not have the "${locale}" locale enabled.`,
        400
      )
    }
    const title = (input.title ?? '').trim()
    if (title.length < 1) {
      throw new CustomError('pageTitleMissing', 'A page needs a title.')
    }
    const editor = input.editor || 'markdown'
    const isRedirect = editor === REDIRECT_EDITOR
    // -> A redirection has no body to be empty: what it holds instead is where it points, and that has
    //    its own rules about being filled in
    const content = isRedirect ? normalizeRedirectContent(input.content) : input.content
    if (!isRedirect && (!content || content.trim().length < 1)) {
      throw new CustomError('pageEmptyContent', 'A page cannot be empty.')
    }

    const hash = generatePathHash(path)
    const duplicate = await WIKI.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(
        and(eq(pagesTable.siteId, siteId), eq(pagesTable.locale, locale), eq(pagesTable.path, path))
      )
      .limit(1)
    if (duplicate.length > 0) {
      throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
    }

    const alias = await this.validateAlias(siteId, input.alias)
    const classification = await this.resolveCreateClassification(
      siteId,
      locale,
      path,
      input.classification
    )
    // -> `classification: null` here, deliberately, even though the value the page is ABOUT to be
    //    created with is already known: `write:scripts`/`write:styles` are checked against the page
    //    as it exists right now, which is not at all -- see `RulePageRef`'s own doc comment on why a
    //    not-yet-existing page fails closed rather than reaching for a value that describes the page
    //    it is about to become.
    const pageRef: RulePageRef = { path, locale, siteId, tags: input.tags, classification: null }
    const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
      siteId,
      input.render ?? '',
      {
        scripts: hasPermission(actor, 'write:scripts', pageRef),
        styles: hasPermission(actor, 'write:styles', pageRef)
      },
      path
    )

    const pathParts = path.split('/')
    let inserted
    try {
      inserted = await WIKI.db
        .insert(pagesTable)
        .values({
          alias,
          authorId: actor.id,
          creatorId: actor.id,
          ownerId: actor.id,
          classification,
          config: this.buildConfig(input, siteId),
          content,
          contentType: EDITOR_CONTENT_TYPES[editor] ?? 'text',
          description: input.description ?? '',
          editor,
          hash,
          icon: input.icon ?? '',
          isBrowsable: input.isBrowsable ?? true,
          // -> A redirection has nothing to find: a result for it would be a result whose page is a
          //    doorway to the page the reader actually wanted, which is the one search should offer
          isSearchable: isRedirect ? false : (input.isSearchable ?? true),
          locale,
          password: input.password || null,
          path,
          publishState: input.publishState ?? 'published',
          publishStartDate: input.publishStartDate ? new Date(input.publishStartDate) : null,
          publishEndDate: input.publishEndDate ? new Date(input.publishEndDate) : null,
          relations: input.relations ?? [],
          links,
          render,
          searchContent: text,
          scripts: this.buildScripts(input, actor, pageRef),
          siteId,
          tags: input.tags ?? [],
          title,
          toc,
          ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
          ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {})
        })
        .returning()
    } catch (err: any) {
      // -> The probe above already covers the common case; this catches the race it cannot close --
      //    two requests that both pass the probe before either inserts
      if (err.cause?.code === '23505' || err.code === '23505') {
        throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
      }
      throw err
    }

    const page = inserted[0]

    try {
      await WIKI.models.tree.addPage({
        id: page.id,
        parentPath: pathParts.slice(0, -1).join('/'),
        fileName: pathParts.at(-1)!,
        title: page.title,
        locale,
        siteId,
        tags: input.tags ?? [],
        meta: this.treeMeta(page)
      })
    } catch (err) {
      // -> A page with no tree entry is invisible to navigation and to the file manager, which is
      //    worse than not having saved it at all
      await WIKI.db.delete(pagesTable).where(eq(pagesTable.id, page.id))
      throw err
    }

    await WIKI.models.pageHistory.record({
      siteId,
      pageId: page.id,
      action: 'created',
      authorId: actor.id,
      via: actor.via,
      reason: input.reasonForChange,
      versionDate: input.updatedAt ? new Date(input.updatedAt) : undefined
    })
    // -> No `notifyWatchers` call here: nobody can be watching a page before it exists, so there is
    //    nothing to resolve. See that method's own comment for the one case (restore) that would
    //    change this, and why it doesn't apply yet.

    await WIKI.models.search.created(page)
    await WIKI.models.hooks.emit('page:create', siteId, {
      id: page.id,
      path: page.path,
      locale,
      siteId,
      authorId: actor.id,
      metadata: { title: page.title, description: page.description, editor }
    })
    await WIKI.models.storage.dispatch('page:create', {
      id: page.id,
      path: page.path,
      locale,
      siteId,
      authorId: actor.id
    })

    return (await this.getPage({ siteId, id: page.id })) as Page
  }

  /**
   * Update a page. Only the fields present in the patch are touched.
   */
  async updatePage(
    siteId: string,
    id: string,
    patch: Partial<PageInput>,
    actor: PageActor
  ): Promise<Page | null> {
    const results = await WIKI.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.id, id), eq(pagesTable.siteId, siteId)))
      .limit(1)
    const existing = results[0]
    if (!existing) {
      return null
    }

    const values: Record<string, any> = { updatedAt: sql`now()` }
    let treeTitle: string | null = null
    // -> Which editor authored a page is not something a save may change, so the row is the authority
    //    on whether this is a redirection
    const isRedirect = existing.editor === REDIRECT_EDITOR

    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (title.length < 1) {
        throw new CustomError('pageTitleMissing', 'A page needs a title.')
      }
      values.title = title
      treeTitle = title
    }
    if (patch.description !== undefined) {
      values.description = patch.description.trim()
    }
    if (patch.icon !== undefined) {
      values.icon = patch.icon.trim()
    }
    if (patch.alias !== undefined) {
      values.alias = await this.validateAlias(siteId, patch.alias, id)
    }
    if (patch.content !== undefined) {
      values.content = isRedirect ? normalizeRedirectContent(patch.content) : patch.content
    }
    if (patch.publishState !== undefined) {
      if (
        patch.publishState === 'scheduled' &&
        !(patch.publishStartDate ?? existing.publishStartDate) &&
        !(patch.publishEndDate ?? existing.publishEndDate)
      ) {
        throw new CustomError(
          'pageMissingScheduledDates',
          'A scheduled page needs a start or an end date.'
        )
      }
      values.publishState = patch.publishState
    }
    if (patch.publishStartDate !== undefined) {
      values.publishStartDate = patch.publishStartDate ? new Date(patch.publishStartDate) : null
    }
    if (patch.publishEndDate !== undefined) {
      values.publishEndDate = patch.publishEndDate ? new Date(patch.publishEndDate) : null
    }
    if (patch.isBrowsable !== undefined) {
      values.isBrowsable = patch.isBrowsable
    }
    if (patch.isSearchable !== undefined) {
      // -> Never for a redirection; see the same call in `createPage`
      values.isSearchable = isRedirect ? false : patch.isSearchable
    }
    if (patch.password !== undefined) {
      values.password = patch.password || null
    }
    if (patch.relations !== undefined) {
      values.relations = patch.relations
    }
    if (patch.tags !== undefined) {
      values.tags = patch.tags
    }
    // -> The declassification GUARDRAIL permission (`manage:classification`, OpenProject #1080) is
    //    checked one layer up, in `api/pages.ts` -- the same layering every other page-rule
    //    permission follows (see CLAUDE.md's Permissions section). This is the structural check: a
    //    page's classification, whichever direction it moves, may never end up below its immediate
    //    parent's floor.
    if (patch.classification !== undefined) {
      if (!WIKI.models.classificationLevels.byId(patch.classification)) {
        throw new CustomError(
          'classificationInvalid',
          'This classification level does not exist.',
          400
        )
      }
      const floorId = await this.parentClassification(siteId, existing.locale, existing.path)
      if (floorId && !WIKI.models.classificationLevels.meetsFloor(patch.classification, floorId)) {
        throw new CustomError(
          'classificationBelowFloor',
          "A page's classification cannot be more open than its parent page's.",
          400
        )
      }
      values.classification = patch.classification
    }

    const existingRef: RulePageRef = {
      path: existing.path,
      locale: existing.locale,
      siteId: existing.siteId,
      tags: existing.tags ?? [],
      classification: existing.classification
    }

    // -> A render only means anything next to the content it came from, so the two move together
    if (patch.render !== undefined) {
      const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
        siteId,
        patch.render,
        {
          scripts: hasPermission(actor, 'write:scripts', existingRef),
          styles: hasPermission(actor, 'write:styles', existingRef)
        },
        existing.path
      )
      values.render = render
      values.toc = toc
      values.searchContent = text
      values.links = links
    }

    if (CONFIG_FIELDS.some((field) => patch[field] !== undefined)) {
      values.config = this.buildConfig(patch, siteId, existing.config as Record<string, any>)
    }
    if (
      patch.scriptJsLoad !== undefined ||
      patch.scriptJsUnload !== undefined ||
      patch.scriptCss !== undefined
    ) {
      values.scripts = this.buildScripts(
        patch,
        actor,
        existingRef,
        existing.scripts as Record<string, any>
      )
    }

    // -> The author is whoever last changed it; the creator and owner do not move
    values.authorId = actor.id

    // -> Worked out before the write, against the row as it stands: the editor sends every field on
    //    every save, so the patch alone would report a change to all of them
    const changedFields = WIKI.models.pageHistory.changedFields(existing, values)

    // -> `.returning()` gets the raw row for free off the same write: `WIKI.models.search.updated`
    //    wants the full `pages` row (`SearchIndexablePage`), not the flattened `Page` shape `getPage`
    //    below produces
    const rawRows = await WIKI.db
      .update(pagesTable)
      .set(values)
      .where(eq(pagesTable.id, id))
      .returning()
    const rawUpdated = rawRows[0]!

    const updated = (await this.getPage({ siteId, id })) as Page

    await WIKI.models.pageHistory.record({
      siteId,
      pageId: id,
      action: 'updated',
      authorId: actor.id,
      via: actor.via,
      changedFields,
      reason: patch.reasonForChange
    })
    await this.notifyWatchers(
      siteId,
      id,
      'updated',
      actor.id,
      {
        title: updated.title,
        path: updated.path,
        locale: updated.locale,
        classification: updated.classification,
        tags: updated.tags
      },
      changedFields
    )

    if (treeTitle !== null || patch.tags !== undefined) {
      await WIKI.db
        .update(treeTable)
        .set({
          ...(treeTitle !== null ? { title: treeTitle } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          meta: this.treeMeta(updated),
          updatedAt: sql`now()`
        })
        .where(eq(treeTable.id, id))
    }

    await WIKI.models.search.updated(rawUpdated)
    await WIKI.models.hooks.emit('page:edit', siteId, {
      id,
      path: updated.path,
      locale: updated.locale,
      siteId,
      authorId: actor.id,
      metadata: { title: updated.title, description: updated.description }
    })
    await WIKI.models.storage.dispatch('page:edit', {
      id,
      path: updated.path,
      locale: updated.locale,
      siteId,
      authorId: actor.id
    })

    return updated
  }

  /**
   * Other pages in this site sharing a path with `path`, excluding `excludeId` -- the translation
   * link this data model uses (same `(siteId, path)`, other locales; see
   * docs/decisions/locale-translation-linking.md). Used by `movePage`'s `includeTranslations`
   * cascade to find the twins a rename has to carry along, and by the move/rename UI to offer it.
   */
  async getTranslations(siteId: string, path: string, excludeId: string): Promise<Page[]> {
    const rows = await WIKI.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(
        and(eq(pagesTable.siteId, siteId), eq(pagesTable.path, path), ne(pagesTable.id, excludeId))
      )
    const pages = await Promise.all(rows.map((row) => this.getPage({ siteId, id: row.id })))
    return pages.filter((candidate): candidate is Page => candidate !== null)
  }

  /**
   * The page + tree write for one page, run inside an already-open transaction -- shared between
   * `movePage()`'s own move and its `includeTranslations` cascade, since a twin's move is exactly
   * the same write against the twin's own current row, with its own (untouched) locale.
   */
  private async moveOnePageInTx(
    tx: WikiTx,
    siteId: string,
    current: Page,
    { path: newPath, title, locale: destLocale }: { path: string; title?: string; locale: string },
    actor: PageActor
  ): Promise<{ rawMoved: typeof pagesTable.$inferSelect; changedFields: string[] }> {
    /*
      Floor invariant on move (OpenProject #1080): unlike create/update, a move that lands a page
      under a stricter parent auto-bumps it rather than refusing the move outright -- "no separate
      confirmation step for a move" is the spec's own words. `stricterOf` is a no-op when the page is
      already at or above the new floor (its own classification IS the stricter of the two already).
      Read inside the transaction (`tx`, not `WIKI.db`) so a concurrent move of the parent cannot land
      between this read and the write below.
    */
    const newFloorId =
      newPath !== current.path || destLocale !== current.locale
        ? await this.parentClassification(siteId, destLocale, newPath, tx)
        : null
    const classification = newFloorId
      ? WIKI.models.classificationLevels.stricterOf(current.classification, newFloorId)
      : current.classification

    const rawMovedRows = await tx
      .update(pagesTable)
      .set({
        path: newPath,
        hash: generatePathHash(newPath),
        locale: destLocale,
        classification,
        ...(title !== undefined ? { title: title.trim() } : {}),
        authorId: actor.id,
        updatedAt: sql`now()`
      })
      .where(eq(pagesTable.id, current.id))
      .returning()

    // -> The tree entry is what places the page in the site, so it is moved rather than rewritten:
    //    dropping and re-adding would create the destination folders but leave the old ones counted
    const pathParts = newPath.split('/')
    await WIKI.models.tree.deleteEntry(current.id, tx)
    await WIKI.models.tree.addPage({
      id: current.id,
      parentPath: pathParts.slice(0, -1).join('/'),
      fileName: pathParts.at(-1)!,
      title: title !== undefined ? title.trim() : current.title,
      locale: destLocale,
      siteId,
      tags: current.tags,
      meta: this.treeMeta({ ...current, path: newPath }),
      db: tx
    })

    // -> Recorded as its own kind of change rather than an edit: a move is what breaks inbound
    //    links, and a history list has to be able to say so
    const changedFields = [
      ...(newPath !== current.path ? ['path'] : []),
      ...(destLocale !== current.locale ? ['locale'] : []),
      ...(title !== undefined && title.trim() !== current.title ? ['title'] : [])
    ]

    return { rawMoved: rawMovedRows[0]!, changedFields }
  }

  /**
   * The side effects one moved page fires once its transaction has committed -- history, watchers,
   * search, hooks and storage dispatch, all keyed to what THIS page changed rather than the batch as
   * a whole, so an `includeTranslations` cascade fires one full set per twin, exactly as if each had
   * been moved on its own (spec item 2 of OpenProject #1026).
   */
  private async recordMoveSideEffects(
    siteId: string,
    previous: Page,
    rawMoved: typeof pagesTable.$inferSelect,
    changedFields: string[],
    actor: PageActor
  ): Promise<Page> {
    const moved = (await this.getPage({ siteId, id: previous.id })) as Page
    await WIKI.models.pageHistory.record({
      siteId,
      pageId: previous.id,
      action: 'moved',
      authorId: actor.id,
      via: actor.via,
      changedFields
    })
    await this.notifyWatchers(
      siteId,
      previous.id,
      'moved',
      actor.id,
      {
        title: moved.title,
        path: moved.path,
        locale: moved.locale,
        classification: moved.classification,
        tags: moved.tags
      },
      changedFields
    )
    await WIKI.models.search.renamed(siteId, rawMoved, previous.path, previous.locale)
    // -> A glossary term's cached canonical-page mapping (`models/glossary.ts`'s `getRawCachedTerms`)
    //    caches the page's path/locale, so a canonical page's path or locale changing has to drop it
    //    too, the same way a term CRUD does -- otherwise the cache would keep resolving a link to
    //    where the page used to live (OpenProject #870).
    if (moved.path !== previous.path || moved.locale !== previous.locale) {
      WIKI.models.glossary.invalidateCache(siteId)
    }
    // -> `previousLocale` alongside `previousPath` because a move can now change either: a consumer
    //    that has to find what the page used to be (the git target's own file for it, say) needs the
    //    whole of where it was, not half of it
    await WIKI.models.hooks.emit('page:rename', siteId, {
      id: previous.id,
      path: moved.path,
      previousPath: previous.path,
      locale: moved.locale,
      previousLocale: previous.locale,
      siteId,
      authorId: actor.id
    })
    await WIKI.models.storage.dispatch('page:rename', {
      id: previous.id,
      path: moved.path,
      previousPath: previous.path,
      locale: moved.locale,
      previousLocale: previous.locale,
      siteId,
      authorId: actor.id
    })
    return moved
  }

  /**
   * Move a page to another path and/or another locale, taking its tree entry with it.
   *
   * `locale` re-homes the page into another of the site's locales, which is a move in exactly the
   * sense a path change is: the page keeps its id, history and watchers, and the (siteId, locale,
   * path) it used to occupy is freed. Absent, the page stays in the locale it is already in.
   *
   * `includeTranslations` cascades a path change to every other locale's page sharing this page's
   * CURRENT path (see `getTranslations` and docs/decisions/locale-translation-linking.md) -- the
   * translation link this data model uses is the shared path itself, so a rename that moves only one
   * locale's page silently strands its twins at the old one. All-or-nothing: every twin goes through
   * the same reserved-segment and collision checks as the page being moved, and a 409 on any one of
   * them aborts the whole batch, page and tree writes together (OpenProject #1026, built on the
   * transaction OpenProject #1022 put under a single move). A locale-only move (path unchanged) never
   * cascades -- twins are found by path, so they are unaffected by definition.
   */
  async movePage(
    siteId: string,
    id: string,
    {
      path,
      title,
      locale,
      includeTranslations = false
    }: { path: string; title?: string; locale?: string; includeTranslations?: boolean },
    actor: PageActor
  ): Promise<Page | null> {
    const page = await this.getPage({ siteId, id })
    if (!page) {
      return null
    }
    const newPath = normalizePath(path)
    // -> Same reasoning as `tree.renameFolder`: only checked when the path is actually changing, so a
    //    title-only (or locale-only) move of an already-grandfathered page — one whose path predates
    //    this rule — isn't itself blocked. The route's own schema advertises rename-via-move, and a
    //    page whose shadowing first segment is untouched by this call isn't newly at risk. Path-only,
    //    so it applies identically to every twin the cascade below moves to the same destination --
    //    no need to repeat it per twin.
    if (newPath !== page.path) {
      const firstSegment = newPath.split('/')[0] ?? ''
      if (await WIKI.models.locales.isReservedLocaleCode(firstSegment)) {
        throw new CustomError(
          'pageReservedLocaleSegment',
          `"${firstSegment}" is an installed locale code and cannot begin a page path.`,
          400
        )
      }
    }
    const destLocale = locale ?? page.locale
    // -> Same rule as `createPage`: a locale that is not enabled on this site is not a place a page
    //    may end up, whether by being created there or by being moved there
    if (destLocale !== page.locale) {
      const activeLocales: string[] = WIKI.sites[siteId]?.config?.locales?.active ?? [
        defaultLocale(siteId)
      ]
      if (!activeLocales.includes(destLocale)) {
        throw new CustomError(
          'pageInvalidLocale',
          `This site does not have the "${destLocale}" locale enabled.`,
          400
        )
      }
    }
    if (
      newPath === page.path &&
      destLocale === page.locale &&
      (title === undefined || title === page.title)
    ) {
      return page
    }

    if (newPath !== page.path || destLocale !== page.locale) {
      const duplicate = await WIKI.db
        .select({ id: pagesTable.id })
        .from(pagesTable)
        .where(
          and(
            ne(pagesTable.id, id),
            eq(pagesTable.siteId, siteId),
            eq(pagesTable.locale, destLocale),
            eq(pagesTable.path, newPath)
          )
        )
        .limit(1)
      if (duplicate.length > 0) {
        throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
      }
    }

    // -> Twins share this page's CURRENT path -- found before anything moves, since the primary no
    //    longer shares it with anyone the moment its own row is updated. Reaching here with the path
    //    unchanged means only the locale (or title) is moving (the no-op check above already
    //    returned for a title-only move too), and twins are addressed by path, not by locale, so
    //    there is nothing for them to inherit from a locale-only move.
    const twins =
      includeTranslations && newPath !== page.path
        ? await this.getTranslations(siteId, page.path, id)
        : []

    for (const twin of twins) {
      const duplicate = await WIKI.db
        .select({ id: pagesTable.id })
        .from(pagesTable)
        .where(
          and(
            ne(pagesTable.id, twin.id),
            eq(pagesTable.siteId, siteId),
            eq(pagesTable.locale, twin.locale),
            eq(pagesTable.path, newPath)
          )
        )
        .limit(1)
      if (duplicate.length > 0) {
        throw new CustomError(
          'pageDuplicatePath',
          `A page already exists at this path in the "${twin.locale}" locale.`,
          409
        )
      }
    }

    // -> Every page in the batch -- the one being moved, plus every twin `includeTranslations` pulls
    //    along -- shares one transaction: a collision the probes above couldn't close (a race, or a
    //    tree name collision only the insert itself can see) rolls the whole batch back rather than
    //    leaving some twins moved and others stranded.
    type MoveResult = {
      previous: Page
      rawMoved: typeof pagesTable.$inferSelect
      changedFields: string[]
    }
    let results: MoveResult[]
    try {
      results = await WIKI.db.transaction(async (tx) => {
        const primary = await this.moveOnePageInTx(
          tx,
          siteId,
          page,
          { path: newPath, title, locale: destLocale },
          actor
        )
        const batch: MoveResult[] = [{ previous: page, ...primary }]
        for (const twin of twins) {
          const twinResult = await this.moveOnePageInTx(
            tx,
            siteId,
            twin,
            { path: newPath, locale: twin.locale },
            actor
          )
          batch.push({ previous: twin, ...twinResult })
        }
        return batch
      })
    } catch (err: any) {
      // -> The probes above already cover the common case; this catches the race they cannot close --
      //    two requests that both pass a probe before either writes
      if (err.cause?.code === '23505' || err.code === '23505') {
        throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
      }
      throw err
    }

    let primaryMoved: Page | undefined
    for (const result of results) {
      const moved = await this.recordMoveSideEffects(
        siteId,
        result.previous,
        result.rawMoved,
        result.changedFields,
        actor
      )
      if (result.previous.id === id) {
        primaryMoved = moved
      }
    }
    return primaryMoved!
  }

  /**
   * Delete a page and its tree entry.
   *
   * @returns Whether a page was deleted
   */
  async deletePage(siteId: string, id: string, actor: PageActor): Promise<boolean> {
    const page = await this.getPage({ siteId, id })
    if (!page) {
      return false
    }
    // -> Before the row goes, and this version is what recovering the page would be built from
    await WIKI.models.pageHistory.record({
      siteId,
      pageId: id,
      action: 'deleted',
      authorId: actor.id,
      via: actor.via
    })
    // -> Also before the row goes: deleting it below cascades `pageWatching` away, so the watch list
    //    has to be read while it still exists
    await this.notifyWatchers(siteId, id, 'deleted', actor.id, {
      title: page.title,
      path: page.path,
      locale: page.locale,
      classification: page.classification,
      tags: page.tags
    })

    await WIKI.db.delete(pagesTable).where(eq(pagesTable.id, id))
    await WIKI.models.tree.deleteEntry(id)
    // -> A page that overrode the sidebar owns a menu keyed by its own id, which nothing could reach
    //    once the page is gone
    await WIKI.models.navigation.deleteNavForEntries([id])
    // -> The FK from `glossaryTerms.pageId` is `set null` (see `db/schema.ts`), so a term canonically
    //    linked to this page is unlinked at the db level already; the cached, resolved copy of that
    //    link needs the same drop or it would keep pointing at a page that no longer exists
    //    (OpenProject #870).
    WIKI.models.glossary.invalidateCache(siteId)

    await WIKI.models.search.deleted(siteId, id)
    await WIKI.models.hooks.emit('page:delete', siteId, {
      id,
      path: page.path,
      locale: page.locale,
      siteId,
      authorId: actor.id
    })
    await WIKI.models.storage.dispatch('page:delete', {
      id,
      path: page.path,
      locale: page.locale,
      siteId,
      authorId: actor.id
    })
    return true
  }

  /**
   * Delete the pages left behind by a folder deletion, which removed their tree entries already.
   *
   * Not optional tidying: a page is served from its own row, found by the hash of its path, and the
   * tree is only consulted for where it sits in the site. A page whose tree entry went with the
   * folder is therefore still live at its URL while being invisible to everything that lists the
   * wiki -- including the file manager somebody would have to use to delete it.
   *
   * Each one is recorded as deleted first, exactly as deleting a single page does. `pageHistory`
   * carries no foreign key back to `pages` precisely so that it outlives the row, which is what makes
   * a folder deleted by mistake recoverable.
   *
   * Also drops each one from the search index, same as `deletePage` — a postgres-backed index has no
   * separate state to clean up, since a deleted row simply stops matching its own query, but an
   * external engine (Elasticsearch, Algolia, ...) keeps a stale entry forever unless told to drop it.
   */
  async deleteOrphaned(siteId: string, entries: DeletedEntry[], actor: PageActor): Promise<void> {
    if (entries.length < 1) {
      return
    }
    // -> Same reasoning as `deletePage`'s own pre-delete read: `notifyWatchers()` needs each page's
    //    classification/tags to re-check `read:pages` per watcher (OpenProject #2173), and `DeletedEntry`
    //    carries neither (a folder deletion never loaded the page rows to begin with) — one bulk SELECT
    //    for the whole batch, not one per entry, before the rows go.
    const pageInfo = new Map(
      (
        await WIKI.db
          .select({
            id: pagesTable.id,
            tags: pagesTable.tags,
            classification: pagesTable.classification
          })
          .from(pagesTable)
          .where(
            inArray(
              pagesTable.id,
              entries.map((entry) => entry.id)
            )
          )
      ).map((row) => [row.id, row])
    )
    for (const entry of entries) {
      await WIKI.models.pageHistory.record({
        siteId,
        pageId: entry.id,
        action: 'deleted',
        authorId: actor.id,
        via: actor.via
      })
      // -> Same ordering as `deletePage`, and for the same reason: still before the bulk delete below.
      //    `DeletedEntry` carries no title (a folder deletion never loaded the page rows to begin
      //    with), so the file name stands in for it, same as the path built for `page:delete` below.
      const info = pageInfo.get(entry.id)
      await this.notifyWatchers(siteId, entry.id, 'deleted', actor.id, {
        title: entry.fileName,
        path: entry.folderPath ? `${entry.folderPath}/${entry.fileName}` : entry.fileName,
        locale: entry.locale,
        classification: info?.classification ?? null,
        tags: info?.tags ?? []
      })
    }
    await WIKI.db.delete(pagesTable).where(
      inArray(
        pagesTable.id,
        entries.map((entry) => entry.id)
      )
    )
    // -> Same reasoning as `deletePage`: a glossary term canonically linked to any of these pages has
    //    a now-stale cached link (OpenProject #870). One call covers the whole batch.
    WIKI.models.glossary.invalidateCache(siteId)

    // -> One per page, as deleting them one at a time would have sent: a subscriber mirroring the
    //    wiki has to hear about each page, not about the folder it happened to sit in
    for (const entry of entries) {
      const path = entry.folderPath ? `${entry.folderPath}/${entry.fileName}` : entry.fileName
      await WIKI.models.search.deleted(siteId, entry.id)
      await WIKI.models.hooks.emit('page:delete', siteId, {
        id: entry.id,
        path,
        locale: entry.locale,
        siteId,
        authorId: actor.id
      })
      await WIKI.models.storage.dispatch('page:delete', {
        id: entry.id,
        path,
        locale: entry.locale,
        siteId,
        authorId: actor.id
      })
    }
    WIKI.logger.debug(`Deleted ${entries.length} page(s) that went with a deleted folder.`)
  }

  /**
   * Ask for a page to be rendered again from its source, without going through an editor.
   *
   * Needed when a stored render has gone stale — the markdown config changed, or the renderer itself
   * did — and there is nobody with the page open to re-save it. The rendering goes through the very
   * same frontend pipeline, driven in a headless browser, so the result is what the editor would have
   * produced; because that costs a browser it is queued rather than done here, one page at a time
   * across the whole instance. See `models/rendering.ts`.
   *
   * What the render may carry is settled here, while there is still an actor to ask, and travels with
   * the queued request.
   *
   * @returns False when there is no such page
   * @throws `renderUnsupportedEditor` for a page the server cannot render, or
   *         `renderPuppeteerMissing` when nothing here could drain the queue
   */
  async queueRerender(siteId: string, id: string, actor: PageActor): Promise<boolean> {
    const page = await this.getPage({ siteId, id })
    if (!page) {
      return false
    }
    await WIKI.models.rendering.ensureCanRender(page.editor)

    await WIKI.models.rendering.queuePage({
      siteId,
      pageId: page.id,
      permissions: {
        scripts: hasPermission(actor, 'write:scripts', { ...page, siteId }),
        styles: hasPermission(actor, 'write:styles', { ...page, siteId })
      },
      requestedById: actor.id
    })
    return true
  }

  /**
   * Store HTML the renderer produced for a page, and re-index it.
   *
   * The counterpart to `queueRerender`: the drain calls this once the browser has been through the
   * content. Post-processed like any other render — it came from a browser either way — against the
   * permissions the person who asked for it had.
   */
  async storeRender(
    siteId: string,
    id: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string
  ): Promise<void> {
    const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
      siteId,
      html,
      permissions,
      pagePath
    )

    const updated = await WIKI.db
      .update(pagesTable)
      .set({ render, toc, searchContent: text, links, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.id, id), eq(pagesTable.siteId, siteId)))
      .returning()

    // -> Nothing was updated when the page went while it sat in the queue
    if (updated[0]) {
      await WIKI.models.search.updated(updated[0])
    }
  }

  /**
   * Resolve a page alias to its path and locale, or null if nothing claims that alias.
   *
   * The locale travels with the path because an alias identifies one specific page, in one specific
   * locale -- the caller (the frontend's `/a/:alias` route) needs both to build a correctly-prefixed
   * link rather than landing on the site's primary-locale default for a translation that isn't.
   */
  async getPathFromAlias(
    siteId: string,
    alias: string
  ): Promise<{ id: string; path: string; locale: string; tags: string[] } | null> {
    const results = await WIKI.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.alias, alias)))
      .limit(1)
    return results[0] ?? null
  }

  /**
   * How many pages currently carry each classification level, instance-wide or narrowed to one site
   * (OpenProject #1081) -- the coverage half of the epic's auditability goal: what does the wiki
   * actually consider sensitive, at a glance, before drilling into any one level's pages.
   *
   * Every level is included even at zero, in level order (most-open first) -- a level nothing is
   * classified as is itself worth an admin seeing, not a row silently missing from the report.
   */
  async classificationReport(
    siteId?: string
  ): Promise<{ levelId: string; name: string; sortOrder: number; count: number }[]> {
    const rows = await WIKI.db
      .select({ classification: pagesTable.classification, count: sql<number>`count(*)::int` })
      .from(pagesTable)
      .where(siteId ? eq(pagesTable.siteId, siteId) : undefined)
      .groupBy(pagesTable.classification)
    const counts = new Map(rows.map((row) => [row.classification, row.count]))
    return WIKI.models.classificationLevels.list().map((level) => ({
      levelId: level.id,
      name: level.name,
      sortOrder: level.sortOrder,
      count: counts.get(level.id) ?? 0
    }))
  }

  /**
   * Every page currently at one classification level, instance-wide or narrowed to one site
   * (OpenProject #1081) -- the drill-down `classificationReport()`'s counts point into. Paginated,
   * newest-updated first; metadata only, matching `listAllForSite()`'s own reasoning for staying out
   * of content.
   */
  async listByClassification(
    levelId: string,
    { siteId, limit = 50, offset = 0 }: { siteId?: string; limit?: number; offset?: number } = {}
  ): Promise<{
    total: number
    entries: { id: string; path: string; locale: string; title: string; siteId: string }[]
  }> {
    const conditions = [
      eq(pagesTable.classification, levelId),
      ...(siteId ? [eq(pagesTable.siteId, siteId)] : [])
    ]
    const where = and(...conditions)
    const [totals, rows] = await Promise.all([
      WIKI.db
        .select({ total: sql<number>`count(*)::int` })
        .from(pagesTable)
        .where(where),
      WIKI.db
        .select({
          id: pagesTable.id,
          path: pagesTable.path,
          locale: pagesTable.locale,
          title: pagesTable.title,
          siteId: pagesTable.siteId
        })
        .from(pagesTable)
        .where(where)
        .orderBy(desc(pagesTable.updatedAt))
        .limit(limit)
        .offset(offset)
    ])
    return { total: totals[0]?.total ?? 0, entries: rows }
  }

  /**
   * A site's page paths and last-updated times, for `/sitemap.xml`.
   *
   * `publishState`/`isBrowsable` are cheap column filters that describe every anonymous reader at
   * once, but they are not the whole of what a guest may see: an administrator can lock a published,
   * browsable page to a signed-in group with a page rule, and that page must not turn up in a sitemap
   * Google reads with no session at all. So every row that survives the column filter is checked again
   * against the guests group's rules with `helpers/pageRules.ts`'s own `read:pages` logic — the same
   * check a real anonymous request would get from `checkAccess` — rather than assuming "published and
   * browsable" already means "public".
   */
  async listPagesForSitemap(
    siteId: string
  ): Promise<Array<{ path: string; locale: string; updatedAt: Date }>> {
    const rows = await WIKI.db
      .select({
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.publishState, 'published'),
          eq(pagesTable.isBrowsable, true)
        )
      )

    const guestRules = WIKI.models.groups.rulesForGroups([WIKI.data.systemIds.guestsGroupId])
    return rows
      .filter((row) =>
        rulesAllow(guestRules, 'read:pages', {
          path: row.path,
          locale: row.locale,
          siteId,
          tags: row.tags,
          classification: row.classification
        })
      )
      .map(({ path, locale, updatedAt }) => ({ path, locale, updatedAt }))
  }

  /**
   * Check an alias is well formed and unclaimed, and normalize an empty one to null.
   */
  private async validateAlias(
    siteId: string,
    alias: string | undefined,
    exceptPageId?: string
  ): Promise<string | null> {
    const value = (alias ?? '').trim()
    if (!value) {
      return null
    }
    if (!reAlias.test(value)) {
      throw new CustomError(
        'pageInvalidAlias',
        'An alias may only contain alphanumeric, hyphen and underscore characters.'
      )
    }
    const conditions = [eq(pagesTable.siteId, siteId), eq(pagesTable.alias, value)]
    if (exceptPageId) {
      conditions.push(ne(pagesTable.id, exceptPageId))
    }
    const duplicate = await WIKI.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(and(...conditions))
      .limit(1)
    if (duplicate.length > 0) {
      throw new CustomError('pageDuplicateAlias', 'Another page already uses this alias.', 409)
    }
    return value
  }

  /**
   * Fold the flat display options back into the `config` blob they are stored in.
   */
  private buildConfig(
    input: Partial<PageInput>,
    siteId: string,
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const defaults = WIKI.sites[siteId]?.config?.defaults ?? {}
    return {
      allowComments: input.allowComments ?? existing.allowComments ?? true,
      allowContributions: input.allowContributions ?? existing.allowContributions ?? true,
      allowRatings: input.allowRatings ?? existing.allowRatings ?? true,
      showSidebar: input.showSidebar ?? existing.showSidebar ?? true,
      showTags: input.showTags ?? existing.showTags ?? true,
      showToc: input.showToc ?? existing.showToc ?? true,
      tocDepth: input.tocDepth ?? existing.tocDepth ?? defaults.tocDepth ?? { min: 1, max: 2 }
    }
  }

  /**
   * Same for the per-page scripts — which only an author holding the matching permission may set.
   *
   * Silently dropped rather than refused, as with the rest of the sanitizing: an author pasting a
   * page template that carries scripts should get their page, minus the scripts.
   */
  private buildScripts(
    input: Partial<PageInput>,
    actor: PageActor,
    page: RulePageRef,
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const mayScript = hasPermission(actor, 'write:scripts', page)
    const mayStyle = hasPermission(actor, 'write:styles', page)
    return {
      jsLoad: mayScript ? (input.scriptJsLoad ?? existing.jsLoad ?? '') : (existing.jsLoad ?? ''),
      jsUnload: mayScript
        ? (input.scriptJsUnload ?? existing.jsUnload ?? '')
        : (existing.jsUnload ?? ''),
      css: mayStyle ? (input.scriptCss ?? existing.css ?? '') : (existing.css ?? '')
    }
  }

  /**
   * Queue pending watch notifications for a page change.
   *
   * Never called for `created`: nobody could have been watching a page before it existed, so a
   * freshly created page has no watchers to notify by construction (there is no page restore/undelete
   * feature yet that would make this untrue — see `deleteOrphaned` and `pageHistory` for why a
   * deletion is recoverable in principle even though nothing currently offers it back). `moved`
   * qualifies by default, same as `updated`, for a watcher who has never touched their preference —
   * see `pageWatching.ts#DEFAULT_PREFERENCE`.
   *
   * The watcher list — now paired with each watcher's resolved `notifyMode`, from
   * `pageWatching.listWatchers` — is resolved here, synchronously, rather than inside the job this
   * queues: a delete removes the page in the very same request, and `pageWatching.pageId` cascades
   * away with it, so a job that only got around to resolving watchers (or their preference) later
   * would find nothing left to read for a `deleted` event. `page` and `changedFields` are threaded
   * through for the same reason: the job composing the actual email cannot re-query a page that, for a
   * delete, is by then already gone. That resolution is one indexed `SELECT` — it does not scale with
   * how many people watch the page, so awaiting it here costs the save a fixed, small amount regardless
   * of audience size. What DOES scale with the audience — writing one `pageWatchEvents` row per
   * watcher, and sending the mail for the ones who want it immediately — is exactly the part pushed
   * into the queued job, which is why this awaits nothing past resolving the (possibly empty) watcher
   * list and asking the scheduler to queue one job for it.
   *
   * A failure to queue is logged and swallowed rather than thrown: a watcher not being told about a
   * change is a real loss, but it must never be the reason the change itself fails to save.
   *
   * `page.classification`/`page.tags` are threaded through to `pageWatching.listWatchers()` so it can
   * re-check `read:pages` per watcher against the page's post-change state (OpenProject #2173) —
   * `read:pages` used to be checked once, at subscribe time, and never again, so a watcher whose access
   * has since been revoked (a raised classification, a move into a restricted branch, an edited group
   * rule) would otherwise still be queued a notification carrying the page's title and a working link.
   *
   * @param changedFields What `movePage`/`updatePage` already computed for `pageHistory.record` —
   *   `['path']`/`['title']` for a move, whichever page fields for an edit. Always empty for a delete.
   */
  private async notifyWatchers(
    siteId: string,
    pageId: string,
    action: PageWatchNotifiableAction,
    actorId: string,
    page: {
      title: string
      path: string
      locale: string
      classification: string | null
      tags?: string[]
    },
    changedFields: string[] = []
  ): Promise<void> {
    try {
      const watchers = await WIKI.models.pageWatching.listWatchers(pageId, actorId, action, {
        path: page.path,
        locale: page.locale,
        siteId,
        classification: page.classification,
        tags: page.tags
      })
      if (watchers.length < 1) {
        return
      }
      await WIKI.scheduler.addJob({
        task: 'notifyPageWatchers',
        payload: {
          siteId,
          pageId,
          pageTitle: page.title,
          pagePath: page.path,
          pageLocale: page.locale,
          action,
          changedFields,
          actorId,
          watchers
        }
      })
    } catch (err: any) {
      WIKI.logger.warn(`Failed to queue watch notifications for page ${pageId}: ${err.message}`)
    }
  }

  /**
   * What a page's tree entry carries about it, so a folder listing needs no join.
   */
  private treeMeta(page: any): Record<string, any> {
    return {
      authorId: page.authorId,
      contentType: page.contentType,
      creatorId: page.creatorId ?? page.authorId,
      description: page.description ?? '',
      editor: page.editor,
      isBrowsable: page.isBrowsable,
      ownerId: page.ownerId ?? page.authorId,
      publishState: page.publishState,
      publishEndDate: page.publishEndDate ?? null,
      publishStartDate: page.publishStartDate ?? null
    }
  }
}

export const pages = new Pages()
