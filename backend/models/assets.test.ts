import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { assets, dispositionFor } from './assets.ts'
import { assetServing } from './assetServing.ts'
import { installTestWiki } from '../test/mocks.ts'
import { installFakeCommands, withEmptyPath, type FakeCommands } from '../test/fakeCommands.ts'

const posix = process.platform !== 'win32'

/**
 * The write half of the assets model, with `CARDINAL.db` / `CARDINAL.models.storage` stubbed rather
 * than a real Postgres instance. The serving half is `models/assetServing.test.ts`.
 */
let wiki: { restore(): void }

before(() => {
  // -> The real `assetServing` singleton: forgetting an asset it just changed is the only thing a
  //    write path calls into the serving cache for.
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

function withSecurityConfig<T>(security: Record<string, unknown>, fn: () => T): T {
  const original = (globalThis as any).CARDINAL
  ;(globalThis as any).CARDINAL = { ...original, config: { security } }
  try {
    return fn()
  } finally {
    ;(globalThis as any).CARDINAL = original
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

/**
 * Stubs the fresh-name (no conflict) `upload()` path; `CARDINAL.db.insert` captures the row handed
 * to it, which is what these tests assert against.
 */
function stubUploadPath(uploadScanSVG: boolean, sharpInstalled = false) {
  let inserted: any
  global.CARDINAL = {
    ...global.CARDINAL,
    config: { security: { uploadScanSVG } },
    sites: {},
    models: {
      ...(global.CARDINAL as any).models,
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
      extensions: {
        getDefinition: () =>
          sharpInstalled ? { key: 'sharp', detect: { type: 'module', value: 'sharp' } } : null,
        isInstalled: async () => sharpInstalled,
        noteLoadFailure: () => {}
      }
    },
    db: {
      insert: () => ({
        values: async (row: any) => {
          inserted = row
        }
      }),
      delete: () => ({ where: async () => {} })
    }
  } as unknown as CardinalGlobal
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

test('upload with a createdAt/updatedAt override stores them on the assets row and returns them', async () => {
  const { getInserted } = stubUploadPath(false)

  const asset = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'backdated.txt',
    data: Buffer.from('hello'),
    authorId: 'user-1',
    createdAt: '2018-03-01T00:00:00.000Z',
    updatedAt: '2018-03-02T00:00:00.000Z'
  })

  const inserted = getInserted()
  assert.equal(inserted.createdAt?.toISOString(), '2018-03-01T00:00:00.000Z')
  assert.equal(inserted.updatedAt?.toISOString(), '2018-03-02T00:00:00.000Z')
  assert.equal(asset.createdAt.toISOString(), '2018-03-01T00:00:00.000Z')
  assert.equal(asset.updatedAt.toISOString(), '2018-03-02T00:00:00.000Z')
})

test('upload with no createdAt/updatedAt override leaves the assets row insert without those keys, keeping the column default', async () => {
  const { getInserted } = stubUploadPath(false)

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'ordinary.txt',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  const inserted = getInserted()
  assert.equal(
    Object.prototype.hasOwnProperty.call(inserted, 'createdAt'),
    false,
    'no override -- must not fight the column default'
  )
  assert.equal(Object.prototype.hasOwnProperty.call(inserted, 'updatedAt'), false)
})

async function loadSharp(): Promise<any> {
  try {
    return (await import('sharp')).default
  } catch {
    return null
  }
}

async function pngOf(width: number, height: number): Promise<Buffer> {
  const sharp = await loadSharp()
  return sharp({
    create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } }
  })
    .png()
    .toBuffer()
}

test('upload of an image stores its width and height in assets.meta and returns them', async (t) => {
  if (!(await loadSharp())) {
    return t.skip('sharp is not installed')
  }
  const { getInserted } = stubUploadPath(false, true)

  const asset = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'photo.png',
    data: await pngOf(640, 480),
    authorId: 'user-1'
  })

  assert.deepEqual(getInserted().meta, { width: 640, height: 480 })
  assert.equal(asset.width, 640)
  assert.equal(asset.height, 480)
  assert.equal(asset.hasPreview, true)
})

