/**
 * The remote-to-DB half of this target: what a pull brought in is reverse-mirrored into
 * `CARDINAL.models.pages` / `CARDINAL.models.assets`. The diff processing here is built as the exact
 * inverse of `content.ts`'s forward mapping (`pageRelPath`'s `[locale/]path.ext` shape, the
 * content-type ↔ extension pairing) rather than a scheme of its own, so the two cannot drift.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime'
import type { DiffResultBinaryFile, DiffResultTextFile, SimpleGit } from 'simple-git'
import { generatePathHash } from '../../../helpers/common.ts'
import { stripLocalePrefix } from '../../../helpers/localeRouting.ts'
import { getContentTypeFromExtension } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { getEditorForContentType } from '../../../models/pages.ts'
import { ensureRepo, gitLog } from './repo.ts'
import { covers, fileExists } from './content.ts'

export interface ImportActor {
  id: string
  permissions: string[]
  groupIds: string[]
}

export interface DiffEntry {
  relPath: string
  /** Equal to `relPath` when the file was not renamed — never null. */
  oldPath: string
  absPath: string
  exists: boolean
  binary: boolean
  insertions: number
  deletions: number
  /** Binary entries only; `undefined` on a text entry. */
  before?: number
  after?: number
}

/**
 * Parses both of git's compact rename spellings out of the single string `diffSummary` reports per
 * renamed file: `old/path => new/path`, and `dir/{old => new}/rest` for a rename that changed only
 * part of the path. The second is what a *folder* rename produces — git has no first-class notion of
 * a directory move, so `docs/guide` → `docs/handbook` arrives as one entry per file underneath,
 * each dispatched independently.
 */
const RENAME_PATTERN = /(.*?)(?:{(.*?))? => (?:(.*?)})?(.*)/

export function parseRenamedPaths(fileEntry: string): { oldPath: string; newPath: string } {
  const match = fileEntry.match(RENAME_PATTERN)
  if (!match) {
    return { oldPath: fileEntry, newPath: fileEntry }
  }
  if (!match[2] && !match[3]) {
    return { oldPath: match[1], newPath: match[4] }
  }
  return {
    oldPath: (match[1] + match[2] + match[4]).replace('//', '/'),
    newPath: (match[1] + match[3] + match[4]).replace('//', '/')
  }
}

function extOf(relPath: string): string {
  const lastDot = relPath.lastIndexOf('.')
  return lastDot === -1 ? '' : relPath.slice(lastDot + 1)
}

function stripExt(relPath: string): string {
  const lastDot = relPath.lastIndexOf('.')
  return lastDot === -1 ? relPath : relPath.slice(0, lastDot)
}

/**
 * Inverse of `content.ts`'s `localeNamespace` + `pageRelPath`. Validated against the site's ACTIVE
 * locales via `stripLocalePrefix` rather than guessed from shape, so a folder merely shaped like a
 * locale code (`it/`, `qa/`) stays a folder and the code comes back cased exactly as stored
 * (`pt-BR`, never a lowercased `pt-br` twin).
 */
export function parseLocaleAndPath(
  siteId: string,
  pathNoExt: string
): { locale: string; path: string } {
  const locales = CARDINAL.sites?.[siteId]?.config?.locales
  const primary = locales?.primary ?? 'en'
  const match = stripLocalePrefix(`/${pathNoExt}`, locales)
  if (match && match.path !== '/') {
    return { locale: match.locale, path: match.path.slice(1) }
  }
  return { locale: primary, path: pathNoExt }
}

/** `path.dirname`, normalized to `''` at the root the way `folderPath` is stored, not `.`. */
function dirnameOf(relPath: string): string {
  const dir = path.dirname(relPath)
  return dir === '.' ? '' : dir
}

/**
 * A guess, for a file that has no DB row yet to ask. Only used to check
 * `target.contentTypes.activeTypes` before importing — `CARDINAL.models.assets.upload` computes the
 * authoritative kind once the row is written.
 */
