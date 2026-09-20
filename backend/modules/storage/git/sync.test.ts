/**
 * Real `git` binaries via `simple-git` against throwaway temp directories: a bare repo standing in
 * for "origin", one working copy playing this target's own local repo and one playing an outside
 * collaborator. No Postgres — what is under test is which `CARDINAL.models.*` call `sync()` decides to
 * make for a given remote change, which a stub records precisely and a real DB would only obscure.
 */
import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { sync, parseRenamedPaths, parseLocaleAndPath, processDiffEntry } from './sync.ts'
import { ensureRepo } from './repo.ts'
import { generatePathHash } from '../../../helpers/common.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'

const SITE_ID = 'site-1'
const PRIMARY_LOCALE = 'en'
const ADMIN_EMAIL = 'admin@example.com'

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function installWiki(
  rootPath: string,
  {
    pages = [],
    assets = []
  }: {
    pages?: Array<{ id: string; path: string; locale: string; contentType: string }>
    assets?: Array<{ id: string; folderPath: string; fileName: string }>
  } = {}
) {
  const calls = {
    createPage: [] as any[],
    updatePage: [] as any[],
    movePage: [] as any[],
    deletePage: [] as any[],
    renameAsset: [] as any[],
    deleteAsset: [] as any[],
    upload: [] as any[]
  }

  installTestWiki({
    ROOTPATH: rootPath,
    sites: {
      [SITE_ID]: {
        config: { locales: { primary: PRIMARY_LOCALE, active: [PRIMARY_LOCALE, 'fr'] } }
      }
    },
    models: {
      extensions: {
        getDefinition: mock.fn(() => ({ key: 'git', detect: { type: 'command', value: 'git' } })),
        isInstalled: mock.fn(async () => true)
      },
      users: {
        getByEmail: mock.fn(async (email: string) =>
          email === ADMIN_EMAIL ? { id: 'admin-1', email } : null
        )
      },
      pages: {
        getPage: mock.fn(async ({ hash, locale }: { hash: string; locale: string }) => {
          const found = pages.find((p) => generatePathHash(p.path) === hash && p.locale === locale)
          return found ? { ...found } : null
        }),
        listAllForSite: mock.fn(async () => pages.map((p) => ({ ...p }))),
        createPage: mock.fn(async (siteId: string, input: any, actor: any) => {
          calls.createPage.push({ siteId, input, actor })
          return { id: 'new-page', ...input }
        }),
        updatePage: mock.fn(async (siteId: string, id: string, patch: any, actor: any) => {
          calls.updatePage.push({ siteId, id, patch, actor })
          return { id }
        }),
        movePage: mock.fn(async (siteId: string, id: string, patch: any, actor: any) => {
          calls.movePage.push({ siteId, id, patch, actor })
          return { id }
        }),
        deletePage: mock.fn(async (siteId: string, id: string, actor: any) => {
          calls.deletePage.push({ siteId, id, actor })
          return true
        })
      },
      assets: {
        getAssetByPath: mock.fn(async (siteId: string, filePath: string) => {
          const segments = filePath.split('/').filter(Boolean)
          const fileName = segments.pop()
          const folderPath = segments.join('/')
          const found = assets.find((a) => a.folderPath === folderPath && a.fileName === fileName)
          return found ? { ...found } : null
        }),
        renameAsset: mock.fn(async (siteId: string, id: string, fileName: string) => {
          calls.renameAsset.push({ siteId, id, fileName })
          return { id }
        }),
        deleteAsset: mock.fn(async (siteId: string, id: string) => {
          calls.deleteAsset.push({ siteId, id })
          return true
        }),
        upload: mock.fn(async (opts: any) => {
          calls.upload.push(opts)
          return { id: 'new-asset' }
        })
      },
      tree: {
        getFolder: mock.fn(async ({ path: folderPath }: { path: string }) => ({
          id: `folder:${folderPath}`
        }))
      }
    }
  })

  return calls
}

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return makeStorageTarget('git', {
    id: 'target-1',
    siteId: SITE_ID,
    title: 'Local Git',
    contentTypes: {
      activeTypes: ['pages', 'images', 'documents', 'others', 'large'],
      largeThreshold: '5MB'
    },
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: false,
      streaming: true,
      directAccess: false
    },
    versioning: { isSupported: true, isForceEnabled: true, enabled: true },
    sync: {
      supportedModes: ['sync', 'push', 'pull'],
      schedule: false,
      mode: 'sync',
      scheduleOverride: null
    },
    config: {
      authType: 'basic',
      branch: 'main',
      verifySSL: true,
      defaultName: 'Fallback Name',
      defaultEmail: ADMIN_EMAIL
    },
    ...overrides
  })
}