test('upload of an image without Sharp stores no dimensions and raises no error', async () => {
  const { getInserted } = stubUploadPath(false, false)

  const asset = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'photo.png',
    data: Buffer.from('bytes'),
    authorId: 'user-1'
  })

  assert.deepEqual(getInserted().meta, {})
  assert.equal(asset.width, undefined)
  assert.equal(asset.height, undefined)
  assert.equal(asset.hasPreview, false)
})

test('upload of a non-image stores no dimensions even when Sharp is installed', async () => {
  const { getInserted } = stubUploadPath(false, true)

  const asset = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'notes.txt',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(getInserted().meta, {})
  assert.equal(asset.width, undefined)
  assert.equal(asset.height, undefined)
})

test('getAsset lifts width and height out of assets.meta and never leaks the raw meta', async () => {
  global.CARDINAL = {
    ...global.CARDINAL,
    db: makeAssetsDbStub({
      id: 'asset-1',
      fileName: 'photo.png',
      folderPath: '',
      fileSize: 10,
      hasPreview: true,
      meta: { width: 800, height: 600 }
    })
  } as unknown as CardinalGlobal

  const asset: any = await assets.getAsset('site-1', 'asset-1')

  assert.equal(asset.width, 800)
  assert.equal(asset.height, 600)
  assert.equal('meta' in asset, false)
})

test('getAsset omits width and height for an asset with an empty meta', async () => {
  global.CARDINAL = {
    ...global.CARDINAL,
    db: makeAssetsDbStub({
      id: 'asset-1',
      fileName: 'archive.zip',
      folderPath: '',
      fileSize: 10,
      hasPreview: false,
      meta: {}
    })
  } as unknown as CardinalGlobal

  const asset: any = await assets.getAsset('site-1', 'asset-1')

  assert.equal('width' in asset, false)
  assert.equal('height' in asset, false)
})

test('an overwrite rewrites the width/height keys of assets.meta from the new upload, and clears them when it has none', async (t) => {
  if (!(await loadSharp())) {
    return t.skip('sharp is not installed')
  }
  const sets: any[] = []
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    values: () => chain,
    limit: () => Promise.resolve([undefined]),
    set: (values: any) => {
      sets.push(values)
      return chain
    }
  }
  const stubOverwrite = (sharpInstalled: boolean) => {
    global.CARDINAL = {
      ...global.CARDINAL,
      ...cacheFsStubs,
      sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
      db: chainDb(chain),
      models: {
        ...(global.CARDINAL as any).models,
        tree: {
          getEntryAt: async () => ({
            type: 'asset',
            id: 'asset-1',
            fileName: 'photo.png',
            folderPath: '',
            title: 'photo.png'
          })
        },
        hooks: { emit: () => {} },
        storage: { dispatch: () => {} },
        extensions: {
          getDefinition: () =>
            sharpInstalled ? { key: 'sharp', detect: { type: 'module', value: 'sharp' } } : null,
          isInstalled: async () => sharpInstalled,
          noteLoadFailure: () => {}
        }
      }
    } as unknown as CardinalGlobal
  }

  stubOverwrite(true)
  const withDims = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'photo.png',
    data: await pngOf(30, 20),
    authorId: 'user-1'
  })
  assert.equal(withDims.width, 30)
  assert.equal(withDims.height, 20)

  stubOverwrite(false)
  const withoutDims = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'photo.png',
    data: Buffer.from('bytes'),
    authorId: 'user-1'
  })
  assert.equal(withoutDims.width, undefined)
  assert.equal(withoutDims.height, undefined)

  const assetsRowSets = sets.filter((values) => 'preview' in values)
  assert.equal(assetsRowSets.length, 2)
  const boundJson = (values: any) =>
    values.meta.queryChunks.find((chunk: any) => typeof chunk === 'string')
  assert.equal(boundJson(assetsRowSets[0]), '{"width":30,"height":20}')
  assert.equal(boundJson(assetsRowSets[1]), '{}')
})

/**
 * Every `update()`/`delete()`/`insert()` chain resolving to itself is enough: none of the methods
 * under test reads back a write result, only whether the call was awaited in sequence.
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
  return chainDb(chain)
}

/** Every builder answers `chain`, and a transaction runs its callback against the same object. */
function chainDb(chain: unknown) {
  const db: any = {
    select: () => chain,
    update: () => chain,
    delete: () => chain,
    insert: () => chain,
    execute: async () => ({ rows: [] })
  }
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db)
  return db
}

