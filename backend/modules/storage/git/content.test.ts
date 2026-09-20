/**
 * A real `git` binary via `simple-git` against a throwaway temp directory, with a minimal `CARDINAL`
 * stub covering only what these handlers read — a mock of `simple-git` itself would mostly just
 * re-describe the code under test rather than verify it.
 */
import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import {
  created,
  updated,
  renamed,
  deleted,
  assetUploaded,
  assetRenamed,
  assetMoved,
  assetDeleted
} from './content.ts'
import { ensureRepo } from './repo.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { CONTENT_TYPES } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'

const SITE_ID = 'site-1'
const PRIMARY_LOCALE = 'en'

function installWiki(
  rootPath: string,
  {
    pages = {},
    assets = {},
    users = {}
  }: {
    pages?: Record<string, any>
    assets?: Record<string, any>
    users?: Record<string, any>
  } = {}
): void {
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
      pages: {
        getPage: mock.fn(async ({ id }: { id: string }) => pages[id] ?? null)
      },
      assets: {
        getContent: mock.fn(async (id: string) => assets[id] ?? null)
      },
      users: {
        getById: mock.fn(async (id: string) => users[id] ?? null)
      }
    }
  })
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-content-'))
}

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return makeStorageTarget('git', {
    id: 'target-1',
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
      defaultEmail: 'fallback@example.com'
    },
    ...overrides
  })
}

async function latestCommit(repoPath: string) {
  const git = simpleGit(repoPath)
  const log = await git.log()
  return log.latest
}

