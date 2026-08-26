import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, mock, test } from 'node:test'
import zlib from 'node:zlib'
import { NotYetImplementedError, type SourceRecord } from '../connector.ts'
import { ExportBundleSourceConnector, JsonArrayStreamParser } from './export-bundle.ts'

/**
 * Smoke coverage for `ExportBundleSourceConnector`, scoped to exactly what this task builds: the
 * connect/disconnect/describe lifecycle, missing-file/empty-directory detection, and the shape checks
 * on the three small files it actually parses (`settings.json`, `navigation.json`, `groups.json`) —
 * plus, for Task 733, the `pages()`/`pageHistory()`/`tags()`/`navigation()` generator bodies.
 */

const tmpDirs: string[] = []

async function makeBundle(files: Record<string, string | Buffer | null>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-migration-bundle-'))
  tmpDirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name)
    if (content === null) {
      // A directory entry (used for `assets`) rather than a file.
      await fs.mkdir(filePath, { recursive: true })
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }
  }
  return dir
}

/** Mirrors the exporter's own pipeline for a `.json.gz` entity file: pretty-printed JSON array text,
 * gzip'd — see `docs/migration/2.5x-export-bundle-format.md`'s "Every gzip'd file is written by the
 * exact same three-stage pipeline" note. */
function gzipJsonArray(rows: SourceRecord[]): Buffer {
  return zlib.gzipSync(JSON.stringify(rows, null, 2))
}

