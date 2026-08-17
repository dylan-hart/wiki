/**
 * Local Git storage module — repository lifecycle and auth wiring.
 *
 * `ensureRepo()` is what every future action handler in this module (push/pull/sync, imports,
 * purge) is expected to call before touching git: it guarantees the configured local path is an
 * initialized repository, on the configured branch, with an `origin` remote that matches the
 * target's current config and whatever auth (SSH key file, or basic-auth-embedded remote URL) that
 * config asks for — and returns a ready-to-use `simpleGit()` instance plus the resolved repo path
 * so a caller never has to re-derive either.
 *
 * The content-dispatch handlers (`created`/`updated`/`renamed`/`deleted`/`assetUploaded`/
 * `assetRenamed`/`assetDeleted`) live in `content.ts`; the `sync` action lives in `sync.ts`; the
 * remaining `syncUntracked`/`importAll`/`purge` actions live in `actions.ts`. All are re-exported onto
 * `gitStorageModule` below, and `ensureRepo` is what every one of them calls first.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
// -> Named import, not the default: TS7 resolves `simple-git`'s default export to the whole module
//    namespace object rather than the callable `SimpleGitFactory` it actually is (confirmed against
//    a minimal repro outside this codebase, so this is a quirk of the package's types under `tsc`'s
//    `nodenext` resolution, not something particular to this file). The named `simpleGit` export is
//    the same function and type-checks correctly.
import { simpleGit } from 'simple-git'
import type { SimpleGit, SimpleGitOptions } from 'simple-git'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'
import {
  assetDeleted,
  assetRenamed,
  assetUploaded,
  created,
  deleted,
  renamed,
  updated
} from './content.ts'
import { sync } from './sync.ts'
import { importAll, purge, syncUntracked } from './actions.ts'

/** Key of the `git` extension in `modules/extensions/`, used for the pre-flight detection check. */
const GIT_EXTENSION_KEY = 'git'

/** Filename the inline SSH private key is written under, inside the repo's own local path. */
const SSH_KEY_FILENAME = '.wiki-ssh-key'

export interface EnsuredRepo {
  /** A `simpleGit()` instance already pointed at the resolved repo path and configured binary. */
  git: SimpleGit
  /** The resolved, absolute local repository path. */
  repoPath: string
}

/** Resolve `config.localRepoPath` to an absolute path, relative to `WIKI.ROOTPATH` when not already one. */
export function resolveRepoPath(localRepoPath: string): string {
  return path.isAbsolute(localRepoPath) ? localRepoPath : path.join(WIKI.ROOTPATH, localRepoPath)
}

/** Whether `repoPath` already has a `.git` directory, i.e. is an initialized git working copy. */
async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoPath, '.git'))
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Confirm the `git` extension is detected before any git invocation.
 *
 * Detection itself lives in `WIKI.models.extensions` (PATH scanning for the `git` command) — this
 * only reads that result and turns a negative into a clear, actionable error instead of letting
 * simple-git fail later with an opaque "spawn git ENOENT".
 *
 * @throws If the `git` extension has no definition, or is not detected on this system.
 */
async function assertGitAvailable(): Promise<void> {
  const definition = WIKI.models.extensions.getDefinition(GIT_EXTENSION_KEY)
  if (!definition) {
    throw new Error('The git extension has no definition on disk — cannot verify it is available.')
  }
  if (!(await WIKI.models.extensions.isInstalled(definition))) {
    throw new Error(
      'The git extension is not detected on this system. Install a git binary (or set the Git Binary Path config) before using the Git storage target.'
    )
  }
}

/**
 * Write the inline private key to `<repoPath>/.wiki-ssh-key` with 0600 permissions.
 *
 * Always overwrites, even if a key file is already there — an inline key config that changes
 * between saves (a rotated key) must be reflected on disk on the next `ensureRepo()` call, not left
 * stale because a file happened to already exist at that path.
 */
async function writeInlineSshKey(repoPath: string, content: string): Promise<string> {
  const keyPath = path.join(repoPath, SSH_KEY_FILENAME)
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  await fs.writeFile(keyPath, normalized, { mode: 0o600 })
  // -> `writeFile`'s `mode` only applies when the file is created; rewriting an existing key must
  //    re-assert the permission explicitly rather than trust a mode set on a previous, possibly
  //    since-loosened, write.
  await fs.chmod(keyPath, 0o600)
  return keyPath
}

/**
 * The SSH key path this target's config should use — written fresh for `inline` mode, taken as-is
 * for `path` mode.
 */
async function resolveSshKeyPath(repoPath: string, config: Record<string, any>): Promise<string> {
  if (config.sshPrivateKeyMode === 'path') {
    return config.sshPrivateKeyPath
  }
  return writeInlineSshKey(repoPath, config.sshPrivateKeyContent ?? '')
}

/**
 * Embed `basicUsername`/`basicPassword` as URL credentials, matching how 2.5.x built the
 * authenticated remote URL for `authType: 'basic'`.
 */
export function buildAuthenticatedUrl(repoUrl: string, username: string, password: string): string {
  const url = new URL(repoUrl)
  url.username = encodeURI(username)
  url.password = encodeURI(password)
  return url.toString()
}