describe('git storage content handlers', () => {
  let rootPath: string
  let target: StorageTarget

  beforeEach(async () => {
    rootPath = await makeTempDir()
    target = makeTarget({
      config: { ...makeTarget().config, localRepoPath: path.join(rootPath, 'repo') }
    })
  })

  describe('created', () => {
    test('writes the page and commits it with the resolved author', async () => {
      installWiki(rootPath, {
        pages: {
          p1: { id: 'p1', path: 'foo/bar', contentType: 'markdown', content: '# Hello' }
        },
        users: { u1: { name: 'Alice', email: 'alice@example.com' } }
      })
      const { repoPath } = await ensureRepo(target)

      await created(target, {
        id: 'p1',
        path: 'foo/bar',
        locale: PRIMARY_LOCALE,
        siteId: SITE_ID,
        authorId: 'u1'
      })

      const written = await fs.readFile(path.join(repoPath, 'foo/bar.md'), 'utf8')
      assert.equal(written, '# Hello')

      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: create foo/bar')
      assert.equal(commit?.author_name, 'Alice')
      assert.equal(commit?.author_email, 'alice@example.com')
    })

    test('maps asciidoc and html content types to their extensions', async () => {
      installWiki(rootPath, {
        pages: {
          a1: { id: 'a1', path: 'doc', contentType: 'asciidoc', content: '= Title' },
          h1: { id: 'h1', path: 'page', contentType: 'html', content: '<p>hi</p>' }
        }
      })
      const { repoPath } = await ensureRepo(target)

      await created(target, { id: 'a1', path: 'doc', locale: PRIMARY_LOCALE, siteId: SITE_ID })
      await created(target, { id: 'h1', path: 'page', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      await assert.doesNotReject(fs.access(path.join(repoPath, 'doc.adoc')))
      await assert.doesNotReject(fs.access(path.join(repoPath, 'page.html')))
    })

    // -> This handler reads `page.contentType`, never `page.editor`, and a WYSIWYG page stores
    //    markdown — so the editor never gets a say in the extension.
    test('writes a WYSIWYG-editor page (content type markdown) to a .md file, same as the markdown editor', async () => {
      installWiki(rootPath, {
        pages: {
          w1: {
            id: 'w1',
            path: 'wysiwyg-page',
            editor: 'wysiwyg',
            contentType: 'markdown',
            content: '# Heading\n\nSome **bold** text.'
          }
        }
      })
      const { repoPath } = await ensureRepo(target)

      await created(target, {
        id: 'w1',
        path: 'wysiwyg-page',
        locale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })

      const written = await fs.readFile(path.join(repoPath, 'wysiwyg-page.md'), 'utf8')
      assert.equal(written, '# Heading\n\nSome **bold** text.')
      await assert.rejects(fs.access(path.join(repoPath, 'wysiwyg-page.html')))
    })

    test('falls back to the target defaultName/defaultEmail when there is no resolvable author', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'markdown', content: 'hi' } }
      })
      const { repoPath } = await ensureRepo(target)

      await created(target, { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      const commit = await latestCommit(repoPath)
      assert.equal(commit?.author_name, 'Fallback Name')
      assert.equal(commit?.author_email, 'fallback@example.com')
    })

    test('namespaces a non-primary-locale page under a locale folder', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'markdown', content: 'bonjour' } }
      })
      const { repoPath } = await ensureRepo(target)

      await created(target, { id: 'p1', path: 'foo', locale: 'fr', siteId: SITE_ID })

      assert.equal(await fs.readFile(path.join(repoPath, 'fr/foo.md'), 'utf8'), 'bonjour')
    })

    test('does nothing when the target does not have pages in its active content types', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'markdown', content: 'hi' } }
      })
      const noPagesTarget = makeTarget({
        config: { ...target.config },
        contentTypes: {
          activeTypes: ['images'],
          supportedTypes: [...CONTENT_TYPES],
          largeThreshold: '5MB'
        }
      })
      const { repoPath } = await ensureRepo(noPagesTarget)

      await created(noPagesTarget, {
        id: 'p1',
        path: 'foo',
        locale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })

      await assert.rejects(fs.access(path.join(repoPath, 'foo.md')))
    })
  })

  describe('updated', () => {
    test('overwrites the file in place and commits with docs: update', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'markdown', content: 'v1' } }
      })
      const { repoPath } = await ensureRepo(target)
      await created(target, { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'markdown', content: 'v2' } }
      })
      await updated(target, { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      assert.equal(await fs.readFile(path.join(repoPath, 'foo.md'), 'utf8'), 'v2')
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: update foo')
    })
  })

  describe('renamed', () => {
    test('moves the tracked file in one commit, preserving history', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'new-path', contentType: 'markdown', content: 'body' } }
      })
      const { repoPath } = await ensureRepo(target)
      await created(target, { id: 'p1', path: 'old-path', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      await renamed(target, {
        id: 'p1',
        path: 'new-path',
        previousPath: 'old-path',
        locale: PRIMARY_LOCALE,
        previousLocale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })

      await assert.rejects(fs.access(path.join(repoPath, 'old-path.md')))
      assert.equal(await fs.readFile(path.join(repoPath, 'new-path.md'), 'utf8'), 'body')
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: rename old-path to new-path')

      const git = simpleGit(repoPath)
      const history = await git.log(['--follow', '--', 'new-path.md'])
      // -> The create commit and the rename commit are both still reachable via --follow
      assert.ok(history.total >= 2)
    })

    test('writes fresh at the new path when nothing was tracked at the old one', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'new-path', contentType: 'markdown', content: 'body' } }
      })
      const { repoPath } = await ensureRepo(target)

      await renamed(target, {
        id: 'p1',
        path: 'new-path',
        previousPath: 'old-path',
        locale: PRIMARY_LOCALE,
        previousLocale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })

      assert.equal(await fs.readFile(path.join(repoPath, 'new-path.md'), 'utf8'), 'body')
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: create new-path')
    })

    test('a locale-only move renames the file out of the old locale directory', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'same-path', contentType: 'markdown', content: 'body' } }
      })
      const { repoPath } = await ensureRepo(target)
      await created(target, { id: 'p1', path: 'same-path', locale: 'fr', siteId: SITE_ID })

      await renamed(target, {
        id: 'p1',
        path: 'same-path',
        previousPath: 'same-path',
        locale: PRIMARY_LOCALE,
        previousLocale: 'fr',
        siteId: SITE_ID
      })

      // -> The primary locale has no directory of its own, so the page lands at the repo root
      await assert.rejects(fs.access(path.join(repoPath, 'fr', 'same-path.md')))
      assert.equal(await fs.readFile(path.join(repoPath, 'same-path.md'), 'utf8'), 'body')
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: rename fr/same-path to en/same-path')
    })

    // -> `movePage`'s `includeTranslations` cascade dispatches `page:rename` once per moved page, so
    //    this handler gets one `renamed()` call per twin and each carries its own commit.
    test('a translations cascade renames every twin file too, each in its own commit', async () => {
      installWiki(rootPath, {
        pages: {
          en1: { id: 'en1', path: 'docs/new', contentType: 'markdown', content: 'English' },
          fr1: { id: 'fr1', path: 'docs/new', contentType: 'markdown', content: 'Français' }
        }
      })
      const { repoPath } = await ensureRepo(target)
      await created(target, {
        id: 'en1',
        path: 'docs/old',
        locale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })
      await created(target, { id: 'fr1', path: 'docs/old', locale: 'fr', siteId: SITE_ID })

      // -> The order `movePage` dispatches in: the primary (en) first, then each twin (fr)
      await renamed(target, {
        id: 'en1',
        path: 'docs/new',
        previousPath: 'docs/old',
        locale: PRIMARY_LOCALE,
        previousLocale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })
      await renamed(target, {
        id: 'fr1',
        path: 'docs/new',
        previousPath: 'docs/old',
        locale: 'fr',
        previousLocale: 'fr',
        siteId: SITE_ID
      })

      await assert.rejects(fs.access(path.join(repoPath, 'docs', 'old.md')))
      await assert.rejects(fs.access(path.join(repoPath, 'fr', 'docs', 'old.md')))
      assert.equal(await fs.readFile(path.join(repoPath, 'docs', 'new.md'), 'utf8'), 'English')
      assert.equal(
        await fs.readFile(path.join(repoPath, 'fr', 'docs', 'new.md'), 'utf8'),
        'Français'
      )

      const git = simpleGit(repoPath)
      const log = await git.log()
      // -> Each is a same-locale rename, so both commit messages read identically (the locale lives
      //    in the file's directory, not in the message) -- the count is what proves it ran twice.
      const renameMessages = log.all
        .map((entry) => entry.message)
        .filter((message) => message === 'docs: rename docs/old to docs/new')
      assert.equal(renameMessages.length, 2)
    })
  })

  describe('deleted', () => {
    test('removes the file it finds on disk and commits docs: delete, despite the page row being gone', async () => {
      installWiki(rootPath, {
        pages: { p1: { id: 'p1', path: 'foo', contentType: 'asciidoc', content: '= x' } }
      })
      const { repoPath } = await ensureRepo(target)
      await created(target, { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      // -> No `pages.getPage` result at all — the row is gone by the time delete dispatches
      installWiki(rootPath, {})
      await deleted(target, { id: 'p1', path: 'foo', locale: PRIMARY_LOCALE, siteId: SITE_ID })

      await assert.rejects(fs.access(path.join(repoPath, 'foo.adoc')))
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: delete foo')
    })

    test('does nothing when no file for this page exists under any known extension', async () => {
      installWiki(rootPath, {})
      const { repoPath } = await ensureRepo(target)
      await fs.writeFile(path.join(repoPath, '.keep'), '')
      const gitBefore = simpleGit(repoPath)
      await gitBefore.add('.keep')
      await gitBefore.commit('initial')

      await deleted(target, {
        id: 'missing',
        path: 'never-existed',
        locale: PRIMARY_LOCALE,
        siteId: SITE_ID
      })

      const log = await simpleGit(repoPath).log()
      assert.equal(log.total, 1)
    })
  })

  describe('assetUploaded', () => {
    test('writes the asset bytes and commits docs: upload', async () => {
      installWiki(rootPath, {
        assets: {
          a1: { data: Buffer.from('binarydata'), mimeType: 'image/png', fileName: 'pic.png' }
        }
      })
      const { repoPath } = await ensureRepo(target)

      await assetUploaded(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })

      assert.equal(await fs.readFile(path.join(repoPath, 'images/pic.png'), 'utf8'), 'binarydata')
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: upload images/pic.png')
    })

    // -> The handler does not re-check the target's content-type coverage: `Storage.dispatch()`
    //    already gated this size-aware before queuing, so a target row disagreeing with that
    //    classification (e.g. edited between queueing and delivery) is not second-guessed here.
    test('writes the asset even though the target row itself would not cover this kind, trusting the dispatch that already gated it', async () => {
      installWiki(rootPath, {
        assets: {
          a1: { data: Buffer.from('binarydata'), mimeType: 'image/png', fileName: 'pic.png' }
        }
      })
      const documentsOnlyTarget = makeTarget({
        config: { ...target.config },
        contentTypes: {
          activeTypes: ['documents'],
          supportedTypes: [...CONTENT_TYPES],
          largeThreshold: '5MB'
        }
      })
      const { repoPath } = await ensureRepo(documentsOnlyTarget)

      await assetUploaded(documentsOnlyTarget, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: '',
        siteId: SITE_ID,
        kind: 'image'
      })

      assert.equal(await fs.readFile(path.join(repoPath, 'pic.png'), 'utf8'), 'binarydata')
    })
  })

  describe('assetRenamed', () => {
    test('moves the tracked file in one commit', async () => {
      installWiki(rootPath, {
        assets: { a1: { data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'new.png' } }
      })
      const { repoPath } = await ensureRepo(target)
      await assetUploaded(target, {
        id: 'a1',
        fileName: 'old.png',
        folderPath: '',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assetRenamed(target, {
        id: 'a1',
        fileName: 'new.png',
        previousFileName: 'old.png',
        folderPath: '',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assert.rejects(fs.access(path.join(repoPath, 'old.png')))
      await assert.doesNotReject(fs.access(path.join(repoPath, 'new.png')))
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: rename old.png to new.png')
    })
  })

  describe('assetMoved (OpenProject #3384)', () => {
    test('moves the tracked file to the new folder in one commit', async () => {
      installWiki(rootPath, {
        assets: { a1: { data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'pic.png' } }
      })
      const { repoPath } = await ensureRepo(target)
      await assetUploaded(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assetMoved(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'gallery',
        previousFolderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assert.rejects(fs.access(path.join(repoPath, 'images/pic.png')))
      await assert.doesNotReject(fs.access(path.join(repoPath, 'gallery/pic.png')))
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: move images/pic.png to gallery/pic.png')
    })

    test('writes fresh at the new folder when nothing is tracked at the old one', async () => {
      installWiki(rootPath, {
        assets: { a1: { data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'pic.png' } }
      })
      const { repoPath } = await ensureRepo(target)

      await assetMoved(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'gallery',
        previousFolderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assert.doesNotReject(fs.access(path.join(repoPath, 'gallery/pic.png')))
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: upload gallery/pic.png')
    })

    test('is a no-op when the folder is unchanged', async () => {
      installWiki(rootPath, {
        assets: { a1: { data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'pic.png' } }
      })
      const { repoPath } = await ensureRepo(target)
      await assetUploaded(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })
      const beforeCommit = await latestCommit(repoPath)

      await assetMoved(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'images',
        previousFolderPath: 'images',
        siteId: SITE_ID,
        kind: 'image'
      })

      const afterCommit = await latestCommit(repoPath)
      assert.equal(afterCommit?.hash, beforeCommit?.hash)
    })
  })

  describe('assetDeleted', () => {
    test('removes the file and commits docs: delete', async () => {
      installWiki(rootPath, {
        assets: { a1: { data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'pic.png' } }
      })
      const { repoPath } = await ensureRepo(target)
      await assetUploaded(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: '',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assetDeleted(target, {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: '',
        siteId: SITE_ID,
        kind: 'image'
      })

      await assert.rejects(fs.access(path.join(repoPath, 'pic.png')))
      const commit = await latestCommit(repoPath)
      assert.equal(commit?.message, 'docs: delete pic.png')
    })
  })
})