after(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const validSettings = JSON.stringify({ title: 'Test Wiki', modules: { storage: [] } })
const validNavigation = JSON.stringify({ site: [{ id: 'home', label: 'Home' }] })
const groupsAtFloor = JSON.stringify([{ id: 1, name: 'Administrators', redirectOnLogin: '/' }])
const groupsBelowFloor = JSON.stringify([{ id: 1, name: 'Administrators' }])

describe('JsonArrayStreamParser (Task 1783 — streaming boundary walker behind readGzipJsonArray)', () => {
  test('yields a completed row as soon as its own chunk arrives, before any later row has been fed', () => {
    const parser = new JsonArrayStreamParser('fixture.json')
    const firstRow = { id: 1, note: 'first' }
    const secondRow = { id: 2, note: 'second' }

    // The first chunk carries the whole first row plus only the *start* of the second row's text —
    // proving the parser doesn't need the rest of the array's text to hand back a completed row.
    const firstChunk = `[${JSON.stringify(firstRow)},${JSON.stringify(secondRow).slice(0, 5)}`
    const firstYield = [...parser.push(firstChunk)]
    assert.deepEqual(firstYield, [firstRow])

    const secondChunk = JSON.stringify(secondRow).slice(5) + ']'
    const secondYield = [...parser.push(secondChunk)]
    assert.deepEqual(secondYield, [secondRow])

    assert.doesNotThrow(() => parser.finish())
  })

  test('does not mistake structural characters inside a string value for object boundaries', () => {
    const parser = new JsonArrayStreamParser('fixture.json')
    const row = { title: 'a {tricky}, [odd] value', tags: [{ tag: 'x', title: null }] }
    const yielded = [...parser.push(`[${JSON.stringify(row)}]`)]
    assert.deepEqual(yielded, [row])
    assert.doesNotThrow(() => parser.finish())
  })

  test('yields nothing for an empty array and finish() does not throw', () => {
    const parser = new JsonArrayStreamParser('fixture.json')
    assert.deepEqual([...parser.push('[]')], [])
    assert.doesNotThrow(() => parser.finish())
  })

  test('finish() throws when the array never closed (truncated stream)', () => {
    const parser = new JsonArrayStreamParser('fixture.json')
    assert.deepEqual([...parser.push('[{"id":1}')], [{ id: 1 }])
    assert.throws(() => parser.finish(), /does not contain a JSON array/)
  })

  test('push() throws immediately when the top-level value is not an array', () => {
    const parser = new JsonArrayStreamParser('fixture.json')
    assert.throws(() => [...parser.push('{"notAnArray":true}')], /does not contain a JSON array/)
  })
})

describe('ExportBundleSourceConnector', () => {
  test('rejects a nonexistent path', async () => {
    const connector = new ExportBundleSourceConnector('/does/not/exist/at/all')
    await assert.rejects(() => connector.connect(), /is not a directory/)
  })

  test('rejects a directory with none of the expected export files', async () => {
    const dir = await makeBundle({ 'readme.txt': 'not a bundle' })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.connect(), /does not look like a 2\.5\.x export bundle/)
  })

  test('rejects a bundle whose settings.json lacks the expected "modules" key', async () => {
    const dir = await makeBundle({ 'settings.json': JSON.stringify({ title: 'Test Wiki' }) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(
      () => connector.connect(),
      /settings\.json does not have the expected shape/
    )
  })

  test('rejects a bundle whose navigation.json is an array instead of a keyed object', async () => {
    const dir = await makeBundle({ 'navigation.json': JSON.stringify([{ key: 'site' }]) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(
      () => connector.connect(),
      /navigation\.json does not have the expected shape/
    )
  })

  test('rejects a bundle whose groups.json is not an array', async () => {
    const dir = await makeBundle({ 'groups.json': JSON.stringify({ notAnArray: true }) })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.connect(), /groups\.json does not have the expected shape/)
  })

  test('connects against a full, valid bundle and reports the detected entities and version floor', async () => {
    const dir = await makeBundle({
      'settings.json': validSettings,
      'navigation.json': validNavigation,
      'groups.json': groupsAtFloor,
      'users.json.gz': 'irrelevant-binary-stand-in',
      'pages.json.gz': 'irrelevant-binary-stand-in',
      'pages-history.json.gz': 'irrelevant-binary-stand-in',
      'comments.json.gz': 'irrelevant-binary-stand-in',
      assets: null
    })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    const description = await connector.describe()
    assert.equal(description.kind, 'export-bundle')
    assert.equal(description.location, dir)
    assert.equal(description.version, '>=2.5.12')
    assert.ok(
      description.notes.some(
        (n) => n.includes('Detected entities:') && n.includes('users') && n.includes('assets')
      )
    )
    assert.ok(description.notes.some((n) => n.includes('settings.json parses as an object')))
    assert.ok(description.notes.some((n) => n.includes('navigation.json parses as a keyed object')))
    assert.ok(description.notes.some((n) => n.includes('at or after 2.5.12')))
    await connector.disconnect()
  })

  test('connects against a partial bundle (only groups.json) and flags a pre-2.5.12 source', async () => {
    const dir = await makeBundle({ 'groups.json': groupsBelowFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    const description = await connector.describe()
    assert.equal(description.version, undefined)
    assert.ok(description.notes.some((n) => n.includes('predates 2.5.12')))
  })

  test('describe() throws when called before connect()', async () => {
    const dir = await makeBundle({ 'groups.json': groupsAtFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await assert.rejects(() => connector.describe(), /before a successful connect/)
  })

  test('users/groups/settings/assets generators remain deferred stubs (owned by other tasks)', async () => {
    const dir = await makeBundle({ 'groups.json': groupsAtFloor })
    const connector = new ExportBundleSourceConnector(dir)
    await connector.connect()
    for (const method of ['users', 'groups', 'settings', 'assets'] as const) {
      assert.throws(() => connector[method](), NotYetImplementedError)
    }
  })

  describe('pages()/pageHistory()/tags()/navigation() (Task 733)', () => {
    const pageRow: SourceRecord = {
      id: 1,
      path: 'welcome',
      localeCode: 'en',
      title: 'Welcome',
      authorId: 10,
      creatorId: 10,
      tags: [{ tag: 'intro', title: 'Intro' }]
    }
    const historyRow: SourceRecord = {
      id: 100,
      pageId: 1,
      versionDate: '2020-01-01T00:00:00.000Z',
      authorId: 10,
      tags: [
        { tag: 'intro', title: 'Intro' },
        { tag: 'draft', title: null }
      ]
    }

    async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
      const out: T[] = []
      for await (const item of iterable) out.push(item)
      return out
    }

    test('pages() yields every row out of pages.json.gz', async () => {
      const dir = await makeBundle({ 'pages.json.gz': gzipJsonArray([pageRow]) })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.pages())
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, 1)
      assert.equal(rows[0].path, 'welcome')
    })

    test('pages() yields every row across a many-row file, in order (Task 1783 streaming round trip)', async () => {
      const rows: SourceRecord[] = Array.from({ length: 500 }, (_, n) => ({
        id: n,
        path: `page-${n}`,
        localeCode: 'en',
        title: `Page ${n}`,
        tags: [{ tag: `tag-${n % 7}`, title: null }]
      }))
      const dir = await makeBundle({ 'pages.json.gz': gzipJsonArray(rows) })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const collected = await collect(connector.pages())
      assert.equal(collected.length, 500)
      assert.deepEqual(
        collected.map((r) => r.id),
        rows.map((r) => r.id)
      )
    })

    test('pages() rejects a pages.json.gz whose decompressed content is not a JSON array', async () => {
      const dir = await makeBundle({
        'pages.json.gz': zlib.gzipSync(JSON.stringify({ notAnArray: true }))
      })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      await assert.rejects(() => collect(connector.pages()), /does not contain a JSON array/)
    })

    test('pages() yields nothing when pages.json.gz is absent (entity was not exported)', async () => {
      const dir = await makeBundle({ 'groups.json': groupsAtFloor })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.pages())
      assert.deepEqual(rows, [])
    })

    test('pageHistory() yields every row out of pages-history.json.gz', async () => {
      const dir = await makeBundle({ 'pages-history.json.gz': gzipJsonArray([historyRow]) })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.pageHistory())
      assert.equal(rows.length, 1)
      assert.equal(rows[0].pageId, 1)
    })

    test('navigation() re-expands the {key: config} object back into (key, config) rows', async () => {
      const dir = await makeBundle({ 'navigation.json': validNavigation })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.navigation())
      assert.deepEqual(rows, [{ key: 'site', config: [{ id: 'home', label: 'Home' }] }])
    })

    test('navigation() yields nothing when navigation.json is absent', async () => {
      const dir = await makeBundle({ 'groups.json': groupsAtFloor })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.navigation())
      assert.deepEqual(rows, [])
    })

    test('tags() derives a deduplicated tag list from pages() and pageHistory(), since the bundle has no dedicated tags file', async () => {
      const dir = await makeBundle({
        'pages.json.gz': gzipJsonArray([pageRow]),
        'pages-history.json.gz': gzipJsonArray([historyRow])
      })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.tags())
      const tags = rows.map((r) => r.tag).sort()
      assert.deepEqual(tags, ['draft', 'intro'])
    })

    test('tags() issues no additional read of pages.json.gz/pages-history.json.gz once both have already been walked (Task 1786)', async () => {
      const dir = await makeBundle({
        'pages.json.gz': gzipJsonArray([pageRow]),
        'pages-history.json.gz': gzipJsonArray([historyRow])
      })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()

      // Fully drain pages() and pageHistory() first, the same order phases/content.ts's contentPhase
      // drives its entities in.
      await collect(connector.pages())
      await collect(connector.pageHistory())

      // From here, readGzipJsonArray (the method that actually opens and decompresses an entity file)
      // must not be called again for a subsequent tags() call.
      let readCalls = 0
      const original = (connector as any).readGzipJsonArray.bind(connector)
      mock.method(connector as any, 'readGzipJsonArray', function (filePath: string) {
        readCalls++
        return original(filePath)
      })

      const rows = await collect(connector.tags())
      const tags = rows.map((r) => r.tag).sort()
      assert.deepEqual(tags, ['draft', 'intro'])
      assert.equal(readCalls, 0)
    })

    test('tags() still derives the correct tag set when called with no prior pages()/pageHistory() walk', async () => {
      const dir = await makeBundle({
        'pages.json.gz': gzipJsonArray([pageRow]),
        'pages-history.json.gz': gzipJsonArray([historyRow])
      })
      const connector = new ExportBundleSourceConnector(dir)
      await connector.connect()
      const rows = await collect(connector.tags())
      const tags = rows.map((r) => r.tag).sort()
      assert.deepEqual(tags, ['draft', 'intro'])
    })

    test('every generator throws when called before connect()', async () => {
      const dir = await makeBundle({ 'pages.json.gz': gzipJsonArray([pageRow]) })
      const connector = new ExportBundleSourceConnector(dir)
      for (const method of ['pages', 'pageHistory', 'tags', 'navigation'] as const) {
        assert.throws(() => connector[method](), /before a successful connect/)
      }
    })
  })
})
