import bcrypt from 'bcryptjs'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import { pages as pagesTable, tree as treeTable, users as usersTable } from '../db/schema.ts'
import {
  BCRYPT_ROUNDS,
  CustomError,
  generatePathHash,
  isUniqueViolation,
  normalizePagePath
} from '../helpers/common.ts'
import {
  assertLocaleActive,
  assertPathNotReservedAppRoute,
  assertPathNotReservedLocale,
  defaultLocale
} from '../helpers/localeRouting.ts'
import { rulesAllow } from '../helpers/pageRules.ts'
import { invalidateGraphCache } from '../helpers/graphCache.ts'
import { rewriteLinkText, rewriteRedirectTarget } from '../helpers/pageLinkRewrite.ts'
import { isLegacyWysiwygJson } from '../helpers/wysiwygHeadlessMarkdown.ts'
import { computeTranslationStaleness } from '../helpers/translationStaleness.ts'
import type { TranslationStalenessEntry } from '../helpers/translationStaleness.ts'
import { announce } from './hooks.ts'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'
import type { PageHistoryVia } from './pageHistory.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'
import type { TocNode } from './rendering.ts'
import { pageIsVisible } from './tree.ts'
import type { DeletedEntry } from './tree.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'
import type { WikiTx } from '../core/db.ts'
import type { LogFields } from '../core/logger.ts'

const EDITOR_CONTENT_TYPES: Record<string, string> = {
  markdown: 'markdown',
  asciidoc: 'asciidoc',
  wysiwyg: 'markdown',
  code: 'html',
  redirect: 'redirect'
}

/**
 * Built first-wins rather than with `Object.fromEntries` (last entry wins on a collision):
 * `wysiwyg` and the plain `markdown` editor both produce `'markdown'`, and a file-backed
 * `'markdown'` page (disk storage, git sync) must not attribute itself to `wysiwyg`, an editor its
 * content never went through.
 */
const CONTENT_TYPE_EDITORS: Record<string, string> = {}
for (const [editor, contentType] of Object.entries(EDITOR_CONTENT_TYPES)) {
  if (!(contentType in CONTENT_TYPE_EDITORS)) {
    CONTENT_TYPE_EDITORS[contentType] = editor
  }
}

export function getEditorForContentType(contentType: string): string {
  return CONTENT_TYPE_EDITORS[contentType] ?? 'markdown'
}

/**
 * `wysiwyg` and `markdown` both answer `'markdown'`, which is the point for a caller asking whether
 * an editor's OUTPUT is renderable: a page is renderable by content, not by which editor happened
 * to write it.
 */
export function getContentTypeForEditor(editor: string): string {
  return EDITOR_CONTENT_TYPES[editor] ?? 'text'
}

/**
 * A redirection is an ordinary page — path, title, icon, a place in the tree — with nothing to read:
 * no body, no render, nothing for the search index to hold. Its content column carries where it
 * points instead.
 */
const REDIRECT_EDITOR = 'redirect'

/**
 * `markdown` and `wysiwyg` share `'markdown'` storage, which is what makes a flip between them a
 * relabel rather than a content transform. `code` and `asciidoc` each produce a content type nothing
 * else shares, and `redirect` isn't an editor a page's text goes through.
 */
const CONVERTIBLE_EDITORS = ['markdown', 'wysiwyg']

/**
 * So the query can never scan an unbounded table. Not the sitemaps.org 50,000-URL-per-file cap
 * `controllers/seo.ts` paginates its result around, and sized well past any realistic installation.
 */
const SITEMAP_QUERY_CAP = 500_000

const rePagePath = /^[a-zA-Z0-9-_/]*$/
const reAlias = /^[a-zA-Z0-9-_]*$/

/**
 * `listPagesForSitemap` is a whole-table scan plus a per-row page-rule evaluation, and the route
 * carries no rate limiting of its own — a few minutes keeps a crawl loop from repeating that work on
 * every request without making a fresh publish invisible for long.
 */
export const SITEMAP_CACHE_TTL_MS = 5 * 60 * 1000

function sitemapCacheKey(siteId: string): string {
  return `sitemap:${siteId}`
}

/**
 * Enough of a row for `getPage`'s `unlocked`/`withPassword` callbacks to ask `mayOnPage()` whether a
 * page rule applies, without exposing the whole raw row to them.
 */
export interface UnlockPageRef {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
}

const CONFIG_FIELDS = [
  'allowComments',
  'allowContributions',
  'showSidebar',
  'showTags',
  'showToc',
  'tocDepth'
] as const

const SCRIPT_FIELDS = ['scriptJsLoad', 'scriptJsUnload', 'scriptCss'] as const

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
   * Absent, rather than false, for a requester who may not edit the page: they cannot tell "no
   * password" from "withheld". Never the password itself nor its stored `bcrypt` hash, which
   * nothing reads back, only replaces.
   */
  hasPassword?: boolean
  /** Whether the body was withheld because the page is password protected. */
  isLocked: boolean
  relations: any[]
  tags: string[]
  toc: TocNode[]
  render: string
  /** Present when the request asked for it, and always for a redirection (`RedirectContent`). */
  content?: string
  allowComments: boolean
  allowContributions: boolean
  showSidebar: boolean
  showTags: boolean
  showToc: boolean
  tocDepth: { min: number; max: number }
  /**
   * Stored together as the `scripts` jsonb column (`{ jsLoad, jsUnload, css }`) and flattened here
   * the same way `config` flattens above.
   */
  scriptJsLoad: string
  scriptJsUnload: string
  scriptCss: string
  navigationId: string | null
  navigationMode: string
  authorId: string
  authorName: string
  createdAt: Date
  updatedAt: Date
  /** A classification level id, never absent -- there is no unclassified state. */
  classification: string
}

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
  /**
   * Plaintext, write-only: hashed with `bcrypt` before it touches the database. `undefined` leaves
   * the page's password untouched, an empty string removes it, a non-empty string replaces it.
   */
  password?: string
  relations?: any[]
  tags?: string[]
  /**
   * Absent on create defaults to the immediate parent page's own level (or the most-open configured
   * level, with no parent page to inherit from); absent on update leaves it untouched.
   */
  classification?: string
  allowComments?: boolean
  allowContributions?: boolean
  showSidebar?: boolean
  showTags?: boolean
  showToc?: boolean
  tocDepth?: { min: number; max: number }
  /** Undefined leaves the stored value untouched on update; absent on create stores `''`. */
  scriptJsLoad?: string
  scriptJsUnload?: string
  scriptCss?: string
  /** Not a page field: it is recorded on the history row this save produces. */
  reasonForChange?: string
  /**
   * Backdates the column instead of stamping the moment `createPage()` runs. Only the migration
   * importer supplies it, to carry a source page's real creation time across rather than replacing
   * it with import time — the bug upstream requarks/wiki#4631 describes.
   */
  createdAt?: string
  /**
   * Same reasoning as {@link createdAt} — also the `versionDate` of the single `pageHistory` row
   * `createPage()` writes, so that row carries the source's real last-modified time too.
   */
  updatedAt?: string
}

export interface CreatedPageRows {
  page: typeof pagesTable.$inferSelect
  hasRenderInput: boolean
}

export interface GraphPageRow {
  /** Not surfaced on a `GraphNode` itself -- the join key for `pageHistory.pageId`'s edit-volume
   *  node-sizing counts. */
  id: string
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  classification: string
  relations: {
    pos: 'left' | 'center' | 'right'
    label: string
    caption: string
    icon: string
    target: string
  }[]
  links: string[]
  publishState: 'draft' | 'published' | 'scheduled'
}

/** Carries `tags`/`classification` so the route can run `mayOnPage` per row. */
export interface BacklinkRow {
  id: string
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  classification: string
}

/** Carries `tags`/`classification` so the route can run `mayOnPage` per row, and `updatedAt` for
 *  the staleness comparison. */
export interface TranslationStatusRow {
  id: string
  path: string
  locale: string
  tags: string[]
  classification: string
  publishState: 'draft' | 'published' | 'scheduled'
  updatedAt: Date
}

/**
 * `write:scripts`/`write:styles` are page-rule-scoped permissions, not group-wide ones, so the flat
 * `permissions` list cannot decide them: `groupIds` is what
 * `CARDINAL.models.groups.checkAccess()` resolves a page rule against, and `scope`/`siteId` carry an
 * API key's own scope narrowing and site pin, because `hasPermission()`'s `checkAccess()` call is
 * the one page-rule decision here that never routes through `groups.actorForRequest()` (which
 * already carries them).
 */
export interface PageActor {
  id: string
  permissions: string[]
  groupIds: string[]
  scope?: string[] | null
  allowedClassifications?: string[] | null
  siteId?: string | null
  /** Undefined for the standard editor; otherwise what made the save, e.g. an MCP tool call. */
  via?: PageHistoryVia
  /**
   * Page-rule permission names force-granted on every page, bypassing
   * `CARDINAL.models.groups.checkAccess()`'s rule engine entirely. `checkAccess()` resolves a
   * page-rule permission only from `groupIds`-derived rules or a `manage:system` grant, so it can
   * never answer for a caller with no group membership at all: the 2.5.x migration importer's
   * synthetic per-page actor. Leave unset for every ordinary actor.
   */
  forcedPagePermissions?: string[]
}