/**
 * Git-config overrides for one fixture repo's own `git` invocations, injected as
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` rather than written to any config file
 * something else could read. Git applies these with `-c` precedence, so they beat the developer's
 * own `~/.gitconfig` without touching anything outside the child process.
 */
type GitConfigEnv = Record<string, string>

function ambientInitBranchEnv(branch: string): GitConfigEnv {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'init.defaultBranch',
    GIT_CONFIG_VALUE_0: branch
  }
}

/**
 * An ALLOWLIST, not a deny list: simple-git refuses a whole vocabulary of variables outright — not
 * only the `GIT_*` ones but `EDITOR`, `PAGER`, `PREFIX` and `SSH_ASKPASS` too — throwing
 * `Use of "X" is not permitted without enabling allowUnsafeX` before git even runs, and a stock
 * GitHub Actions runner exports `EDITOR`. Naming what git needs means a variable added to that
 * refusal table later cannot break this suite. `PATH` is the load-bearing entry: without it git
 * survives only on `execvp`'s `/usr/bin:/bin` fallback. No author identity is inherited — every
 * fixture repo sets `user.name`/`user.email` explicitly.
 */
const AMBIENT_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA'
] as const

/**
 * `.env()` REPLACES the spawned child's whole environment rather than merging into it, so
 * `AMBIENT_ENV_KEYS` is laid back underneath the overrides. Dropping every ambient `GIT_*` falls out
 * of that and is wanted anyway: a `GIT_DIR` or `GIT_CONFIG_COUNT` already in the developer's shell
 * cannot then fight the overrides. `allowUnsafeConfigEnvCount` is simple-git's opt-in for passing
 * `GIT_CONFIG_COUNT` at all; the values here are literals in this file, never request input.
 */
function fixtureGit(repoPath: string, env?: GitConfigEnv): ReturnType<typeof simpleGit> {
  if (!env) {
    return simpleGit(repoPath)
  }
  const ambient: Record<string, string> = {}
  for (const key of AMBIENT_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) {
      ambient[key] = value
    }
  }
  return simpleGit(repoPath, { unsafe: { allowUnsafeConfigEnvCount: true } }).env({
    ...ambient,
    ...env
  })
}

/**
 * `env` exists for this file's own fixture regression tests, which re-run this helper against a
 * hostile ambient `init.defaultBranch`; every real test leaves it unset.
 */
async function makeOrigin(env?: GitConfigEnv): Promise<{ originPath: string; seedPath: string }> {
  const originPath = await makeTempDir('wiki-git-sync-origin-')
  // -> The bare origin's advertised HEAD is what `makePeer()`'s plain `clone()` follows. Left to
  //    the ambient default it names a branch that never gets created (only the seed's push below
  //    creates one), so a peer clone lands on an unborn, wrong-named local branch.
  await fixtureGit(originPath, env).init(true, ['--initial-branch=main'])

  const seedPath = await makeTempDir('wiki-git-sync-seed-')
  const seed = fixtureGit(seedPath, env)
  // -> Every later `push`/`pull` in this file names `main` literally, while a bare `init()` defers
  //    to the binary's compiled-in default, which is not guaranteed to match across machines or CI
  //    images. Naming it here is what makes those calls environment-independent.
  await seed.init(false, ['--initial-branch=main'])
  await seed.addConfig('user.name', 'Seed')
  await seed.addConfig('user.email', 'seed@example.com')
  await fs.writeFile(path.join(seedPath, '.keep'), '')
  await seed.add('.keep')
  await seed.commit('initial')
  await seed.addRemote('origin', originPath)
  await seed.push('origin', 'main')

  return { originPath, seedPath }
}

async function makePeer(
  originPath: string,
  env?: GitConfigEnv
): Promise<{ peerPath: string; peer: ReturnType<typeof simpleGit> }> {
  const peerPath = await makeTempDir('wiki-git-sync-peer-')
  const peer = fixtureGit(peerPath, env)
  await peer.clone(originPath, '.')
  await peer.addConfig('user.name', 'Peer')
  await peer.addConfig('user.email', 'peer@example.com')
  return { peerPath, peer }
}

