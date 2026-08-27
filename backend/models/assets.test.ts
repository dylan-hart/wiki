import { test, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { assets } from './assets.ts'
import type { StorageTarget } from './storage.ts'

/**
 * Exercises `readContent()`'s target-awareness — `governingTarget`, `directUrlFor`, and the
 * `assetDelivery.streaming` branch itself — with `WIKI.db` / `WIKI.models.storage` stubbed rather
 * than a real Postgres instance. What this has to get right is which path gets taken (disk cache vs.
 * buffered read vs. redirect) for a given target configuration, not SQL, so a stub answering exactly
 * the calls each path makes is enough to drive it — and, crucially, lets a test assert a path was
 * *not* taken (e.g. the disk cache never touched with streaming off) by having the stub throw if
 * called.
 */
before(() => {
  global.WIKI = {
    logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  } as unknown as WikiGlobal
})

const testAsset = {
  id: 'asset-1',
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  fileName: 'x.png',
  folderPath: '',
  kind: 'image' as const,
  fileSize: 1000
}

/** A db-module target, as `getSiteTargets` would shape one, with `assetDelivery` overridable. */
function makeDbTarget(
  assetDelivery: Partial<StorageTarget['assetDelivery']> = {},
  overrides: Partial<StorageTarget> = {}
): StorageTarget {
  return {
    id: 'target-db',
    siteId: 'site-1',
    module: 'db',
    isEnabled: true,
    title: 'Database',
    description: '',
    icon: '',
    banner: '',
    vendor: '',
    website: '',
    contentTypes: { activeTypes: [], largeThreshold: '5MB' },
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: true,
      streaming: true,
      directAccess: false,
      ...assetDelivery
    },
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: false
    },
    props: {},
    config: {},
    actions: [],
    ...overrides
  }
}

/** Stubs the pieces of `WIKI.models.storage` that `readContent()`'s target-aware path calls. */
function stubStorage({
  targets = [],
  ensureModule = async () => null
}: {
  targets?: StorageTarget[]
  ensureModule?: (key: string) => Promise<any>
} = {}) {
  global.WIKI = {
    ...global.WIKI,
    models: {
      ...(global.WIKI as any).models,
      storage: {
        getSiteTargets: async () => targets,
        ensureModule
      }
    }
  } as unknown as WikiGlobal
}

/** Stubs `WIKI.db`'s `getContent()` chain to answer with (or without) a row. */
function stubDb(row: { data: Buffer; mimeType: string; fileName: string } | undefined) {
  global.WIKI = {
    ...global.WIKI,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(row ? [row] : [])
          })
        })
      })
    }
  } as unknown as WikiGlobal
}

/** Fails the test if called — for asserting a path was never taken. */
function unreachable(label: string) {
  return async () => {
    throw new Error(`should not have been called: ${label}`)
  }
}

// ---------------------------------------------------------------------------------------------
// governingTarget()
// ---------------------------------------------------------------------------------------------

test('governingTarget picks the enabled db-module target among several', async () => {
  const dbTarget = makeDbTarget()
  const diskTarget = { ...makeDbTarget(), id: 'target-disk', module: 'disk' }
  stubStorage({ targets: [diskTarget, dbTarget] })
  const found = await assets.governingTarget('site-1')
  assert.equal(found?.id, 'target-db')
})

test('governingTarget ignores a disabled db-module row', async () => {
  stubStorage({ targets: [makeDbTarget({}, { isEnabled: false })] })
  assert.equal(await assets.governingTarget('site-1'), null)
})

test('governingTarget returns null when the site has no targets at all', async () => {
  stubStorage({ targets: [] })
  assert.equal(await assets.governingTarget('site-1'), null)
})

test('governingTarget prefers an enabled direct-access target that covers the asset over db', async () => {
  const dbTarget = makeDbTarget()
  const s3Target = makeDbTarget(
    { directAccess: true, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    }
  )
  stubStorage({ targets: [dbTarget, s3Target] })
  const found = await assets.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
  assert.equal(found?.id, 'target-s3')
})

