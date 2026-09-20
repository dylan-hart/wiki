/**
 * Each export here is a `StorageModule` content-dispatch handler, called as `handler(target, data)` by
 * the `dispatchStorage` task. `data` is the small, JSON-serializable payload `Storage.dispatch()`
 * queues per write-path event — ids, a path, a locale, the acting user, an old name — never the page's
 * rendered content or the asset's bytes, which is why every handler opens with a lookup of its own.
 *
 * `ensureRepo()` is called at the top of every handler rather than once and shared: it is idempotent
 * and cheap when nothing has changed, and calling it per dispatch is what keeps the repo's
 * origin/branch/auth correct when config was edited between one dispatch and the next.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SimpleGit } from 'simple-git'
import { CONTENT_TYPE_EXTENSIONS } from '../../../helpers/pageSerialization.ts'
import { getFileExtension } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureRepo } from './repo.ts'

/**
 * Derived from the shared `CONTENT_TYPE_EXTENSIONS` table so a new page content type is probed here
 * the moment it can be written. Only `deleted` consults it (see there for why); every other handler
 * takes the extension straight from the page's own `contentType`.
 */
const PAGE_EXTENSIONS = [...new Set(Object.values(CONTENT_TYPE_EXTENSIONS))]

/**
 * Exported for `sync.ts`: the same gate a write-path event is checked against also decides whether a
 * change coming the other way, from the remote, is one this target is configured to import.
 */
export function covers(target: StorageTarget, bucket: string): boolean {
  return target.contentTypes.activeTypes.includes(bucket)
}

/**
 * A page in the site's primary locale is written bare and any other locale gets its own folder, so a
 * single-locale wiki never sees a locale segment in its repo at all — git's primary-bare
 * serialization convention, per the locale-architecture decision's §5.3.
 */
function localeNamespace(siteId: string, locale: string): string {
  const primary = CARDINAL.sites?.[siteId]?.config?.locales?.primary
  return primary && locale !== primary ? `${locale}/` : ''
}

export function pageRelPath(
  siteId: string,
  locale: string,
  pagePath: string,
  contentType: string
): string {
  return `${localeNamespace(siteId, locale)}${pagePath}.${getFileExtension(contentType)}`
}

export function assetRelPath(folderPath: string, fileName: string): string {
  return folderPath ? `${folderPath}/${fileName}` : fileName
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

/**
 * Only `deleted` needs this: by the time a page-delete event dispatches, the page's row — and with it
 * its `contentType` — is already gone from the database, so the extension cannot be looked up the way
 * every other handler does. Probing disk works because a page is only ever written under one
 * extension at a time.
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
 * Falls back to the target's configured `defaultName`/`defaultEmail` when there is no author to
 * resolve — either because the dispatch payload carries no `authorId` at all (an asset rename or
 * delete never does), or because the id no longer resolves to a user.
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
  const user = await CARDINAL.models.users.getById(authorId)
  return user?.email ? { name: user.name || fallback.name, email: user.email } : fallback
}

export function authorOption(author: { name: string; email: string }): Record<string, string> {
  return { '--author': `${author.name} <${author.email}>` }
}

/**
 * A `.gitignore`d path is written but never committed: a path the repo owner explicitly excluded
 * should not end up committed regardless of which kind of content it is.
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

export async function created(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await CARDINAL.models.pages.getPage({
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

export async function updated(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await CARDINAL.models.pages.getPage({
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
 * A git rename — old path removed, new path added, in a single commit — rather than a delete plus an
 * add: that is what keeps `git log --follow` treating the file as one continuous history.
 *
 * Where the file *was* is composed from `previousLocale`, not the page's current one: a locale is
 * part of a page's repo path (`localeNamespace`), so reading the old path off the new locale would
 * rename a file that was never there while leaving the real one behind.
 */
export async function renamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
  if (!covers(target, 'pages')) return
  const { git, repoPath } = await ensureRepo(target)
  const page = await CARDINAL.models.pages.getPage({
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
    // -> "rename foo to foo" says nothing about a locale-only move, so qualify both ends with their
    //    locale in that case
    const description =
      data.previousLocale === data.locale
        ? `${data.previousPath} to ${data.path}`
        : `${data.previousLocale}/${data.previousPath} to ${data.locale}/${data.path}`
    await fs.mkdir(path.dirname(path.join(repoPath, newRelPath)), { recursive: true })
    await git.mv(oldRelPath, newRelPath)
    await git.commit(`docs: rename ${description}`, [oldRelPath, newRelPath], authorOption(author))
    return
  }
  // -> Nothing tracked at the old path (e.g. this target only started covering pages after the page
  //    was created), so write fresh at the new path instead of failing the rename.
  await writeAndCommit(
    git,
    repoPath,
    newRelPath,
    page.content ?? '',
    `docs: create ${data.path}`,
    author
  )
}

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
 * No `covers()` re-check here, unlike the page handlers above: an asset's bucket is size-aware
 * (`models/storage.ts`'s `targetCoversEvent`, checked once before `Storage.dispatch()` ever queues
 * this call), and a kind-only re-check would disagree with it for a "large" file — silently dropping
 * the event for a target covering `large` but not the file's own kind bucket, or vice versa. The
 * asset handlers below trust the same gate rather than re-deriving it.
 */
export async function assetUploaded(
  target: StorageTarget,
  data: Record<string, any>
): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const content = await CARDINAL.models.assets.getContent(data.id)
  if (!content) return
  const relPath = assetRelPath(data.folderPath, data.fileName)
  const author = await resolveAuthor(target, data.authorId)
  await writeAndCommit(git, repoPath, relPath, content.data, `docs: upload ${relPath}`, author)
}

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
  const content = await CARDINAL.models.assets.getContent(data.id)
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

export async function assetMoved(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const oldRelPath = assetRelPath(data.previousFolderPath, data.fileName)
  const newRelPath = assetRelPath(data.folderPath, data.fileName)
  if (oldRelPath === newRelPath) return
  const author = await resolveAuthor(target, data.authorId)

  if (await fileExists(path.join(repoPath, oldRelPath))) {
    // -> Unlike a same-folder rename, the destination folder may not exist on disk yet, and `git mv`
    //    does a plain filesystem rename under the hood rather than creating it.
    await fs.mkdir(path.dirname(path.join(repoPath, newRelPath)), { recursive: true })
    await git.mv(oldRelPath, newRelPath)
    await git.commit(
      `docs: move ${oldRelPath} to ${newRelPath}`,
      [oldRelPath, newRelPath],
      authorOption(author)
    )
    return
  }
  // -> Nothing tracked at the old path — write fresh at the new one instead of failing the move.
  const content = await CARDINAL.models.assets.getContent(data.id)
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
