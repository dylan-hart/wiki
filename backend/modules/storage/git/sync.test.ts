/**
 * Tests for the two-way `sync` action: fetch/pull-rebase, push, and reverse-mirroring the remote
 * side's changes into the DB.
 *
 * Same approach as `storage.test.ts`/`content.test.ts`: real `git` binaries via `simple-git` against
 * throwaway temp directories — a bare repo standing in for "origin", and two working copies of it (one
 * playing this target's own local repo, one playing an outside collaborator pushing directly to
 * origin) — plus a minimal `WIKI` stub. Nothing here needs Postgres: what's under test is which
 * `WIKI.models.pages`/`WIKI.models.assets` call `sync()` decides to make for a given remote change,
 * which a stub records precisely and a real DB would only obscure behind more setup.
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

/** Installs a `WIKI` stub. Model calls are recorded on the returned `calls` object. */
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

/** A bare repo standing in for "origin", plus a working copy already pushed to it (`seedPath`). */
async function makeOrigin(): Promise<{ originPath: string; seedPath: string }> {
  const originPath = await makeTempDir('wiki-git-sync-origin-')
  await simpleGit(originPath).init(true)

  const seedPath = await makeTempDir('wiki-git-sync-seed-')
  const seed = simpleGit(seedPath)
  await seed.init()
  await seed.addConfig('user.name', 'Seed')
  await seed.addConfig('user.email', 'seed@example.com')
  await fs.writeFile(path.join(seedPath, '.keep'), '')
  await seed.add('.keep')
  await seed.commit('initial')
  await seed.addRemote('origin', originPath)
  await seed.push('origin', 'main')

  return { originPath, seedPath }
}

/** A second working copy of `originPath`, standing in for an outside collaborator. */
async function makePeer(
  originPath: string
): Promise<{ peerPath: string; peer: ReturnType<typeof simpleGit> }> {
  const peerPath = await makeTempDir('wiki-git-sync-peer-')
  const peer = simpleGit(peerPath)
  await peer.clone(originPath, '.')
  await peer.addConfig('user.name', 'Peer')
  await peer.addConfig('user.email', 'peer@example.com')
  return { peerPath, peer }
}

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
    // -> Establish the local clone/branch and its origin wiring, with at least one commit already
    //    pulled — `sync()` deliberately treats a repo with no prior local commits as a job for the
    //    separate "Import Everything" action rather than something it infers on its own.
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
    // -> Local is caught up to the file as it stood before the update under test.
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
    // -> Bring the local repo up to date with the peer's first commit before the rename.
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

    // -> The whole point: the path within the locale is unchanged, only the locale directory moves,
    //    so a move that carried the path alone would be a no-op that silently left the page in `fr`
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
      //    folder move, so this is what actually produces the `dir/{old => new}/rest` diff shape
      //    `parseRenamedPaths` exists to parse — verified directly against a real git diff before
      //    writing this test, not assumed.
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

      // -> Exactly one surviving row: the old one deleted, a fresh one uploaded at the new path —
      //    never a rename-in-place (which would silently drop the new bytes) and never both an
      //    orphaned old row AND a fresh one.
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

  // -> OpenProject #925: sync.mode must be respected, not always run the full two-way sequence.
  test('a push-only target never pulls remote content — its push rejects rather than silently rebasing first', async () => {
    installWiki(localPath, { pages: [] })
    const { git, repoPath } = await ensureRepo(target)
    await git.pull('origin', 'main')
    await fs.writeFile(path.join(repoPath, 'mine.md'), 'local content')
    await git.add('mine.md')
    await git.commit('docs: create mine')

    // -> The remote diverges after local's last pull, exactly the shape "a rebase conflict rejects"
    //    below exercises for two-way mode. A two-way (or pull-capable) sync would rebase onto this
    //    first and the push would then succeed; a push-only sync must not — proven here by the raw
    //    git push itself rejecting as non-fast-forward, since nothing rebased it onto the new tip.
    const { peer, peerPath } = await makePeer(originPath)
    await fs.writeFile(path.join(peerPath, 'welcome.md'), '# Hello there')
    await peer.add('welcome.md')
    await peer.commit('docs: create welcome')
    await peer.push('origin', 'main')

    const calls = installWiki(localPath, { pages: [] })
    await assert.rejects(sync({ ...target, sync: { ...target.sync, mode: 'push' } }))

    // -> Rejected before ever reaching the DB-import step, and the peer's file was never pulled down
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

    // -> Pulled and DB-imported the peer's change...
    assert.equal(calls.createPage.length, 1)
    assert.equal(calls.createPage[0].input.path, 'welcome')
    // -> ...but never pushed the local one
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
    // -> An unpushed local change to the same file...
    await fs.writeFile(path.join(repoPath, 'shared.md'), 'local edit')
    await git.add('shared.md')
    await git.commit('docs: local edit')

    // -> ...while the peer changes the same line a different way and gets there first.
    await fs.writeFile(path.join(peerPath, 'shared.md'), 'peer edit')
    await peer.add('shared.md')
    await peer.commit('docs: peer edit')
    await peer.push('origin', 'main')

    installWiki(localPath, { pages: [] })
    await assert.rejects(sync(target))
  })
})