/** `symbolic-ref` because it answers for an unborn branch too, which `branchLocal()` cannot. */
async function headBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  return (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
}

/**
 * Guards both fixture helpers against assuming the branch a bare `git init` produces is named
 * `main`, which is a property of the machine's config rather than of git. They drive the REAL
 * `makeOrigin()`/`makePeer()` rather than an inline copy of their bodies: the first attempt at this
 * guard was such a copy, and it drifted from the helpers it was protecting and sat green beside a
 * red CI.
 */
describe('git storage: sync test fixtures', () => {
  // -> Not `master`: a name neither git nor this repo would ever pick by accident, so a passing
  //    assertion below cannot be the ambient default coincidentally agreeing with the fixture.
  const hostileEnv = ambientInitBranchEnv('trunk')

  test('the hostile-default control: git really does honor the injected init.defaultBranch', async () => {
    // -> Precondition for every assertion in this describe: if the env injection silently stopped
    //    applying, the tests below would keep passing while testing nothing at all.
    const controlPath = await makeTempDir('wiki-git-sync-control-')
    await fixtureGit(controlPath, hostileEnv).init()
    assert.equal(await headBranch(fixtureGit(controlPath, hostileEnv)), 'trunk')
  })

  test("makeOrigin() pins the seed working copy to `main` regardless of the git binary's own default", async () => {
    const { seedPath } = await makeOrigin(hostileEnv)
    assert.equal(await headBranch(fixtureGit(seedPath, hostileEnv)), 'main')
  })

  test("makeOrigin() pins the bare origin's advertised HEAD to `main`, and the seed push really lands there", async () => {
    const { originPath } = await makeOrigin(hostileEnv)
    const origin = fixtureGit(originPath, hostileEnv)
    // -> The advertised HEAD is what a plain `git clone` of this path checks out.
    assert.equal(await headBranch(origin), 'main')
    // -> ...and `main` must be a branch that actually exists, not just the one HEAD names:
    //    `seed.push('origin', 'main')` is the only thing that ever creates a ref in this repo, so
    //    this also asserts that push did not silently fail.
    assert.deepEqual((await origin.branchLocal()).all, ['main'])
  })

  test('makePeer() clones onto `main` with the seed commit checked out', async () => {
    const { originPath } = await makeOrigin(hostileEnv)
    const { peer } = await makePeer(originPath, hostileEnv)
    assert.equal(await headBranch(peer), 'main')
    // -> A clone that followed a wrong-named advertised HEAD still "succeeds", just with an unborn
    //    branch and an empty working copy, so the checked-out commit is the real proof.
    assert.equal((await peer.log()).latest?.message, 'initial')
  })
})

describe('git storage: parseRenamedPaths', () => {
  test('a plain, unrenamed path matches neither half of the pattern', () => {
    assert.deepEqual(parseRenamedPaths('docs/foo.md'), {
      oldPath: 'docs/foo.md',
      newPath: 'docs/foo.md'
    })
  })

  test('a whole-path rename', () => {
    assert.deepEqual(parseRenamedPaths('docs/old.md => docs/new.md'), {
      oldPath: 'docs/old.md',
      newPath: 'docs/new.md'
    })
  })

  test("a rename confined to part of the path, in git's brace notation", () => {
    assert.deepEqual(parseRenamedPaths('docs/{old => new}/page.md'), {
      oldPath: 'docs/old/page.md',
      newPath: 'docs/new/page.md'
    })
  })
})

describe('git storage: parseLocaleAndPath', () => {
  test('a two-letter folder that is not an active locale stays a folder path', () => {
    installTestWiki({
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } }
    })
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'it/setup'), { locale: 'en', path: 'it/setup' })
  })

  test('an active locale folder is recognized case-preservingly', () => {
    installTestWiki({
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'pt-BR'] } } } }
    })
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'pt-BR/intro'), { locale: 'pt-BR', path: 'intro' })
    // -> A mis-cased folder still resolves to the code AS STORED, never a lowercased twin.
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'pt-br/intro'), { locale: 'pt-BR', path: 'intro' })
  })

  test('a file named after a locale code at the root is a primary-locale page, not an empty path', () => {
    installTestWiki({
      sites: { [SITE_ID]: { config: { locales: { primary: 'en', active: ['en', 'fr'] } } } }
    })
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'fr'), { locale: 'en', path: 'fr' })
  })
})