export interface UpdatePageOptions {
  /**
   * Overrides what `patch.render` is post-processed against, instead of deriving it from `actor`.
   * `approveSubmission` (`models/approvals.ts`) is the reason this exists: `actor` there is the
   * reviewer finalizing someone else's edit suggestion, and the HTML being written is the
   * submitter's -- resolving `write:scripts`/`write:styles` from `actor` would let a reviewer's own
   * grants launder a submitter's `<script>`/`<style>` past a permission the submitter never held.
   */
  renderPermissions?: RenderPermissions
  /**
   * `patch.render` is the page's STORED render with one edit already made to it by the caller (the
   * tick route flipping a checkbox), so it is written as it is: not post-processed again, and
   * `toc`/`searchContent`/`links` left alone. Post-processing it would re-sanitize markup already
   * sanitized for whoever last saved it against THIS actor's `write:scripts`/`write:styles`, and
   * swap another author's embed for the "requires the permission" callout the moment somebody
   * without those grants ticks a box. The caller answers for `patch.render` holding nothing the
   * stored render did not.
   */
  storedRenderPatch?: boolean
  /**
   * Write only if the row's `updatedAt` still reads this, to the millisecond a client ever sees,
   * and otherwise refuse with `pageChangedSinceLoad` (409) having written nothing. The comparison is
   * part of the `UPDATE` itself, so two saves made from the same view cannot both pass it.
   */
  expectedUpdatedAt?: Date
}

/**
 * For the lifecycle log line and nothing else. A recovery (`pageHistory.recoverDeletedPage`) really
 * does insert a brand new page row, so it goes through `createPage()` like every other create — but
 * an operator reading the log wants to see the page coming *back*. Everything the call writes is
 * identical either way.
 */
export type PageWriteOrigin = 'restore'

/**
 * `user` is the actor's own id — never an e-mail address — and `system` stands in for a write with
 * no actor behind it at all.
 */
function actorFields(actor: { id?: string | null; via?: PageHistoryVia }): LogFields {
  return {
    user: actor.id || 'system',
    ...(actor.via ? { via: actor.via } : {})
  }
}

/**
 * `actor.permissions` is the group-wide list and a page-rule-only grant never appears in it, so this
 * asks the rule engine instead. `forcedPagePermissions` short-circuits ahead of it — see
 * `PageActor`.
 */
export function hasPermission(actor: PageActor, permission: string, page: RulePageRef): boolean {
  if (actor.forcedPagePermissions?.includes(permission)) {
    return true
  }
  return CARDINAL.models.groups.checkAccess(actor, permission, page)
}

/**
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
 * `kind` is stored rather than sniffed off the target, because it is the question the author actually
 * answered: the two are not reliably told apart afterwards — `/help` is a page here and a perfectly
 * good relative URL elsewhere — and the editor has to reopen on the choice that was made.
 */
export interface RedirectContent {
  kind: 'page' | 'url'
  /** A rooted path within this wiki, or an absolute `http(s)` URL. */
  target: string
  showInterstitial: boolean
}

/**
 * Re-serialized rather than stored as it arrived, so that the column holds one canonical spelling: a
 * save that changes nothing then reports no change, and the history rows say what they mean.
 *
 * A URL target is held to `http`/`https` deliberately: this value ends up in a `location` assignment
 * that is followed without the reader clicking anything, so any other scheme is either useless
 * (`mailto:`) or an invitation (`javascript:`).
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
 * A page is a row here plus a row in the tree that gives it its place in the site. The markdown is
 * authored and rendered in the browser: what arrives is both the source and the HTML, and the HTML
 * goes through `models/rendering.ts` before being stored — where it is sanitized against what the
 * author is actually allowed to embed, and where the table of contents and the search text come
 * from.
 */