test('governingTarget falls back to db when the direct-access target does not cover the asset kind', async () => {
  const dbTarget = makeDbTarget()
  const s3Target = makeDbTarget(
    { directAccess: true, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      contentTypes: { activeTypes: ['documents'], largeThreshold: '5MB' }
    }
  )
  stubStorage({ targets: [dbTarget, s3Target] })
  const found = await assets.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
  assert.equal(found?.id, 'target-db')
})

test('governingTarget falls back to db when the direct-access target is disabled', async () => {
  const dbTarget = makeDbTarget()
  const s3Target = makeDbTarget(
    { directAccess: true, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      isEnabled: false,
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    }
  )
  stubStorage({ targets: [dbTarget, s3Target] })
  const found = await assets.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
  assert.equal(found?.id, 'target-db')
})

test('governingTarget falls back to db when the direct-access target has directAccess turned off', async () => {
  const dbTarget = makeDbTarget()
  const s3Target = makeDbTarget(
    { directAccess: false, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    }
  )
  stubStorage({ targets: [dbTarget, s3Target] })
  const found = await assets.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
  assert.equal(found?.id, 'target-db')
})

test('governingTarget ignores content-type matching entirely when called with no asset', async () => {
  const dbTarget = makeDbTarget()
  const s3Target = makeDbTarget(
    { directAccess: true, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    }
  )
  stubStorage({ targets: [dbTarget, s3Target] })
  const found = await assets.governingTarget('site-1')
  assert.equal(found?.id, 'target-db')
})

// ---------------------------------------------------------------------------------------------
// directUrlFor()
// ---------------------------------------------------------------------------------------------

test('directUrlFor returns null without consulting the module when directAccess is off', async () => {
  const target = makeDbTarget({ directAccess: false, isDirectAccessSupported: true })
  stubStorage({ targets: [target], ensureModule: unreachable('ensureModule') })
  assert.equal(await assets.directUrlFor(testAsset, target), null)
})

test('directUrlFor returns null when the definition does not support direct access, even if directAccess is on', async () => {
  const target = makeDbTarget({ directAccess: true, isDirectAccessSupported: false })
  stubStorage({ targets: [target], ensureModule: unreachable('ensureModule') })
  assert.equal(await assets.directUrlFor(testAsset, target), null)
})

test('directUrlFor returns null when the module has no getDirectUrl', async () => {
  const target = makeDbTarget({ directAccess: true, isDirectAccessSupported: true })
  stubStorage({ targets: [target], ensureModule: async () => ({}) })
  assert.equal(await assets.directUrlFor(testAsset, target), null)
})

test('directUrlFor returns the module URL when everything lines up', async () => {
  const target = makeDbTarget({ directAccess: true, isDirectAccessSupported: true })
  let calledWith: any
  stubStorage({
    targets: [target],
    ensureModule: async () => ({
      getDirectUrl: async (asset: any, t: any) => {
        calledWith = { asset, t }
        return 'https://cdn.example.com/asset-1'
      }
    })
  })
  assert.equal(await assets.directUrlFor(testAsset, target), 'https://cdn.example.com/asset-1')
  assert.equal(calledWith.asset.id, 'asset-1')
  assert.equal(calledWith.t.id, 'target-db')
})

// ---------------------------------------------------------------------------------------------
// readContent() — streaming on/off and the directAccess hook, wired together
// ---------------------------------------------------------------------------------------------

test('readContent, streaming on (the default), reads the disk cache first and never touches the db when it hits', async () => {
  const target = makeDbTarget({ streaming: true })
  stubStorage({ targets: [target] })
  stubDb(undefined) // -> getContent() would fail the test if this test path reaches it
  const originalReadCache = assets.readContentCache
  const originalGetContent = assets.getContent
  let cacheHit = false
  assets.readContentCache = async () => {
    cacheHit = true
    return { body: 'stream-stand-in' as any, size: 42 }
  }
  assets.getContent = unreachable('getContent') as any
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.ok(cacheHit)
    assert.deepEqual(result, { body: 'stream-stand-in', size: 42 })
  } finally {
    assets.readContentCache = originalReadCache
    assets.getContent = originalGetContent
  }
})

