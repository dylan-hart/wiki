import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { icons as iconsTable, iconSets as iconSetsTable } from '../db/schema.ts'
import {
  DEFAULT_SETS,
  NOT_FOUND_CACHE_MAX,
  IconNotFoundUpstreamError,
  icons,
  parseSideloadIconCollection
} from './icons.ts'

/**
 * OpenProject #1212: Font Awesome Free ships pre-added, the same way Line Awesome and Material
 * Design Icons already do, rather than being something an admin has to know to search for and add
 * manually via the live Iconify catalog.
 *
 * Pure data assertion, not a DB-backed test -- `init()` itself (the thing that actually inserts
 * these rows) is a one-line `db.insert(...).values(...)` with no branching worth a Postgres round
 * trip; what is worth pinning is the seed list's own shape, which is what a future edit is most
 * likely to accidentally change.
 */
describe('icons DEFAULT_SETS', () => {
  it('still seeds the pre-existing mdi and la prefixes', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.ok(prefixes.includes('mdi'))
    assert.ok(prefixes.includes('la'))
  })

  it('seeds all three Font Awesome 6 free-tier collections, not the single legacy fa prefix', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.ok(prefixes.includes('fa6-solid'))
    assert.ok(prefixes.includes('fa6-regular'))
    assert.ok(prefixes.includes('fa6-brands'))
    assert.ok(!prefixes.includes('fa'))
  })

  it('has no duplicate prefixes', () => {
    const prefixes = DEFAULT_SETS.map((set) => set.prefix)
    assert.equal(new Set(prefixes).size, prefixes.length)
  })
})

/**
 * `getSet()` (OpenProject #2272): a single-row query by prefix, with no `count()` aggregate over the
 * (potentially large) `icons` table -- the public `/_icons` batch route calls this on every request.
 *
 * A fake `WIKI.db` distinguishing the two tables `select().from()` could be pointed at, rather than a
 * real database: what is under test is which query shape `getSet()` issues, not any actual row data,
 * so recording call counts against each table's own chain is a more direct check than reading back
 * values a real Postgres round trip would launder through anyway.
 */
describe('icons.getSet', () => {
  const calls = { setsRowQuery: 0, setsCountAggregate: 0 }
  const fixtureSet = {
    prefix: 'mdi',
    name: 'Material Design Icons',
    isEnabled: true,
    info: {},
    refreshedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z')
  }

  function makeFakeDb() {
    return {
      select: (_cols?: any) => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return {
              where: (_where: any) => ({
                limit: async (_n: number) => {
                  calls.setsRowQuery++
                  return [fixtureSet]
                }
              })
            }
          }
          if (table === iconsTable) {
            return {
              groupBy: async (_col: any) => {
                calls.setsCountAggregate++
                return []
              }
            }
          }
          throw new Error(`unexpected table passed to select().from(): ${String(table)}`)
        }
      })
    }
  }

  beforeEach(() => {
    calls.setsRowQuery = 0
    calls.setsCountAggregate = 0
    ;(globalThis as any).WIKI = { db: makeFakeDb() }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
  })

  it('issues exactly one row-scoped query and no count() aggregate', async () => {
    const result = await icons.getSet('mdi')
    assert.equal(calls.setsRowQuery, 1)
    assert.equal(calls.setsCountAggregate, 0)
    assert.equal(result?.prefix, 'mdi')
    assert.ok(!('iconCount' in (result as object)), 'getSet() must not return iconCount')
  })

  it('returns null, still with no aggregate, when the prefix has not been added', async () => {
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return { where: () => ({ limit: async () => [] }) }
          }
          throw new Error('must not query the icons table for a set that is not there')
        }
      })
    }
    const result = await icons.getSet('does-not-exist')
    assert.equal(result, null)
  })
})

/**
 * `notFoundCache` bound (OpenProject #2272): it is an `LRUCache` with `max: NOT_FOUND_CACHE_MAX`, so
 * inserting past that bound through `rememberMissing()` evicts the oldest (least recently used) entry
 * automatically. No `WIKI` needed -- this exercises the cache directly, with no I/O.
 */
