/**
 * Bidirectional sync action: fetch and pull-rebase from origin, push local commits back, then read
 * whatever the pull brought in and reverse-mirror it into the DB via `WIKI.models.pages` /
 * `WIKI.models.assets` — the two-way half of this target that makes it a real sync rather than a
 * push-only mirror. `created`/`updated`/`renamed`/`deleted` (`content.ts`, task 506) are the forward
 * direction — DB change to file; the diff processing here is deliberately built as the reverse of
 * that same mapping (`pageRelPath`'s `[locale/]path.ext` shape, `getFileExtension`'s content-type ↔
 * extension pairing), not a separate scheme.
 *
 * Sequence and diff handling are matched against 2.5.x's `server/modules/storage/git/storage.js`
 * `sync()`/`processFiles()` (verified directly against that source, not from memory): pull --rebase,
 * then push, then `git diffSummary(['-M', beforeHash, afterHash])` — simple-git's equivalent of
 * `git diff --name-status -M`, which is what `-M` (rename detection) actually requests — followed by
 * the same regex 2.5.x runs over each `file.file` entry to pull the old/new halves out of git's
 * `old => new` / `dir/{old => new}/rest` rename notation. No separate rename-detection API call.
 *
 * Sync-direction config (push-only / pull-only / two-way): Feature 370 is the one landing
 * `StorageTarget.sync.mode`, and it had not reached this branch when this task was implemented (its
 * config lives only on the sibling `feature/content-dispatch-sync-engine` branch, which this branch
 * may not merge from). `sync()` therefore always runs the full two-way sequence below, matching
 * 2.5.x's `mode: 'sync'` — the only mode this fork's `definition.yml` exposes today (its `sync`
 * action is declared without a mode selector). See `docs/variances.md` for the tracked follow-up:
 * once `target.sync.mode` exists, the two `if (_.includes(['sync', 'pull'], mode))`-style guards
 * 2.5.x uses around the pull half and the push half belong here too.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime'
import type { DiffResultBinaryFile, DiffResultTextFile, SimpleGit } from 'simple-git'
import { generatePathHash } from '../../../helpers/common.ts'
import { getContentTypeFromExtension } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { getEditorForContentType } from '../../../models/pages.ts'
import { ensureRepo } from './storage.ts'
import { covers, fileExists } from './content.ts'

/**
 * Who a DB write coming from the remote side of a sync is attributed to.
 *
 * Exported for `actions.ts`: `resolveImportActor`/`processDiffEntry` are shared with `importAll`,
 * which attributes its bulk upsert to the same identity.
 */
export interface ImportActor {
  id: string
  permissions: string[]
}

/**
 * One file the diff between the previous and new HEAD reports as changed.
 *
 * Exported for `actions.ts`: `importAll` reuses `processDiffEntry` below to upsert every file it finds
 * in the working tree, built from a synthetic entry (`exists: true`, `oldPath === relPath`, no
 * insertions/deletions) rather than a real `diffSummary` line — that shape is exactly what makes
 * `processPageEntry`/`processAssetEntry`'s rename/delete branches (which all key off `relPath !==
 * oldPath` or `!exists`) fall straight through to the same "does it exist in the DB yet" upsert every
 * other caller of this file reaches too.
 */
export interface DiffEntry {
  /** Path (relative to the repo root) the file has now — after whatever rename, if any. */
  relPath: string
  /** Path it had before — equal to `relPath` when this file was not renamed. */
  oldPath: string
  /** Absolute path of `relPath` on disk. */
  absPath: string
  /** Whether `absPath` exists on disk right now. */
  exists: boolean
  binary: boolean
  insertions: number
  deletions: number
  /** Only meaningful for a binary file — see `DiffResultBinaryFile`. */
  before?: number
  after?: number
}

/**
 * 2.5.x's rename-notation regex, verified against source, copied verbatim rather than
 * re-derived: it parses both of git's compact rename spellings — `old/path => new/path` for a
 * whole-path rename, and `dir/{old => new}/rest` for a rename that only changed part of the path —
 * out of the single string `git diffSummary` reports per renamed file.
 */
const RENAME_PATTERN = /(.*?)(?:{(.*?))? => (?:(.*?)})?(.*)/

/**
 * Split a `git diffSummary` file entry into its old and new paths, applying `RENAME_PATTERN`. A file
 * that was not renamed has no ` => ` in it at all, so the pattern simply fails to match and both
 * paths come back equal to the input — exactly 2.5.x's fallback.
 */
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

/** The extension on a rel path, without its dot — empty when there is none. */
function extOf(relPath: string): string {
  const lastDot = relPath.lastIndexOf('.')
  return lastDot === -1 ? '' : relPath.slice(lastDot + 1)
}

/** `relPath` with its extension removed. */
function stripExt(relPath: string): string {
  const lastDot = relPath.lastIndexOf('.')
  return lastDot === -1 ? relPath : relPath.slice(0, lastDot)
}

/** A folder segment shaped like a locale code, at the front of an extension-stripped page path. */
const LOCALE_SEGMENT = /^([a-z]{2}(?:-[a-z]{2})?)\/(.+)$/i

