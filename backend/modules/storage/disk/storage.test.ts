import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { list as listTarball } from 'tar'
import { CustomError } from '../../../helpers/common.ts'
import diskStorageModule, {
  validateConfig,
  dump,
  importAll,
  backup,
  dailyBackup,
  pruneDailyBackups
} from './storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'

/**
 * Exercises `validateConfig`, `dump` and `backup` entirely against the real filesystem (temp
 * directories, cleaned up after each test) with `WIKI.db` / `WIKI.models.pages` /
 * `WIKI.models.assets` stubbed rather than a real Postgres instance — what this module has to get
 * right is filesystem behavior (paths, directory creation, archive contents, surfacing a write
 * failure), not SQL, so a stub answering the exact `select().from().where().orderBy()` chain
 * `listSiteEntries` builds is enough to drive it.
 */
before(async () => {
  await ensureTemporal()
})

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-disk-storage-test-'))
}

/** A minimal target for `site-1` configured to write to `dir` -- all `dump`/`backup` read from it. */
function makeTarget(dir: string): StorageTarget {
  return makeStorageTarget('disk', { siteId: 'site-1', config: { path: dir } })
}

/** Points `WIKI` at fakes answering exactly what `dump()` calls: the tree query, pages, assets. */
function fakeDumpDeps({
  rows = [],
  getPage = async () => null,
  getContent = async () => null
}: {
  rows?: object[]
  getPage?: (args: { siteId: string; id: string; withContent: boolean }) => Promise<any>
  getContent?: (id: string) => Promise<any>
} = {}) {
  // -> `models` names exactly what `dump()` calls and nothing else, so a reach past them still
  //    throws (`createWikiStub` defaults `models` to `{}` for precisely this reason).
  installTestWiki({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(rows)
          })
        })
      })
    },
    models: {
      pages: { getPage },
      assets: { getContent }
    }
  })
}

test('diskStorageModule declares validateConfig, dump, importAll, backup and dailyBackup', () => {
  assert.deepEqual(Object.keys(diskStorageModule).sort(), [
    'backup',
    'dailyBackup',
    'dump',
    'importAll',
    'validateConfig'
  ])
})

// ---------------------------------------------------------------------------------------------
// validateConfig()
// ---------------------------------------------------------------------------------------------

test('validateConfig requires a path', async () => {
  assert.match((await validateConfig({})) ?? '', /path is required/)
})

test('validateConfig rejects a relative path', async () => {
  assert.match((await validateConfig({ path: 'relative/path' })) ?? '', /not an absolute path/)
})

test('validateConfig rejects a path that does not exist', async () => {
  const missing = path.join(os.tmpdir(), `wiki-disk-storage-missing-${Date.now()}`)
  assert.match((await validateConfig({ path: missing })) ?? '', /does not exist/)
})

