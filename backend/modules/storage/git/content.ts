/**
 * Write-path handlers: page/asset to git file mapping and commits.
 *
 * Each export here is a `StorageModule` content-dispatch handler (`created`, `updated`, `renamed`,
 * `deleted`, `assetUploaded`, `assetRenamed`, `assetDeleted` — see `models/storage.ts`), called as
 * `handler(target, data)` by the `dispatchStorage` task. `data` is the small, JSON-serializable
 * payload `Storage.dispatch()` queues per
 * write-path event — an id, a path, a locale, the acting user's id, and for a rename/delete-adjacent
 * event whatever the old name was — never the page's rendered content or the asset's bytes. A handler
 * that needs those fetches them itself via `WIKI.models.pages` / `WIKI.models.assets`, which is why
 * every one of these opens with a lookup.
 *
 * `ensureRepo()` (task 504, `storage.ts`) is called at the top of every handler rather than once and
 * shared: it is idempotent and cheap when nothing has changed, and calling it here is what keeps the
 * repo's origin/branch/auth correct even if config was edited between one dispatch and the next.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SimpleGit } from 'simple-git'
import { CONTENT_TYPE_EXTENSIONS } from '../../../helpers/pageSerialization.ts'
import { getFileExtension } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureRepo } from './repo.ts'

/**
 * Every extension this module ever writes a page out as, in probe order — the distinct values of the
 * shared `CONTENT_TYPE_EXTENSIONS` table, `getFileExtension`'s `txt` fallback included, so a new page
 * content type is probed here the moment it can be written. Only consulted by `deleted` (see there for
 * why): everywhere else the extension comes straight from the page's own `contentType`.
 */
const PAGE_EXTENSIONS = [...new Set(Object.values(CONTENT_TYPE_EXTENSIONS))]

/**
 * Whether a target's active content types cover this bucket — `'pages'`, or an asset bucket.
 *
 * Exported for `sync.ts`: the same gate a write-path event is checked against also decides whether a
 * change coming the other way, from the remote, is one this target is configured to import.
 */
export function covers(target: StorageTarget, bucket: string): boolean {
  return target.contentTypes.activeTypes.includes(bucket)
}

/**
 * The locale segment a page's file path is written under, mirroring 2.5.x's namespacing: a page in
 * the site's primary locale is written bare, any other locale gets its own folder — so a single-locale
 * wiki (the common case) never sees a locale segment in its repo at all.
 *
 * Implements git's primary-bare serialization convention — see `docs/decisions/locale-architecture.md`
 * §5.3.
 */
function localeNamespace(siteId: string, locale: string): string {
  const primary = WIKI.sites?.[siteId]?.config?.locales?.primary
  return primary && locale !== primary ? `${locale}/` : ''
}

/**
 * Where a page's content lives in the repo: `[locale/]path.ext`, the extension coming from
 * `contentType`. Exported for `actions.ts`, which maps every page of a site the same way a single
 * write-path event does.
 */
export function pageRelPath(
  siteId: string,
  locale: string,
  pagePath: string,
  contentType: string
): string {
  return `${localeNamespace(siteId, locale)}${pagePath}.${getFileExtension(contentType)}`
}

/**
 * Where an asset's bytes live in the repo: its folder plus its stored `fileName`, which already
 * carries its extension. Exported for `actions.ts`, same reasoning as `pageRelPath`.
 */
export function assetRelPath(folderPath: string, fileName: string): string {
  return folderPath ? `${folderPath}/${fileName}` : fileName
}

/** Exported for `sync.ts`, which checks the same thing about a path the pull just changed. */
export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

/**
 * Which of this module's extensions `baseRelPath` actually exists on disk under, if any.
 *
 * Only `deleted` needs this: by the time a page-delete event dispatches, the page's row — and with it
 * its `contentType` — is already gone from the database (see `models/pages.ts`'s `deletePage`), so the
 * extension cannot be looked up the way every other handler here looks it up. Probing disk instead
 * works because a page is only ever written under one extension at a time.
 */