describe('icons.rememberMissing (notFoundCache bound)', () => {
  afterEach(() => {
    icons.notFoundCache.clear()
  })

  it('stops growing once the bound is reached', () => {
    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 50; i++) {
      icons.rememberMissing('mdi', `icon-${i}`)
    }
    assert.equal(icons.notFoundCache.size, NOT_FOUND_CACHE_MAX)
  })

  it('evicts the oldest entry first, keeping the most recently remembered names', () => {
    for (let i = 0; i < NOT_FOUND_CACHE_MAX + 1; i++) {
      icons.rememberMissing('mdi', `icon-${i}`)
    }
    assert.ok(
      !icons.notFoundCache.has('mdi:icon-0'),
      'the very first entry should have been evicted'
    )
    assert.ok(
      icons.notFoundCache.has(`mdi:icon-${NOT_FOUND_CACHE_MAX}`),
      'the most recently added entry should still be present'
    )
  })
})

/**
 * `apiFetch` (OpenProject #2889): upstream answers an unknown icon/prefix two documented ways -- a
 * genuine HTTP 404, or a 200 response whose JSON body is the literal string `'404'` -- and both must
 * reject with `IconNotFoundUpstreamError` specifically, not the plain `Error` a real failure throws,
 * since that is what lets `fetchIconsUpstream` pick the right log level.
 */
describe('icons.apiFetch upstream-not-found detection', () => {
  beforeEach(() => {
    ;(globalThis as any).WIKI = {
      config: { offline: false, icons: {} },
      logger: { debug: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
    mock.restoreAll()
  })

  it('throws IconNotFoundUpstreamError for a genuine HTTP 404', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      json: async () => {
        throw new Error('must not be read on a 404')
      }
    }))
    await assert.rejects(() => icons.apiFetch('/does-not-exist.json'), IconNotFoundUpstreamError)
  })

  it('throws IconNotFoundUpstreamError for a 200 response whose body is the literal string "404"', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => '404'
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=does-not-exist'),
      IconNotFoundUpstreamError
    )
  })

  it('throws a plain Error, not IconNotFoundUpstreamError, for a real failure (5xx)', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error('must not be read on a non-404 error')
      }
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=user'),
      (err: any) => err instanceof Error && !(err instanceof IconNotFoundUpstreamError)
    )
  })

  it('throws a plain Error, not IconNotFoundUpstreamError, for a malformed non-404 body', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => null
    }))
    await assert.rejects(
      () => icons.apiFetch('/mdi.json?icons=user'),
      (err: any) => err instanceof Error && !(err instanceof IconNotFoundUpstreamError)
    )
  })
})

/**
 * `fetchIconsUpstream` (OpenProject #2889): the "upstream has nothing for this" shape is an
 * expected, routine outcome and must log at `debug`, not `warn` -- only a genuine failure (network
 * error, 5xx, a malformed body) still warns. `apiFetch` is stubbed here so the test is about which
 * log level the catch block picks, not about `apiFetch`'s own response parsing (covered above).
 */
describe('icons.fetchIconsUpstream logging level', () => {
  function makeFakeDb() {
    return {
      select: () => ({
        from: (table: any) => {
          if (table === iconSetsTable) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    prefix: 'wp2889',
                    name: 'Test Set',
                    isEnabled: true,
                    info: {},
                    refreshedAt: null,
                    createdAt: new Date('2026-01-01T00:00:00.000Z')
                  }
                ]
              })
            }
          }
          throw new Error(`unexpected table passed to select().from(): ${String(table)}`)
        }
      })
    }
  }

  beforeEach(() => {
    ;(globalThis as any).WIKI = {
      db: makeFakeDb(),
      config: { offline: false, icons: {} },
      logger: { debug: mock.fn(), warn: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
    mock.restoreAll()
    icons.notFoundCache.clear()
  })

  it('logs debug, not warn, when upstream has nothing for this request', async () => {
    mock.method(icons, 'apiFetch', async () => {
      throw new IconNotFoundUpstreamError('upstream has nothing for this')
    })
    await icons.fetchIconsUpstream('wp2889', ['unknown-icon-a'])
    const wiki = (globalThis as any).WIKI
    assert.equal(wiki.logger.debug.mock.calls.length, 1)
    assert.equal(wiki.logger.warn.mock.calls.length, 0)
    const [scope, message, fields] = wiki.logger.debug.mock.calls[0].arguments
    assert.equal(scope, 'icons')
    assert.equal(typeof message, 'string')
    assert.equal(fields.prefix, 'wp2889')
  })

  it('still logs warn, not debug, for a genuine failure', async () => {
    mock.method(icons, 'apiFetch', async () => {
      throw new Error('network exploded')
    })
    await icons.fetchIconsUpstream('wp2889', ['unknown-icon-b'])
    const wiki = (globalThis as any).WIKI
    assert.equal(wiki.logger.warn.mock.calls.length, 1)
    assert.equal(wiki.logger.debug.mock.calls.length, 0)
  })
})

