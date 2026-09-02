import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { assetServing } from './assetServing.ts'
import { assets } from './assets.ts'
import { installTestWiki } from '../test/mocks.ts'
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
let wiki: { restore(): void }

before(() => {
  // -> The real `assets` singleton: the serving cache falls through to it for the metadata
  //    (`getAssetByPath`) and the bytes (`getContent`) a cache miss has to go and fetch.
  wiki = installTestWiki({ models: { assets } })
})

after(() => wiki.restore())

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
  const found = await assetServing.governingTarget('site-1')
  assert.equal(found?.id, 'target-db')
})

test('governingTarget ignores a disabled db-module row', async () => {
  stubStorage({ targets: [makeDbTarget({}, { isEnabled: false })] })
  assert.equal(await assetServing.governingTarget('site-1'), null)
})

test('governingTarget returns null when the site has no targets at all', async () => {
  stubStorage({ targets: [] })
  assert.equal(await assetServing.governingTarget('site-1'), null)
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
  const found = await assetServing.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
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
  const found = await assetServing.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
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
  const found = await assetServing.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
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
  const found = await assetServing.governingTarget('site-1', { kind: 'image', fileSize: 1000 })
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
  const found = await assetServing.governingTarget('site-1')
  assert.equal(found?.id, 'target-db')
})

// ---------------------------------------------------------------------------------------------
// directUrlFor()
// ---------------------------------------------------------------------------------------------

test('directUrlFor returns null without consulting the module when directAccess is off', async () => {
  const target = makeDbTarget({ directAccess: false, isDirectAccessSupported: true })
  stubStorage({ targets: [target], ensureModule: unreachable('ensureModule') })
  assert.equal(await assetServing.directUrlFor(testAsset, target), null)
})

test('directUrlFor returns null when the definition does not support direct access, even if directAccess is on', async () => {
  const target = makeDbTarget({ directAccess: true, isDirectAccessSupported: false })
  stubStorage({ targets: [target], ensureModule: unreachable('ensureModule') })
  assert.equal(await assetServing.directUrlFor(testAsset, target), null)
})

test('directUrlFor returns null when the module has no getDirectUrl', async () => {
  const target = makeDbTarget({ directAccess: true, isDirectAccessSupported: true })
  stubStorage({ targets: [target], ensureModule: async () => ({}) })
  assert.equal(await assetServing.directUrlFor(testAsset, target), null)
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
  assert.equal(
    await assetServing.directUrlFor(testAsset, target),
    'https://cdn.example.com/asset-1'
  )
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
  const originalReadCache = assetServing.readContentCache
  const originalGetContent = WIKI.models.assets.getContent
  let cacheHit = false
  assetServing.readContentCache = async () => {
    cacheHit = true
    return { body: 'stream-stand-in' as any, size: 42 }
  }
  WIKI.models.assets.getContent = unreachable('getContent') as any
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.ok(cacheHit)
    assert.deepEqual(result, { body: 'stream-stand-in', size: 42 })
  } finally {
    assetServing.readContentCache = originalReadCache
    WIKI.models.assets.getContent = originalGetContent
  }
})

test('readContent, streaming on, falls back to the db and writes the cache back on a cache miss', async () => {
  const target = makeDbTarget({ streaming: true })
  stubStorage({ targets: [target] })
  stubDb({ data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'x.png' })
  const originalReadCache = assetServing.readContentCache
  const originalWriteCache = assetServing.writeContentCache
  let wroteCache: any
  assetServing.readContentCache = async () => null
  assetServing.writeContentCache = async (asset, data) => {
    wroteCache = { asset, data }
  }
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: Buffer.from('bytes'), size: 5 })
    assert.equal(wroteCache.asset.id, 'asset-1')
    assert.deepEqual(wroteCache.data, Buffer.from('bytes'))
  } finally {
    assetServing.readContentCache = originalReadCache
    assetServing.writeContentCache = originalWriteCache
  }
})

test('readContent, streaming off, never touches the disk cache and always serves the buffer', async () => {
  const target = makeDbTarget({ streaming: false })
  stubStorage({ targets: [target] })
  stubDb({ data: Buffer.from('bytes'), mimeType: 'image/png', fileName: 'x.png' })
  const originalReadCache = assetServing.readContentCache
  const originalWriteCache = assetServing.writeContentCache
  assetServing.readContentCache = unreachable('readContentCache') as any
  assetServing.writeContentCache = unreachable('writeContentCache') as any
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: Buffer.from('bytes'), size: 5 })
  } finally {
    assetServing.readContentCache = originalReadCache
    assetServing.writeContentCache = originalWriteCache
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
  const originalReadCache = assetServing.readContentCache
  assetServing.readContentCache = unreachable('readContentCache') as any
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { redirectUrl: 'https://cdn.example.com/asset-1' })
  } finally {
    assetServing.readContentCache = originalReadCache
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
  const originalReadCache = assetServing.readContentCache
  assetServing.readContentCache = async () => ({ body: 'stream-stand-in' as any, size: 1 })
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { body: 'stream-stand-in', size: 1 })
  } finally {
    assetServing.readContentCache = originalReadCache
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
  const originalReadCache = assetServing.readContentCache
  assetServing.readContentCache = unreachable('readContentCache') as any
  try {
    const result = await assetServing.readContent(testAsset, 'site-1')
    assert.deepEqual(result, { redirectUrl: 'https://bucket.example.com/asset-1' })
  } finally {
    assetServing.readContentCache = originalReadCache
  }
})

test('readContent defaults to streaming on when the site has no governing target row', async () => {
  stubStorage({ targets: [] })
  const originalReadCache = assetServing.readContentCache
  let cacheChecked = false
  assetServing.readContentCache = async () => {
    cacheChecked = true
    return { body: 'stream-stand-in' as any, size: 1 }
  }
  try {
    await assetServing.readContent(testAsset, 'site-1')
    assert.ok(cacheChecked)
  } finally {
    assetServing.readContentCache = originalReadCache
  }
})

test('readContent returns null when the asset row is gone, whichever path was taken', async () => {
  const target = makeDbTarget({ streaming: false })
  stubStorage({ targets: [target] })
  stubDb(undefined)
  assert.equal(await assetServing.readContent(testAsset, 'site-1'), null)
})
