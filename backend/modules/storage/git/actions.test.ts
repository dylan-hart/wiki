/**
 * Tests for the `syncUntracked`, `importAll` and `purge` actions.
 *
 * Same approach as `content.test.ts`/`sync.test.ts`: a real `git` binary via `simple-git` against a
 * throwaway temp directory, and a minimal `WIKI` stub covering only what these actions read.
 */
import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { syncUntracked, importAll, purge } from './actions.ts'
import { ensureRepo } from './repo.ts'
import { generatePathHash } from '../../../helpers/common.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'

const SITE_ID = 'site-1'
const PRIMARY_LOCALE = 'en'
const ADMIN_EMAIL = 'admin@example.com'

interface PageRow {
  id: string
  path: string
  locale: string
  contentType: string
  content: string
}

interface AssetRow {
  id: string
  kind: string
  folderPath: string
  fileName: string
  data: Buffer
  /** Defaults to `data.length` when omitted — set explicitly to exercise the "large" bucket. */
  fileSize?: number
}

/** Installs a `WIKI` stub. `pages`/`assets` back both the listing and per-item lookup calls. */
function installWiki(
  rootPath: string,
  { pages = [], assets = [] }: { pages?: PageRow[]; assets?: AssetRow[] } = {}
) {
  const calls = {
    createPage: [] as any[],
    updatePage: [] as any[],
    upload: [] as any[]
  }

  installTestWiki({
    ROOTPATH: rootPath,
    sites: {
      [SITE_ID]: { config: { locales: { primary: PRIMARY_LOCALE } } }
    },
    models: {
      extensions: {
        getDefinition: mock.fn(() => ({ key: 'git', detect: { type: 'command', value: 'git' } })),
        isInstalled: mock.fn(async () => true)
      },
      users: {
        getById: mock.fn(async () => null),
        getByEmail: mock.fn(async (email: string) =>
          email === ADMIN_EMAIL ? { id: 'admin-1', email } : null
        )
      },
      pages: {
        listAllForSite: mock.fn(async () =>
          pages.map((p) => ({
            id: p.id,
            path: p.path,
            locale: p.locale,
            contentType: p.contentType
          }))
        ),
        getPage: mock.fn(
          async ({ id, hash, locale }: { id?: string; hash?: string; locale?: string }) => {
            const found = id
              ? pages.find((p) => p.id === id)
              : pages.find((p) => generatePathHash(p.path) === hash && p.locale === locale)
            return found ? { ...found } : null
          }
        ),
        createPage: mock.fn(async (siteId: string, input: any, actor: any) => {
          calls.createPage.push({ siteId, input, actor })
          return { id: 'new-page', ...input }
        }),
        updatePage: mock.fn(async (siteId: string, id: string, patch: any, actor: any) => {
          calls.updatePage.push({ siteId, id, patch, actor })
          return { id }
        })
      },
      assets: {
        listAllForSite: mock.fn(async () =>
          assets.map((a) => ({
            id: a.id,
            kind: a.kind,
            folderPath: a.folderPath,
            fileName: a.fileName,
            fileSize: a.fileSize ?? a.data.length
          }))
        ),
        getContent: mock.fn(async (id: string) => {
          const found = assets.find((a) => a.id === id)
          return found
            ? { data: found.data, mimeType: 'application/octet-stream', fileName: found.fileName }
            : null
        }),
        getAssetByPath: mock.fn(async () => null),
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

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
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
    config: {
      authType: 'basic',
      repoUrl: 'https://example.com/org/repo.git',
      branch: 'main',
      verifySSL: true,
      defaultName: 'Fallback Name',
      defaultEmail: ADMIN_EMAIL
    },
    ...overrides
  })
}

async function latestCommit(repoPath: string) {
  const git = simpleGit(repoPath)
  const log = await git.log()
  return log.latest
}

describe('git storage: syncUntracked', () => {
  let rootPath: string
  let target: StorageTarget

  beforeEach(async () => {
    rootPath = await makeTempDir('wiki-git-actions-')
    target = makeTarget({
      config: { ...makeTarget().config, localRepoPath: path.join(rootPath, 'repo') }
    })
  })

  test('writes an untracked page and asset in a single bulk commit', async () => {
    installWiki(rootPath, {
      pages: [
        {
          id: 'p1',
          path: 'foo/bar',
          locale: PRIMARY_LOCALE,
          contentType: 'markdown',
          content: '# Hello'
        }
      ],
      assets: [
        {
          id: 'a1',
          kind: 'image',
          folderPath: 'images',
          fileName: 'logo.png',
          data: Buffer.from('PNGDATA')
        }
      ]
    })
    const { repoPath } = await ensureRepo(target)

    await syncUntracked(target)

    assert.equal(await fs.readFile(path.join(repoPath, 'foo/bar.md'), 'utf8'), '# Hello')
    assert.equal((await fs.readFile(path.join(repoPath, 'images/logo.png'))).toString(), 'PNGDATA')

    const commit = await latestCommit(repoPath)
    assert.equal(commit?.message, 'docs: add all untracked content')
    assert.equal(commit?.author_name, 'Fallback Name')
    assert.equal(commit?.author_email, ADMIN_EMAIL)
  })

  test('makes no commit at all when everything is already tracked and unchanged', async () => {
    installWiki(rootPath, {
      pages: [
        { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, contentType: 'markdown', content: 'hi' }
      ]
    })
    const { git, repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'foo.md'), 'hi')
    await git.add('foo.md')
    await git.commit('docs: create foo', { '--author': 'Someone <someone@example.com>' })
    const before = await latestCommit(repoPath)

    await syncUntracked(target)

    const after = await latestCommit(repoPath)
    assert.equal(after?.hash, before?.hash)
  })

  test('rewrites and commits a tracked file whose disk content has drifted from the DB', async () => {
    installWiki(rootPath, {
      pages: [
        {
          id: 'p1',
          path: 'foo',
          locale: PRIMARY_LOCALE,
          contentType: 'markdown',
          content: 'new content'
        }
      ]
    })
    const { git, repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'foo.md'), 'stale content')
    await git.add('foo.md')
    await git.commit('docs: create foo', { '--author': 'Someone <someone@example.com>' })

    await syncUntracked(target)

    assert.equal(await fs.readFile(path.join(repoPath, 'foo.md'), 'utf8'), 'new content')
    const commit = await latestCommit(repoPath)
    assert.equal(commit?.message, 'docs: add all untracked content')
  })

  test('skips a bucket the target does not actively cover', async () => {
    installWiki(rootPath, {
      pages: [
        { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, contentType: 'markdown', content: 'hi' }
      ]
    })
    const noPagesTarget = makeTarget({
      config: { ...target.config },
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    })
    const { repoPath } = await ensureRepo(noPagesTarget)

    await syncUntracked(noPagesTarget)

    await assert.rejects(fs.access(path.join(repoPath, 'foo.md')))
  })

  // -> OpenProject #924: the asset gate must be size-aware (`belongsInTarget`), matching
  //    `Storage.dispatch()`'s own classification, not a kind-only re-check that disagrees with it.
  test('includes an oversized asset through the large bucket even though its kind bucket is not covered', async () => {
    installWiki(rootPath, {
      assets: [
        {
          id: 'a1',
          kind: 'image',
          folderPath: '',
          fileName: 'huge.png',
          data: Buffer.from('x'),
          fileSize: 10 * 1024 * 1024 // -> 10MB, over the 5MB threshold below
        }
      ]
    })
    const largeOnlyTarget = makeTarget({
      config: { ...target.config },
      contentTypes: { activeTypes: ['large'], largeThreshold: '5MB' } // -> no 'images'
    })
    const { repoPath } = await ensureRepo(largeOnlyTarget)

    await syncUntracked(largeOnlyTarget)

    await assert.doesNotReject(fs.access(path.join(repoPath, 'huge.png')))
  })

  test('skips an oversized asset when the target covers its kind bucket but not large', async () => {
    installWiki(rootPath, {
      assets: [
        {
          id: 'a1',
          kind: 'image',
          folderPath: '',
          fileName: 'huge.png',
          data: Buffer.from('x'),
          fileSize: 10 * 1024 * 1024
        }
      ]
    })
    const imagesOnlyTarget = makeTarget({
      config: { ...target.config },
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' } // -> no 'large'
    })
    const { repoPath } = await ensureRepo(imagesOnlyTarget)

    await syncUntracked(imagesOnlyTarget)

    await assert.rejects(fs.access(path.join(repoPath, 'huge.png')))
  })
})