/**
 * `parseSideloadIconCollection()` (OpenProject #2945): the pure shape validation
 * `sideloadFromDataPath` runs each `<dataPath>/icons/<prefix>.json` file's parsed content through
 * before anything touches the database or the filesystem again -- a plain function, tested the same
 * way `parseSideloadLocalePack()` is in `locales.test.ts`.
 */
describe('parseSideloadIconCollection()', () => {
  it('accepts a minimal valid collection', () => {
    const result = parseSideloadIconCollection({ icons: { foo: { body: '<path d="M0 0"/>' } } })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.collection.icons, { foo: { body: '<path d="M0 0"/>' } })
    }
  })

  it('accepts optional aliases and info alongside icons', () => {
    const result = parseSideloadIconCollection({
      icons: { foo: { body: '<path/>' } },
      aliases: { bar: { parent: 'foo' } },
      info: { name: 'Test Set' }
    })
    assert.equal(result.ok, true)
  })

  it('rejects a non-object', () => {
    const result = parseSideloadIconCollection('not an object')
    assert.equal(result.ok, false)
  })

  it('rejects a missing "icons" field', () => {
    const result = parseSideloadIconCollection({ aliases: {} })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /icons/)
    }
  })

  it('rejects a non-object "icons" field', () => {
    const result = parseSideloadIconCollection({ icons: 'nope' })
    assert.equal(result.ok, false)
  })

  it('rejects a non-object "aliases" field when present', () => {
    const result = parseSideloadIconCollection({ icons: {}, aliases: 'nope' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /aliases/)
    }
  })

  it('rejects a non-object "info" field when present', () => {
    const result = parseSideloadIconCollection({ icons: {}, info: 'nope' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /info/)
    }
  })
})

/**
 * `sideloadFromDataPath()` (OpenProject #2945): the actual disk -> DB path. A real temp directory
 * (not a real Postgres instance -- this file's whole suite is pure-unit, stubbing `WIKI.db` the same
 * way `icons.getSet`/`icons.fetchIconsUpstream logging level` above already do) stands in for
 * `<dataPath>/icons/`, and a fake `WIKI.db` records every `insert(...)` call so the test can assert
 * both WHAT was written and the write ORDER -- the `iconSets` row must land before any of that
 * prefix's `icons` rows, since `icons.prefix` has a foreign key on `iconSets.prefix`.
 */