function guessAssetBucket(relPath: string): string {
  const mimeType = mime.getType(relPath) ?? ''
  if (mimeType.startsWith('image/')) return 'images'
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return 'documents'
  return 'others'
}

/**
 * A bare `git diffSummary` carries no per-file author (only per-commit, and a commit can touch many
 * files), and there is no fixed system user to fall back on — so a pulled change is attributed to
 * whoever is registered under the target's Default Author Email, the same identity `content.ts`'s
 * `resolveAuthor` commits *out* to git under. With no such user there is nobody to attribute the
 * write to, so the import is skipped rather than fabricated.
 */
export async function resolveImportActor(target: StorageTarget): Promise<ImportActor> {
  const email = target.config?.defaultEmail
  const user = email ? await CARDINAL.models.users.getByEmail(email) : null
  const id = user ? user.id : await CARDINAL.models.users.ensureSystemUser()
  // -> Only an admin can configure a sync target, so what it pulls in is accepted at the trust
  //    level an admin's own edit would be. `manage:system` bypasses every page-rule check, which is
  //    why `groupIds` is never actually consulted.
  return { id, permissions: ['manage:system'], groupIds: [] }
}

/** `null` for a repo with no commits yet — an unborn HEAD, not a failure. */
async function headHash(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.revparse(['HEAD'])).trim()
  } catch {
    return null
  }
}

function isBinaryEntry(
  file: DiffResultTextFile | DiffResultBinaryFile
): file is DiffResultBinaryFile {
  return file.binary
}

/** Mirrors `definition.yml`'s own `default: 50` — keep the two in step. */
const DEFAULT_MAX_DELETE_PERCENT = 50

/**
 * A percentage threshold is meaningless noise below this: on a 3-page wiki, deleting one page is a
 * 33% deletion. Deliberately not configurable — a second knob would only obscure the one that
 * matters.
 */
const MIN_PAGES_FOR_DELETE_GUARD = 10

/**
 * Duplicates `processPageEntry`'s own delete condition so the mass-delete guard can count deletions
 * before any entry is applied, without the DB reads and side effects that method carries. Asset
 * deletions are deliberately out of the guard's scope.
 */
function isPageDeletionEntry(entry: DiffEntry): boolean {
  if (entry.binary) return false
  if (!getContentTypeFromExtension(extOf(entry.relPath))) return false
  return !entry.exists && entry.deletions > 0 && entry.insertions === 0
}

/**
 * Clamped and defaulted here because a `definition.yml` prop declared as `Number` has no schema
 * enforcing a range the way a JSON Schema body would.
 */
function maxDeletePercentFor(target: StorageTarget): number {
  const raw = Number(target.config?.maxDeletePercent)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_DELETE_PERCENT
  return Math.min(100, raw)
}

async function processPageEntry(
  target: StorageTarget,
  actor: ImportActor,
  entry: DiffEntry,
  contentType: string
): Promise<void> {
  if (!covers(target, 'pages')) return
  const newMeta = parseLocaleAndPath(target.siteId, stripExt(entry.relPath))

  if (entry.exists && entry.relPath !== entry.oldPath) {
    const oldMeta = parseLocaleAndPath(target.siteId, stripExt(entry.oldPath))
    const existing = await CARDINAL.models.pages.getPage({
      siteId: target.siteId,
      hash: generatePathHash(oldMeta.path),
      locale: oldMeta.locale
    })
    if (existing) {
      // -> Locale included, because a locale is a directory in the repo: `git mv en/foo.md
      //    fr/foo.md` is a move into another locale, and the path alone would keep it in `en`.
      await CARDINAL.models.pages.movePage(
        target.siteId,
        existing.id,
        { path: newMeta.path, locale: newMeta.locale },
        actor
      )
      return
    }
    // -> Nothing tracked at the old path: fall through and write fresh at the new one.
  } else if (!entry.exists && entry.deletions > 0 && entry.insertions === 0) {
    const existing = await CARDINAL.models.pages.getPage({
      siteId: target.siteId,
      hash: generatePathHash(newMeta.path),
      locale: newMeta.locale
    })
    if (existing) {
      await CARDINAL.models.pages.deletePage(target.siteId, existing.id, actor)
    }
    return
  }

  if (!entry.exists) return
  const content = await fs.readFile(entry.absPath, 'utf8')
  const existing = await CARDINAL.models.pages.getPage({
    siteId: target.siteId,
    hash: generatePathHash(newMeta.path),
    locale: newMeta.locale
  })
  if (existing) {
    await CARDINAL.models.pages.updatePage(target.siteId, existing.id, { content }, actor)
  } else {
    // -> `content.ts` injects no front matter into what it writes, so there is none to parse back
    //    out either — the title is guessed from the path.
    await CARDINAL.models.pages.createPage(
      target.siteId,
      {
        path: newMeta.path,
        locale: newMeta.locale,
        title: newMeta.path.split('/').pop() || newMeta.path,
        editor: getEditorForContentType(contentType),
        content
      },
      actor
    )
  }
}