describe('git storage: importAll', () => {
  let rootPath: string
  let target: StorageTarget

  beforeEach(async () => {
    rootPath = await makeTempDir('wiki-git-actions-')
    target = makeTarget({
      config: { ...makeTarget().config, localRepoPath: path.join(rootPath, 'repo') }
    })
  })

  test('creates a new page from an untracked file in the working tree', async () => {
    const calls = installWiki(rootPath, { pages: [] })
    const { repoPath } = await ensureRepo(target)
    await fs.mkdir(path.join(repoPath, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repoPath, 'docs/welcome.md'), '# Welcome')

    await importAll(target)

    assert.equal(calls.createPage.length, 1)
    assert.equal(calls.createPage[0].input.path, 'docs/welcome')
    assert.equal(calls.createPage[0].input.content, '# Welcome')
    assert.equal(calls.createPage[0].actor.id, 'admin-1')
  })

  test('updates an existing page instead of creating a duplicate', async () => {
    const calls = installWiki(rootPath, {
      pages: [
        {
          id: 'p1',
          path: 'welcome',
          locale: PRIMARY_LOCALE,
          contentType: 'markdown',
          content: 'old'
        }
      ]
    })
    const { repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'welcome.md'), 'new content')

    await importAll(target)

    assert.equal(calls.createPage.length, 0)
    assert.equal(calls.updatePage.length, 1)
    assert.equal(calls.updatePage[0].id, 'p1')
    assert.equal(calls.updatePage[0].patch.content, 'new content')
  })

  test('imports a file with no recognized page extension as an asset upload', async () => {
    const calls = installWiki(rootPath, { pages: [] })
    const { repoPath } = await ensureRepo(target)
    await fs.mkdir(path.join(repoPath, 'images'), { recursive: true })
    await fs.writeFile(path.join(repoPath, 'images/logo.png'), 'PNGDATA')

    await importAll(target)

    assert.equal(calls.upload.length, 1)
    assert.equal(calls.upload[0].fileName, 'logo.png')
  })

  test("skips .git internals and this module's own inline SSH key file", async () => {
    const calls = installWiki(rootPath, { pages: [] })
    const sshTarget = makeTarget({
      config: {
        ...target.config,
        localRepoPath: target.config.localRepoPath,
        authType: 'ssh',
        sshPrivateKeyMode: 'inline',
        sshPrivateKeyContent: 'fake-key-material'
      }
    })
    await ensureRepo(sshTarget)

    await importAll(sshTarget)

    assert.equal(calls.createPage.length, 0)
    assert.equal(calls.upload.length, 0)
  })

  test('skips zero-byte files', async () => {
    const calls = installWiki(rootPath, { pages: [] })
    const { repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'empty.md'), '')

    await importAll(target)

    assert.equal(calls.createPage.length, 0)
  })

  test('does nothing when no user matches the configured default author email', async () => {
    const calls = installWiki(rootPath, { pages: [] })
    ;(globalThis as any).WIKI.models.users.getByEmail = mock.fn(async () => null)
    const { repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'welcome.md'), '# Welcome')

    await importAll(target)

    assert.equal(calls.createPage.length, 0)
  })
})

