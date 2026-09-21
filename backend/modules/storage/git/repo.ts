/**
 * Imports nothing from its siblings (`storage.ts`, `content.ts`, `sync.ts`, `actions.ts`) so all
 * four can take `ensureRepo`/`resolveRepoPath` from this one leaf without forming an import cycle
 * among themselves.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
// -> Named import, not the default: under `nodenext` resolution TS7 resolves `simple-git`'s default
//    export to the module namespace object rather than the callable `SimpleGitFactory` it actually
//    is. The named `simpleGit` export is the same function and type-checks correctly.
import { simpleGit } from 'simple-git'
import type { SimpleGit, SimpleGitOptions } from 'simple-git'
import type { StorageTarget } from '../../../models/storage.ts'
import type { ScopedLogger } from '../../../core/logger.ts'

/**
 * Built per call rather than once at import time: `CARDINAL` does not exist yet when this module is
 * loaded, and a target's identity is per-invocation anyway.
 */
export function gitLog(target: StorageTarget): ScopedLogger {
  return CARDINAL.logger.scope('storage', { module: 'git', target: target.id })
}

const GIT_EXTENSION_KEY = 'git'

const SSH_KEY_FILENAME = '.wiki-ssh-key'

export interface EnsuredRepo {
  git: SimpleGit
  repoPath: string
}

export function resolveRepoPath(localRepoPath: string): string {
  return path.isAbsolute(localRepoPath)
    ? localRepoPath
    : path.join(CARDINAL.ROOTPATH, localRepoPath)
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoPath, '.git'))
    return stat.isDirectory()
  } catch {
    return false
  }
}

/**
 * Turns a missing git binary into an actionable error up front, instead of letting simple-git fail
 * later with an opaque "spawn git ENOENT".
 */
async function assertGitAvailable(): Promise<void> {
  const definition = CARDINAL.models.extensions.getDefinition(GIT_EXTENSION_KEY)
  if (!definition) {
    throw new Error('The git extension has no definition on disk — cannot verify it is available.')
  }
  if (!(await CARDINAL.models.extensions.isInstalled(definition))) {
    throw new Error(
      'The git extension is not detected on this system. Install a git binary (or set the Git Binary Path config) before using the Git storage target.'
    )
  }
}

/**
 * Always overwrites: a rotated inline key must reach disk on the next `ensureRepo()` call, not be
 * left stale because a file happened to already exist at that path.
 */
async function writeInlineSshKey(repoPath: string, content: string): Promise<string> {
  const keyPath = path.join(repoPath, SSH_KEY_FILENAME)
  const normalized = content.endsWith('\n') ? content : `${content}\n`
  await fs.writeFile(keyPath, normalized, { mode: 0o600 })
  // -> `writeFile`'s `mode` only applies when the file is created, so rewriting an existing key has
  //    to re-assert the permission rather than trust a possibly since-loosened earlier mode.
  await fs.chmod(keyPath, 0o600)
  return keyPath
}

async function resolveSshKeyPath(repoPath: string, config: Record<string, any>): Promise<string> {
  if (config.sshPrivateKeyMode === 'path') {
    return config.sshPrivateKeyPath
  }
  return writeInlineSshKey(repoPath, config.sshPrivateKeyContent ?? '')
}

/**
 * `new URL()`'s `username`/`password` setters percent-encode per the userinfo encode set on
 * assignment, so a credential containing `@`, `:`, `/` or `#` cannot shift where the userinfo
 * section ends and silently retarget the host — which naive `user:pass@host` interpolation does.
 * `encodeURI()` is therefore redundant with the setters, kept only as defense in depth should that
 * setter behavior ever change.
 */
export function buildAuthenticatedUrl(repoUrl: string, username: string, password: string): string {
  const url = new URL(repoUrl)
  url.username = encodeURI(username)
  url.password = encodeURI(password)
  return url.toString()
}

function resolveRemoteUrl(config: Record<string, any>): string {
  if (config.authType === 'basic' && config.basicUsername) {
    return buildAuthenticatedUrl(config.repoUrl, config.basicUsername, config.basicPassword ?? '')
  }
  return config.repoUrl
}

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
 * `symbolic-ref` rather than `branchLocal()`: the latter lists nothing until the first commit
 * exists, so it cannot report an *unborn* branch in a freshly-`init`ed repo.
 */