/** The remote URL `origin` should point at, given the target's auth config. */
function resolveRemoteUrl(config: Record<string, any>): string {
  if (config.authType === 'basic' && config.basicUsername) {
    return buildAuthenticatedUrl(config.repoUrl, config.basicUsername, config.basicPassword ?? '')
  }
  return config.repoUrl
}

/**
 * Add the `origin` remote if missing, or update its URL if it has changed since the last save —
 * never silently skip a URL change.
 */
async function ensureOrigin(git: SimpleGit, remoteUrl: string): Promise<void> {
  const remotes = await git.getRemotes(true)
  const origin = remotes.find((remote) => remote.name === 'origin')
  if (!origin) {
    await git.addRemote('origin', remoteUrl)
    return
  }
  if (origin.refs.fetch !== remoteUrl) {
    await git.remote(['set-url', 'origin', remoteUrl])
  }
}

/**
 * The branch HEAD currently points at, including an *unborn* one (a freshly-`init`ed repo with no
 * commits yet) — `git branch`/`branchLocal()` list nothing until the first commit exists, so they
 * cannot answer this for a brand new repo, but `symbolic-ref` still can.
 */
async function currentBranchName(git: SimpleGit): Promise<string> {
  try {
    return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
  } catch {
    // -> Detached HEAD, or some other state with no symbolic ref to read
    return ''
  }
}

/** Check out `branch`, creating it locally (from the current, possibly unborn, HEAD) if needed. */
async function ensureBranch(git: SimpleGit, branch: string): Promise<void> {
  if ((await currentBranchName(git)) === branch) {
    return
  }
  const summary = await git.branchLocal()
  if (summary.all.includes(branch)) {
    await git.checkout(branch)
  } else if (summary.all.length === 0) {
    // -> No commit exists anywhere in this repo yet, so there is no ref `checkoutLocalBranch` could
    //    branch off of — just repoint the still-unborn HEAD at the configured branch name instead.
    await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  } else {
    await git.checkoutLocalBranch(branch)
  }
}

/**
 * Ensure `target`'s local git repository exists, is initialized, has its `origin` remote and auth
 * wired up per its config, and is on the configured branch. Safe to call repeatedly — every step is
 * idempotent, and each re-derives from the current config rather than trusting anything left over
 * from a previous call (an origin URL or SSH key that changed since the last save is corrected, not
 * skipped).
 *
 * @throws If the `git` extension is not detected, or any git invocation fails.
 */
export async function ensureRepo(target: Pick<StorageTarget, 'config'>): Promise<EnsuredRepo> {
  const config = target.config ?? {}
  await assertGitAvailable()

  const repoPath = resolveRepoPath(config.localRepoPath)
  await fs.mkdir(repoPath, { recursive: true })

  const gitOptions: Partial<SimpleGitOptions> = {
    maxConcurrentProcesses: 1,
    // -> simple-git blocks `-c core.sshCommand=...` by default (it is a documented attack vector
    //    when the value comes from untrusted input). Here it is built entirely server-side from an
    //    admin-configured storage target, never from request input, so the vulnerability the guard
    //    exists for does not apply — the value is trusted the same way `repoUrl`/`branch` already are.
    unsafe: { allowUnsafeSshCommand: true }
  }
  if (config.gitBinaryPath) {
    gitOptions.binary = config.gitBinaryPath
  }
  const git = simpleGit(repoPath, gitOptions)

  // -> A directory that exists but isn't (yet) a git repo — including one left behind by a purge,
  //    or one that simply predates this target — is (re-)initialized rather than treated as an error.
  if (!(await isGitRepo(repoPath))) {
    await git.init()
  }

  await git.addConfig('http.sslVerify', config.verifySSL === false ? 'false' : 'true')

  // -> A commit always needs a committer identity, regardless of the `--author` override the
  //    write-path handlers pass per-commit (see `content.ts`) — git refuses to commit with neither
  //    set, and this must never depend on whatever happens to be in the host's global git config.
  await git.addConfig('user.name', config.defaultName || 'Wiki.js')
  await git.addConfig('user.email', config.defaultEmail || 'noreply@example.com')

  if (config.authType === 'ssh') {
    const keyPath = await resolveSshKeyPath(repoPath, config)
    await git.addConfig('core.sshCommand', `ssh -i ${keyPath} -o StrictHostKeyChecking=no`)
  }

  await ensureOrigin(git, resolveRemoteUrl(config))
  await ensureBranch(git, config.branch || 'main')

  return { git, repoPath }
}

const gitStorageModule: StorageModule = {
  ensureRepo,
  // -> Content-dispatch handlers (task 506) — see `content.ts` for the mapping and commit logic.
  //    Called as `handler(target, data)` by the `dispatchStorage` worker task, per `StorageModule`.
  created,
  updated,
  renamed,
  deleted,
  assetUploaded,
  assetRenamed,
  assetDeleted,
  // -> The `sync` action declared in `definition.yml` (task 507) — see `sync.ts`. Called as
  //    `handler(target)` by `Storage.executeAction()`, per `StorageModule`.
  sync,
  // -> The remaining `definition.yml` actions (task 508) — see `actions.ts`. Same `handler(target)`
  //    calling convention as `sync`.
  syncUntracked,
  importAll,
  purge
}

export default gitStorageModule
