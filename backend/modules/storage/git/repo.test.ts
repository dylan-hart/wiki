/**
 * Unit tests for `repo.ts` — the git storage module's repo lifecycle and auth wiring leaf.
 *
 * `resolveRepoPath`/`buildAuthenticatedUrl` are tested as pure functions with no `WIKI` global and
 * no I/O, made straightforward precisely because `repo.ts` has no sibling imports to stand in the
 * way. `ensureRepo` itself is not pure — it shells out to a real `git` binary via `simple-git`
 * against throwaway temp directories, since the behavior under test — init, remote add/update,
 * branch checkout, SSH config wiring — genuinely is that shelling-out, and a mock of `simple-git`
 * would mostly just be re-describing the code rather than verifying it. No `test/db.ts` fixture:
 * nothing here touches Postgres. `WIKI` is a minimal stub: only `ROOTPATH` and `models.extensions`
 * (git-detection) are read by this file.
 */
import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { ensureRepo, resolveRepoPath, buildAuthenticatedUrl } from './repo.ts'
import { installTestWiki } from '../../../test/mocks.ts'

/** Installs a `WIKI` stub with git detection reporting `installed`, and ROOTPATH under a temp dir. */
function installWiki(rootPath: string, { installed = true }: { installed?: boolean } = {}): void {
  installTestWiki({
    ROOTPATH: rootPath,
    models: {
      extensions: {
        getDefinition: mock.fn(() => ({ key: 'git', detect: { type: 'command', value: 'git' } })),
        isInstalled: mock.fn(async () => installed)
      }
    }
  })
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-storage-'))
}

function baseConfig(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    authType: 'ssh',
    repoUrl: 'https://example.com/org/repo.git',
    branch: 'main',
    localRepoPath: './repo',
    verifySSL: true,
    sshPrivateKeyMode: 'inline',
    sshPrivateKeyContent: 'FAKE-PRIVATE-KEY',
    ...overrides
  }
}

describe('git storage: resolveRepoPath', () => {
  test('resolves a relative path against WIKI.ROOTPATH', () => {
    installWiki('/srv/wiki')
    assert.equal(resolveRepoPath('./data/repo'), path.join('/srv/wiki', './data/repo'))
  })

  test('leaves an absolute path untouched', () => {
    installWiki('/srv/wiki')
    assert.equal(resolveRepoPath('/var/lib/wiki-repo'), '/var/lib/wiki-repo')
  })
})

describe('git storage: buildAuthenticatedUrl', () => {
  test('round-trips username and password as URL credentials', () => {
    const result = buildAuthenticatedUrl(
      'https://git.example.com/org/repo.git',
      'alice',
      'p@ss w/ord'
    )
    const parsed = new URL(result)
    assert.equal(parsed.hostname, 'git.example.com')
    assert.equal(parsed.pathname, '/org/repo.git')
    assert.equal(decodeURIComponent(parsed.username), 'alice')
    assert.equal(decodeURIComponent(parsed.password), 'p@ss w/ord')
  })

  test(
    'an @ in the password does not shift where the host is parsed from ' +
      '(OpenProject #823 item 1 — upstream #2646)',
    () => {
      // -> 2.5.x built this URL by string interpolation, so a password containing its own `@` (a
      //    real shape for a PAT or generated password) was read as ending the userinfo section
      //    early, and everything after it — including the *real* `@host` — was misparsed as part of
      //    the host/path instead. A password with two `@`s is the sharpest version of that.
      const result = buildAuthenticatedUrl(
        'https://git.example.com/org/repo.git',
        'svc-account',
        'tok@en@2026'
      )
      const parsed = new URL(result)
      assert.equal(parsed.hostname, 'git.example.com')
      assert.equal(parsed.pathname, '/org/repo.git')
      assert.equal(decodeURIComponent(parsed.password), 'tok@en@2026')
      // -> The raw string must not contain a bare, unencoded `@` inside the credentials portion —
      //    that is precisely what would let it be re-parsed as the userinfo/host separator by
      //    anything downstream (git itself included) that re-reads this URL as text.
      const credentials = result.slice('https://'.length, result.indexOf('@git.example.com'))
      assert.equal(credentials.includes('@'), false)
    }
  )
})