/**
 * Resolves only after a real tick, then records. A method that fired the call without awaiting it
 * would resolve — and be asserted on — before the `order` push ever happens.
 */
function delayedDispatchMock(order: string[], label: string) {
  return mock.fn(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    order.push(label)
  })
}

/** A cache dir that never exists, so `dropCachedContent()`'s `fs.readdir` throws ENOENT and is
 *  silently caught, same as on a fresh instance. */
const cacheFsStubs = {
  ROOTPATH: '/tmp',
  config: { dataPath: 'wiki-assets-test-no-such-cache-dir' }
}

test('upload (new file) awaits both asset:upload hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'new' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.CARDINAL as any).models,
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
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.CARDINAL as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.CARDINAL as any).models.storage.dispatch.mock.callCount(), 1)
})

test('upload (overwrite of an existing asset) awaits both asset:edit hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.CARDINAL as any).models,
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
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.CARDINAL as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.CARDINAL as any).models.storage.dispatch.mock.callCount(), 1)
})

test('renameAsset awaits both asset:rename hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, mimeType: 'image/png' }),
    models: {
      ...(global.CARDINAL as any).models,
      tree: { renameEntry: async () => undefined },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as CardinalGlobal

  const result = await assets.renameAsset('site-1', 'asset-1', 'y.png')

  assert.ok(result)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.CARDINAL as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.CARDINAL as any).models.storage.dispatch.mock.callCount(), 1)
})

test('moveAsset awaits both asset:move hooks.emit and storage.dispatch before resolving, and busts both cached paths', async (t) => {
  const order: string[] = []
  // -> Spies on the real singleton's prototype method rather than replacing the object: replacing
  //    it drops every other prototype method (`dropCachedContent` included) for whichever test runs
  //    next. `t.mock` restores this automatically.
  const forgetPathSpy = t.mock.method(assetServing, 'forgetPath')
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, folderPath: '', mimeType: 'image/png' }),
    models: {
      ...(global.CARDINAL as any).models,
      tree: {
        moveEntry: async () => ({ id: 'asset-1', folderPath: 'new-folder', fileName: 'x.png' })
      },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as CardinalGlobal

  const result = await assets.moveAsset({ siteId: 'site-1', id: 'asset-1', folderId: 'folder-1' })

  assert.ok(result)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.CARDINAL as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.CARDINAL as any).models.storage.dispatch.mock.callCount(), 1)
  assert.deepEqual(
    forgetPathSpy.mock.calls.map((call) => call.arguments[1]),
    ['', 'new-folder']
  )
})

test('moveAsset is a no-op — no hooks.emit, no storage.dispatch, no cache-bust — when the destination is the folder it is already in', async (t) => {
  const forgetPathSpy = t.mock.method(assetServing, 'forgetPath')
  const emit = mock.fn(async () => {})
  const dispatch = mock.fn(async () => {})
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, folderPath: 'same-folder', mimeType: 'image/png' }),
    models: {
      ...(global.CARDINAL as any).models,
      tree: {
        // -> Mirrors `Tree#moveEntry`'s own no-op branch: the entry comes back unchanged
        moveEntry: async () => ({ id: 'asset-1', folderPath: 'same-folder', fileName: 'x.png' })
      },
      hooks: { emit },
      storage: { dispatch }
    }
  } as unknown as CardinalGlobal

  const result = await assets.moveAsset({ siteId: 'site-1', id: 'asset-1', folderId: 'folder-1' })

  assert.ok(result)
  assert.equal(emit.mock.callCount(), 0)
  assert.equal(dispatch.mock.callCount(), 0)
  assert.equal(forgetPathSpy.mock.callCount(), 0)
})