async function currentBranchName(git: SimpleGit): Promise<string> {
  try {
    return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
  } catch {
    // -> Detached HEAD, or some other state with no symbolic ref to read
    return ''
  }
}

async function ensureBranch(git: SimpleGit, branch: string): Promise<void> {
  if ((await currentBranchName(git)) === branch) {
    return
  }
  const summary = await git.branchLocal()
  if (summary.all.includes(branch)) {
    await git.checkout(branch)
  } else if (summary.all.length === 0) {
    // -> No commit exists yet, so there is no ref `checkoutLocalBranch` could branch off of —
    //    repoint the still-unborn HEAD at the configured branch name instead.
    await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  } else {
    await git.checkoutLocalBranch(branch)
  }
}

/**
 * Runs in `ensureRepo` before `ensureBranch`: `git checkout` refuses to move a branch while the
 * index is unmerged, so a stale rebase would fail `ensureRepo` itself before a later step could
 * clean it up.
 */
export async function abortInterruptedRebase(git: SimpleGit, log: ScopedLogger): Promise<boolean> {
  const gitDir = (await git.revparse(['--absolute-git-dir'])).trim()
  const exists = (name: string) =>
    fs.stat(path.join(gitDir, name)).then(
      () => true,
      () => false
    )
  if (!(await exists('rebase-merge')) && !(await exists('rebase-apply'))) {
    return false
  }
  log.warn('rolling back an unfinished rebase left by an earlier sync')
  await git.raw(['rebase', '--abort'])
  return true
}

export interface EnsureRepoOptions {
  // -> Opt-in so a content-commit caller never rolls back a rebase an administrator is in the
  //    middle of.
  abortInterrupted?: ScopedLogger
}

/**
 * Safe to call repeatedly: every step is idempotent and re-derives from the current config rather
 * than trusting a previous call, so an origin URL or SSH key changed since the last save is
 * corrected rather than skipped.
 */
export async function ensureRepo(
  target: Pick<StorageTarget, 'config'>,
  options: EnsureRepoOptions = {}
): Promise<EnsuredRepo> {
  const config = target.config ?? {}
  await assertGitAvailable()

  const repoPath = resolveRepoPath(config.localRepoPath)
  await fs.mkdir(repoPath, { recursive: true })

  const gitOptions: Partial<SimpleGitOptions> = {
    maxConcurrentProcesses: 1,
    // -> simple-git blocks `-c core.sshCommand=...` by default, since it is an attack vector when
    //    the value comes from untrusted input. Here it is built server-side from an
    //    admin-configured storage target and never from request input, the same trust level
    //    `repoUrl`/`branch` already carry.
    unsafe: { allowUnsafeSshCommand: true }
  }
  if (config.gitBinaryPath) {
    gitOptions.binary = config.gitBinaryPath
  }
  const git = simpleGit(repoPath, gitOptions)

  // -> A directory that exists but isn't a git repo — left behind by a purge, or simply predating
  //    this target — is (re-)initialized rather than treated as an error.
  if (!(await isGitRepo(repoPath))) {
    await git.init()
  }

  if (options.abortInterrupted) {
    await abortInterruptedRebase(git, options.abortInterrupted)
  }

  await git.addConfig('http.sslVerify', config.verifySSL === false ? 'false' : 'true')

  // -> git refuses to commit with no committer identity, regardless of the per-commit `--author`
  //    override `content.ts` passes, and this must not depend on the host's global git config.
  await git.addConfig('user.name', config.defaultName || 'Cardinal.js')
  await git.addConfig('user.email', config.defaultEmail || 'noreply@example.com')

  if (config.authType === 'ssh') {
    const keyPath = await resolveSshKeyPath(repoPath, config)
    // -> No `-p <port>`, and no "SSH Port" config prop: a non-default port belongs in `repoUrl`
    //    (`ssh://host:port/...`), and git derives `-p` from that itself when invoking
    //    `core.sshCommand`. That only holds because the command starts with the literal binary name
    //    `ssh` — git appends `-p` for the recognized `ssh`/`plink`/`tortoiseplink` variants only,
    //    and falls back to a `-p`-less "simple" variant for anything else.
    await git.addConfig('core.sshCommand', `ssh -i ${keyPath} -o StrictHostKeyChecking=no`)
  }

  await ensureOrigin(git, resolveRemoteUrl(config))
  await ensureBranch(git, config.branch || 'main')

  return { git, repoPath }
}