test('readContent, streaming on, falls back to the db and writes the cache back on a cache miss', async () => {
  const target = makeDbTarget({ streaming: true })
  stubStorage({ targets: [target] })
  stubDb({ data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'x.png' })
  const originalReadCache = assets.readContentCache
  const originalWriteCache = assets.writeContentCache
  let wroteCache: any
  assets.readContentCache = async () => null
  assets.writeContentCache = async (asset, data) => {
    wroteCache = { asset, data }
  }
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: Buffer.from('bytes'), size: 5 })
    assert.equal(wroteCache.asset.id, 'asset-1')
    assert.deepEqual(wroteCache.data, Buffer.from('bytes'))
  } finally {
    assets.readContentCache = originalReadCache
    assets.writeContentCache = originalWriteCache
  }
})

test('readContent, streaming off, never touches the disk cache and always serves the buffer', async () => {
  const target = makeDbTarget({ streaming: false })
  stubStorage({ targets: [target] })
  stubDb({ data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'x.png' })
  const originalReadCache = assets.readContentCache
  const originalWriteCache = assets.writeContentCache
  assets.readContentCache = unreachable('readContentCache') as any
  assets.writeContentCache = unreachable('writeContentCache') as any
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: Buffer.from('bytes'), size: 5 })
  } finally {
    assets.readContentCache = originalReadCache
    assets.writeContentCache = originalWriteCache
  }
})

test('readContent checks directAccess before streaming, and returns a redirectUrl without touching the cache or db', async () => {
  const target = makeDbTarget({
    directAccess: true,
    isDirectAccessSupported: true,
    streaming: true
  })
  stubStorage({
    targets: [target],
    ensureModule: async () => ({ getDirectUrl: async () => 'https://cdn.example.com/asset-1' })
  })
  const originalReadCache = assets.readContentCache
  assets.readContentCache = unreachable('readContentCache') as any
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { redirectUrl: 'https://cdn.example.com/asset-1' })
  } finally {
    assets.readContentCache = originalReadCache
  }
})

test('readContent falls through to the normal path when the module has directAccess on but returns no URL', async () => {
  const target = makeDbTarget({
    directAccess: true,
    isDirectAccessSupported: true,
    streaming: true
  })
  stubStorage({
    targets: [target],
    ensureModule: async () => ({ getDirectUrl: async () => null })
  })
  const originalReadCache = assets.readContentCache
  assets.readContentCache = async () => ({ body: 'stream-stand-in' as any, size: 1 })
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: 'stream-stand-in', size: 1 })
  } finally {
    assets.readContentCache = originalReadCache
  }
})

test('readContent redirects through a non-db direct-access target (e.g. s3) that covers the asset, over db', async () => {
  const dbTarget = makeDbTarget({ streaming: true })
  const s3Target = makeDbTarget(
    { directAccess: true, isDirectAccessSupported: true },
    {
      id: 'target-s3',
      module: 's3',
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    }
  )
  stubStorage({
    targets: [dbTarget, s3Target],
    ensureModule: async (key: string) =>
      key === 's3' ? { getDirectUrl: async () => 'https://bucket.example.com/asset-1' } : null
  })
  const originalReadCache = assets.readContentCache
  assets.readContentCache = unreachable('readContentCache') as any
  try {
    const result = await assets.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { redirectUrl: 'https://bucket.example.com/asset-1' })
  } finally {
    assets.readContentCache = originalReadCache
  }
})

