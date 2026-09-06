/**
 * The three remaining `definition.yml` actions: `syncUntracked` ("Add Untracked Changes"),
 * `importAll` ("Import Everything") and `purge` ("Purge Local Repository").
 *
 * All three reuse the plumbing built for the write-path handlers and `sync`, rather than
 * re-implementing it:
 *  - `ensureRepo` (`storage.ts`, task 504) for repo lifecycle/auth.
 *  - `pageRelPath`/`assetRelPath`/`covers`/`resolveAuthor`/`authorOption` (`content.ts`, task 506)
 *    for the DB→file mapping the forward direction already established.
 *  - `processDiffEntry`/`resolveImportActor`/`DiffEntry` (`sync.ts`, task 507) for the file→DB upsert
 *    the reverse direction already established — `importAll` feeds it synthetic entries (see below)
 *    instead of a real `git diffSummary` line.
 *
 * `syncUntracked`'s asset walk gates on `belongsInTarget` (`helpers/blobTarget.ts`), the same
 * size-aware bucket classification `Storage.dispatch()` gates a write-path event on and the
 * `s3`/`azure`/`gcs` modules' own `exportAll` gates their bulk push on — not `content.ts`'s
 * kind-only `covers(target, assetBucket(...))`, which would silently skip (or wrongly include) a
 * "large" asset for a target that covers `large` but not the asset's own kind bucket, or vice versa
 * (OpenProject #924).
 *
 * Verified against 2.5.x's own `syncUntracked`/`importAll`/`purge` (`server/modules/storage/git/
 * storage.js`, fetched and read directly rather than recalled from memory) for the shape each action
 * takes — one bulk commit for `syncUntracked`, a plain working-tree walk with no diff/rename/delete
 * inference for `importAll`, an empty-and-reinit for `purge` — while re-deriving the actual per-file
 * logic from this branch's own plumbing rather than porting 2.5.x's code.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SimpleGit } from 'simple-git'
import type { StorageTarget } from '../../../models/storage.ts'
import { belongsInTarget } from '../../../helpers/blobTarget.ts'
import { assetRelPath, authorOption, covers, pageRelPath, resolveAuthor } from './content.ts'
import { processDiffEntry, resolveImportActor } from './sync.ts'
import type { DiffEntry } from './sync.ts'
import { ensureRepo, gitLog, resolveRepoPath } from './repo.ts'

/**
 * Write `content` to `relPath` if it is missing or its bytes differ from what is already there, and
 * stage it (`git add`) when it was written — never committed here, `syncUntracked` commits everything
 * it staged in one go at the end.
 *
 * @returns Whether the file was written and staged.
 */
async function writeIfChanged(
  git: SimpleGit,
  repoPath: string,
  relPath: string,
  content: string | Buffer
): Promise<boolean> {
  const absPath = path.join(repoPath, relPath)
  const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')

  const existing = await fs.readFile(absPath).catch(() => null)
  if (existing && existing.equals(incoming)) {
    return false
  }

  await fs.mkdir(path.dirname(absPath), { recursive: true })
  await fs.writeFile(absPath, incoming)
  if ((await git.checkIgnore(relPath)).length > 0) {
    return false
  }
  await git.add(relPath)
  return true
}

/**
 * `syncUntracked` ("Add Untracked Changes"): a one-way DB→repo export for content that predates git
 * being enabled (or was created while it was temporarily disabled) — walk every page and asset of the
 * target's site whose content type the target actively covers, write out whichever ones the repo does
 * not yet have or has stale, and commit them all in a single "docs: add all untracked content" commit,
 * matching 2.5.x's own action. Never touches the remote — no pull, no push.
 *
 * If nothing on disk needed writing, no commit is made at all: `git commit` with nothing staged is an
 * error, not a no-op, so this only calls it when at least one file was actually staged.
 */
export async function syncUntracked(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const { git, repoPath } = await ensureRepo(target)
  let staged = false

  if (covers(target, 'pages')) {
    const pages = await WIKI.models.pages.listAllForSite(target.siteId)
    for (const page of pages) {
      try {
        const relPath = pageRelPath(target.siteId, page.locale, page.path, page.contentType)
        const full = await WIKI.models.pages.getPage({
          siteId: target.siteId,
          id: page.id,
          withContent: true
        })
        if (!full) continue
        if (await writeIfChanged(git, repoPath, relPath, full.content ?? '')) {
          staged = true
        }
      } catch (err: any) {
        log.warn('adding an untracked page failed', { page: page.path, error: err })
      }
    }
  }

  const assets = await WIKI.models.assets.listAllForSite(target.siteId)
  for (const asset of assets) {
    if (!belongsInTarget(asset, target.contentTypes)) continue
    try {
      const relPath = assetRelPath(asset.folderPath, asset.fileName)
      const content = await WIKI.models.assets.getContent(asset.id)
      if (!content) continue
      if (await writeIfChanged(git, repoPath, relPath, content.data)) {
        staged = true
      }
    } catch (err: any) {
      log.warn('adding an untracked asset failed', { asset: asset.fileName, error: err })
    }
  }

  if (!staged) {
    log.info('no untracked content found, nothing to commit')
    return
  }

  // -> A bulk export has no single acting user behind it — same fallback-only situation `resolveAuthor`
  //    already handles for an asset rename/delete dispatch payload that carries no `authorId`.
  const author = await resolveAuthor(target, undefined)
  await git.commit('docs: add all untracked content', authorOption(author))
  log.info('all content is now tracked')
}