async function processAssetEntry(
  target: StorageTarget,
  actor: ImportActor,
  entry: DiffEntry
): Promise<void> {
  const bucket = guessAssetBucket(entry.relPath)
  if (!covers(target, bucket)) return

  if (entry.exists && entry.relPath !== entry.oldPath) {
    const existing = await CARDINAL.models.assets.getAssetByPath(target.siteId, entry.oldPath)
    if (existing) {
      // -> `entry.binary` is the discriminant, not an OR of both signals: a text entry's
      //    `before`/`after` are always `undefined` and a binary entry's `insertions`/`deletions`
      //    always `0`, so each clause is vacuously true for the other kind and an OR of the two is
      //    unconditionally true — which sends a same-folder rename-and-rewrite through
      //    `renameAsset` with stale bytes. Only the field that is real for this kind is consulted.
      const contentUnchanged = entry.binary
        ? entry.before === entry.after
        : entry.deletions === 0 && entry.insertions === 0
      const newFolder = dirnameOf(entry.relPath)
      if (contentUnchanged && newFolder === existing.folderPath) {
        await CARDINAL.models.assets.renameAsset(
          target.siteId,
          existing.id,
          path.basename(entry.relPath)
        )
        return
      }
      // -> Renamed across folders, or renamed AND rewritten in one commit: either way the old row
      //    cannot be updated in place (`renameAsset` only changes the file name, and `upload()`
      //    below keys on the new path), so it is deleted rather than left orphaned.
      await CARDINAL.models.assets.deleteAsset(target.siteId, existing.id, { authorId: actor.id })
    }
  } else if (
    !entry.exists &&
    (((entry.before ?? 0) > 0 && entry.after === 0) ||
      (entry.deletions > 0 && entry.insertions === 0))
  ) {
    const existing = await CARDINAL.models.assets.getAssetByPath(target.siteId, entry.relPath)
    if (existing) {
      await CARDINAL.models.assets.deleteAsset(target.siteId, existing.id, { authorId: actor.id })
    }
    return
  }

  if (!entry.exists) return
  const data = await fs.readFile(entry.absPath)
  const folderPath = dirnameOf(entry.relPath)
  const primary = CARDINAL.sites?.[target.siteId]?.config?.locales?.primary ?? 'en'
  const folder = folderPath
    ? await CARDINAL.models.tree.getFolder({
        path: folderPath,
        locale: primary,
        siteId: target.siteId,
        createIfMissing: true
      })
    : null
  // -> `upload()` resolves a name already taken in this folder to an overwrite, so this one call
  //    covers both "new asset" and "existing asset's bytes changed".
  await CARDINAL.models.assets.upload({
    siteId: target.siteId,
    locale: primary,
    folderId: folder?.id ?? null,
    fileName: path.basename(entry.relPath),
    data,
    authorId: actor.id
  })
}

export async function processDiffEntry(
  target: StorageTarget,
  actor: ImportActor,
  entry: DiffEntry
): Promise<void> {
  const contentType = entry.binary ? null : getContentTypeFromExtension(extOf(entry.relPath))
  if (contentType) {
    await processPageEntry(target, actor, entry, contentType)
  } else {
    await processAssetEntry(target, actor, entry)
  }
}