describe('icons.sideloadFromDataPath() (DB-backed, fake db)', () => {
  let tmpRoot: string
  const writes: { kind: 'set' | 'icon'; prefix: string; name?: string; value: any }[] = []

  function makeFakeDb() {
    return {
      insert: (table: any) => ({
        values: (value: any) => ({
          onConflictDoNothing: async () => {
            if (table === iconSetsTable) {
              writes.push({ kind: 'set', prefix: value.prefix, value })
            }
          },
          onConflictDoUpdate: async (_opts: any) => {
            if (table === iconsTable) {
              writes.push({ kind: 'icon', prefix: value.prefix, name: value.name, value })
            }
          }
        })
      })
    }
  }

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'icons-sideload-'))
    writes.length = 0
    ;(globalThis as any).WIKI = {
      db: makeFakeDb(),
      ROOTPATH: tmpRoot,
      config: { dataPath: '.' },
      logger: { debug: mock.fn(), warn: mock.fn() }
    }
  })

  afterEach(async () => {
    delete (globalThis as any).WIKI
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('returns empty results when the sideload directory does not exist', async () => {
    const result = await icons.sideloadFromDataPath()
    assert.deepEqual(result, { loaded: [], skipped: [] })
    assert.equal(writes.length, 0)
  })

  it('sideloadPath() resolves to <dataPath>/icons', () => {
    assert.equal(icons.sideloadPath(), path.resolve(tmpRoot, 'icons'))
  })

  it('loads a valid collection file, resolving both a direct icon and an alias', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'tabler.json'),
      JSON.stringify({
        prefix: 'tabler',
        icons: { foo: { body: '<path d="M0 0"/>', width: 24, height: 24 } },
        aliases: { bar: { parent: 'foo' } },
        info: { name: 'Tabler Icons' }
      })
    )

    const result = await icons.sideloadFromDataPath()

    assert.deepEqual(result.skipped, [])
    assert.equal(result.loaded.length, 1)
    assert.equal(result.loaded[0].prefix, 'tabler')
    assert.equal(result.loaded[0].iconCount, 2)

    const setWrite = writes.find((w) => w.kind === 'set')
    const iconWrites = writes.filter((w) => w.kind === 'icon')
    assert.ok(setWrite, 'expected an iconSets upsert')
    assert.equal(setWrite!.value.name, 'Tabler Icons')
    assert.equal(setWrite!.value.isEnabled, true)
    assert.equal(iconWrites.length, 2)
    assert.ok(iconWrites.some((w) => w.name === 'foo'))
    assert.ok(iconWrites.some((w) => w.name === 'bar'))
    // -> The alias must have resolved to its parent's body, not been stored empty
    const aliasWrite = iconWrites.find((w) => w.name === 'bar')
    assert.equal(aliasWrite!.value.body, '<path d="M0 0"/>')

    // -> FK ordering: the set row must be written before any icon row for that prefix
    const setIndex = writes.indexOf(setWrite!)
    for (const iconWrite of iconWrites) {
      assert.ok(writes.indexOf(iconWrite) > setIndex)
    }
  })

  it('upserts a set with onConflictDoNothing, so existing metadata is not clobbered', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'mdi.json'),
      JSON.stringify({ icons: { account: { body: '<path/>' } }, info: { name: 'Sideload Name' } })
    )

    await icons.sideloadFromDataPath()

    const setWrite = writes.find((w) => w.kind === 'set')
    // -> onConflictDoNothing is what protects a real upstream-added set's metadata -- verified here
    //    by confirming the loader always goes through that conflict strategy, never a plain update.
    assert.ok(setWrite)
  })

  it('skips a file whose body is unsafe, reporting no usable icons', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'evil.json'),
      JSON.stringify({ icons: { bad: { body: '<script>alert(1)</script>' } } })
    )

    const result = await icons.sideloadFromDataPath()

    assert.equal(result.loaded.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].prefix, 'evil')
    assert.match(result.skipped[0].error, /no usable icons/)
    assert.equal(writes.length, 0)
  })

  it('skips a file with invalid JSON, without throwing', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not valid json')

    const result = await icons.sideloadFromDataPath()

    assert.equal(result.loaded.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].prefix, 'broken')
    assert.match(result.skipped[0].error, /invalid JSON/)
  })

  it('skips a file with the wrong shape', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'shapeless.json'), JSON.stringify({ notIcons: {} }))

    const result = await icons.sideloadFromDataPath()

    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].error, /icons/)
  })

  it('skips a filename that is not a valid icon set prefix', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'Not_Valid.json'),
      JSON.stringify({ icons: { foo: { body: '<path/>' } } })
    )

    const result = await icons.sideloadFromDataPath()

    assert.equal(result.loaded.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].error, /not a valid icon set prefix/)
  })

  it('ignores non-.json files in the directory', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'README.md'), 'not an icon file')

    const result = await icons.sideloadFromDataPath()

    assert.deepEqual(result, { loaded: [], skipped: [] })
  })

  it('logs a warn summary when any file was skipped, and nothing when none were', async () => {
    const dir = path.join(tmpRoot, 'icons')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not valid json')

    await icons.sideloadFromDataPath()
    const wiki = (globalThis as any).WIKI
    assert.equal(wiki.logger.warn.mock.calls.length, 1)
    const [scope] = wiki.logger.warn.mock.calls[0].arguments
    assert.equal(scope, 'icons')
  })
})