describe('git storage: purge', () => {
  let rootPath: string
  let target: StorageTarget

  beforeEach(async () => {
    rootPath = await makeTempDir('wiki-git-actions-')
    target = makeTarget({
      config: { ...makeTarget().config, localRepoPath: path.join(rootPath, 'repo') }
    })
  })

  test('empties the repo directory and leaves a fresh, empty, initialized repo behind', async () => {
    installWiki(rootPath)
    const { git, repoPath } = await ensureRepo(target)
    await fs.writeFile(path.join(repoPath, 'foo.md'), 'hi')
    await git.add('foo.md')
    await git.commit('docs: create foo', { '--author': 'Someone <someone@example.com>' })
    await assert.doesNotReject(fs.access(path.join(repoPath, 'foo.md')))

    await purge(target)

    await assert.rejects(fs.access(path.join(repoPath, 'foo.md')))
    const postGit = simpleGit(repoPath)
    await assert.doesNotReject(fs.access(path.join(repoPath, '.git')))
    const head = (await postGit.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
    assert.equal(head, 'main')
    const remotes = await postGit.getRemotes(true)
    assert.equal(remotes.find((r) => r.name === 'origin')?.refs.fetch, target.config.repoUrl)
  })

  test('refuses to purge when localRepoPath resolves to WIKI.ROOTPATH itself', async () => {
    installWiki(rootPath)
    const rootTarget = makeTarget({ config: { ...target.config, localRepoPath: '.' } })

    await assert.rejects(purge(rootTarget), /Refusing to purge/)
  })
})