test('validateConfig rejects a path that is a file rather than a directory', async () => {
  const dir = await makeTempDir()
  const file = path.join(dir, 'not-a-directory.txt')
  await fs.writeFile(file, 'x')
  try {
    assert.match((await validateConfig({ path: file })) ?? '', /not a directory/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test(
  'validateConfig rejects a directory it cannot write to',
  { skip: process.getuid?.() === 0 },
  async () => {
    const dir = await makeTempDir()
    await fs.chmod(dir, 0o500)
    try {
      assert.match((await validateConfig({ path: dir })) ?? '', /not writable/)
    } finally {
      await fs.chmod(dir, 0o700)
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
)

test('validateConfig accepts an absolute, existing, writable directory', async () => {
  const dir = await makeTempDir()
  try {
    assert.equal(await validateConfig({ path: dir }), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// dump()
// ---------------------------------------------------------------------------------------------

test('dump writes nothing and does not throw for a site with no pages or assets', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({ rows: [] })
  try {
    await assert.doesNotReject(dump(makeTarget(dir)))
    assert.deepEqual(await fs.readdir(dir), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dump writes a page under <path>/<locale>/<path>.<ext>, by contentType', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({
    rows: [{ id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'home' }],
    getPage: async ({ id }) =>
      id === 'p1'
        ? { path: 'foo/home', locale: 'en', contentType: 'markdown', content: '# Hello' }
        : null
  })
  try {
    await dump(makeTarget(dir))
    const written = await fs.readFile(path.join(dir, 'en', 'foo', 'home.md'), 'utf8')
    assert.equal(written, '# Hello')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dump writes a redirect page as JSON', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({
    rows: [{ id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'old' }],
    getPage: async () => ({
      path: 'old',
      locale: 'en',
      contentType: 'redirect',
      content: '{"target":"/new"}'
    })
  })
  try {
    await dump(makeTarget(dir))
    const written = await fs.readFile(path.join(dir, 'en', 'old.json'), 'utf8')
    assert.equal(written, '{"target":"/new"}')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dump writes an asset under <path>/<locale>/<folderPath>/<fileName>', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({
    rows: [{ id: 'a1', type: 'asset', locale: 'en', folderPath: 'images', fileName: 'logo.png' }],
    getContent: async (id) =>
      id === 'a1'
        ? { data: Buffer.from('PNGDATA'), mimeType: 'image/png', fileName: 'logo.png' }
        : null
  })
  try {
    await dump(makeTarget(dir))
    const written = await fs.readFile(path.join(dir, 'en', 'images', 'logo.png'))
    assert.equal(written.toString(), 'PNGDATA')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dump skips an entry that no longer exists between listing and dumping, without throwing', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({
    rows: [
      { id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'gone' },
      { id: 'a1', type: 'asset', locale: 'en', folderPath: '', fileName: 'gone.png' }
    ],
    getPage: async () => null,
    getContent: async () => null
  })
  try {
    await assert.doesNotReject(dump(makeTarget(dir)))
    assert.deepEqual(await fs.readdir(dir), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('re-running dump overwrites deterministically, so a rerun after a partial failure is safe', async () => {
  const dir = await makeTempDir()
  fakeDumpDeps({
    rows: [{ id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'home' }],
    getPage: async () => ({ path: 'home', locale: 'en', contentType: 'markdown', content: 'v1' })
  })
  try {
    await dump(makeTarget(dir))
    assert.equal(await fs.readFile(path.join(dir, 'en', 'home.md'), 'utf8'), 'v1')

    // -> A second run against the same path, with the underlying content since changed, must land the
    //    new bytes rather than leaving the first run's file untouched or erroring on "already exists"
    fakeDumpDeps({
      rows: [{ id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'home' }],
      getPage: async () => ({ path: 'home', locale: 'en', contentType: 'markdown', content: 'v2' })
    })
    await dump(makeTarget(dir))
    assert.equal(await fs.readFile(path.join(dir, 'en', 'home.md'), 'utf8'), 'v2')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('dump throws a clear error naming the entry when the path becomes unwritable mid-run, leaving earlier writes in place', async () => {
  const dir = await makeTempDir()
  // -> A plain *file* sits where the second entry needs a directory, forcing an ENOTDIR write failure
  //    partway through — deterministic on every platform and every user, unlike a chmod-based
  //    permission failure, which root ignores entirely.
  await fs.mkdir(path.join(dir, 'en'), { recursive: true })
  await fs.writeFile(path.join(dir, 'en', 'blocked'), 'not a directory')

  fakeDumpDeps({
    rows: [
      { id: 'p1', type: 'page', locale: 'en', folderPath: '', fileName: 'first' },
      { id: 'p2', type: 'page', locale: 'en', folderPath: '', fileName: 'second' }
    ],
    getPage: async ({ id }) => {
      if (id === 'p1') {
        return { path: 'first', locale: 'en', contentType: 'markdown', content: 'ok' }
      }
      if (id === 'p2') {
        return { path: 'blocked/second', locale: 'en', contentType: 'markdown', content: 'ok' }
      }
      return null
    }
  })

  try {
    await assert.rejects(dump(makeTarget(dir)), /Failed to dump page "second"/)
    // -> The entry processed before the failure was still written -- dump neither rolls back nor
    //    buffers, it writes as it goes
    assert.equal(await fs.readFile(path.join(dir, 'en', 'first.md'), 'utf8'), 'ok')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// importAll()
// ---------------------------------------------------------------------------------------------

/** A target for `site-1` importing from `dir`. Active locales are set via `fakeImportDeps`. */
function makeImportTarget(dir: string): StorageTarget {
  return {
    siteId: 'site-1',
    title: 'Test Target',
    config: { path: dir }
  } as unknown as StorageTarget
}

/**
 * Points `WIKI` at fakes answering exactly what `importAll()` calls: the site's active locales, the
 * system actor id, and `tree`/`pages`/`assets` model methods. Each model method defaults to a stub
 * that would fail loudly if actually invoked, and callers override only the ones their scenario
 * exercises -- so a test that never expects e.g. `assets.upload` to run finds out immediately if it
 * does.
 */
function fakeImportDeps({
  locales = ['en'],
  getEntryAt = async () => null,
  getFolder = async ({ path: p }: { path: string }) => ({ id: `folder-${p}` }) as any,
  createPage = async () => ({ id: 'new-page-id' }) as any,
  upload = async () => ({}) as any
}: {
  locales?: string[]
  getEntryAt?: (args: any) => Promise<any>
  getFolder?: (args: any) => Promise<any>
  createPage?: (siteId: string, input: any, actor: any) => Promise<any>
  upload?: (args: any) => Promise<any>
} = {}) {
  installTestWiki({
    sites: { 'site-1': { config: { locales: { active: locales } } } },
    data: { systemIds: { userAdminId: 'admin-user-id' } },
    models: {
      // -> No `queueRerender` stub: `importPage()` no longer calls it (OpenProject #1723) --
      //    `createPage()` alone now owns queuing its own re-render, so a test whose scenario
      //    somehow still reached it would fail loudly (`TypeError`) rather than silently pass.
      tree: { getEntryAt, getFolder },
      pages: { createPage },
      assets: { upload }
    }
  })
}

async function writeFile(dir: string, ...segments: string[]): Promise<string> {
  const filePath = path.join(dir, ...segments)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  return filePath
}

test('importAll imports a markdown file as a new page', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'foo', 'home.md')
  await fs.writeFile(filePath, '# Hello')

  const createPageCalls: any[] = []
  fakeImportDeps({
    createPage: async (siteId, input, actor) => {
      createPageCalls.push({ siteId, input, actor })
      return { id: 'new-page-id' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(result.pagesSkipped, 0)
    assert.equal(createPageCalls.length, 1)
    assert.equal(createPageCalls[0].input.path, 'foo/home')
    assert.equal(createPageCalls[0].input.locale, 'en')
    assert.equal(createPageCalls[0].input.editor, 'markdown')
    assert.equal(createPageCalls[0].input.content, '# Hello')
    assert.equal(createPageCalls[0].input.title, 'Home')
    assert.equal(createPageCalls[0].actor.id, 'admin-user-id')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// -> OpenProject #926: dump() writes pages in every PAGE_EXTENSIONS extension, so importAll must
//    reverse all of them, not just .md — the rest previously fell through to importAsset and came
//    back as a binary asset row instead of a page.
test('importAll imports an asciidoc file as a page with the asciidoc editor', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'foo', 'home.adoc')
  await fs.writeFile(filePath, '= Hello')

  const createPageCalls: any[] = []
  fakeImportDeps({
    createPage: async (siteId, input, actor) => {
      createPageCalls.push({ siteId, input, actor })
      return { id: 'new-page-id' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(result.assetsWritten, 0)
    assert.equal(createPageCalls.length, 1)
    assert.equal(createPageCalls[0].input.path, 'foo/home')
    assert.equal(createPageCalls[0].input.editor, 'asciidoc')
    assert.equal(createPageCalls[0].input.content, '= Hello')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll imports an html file as a page, not an asset', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'foo', 'home.html')
  await fs.writeFile(filePath, '<p>Hello</p>')

  const createPageCalls: any[] = []
  const uploadCalls: any[] = []
  fakeImportDeps({
    createPage: async (siteId, input, actor) => {
      createPageCalls.push({ siteId, input, actor })
      return { id: 'new-page-id' } as any
    },
    upload: async (args) => {
      uploadCalls.push(args)
      return {} as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(result.assetsWritten, 0)
    assert.equal(uploadCalls.length, 0)
    assert.equal(createPageCalls[0].input.path, 'foo/home')
    assert.equal(createPageCalls[0].input.content, '<p>Hello</p>')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll imports a redirect page (.json) as a page with the redirect editor', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'old.json')
  const redirectContent = JSON.stringify({ target: '/new-path' })
  await fs.writeFile(filePath, redirectContent)

  const createPageCalls: any[] = []
  fakeImportDeps({
    createPage: async (siteId, input, actor) => {
      createPageCalls.push({ siteId, input, actor })
      return { id: 'new-page-id' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(result.assetsWritten, 0)
    assert.equal(createPageCalls[0].input.path, 'old')
    assert.equal(createPageCalls[0].input.editor, 'redirect')
    assert.equal(createPageCalls[0].input.content, redirectContent)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll skips a markdown file whose page path already exists, and does not call createPage', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'home.md')
  await fs.writeFile(filePath, '# Hello')

  let createPageCalled = false
  fakeImportDeps({
    getEntryAt: async () => ({ id: 'existing-page-id', type: 'page' }),
    createPage: async () => {
      createPageCalled = true
      return { id: 'x' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 0)
    assert.equal(result.pagesSkipped, 1)
    assert.equal(createPageCalled, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll imports a non-markdown file as an asset, resolving/creating its folder', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'images', 'logo.png')
  await fs.writeFile(filePath, 'PNGDATA')

  const uploadCalls: any[] = []
  const getFolderCalls: any[] = []
  fakeImportDeps({
    getFolder: async (args) => {
      getFolderCalls.push(args)
      return { id: 'images-folder-id' } as any
    },
    upload: async (args) => {
      uploadCalls.push(args)
      return {} as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.assetsWritten, 1)
    assert.equal(result.assetsSkipped, 0)
    assert.equal(getFolderCalls.length, 1)
    assert.equal(getFolderCalls[0].path, 'images')
    assert.equal(getFolderCalls[0].createIfMissing, true)
    assert.equal(uploadCalls.length, 1)
    assert.equal(uploadCalls[0].folderId, 'images-folder-id')
    assert.equal(uploadCalls[0].fileName, 'logo.png')
    assert.equal(uploadCalls[0].data.toString(), 'PNGDATA')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll imports an asset at the locale root with no folder, without calling getFolder', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'note.txt')
  await fs.writeFile(filePath, 'content')

  let getFolderCalled = false
  const uploadCalls: any[] = []
  fakeImportDeps({
    getFolder: async () => {
      getFolderCalled = true
      return { id: 'x' } as any
    },
    upload: async (args) => {
      uploadCalls.push(args)
      return {} as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.assetsWritten, 1)
    assert.equal(getFolderCalled, false)
    assert.equal(uploadCalls[0].folderId, undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("importAll counts an asset rejected by the site's conflict behavior as skipped, not a crash", async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'existing.txt')
  await fs.writeFile(filePath, 'content')

  fakeImportDeps({
    upload: async () => {
      throw new CustomError('assetAlreadyExists', 'A file with this name already exists here.', 409)
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.assetsWritten, 0)
    assert.equal(result.assetsSkipped, 1)
    assert.equal(result.unrecognized.length, 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll counts an asset name taken by a page or folder as skipped', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', 'taken.txt')
  await fs.writeFile(filePath, 'content')

  fakeImportDeps({
    upload: async () => {
      throw new CustomError(
        'assetNameTakenByEntry',
        'A page with this name already exists here.',
        409
      )
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.assetsSkipped, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll reports a dotfile as unrecognized rather than importing it as an asset', async () => {
  const dir = await makeTempDir()
  const filePath = await writeFile(dir, 'en', '.DS_Store')
  await fs.writeFile(filePath, 'junk')

  let uploadCalled = false
  fakeImportDeps({
    upload: async () => {
      uploadCalled = true
      return {} as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(uploadCalled, false)
    assert.equal(result.assetsWritten, 0)
    assert.equal(result.unrecognized.length, 1)
    assert.equal(result.unrecognized[0].path, 'en/.DS_Store')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll reports a top-level entry that is not an active locale as unrecognized', async () => {
  const dir = await makeTempDir()
  await fs.mkdir(path.join(dir, 'fr'), { recursive: true })
  await fs.writeFile(path.join(dir, 'stray.txt'), 'junk')

  fakeImportDeps({ locales: ['en'] })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.unrecognized.length, 2)
    const paths = result.unrecognized.map((e) => e.path).sort()
    assert.deepEqual(paths, ['fr', 'stray.txt'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll silently excludes the _manual and _daily backup folders, not reporting them as unrecognized', async () => {
  const dir = await makeTempDir()
  await fs.mkdir(path.join(dir, '_manual'), { recursive: true })
  await fs.mkdir(path.join(dir, '_daily'), { recursive: true })

  fakeImportDeps()

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.deepEqual(result.unrecognized, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll reports one failing entry without aborting the rest of the walk', async () => {
  const dir = await makeTempDir()
  await writeFile(dir, 'en', 'bad.md').then((p) => fs.writeFile(p, '# Bad'))
  await writeFile(dir, 'en', 'good.md').then((p) => fs.writeFile(p, '# Good'))

  fakeImportDeps({
    createPage: async (siteId, input) => {
      if (input.path === 'bad') {
        throw new CustomError('pageInvalidPath', 'invalid path')
      }
      return { id: 'good-page-id' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(result.unrecognized.length, 1)
    assert.equal(result.unrecognized[0].path, 'en/bad.md')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('importAll: re-running after a prior run does not duplicate an already-imported page or asset', async () => {
  const dir = await makeTempDir()
  await writeFile(dir, 'en', 'home.md').then((p) => fs.writeFile(p, '# Hello'))
  await writeFile(dir, 'en', 'logo.png').then((p) => fs.writeFile(p, 'PNGDATA'))

  // -> First run: nothing exists yet
  let pageExists = false
  let assetUploadCount = 0
  fakeImportDeps({
    getEntryAt: async () => (pageExists ? ({ id: 'p1', type: 'page' } as any) : null),
    createPage: async () => {
      pageExists = true
      return { id: 'p1' } as any
    },
    upload: async () => {
      assetUploadCount++
      return {} as any
    }
  })

  try {
    const first = await importAll(makeImportTarget(dir))
    assert.equal(first.pagesCreated, 1)
    assert.equal(assetUploadCount, 1)

    // -> Second run against the same fakes: the page now resolves as an existing occupant and is
    //    skipped; the asset upload still runs (its idempotency is `upload()`'s own `overwrite`
    //    default, exercised by the real model, not by this fake) but produces no new tree entry.
    const second = await importAll(makeImportTarget(dir))
    assert.equal(second.pagesCreated, 0)
    assert.equal(second.pagesSkipped, 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("importAll resolves each locale's same-named folder separately, rather than sharing one cached id", async () => {
  const dir = await makeTempDir()
  await writeFile(dir, 'en', 'images', 'logo.png').then((p) => fs.writeFile(p, 'EN-LOGO'))
  await writeFile(dir, 'fr', 'images', 'logo.png').then((p) => fs.writeFile(p, 'FR-LOGO'))

  const uploadCalls: any[] = []
  fakeImportDeps({
    locales: ['en', 'fr'],
    getFolder: async ({ locale }) => ({ id: `${locale}-images-folder-id` }) as any,
    upload: async (args) => {
      uploadCalls.push(args)
      return {} as any
    }
  })

  try {
    await importAll(makeImportTarget(dir))
    assert.equal(uploadCalls.length, 2)
    const byLocale = Object.fromEntries(uploadCalls.map((c) => [c.locale, c.folderId]))
    assert.equal(byLocale.en, 'en-images-folder-id')
    assert.equal(byLocale.fr, 'fr-images-folder-id')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// -> OpenProject #1723: `importPage()` used to call `queueRerender()` itself after `createPage()`,
//    best-effort (a queue failure only warned, the page still counted as imported). `createPage()`
//    now does that queuing internally whenever `render` is omitted (OpenProject #1716), so this call
//    site is a plain `createPage()` with nothing after it.
test('importAll creates a page via a plain createPage() call, with no render field and no separate queueRerender call', async () => {
  const dir = await makeTempDir()
  await writeFile(dir, 'en', 'home.md').then((p) => fs.writeFile(p, '# Hello'))

  const createPageCalls: any[] = []
  fakeImportDeps({
    createPage: async (siteId, input, actor) => {
      createPageCalls.push({ siteId, input, actor })
      return { id: 'new-page-id' } as any
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 1)
    assert.equal(createPageCalls.length, 1)
    assert.equal(createPageCalls[0].input.render, undefined)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// -> `createPage()` now consults `ensureCanRender()` *before* the write (OpenProject #1716), so a
//    missing Puppeteer refuses the create outright rather than landing a page with no render queued.
//    `importLocaleDir`'s own per-entry try/catch is what turns that into an `unrecognized` entry
//    instead of aborting the whole import.
test('importAll surfaces a createPage() failure (e.g. missing Puppeteer) as an unrecognized entry, not a silently blank page', async () => {
  const dir = await makeTempDir()
  await writeFile(dir, 'en', 'home.md').then((p) => fs.writeFile(p, '# Hello'))

  fakeImportDeps({
    createPage: async () => {
      throw new CustomError('renderPuppeteerMissing', 'Rendering needs Puppeteer.', 503)
    }
  })

  try {
    const result = await importAll(makeImportTarget(dir))
    assert.equal(result.pagesCreated, 0)
    assert.equal(result.unrecognized.length, 1)
    assert.equal(result.unrecognized[0].path, 'en/home.md')
    assert.match(result.unrecognized[0].reason, /Rendering needs Puppeteer\./)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// backup()
// ---------------------------------------------------------------------------------------------

test('backup creates the _manual folder and a timestamped tar.gz containing what was on disk', async () => {
  const dir = await makeTempDir()
  await fs.mkdir(path.join(dir, 'en'), { recursive: true })
  await fs.writeFile(path.join(dir, 'en', 'home.md'), '# Hello')
  await fs.writeFile(path.join(dir, 'note.txt'), 'root file')

  try {
    await backup(makeTarget(dir))

    const manualDir = path.join(dir, '_manual')
    const archives = await fs.readdir(manualDir)
    assert.equal(archives.length, 1)
    assert.match(archives[0], /^[\d-]+T[\d-]+Z\.tar\.gz$/)

    const entries: string[] = []
    await listTarball({
      file: path.join(manualDir, archives[0]),
      onReadEntry: (entry: { path: string }) => entries.push(entry.path)
    })
    assert.ok(entries.includes('note.txt'), 'expected the root file in the archive')
    assert.ok(entries.includes('en/home.md'), 'expected the locale folder contents in the archive')
    assert.ok(
      !entries.some((entry) => entry.startsWith('_manual')),
      'expected the _manual folder itself to be excluded from its own archive'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('backup names two calls a second apart with two distinct archives', async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, 'note.txt'), 'content')

  // -> Timestamps are second-precision (see `backup`'s doc), so proving two calls land as two
  //    distinct archives -- rather than one silently overwriting the other -- needs them a second
  //    apart. Stubbing `Temporal.Now.instant` proves that without a real sleep in the test.
  const originalInstant = Temporal.Now.instant
  const base = originalInstant()
  let call = 0
  ;(Temporal.Now as any).instant = () => base.add({ seconds: call++ })

  try {
    await backup(makeTarget(dir))
    await backup(makeTarget(dir))

    const archives = await fs.readdir(path.join(dir, '_manual'))
    assert.equal(archives.length, 2)
  } finally {
    ;(Temporal.Now as any).instant = originalInstant
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('backup throws a clear error when _manual cannot be created (path unwritable)', async () => {
  const dir = await makeTempDir()
  // -> A plain *file* already sits where `backup()` needs to create the `_manual` directory --
  //    deterministic on every platform and every user, unlike a chmod-based permission failure,
  //    which root ignores entirely.
  await fs.writeFile(path.join(dir, '_manual'), 'not a directory')
  try {
    await assert.rejects(backup(makeTarget(dir)), /Failed to create.*_manual/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// dailyBackup() / pruneDailyBackups()
// ---------------------------------------------------------------------------------------------

test('dailyBackup creates the _daily folder and a timestamped tar.gz containing what was on disk', async () => {
  const dir = await makeTempDir()
  await fs.mkdir(path.join(dir, 'en'), { recursive: true })
  await fs.writeFile(path.join(dir, 'en', 'home.md'), '# Hello')

  try {
    await dailyBackup(makeTarget(dir))

    const dailyDir = path.join(dir, '_daily')
    const archives = await fs.readdir(dailyDir)
    assert.equal(archives.length, 1)
    assert.match(archives[0], /^[\d-]+T[\d-]+Z\.tar\.gz$/)

    const entries: string[] = []
    await listTarball({
      file: path.join(dailyDir, archives[0]),
      onReadEntry: (entry: { path: string }) => entries.push(entry.path)
    })
    assert.ok(entries.includes('en/home.md'), 'expected the locale folder contents in the archive')
    assert.ok(
      !entries.some((entry) => entry.startsWith('_daily') || entry.startsWith('_manual')),
      'expected both backup folders to be excluded from the archive'
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('pruneDailyBackups does nothing when the _daily folder does not exist yet', async () => {
  const dir = await makeTempDir()
  try {
    await assert.doesNotReject(pruneDailyBackups(path.join(dir, '_daily')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('pruneDailyBackups keeps an archive under 30 days old', async () => {
  const dailyDir = await makeTempDir()
  const archive = path.join(dailyDir, '2026-01-01T00-00-00Z.tar.gz')
  await fs.writeFile(archive, 'archive')
  const now = Temporal.Now.instant()
  const mtime = now.subtract({ hours: 30 * 24 - 1 })
  await fs.utimes(archive, new Date(mtime.epochMilliseconds), new Date(mtime.epochMilliseconds))

  try {
    await pruneDailyBackups(dailyDir, now)
    assert.deepEqual(await fs.readdir(dailyDir), ['2026-01-01T00-00-00Z.tar.gz'])
  } finally {
    await fs.rm(dailyDir, { recursive: true, force: true })
  }
})

test('pruneDailyBackups removes an archive exactly 30 days old (the retention boundary)', async () => {
  const dailyDir = await makeTempDir()
  const archive = path.join(dailyDir, '2026-01-01T00-00-00Z.tar.gz')
  await fs.writeFile(archive, 'archive')
  const now = Temporal.Now.instant()
  const mtime = now.subtract({ hours: 30 * 24 })
  await fs.utimes(archive, new Date(mtime.epochMilliseconds), new Date(mtime.epochMilliseconds))

  try {
    await pruneDailyBackups(dailyDir, now)
    assert.deepEqual(await fs.readdir(dailyDir), [])
  } finally {
    await fs.rm(dailyDir, { recursive: true, force: true })
  }
})

test('pruneDailyBackups removes an archive well over 30 days old', async () => {
  const dailyDir = await makeTempDir()
  const archive = path.join(dailyDir, '2025-01-01T00-00-00Z.tar.gz')
  await fs.writeFile(archive, 'archive')
  const now = Temporal.Now.instant()
  const mtime = now.subtract({ hours: 30 * 24 + 24 })
  await fs.utimes(archive, new Date(mtime.epochMilliseconds), new Date(mtime.epochMilliseconds))

  try {
    await pruneDailyBackups(dailyDir, now)
    assert.deepEqual(await fs.readdir(dailyDir), [])
  } finally {
    await fs.rm(dailyDir, { recursive: true, force: true })
  }
})

test('pruneDailyBackups ignores non-tar.gz entries', async () => {
  const dailyDir = await makeTempDir()
  const stray = path.join(dailyDir, 'readme.txt')
  await fs.writeFile(stray, 'not an archive')
  const now = Temporal.Now.instant()
  const oldMtime = new Date(now.subtract({ hours: 30 * 24 + 24 }).epochMilliseconds)
  await fs.utimes(stray, oldMtime, oldMtime)

  try {
    await pruneDailyBackups(dailyDir, now)
    assert.deepEqual(await fs.readdir(dailyDir), ['readme.txt'])
  } finally {
    await fs.rm(dailyDir, { recursive: true, force: true })
  }
})

test('dailyBackup prunes stale archives after writing the new one', async () => {
  const dir = await makeTempDir()
  await fs.writeFile(path.join(dir, 'note.txt'), 'content')
  const dailyDir = path.join(dir, '_daily')
  await fs.mkdir(dailyDir, { recursive: true })
  const stale = path.join(dailyDir, '2020-01-01T00-00-00Z.tar.gz')
  await fs.writeFile(stale, 'old archive')
  const staleMtime = new Date(
    Temporal.Now.instant().subtract({ hours: 30 * 24 + 1 }).epochMilliseconds
  )
  await fs.utimes(stale, staleMtime, staleMtime)

  try {
    await dailyBackup(makeTarget(dir))
    const archives = await fs.readdir(dailyDir)
    assert.equal(archives.length, 1, 'expected the stale archive pruned and only the new one left')
    assert.ok(!archives.includes('2020-01-01T00-00-00Z.tar.gz'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