async function findPageFile(repoPath: string, baseRelPath: string): Promise<string | null> {
  for (const ext of PAGE_EXTENSIONS) {
    const relPath = `${baseRelPath}.${ext}`
    if (await fileExists(path.join(repoPath, relPath))) {
      return relPath
    }
  }
  return null
}

/**
 * The name and email a commit is authored as: the actor who made the change, or the target's own
 * configured fallback (`defaultName` / `defaultEmail`) when there is none to resolve — either because
 * the dispatch payload carries no `authorId` at all (an asset rename or delete never does, see
 * `models/storage.ts`), or because the id no longer resolves to a user.
 */
export async function resolveAuthor(
  target: StorageTarget,
  authorId: string | undefined
): Promise<{ name: string; email: string }> {
  const config = target.config ?? {}
  const fallback = {
    name: config.defaultName || 'Cardinal.js',
    email: config.defaultEmail || 'noreply@example.com'
  }
  if (!authorId) {
    return fallback
  }
  const user = await WIKI.models.users.getById(authorId)
  return user?.email ? { name: user.name || fallback.name, email: user.email } : fallback
}

/** Exported for `actions.ts`, same reasoning as `resolveAuthor`. */
export function authorOption(author: { name: string; email: string }): Record<string, string> {
  return { '--author': `${author.name} <${author.email}>` }
}

/**
 * Write `content` to `relPath` and commit it, unless `.gitignore` excludes the path — a deliberate
 * safety net rather than strict 2.5.x parity (which never checked this for assets, only pages): a path
 * the repo owner explicitly excluded should never end up committed regardless of which kind of content
 * it is.
 */
async function writeAndCommit(
  git: SimpleGit,
  repoPath: string,
  relPath: string,
  content: string | Buffer,
  message: string,
  author: { name: string; email: string }
): Promise<void> {
  const absPath = path.join(repoPath, relPath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, content)
  if ((await git.checkIgnore(relPath)).length > 0) {
    return
  }
  await git.add(relPath)
  await git.commit(message, [relPath], authorOption(author))
}

/** A page was created. */
export async function created(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await WIKI.models.pages.getPage({
    siteId: data.siteId,
    id: data.id,
    withContent: true
  })
  if (!page) return
  const relPath = pageRelPath(data.siteId, data.locale, data.path, page.contentType)
  const author = await resolveAuthor(target, data.authorId)
  await writeAndCommit(
    git,
    repoPath,
    relPath,
    page.content ?? '',
    `docs: create ${data.path}`,
    author
  )
}

/** A page's content, title or metadata changed. */
export async function updated(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await WIKI.models.pages.getPage({
    siteId: data.siteId,
    id: data.id,
    withContent: true
  })
  if (!page) return
  const relPath = pageRelPath(data.siteId, data.locale, data.path, page.contentType)
  const author = await resolveAuthor(target, data.authorId)
  await writeAndCommit(
    git,
    repoPath,
    relPath,
    page.content ?? '',
    `docs: update ${data.path}`,
    author
  )
}

/**
 * A page moved to a new path, a new locale, or both.
 *
 * A git rename — old path removed, new path added, in a single commit — rather than a delete plus an
 * add: that is what keeps `git log --follow` (and every other history tool) treating the file as one
 * continuous history rather than two unrelated ones, the way 2.5.x's own rename handler did.
 *
 * Where the file *was* is composed from `previousLocale`, not the page's current one: a locale is
 * part of a page's repo path (`localeNamespace`), so a move from `en` to `fr` changes the file's
 * directory just as a path change does, and reading the old path off the new locale would rename a
 * file that was never there while leaving the real one behind.
 */