describe('git storage: ensureRepo', () => {
  let rootPath: string

  beforeEach(async () => {
    rootPath = await makeTempDir()
    installWiki(rootPath)
  })

  test('throws a clear error when the git extension is not detected', async () => {
    installWiki(rootPath, { installed: false })
    await assert.rejects(
      () => ensureRepo({ config: baseConfig() }),
      /git extension is not detected/
    )
  })

  test('creates the local repo directory and initializes git when none exists', async () => {
    const { repoPath } = await ensureRepo({ config: baseConfig() })
    const stat = await fs.stat(path.join(repoPath, '.git'))
    assert.ok(stat.isDirectory())
  })

  test('re-initializes rather than crashing when the directory exists but is not a git repo', async () => {
    const repoPath = path.join(rootPath, 'repo')
    await fs.mkdir(repoPath, { recursive: true })
    await fs.writeFile(path.join(repoPath, 'not-git-yet.txt'), 'hello')

    const result = await ensureRepo({ config: baseConfig() })
    const stat = await fs.stat(path.join(result.repoPath, '.git'))
    assert.ok(stat.isDirectory())
    // -> Pre-existing content is untouched by init
    await assert.doesNotReject(fs.access(path.join(result.repoPath, 'not-git-yet.txt')))
  })

  test('does not re-run init when a git repo already exists', async () => {
    await ensureRepo({ config: baseConfig() })
    // -> Second call must not throw or wipe the already-initialized repo
    const { repoPath } = await ensureRepo({ config: baseConfig() })
    const stat = await fs.stat(path.join(repoPath, '.git'))
    assert.ok(stat.isDirectory())
  })

  test('adds the origin remote pointing at repoUrl', async () => {
    const { git } = await ensureRepo({ config: baseConfig({ authType: 'basic' }) })
    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    assert.equal(origin?.refs.fetch, 'https://example.com/org/repo.git')
  })

  test('updates the origin remote when repoUrl changed since the last save', async () => {
    await ensureRepo({ config: baseConfig({ authType: 'basic' }) })
    const { git } = await ensureRepo({
      config: baseConfig({ authType: 'basic', repoUrl: 'https://example.com/org/other-repo.git' })
    })
    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    assert.equal(origin?.refs.fetch, 'https://example.com/org/other-repo.git')
  })

  test('embeds basic auth credentials into the origin remote url', async () => {
    const { git } = await ensureRepo({
      config: baseConfig({
        authType: 'basic',
        basicUsername: 'alice',
        basicPassword: 'secret123'
      })
    })
    const remotes = await git.getRemotes(true)
    const origin = remotes.find((r) => r.name === 'origin')
    assert.ok(origin?.refs.fetch.startsWith('https://alice:secret123@'))
  })

  test('creates and checks out the configured branch, even on a fresh empty repo', async () => {
    const { git } = await ensureRepo({ config: baseConfig({ branch: 'trunk', authType: 'basic' }) })
    // -> No commit exists yet on a fresh repo, so `branchLocal()` (which parses `git branch`) lists
    //    nothing at all — `symbolic-ref` is what actually answers "which branch is HEAD on" here.
    const current = (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
    assert.equal(current, 'trunk')
  })

  test('checks out an existing local branch rather than re-creating it', async () => {
    const first = await ensureRepo({ config: baseConfig({ branch: 'trunk', authType: 'basic' }) })
    // -> Give the branch a real commit, so the second call exercises the "ref already exists" path
    //    (`git.checkout`) rather than the still-unborn-HEAD path the first call took.
    await first.git.addConfig('user.email', 'test@example.com')
    await first.git.addConfig('user.name', 'Test')
    await fs.writeFile(path.join(first.repoPath, 'README.md'), 'hello')
    await first.git.add('README.md')
    await first.git.commit('initial commit')
    await first.git.checkoutLocalBranch('other')

    const { git } = await ensureRepo({ config: baseConfig({ branch: 'trunk', authType: 'basic' }) })
    const summary = await git.branchLocal()
    assert.equal(summary.current, 'trunk')
  })

  test('sets http.sslVerify=false when verifySSL is false', async () => {
    const { git } = await ensureRepo({
      config: baseConfig({ authType: 'basic', verifySSL: false })
    })
    const value = await git.raw(['config', 'http.sslVerify'])
    assert.equal(value.trim(), 'false')
  })

  test('writes the inline SSH private key with 0600 permissions and wires core.sshCommand', async () => {
    const { git, repoPath } = await ensureRepo({
      config: baseConfig({ sshPrivateKeyMode: 'inline', sshPrivateKeyContent: 'INLINE-KEY-A' })
    })
    const keyPath = path.join(repoPath, '.wiki-ssh-key')
    const content = await fs.readFile(keyPath, 'utf8')
    assert.equal(content, 'INLINE-KEY-A\n')

    const stat = await fs.stat(keyPath)
    assert.equal(stat.mode & 0o777, 0o600)

    const sshCommand = (await git.raw(['config', 'core.sshCommand'])).trim()
    assert.ok(sshCommand.includes(`-i ${keyPath}`))
    assert.ok(sshCommand.includes('-o StrictHostKeyChecking=no'))
  })

  test('rewrites the inline SSH key file when its content is rotated', async () => {
    const first = await ensureRepo({
      config: baseConfig({ sshPrivateKeyMode: 'inline', sshPrivateKeyContent: 'INLINE-KEY-A' })
    })
    const keyPath = path.join(first.repoPath, '.wiki-ssh-key')
    assert.equal(await fs.readFile(keyPath, 'utf8'), 'INLINE-KEY-A\n')

    await ensureRepo({
      config: baseConfig({ sshPrivateKeyMode: 'inline', sshPrivateKeyContent: 'INLINE-KEY-B' })
    })
    assert.equal(await fs.readFile(keyPath, 'utf8'), 'INLINE-KEY-B\n')
  })

  test('points core.sshCommand at sshPrivateKeyPath in path mode without writing a key file', async () => {
    const { git, repoPath } = await ensureRepo({
      config: baseConfig({
        sshPrivateKeyMode: 'path',
        sshPrivateKeyPath: '/etc/wiki/keys/id_ed25519',
        sshPrivateKeyContent: undefined
      })
    })
    const sshCommand = (await git.raw(['config', 'core.sshCommand'])).trim()
    assert.ok(sshCommand.includes('-i /etc/wiki/keys/id_ed25519'))
    await assert.rejects(fs.access(path.join(repoPath, '.wiki-ssh-key')))
  })

  test(
    'honors a custom SSH port embedded in the repository URL (OpenProject #823 item 2 — ' +
      'upstream #2564, "custom SSH port setting silently ignored")',
    async () => {
      // -> This fork's `definition.yml` has no separate "SSH Port" prop at all: `repoUrl` is a
      //    "Git-compliant URI", and `ssh://host:port/...` is exactly how one embeds a non-default
      //    port. The regression this guards is that `core.sshCommand` (`-i <key> -o
      //    StrictHostKeyChecking=no`) must not clobber or ignore that port — git appends its own
      //    `-p <port>` when invoking a command it recognizes as the real `ssh` binary, but only for
      //    the "ssh" variant, not the fallback "simple" variant it assumes for anything not
      //    literally named `ssh`/`plink`/`tortoiseplink`. `ensureRepo()`'s `core.sshCommand` starts
      //    with literal `ssh`, so it gets the real-variant treatment.
      const { git } = await ensureRepo({
        config: baseConfig({
          authType: 'ssh',
          repoUrl: 'ssh://git@127.0.0.1:59999/org/repo.git',
          sshPrivateKeyMode: 'inline',
          sshPrivateKeyContent: 'FAKE-PRIVATE-KEY'
        })
      })
      // -> Nothing listens on this port, so the attempt fails fast — the point is *which* port ssh
      //    reports trying, not a successful connection.
      await assert.rejects(git.listRemote(['origin']), /59999/)
    }
  )

  test('passes gitBinaryPath through to simple-git as the binary option', async () => {
    const { repoPath } = await ensureRepo({
      config: baseConfig({ authType: 'basic', gitBinaryPath: 'git' })
    })
    // -> `binary: 'git'` still has to resolve and run correctly — proves the option is honored
    //    rather than silently ignored, without depending on a fake non-PATH binary being present.
    const check = simpleGit(repoPath)
    assert.ok(await check.checkIsRepo())
  })
})