/**
 * The inverse of `content.ts`'s `localeNamespace` + `pageRelPath`: split `[locale/]path` (already
 * stripped of its extension) back into the locale it was written under and the bare page path. A
 * path with no such prefix is the site's primary locale, exactly as a page written by `created()`
 * never gets a locale folder when it is already in the primary one.
 */
function parseLocaleAndPath(siteId: string, pathNoExt: string): { locale: string; path: string } {
  const primary = WIKI.sites?.[siteId]?.config?.locales?.primary ?? 'en'
  const match = pathNoExt.match(LOCALE_SEGMENT)
  if (match) {
    return { locale: match[1].toLowerCase(), path: match[2] }
  }
  return { locale: primary, path: pathNoExt }
}

/** `path.dirname`, normalized to `''` at the root the way `folderPath` is stored, not `.`. */
function dirnameOf(relPath: string): string {
  const dir = path.dirname(relPath)
  return dir === '.' ? '' : dir
}

/**
 * A rough content-type-bucket guess for a file nobody has told us the kind of yet — the reverse-sync
 * equivalent of `assets.ts`'s private `kindOf()`, which cannot run before the asset exists in the DB.
 * Only used to check `target.contentTypes.activeTypes` before importing; `WIKI.models.assets.upload`
 * computes the real, authoritative kind itself once the row is written.
 */
function guessAssetBucket(relPath: string): string {
  const mimeType = mime.getType(relPath) ?? ''
  if (mimeType.startsWith('image/')) return 'images'
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) return 'documents'
  return 'others'
}

/**
 * Who a change pulled in from the remote is attributed to in the DB: 2.5.x uses a fixed "root user"
 * for this (there is no per-file author info in a bare `git diffSummary`, only per-commit, and a
 * commit can touch many files); this fork has no equivalent fixed system user, so the closest
 * available match is whoever is registered under the target's own configured Default Author Email —
 * the same identity `content.ts`'s `resolveAuthor` falls back to when committing *out* to git. Absent
 * a resolvable user, there is nobody to attribute the write to, and DB import for this sync is
 * skipped entirely (the pull and push above still happened) rather than fabricated.
 */
export async function resolveImportActor(target: StorageTarget): Promise<ImportActor | null> {
  const email = target.config?.defaultEmail
  if (!email) return null
  const user = await WIKI.models.users.getByEmail(email)
  if (!user) return null
  // -> Trusted the same way the git remote itself is: only an admin can configure a sync target, so
  //    content it pulls in is accepted at the same trust level an admin's own edit would be.
  return { id: user.id, permissions: ['manage:system'] }
}

/** The current commit `git` is on, or `null` for a repo with no commits yet (an unborn HEAD). */
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