/**
 * A rebase conflict is deliberately not caught: it aborts the sync and leaves the working copy
 * mid-rebase for an administrator, the same place a hand-run `git pull --rebase` would.
 *
 * Mass-delete guard: once page deletions reach the target's `maxDeletePercent`, only the
 * page-deletion entries are held back and logged — every other change in the diff still applies,
 * mirroring `rsync --max-delete`'s "stop deleting, keep transferring" rather than refusing the whole
 * sync. `data.confirmMassDelete === true` bypasses it, and `tickScheduledSyncs()` passes `{}`, so a
 * scheduled run can never supply that override unattended — only a manual "Force Sync" can.
 */
export async function sync(target: StorageTarget, data: Record<string, any> = {}): Promise<void> {
  const log = gitLog(target)
  const { git, repoPath } = await ensureRepo(target)
  const branch = target.config?.branch || 'main'
  const mode = target.sync.mode
  const pulls = ['sync', 'pull'].includes(mode)
  const pushes = ['sync', 'push'].includes(mode)

  const beforeHash = await headHash(git)

  if (pulls) {
    if (beforeHash) {
      log.debug('pulling from origin with rebase', { branch })
      await git.pull('origin', branch, ['--rebase'])
    } else {
      // -> Nothing local to rebase yet — a plain pull is enough to bring the branch into existence.
      log.debug('performing the initial pull from origin', { branch })
      await git.pull('origin', branch)
    }
  }

  if (pushes) {
    log.debug('pushing to origin', { branch })
    await git.push('origin', branch, ['--signed=if-asked'])
  }

  if (!pulls) {
    // -> A push-only target has nothing pulled to reverse-mirror into the DB
    return
  }

  const afterHash = await headHash(git)
  if (!afterHash || !beforeHash || afterHash === beforeHash) {
    // -> Nothing changed, or this was the repo's very first pull. A first sync deliberately does
    //    not diff-import; the separate `importAll` action is what seeds a repo's existing content.
    return
  }

  const actor = await resolveImportActor(target)

  const diff = await git.diffSummary(['-M', beforeHash, afterHash])
  const entries: DiffEntry[] = []
  for (const file of diff.files) {
    const { oldPath, newPath } = parseRenamedPaths(file.file)
    const absPath = path.join(repoPath, newPath)
    const binary = isBinaryEntry(file)
    entries.push({
      relPath: newPath,
      oldPath,
      absPath,
      exists: await fileExists(absPath),
      binary,
      insertions: binary ? 0 : file.insertions,
      deletions: binary ? 0 : file.deletions,
      before: binary ? file.before : undefined,
      after: binary ? file.after : undefined
    })
  }

  const deletedPageCount = entries.filter(isPageDeletionEntry).length
  let holdBackDeletions = false
  if (deletedPageCount > 0 && data.confirmMassDelete !== true) {
    const totalPages = (await CARDINAL.models.pages.listAllForSite(target.siteId)).length
    if (totalPages >= MIN_PAGES_FOR_DELETE_GUARD) {
      const percentDeleted = (deletedPageCount / totalPages) * 100
      if (percentDeleted >= maxDeletePercentFor(target)) {
        holdBackDeletions = true
        log.warn(
          'diff would delete at or above the safety threshold, deletions skipped — re-run force sync with confirmation to apply them',
          {
            deleted: deletedPageCount,
            total: totalPages,
            percent: Math.round(percentDeleted),
            threshold: maxDeletePercentFor(target)
          }
        )
      }
    }
  }

  for (const entry of entries) {
    if (holdBackDeletions && isPageDeletionEntry(entry)) {
      continue
    }
    try {
      await processDiffEntry(target, actor, entry)
    } catch (err: any) {
      log.warn('importing a file from the remote change failed', {
        path: entry.relPath,
        error: err
      })
    }
  }
}
