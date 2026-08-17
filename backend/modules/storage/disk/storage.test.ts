import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { list as listTarball } from 'tar'
import diskStorageModule, { validateConfig, dump, backup } from './storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Exercises `validateConfig`, `dump` and `backup` entirely against the real filesystem (temp
 * directories, cleaned up after each test) with `WIKI.db` / `WIKI.models.pages` /
 * `WIKI.models.assets` stubbed rather than a real Postgres instance — what this module has to get
 * right is filesystem behavior (paths, directory creation, archive contents, surfacing a write
 * failure), not SQL, so a stub answering the exact `select().from().where().orderBy()` chain
 * `listSiteEntries` builds is enough to drive it.
 */
before(async () => {
  if (typeof Temporal === 'undefined') {
    const polyfill = await import('@js-temporal/polyfill')
    ;(globalThis as any).Temporal = polyfill.Temporal
  }
})

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-disk-storage-test-'))
}

/** A minimal target for `site-1` configured to write to `dir` -- all `dump`/`backup` read from it. */
function makeTarget(dir: string): StorageTarget {
  return { siteId: 'site-1', config: { path: dir } } as unknown as StorageTarget
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
  global.WIKI = {
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
  } as unknown as WikiGlobal
}

test('diskStorageModule declares validateConfig, dump and backup', () => {
  assert.deepEqual(Object.keys(diskStorageModule).sort(), ['backup', 'dump', 'validateConfig'])
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