/** A page's content changed, moved, or was removed on the remote side. Reverses `content.ts`'s page handlers. */
async function processPageEntry(
  target: StorageTarget,
  actor: ImportActor,
  entry: DiffEntry,
  contentType: string
): Promise<void> {
  if (!covers(target, 'pages')) return
  const newMeta = parseLocaleAndPath(target.siteId, stripExt(entry.relPath))

  if (entry.exists && entry.relPath !== entry.oldPath) {
    // -> Renamed by git — matches 2.5.x, which treats any path change on an existing file as a
    //    rename regardless of whether the content also changed in the same commit.
    const oldMeta = parseLocaleAndPath(target.siteId, stripExt(entry.oldPath))
    const existing = await WIKI.models.pages.getPage({
      siteId: target.siteId,
      hash: generatePathHash(oldMeta.path),
      locale: oldMeta.locale
    })
    if (existing) {
      await WIKI.models.pages.movePage(target.siteId, existing.id, { path: newMeta.path }, actor)
      return
    }
    // -> Nothing tracked at the old path: fall through and write fresh at the new one.
  } else if (!entry.exists && entry.deletions > 0 && entry.insertions === 0) {
    const existing = await WIKI.models.pages.getPage({
      siteId: target.siteId,
      hash: generatePathHash(newMeta.path),
      locale: newMeta.locale
    })
    if (existing) {
      await WIKI.models.pages.deletePage(target.siteId, existing.id, actor)
    }
    return
  }

  if (!entry.exists) return
  const content = await fs.readFile(entry.absPath, 'utf8')
  const existing = await WIKI.models.pages.getPage({
    siteId: target.siteId,
    hash: generatePathHash(newMeta.path),
    locale: newMeta.locale
  })
  if (existing) {
    await WIKI.models.pages.updatePage(target.siteId, existing.id, { content }, actor)
  } else {
    // -> Brand new to the DB. `content.ts` never injects front matter into what it writes (see its
    //    header), so there is none to parse back out either — the title is guessed from the path the
    //    same way 2.5.x falls back when a file it is importing has no front matter of its own.
    await WIKI.models.pages.createPage(
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

/** An asset changed, moved, or was removed on the remote side. Reverses `content.ts`'s asset handlers. */
async function processAssetEntry(
  target: StorageTarget,
  actor: ImportActor,
  entry: DiffEntry
): Promise<void> {
  const bucket = guessAssetBucket(entry.relPath)
  if (!covers(target, bucket)) return

  const contentUnchanged =
    entry.before === entry.after || (entry.deletions === 0 && entry.insertions === 0)
  if (entry.exists && entry.relPath !== entry.oldPath && contentUnchanged) {
    const existing = await WIKI.models.assets.getAssetByPath(target.siteId, entry.oldPath)
    if (existing) {
      const newFolder = dirnameOf(entry.relPath)
      if (newFolder === existing.folderPath) {
        await WIKI.models.assets.renameAsset(
          target.siteId,
          existing.id,
          path.basename(entry.relPath)
        )
        return
      }
      // -> The rename also moved folders, which `renameAsset` only ever changes the file name for
      //    (see its own doc comment) — treat it as a delete of the old asset and a fresh upload at
      //    the new location rather than silently losing the folder move.
      await WIKI.models.assets.deleteAsset(target.siteId, existing.id)
    }
    // -> Nothing tracked at the old path: fall through and upload fresh at the new one.
  } else if (
    !entry.exists &&
    (((entry.before ?? 0) > 0 && entry.after === 0) ||
      (entry.deletions > 0 && entry.insertions === 0))
  ) {
    const existing = await WIKI.models.assets.getAssetByPath(target.siteId, entry.relPath)
    if (existing) {
      await WIKI.models.assets.deleteAsset(target.siteId, existing.id)
    }
    return
  }

  if (!entry.exists) return
  const data = await fs.readFile(entry.absPath)
  const folderPath = dirnameOf(entry.relPath)
  const primary = WIKI.sites?.[target.siteId]?.config?.locales?.primary ?? 'en'
  const folder = folderPath
    ? await WIKI.models.tree.getFolder({
        path: folderPath,
        locale: primary,
        siteId: target.siteId,
        createIfMissing: true
      })
    : null
  // -> `upload()` itself resolves a name already taken in this folder to an overwrite, so this one
  //    call covers both "new asset" and "existing asset's bytes changed" — same as 2.5.x's
  //    `commonDisk.processAsset`, which upserts rather than branching on whether the row exists yet.
  await WIKI.models.assets.upload({
    siteId: target.siteId,
    locale: primary,
    folderId: folder?.id ?? null,
    fileName: path.basename(entry.relPath),
    data,
    authorId: actor.id
  })
}

/** Exported for `actions.ts` — see the header comment on `DiffEntry` for why `importAll` reuses this. */
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
 * The `sync` action declared in `definition.yml`: fetch + pull-rebase from origin, push local commits
 * back, then reverse-mirror whatever the pull brought in into the DB.
 *
 * A rebase conflict is not caught here — see the header comment for why that is a deliberate,
 * verified match of 2.5.x rather than a gap: it aborts the sync and surfaces the rejection to
 * whichever caller invoked this action (the admin "Force Sync" button today; a scheduled job once
 * Feature 370 lands one), leaving the working copy mid-rebase for an administrator to resolve, the
 * same place a `git pull --rebase` run by hand would leave it.
 */
export async function sync(target: StorageTarget): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const branch = target.config?.branch || 'main'

  const beforeHash = await headHash(git)

  if (beforeHash) {
    WIKI.logger.info(`(STORAGE/GIT) Performing pull rebase from origin on branch ${branch}...`)
    await git.pull('origin', branch, ['--rebase'])
  } else {
    // -> Nothing local to rebase yet — a plain pull is enough to bring the branch into existence.
    WIKI.logger.info(`(STORAGE/GIT) Performing initial pull from origin on branch ${branch}...`)
    await git.pull('origin', branch)
  }

  WIKI.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${branch}...`)
  await git.push('origin', branch, ['--signed=if-asked'])

  const afterHash = await headHash(git)
  if (!afterHash || !beforeHash || afterHash === beforeHash) {
    // -> Either nothing changed, or this was the repo's very first pull: 2.5.x does not diff-import
    //    on a first sync either — that is what the separate "Import Everything" action is for
    //    (`importAll`, out of this task's scope), rather than something `sync()` infers on its own.
    return
  }

  const actor = await resolveImportActor(target)
  if (!actor) {
    WIKI.logger.warn(
      `(STORAGE/GIT) No user matches target's configured Default Author Email — skipping DB import for this sync.`
    )
    return
  }

  const diff = await git.diffSummary(['-M', beforeHash, afterHash])
  for (const file of diff.files) {
    const { oldPath, newPath } = parseRenamedPaths(file.file)
    const absPath = path.join(repoPath, newPath)
    const binary = isBinaryEntry(file)
    const entry: DiffEntry = {
      relPath: newPath,
      oldPath,
      absPath,
      exists: await fileExists(absPath),
      binary,
      insertions: binary ? 0 : file.insertions,
      deletions: binary ? 0 : file.deletions,
      before: binary ? file.before : undefined,
      after: binary ? file.after : undefined
    }
    try {
      await processDiffEntry(target, actor, entry)
    } catch (err: any) {
      WIKI.logger.warn(`(STORAGE/GIT) Failed to import ${entry.relPath} from the remote change:`)
      WIKI.logger.warn(err)
    }
  }
}