test('deleteAsset awaits both asset:delete hooks.emit and storage.dispatch before resolving', async () => {
  const order: string[] = []
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    db: makeAssetsDbStub({ ...testAsset, mimeType: 'image/png' }),
    models: {
      ...(global.CARDINAL as any).models,
      tree: { deleteEntry: async () => undefined },
      contentSync: { forgetContent: async () => undefined },
      hooks: { emit: delayedDispatchMock(order, 'hooks') },
      storage: { dispatch: delayedDispatchMock(order, 'storage') }
    }
  } as unknown as CardinalGlobal

  const result = await assets.deleteAsset('site-1', 'asset-1')

  assert.equal(result, true)
  assert.deepEqual(order.sort(), ['hooks', 'storage'])
  assert.equal((global.CARDINAL as any).models.hooks.emit.mock.callCount(), 1)
  assert.equal((global.CARDINAL as any).models.storage.dispatch.mock.callCount(), 1)
})

/**
 * Collects `info` calls so the tests can assert on the scope and fields a call passed, never on a
 * rendered string — the renderer is `core/logger.ts`'s business, and matching formatted text breaks
 * the moment a column widens.
 */
function collectingLogger() {
  const lines: { scope: string; message: string; fields: Record<string, any> }[] = []
  const noop = () => {}
  const logger: any = {
    error: noop,
    warn: noop,
    debug: noop,
    info: (scope: string, message: string, fields: Record<string, any> = {}) => {
      lines.push({ scope, message, fields })
    }
  }
  logger.scope = () => logger
  return { logger, assetLines: () => lines.filter((line) => line.scope === 'assets') }
}

test('upload logs one "uploaded" line naming the site, asset, path, bytes, kind and user', async () => {
  const { logger, assetLines } = collectingLogger()
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    logger,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'new' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.CARDINAL as any).models,
      tree: {
        addAsset: async () => ({
          id: 'asset-9',
          fileName: 'notes.txt',
          folderPath: 'docs',
          title: 'notes.txt',
          createdAt: new Date(),
          updatedAt: new Date()
        })
      },
      hooks: { emit: async () => {} },
      storage: { dispatch: async () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'notes.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  const lines = assetLines()
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.message, 'uploaded')
  assert.deepEqual(lines[0]!.fields, {
    site: 'site-1',
    asset: 'asset-9',
    path: 'docs/notes.txt',
    bytes: 5,
    kind: 'document',
    user: 'user-1'
  })
})