class Pages {
  /**
   * @param locked Withhold the body, keeping the metadata: the lock screen is drawn from it.
   * @param withContent Include the source. A redirection's comes back either way — its content is
   *                    where the page sends its reader, which the page view never asks for.
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
      ...(withPassword ? { hasPassword: Boolean(row.password) } : {}),
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
      showSidebar: config.showSidebar ?? true,
      showTags: config.showTags ?? true,
      showToc: config.showToc ?? true,
      tocDepth: config.tocDepth ?? { min: 1, max: 2 },
      // -> Blanked for a locked page, like `render`/`toc` above: there is nothing to run against a
      //    body that wasn't sent, and the scripts are part of what the password protects.
      scriptJsLoad: locked ? '' : (scripts.jsLoad ?? ''),
      scriptJsUnload: locked ? '' : (scripts.jsUnload ?? ''),
      scriptCss: locked ? '' : (scripts.css ?? ''),
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
   * The hash is what the frontend addresses a page with (`generatePathHash`).
   *
   * A password-protected page still comes back to a requester who has not unlocked it: the metadata
   * is what the lock screen is drawn from, and it is the body that is withheld (`toPage`'s
   * `locked`). The enforcement is this method and not the client, so anything that puts a page's
   * text in front of a reader has to go through here, or through the same check.
   *
   * **The defaults hand over the whole page**: most callers here are a save, a move, a delete or a
   * re-render, and none of those is a reader — a save handed a withheld body would answer its
   * author with an empty page, and a re-render would store one. A path that serves a reader has to
   * say so.
   *
   * @param unlocked Whether the password has been satisfied for this requester (`unlockedFor` in
   *                 `helpers/pageAccess.ts`). A function is called with the row once it is in hand:
   *                 deciding this needs the page's path, locale and tags to ask `mayOnPage()`
   *                 whether a page RULE bypasses the password, and a caller that knew only a path
   *                 hash going in has none of them.
   * @param withPassword Whether to include `hasPassword`, for whoever may edit the page — not for a
   *                     reader who just entered it. A function for the same reason as `unlocked`.
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
    /** Published pages only — what a reader with no session may see. */
    publicOnly?: boolean
    unlocked?: boolean | ((page: UnlockPageRef) => boolean)
    withPassword?: boolean | ((page: UnlockPageRef) => boolean)
  }): Promise<Page | null> {
    const conditions = [eq(pagesTable.siteId, siteId)]
    if (publicOnly) {
      // -> A password does not hide a page from an anonymous reader — it withholds the body until
      //    they enter it, which is what `locked` below does.
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

    // -> `password` is selected for the `locked` check below even when `withPassword` is off.
    //    `content` is decided in SQL rather than after the fact because a redirection's comes back
    //    even when `withContent` is off, and the row's `editor` isn't known until the query has run.
    const results = await CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        hash: pagesTable.hash,
        alias: pagesTable.alias,
        title: pagesTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        locale: pagesTable.locale,
        editor: pagesTable.editor,
        contentType: pagesTable.contentType,
        publishState: pagesTable.publishState,
        publishStartDate: pagesTable.publishStartDate,
        publishEndDate: pagesTable.publishEndDate,
        isBrowsable: pagesTable.isBrowsable,
        isSearchable: pagesTable.isSearchable,
        password: pagesTable.password,
        relations: pagesTable.relations,
        tags: pagesTable.tags,
        toc: pagesTable.toc,
        render: pagesTable.render,
        content: withContent
          ? pagesTable.content
          : sql<
              string | null
            >`CASE WHEN ${pagesTable.editor} = ${REDIRECT_EDITOR} THEN ${pagesTable.content} ELSE NULL END`,
        config: pagesTable.config,
        scripts: pagesTable.scripts,
        authorId: pagesTable.authorId,
        createdAt: pagesTable.createdAt,
        updatedAt: pagesTable.updatedAt,
        classification: pagesTable.classification,
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
      id: row.id,
      path: row.path,
      locale: row.locale,
      tags: row.tags,
      classification: row.classification
    }
    const isUnlocked = typeof unlocked === 'function' ? unlocked(unlockRef) : unlocked
    const includePassword =
      typeof withPassword === 'function' ? withPassword(unlockRef) : withPassword
    return this.toPage(row, {
      withContent,
      withPassword: includePassword,
      locked: Boolean(row.password) && !isUnlocked
    })
  }

  /**
   * One query regardless of how many ids are asked for, for a caller running `mayOnPage`-style
   * checks over a batch without paying for `getPage`'s full two-LEFT-JOIN select once per id. A
   * missing key is an id that did not resolve — not on this site, or not existing at all.
   */
  async getPagesByIds(
    siteId: string,
    ids: string[]
  ): Promise<
    Map<
      string,
      { id: string; path: string; locale: string; tags: string[]; classification: string }
    >
  > {
    if (ids.length < 1) {
      return new Map()
    }
    const rows = await CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.id, ids)))
    return new Map(rows.map((row) => [row.id, row]))
  }

  /**
   * Not for anything reader-facing: no pagination and no publish-state or permission filtering, for
   * a full walk of a site's pages (a file-backed storage target reconciling its repo against the DB,
   * chiefly). `listPages` on the tree model is the reader-facing one. Content is fetched per page
   * via `getPage({ withContent: true })`.
   */
  async listAllForSite(
    siteId: string
  ): Promise<{ id: string; path: string; locale: string; contentType: string }[]> {
    return CARDINAL.db
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
   * `publicOnly` applies `pageIsVisible` (`tree.ts`): `assembleGraph`'s `canRead` filter is a
   * *permission* check, not a publication one, and was never going to catch a draft or an
   * `isBrowsable: false` page. The row also carries `publishState`, so a caller holding one shared
   * `publicOnly: false` bundle can narrow it to published-only rows itself, per request, without
   * re-querying.
   *
   * Deliberately NOT narrowed by actor: the result is the shared, per-site graph cache, rebuilt by
   * whichever signed-in caller happens to hit a cold cache first. Narrowing the fetch to that one
   * caller's rule set would bake their read scope into the bundle every other caller reuses until
   * the TTL expires. The exact per-request filter still runs in `assembleGraph`'s `canRead` -- this
   * only has to be a safe superset of what SOME caller may read.
   */
  async listAllForGraph(siteId: string, publicOnly = false): Promise<GraphPageRow[]> {
    return CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        icon: pagesTable.icon,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        relations: pagesTable.relations,
        links: pagesTable.links,
        publishState: pagesTable.publishState
      })
      .from(pagesTable)
      .where(
        and(eq(pagesTable.siteId, siteId), ...pageIsVisible(pagesTable, publicOnly))
      ) as Promise<GraphPageRow[]>
  }

  /**
   * Unfiltered by permission: the route filters each row through `mayOnPage`. One `jsonb`
   * containment query against the array `models/rendering.ts#extractInternalLinks` writes on every
   * save, rather than a re-parse of anyone's content.
   */
  async listBacklinks(siteId: string, targetPath: string): Promise<BacklinkRow[]> {
    return CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        icon: pagesTable.icon,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          sql`${pagesTable.links} @> ${JSON.stringify([targetPath])}::jsonb`
        )
      ) as Promise<BacklinkRow[]>
  }

  /**
   * The same translation link `getTranslations()` follows -- same `(siteId, path)`, other locales --
   * but lightweight: no content, no per-row `getPage()` round trip. Applies no visibility narrowing
   * of its own, so the caller filters rows to what THIS requester may actually see before handing
   * them on.
   */
  async listTranslationStatusRows(siteId: string, path: string): Promise<TranslationStatusRow[]> {
    return CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        publishState: pagesTable.publishState,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.path, path))) as Promise<
      TranslationStatusRow[]
    >
  }

  /**
   * Deliberately the only way past the lock: a reader gets the body from here or from a `getPage`
   * the route has already marked as unlocked, and never from a flag the browser sent.
   *
   * @returns null when the password is wrong or the page has none — the caller cannot tell those
   *          apart, and neither can whoever is guessing.
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
      Asked for as a reader would see it: a wrong guess must not assemble the body in the first
      place, and `isLocked` is how this knows there is a password to check at all.
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
    const stored = await CARDINAL.db
      .select({ password: pagesTable.password })
      .from(pagesTable)
      .where(eq(pagesTable.id, page.id))
      .limit(1)
    const expected = stored[0]?.password
    if (!expected || !(await bcrypt.compare(password, expected))) {
      return null
    }
    // -> Unlocked, but still without `hasPassword`: entering a password is not the same as being
    //    able to change it
    return this.getPage({
      siteId,
      id: page.id,
      publicOnly,
      unlocked: true,
      withPassword: false
    })
  }

  /** @param actor Their permissions decide what survives sanitizing. */
  async createPage(
    siteId: string,
    input: PageInput,
    actor: PageActor,
    { origin }: { origin?: PageWriteOrigin } = {}
  ): Promise<Page> {
    const created = await this.insertPageRows(siteId, input, actor)
    return this.completePageCreate(siteId, created, input, actor, { origin })
  }

  /**
   * The database half of `createPage`, split out so a caller creating several pages in one
   * transaction can commit them together and only then run `completePageCreate` for each.
   */
  async insertPageRows(
    siteId: string,
    input: PageInput,
    actor: PageActor,
    { tx, passwordHash }: { tx?: WikiTx; passwordHash?: string | null } = {}
  ): Promise<CreatedPageRows> {
    if (!CARDINAL.sites[siteId]) {
      throw new CustomError('pageInvalidSite', 'This site does not exist.', 404)
    }

    const path = normalizePath(input.path)
    await assertPathNotReservedLocale(path, siteId)
    assertPathNotReservedAppRoute(path)
    const locale = input.locale || defaultLocale(siteId)
    // -> A locale that used to be enabled and got turned off is not a valid target for a new page,
    //    including one recreated by the deletion-recovery flow into a locale that no longer exists
    assertLocaleActive(siteId, locale)
    const title = (input.title ?? '').trim()
    if (title.length < 1) {
      throw new CustomError('pageTitleMissing', 'A page needs a title.')
    }
    const editor = input.editor || 'markdown'
    const isRedirect = editor === REDIRECT_EDITOR
    // -> A redirection has no body to be empty: what it holds instead is where it points, and that
    //    has its own rules about being filled in
    const content = isRedirect ? normalizeRedirectContent(input.content) : input.content
    if (!isRedirect && (!content || content.trim().length < 1)) {
      throw new CustomError('pageEmptyContent', 'A page cannot be empty.')
    }

    const hash = generatePathHash(path)
    await this.assertNoPageAt(siteId, locale, path)

    const alias = await this.validateAlias(siteId, input.alias)
    const classification = await CARDINAL.models.pageClassification.resolveCreateClassification(
      siteId,
      locale,
      path,
      input.classification
    )
    // -> `classification: null` deliberately, even though the value the page is ABOUT to be created
    //    with is already known: `write:scripts`/`write:styles` are checked against the page as it
    //    exists right now, which is not at all, so a not-yet-existing page fails closed.
    const pageRef: RulePageRef = { path, locale, siteId, tags: input.tags, classification: null }

    /*
      Refuse up front when nothing here could ever produce a render, rather than land a page whose
      render, search text and outbound links never catch up to its content.
    */
    const hasRenderInput = input.render !== undefined
    if (!hasRenderInput) {
      await CARDINAL.models.renderQueue.ensureCanRender(editor)
    }

    const { render, toc, text, links } = await CARDINAL.models.rendering.postProcess(
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
      inserted = await (tx ?? CARDINAL.db)
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
          autoTagPending: (input.tags ?? []).length < 1,
          isBrowsable: input.isBrowsable ?? true,
          // -> A redirection has nothing to find: it is a doorway to the page the reader actually
          //    wanted, which is the one search should offer
          isSearchable: isRedirect ? false : (input.isSearchable ?? true),
          locale,
          password:
            passwordHash ??
            (input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : null),
          path,
          publishState: input.publishState ?? 'published',
          publishStartDate: input.publishStartDate ? new Date(input.publishStartDate) : null,
          publishEndDate: input.publishEndDate ? new Date(input.publishEndDate) : null,
          relations: input.relations ?? [],
          links,
          render,
          scripts: this.buildScripts(input),
          searchContent: text,
          siteId,
          tags: input.tags ?? [],
          title,
          toc,
          ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
          ...(input.updatedAt ? { updatedAt: new Date(input.updatedAt) } : {})
        })
        .returning()
    } catch (err: any) {
      // -> The probe above covers the common case; this catches the race it cannot close -- two
      //    requests that both pass the probe before either inserts
      if (isUniqueViolation(err)) {
        throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
      }
      throw err
    }

    const page = inserted[0]

    try {
      await CARDINAL.models.tree.addPage({
        id: page.id,
        parentPath: pathParts.slice(0, -1).join('/'),
        fileName: pathParts.at(-1)!,
        title: page.title,
        locale,
        siteId,
        tags: input.tags ?? [],
        meta: this.treeMeta(page),
        ...(tx ? { db: tx } : {})
      })
    } catch (err) {
      // -> A page with no tree entry is invisible to navigation and to the file manager, which is
      //    worse than not having saved it at all. Inside a caller's transaction the failed statement
      //    has aborted it, so a delete here would only mask the real error; their rollback removes
      //    the page row.
      if (!tx) {
        await CARDINAL.db.delete(pagesTable).where(eq(pagesTable.id, page.id))
      }
      throw err
    }

    return { page, hasRenderInput }
  }

  async completePageCreate(
    siteId: string,
    { page, hasRenderInput }: CreatedPageRows,
    input: Pick<PageInput, 'updatedAt' | 'reasonForChange'>,
    actor: PageActor,
    { origin }: { origin?: PageWriteOrigin } = {}
  ): Promise<Page> {
    const { locale } = page

    await CARDINAL.models.pageHistory.record({
      siteId,
      pageId: page.id,
      action: 'created',
      authorId: actor.id,
      via: actor.via,
      reason: input.reasonForChange,
      versionDate: input.updatedAt ? new Date(input.updatedAt) : undefined
    })
    // -> No `notifyWatchers` call here: nobody can be watching a page before it exists

    await CARDINAL.models.search.created(page)
    if (hasRenderInput) {
      // -> Only on this branch: when a render is queued instead, `storeRender()` is what queues the
      //    embed job, once the real content actually lands
      await this.enqueueEmbedJob(page.id)
    }
    await announce(
      'page:create',
      siteId,
      { id: page.id, path: page.path, locale, siteId, authorId: actor.id },
      { metadata: { title: page.title, description: page.description, editor: page.editor } }
    )
    // -> A new page defaults to published and browsable, so the cached sitemap list and graph bundle
    //    both have to see it on the very next request.
    this.invalidateSiteCaches(siteId)

    // -> Emitted from the model rather than from the route, so every caller -- editor, MCP tool,
    //    2.5.x import, storage sync -- produces the identical line. A page's *edits* stay at `debug`
    //    (the history table records every one of them); its appearance does not.
    CARDINAL.logger.info('pages', origin === 'restore' ? 'restored' : 'created', {
      site: siteId,
      page: page.id,
      path: page.path,
      locale,
      ...actorFields(actor)
    })

    const finalPage = (await this.getPage({ siteId, id: page.id })) as Page

    if (!hasRenderInput) {
      // -> Briefly blank rather than wrong: this fills `render`/`toc`/`searchContent`/`links` in
      //    from the content just written. `ensureCanRender()` was confirmed before the write, so
      //    this enqueues directly rather than through `queueRerender()`'s own copy of that check.
      await this.enqueueRerender(siteId, finalPage, actor)
    }

    return finalPage
  }

  /**
   * @param options See `UpdatePageOptions`; an ordinary save passes none of them.
   * @throws CustomError `pageChangedSinceLoad` (409) when `options.expectedUpdatedAt` is stale
   */
  async updatePage(
    siteId: string,
    id: string,
    patch: Partial<PageInput>,
    actor: PageActor,
    { renderPermissions, storedRenderPatch = false, expectedUpdatedAt }: UpdatePageOptions = {}
  ): Promise<Page | null> {
    const results = await CARDINAL.db
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
    /*
      The lazy on-open fallback for a row the run-once conversion job (`convertLegacyWysiwygRow`)
      could not parse: it stays a legacy `contentType: 'html'` row holding raw Tiptap JSON until
      somebody actually opens it, and `EditorWysiwyg.vue`'s save then writes real markdown into
      `content` above. `contentType` is otherwise immutable here, and this is the one case where it
      must move: the row's true shape changed under it.
    */
    const isLegacyWysiwygConversionSave =
      existing.editor === 'wysiwyg' &&
      existing.contentType === 'html' &&
      isLegacyWysiwygJson(existing.content) &&
      patch.content !== undefined &&
      !isLegacyWysiwygJson(values.content)
    if (isLegacyWysiwygConversionSave) {
      values.contentType = 'markdown'
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
      // -> Never searchable for a redirection, for the reason `createPage` gives
      values.isSearchable = isRedirect ? false : patch.isSearchable
    }
    if (patch.password !== undefined) {
      values.password = patch.password ? await bcrypt.hash(patch.password, BCRYPT_ROUNDS) : null
    }
    if (patch.relations !== undefined) {
      values.relations = patch.relations
    }
    if (patch.tags !== undefined) {
      values.tags = patch.tags
    }
    // -> The declassification guardrail (`manage:classification`) is checked one layer up, in
    //    `api/pages/write.ts`. This is the structural check: a page's classification, whichever
    //    direction it moves, may never end up below its immediate parent's floor.
    // -> Compared against the row as it stands, not merely `!== undefined`: the editor can send a
    //    patch that restates the current level, and `page:classification-changed` must never fire
    //    for that -- a webhook on a no-op change is worse than no webhook for a compliance
    //    integration.
    const classificationChanged =
      patch.classification !== undefined && patch.classification !== existing.classification
    if (patch.classification !== undefined) {
      const floorId = await CARDINAL.models.pageClassification.parentClassification(
        siteId,
        existing.locale,
        existing.path
      )
      CARDINAL.models.pageClassification.assertClassificationMeetsFloor(
        patch.classification,
        floorId
      )
      values.classification = patch.classification
    }

    const existingRef: RulePageRef = {
      path: existing.path,
      locale: existing.locale,
      siteId: existing.siteId,
      tags: existing.tags ?? [],
      classification: existing.classification
    }

    /*
      Refuse up front when this instance could never produce a render, so the caller gets an
      actionable error instead of a page whose HTML, search text and outbound links stay pinned to
      the revision being replaced.
    */
    const hasRenderInput = patch.render !== undefined
    const needsRerenderQueue = patch.content !== undefined && !hasRenderInput
    if (needsRerenderQueue) {
      await CARDINAL.models.renderQueue.ensureCanRender(existing.editor)
    }

    // -> A render only means anything next to the content it came from, so the two move together --
    //    the real one when this save carried one, a blank placeholder when it didn't, so nothing
    //    here goes on matching text or outbound links the new content no longer has.
    if (hasRenderInput && storedRenderPatch) {
      values.render = patch.render
    } else if (hasRenderInput || needsRerenderQueue) {
      const { render, toc, text, links } = await CARDINAL.models.rendering.postProcess(
        siteId,
        patch.render ?? '',
        renderPermissions ?? {
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
    if (SCRIPT_FIELDS.some((field) => patch[field] !== undefined)) {
      values.scripts = this.buildScripts(patch, existing.scripts as Record<string, any>)
    }

    // -> The author is whoever last changed it; the creator and owner do not move
    values.authorId = actor.id

    // -> Worked out before the write, against the row as it stands: the editor sends every field on
    //    every save, so the patch alone would report a change to all of them
    const changedFields = CARDINAL.models.pageHistory.changedFields(existing, values)

    // -> `.returning()` gets the raw row for free off the same write:
    //    `CARDINAL.models.search.updated` wants the full `pages` row, not the flattened `Page` shape
    //    `getPage` below produces
    const rawRows = await CARDINAL.db
      .update(pagesTable)
      .set(values)
      .where(
        and(
          eq(pagesTable.id, id),
          ...(expectedUpdatedAt
            ? [sql`date_trunc('milliseconds', ${pagesTable.updatedAt}) = ${expectedUpdatedAt}`]
            : [])
        )
      )
      .returning()
    const rawUpdated = rawRows[0]
    if (!rawUpdated) {
      throw new CustomError(
        'pageChangedSinceLoad',
        'This page was changed since you loaded it.',
        409
      )
    }

    const updated = (await this.getPage({ siteId, id })) as Page

    /*
      The one thing an ordinary edit can do that IS a content lifecycle event: cross the published
      boundary. Everything else a save touches stays silent at `info` -- edits are frequent and
      `pageHistory` already records each of them. `draft` <-> `scheduled` is neither publishing nor
      unpublishing (the page was not visible before and is not visible now), so it logs nothing here;
      `scheduled` counts as leaving `published`, because that is what it does to a page that was live.
    */
    if (values.publishState !== undefined && values.publishState !== existing.publishState) {
      const published = values.publishState === 'published'
      if (published || existing.publishState === 'published') {
        CARDINAL.logger.info('pages', published ? 'published' : 'unpublished', {
          site: siteId,
          page: id,
          path: updated.path,
          locale: updated.locale,
          state: values.publishState,
          ...actorFields(actor)
        })
      }
    }

    await CARDINAL.models.pageHistory.record({
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

    // -> `meta` and `updatedAt` move on every save, not only when `title`/`tags` did: otherwise a
    //    description-only edit leaves the tree row's `meta` (which the file manager reads
    //    `description` out of) and sort-by-`updatedAt` ordering stale.
    await CARDINAL.db
      .update(treeTable)
      .set({
        ...(treeTitle !== null ? { title: treeTitle } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        meta: this.treeMeta(updated),
        updatedAt: sql`now()`
      })
      .where(eq(treeTable.id, id))

    // -> A generated menu item's label comes from the tree row's title and its icon/inclusion at all
    //    from `pages.icon`/`isBrowsable`/`publishState`, so an ancestor `auto`/`mixed` menu's cached
    //    tree walk depends on these. This write bypasses `tree.ts`'s own methods, so it needs its
    //    own invalidation rather than inheriting one.
    if (
      treeTitle !== null ||
      patch.icon !== undefined ||
      patch.isBrowsable !== undefined ||
      patch.publishState !== undefined
    ) {
      CARDINAL.models.navigation.invalidateCache(siteId)
    }

    await CARDINAL.models.search.updated(rawUpdated)
    if (hasRenderInput) {
      // -> Only on this branch: when `needsRerenderQueue` fires instead, `storeRender()` is what
      //    queues the embed job, once the real content actually lands
      await this.enqueueEmbedJob(id)
    }
    // -> The glossary's cached canonical-page mapping caches the page's classification and tags
    //    alongside its path/locale and runs `read:pages` against that cached copy, so a change here
    //    has to drop it or a reader keeps seeing a term resolve to a page whose access just changed.
    if (patch.classification !== undefined || patch.tags !== undefined) {
      CARDINAL.models.glossary.invalidateCache(siteId)
    }
    await CARDINAL.models.hooks.emit('page:edit', siteId, {
      id,
      path: updated.path,
      locale: updated.locale,
      siteId,
      authorId: actor.id,
      metadata: { title: updated.title, description: updated.description }
    })
    // -> The `page:edit` pair is split around this one rather than going through `announce()`: a
    //    classification change emits its own webhook (with no storage dispatch of its own) BETWEEN
    //    the edit's emit and its dispatch, and that ordering is what a subscriber sees.
    if (classificationChanged) {
      await CARDINAL.models.hooks.emit('page:classification-changed', siteId, {
        id,
        path: updated.path,
        locale: updated.locale,
        siteId,
        authorId: actor.id,
        previousClassification: existing.classification,
        classification: updated.classification
      })
    }
    await CARDINAL.models.storage.dispatch('page:edit', {
      id,
      path: updated.path,
      locale: updated.locale,
      siteId,
      authorId: actor.id
    })
    // -> Unconditional: there is no single field either cache turns on, and `updatedAt` alone moves
    //    the sitemap's `<lastmod>`. The glossary's own drop above is conditional and stays ahead of
    //    the emit.
    this.invalidateSiteCaches(siteId)

    if (needsRerenderQueue) {
      // -> Briefly blank rather than wrong: this fills `render`/`toc`/`searchContent`/`links` back
      //    in from the content just written. `ensureCanRender()` was confirmed before the write, so
      //    this enqueues directly rather than through `queueRerender()`'s own copy of that check.
      await this.enqueueRerender(siteId, updated, actor, renderPermissions)
    }

    return updated
  }

  /**
   * Deliberately not `updatePage()`: `contentType` is immutable through every ordinary save path,
   * and here relabeling is exactly the point. The page's VISIBLE output does not change (same
   * document, correctly encoded instead of mislabeled), so this skips everything a real edit does:
   * no re-render (the stored `render`/`toc`/`searchContent` already reflect this exact content), no
   * search reindex, no webhook emit, no storage dispatch.
   *
   * The `WHERE` clause doubles as an optimistic-concurrency guard against the row having moved on
   * since the caller's own `SELECT`: it only ever touches a row still shaped exactly like the one
   * that was read.
   *
   * @returns false when the row no longer matches that shape -- the caller's cue to count it as
   *   skipped rather than converted, not to treat it as a failure.
   */
  async convertLegacyWysiwygRow(
    siteId: string,
    id: string,
    markdown: string,
    authorId: string
  ): Promise<boolean> {
    const rows = await CARDINAL.db
      .update(pagesTable)
      .set({ content: markdown, contentType: 'markdown', updatedAt: sql`now()` })
      .where(
        and(
          eq(pagesTable.id, id),
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.editor, 'wysiwyg'),
          eq(pagesTable.contentType, 'html')
        )
      )
      .returning({ id: pagesTable.id })
    if (rows.length === 0) {
      return false
    }
    await CARDINAL.models.pageHistory.record({
      siteId,
      pageId: id,
      action: 'updated',
      authorId,
      changedFields: ['content', 'contentType']
    })
    return true
  }

  /**
   * Deliberately not `updatePage()`, which treats the editor that authored a page as unchangeable --
   * this is the one place changing it IS the point. `content`/`contentType` are left untouched: the
   * flip is a relabel rather than a transform (`CONVERTIBLE_EDITORS`), so the stored
   * `render`/`toc`/`searchContent`/`links` already reflect this exact markdown.
   *
   * The render-equality guard that makes this safe -- parsing the page into a headless WYSIWYG
   * editor, serializing it back out, and comparing the two renders -- runs entirely client-side, in
   * `PageConvertDialog.vue`, before this is ever called. This method trusts that guard and only
   * re-checks what it cannot see: that the row is still in a convertible state at all.
   *
   * `pageEditorConvertNotMarkdown` is the legacy case: a JSON-holding `wysiwyg` row neither the
   * run-once conversion job nor the lazy on-open fallback has reached has no markdown for the
   * frontend's round-trip check to have compared against in the first place.
   */
  async convertEditor(
    siteId: string,
    id: string,
    targetEditor: string,
    actor: PageActor
  ): Promise<Page | null> {
    const results = await CARDINAL.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.id, id), eq(pagesTable.siteId, siteId)))
      .limit(1)
    const existing = results[0]
    if (!existing) {
      return null
    }
    if (
      !CONVERTIBLE_EDITORS.includes(existing.editor) ||
      !CONVERTIBLE_EDITORS.includes(targetEditor)
    ) {
      throw new CustomError(
        'pageEditorConvertUnsupported',
        'This page’s editor cannot be converted this way.'
      )
    }
    if (existing.editor === targetEditor) {
      throw new CustomError('pageEditorConvertUnchanged', 'This page already uses that editor.')
    }
    if (existing.contentType !== 'markdown') {
      throw new CustomError(
        'pageEditorConvertNotMarkdown',
        'This page must be saved once more before its editor can be converted.'
      )
    }

    await CARDINAL.db
      .update(pagesTable)
      .set({ editor: targetEditor, updatedAt: sql`now()` })
      .where(eq(pagesTable.id, id))

    const updated = (await this.getPage({ siteId, id })) as Page

    await CARDINAL.models.pageHistory.record({
      siteId,
      pageId: id,
      action: 'updated',
      authorId: actor.id,
      via: actor.via,
      changedFields: ['editor']
    })

    return updated
  }

  /** The translation link this data model uses: same `(siteId, path)`, other locales. */
  async getTranslations(siteId: string, path: string, excludeId: string): Promise<Page[]> {
    const rows = await CARDINAL.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(
        and(eq(pagesTable.siteId, siteId), eq(pagesTable.path, path), ne(pagesTable.id, excludeId))
      )
    const pages = await Promise.all(rows.map((row) => this.getPage({ siteId, id: row.id })))
    return pages.filter((candidate): candidate is Page => candidate !== null)
  }

  /**
   * One `SELECT` plus an in-memory comparison (`helpers/translationStaleness.ts`), never a
   * per-page/per-locale round trip.
   *
   * @param paths Restrict to these paths; omit for every page in the site.
   */
  async getTranslationStaleness(
    siteId: string,
    paths?: string[]
  ): Promise<TranslationStalenessEntry[]> {
    const localesConfig = CARDINAL.sites[siteId]?.config?.locales
    const primaryLocale = defaultLocale(siteId)
    const activeLocales: string[] = localesConfig?.active ?? [primaryLocale]
    if (activeLocales.length < 2) {
      return []
    }

    const rows = await CARDINAL.db
      .select({
        path: pagesTable.path,
        locale: pagesTable.locale,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(
        paths && paths.length > 0
          ? and(eq(pagesTable.siteId, siteId), inArray(pagesTable.path, paths))
          : eq(pagesTable.siteId, siteId)
      )

    return computeTranslationStaleness(rows, { primaryLocale, activeLocales })
  }

  /**
   * Shared with `movePage()`'s `includeTranslations` cascade: a twin's move is exactly this write
   * against the twin's own current row, with its own (untouched) locale.
   */
  private async moveOnePageInTx(
    tx: WikiTx,
    siteId: string,
    current: Page,
    { path: newPath, title, locale: destLocale }: { path: string; title?: string; locale: string },
    actor: PageActor
  ): Promise<{
    rawMoved: typeof pagesTable.$inferSelect
    changedFields: string[]
    relinkedPageIds: string[]
  }> {
    /*
      Floor invariant on move: unlike create/update, a move that lands a page under a stricter parent
      auto-bumps it rather than refusing the move outright -- there is no separate confirmation step
      for a move. Read inside the transaction (`tx`, not `CARDINAL.db`) so a concurrent move of the
      parent cannot land between this read and the write below.
    */
    const newFloorId =
      newPath !== current.path || destLocale !== current.locale
        ? await CARDINAL.models.pageClassification.parentClassification(
            siteId,
            destLocale,
            newPath,
            tx
          )
        : null
    const classification = newFloorId
      ? CARDINAL.models.classificationLevels.stricterOf(current.classification, newFloorId)
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

    const pathParts = newPath.split('/')
    await CARDINAL.models.tree.deleteEntry(current.id, tx)
    await CARDINAL.models.tree.addPage({
      id: current.id,
      parentPath: pathParts.slice(0, -1).join('/'),
      fileName: pathParts.at(-1)!,
      title: title !== undefined ? title.trim() : current.title,
      locale: destLocale,
      siteId,
      tags: current.tags,
      // -> The freshly-updated raw row, not `current` (the pre-move snapshot): `current.authorId`
      //    is stale the instant this transaction sets it to `actor.id` above. No other `treeMeta`
      //    field is touched by this update, so the two agree on everything else.
      meta: this.treeMeta(rawMovedRows[0]!),
      db: tx
    })

    // -> Only a real path change leaves an old-path reference to fix -- a locale-only or title-only
    //    move touches no link target, so this would find nothing to do beyond the wasted query.
    const relinkedPageIds =
      newPath !== current.path
        ? await this.relinkReferencingPages(
            tx,
            siteId,
            current.locale,
            current.path,
            newPath,
            destLocale
          )
        : []

    const changedFields = [
      ...(newPath !== current.path ? ['path'] : []),
      ...(destLocale !== current.locale ? ['locale'] : []),
      ...(title !== undefined && title.trim() !== current.title ? ['title'] : [])
    ]

    return { rawMoved: rawMovedRows[0]!, changedFields, relinkedPageIds }
  }

  /**
   * Reuses the tracking data `models/rendering.ts#extractInternalLinks` writes on every save rather
   * than re-parsing content -- `helpers/pageLinkRewrite.ts` holds the two link shapes rewritten in
   * place.
   *
   * `oldLocale` is deliberately the moved page's locale as it stood BEFORE this move: a bare-path
   * link target only ever resolves within the referencing page's own locale, so a referencing page
   * in any OTHER locale could never have meant this page in the first place.
   *
   * A move that changes locale AS WELL AS path is skipped entirely (`newLocale !== oldLocale`): the
   * `links: string[]` / `relations[].target: string` representation carries no locale of its own, so
   * writing `newPath` into an old-locale page's link would target a path that, in that page's own
   * locale, no longer names the moved page at all. There is nothing this method could write that
   * would fix that case.
   *
   * Deliberately not built on `listBacklinks()`: that query has no locale filter -- fine for a
   * read-only listing, unsafe for a mutating rewrite, since a same-path translation's own unrelated
   * link could otherwise be corrupted by a different locale's move.
   *
   * Fires no new `pageHistory` version and no `updatedAt` bump on a candidate page -- this is a side
   * effect of someone else's move, not a fresh edit of the candidate.
   *
   * @returns The id of every candidate page this rewrote, for the caller to clear each one's
   * recovery draft: left uncleared, a stale draft predating this rewrite would offer to restore
   * content this move has already overtaken.
   */
  private async relinkReferencingPages(
    tx: WikiTx,
    siteId: string,
    oldLocale: string,
    oldPath: string,
    newPath: string,
    newLocale: string
  ): Promise<string[]> {
    if (!oldPath || oldPath === newPath || newLocale !== oldLocale) {
      return []
    }
    interface RelinkCandidateRow {
      id: string
      editor: string
      content: string | null
      render: string | null
      links: string[]
      relations: { target: string; [key: string]: unknown }[]
    }
    const redirectTarget = `/${oldPath}`
    const candidates = (await tx
      .select({
        id: pagesTable.id,
        editor: pagesTable.editor,
        content: pagesTable.content,
        render: pagesTable.render,
        links: pagesTable.links,
        relations: pagesTable.relations
      })
      .from(pagesTable)
      .where(
        and(
          eq(pagesTable.siteId, siteId),
          eq(pagesTable.locale, oldLocale),
          sql`(
            ${pagesTable.links} @> ${JSON.stringify([oldPath])}::jsonb
            OR ${pagesTable.relations} @> ${JSON.stringify([{ target: oldPath }])}::jsonb
            OR (${pagesTable.editor} = ${REDIRECT_EDITOR} AND ${pagesTable.content}::jsonb ->> 'target' = ${redirectTarget})
          )`
        )
      )) as RelinkCandidateRow[]

    // -> Same locale list `extractInternalLinks` (`models/rendering.ts`) strips before storing
    //    `oldPath` bare -- a `forcePrefix` site (or a non-primary-locale target) can have written
    //    that href with a leading locale segment still on it, which the plain `oldPath` pattern
    //    alone would not match.
    const activeLocales: string[] = CARDINAL.sites?.[siteId]?.config?.locales?.active ?? []

    for (const row of candidates) {
      const links = [...new Set(row.links.map((target) => (target === oldPath ? newPath : target)))]
      const relations = row.relations.map((relation) =>
        relation?.target === oldPath ? { ...relation, target: newPath } : relation
      )
      const isRedirect = row.editor === REDIRECT_EDITOR
      const contentRewrite = isRedirect
        ? rewriteRedirectTarget(row.content ?? '', oldPath, newPath)
        : rewriteLinkText(row.content ?? '', oldPath, newPath, activeLocales)
      // -> A redirection has no render to speak of, so it is left alone rather than run through the
      //    markdown/HTML pass
      const renderRewrite = isRedirect
        ? { text: row.render ?? '', changed: false }
        : rewriteLinkText(row.render ?? '', oldPath, newPath, activeLocales)

      await tx
        .update(pagesTable)
        .set({
          links,
          relations,
          ...(contentRewrite.changed ? { content: contentRewrite.text } : {}),
          ...(renderRewrite.changed ? { render: renderRewrite.text } : {})
        })
        .where(eq(pagesTable.id, row.id))
    }

    return candidates.map((row) => row.id)
  }

  /**
   * Keyed to what THIS page changed rather than the batch as a whole, so an `includeTranslations`
   * cascade fires one full set of side effects per twin, exactly as if each had been moved on its
   * own. Takes a page id + previous path/locale rather than a full previous `Page`, so a bulk mover
   * can fire it per page without first assembling a `Page` snapshot of each one.
   *
   * Does NOT invalidate the glossary cache itself -- a canonical page's path/locale change has to
   * drop the cached term->page mapping, but that is a per-SITE concern, and calling it once per page
   * in a large batch would be wasteful. Instead this reports whether THIS page's move requires it,
   * via the returned `glossaryInvalidate` flag, leaving the caller to OR that across the batch and
   * call `CARDINAL.models.glossary.invalidateCache(siteId)` at most once.
   */
  private async recordPageMoveSideEffects(
    siteId: string,
    pageId: string,
    previousPath: string,
    previousLocale: string,
    rawMoved: typeof pagesTable.$inferSelect,
    changedFields: string[],
    actor: PageActor
  ): Promise<{ moved: Page; glossaryInvalidate: boolean }> {
    const moved = (await this.getPage({ siteId, id: pageId })) as Page
    await CARDINAL.models.pageHistory.record({
      siteId,
      pageId,
      action: 'moved',
      authorId: actor.id,
      via: actor.via,
      changedFields
    })
    await this.notifyWatchers(
      siteId,
      pageId,
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
    await CARDINAL.models.search.renamed(siteId, rawMoved, previousPath, previousLocale)
    // -> A move changes the page's sitemap `<loc>`, and its path is what every graph edge pointing
    //    at it is keyed by (`assembleGraph` matches relations/links against `row.path`), so a stale
    //    bundle would carry broken edges.
    this.invalidateSiteCaches(siteId)
    // -> `previousLocale` alongside `previousPath` because a move can change either: a consumer that
    //    has to find what the page used to be (the git target's own file for it, say) needs the
    //    whole of where it was, not half of it
    await announce('page:rename', siteId, {
      id: pageId,
      path: moved.path,
      previousPath,
      locale: moved.locale,
      previousLocale,
      siteId,
      authorId: actor.id
    })
    // -> One line per page actually moved, `includeTranslations` twins included: a twin's move is a
    //    move of its own, not a detail of somebody else's. `fromLocale` appears only for a
    //    re-homing, where `from`/`to` can otherwise be the same path.
    CARDINAL.logger.info('pages', 'moved', {
      site: siteId,
      page: pageId,
      from: previousPath,
      to: moved.path,
      locale: moved.locale,
      ...(previousLocale !== moved.locale ? { fromLocale: previousLocale } : {}),
      ...actorFields(actor)
    })
    return {
      moved,
      glossaryInvalidate: moved.path !== previousPath || moved.locale !== previousLocale
    }
  }

  /**
   * `locale` re-homes the page into another of the site's locales, which is a move in exactly the
   * sense a path change is: the page keeps its id, history and watchers, and the (siteId, locale,
   * path) it used to occupy is freed.
   *
   * `includeTranslations` cascades a path change to every other locale's page sharing this page's
   * CURRENT path -- the translation link this data model uses is the shared path itself, so a rename
   * that moves only one locale's page silently strands its twins at the old one. All-or-nothing:
   * every twin goes through the same reserved-segment and collision checks as the page being moved,
   * and a 409 on any one of them aborts the whole batch, page and tree writes together. A
   * locale-only move never cascades -- twins are found by path, so they are unaffected by
   * definition.
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
    // -> Same reasoning as `tree.renameFolder`: only checked when the path is actually changing, so
    //    a title-only (or locale-only) move of an already-grandfathered page — one whose path
    //    predates this rule, or a later-configured locale alias — isn't itself blocked by a
    //    shadowing first segment it never touches.
    if (newPath !== page.path) {
      await assertPathNotReservedLocale(newPath, siteId)
      assertPathNotReservedAppRoute(newPath)
    }
    const destLocale = locale ?? page.locale
    // -> Same rule as `createPage`: a disabled locale is not a place a page may end up
    if (destLocale !== page.locale) {
      assertLocaleActive(siteId, destLocale)
    }
    if (
      newPath === page.path &&
      destLocale === page.locale &&
      (title === undefined || title === page.title)
    ) {
      return page
    }

    if (newPath !== page.path || destLocale !== page.locale) {
      await this.assertNoPageAt(siteId, destLocale, newPath, { exceptId: id })
    }

    // -> Twins share this page's CURRENT path -- found before anything moves, since the primary no
    //    longer shares it with anyone the moment its own row is updated.
    const twins =
      includeTranslations && newPath !== page.path
        ? await this.getTranslations(siteId, page.path, id)
        : []

    for (const twin of twins) {
      await this.assertNoPageAt(siteId, twin.locale, newPath, {
        exceptId: twin.id,
        // -> Names the locale: the caller asked to move one page and is being refused over a
        //    translation it did not name, which the default message would not identify
        message: `A page already exists at this path in the "${twin.locale}" locale.`
      })
    }

    // -> Every page in the batch shares one transaction: a collision the probes above couldn't close
    //    (a race, or a tree name collision only the insert itself can see) rolls the whole batch
    //    back rather than leaving some twins moved and others stranded.
    type MoveResult = {
      previous: Page
      rawMoved: typeof pagesTable.$inferSelect
      changedFields: string[]
      relinkedPageIds: string[]
    }
    let results: MoveResult[]
    try {
      results = await CARDINAL.db.transaction(async (tx) => {
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
      // -> The probes above cover the common case; this catches the race they cannot close -- two
      //    requests that both pass a probe before either writes
      if (isUniqueViolation(err)) {
        throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
      }
      throw err
    }

    // -> These pages were rewritten in place, a real committed change -- exactly what
    //    `core/collab.ts#pageSaved` clears a recovery draft for. After the `try`, since a move that
    //    rolled back relinked nothing; awaited so a caller awaiting `movePage()` sees the clear
    //    land, with a per-id `catch` so one failed clear cannot fail a move that already committed.
    const relinkedPageIds = new Set(results.flatMap((result) => result.relinkedPageIds))
    await Promise.all(
      [...relinkedPageIds].map((relinkedPageId) =>
        CARDINAL.models.pageDrafts.clear(relinkedPageId).catch((err: any) => {
          CARDINAL.logger.warn('pages', 'clearing the draft failed', {
            page: relinkedPageId,
            error: err
          })
        })
      )
    )

    let primaryMoved: Page | undefined
    // -> One `invalidateCache` call covers the whole batch rather than one per page
    let glossaryInvalidate = false
    for (const result of results) {
      const { moved, glossaryInvalidate: needsInvalidate } = await this.recordPageMoveSideEffects(
        siteId,
        result.previous.id,
        result.previous.path,
        result.previous.locale,
        result.rawMoved,
        result.changedFields,
        actor
      )
      glossaryInvalidate ||= needsInvalidate
      if (result.previous.id === id) {
        primaryMoved = moved
      }
    }
    if (glossaryInvalidate) {
      CARDINAL.models.glossary.invalidateCache(siteId)
    }
    return primaryMoved!
  }

  async deletePage(siteId: string, id: string, actor: PageActor): Promise<boolean> {
    const page = await this.getPage({ siteId, id })
    if (!page) {
      return false
    }
    // -> Before the row goes, and this version is what recovering the page would be built from
    await CARDINAL.models.pageHistory.record({
      siteId,
      pageId: id,
      action: 'deleted',
      authorId: actor.id,
      via: actor.via
    })
    // -> Also before the row goes: deleting it below cascades `pageWatching` away, so the watch list
    //    has to be read while it still exists -- and the `pageWatchEvents` rows written here carry a
    //    `pageId` foreign key needing this row alive too (see `notifyWatchers`)
    await this.notifyWatchers(siteId, id, 'deleted', actor.id, {
      title: page.title,
      path: page.path,
      locale: page.locale,
      classification: page.classification,
      tags: page.tags
    })

    // -> One transaction: there is no FK from `tree.id` to `pages.id` (only `siteId` is a foreign
    //    key), so nothing at the database level removes the tree row when the page row goes. A
    //    failure between two separate statements here would leave a tree entry pointing at a page
    //    that no longer exists -- still rendering in the file manager, 404ing when opened, and
    //    permanently blocking a future page at the same path via `tree_composite_page_idx`.
    await CARDINAL.db.transaction(async (tx) => {
      await tx.delete(pagesTable).where(eq(pagesTable.id, id))
      await CARDINAL.models.tree.deleteEntry(id, tx)
    })
    // -> A page that overrode the sidebar owns a menu keyed by its own id, which nothing could reach
    //    once the page is gone
    await CARDINAL.models.navigation.deleteNavForEntries(siteId, [id])
    // -> The FK from `glossaryTerms.pageId` is `set null`, so a term canonically linked to this page
    //    is unlinked at the db level already; the cached, resolved copy of that link needs the same
    //    drop or it would keep pointing at a page that no longer exists.
    this.invalidateSiteCaches(siteId, { glossary: true })

    // -> `contentSyncState.contentId` isn't a real FK (it can point at a page or an asset), so nothing
    //    at the db level drops the sync-state rows for this page on its own.
    await CARDINAL.models.contentSync.forgetContent('page', id)

    await CARDINAL.models.search.deleted(siteId, id)
    await announce('page:delete', siteId, {
      id,
      path: page.path,
      locale: page.locale,
      siteId,
      authorId: actor.id
    })
    CARDINAL.logger.info('pages', 'deleted', {
      site: siteId,
      page: id,
      path: page.path,
      locale: page.locale,
      ...actorFields(actor)
    })
    return true
  }

  /**
   * Not optional tidying: a page is served from its own row, found by the hash of its path, and the
   * tree is only consulted for where it sits in the site. A page whose tree entry went with the
   * folder is therefore still live at its URL while being invisible to everything that lists the
   * wiki -- including the file manager somebody would have to use to delete it.
   *
   * `pageHistory` carries no foreign key back to `pages` precisely so that it outlives the row,
   * which is what makes a folder deleted by mistake recoverable.
   *
   * The search-index drop matters for an external engine, which keeps a stale entry forever unless
   * told to drop it; a postgres-backed index has nothing to clean up, since a deleted row simply
   * stops matching its own query.
   */
  async deleteOrphaned(siteId: string, entries: DeletedEntry[], actor: PageActor): Promise<void> {
    if (entries.length < 1) {
      return
    }
    // -> `notifyWatchers()` re-checks `read:pages` per watcher and needs each page's
    //    classification/tags, which `DeletedEntry` does not carry — one bulk SELECT for the whole
    //    batch, not one per entry, before the rows go.
    const pageInfo = new Map(
      (
        await CARDINAL.db
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
      await CARDINAL.models.pageHistory.record({
        siteId,
        pageId: entry.id,
        action: 'deleted',
        authorId: actor.id,
        via: actor.via
      })
      // -> Same ordering as `deletePage`, and for the same reason: still before the bulk delete
      //    below. `DeletedEntry` carries no title, so the file name stands in for it.
      const info = pageInfo.get(entry.id)
      await this.notifyWatchers(siteId, entry.id, 'deleted', actor.id, {
        title: entry.fileName,
        path: entry.folderPath ? `${entry.folderPath}/${entry.fileName}` : entry.fileName,
        locale: entry.locale,
        classification: info?.classification ?? null,
        tags: info?.tags ?? []
      })
    }
    await CARDINAL.db.delete(pagesTable).where(
      inArray(
        pagesTable.id,
        entries.map((entry) => entry.id)
      )
    )
    // -> Same reasoning as `deletePage`; one call covers the whole batch.
    this.invalidateSiteCaches(siteId, { glossary: true })

    // -> Same reasoning as `deletePage`: one batched call rather than one per page.
    await CARDINAL.models.contentSync.forgetContentBatch(
      'page',
      entries.map((entry) => entry.id)
    )

    // -> One per page, as deleting them one at a time would have sent: a subscriber mirroring the
    //    wiki has to hear about each page, not about the folder it happened to sit in
    for (const entry of entries) {
      const path = entry.folderPath ? `${entry.folderPath}/${entry.fileName}` : entry.fileName
      await CARDINAL.models.search.deleted(siteId, entry.id)
      await announce('page:delete', siteId, {
        id: entry.id,
        path,
        locale: entry.locale,
        siteId,
        authorId: actor.id
      })
      // -> One line per page, for exactly the reason the `announce` above is also per page.
      //    `cascade` is what tells a page swept up by a folder apart from one deleted by name.
      CARDINAL.logger.info('pages', 'deleted', {
        site: siteId,
        page: entry.id,
        path,
        locale: entry.locale,
        cascade: 'folder',
        ...actorFields(actor)
      })
    }
    CARDINAL.logger.debug('pages', 'deleted the pages that went with a deleted folder', {
      pages: entries.length
    })
  }

  /**
   * For a stored render gone stale — the markdown config changed, or the renderer itself did — with
   * nobody holding the page open to re-save it. The rendering goes through the very same frontend
   * pipeline, driven in a headless browser, so the result is what the editor would have produced;
   * because that costs a browser it is queued rather than done here, one page at a time across the
   * whole instance (`models/renderQueue.ts`).
   *
   * What the render may carry is settled here, while there is still an actor to ask, and travels with
   * the queued request.
   *
   * @param renderPermissions Same override `updatePage` accepts, and for the same reason.
   *   `approveSubmission`'s no-render fallback path reaches this too, and must pass the identical
   *   submitter-derived permissions the direct `postProcess()` branch used, or the queued re-render
   *   would launder the content back through the reviewer's permissions anyway.
   */
  async queueRerender(
    siteId: string,
    id: string,
    actor: PageActor,
    renderPermissions?: RenderPermissions
  ): Promise<boolean> {
    const page = await this.getPage({ siteId, id })
    if (!page) {
      return false
    }
    await CARDINAL.models.renderQueue.ensureCanRender(page.editor)
    await this.enqueueRerender(siteId, page, actor, renderPermissions)
    return true
  }

  /**
   * Split out of `queueRerender()` so `createPage()`/`updatePage()` can enqueue directly after their
   * own up-front `ensureCanRender()` guard, rather than paying for that same consult a second time.
   *
   * `page` only needs to carry what `hasPermission()`'s `RulePageRef` match needs, narrower than the
   * full `Page` most callers have on hand, which is what lets `queueRerenderAllPages()` pass a
   * lightweight per-page row straight through without a `getPage()`-shaped select per page.
   */
  private async enqueueRerender(
    siteId: string,
    page: Pick<Page, 'id' | 'path' | 'locale' | 'tags' | 'classification'>,
    actor: PageActor,
    renderPermissions?: RenderPermissions
  ): Promise<void> {
    await CARDINAL.models.renderQueue.queuePage({
      siteId,
      pageId: page.id,
      permissions: renderPermissions ?? {
        scripts: hasPermission(actor, 'write:scripts', { ...page, siteId }),
        styles: hasPermission(actor, 'write:styles', { ...page, siteId })
      },
      requestedById: actor.id
    })
  }

  /**
   * The manual "apply it everywhere, right now" counterpart to the glossary's render-time term
   * matching: a stored page's render only picks up a term change on its own next render (a save, or
   * an explicit rerender), never retroactively the moment a term is added or edited -- rewriting
   * every stored page's render on every term save would mean a full-site headless-browser re-render
   * per edit.
   *
   * Only markdown-editor pages are queued: every other editor has no server-side renderer at all
   * (`ensureCanRender()` refuses everything but `markdown`), and queuing one anyway would just make
   * the drain log a warning and skip it.
   *
   * Deliberately scoped to "every page", not "only pages that mention this term": there is no
   * term-backlink index to narrow it with.
   */
  async queueRerenderAllPages(siteId: string, actor: PageActor): Promise<number> {
    await CARDINAL.models.renderQueue.ensureCanRender('markdown')
    const rows = await CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), eq(pagesTable.editor, 'markdown')))
    for (const row of rows) {
      await this.enqueueRerender(siteId, row, actor)
    }
    return rows.length
  }

  /**
   * The drain calls this once the browser has been through the content. Post-processed like any
   * other render — it came from a browser either way — against the permissions the person who asked
   * for it had.
   */
  async storeRender(
    siteId: string,
    id: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string
  ): Promise<void> {
    const { render, toc, text, links } = await CARDINAL.models.rendering.postProcess(
      siteId,
      html,
      permissions,
      pagePath
    )

    const updated = await CARDINAL.db
      .update(pagesTable)
      .set({ render, toc, searchContent: text, links, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.id, id), eq(pagesTable.siteId, siteId)))
      .returning()

    // -> Nothing was updated when the page went while it sat in the queue
    if (updated[0]) {
      await CARDINAL.models.search.updated(updated[0])
      // -> Where a render-queued save's real content lands, so this is the only embed-job enqueue
      //    the queued path needs
      await this.enqueueEmbedJob(id)
    }
  }

  /**
   * Called only where a page's `searchContent` becomes the real, final text for this save -- never
   * for a save that merely queued a render, which `storeRender()` picks up once that render lands.
   */
  private async enqueueEmbedJob(pageId: string): Promise<void> {
    await CARDINAL.scheduler.addJob({ task: 'embedPage', payload: { pageId } })
  }

  /**
   * The locale travels with the path because an alias identifies one specific page, in one specific
   * locale -- the caller needs both to build a correctly-prefixed link rather than landing on the
   * site's primary-locale default for a translation that isn't.
   */
  async getPathFromAlias(
    siteId: string,
    alias: string
  ): Promise<{ id: string; path: string; locale: string; tags: string[] } | null> {
    const results = await CARDINAL.db
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
   * `publishState`/`isBrowsable` are cheap column filters that describe every anonymous reader at
   * once, but they are not the whole of what a guest may see: an administrator can lock a published,
   * browsable page to a signed-in group with a page rule, and that page must not turn up in a sitemap
   * Google reads with no session at all. So every row that survives the column filter is checked again
   * against the guests group's rules with `helpers/pageRules.ts`'s own `read:pages` logic — the same
   * check a real anonymous request would get from `checkAccess` — rather than assuming "published and
   * browsable" already means "public".
   *
   * Ordered by path so that a page's translations (same path, several locale rows) land next to each
   * other, keeping a multi-locale hreflang cluster out of two different paginated child sitemaps in
   * the common case.
   */
  async listPagesForSitemap(
    siteId: string
  ): Promise<Array<{ path: string; locale: string; updatedAt: Date }>> {
    const key = sitemapCacheKey(siteId)
    const cached = CARDINAL.cache.get(key) as
      | Array<{ path: string; locale: string; updatedAt: Date }>
      | undefined
    if (cached) {
      return cached
    }

    const rows = await CARDINAL.db
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
      .orderBy(pagesTable.path)
      .limit(SITEMAP_QUERY_CAP)

    const guestRules = CARDINAL.models.groups.rulesForGroups([
      CARDINAL.data.systemIds.guestsGroupId
    ])
    const result = rows
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

    CARDINAL.cache.set(key, result, { ttl: SITEMAP_CACHE_TTL_MS })
    return result
  }

  invalidateSitemapCache(siteId: string): void {
    CARDINAL.cache.delete(sitemapCacheKey(siteId))
  }

  /**
   * The join half of translation staleness/missing detection (`helpers/translationStatus.ts` is the
   * compare half).
   *
   * Unfiltered by page-rule access on purpose: the caller already knows about every path it is
   * asking for (typically an already permission-filtered search result), and all that is reported
   * back here is "does a translation exist / when did it last change" — never page content.
   */
  async getTranslationRows(
    siteId: string,
    paths: string[]
  ): Promise<Array<{ path: string; locale: string; updatedAt: Date }>> {
    if (paths.length < 1) {
      return []
    }
    return CARDINAL.db
      .select({
        path: pagesTable.path,
        locale: pagesTable.locale,
        updatedAt: pagesTable.updatedAt
      })
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, siteId), inArray(pagesTable.path, paths)))
  }

  /**
   * The sitemap list and the graph bundle are dropped unconditionally: a page's existence, path,
   * locale, publish state, tags or classification all feed one or both, and there is no single field
   * either turns on. The glossary's resolved canonical-page cache is not — only a write that can
   * change which page a term points at, or who may read it, needs it dropped, which is why it is a
   * flag rather than a third unconditional call.
   */
  private invalidateSiteCaches(siteId: string, opts: { glossary?: boolean } = {}): void {
    if (opts.glossary) {
      CARDINAL.models.glossary.invalidateCache(siteId)
    }
    this.invalidateSitemapCache(siteId)
    invalidateGraphCache(siteId)
  }

  /**
   * A probe, not the arbiter: the `(siteId, locale, path)` uniqueness constraint is, and a writer
   * that lands between this read and the insert is caught by `isUniqueViolation` at the write
   * itself. This is what turns the common case into a 409 the caller can act on rather than a
   * constraint error.
   *
   * @param opts.exceptId Ignore this page — the one being moved, which is allowed to already be here
   */
  private async assertNoPageAt(
    siteId: string,
    locale: string,
    path: string,
    opts: { exceptId?: string; message?: string } = {}
  ): Promise<void> {
    const conditions = [
      eq(pagesTable.siteId, siteId),
      eq(pagesTable.locale, locale),
      eq(pagesTable.path, path)
    ]
    if (opts.exceptId) {
      conditions.unshift(ne(pagesTable.id, opts.exceptId))
    }
    const duplicate = await CARDINAL.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(and(...conditions))
      .limit(1)
    if (duplicate.length > 0) {
      throw new CustomError(
        'pageDuplicatePath',
        opts.message ?? 'A page already exists at this path.',
        409
      )
    }
  }

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
    const duplicate = await CARDINAL.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(and(...conditions))
      .limit(1)
    if (duplicate.length > 0) {
      throw new CustomError('pageDuplicateAlias', 'Another page already uses this alias.', 409)
    }
    return value
  }

  private buildConfig(
    input: Partial<PageInput>,
    siteId: string,
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const defaults = CARDINAL.sites[siteId]?.config?.defaults ?? {}
    return {
      allowComments: input.allowComments ?? existing.allowComments ?? true,
      allowContributions: input.allowContributions ?? existing.allowContributions ?? true,
      showSidebar: input.showSidebar ?? existing.showSidebar ?? true,
      showTags: input.showTags ?? existing.showTags ?? true,
      showToc: input.showToc ?? existing.showToc ?? true,
      tocDepth: input.tocDepth ?? existing.tocDepth ?? defaults.tocDepth ?? { min: 1, max: 2 }
    }
  }

  /**
   * Does NOT check `write:scripts`/`write:styles` itself -- it trusts whatever `input` carries. That
   * permission check is the caller's job, done once as a 403 refusal at the route layer
   * (`api/pages/write.ts`) before `createPage()`/`updatePage()` are ever called, rather than being
   * re-checked here and silently dropping an unauthorized field.
   */
  private buildScripts(
    input: Partial<PageInput>,
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return {
      jsLoad: input.scriptJsLoad ?? existing.jsLoad ?? '',
      jsUnload: input.scriptJsUnload ?? existing.jsUnload ?? '',
      css: input.scriptCss ?? existing.css ?? ''
    }
  }

  /**
   * The watcher list — paired with each watcher's resolved `notifyMode` — is resolved here,
   * synchronously, rather than inside the job this queues: a delete removes the page in the very
   * same request, and `pageWatching.pageId` cascades away with it, so a job that only got around to
   * resolving watchers later would find nothing left to read for a `deleted` event. `page` and
   * `changedFields` are threaded through for the same reason. That resolution is one indexed
   * `SELECT`, so it does not scale with how many people watch the page; what does — one
   * `pageWatchEvents` row per watcher, and the mail — is exactly what the queued job does instead.
   *
   * A failure to queue is logged and swallowed rather than thrown: a watcher not being told about a
   * change is a real loss, but it must never be the reason the change itself fails to save.
   *
   * `pageWatching.listWatchers()` re-checks `read:pages` per watcher against the page's own live row,
   * so a watcher whose access has since been revoked is not queued a notification carrying the page's
   * title and a working link.
   *
   * For a `deleted` action the `pageWatchEvents` rows are recorded HERE, synchronously, rather than
   * left to the queued job: `pageWatchEvents.pageId` is a foreign key, so the INSERT has to run while
   * the `pages` row this call is about still exists. The already-recorded rows are handed to the job
   * as `recordedEvents`, so it does the immediate-send loop against them rather than inserting a
   * second time. Every other action defers the insert into the job: the page row those are about
   * stays put.
   *
   * @param changedFields Always empty for a delete.
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
      const watchers = await CARDINAL.models.pageWatching.listWatchers(
        siteId,
        pageId,
        actorId,
        action
      )
      if (watchers.length < 1) {
        return
      }
      const recordedEvents =
        action === 'deleted'
          ? await CARDINAL.models.pageWatchEvents.recordMany(
              watchers.map((watcher) => ({
                siteId,
                pageId,
                pageTitle: page.title,
                pagePath: page.path,
                pageLocale: page.locale,
                userId: watcher.userId,
                action,
                actorId,
                changedFields,
                notifyMode: watcher.notifyMode
              }))
            )
          : undefined
      await CARDINAL.scheduler.addJob({
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
          watchers,
          recordedEvents
        }
      })
    } catch (err: any) {
      CARDINAL.logger.warn('pages', 'queueing the watch notifications failed', {
        page: pageId,
        error: err
      })
    }
  }

  /**
   * Denormalized onto the tree entry so a folder listing needs no join.
   *
   * The parameter type is deliberately narrower than `typeof pagesTable.$inferSelect` or the full
   * `Page` interface: it names exactly the fields written below, so either a raw inserted/updated
   * `pages` row or the flattened `Page` shape `toPage()` produces satisfies it structurally.
   * `creatorId`/`ownerId` stay out -- `Page` carries neither column, so reading them here would
   * record the *acting* editor as creator/owner, and nothing reads `meta.creatorId`/`meta.ownerId`.
   */
  private treeMeta(
    page: Pick<
      Page,
      | 'authorId'
      | 'contentType'
      | 'description'
      | 'editor'
      | 'isBrowsable'
      | 'publishState'
      | 'publishEndDate'
      | 'publishStartDate'
    >
  ): Record<string, any> {
    return {
      authorId: page.authorId,
      contentType: page.contentType,
      description: page.description ?? '',
      editor: page.editor,
      isBrowsable: page.isBrowsable,
      publishState: page.publishState,
      publishEndDate: page.publishEndDate ?? null,
      publishStartDate: page.publishStartDate ?? null
    }
  }
}

export const pages = new Pages()
