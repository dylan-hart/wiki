/**
 * `syncUntracked`'s asset walk gates on `belongsInTarget` (`helpers/blobTarget.ts`) — the same
 * size-aware bucket classification `Storage.dispatch()` gates a write-path event on — and not on
 * `content.ts`'s kind-only `covers(target, assetBucket(...))`, which would silently skip (or wrongly
 * include) a "large" asset for a target covering `large` but not that asset's own kind bucket.
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

/** Staged but never committed here: `syncUntracked` commits everything it staged in one go. */
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
 * A one-way DB→repo export for content that predates git being enabled, or was created while it was
 * disabled. Never touches the remote — no pull, no push.
 *
 * Commits only when at least one file was actually staged: `git commit` with nothing staged is an
 * error, not a no-op.
 */
export async function syncUntracked(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const { git, repoPath } = await ensureRepo(target)
  let staged = false

  if (covers(target, 'pages')) {
    const pages = await CARDINAL.models.pages.listAllForSite(target.siteId)
    for (const page of pages) {
      try {
        const relPath = pageRelPath(target.siteId, page.locale, page.path, page.contentType)
        const full = await CARDINAL.models.pages.getPage({
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

  const assets = await CARDINAL.models.assets.listAllForSite(target.siteId)
  for (const asset of assets) {
    if (!belongsInTarget(asset, target.contentTypes)) continue
    try {
      const relPath = assetRelPath(asset.folderPath, asset.fileName)
      const content = await CARDINAL.models.assets.getContent(asset.id)
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

  // -> A bulk export has no single acting user behind it — the fallback-only case `resolveAuthor`
  //    already handles for a dispatch payload carrying no `authorId`.
  const author = await resolveAuthor(target, undefined)
  await git.commit('docs: add all untracked content', authorOption(author))
  log.info('all content is now tracked')
}

async function walkFiles(root: string, dir: string = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const relPaths: string[] = []
  for (const entry of entries) {
    // -> Every dotfile, not just `.git`: this module's own `.wiki-ssh-key` (see `storage.ts`) sits in
    //    the repo, and walking an inline SSH key into the DB as an "other" asset would leak it.
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
 * The inverse full reconciliation: every file in the working tree is upserted into the DB regardless
 * of what git's commit history says, for bootstrapping from a repo that already has content before
 * this target ever ran a `sync`.
 *
 * The synthetic `DiffEntry` per file is deliberate: `processPageEntry`/`processAssetEntry`'s rename
 * and delete branches key off `relPath !== oldPath` and `!exists`, so `oldPath: relPath` plus
 * `exists: true` falls straight through to the plain create-or-update upsert.
 *
 * Does not pull from the remote — the working tree is taken exactly as it stands.
 */
export async function importAll(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const { repoPath } = await ensureRepo(target)

  const actor = await resolveImportActor(target)

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
 * Local-only, matching the action's own hint text in `definition.yml`: no commit, no push, no effect
 * whatsoever on the remote — `ensureRepo` never fetches or clones, it only inits and wires up config.
 *
 * The refusal below is load-bearing: `fs.rm` is recursive, so a blank or misconfigured
 * `localRepoPath` must never be able to turn "purge the repo" into "purge the install".
 */
export async function purge(target: StorageTarget): Promise<void> {
  const log = gitLog(target)
  const repoPath = resolveRepoPath(target.config?.localRepoPath)
  const parsedRoot = path.parse(repoPath).root
  if (!repoPath || repoPath === CARDINAL.ROOTPATH || repoPath === parsedRoot) {
    throw new Error(
      `Refusing to purge "${repoPath}" — this does not look like a dedicated local repository path.`
    )
  }

  log.debug('purging the local repository', { path: repoPath })
  await fs.rm(repoPath, { recursive: true, force: true })
  const { git } = await ensureRepo(target)

  if (target.config?.repoUrl) {
    const branch = target.config?.branch || 'main'
    const heads = await git.listRemote(['--heads', 'origin', branch])
    const onRemote = heads
      .split('\n')
      .some((line) => line.trim().endsWith(`\trefs/heads/${branch}`))
    if (onRemote) {
      log.debug('re-cloning the local repository from origin', { branch })
      await git.pull('origin', branch)
      log.info('local repository purged and re-cloned from origin', { path: repoPath, branch })
      return
    }
    log.warn('the remote has no such branch to re-clone, leaving an empty repository', { branch })
  }
  log.info('local repository purged and reinitialized', { path: repoPath })
}
