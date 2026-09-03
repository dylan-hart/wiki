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
 * Sync-direction config (push-only / pull-only / two-way): `sync()` reads `target.sync.mode` and
 * mirrors 2.5.x's own `if (_.includes(['sync', 'pull'], mode))` / `if (_.includes(['sync', 'push'],
 * mode))` guards around the pull half and the push half — a `push`-only target never pulls (so
 * "Force Sync" cannot import remote content into the DB, matching `definition.yml`'s own "The sync
 * direction is respected" hint on that action) and a `pull`-only target never pushes. The reverse-
 * mirror step (diff-importing whatever the pull brought in) is gated the same way as the pull half:
 * nothing was pulled for a `push`-only target to reverse-mirror in the first place.
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
import { ensureRepo } from './repo.ts'
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
  groupIds: string[]
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
 *
 * The `dir/{old => new}/rest` branch is what a *folder* rename actually produces — git has no
 * first-class notion of a directory move, so renaming `docs/guide` to `docs/handbook` shows up as one
 * `docs/{guide => handbook}/<file>` entry per file underneath, each parsed and dispatched
 * independently by `processDiffEntry` below. OpenProject #823 item 3 (upstream #2817: "folder renames
 * in the remote repo don't sync via Force Sync") asked this be checked against that upstream bug —
 * confirmed against a real `git diff -M` first (not assumed), then against `sync()` end-to-end in
 * `sync.test.ts`'s "pulls a whole-folder rename" tests: this already works, both for pages
 * (`movePage` per file) and assets (delete + re-upload per file, since a folder move is not something
 * `renameAsset()` covers — see `processAssetEntry`).
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

/**
 * The inverse of `content.ts`'s `localeNamespace` + `pageRelPath`: split `[locale/]path` (already
 * stripped of its extension) back into the locale it was written under and the bare page path.
 * Validated against the site's ACTIVE locales via the canonical `stripLocalePrefix` — a folder
 * merely shaped like a locale code (`it/`, `qa/`) is a folder, and the code comes back exactly as
 * stored in `active` (`pt-BR`, never a lowercased `pt-br` twin). A path with no active-locale
 * prefix is the site's primary locale, exactly as `created()` writes it.
 *
 * Exported for `sync.test.ts` — see `docs/decisions/locale-architecture.md` §5.3 for why this
 * parser validates against `locales.active` instead of guessing from shape.
 */
export function parseLocaleAndPath(
  siteId: string,
  pathNoExt: string
): { locale: string; path: string } {
  const locales = WIKI.sites?.[siteId]?.config?.locales
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
  //    `manage:system` bypasses every page-rule check, so `groupIds` is never actually consulted.
  return { id: user.id, permissions: ['manage:system'], groupIds: [] }
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

/**
 * The default `maxDeletePercent` when a target's config doesn't declare one — matches
 * `definition.yml`'s own `default: 50`, re-declared here as the fallback for a target whose config
 * predates the prop, or whose stored value fails to parse as a usable number.
 */
const DEFAULT_MAX_DELETE_PERCENT = 50

/**
 * The mass-delete guard below only ever engages once a site has at least this many pages. Below it,
 * any percentage-based threshold is meaningless noise: a 3-page wiki where someone deletes one page
 * is a 33% deletion, and treating that as a "mass deletion" worth holding back would make the guard
 * fire on completely ordinary single-page cleanup. This floor is deliberately not configurable —
 * unlike `maxDeletePercent`, there is no real reason an administrator would want to tune it, and a
 * second knob here would only make the config surface harder to reason about for the one knob that
 * actually matters.
 */
const MIN_PAGES_FOR_DELETE_GUARD = 10

/**
 * Whether `entry` represents a page (not an asset) being deleted on the remote side — the same
 * condition `processPageEntry`'s own delete branch checks, re-derived here so the mass-delete guard
 * below (which runs BEFORE any entry is processed) can count deletions without any of the DB reads
 * or side effects `processPageEntry` itself carries. `contentType` is required to be non-null, the
 * same gate `processDiffEntry` uses to route an entry to `processPageEntry` in the first place — an
 * asset's own deletion is scoped out of this guard entirely (see `sync()`'s header comment).
 */
function isPageDeletionEntry(entry: DiffEntry): boolean {
  if (entry.binary) return false
  if (!getContentTypeFromExtension(extOf(entry.relPath))) return false
  return !entry.exists && entry.deletions > 0 && entry.insertions === 0
}

/**
 * The effective `maxDeletePercent` for `target`, clamped to a sane 1-100 range and falling back to
 * `DEFAULT_MAX_DELETE_PERCENT` for anything that doesn't parse as a positive number — a defensively
 * generic prop declared as `Number` has no schema enforcing a range the way a JSON Schema body would.
 */
function maxDeletePercentFor(target: StorageTarget): number {
  const raw = Number(target.config?.maxDeletePercent)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_DELETE_PERCENT
  return Math.min(100, raw)
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
      // -> Locale included, because a locale is a directory in the repo: `git mv en/foo.md fr/foo.md`
      //    is a move into another locale, and passing the path alone would import it as a page that
      //    never left `en`
      await WIKI.models.pages.movePage(
        target.siteId,
        existing.id,
        { path: newMeta.path, locale: newMeta.locale },
        actor
      )
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

  if (entry.exists && entry.relPath !== entry.oldPath) {
    const existing = await WIKI.models.assets.getAssetByPath(target.siteId, entry.oldPath)
    if (existing) {
      // -> `entry.binary` (which `sync()` always knows, from `DiffResultBinaryFile` vs.
      //    `DiffResultTextFile`) is the discriminant, not an OR of both signals: a text entry's
      //    `before`/`after` are always `undefined` (so `before === after` is vacuously true for
      //    every text entry) and a binary entry's `insertions`/`deletions` are always hardcoded to
      //    `0` (so that clause is vacuously true for every binary entry) — an OR of the two is
      //    unconditionally true regardless of which kind actually changed, which is what silently
      //    let a same-folder rename-and-rewrite through `renameAsset` with stale bytes. Only the
      //    field that is real for this entry's kind is consulted.
      const contentUnchanged = entry.binary
        ? entry.before === entry.after
        : entry.deletions === 0 && entry.insertions === 0
      const newFolder = dirnameOf(entry.relPath)
      if (contentUnchanged && newFolder === existing.folderPath) {
        await WIKI.models.assets.renameAsset(
          target.siteId,
          existing.id,
          path.basename(entry.relPath)
        )
        return
      }
      // -> Renamed across folders, or renamed AND rewritten in one commit: either way the old row
      //    cannot be updated in place (renameAsset only changes the file name; upload() below keys
      //    on the new path) — delete it so the fresh upload doesn't leave it orphaned.
      await WIKI.models.assets.deleteAsset(target.siteId, existing.id)
    }
    // -> fall through to the upload below
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
 * whichever caller invoked this action (the admin "Force Sync" button, or a scheduled job via
 * `storageSyncTick`), leaving the working copy mid-rebase for an administrator to resolve, the same
 * place a `git pull --rebase` run by hand would leave it.
 *
 * Mass-delete safety guard (OpenProject #2429): a reverted/deleted commit on the remote legitimately
 * reverse-mirrors as page deletions here — that is working as designed — but nothing used to stand
 * between "the diff says delete one page" and "the diff says delete every page", the way `rsync
 * --max-delete` or a Terraform destroy-count warning would for an equivalent bulk-destructive diff.
 * Before any entry is applied, the diff is pre-scanned for page deletions (`isPageDeletionEntry` —
 * asset deletions are deliberately out of scope for this guard) and compared against the site's
 * current total page count. Once that fraction reaches the target's configured
 * `maxDeletePercent` (default 50%, `MIN_PAGES_FOR_DELETE_GUARD` pages minimum so the check is
 * meaningless noise on a small wiki), every OTHER change in the diff still applies normally — only
 * the page-deletion entries are held back, logged, and skipped, mirroring `rsync --max-delete`'s own
 * "stop deleting, keep transferring" behavior rather than refusing the whole sync. `data.
 * confirmMassDelete === true` bypasses the hold entirely. `data` is `{}` for every scheduled sync
 * (`tickScheduledSyncs()` never sets it), so a scheduled run can never itself supply the override —
 * only a manually re-triggered "Force Sync" through the API (passing the flag in its request body)
 * can, which is what applies this guard identically to both trigger paths while keeping the scheduled
 * one inherently unable to blow past it unattended.
 *
 * @param data The same payload `dispatchStorage` hands every other module handler — `{}` for a
 *   scheduled sync, or `{ confirmMassDelete: true }` for a manually-confirmed "Force Sync" (see
 *   `api/storage.ts`).
 */
export async function sync(target: StorageTarget, data: Record<string, any> = {}): Promise<void> {
  const { git, repoPath } = await ensureRepo(target)
  const branch = target.config?.branch || 'main'
  const mode = target.sync.mode
  const pulls = ['sync', 'pull'].includes(mode)
  const pushes = ['sync', 'push'].includes(mode)

  const beforeHash = await headHash(git)

  if (pulls) {
    if (beforeHash) {
      WIKI.logger.info(`(STORAGE/GIT) Performing pull rebase from origin on branch ${branch}...`)
      await git.pull('origin', branch, ['--rebase'])
    } else {
      // -> Nothing local to rebase yet — a plain pull is enough to bring the branch into existence.
      WIKI.logger.info(`(STORAGE/GIT) Performing initial pull from origin on branch ${branch}...`)
      await git.pull('origin', branch)
    }
  }

  if (pushes) {
    WIKI.logger.info(`(STORAGE/GIT) Performing push to origin on branch ${branch}...`)
    await git.push('origin', branch, ['--signed=if-asked'])
  }

  if (!pulls) {
    // -> A push-only target has nothing pulled to reverse-mirror into the DB
    return
  }

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
    const totalPages = (await WIKI.models.pages.listAllForSite(target.siteId)).length
    if (totalPages >= MIN_PAGES_FOR_DELETE_GUARD) {
      const percentDeleted = (deletedPageCount / totalPages) * 100
      if (percentDeleted >= maxDeletePercentFor(target)) {
        holdBackDeletions = true
        WIKI.logger.warn(
          `(STORAGE/GIT) This sync's diff would delete ${deletedPageCount} of ${totalPages} pages ` +
            `(~${Math.round(percentDeleted)}%), at or above the configured safety threshold of ` +
            `${maxDeletePercentFor(target)}%. Skipping the deletions (everything else in the diff ` +
            `still applies) — re-run "Force Sync" with confirmation to apply them anyway.`
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
      WIKI.logger.warn(`(STORAGE/GIT) Failed to import ${entry.relPath} from the remote change:`)
      WIKI.logger.warn(err)
    }
  }
}