test('readContent defaults to streaming on when the site has no governing target row', async () => {
  stubStorage({ targets: [] })
  const originalReadCache = assets.readContentCache
  let cacheChecked = false
  assets.readContentCache = async () => {
    cacheChecked = true
    return { body: 'stream-stand-in' as any, size: 1 }
  }
  try {
    await assets.readContent(testAsset, 'site-1')
    assert.ok(cacheChecked)
  } finally {
    assets.readContentCache = originalReadCache
  }
})

test('readContent returns null when the asset row is gone, whichever path was taken', async () => {
  const target = makeDbTarget({ streaming: false })
  stubStorage({ targets: [target] })
  stubDb(undefined)
  assert.equal(await assets.readContent(testAsset, 'site-1'), null)
})

// ---------------------------------------------------------------------------------------------
// upload() / renameAsset() / deleteAsset() — hooks.emit and storage.dispatch are awaited, not
// detached (OpenProject #1697)
// ---------------------------------------------------------------------------------------------

/**
 * A `WIKI.db`-shaped stub sufficient for the tests below: every `select(...)` chain terminates at
 * `.limit()` with a fixed asset row (what `getAsset()` reads), and every `update()`/`delete()`/
 * `insert()` chain resolves to itself — none of the four methods under test reads back an
 * update/delete/insert result, only whether the row-mutating call was awaited in sequence.
 */
function makeAssetsDbStub(assetRow: unknown) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    set: () => chain,
    values: () => chain,
    limit: () => Promise.resolve([assetRow])
  }
  return {
    select: () => chain,
    update: () => chain,
    delete: () => chain,
    insert: () => chain
  }
}

/**
 * A `hooks.emit`/`storage.dispatch`-shaped mock that only resolves after a real tick
 * (`setImmediate`), and records into `order` when it does. If the method under test only fired the
 * call without awaiting it, the method's own promise would resolve — and the assertion below would
 * run — before this mock's `order` push ever happens.
 */
function delayedDispatchMock(order: string[], label: string) {
  return mock.fn(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    order.push(label)
  })
}

/** Minimal filesystem-adjacent `WIKI` bits `dropCachedContent()` needs — a cache dir that never
 *  exists, so its `fs.readdir` throws ENOENT and is silently caught, same as a fresh instance. */
const cacheFsStubs = {
  ROOTPATH: '/tmp',
  config: { dataPath: 'wiki-assets-test-no-such-cache-dir' }
}

test('upload (new file) awaits both asset:upload hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'new' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.WIKI as any).models,
      tree: {
        addAsset: async () => ({
          id: 'asset-1',
          fileName: 'test.txt',
          folderPath: '',
          title: 'test.txt',
          createdAt: new Date(),
          updatedAt: new Date()
        })
      },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as WikiGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.WIKI as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.WIKI as any).models.storage.dispatch.mock.callCount(), 1)
})

test('upload (overwrite of an existing asset) awaits both asset:edit hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.WIKI as any).models,
      tree: {
        getEntryAt: async () => ({
          type: 'asset',
          id: 'asset-1',
          fileName: 'test.txt',
          folderPath: '',
          title: 'test.txt'
        }),
        addAsset: async () => {
          throw new Error('should not have been called: addAsset (an occupant exists)')
        }
      },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as WikiGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.WIKI as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.WIKI as any).models.storage.dispatch.mock.callCount(), 1)
})

test('renameAsset awaits both asset:rename hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, mimeType: 'image/png' }),
    models: {
      ...(global.WIKI as any).models,
      tree: { renameEntry: async () => undefined },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as WikiGlobal

  const result = await assets.renameAsset('site-1', 'asset-1', 'y.png')

  assert.ok(result)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.WIKI as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.WIKI as any).models.storage.dispatch.mock.callCount(), 1)
})

test('deleteAsset awaits both asset:delete hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, mimeType: 'image/png' }),
    models: {
      ...(global.WIKI as any).models,
      tree: { deleteEntry: async () => undefined },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as WikiGlobal

  const result = await assets.deleteAsset('site-1', 'asset-1')

  assert.equal(result, true)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.WIKI as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.WIKI as any).models.storage.dispatch.mock.callCount(), 1)
})