test('an overwrite is still one "uploaded" line, marked as such rather than logged as a new file', async () => {
  const { logger, assetLines } = collectingLogger()
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    logger,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
    db: makeAssetsDbStub(undefined),
    models: {
      ...(global.CARDINAL as any).models,
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
      hooks: { emit: async () => {} },
      storage: { dispatch: async () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  const lines = assetLines()
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.message, 'uploaded')
  assert.deepEqual(lines[0]!.fields, {
    site: 'site-1',
    asset: 'asset-1',
    path: 'test.txt',
    bytes: 5,
    kind: 'document',
    overwrite: true,
    user: 'user-1'
  })
})

test('deleteAsset logs one "deleted" line, falling back to user=system with no actor', async () => {
  const { logger, assetLines } = collectingLogger()
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    logger,
    db: makeAssetsDbStub({ ...testAsset, mimeType: 'image/png' }),
    models: {
      ...(global.CARDINAL as any).models,
      tree: { deleteEntry: async () => undefined },
      contentSync: { forgetContent: async () => undefined },
      hooks: { emit: async () => {} },
      storage: { dispatch: async () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.deleteAsset('site-1', 'asset-1')
  await assets.deleteAsset('site-1', 'asset-1', { authorId: 'user-1' })

  const lines = assetLines()
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0]!.fields, {
    site: 'site-1',
    asset: 'asset-1',
    path: 'x.png',
    kind: 'image',
    user: 'system'
  })
  assert.equal(lines[1]!.fields.user, 'user-1')
})

test('deleteOrphaned logs one line per asset, marked as a folder cascade', async () => {
  const { logger, assetLines } = collectingLogger()
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    logger,
    db: {
      ...makeAssetsDbStub(undefined),
      delete: () => ({
        where: () => ({
          returning: async () => [
            { id: 'asset-1', kind: 'image', fileSize: 10 },
            { id: 'asset-2', kind: 'other', fileSize: 20 }
          ]
        })
      })
    },
    models: {
      ...(global.CARDINAL as any).models,
      contentSync: { forgetContentBatch: async () => undefined },
      hooks: { emit: async () => {} },
      storage: { dispatch: async () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.deleteOrphaned(
    'site-1',
    [
      { id: 'asset-1', fileName: 'a.png', folderPath: 'shots', locale: 'en' },
      { id: 'asset-2', fileName: 'b.zip', folderPath: '', locale: 'en' }
    ],
    { authorId: 'user-1' }
  )

  const lines = assetLines()
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0]!.fields, {
    site: 'site-1',
    asset: 'asset-1',
    path: 'shots/a.png',
    kind: 'image',
    cascade: 'folder',
    user: 'user-1'
  })
  assert.equal(lines[1]!.fields.path, 'b.zip')
  assert.equal(lines[1]!.fields.cascade, 'folder')
})

test('an overwrite clears the extracted search text, which described the bytes just replaced', async () => {
  const sets: any[] = []
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    values: () => chain,
    limit: () => Promise.resolve([undefined]),
    set: (values: any) => {
      sets.push(values)
      return chain
    }
  }
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
    db: chainDb(chain),
    models: {
      ...(global.CARDINAL as any).models,
      tree: {
        getEntryAt: async () => ({
          type: 'asset',
          id: 'asset-1',
          fileName: 'test.txt',
          folderPath: '',
          title: 'test.txt'
        })
      },
      hooks: { emit: () => {} },
      storage: { dispatch: () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'test.txt',
    mimeType: 'text/plain',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  const assetSet = sets.find((values) => 'fileSize' in values)
  assert.ok(assetSet)
  assert.equal(assetSet.searchContent, null)
  assert.equal(assetSet.ts, null)
})

for (const semanticSearch of [true, false]) {
  test(`an overwrite ${semanticSearch ? 'drops' : 'leaves alone'} the old file's embedding chunks with semantic search ${semanticSearch ? 'on' : 'off'}`, async () => {
    const chain: any = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      values: () => chain,
      limit: () => Promise.resolve([undefined]),
      set: () => chain
    }
    const executed: string[] = []
    const tx: any = {
      update: () => chain,
      execute: async (query: { queryChunks?: unknown[] }) => {
        executed.push(JSON.stringify(query.queryChunks ?? []))
        return { rows: [] }
      }
    }
    const pool = chainDb(chain)
    pool.execute = async () => {
      throw new Error('the chunks must go in the same transaction as the bytes')
    }
    pool.transaction = async (fn: (t: unknown) => unknown) => fn(tx)
    global.CARDINAL = {
      ...global.CARDINAL,
      ...cacheFsStubs,
      capabilities: { semanticSearch },
      sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
      db: pool,
      models: {
        ...(global.CARDINAL as any).models,
        tree: {
          getEntryAt: async () => ({
            type: 'asset',
            id: 'asset-1',
            fileName: 'test.txt',
            folderPath: '',
            title: 'test.txt'
          })
        },
        hooks: { emit: () => {} },
        storage: { dispatch: () => {} }
      }
    } as unknown as CardinalGlobal

    await assets.upload({
      siteId: 'site-1',
      locale: 'en',
      fileName: 'test.txt',
      data: Buffer.from('hello'),
      authorId: 'user-1'
    })

    if (semanticSearch) {
      assert.equal(executed.length, 1)
      assert.match(executed[0]!, /DELETE FROM \\"assetEmbeddingChunks\\"/)
      assert.match(executed[0]!, /asset-1/)
    } else {
      assert.deepEqual(executed, [])
    }
  })
}

test('setSearchContent stores the text with a vector, and clears both for blank text', async () => {
  const sets: any[] = []
  const chain: any = {
    where: () => Promise.resolve(),
    set: (values: any) => {
      sets.push(values)
      return chain
    }
  }
  global.CARDINAL = { ...global.CARDINAL, db: { update: () => chain } } as unknown as CardinalGlobal

  await assets.setSearchContent('asset-1', 'quarterly report')
  await assets.setSearchContent('asset-1', '  \n ')
  await assets.setSearchContent('asset-1', null)

  assert.equal(sets[0].searchContent, 'quarterly report')
  assert.notEqual(sets[0].ts, null)
  assert.equal('updatedAt' in sets[0], false)
  assert.deepEqual(sets[1], { searchContent: null, ts: null })
  assert.deepEqual(sets[2], { searchContent: null, ts: null })
})

function extractionJobs() {
  const addJob = (global.CARDINAL as any).scheduler.addJob
  return addJob.mock.calls.map((call: any) => call.arguments[0])
}

test('upload of a PDF queues text extraction for the new asset', async () => {
  stubUploadPath(false)
  const addJob = mock.fn(async () => ({ id: 'job-1' }))
  global.CARDINAL = { ...global.CARDINAL, scheduler: { addJob } } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'report.pdf',
    data: Buffer.from('%PDF-1.4'),
    authorId: 'user-1'
  })

  assert.deepEqual(extractionJobs(), [
    { task: 'extractAssetText', payload: { assetId: 'asset-svg-1' } }
  ])
})