describe('git storage: parseLocaleAndPath with a locale URL alias', () => {
  beforeEach(() => {
    installTestWiki({
      sites: {
        [SITE_ID]: {
          config: {
            locales: { primary: 'en', active: ['en', 'zh-CN'], aliases: { 'zh-CN': 'zh' } }
          }
        }
      }
    })
  })

  test('a repo folder named by the alias parses to the canonical locale', () => {
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'zh/intro'), { locale: 'zh-CN', path: 'intro' })
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'ZH/intro'), { locale: 'zh-CN', path: 'intro' })
  })

  test('a repo folder named by the canonical code still parses, so an existing layout keeps importing', () => {
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'zh-CN/intro'), {
      locale: 'zh-CN',
      path: 'intro'
    })
  })

  test('a file named after the alias at the root is a primary-locale page, not an empty path', () => {
    assert.deepEqual(parseLocaleAndPath(SITE_ID, 'zh'), { locale: 'en', path: 'zh' })
  })
})

describe('git storage: sync', () => {
  let originPath: string
  let localPath: string
  let target: StorageTarget

  beforeEach(async () => {
    const origin = await makeOrigin()
    originPath = origin.originPath
    localPath = await makeTempDir('wiki-git-sync-local-')
    target = makeTarget({
      config: {
        ...makeTarget().config,
        repoUrl: originPath,
        localRepoPath: path.join(localPath, 'repo')
      }
    })
  })

  test('pulls a page a peer created and creates it in the DB', async () => {
    installWiki(localPath, { pages: [] })
    // -> At least one commit must already be pulled: `sync()` deliberately leaves a repo with no
    //    prior local commits to the separate `importAll` action.
    const { git: localGit } = await ensureRepo(target)
    await localGit.pull('origin', 'main')

    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'welcome.md'), '# Hello there')
    await peer.add('welcome.md')
    await peer.commit('docs: create welcome')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, { pages: [] })
    await sync(target)

    assert.equal(calls.createPage.length, 1)
    assert.equal(calls.createPage[0].input.path, 'welcome')
    assert.equal(calls.createPage[0].input.content, '# Hello there')
    assert.equal(calls.createPage[0].input.editor, 'markdown')
    assert.equal(calls.createPage[0].actor.id, 'admin-1')
  })

  test('pulls an update to a page already tracked in the DB', async () => {
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'welcome.md'), 'v1 content')
    await peer.add('welcome.md')
    await peer.commit('docs: create welcome')
    await peer.push('origin', 'main')

    installWiki(localPath, {
      pages: [{ id: 'p1', path: 'welcome', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    const { git: localGit } = await ensureRepo(target)
    await localGit.pull('origin', 'main')

    await fs.writeFile(path.join(peerPath, 'welcome.md'), 'v2 content')
    await peer.add('welcome.md')
    await peer.commit('docs: update welcome')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, {
      pages: [{ id: 'p1', path: 'welcome', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    await sync(target)

    assert.equal(calls.updatePage.length, 1)
    assert.equal(calls.updatePage[0].id, 'p1')
    assert.equal(calls.updatePage[0].patch.content, 'v2 content')
  })

  test('pulls a page rename and moves it in the DB', async () => {
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'old-name.md'), 'body')
    await peer.add('old-name.md')
    await peer.commit('docs: create old-name')
    await peer.push('origin', 'main')

    installWiki(localPath, {
      pages: [{ id: 'p1', path: 'old-name', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    await ensureRepo(target)
    const localGit = simpleGit(target.config.localRepoPath)
    await localGit.pull('origin', 'main')

    await peer.mv('old-name.md', 'new-name.md')
    await peer.commit('docs: rename old-name to new-name')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, {
      pages: [{ id: 'p1', path: 'old-name', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    await sync(target)

    assert.equal(calls.movePage.length, 1)
    assert.equal(calls.movePage[0].id, 'p1')
    assert.equal(calls.movePage[0].patch.path, 'new-name')
    assert.equal(calls.movePage[0].patch.locale, PRIMARY_LOCALE)
    assert.equal(calls.createPage.length, 0)
  })

  test('pulls a cross-locale rename and moves the page into the destination locale', async () => {
    const { peer, peerPath } = await makePeer(originPath)
    await fs.mkdir(path.join(peerPath, 'fr'), { recursive: true })
    await fs.writeFile(path.join(peerPath, 'fr/guide.md'), 'body')
    await peer.add('fr/guide.md')
    await peer.commit('docs: create fr/guide')
    await peer.push('origin', 'main')

    installWiki(localPath, {
      pages: [{ id: 'p1', path: 'guide', locale: 'fr', contentType: 'markdown' }]
    })
    await ensureRepo(target)
    const localGit = simpleGit(target.config.localRepoPath)
    await localGit.pull('origin', 'main')

    // -> The path within the locale is unchanged and only the locale directory moves, so a move
    //    carrying the path alone would be a no-op that silently left the page in `fr`.
    await peer.mv('fr/guide.md', 'guide.md')
    await peer.commit('docs: translate guide into the primary locale')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, {
      pages: [{ id: 'p1', path: 'guide', locale: 'fr', contentType: 'markdown' }]
    })
    await sync(target)

    assert.equal(calls.movePage.length, 1)
    assert.equal(calls.movePage[0].id, 'p1')
    assert.equal(calls.movePage[0].patch.path, 'guide')
    assert.equal(calls.movePage[0].patch.locale, PRIMARY_LOCALE)
    assert.equal(calls.createPage.length, 0)
  })

  test(
    'pulls a whole-folder rename (multiple pages) and moves each one in the DB ' +
      '(OpenProject #823 item 3 — upstream #2817, "folder renames don\'t sync via Force Sync")',
    async () => {
      const { peer, peerPath } = await makePeer(originPath)
      await fs.mkdir(path.join(peerPath, 'docs/guide'), { recursive: true })
      await fs.writeFile(path.join(peerPath, 'docs/guide/one.md'), 'body one')
      await fs.writeFile(path.join(peerPath, 'docs/guide/two.md'), 'body two')
      await peer.add(['docs/guide/one.md', 'docs/guide/two.md'])
      await peer.commit('docs: create guide folder')
      await peer.push('origin', 'main')

      installWiki(localPath, {
        pages: [
          { id: 'p1', path: 'docs/guide/one', locale: PRIMARY_LOCALE, contentType: 'markdown' },
          { id: 'p2', path: 'docs/guide/two', locale: PRIMARY_LOCALE, contentType: 'markdown' }
        ]
      })
      await ensureRepo(target)
      const localGit = simpleGit(target.config.localRepoPath)
      await localGit.pull('origin', 'main')

      // -> A directory rename, not two individual file renames: git has no first-class notion of a
      //    folder move, so this is what produces the `dir/{old => new}/rest` diff shape
      //    `parseRenamedPaths` exists to parse.
      await peer.mv('docs/guide', 'docs/handbook')
      await peer.commit('docs: rename guide to handbook')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, {
        pages: [
          { id: 'p1', path: 'docs/guide/one', locale: PRIMARY_LOCALE, contentType: 'markdown' },
          { id: 'p2', path: 'docs/guide/two', locale: PRIMARY_LOCALE, contentType: 'markdown' }
        ]
      })
      await sync(target)

      assert.equal(calls.movePage.length, 2)
      const moved = calls.movePage
        .map((c: any) => ({ id: c.id, path: c.patch.path }))
        .sort((a, b) => a.id.localeCompare(b.id))
      assert.deepEqual(moved, [
        { id: 'p1', path: 'docs/handbook/one' },
        { id: 'p2', path: 'docs/handbook/two' }
      ])
      assert.equal(calls.createPage.length, 0)
    }
  )

  test('pulls a page deletion and deletes it in the DB', async () => {
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'doomed.md'), 'body')
    await peer.add('doomed.md')
    await peer.commit('docs: create doomed')
    await peer.push('origin', 'main')

    installWiki(localPath, {
      pages: [{ id: 'p1', path: 'doomed', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    await ensureRepo(target)
    const localGit = simpleGit(target.config.localRepoPath)
    await localGit.pull('origin', 'main')

    await peer.rm('doomed.md')
    await peer.commit('docs: delete doomed')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, {
      pages: [{ id: 'p1', path: 'doomed', locale: PRIMARY_LOCALE, contentType: 'markdown' }]
    })
    await sync(target)

    assert.equal(calls.deletePage.length, 1)
    assert.equal(calls.deletePage[0].id, 'p1')
  })

  describe('mass-delete safety guard (OpenProject #2429)', () => {
    async function seedTenPages(peer: ReturnType<typeof simpleGit>, peerPath: string) {
      const pages = Array.from({ length: 10 }, (_, i) => ({
        id: `p${i + 1}`,
        path: `page${i + 1}`,
        locale: PRIMARY_LOCALE,
        contentType: 'markdown'
      }))
      for (const p of pages) {
        await fs.writeFile(path.join(peerPath, `${p.path}.md`), `body of ${p.path}`)
      }
      await peer.add(pages.map((p) => `${p.path}.md`))
      await peer.commit('docs: create ten pages')
      await peer.push('origin', 'main')
      return pages
    }

    test('holds back page deletions at/above the default 50% threshold, but still applies everything else in the same diff', async () => {
      const { peer, peerPath } = await makePeer(originPath)
      const pages = await seedTenPages(peer, peerPath)

      installWiki(localPath, { pages })
      await ensureRepo(target)
      const localGit = simpleGit(target.config.localRepoPath)
      await localGit.pull('origin', 'main')

      // -> 6 of 10 deleted (60%, above the 50% default) in the same commit as an unrelated new
      //    page, which must still land even though the deletions are held back.
      const toDelete = pages.slice(0, 6).map((p) => `${p.path}.md`)
      await peer.rm(toDelete)
      await fs.writeFile(path.join(peerPath, 'unrelated.md'), 'a normal, unrelated change')
      await peer.add('unrelated.md')
      await peer.commit('docs: revert most pages, add one unrelated page')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, { pages })
      await sync(target)

      assert.equal(calls.deletePage.length, 0)
      assert.equal(calls.createPage.length, 1)
      assert.equal(calls.createPage[0].input.path, 'unrelated')
    })

    test('an explicit confirmMassDelete override applies the held-back deletions', async () => {
      const { peer, peerPath } = await makePeer(originPath)
      const pages = await seedTenPages(peer, peerPath)

      installWiki(localPath, { pages })
      await ensureRepo(target)
      const localGit = simpleGit(target.config.localRepoPath)
      await localGit.pull('origin', 'main')

      const toDelete = pages.slice(0, 6).map((p) => `${p.path}.md`)
      await peer.rm(toDelete)
      await peer.commit('docs: revert most pages')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, { pages })
      await sync(target, { confirmMassDelete: true })

      assert.equal(calls.deletePage.length, 6)
      assert.deepEqual(calls.deletePage.map((c: any) => c.id).sort(), [
        'p1',
        'p2',
        'p3',
        'p4',
        'p5',
        'p6'
      ])
    })

    test('a deletion under the configured threshold still applies without needing an override', async () => {
      const { peer, peerPath } = await makePeer(originPath)
      const pages = await seedTenPages(peer, peerPath)

      installWiki(localPath, { pages })
      await ensureRepo(target)
      const localGit = simpleGit(target.config.localRepoPath)
      await localGit.pull('origin', 'main')

      // -> 1 of 10 deleted (10%), well under the 50% default threshold.
      await peer.rm('page1.md')
      await peer.commit('docs: delete a single page')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, { pages })
      await sync(target)

      assert.equal(calls.deletePage.length, 1)
      assert.equal(calls.deletePage[0].id, 'p1')
    })

    test('a lower configured maxDeletePercent blocks a smaller fraction than the default', async () => {
      const { peer, peerPath } = await makePeer(originPath)
      const pages = await seedTenPages(peer, peerPath)

      const strictTarget = makeTarget({
        config: {
          ...makeTarget().config,
          repoUrl: originPath,
          localRepoPath: path.join(localPath, 'repo'),
          maxDeletePercent: 10
        }
      })

      installWiki(localPath, { pages })
      await ensureRepo(strictTarget)
      const localGit = simpleGit(strictTarget.config.localRepoPath)
      await localGit.pull('origin', 'main')

      // -> 2 of 10 deleted (20%) — under the 50% default, but at/above this target's own 10% cap.
      await peer.rm(['page1.md', 'page2.md'])
      await peer.commit('docs: delete two pages')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, { pages })
      await sync(strictTarget)

      assert.equal(calls.deletePage.length, 0)
    })
  })

  test('pulls a new asset and uploads it', async () => {
    installWiki(localPath, { assets: [] })
    const { git: localGit } = await ensureRepo(target)
    await localGit.pull('origin', 'main')

    const { peer, peerPath } = await makePeer(originPath)
    await fs.mkdir(path.join(peerPath, 'images'), { recursive: true })
    await fs.writeFile(path.join(peerPath, 'images/pic.png'), 'binarybytes')
    await peer.add('images/pic.png')
    await peer.commit('docs: upload pic.png')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, { assets: [] })
    await sync(target)

    assert.equal(calls.upload.length, 1)
    assert.equal(calls.upload[0].fileName, 'pic.png')
    assert.equal(calls.upload[0].data.toString(), 'binarybytes')
  })

  test(
    'pulls a whole-folder rename of assets — deletes each old asset and re-uploads it at the new ' +
      'location (OpenProject #823 item 3), since a folder move is not something renameAsset() covers',
    async () => {
      const { peer, peerPath } = await makePeer(originPath)
      await fs.mkdir(path.join(peerPath, 'images/gallery'), { recursive: true })
      await fs.writeFile(path.join(peerPath, 'images/gallery/photo1.png'), 'bytes-one')
      await fs.writeFile(path.join(peerPath, 'images/gallery/photo2.png'), 'bytes-two')
      await peer.add(['images/gallery/photo1.png', 'images/gallery/photo2.png'])
      await peer.commit('docs: create gallery folder')
      await peer.push('origin', 'main')

      const assetsBefore = [
        { id: 'a1', folderPath: 'images/gallery', fileName: 'photo1.png' },
        { id: 'a2', folderPath: 'images/gallery', fileName: 'photo2.png' }
      ]
      installWiki(localPath, { assets: assetsBefore })
      await ensureRepo(target)
      const localGit = simpleGit(target.config.localRepoPath)
      await localGit.pull('origin', 'main')

      await peer.mv('images/gallery', 'images/exhibit')
      await peer.commit('docs: rename gallery to exhibit')
      await peer.push('origin', 'main')

      const calls = installWiki(localPath, { assets: assetsBefore })
      await sync(target)

      assert.deepEqual(calls.deleteAsset.map((c: any) => c.id).sort(), ['a1', 'a2'])
      assert.equal(calls.upload.length, 2)
      assert.deepEqual(calls.upload.map((c: any) => c.fileName).sort(), [
        'photo1.png',
        'photo2.png'
      ])
      assert.ok(calls.upload.every((c: any) => c.folderId === 'folder:images/exhibit'))
    }
  )

  test(
    'a text-asset rename+rewrite (shaped exactly as sync() really builds it: real ' +
      'insertions/deletions, before/after undefined) leaves exactly one asset row, at the new ' +
      'path, holding the new content (#993 — orphaned-row fix)',
    async () => {
      const assetsBefore = [{ id: 'a1', folderPath: 'images', fileName: 'old.svg' }]
      const calls = installWiki(localPath, { assets: assetsBefore })

      const absPath = path.join(localPath, 'new.svg')
      await fs.mkdir(localPath, { recursive: true })
      await fs.writeFile(absPath, 'new-bytes')

      await processDiffEntry(
        target,
        { id: 'admin-1', permissions: ['manage:system'], groupIds: [] },
        {
          relPath: 'images/new.svg',
          oldPath: 'images/old.svg',
          absPath,
          exists: true,
          binary: false,
          insertions: 5,
          deletions: 2,
          before: undefined,
          after: undefined
        }
      )

      // -> Exactly one surviving row: never a rename-in-place, which would silently drop the new
      //    bytes, and never both an orphaned old row AND a fresh one.
      assert.deepEqual(
        calls.deleteAsset.map((c: any) => c.id),
        ['a1']
      )
      assert.equal(calls.renameAsset.length, 0)
      assert.equal(calls.upload.length, 1)
      assert.equal(calls.upload[0].fileName, 'new.svg')
      assert.equal(calls.upload[0].data.toString(), 'new-bytes')
    }
  )

  test(
    'a binary same-folder rename with unchanged before/after byte counts still takes the ' +
      'renameAsset path (shaped exactly as sync() really builds it: insertions/deletions ' +
      'hardcoded 0, real before/after)',
    async () => {
      const assetsBefore = [{ id: 'a1', folderPath: 'images', fileName: 'old.png' }]
      const calls = installWiki(localPath, { assets: assetsBefore })

      await processDiffEntry(
        target,
        { id: 'admin-1', permissions: ['manage:system'], groupIds: [] },
        {
          relPath: 'images/new.png',
          oldPath: 'images/old.png',
          absPath: path.join(localPath, 'new.png'),
          exists: true,
          binary: true,
          insertions: 0,
          deletions: 0,
          before: 1024,
          after: 1024
        }
      )

      assert.equal(calls.deleteAsset.length, 0)
      assert.equal(calls.upload.length, 0)
      assert.equal(calls.renameAsset.length, 1)
      assert.equal(calls.renameAsset[0].id, 'a1')
      assert.equal(calls.renameAsset[0].fileName, 'new.png')
    }
  )

  test('pushes local commits to origin', async () => {
    installWiki(localPath, { pages: [] })
    const { git, repoPath } = await ensureRepo(target)
    await git.pull('origin', 'main')
    await fs.writeFile(path.join(repoPath, 'mine.md'), 'local content')
    await git.add('mine.md')
    await git.commit('docs: create mine')

    installWiki(localPath, { pages: [] })
    await sync(target)

    const { peerPath, peer } = await makePeer(originPath)
    void peerPath
    const log = await peer.log()
    assert.ok(log.all.some((entry) => entry.message === 'docs: create mine'))
  })

  test('a push-only target never pulls remote content — its push rejects rather than silently rebasing first', async () => {
    installWiki(localPath, { pages: [] })
    const { git, repoPath } = await ensureRepo(target)
    await git.pull('origin', 'main')
    await fs.writeFile(path.join(repoPath, 'mine.md'), 'local content')
    await git.add('mine.md')
    await git.commit('docs: create mine')

    // -> The remote diverges after local's last pull. A pull-capable sync would rebase onto this
    //    first and the push would then succeed; a push-only one must not, which the raw git push
    //    rejecting as non-fast-forward is what proves.
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'welcome.md'), '# Hello there')
    await peer.add('welcome.md')
    await peer.commit('docs: create welcome')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, { pages: [] })
    await assert.rejects(sync({ ...target, sync: { ...target.sync, mode: 'push' } }))

    assert.equal(calls.createPage.length, 0)
    await assert.rejects(fs.access(path.join(repoPath, 'welcome.md')))
    void peerPath
  })

  test('a pull-only target never pushes local commits to origin', async () => {
    installWiki(localPath, { pages: [] })
    const { git, repoPath } = await ensureRepo(target)
    await git.pull('origin', 'main')
    await fs.writeFile(path.join(repoPath, 'mine.md'), 'local content')
    await git.add('mine.md')
    await git.commit('docs: create mine')

    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'welcome.md'), '# Hello there')
    await peer.add('welcome.md')
    await peer.commit('docs: create welcome')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, { pages: [] })
    await sync({ ...target, sync: { ...target.sync, mode: 'pull' } })

    assert.equal(calls.createPage.length, 1)
    assert.equal(calls.createPage[0].input.path, 'welcome')
    const log = await peer.log()
    assert.ok(!log.all.some((entry) => entry.message === 'docs: create mine'))
    void peerPath
  })

  test('a rebase conflict rejects rather than being force-resolved', async () => {
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'shared.md'), 'line one')
    await peer.add('shared.md')
    await peer.commit('docs: create shared')
    await peer.push('origin', 'main')

    installWiki(localPath, { pages: [] })
    const { git, repoPath } = await ensureRepo(target)
    await git.pull('origin', 'main')
    await fs.writeFile(path.join(repoPath, 'shared.md'), 'local edit')
    await git.add('shared.md')
    await git.commit('docs: local edit')

    // -> The peer changes the same line a different way and gets to origin first, which is what
    //    makes the rebase conflict.
    await fs.writeFile(path.join(peerPath, 'shared.md'), 'peer edit')
    await peer.add('shared.md')
    await peer.commit('docs: peer edit')
    await peer.push('origin', 'main')

    installWiki(localPath, { pages: [] })
    await assert.rejects(sync(target))
  })
})