export async function renamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await WIKI.models.pages.getPage({
    siteId: data.siteId,
    id: data.id,
    withContent: true
  })
  if (!page) return
  const author = await resolveAuthor(target, data.authorId)
  const oldRelPath = pageRelPath(
    data.siteId,
    data.previousLocale,
    data.previousPath,
    page.contentType
  )
  const newRelPath = pageRelPath(data.siteId, data.locale, data.path, page.contentType)
  if (oldRelPath === newRelPath) return

  if (await fileExists(path.join(repoPath, oldRelPath))) {
    // -> A locale-only move leaves both paths identical, and "rename foo to foo" says nothing about
    //    what actually happened; qualify both ends with their locale in that case
    const description =
      data.previousLocale === data.locale
        ? `${data.previousPath} to ${data.path}`
        : `${data.previousLocale}/${data.previousPath} to ${data.locale}/${data.path}`
    await fs.mkdir(path.dirname(path.join(repoPath, newRelPath)), { recursive: true })
    await git.mv(oldRelPath, newRelPath)
    await git.commit(`docs: rename ${description}`, [oldRelPath, newRelPath], authorOption(author))
    return
  }
  // -> Nothing tracked at the old path — e.g. this target only started covering pages after the page
  //    was created — so there is nothing to rename; write fresh at the new path instead of failing.
  await writeAndCommit(
    git,
    repoPath,
    newRelPath,
    page.content ?? '',
    `docs: create ${data.path}`,
    author
  )
}

/** A page was deleted. */
export async function deleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const baseRelPath = `${localeNamespace(data.siteId, data.locale)}${data.path}`
  const relPath = await findPageFile(repoPath, baseRelPath)
  if (!relPath) return
  if ((await git.checkIgnore(relPath)).length > 0) return
  const author = await resolveAuthor(target, data.authorId)
  await git.rm([relPath])
  await git.commit(`docs: delete ${data.path}`, [relPath], authorOption(author))
}

/**
 * An asset was created, or an existing one had its bytes replaced.
 *
 * No `covers()` re-check here — unlike the page handlers above, an asset's bucket is size-aware
 * (`models/storage.ts`'s `targetCoversEvent`, checked once before `Storage.dispatch()` ever queues
 * this call), and a kind-only re-check here would disagree with it for a "large" file, silently
 * dropping the event for a target configured to cover `large` but not the file's own kind bucket, or
 * vice versa (OpenProject #924). `dispatchStorage` never calls this for a target dispatch already
 * decided is not covered, matching the convention the `s3`/`azure`/`gcs` write-path handlers already
 * follow — they trust the same gate rather than re-deriving it.
 */
export async function assetUploaded(
  target: StorageTarget,
  data: Record<string, any>
): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const content = await WIKI.models.assets.getContent(data.id)
  if (!content) return
  const relPath = assetRelPath(data.folderPath, data.fileName)
  const author = await resolveAuthor(target, data.authorId)
  await writeAndCommit(git, repoPath, relPath, content.data, `docs: upload ${relPath}`, author)
}

/**
 * An asset moved to a new name — a git rename in a single commit, same reasoning as `renamed`.
 *
 * No `covers()` re-check — see `assetUploaded`'s doc for why (OpenProject #924).
 */
export async function assetRenamed(
  target: StorageTarget,
  data: Record<string, any>
): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const oldRelPath = assetRelPath(data.folderPath, data.previousFileName)
  const newRelPath = assetRelPath(data.folderPath, data.fileName)
  if (oldRelPath === newRelPath) return
  const author = await resolveAuthor(target, data.authorId)

  if (await fileExists(path.join(repoPath, oldRelPath))) {
    await git.mv(oldRelPath, newRelPath)
    await git.commit(
      `docs: rename ${oldRelPath} to ${newRelPath}`,
      [oldRelPath, newRelPath],
      authorOption(author)
    )
    return
  }
  // -> Nothing tracked at the old name — write fresh at the new one instead of failing the rename.
  const content = await WIKI.models.assets.getContent(data.id)
  if (!content) return
  await writeAndCommit(
    git,
    repoPath,
    newRelPath,
    content.data,
    `docs: upload ${newRelPath}`,
    author
  )
}

/**
 * An asset was deleted.
 *
 * No `covers()` re-check — see `assetUploaded`'s doc for why (OpenProject #924).
 */
export async function assetDeleted(
  target: StorageTarget,
  data: Record<string, any>
): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const relPath = assetRelPath(data.folderPath, data.fileName)
  if (!(await fileExists(path.join(repoPath, relPath)))) return
  if ((await git.checkIgnore(relPath)).length > 0) return
  const author = await resolveAuthor(target, data.authorId)
  await git.rm([relPath])
  await git.commit(`docs: delete ${relPath}`, [relPath], authorOption(author))
}