test('upload of a non-PDF queues no extraction', async () => {
  stubUploadPath(false)
  const addJob = mock.fn(async () => ({ id: 'job-1' }))
  global.CARDINAL = { ...global.CARDINAL, scheduler: { addJob } } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'notes.txt',
    data: Buffer.from('hello'),
    authorId: 'user-1'
  })

  assert.deepEqual(extractionJobs(), [])
})

test('upload of an image queues OCR when tesseract is on PATH', { skip: !posix }, async () => {
  let fake: FakeCommands | undefined
  try {
    fake = await installFakeCommands({ tesseract: 'exit 0' })
    stubUploadPath(false)
    const addJob = mock.fn(async () => ({ id: 'job-1' }))
    global.CARDINAL = { ...global.CARDINAL, scheduler: { addJob } } as unknown as CardinalGlobal

    await assets.upload({
      siteId: 'site-1',
      locale: 'en',
      fileName: 'scan.png',
      data: Buffer.from('bytes'),
      authorId: 'user-1'
    })

    assert.deepEqual(extractionJobs(), [{ task: 'ocrAsset', payload: { assetId: 'asset-svg-1' } }])
  } finally {
    await fake?.restore()
  }
})

test('upload of an image queues no OCR when tesseract is absent', async () => {
  await withEmptyPath(async () => {
    stubUploadPath(false)
    const addJob = mock.fn(async () => ({ id: 'job-1' }))
    global.CARDINAL = { ...global.CARDINAL, scheduler: { addJob } } as unknown as CardinalGlobal

    await assets.upload({
      siteId: 'site-1',
      locale: 'en',
      fileName: 'scan.png',
      data: Buffer.from('bytes'),
      authorId: 'user-1'
    })

    assert.deepEqual(extractionJobs(), [])
  })
})

test('a scheduler failure while queueing extraction does not fail the upload', async () => {
  stubUploadPath(false)
  const addJob = mock.fn(async () => {
    throw new Error('queue down')
  })
  global.CARDINAL = {
    ...global.CARDINAL,
    scheduler: { addJob },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
  } as unknown as CardinalGlobal

  const asset = await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'report.pdf',
    data: Buffer.from('%PDF-1.4'),
    authorId: 'user-1'
  })

  assert.equal(asset.id, 'asset-svg-1')
})

test('an overwrite of a PDF queues extraction for the existing asset id', async () => {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    values: () => chain,
    limit: () => Promise.resolve([undefined]),
    set: () => chain
  }
  const addJob = mock.fn(async () => ({ id: 'job-1' }))
  global.CARDINAL = {
    ...global.CARDINAL,
    ...cacheFsStubs,
    scheduler: { addJob },
    sites: { 'site-1': { config: { uploads: { conflictBehavior: 'overwrite' } } } },
    db: chainDb(chain),
    models: {
      ...(global.CARDINAL as any).models,
      tree: {
        getEntryAt: async () => ({
          type: 'asset',
          id: 'asset-9',
          fileName: 'report.pdf',
          folderPath: '',
          title: 'report.pdf'
        })
      },
      hooks: { emit: () => {} },
      storage: { dispatch: () => {} }
    }
  } as unknown as CardinalGlobal

  await assets.upload({
    siteId: 'site-1',
    locale: 'en',
    fileName: 'report.pdf',
    data: Buffer.from('%PDF-1.4'),
    authorId: 'user-1'
  })

  assert.deepEqual(extractionJobs(), [
    { task: 'extractAssetText', payload: { assetId: 'asset-9' } }
  ])
})