/** Every regular file under `dir`, relative to `root`, skipping `.git` and any other dotfile/dotdir (an inline SSH key included) and zero-byte files. */
async function walkFiles(root: string, dir: string = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const relPaths: string[] = []
  for (const entry of entries) {
    // -> Skips `.git`, this module's own `.wiki-ssh-key` (see `storage.ts`), `.gitignore`, etc. 2.5.x's
    //    own `importAll` only excludes `.git` by substring match, which would have walked its SSH key
    //    file straight into the DB as an "other" asset — a real bug, not something worth porting.
    if (entry.name.startsWith('.')) continue
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      relPaths.push(...(await walkFiles(root, absPath)))
      continue
    }
    if (!entry.isFile()) continue
    const stat = await fs.stat(absPath)
    if (stat.size < 1) continue
    relPaths.push(path.relative(root, absPath).split(path.sep).join('/'))
  }
  return relPaths
}

/**
 * `importAll` ("Import Everything"): the inverse full reconciliation — walk every matching file
 * currently in the repo's working tree, regardless of what git's commit history says, and upsert each
 * into the DB. For bootstrapping from a repo that already has content before this target ever ran a
 * `sync` (e.g. a pre-existing remote, manually cloned into `localRepoPath`).
 *
 * Reuses `sync.ts`'s `processDiffEntry` by constructing a synthetic `DiffEntry` per file: `exists:
 * true`, `oldPath` equal to `relPath`, no insertions/deletions. That shape is deliberate, not
 * incidental — `processPageEntry`/`processAssetEntry`'s rename and delete branches both key off
 * `relPath !== oldPath` or `!exists`, neither of which a synthetic entry ever satisfies, so every file
 * falls straight through to the plain "create or update" upsert, exactly what an unconditional import
 * needs and matching 2.5.x's own `importAll: true` flag through the same shared file processor.
 *
 * Does not pull from the remote — the working tree is taken exactly as it stands. `ensureRepo` still
 * runs first so a target that has never been used at all gets an initialized repo to walk.
 */
export async function importAll(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const { repoPath } = await ensureRepo(target)

  const actor = await resolveImportActor(target)
  if (!actor) {
    log.warn('no user matches the configured default author email, skipping the import')
    return
  }

  log.info('importing all content from the local repo')
  const relPaths = await walkFiles(repoPath)
  for (const relPath of relPaths) {
    const entry: DiffEntry = {
      relPath,
      oldPath: relPath,
      absPath: path.join(repoPath, relPath),
      exists: true,
      binary: false,
      insertions: 0,
      deletions: 0
    }
    try {
      await processDiffEntry(target, actor, entry)
    } catch (err: any) {
      log.warn('importing a file failed', { path: relPath, error: err })
    }
  }
  log.info('import completed', { files: relPaths.length })
}

/**
 * `purge` ("Purge Local Repository"): delete the contents of `localRepoPath` and re-run `ensureRepo`
 * to leave an empty, freshly-initialized repo. Explicitly local-only, matching the action's own hint
 * text in `definition.yml`: no commit, no push, no effect whatsoever on the remote — `ensureRepo` never
 * fetches or clones, it only inits and wires up config, so the result is an empty repo with `origin`
 * pointed at the configured remote and nothing pulled from it yet.
 *
 * Refuses to run if the configured path resolves to something that is clearly not this target's own
 * repo directory (`WIKI.ROOTPATH` itself, or a filesystem root) — `fs.rm` below is recursive, and a
 * blank or misconfigured `localRepoPath` must never be able to turn "purge the repo" into "purge the
 * install".
 */
export async function purge(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const repoPath = resolveRepoPath(target.config?.localRepoPath)
  const parsedRoot = path.parse(repoPath).root
  if (!repoPath || repoPath === WIKI.ROOTPATH || repoPath === parsedRoot) {
    throw new Error(
      `Refusing to purge "${repoPath}" — this does not look like a dedicated local repository path.`
    )
  }

  log.debug('purging the local repository', { path: repoPath })
  await fs.rm(repoPath, { recursive: true, force: true })
  await ensureRepo(target)
  log.info('local repository purged and reinitialized', { path: repoPath })
}
