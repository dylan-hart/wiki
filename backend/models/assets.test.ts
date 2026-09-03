import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { assets, dispositionFor } from './assets.ts'
import { assetServing } from './assetServing.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * The write half of the assets model, with `WIKI.db` / `WIKI.models.storage` stubbed rather than a
 * real Postgres instance: what an upload does to an SVG, what `dispositionFor()` answers for a given
 * extension and setting, and that every write awaits its `hooks.emit` / `storage.dispatch` pair
 * rather than detaching it. The serving half — `governingTarget`, `directUrlFor`, `readContent` and
 * the two caches behind them — is `models/assetServing.test.ts`.
 */
let wiki: { restore(): void }

before(() => {
  // -> The real `assetServing` singleton: every write path below tells it to forget the asset it
  //    just changed, which is the only thing the CRUD half calls into the serving cache for.
  wiki = installTestWiki({ models: { assetServing } })
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

/**
 * OpenProject #1360/#2152/#2164 (2026-08-24 security audit §3): `controllers/files.ts`'s `/_files/*`
 * route and `api/assets.ts`'s `/content` route used to compute this independently, with inverted
 * predicates — this is the one function both now call, so the same asset/setting combination answers
 * identically on both routes by construction rather than by two implementations staying in sync.
 *
 * `dispositionFor()` is the single predicate `controllers/files.ts` and `api/assets.ts`'s `/content`
 * route both call, replacing two expressions that used to disagree (OpenProject #2164). What matters
 * here is that it answers the SAME way for the same inputs regardless of which route asks — this is
 * a pure function of `fileExt` plus `WIKI.config.security.forceAssetDownload`, no I/O, so both
 * "routes" are just calling it directly with the same arguments.
 */
function withSecurityConfig<T>(security: Record<string, unknown>, fn: () => T): T {
  const original = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = { ...original, config: { security } }
  try {
    return fn()
  } finally {
    ;(globalThis as any).WIKI = original
  }
}

test('dispositionFor: an INLINE_EXTS member is never forced to download, forceAssetDownload on or off', () => {
  assert.equal(
    withSecurityConfig({ forceAssetDownload: true }, () => dispositionFor('png')),
    false
  )
  assert.equal(
    withSecurityConfig({ forceAssetDownload: false }, () => dispositionFor('png')),
    false
  )
})

test('dispositionFor: a non-inline extension downloads only when forceAssetDownload is on', () => {
  assert.equal(
    withSecurityConfig({ forceAssetDownload: true }, () => dispositionFor('zip')),
    true
  )
  assert.equal(
    withSecurityConfig({ forceAssetDownload: false }, () => dispositionFor('zip')),
    false
  )
})

// ---------------------------------------------------------------------------------------------
// upload() — the security.uploadScanSVG gate
// ---------------------------------------------------------------------------------------------

/**
 * Stubs everything `upload()` touches on a fresh-name (no conflict) path: no existing tree entry,
 * `addAsset` echoing back a synthesized row, and no-op hooks/dispatch/extensions. `WIKI.db.insert`
 * captures what was actually handed to it, which is what these tests assert against.
 */
function stubUploadPath(uploadScanSVG: boolean) {
  let inserted: any
  global.WIKI = {
    ...global.WIKI,
    config: { security: { uploadScanSVG } },
    sites: {},
    models: {
      ...(global.WIKI as any).models,
      tree: {
        getEntryAt: async () => null,
        addAsset: async ({ fileName, siteId }: any) => ({
          id: 'asset-svg-1',
          fileName,
          folderPath: '',
          title: fileName,
          siteId,
          createdAt: new Date('2024-01-01T00:00:00Z'),
          updatedAt: new Date('2024-01-01T00:00:00Z')
        })
      },
      hooks: { emit: () => {} },
      storage: { dispatch: () => {} },
      extensions: { getDefinition: () => null, isInstalled: async () => false }
    },
    db: {
      insert: () => ({
        values: async (row: any) => {
          inserted = row
        }
      }),
      delete: () => ({ where: async () => {} })
    }
  } as unknown as WikiGlobal
  return {
    getInserted: () => inserted
  }
}

test('upload sanitizes an SVG when security.uploadScanSVG is on, stripping a script tag', async () => {
  const { getInserted } = stubUploadPath(true)
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle cx="1" cy="1" r="1"/></svg>'
  )
  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'malicious.svg',
    data: svg,
    authorId: 'user-1'
  })
  const stored: Buffer = getInserted().data
  const storedText = stored.toString('utf8')
  assert.ok(!storedText.includes('<script'))
  assert.ok(!storedText.includes('alert(1)'))
  assert.ok(storedText.includes('<circle'))
})

test('upload stores an SVG untouched when security.uploadScanSVG is off', async () => {
  const { getInserted } = stubUploadPath(false)
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'untouched.svg',
    data: svg,
    authorId: 'user-1'
  })
  const stored: Buffer = getInserted().data
  assert.deepEqual(stored, svg)
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

test('moveAsset awaits both asset:move hooks.emit and storage.dispatch before resolving, and busts both cached paths', async (t) => {
  const order: string[] = []
  // -> Spies on the real singleton's prototype method rather than replacing the object -- the
  //    latter drops every other prototype method (`dropCachedContent` included), which corrupted
  //    shared test state for whichever test ran next. `t.mock` restores this automatically.
  const forgetPathSpy = t.mock.method(assetServing, 'forgetPath')
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, folderPath: '', mimeType: 'image/png' }),
    models: {
      ...(global.WIKI as any).models,
      tree: {
        moveEntry: async () => ({ id: 'asset-1', folderPath: 'new-folder', fileName: 'x.png' })
      },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as WikiGlobal

  const result = await assets.moveAsset({ siteId: 'site-1', id: 'asset-1', folderId: 'folder-1' })

  assert.ok(result)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.WIKI as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.WIKI as any).models.storage.dispatch.mock.callCount(), 1)
  // -> Both ends of the move: the folder it left ('') and the folder it arrived in ('new-folder')
  assert.deepEqual(
    forgetPathSpy.mock.calls.map((call) => call.arguments[1]),
    ['', 'new-folder']
  )
})

test('moveAsset is a no-op — no hooks.emit, no storage.dispatch, no cache-bust — when the destination is the folder it is already in', async (t) => {
  const forgetPathSpy = t.mock.method(assetServing, 'forgetPath')
  const emit = mock.fn(async () => {})
  const dispatch = mock.fn(async () => {})
  global.WIKI = {
    ...global.WIKI,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, folderPath: 'same-folder', mimeType: 'image/png' }),
    models: {
      ...(global.WIKI as any).models,
      tree: {
        // -> Mirrors `Tree#moveEntry`'s own no-op branch: the entry comes back unchanged
        moveEntry: async () => ({ id: 'asset-1', folderPath: 'same-folder', fileName: 'x.png' })
      },
      hooks: { emit },
      storage: { dispatch }
    }
  } as unknown as WikiGlobal

  const result = await assets.moveAsset({ siteId: 'site-1', id: 'asset-1', folderId: 'folder-1' })

  assert.ok(result)
  assert.equal(emit.mock.callCount(), 0)
  assert.equal(dispatch.mock.callCount(), 0)
  assert.equal(forgetPathSpy.mock.callCount(), 0)
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
      contentSync: { forgetContent: async () => undefined },
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
