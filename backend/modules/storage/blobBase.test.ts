import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  blobStorageModule,
  keyFor,
  DIRECT_ACCESS_TTL_SECONDS,
  type BlobDriver
} from './blobBase.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'
import { makeStorageTarget } from '../../test/builders.ts'
import type { StorageTarget } from '../../models/storage.ts'

/**
 * Pure unit tests for the shared blob-target factory, driven by a fake driver rather than any cloud
 * SDK: what is under test here is the part `s3`, `azure` and `gcs` no longer each own — the activation
 * cache, the five handlers, the key computation and the error wrapping — so a stand-in driver that
 * merely records what it was asked to do is exactly the right instrument. Each module's own
 * `storage.test.ts` still covers its SDK callbacks against that SDK's mocking story.
 */

installTestWiki({
  // -> `info` is a `mock.fn()` rather than the silent default: `beforeEach` below resets its call
  //    history, and one test asserts on what the module logged.
  logger: { ...createSilentLogger(), info: mock.fn() },
  models: {
    assets: {
      getContent: mock.fn(async () => null),
      streamAll: async function* () {}
    }
  }
})

/** The fake driver's "client" — an opaque token, so a test can assert it reached every callback. */
interface FakeClient {
  id: string
}

/**
 * A driver that records what it was asked to do. Returned unannotated (rather than as a
 * `BlobDriver<FakeClient>`) so each callback keeps its `mock.fn` type — that is what lets a test both
 * assert call arguments and swap one call's implementation with `mockImplementationOnce`.
 */
function makeDriver() {
  return {
    label: 'Fake Blob Store',
    build: mock.fn(async (_config: Record<string, any>) => ({ id: randomUUID() }) as FakeClient),
    put: mock.fn(
      async (
        _client: FakeClient,
        _key: string,
        _body: Buffer,
        _mimeType: string,
        _config: Record<string, any>
      ) => {}
    ),
    remove: mock.fn(async (_client: FakeClient, _key: string) => {}),
    copy: mock.fn(
      async (
        _client: FakeClient,
        _sourceKey: string,
        _destinationKey: string,
        _config: Record<string, any>
      ) => {}
    ),
    sign: mock.fn(async (_client: FakeClient, key: string, _ttl: number) => `signed:${key}`)
  } satisfies BlobDriver<FakeClient>
}

/** A fresh target per test, so the factory's per-target activation cache never leaks between cases. */
function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
  return makeStorageTarget('fake', {
    title: 'Test Blob',
    config: { bucket: 'wiki', ...configOverrides }
  })
}

beforeEach(() => {
  ;(WIKI.models.assets.getContent as any).mock.resetCalls()
  ;(WIKI.logger.info as any).mock.resetCalls()
})

describe('blobBase / keyFor', () => {
  test('scopes the key by siteId and joins the folder path', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, 'docs/reports', 'q1.pdf'), `${target.siteId}/docs/reports/q1.pdf`)
  })

  test('an empty folderPath yields a key straight under the site', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, '', 'logo.png'), `${target.siteId}/logo.png`)
  })
})

describe('blobBase / activation cache', () => {
  test('builds one client per target and reuses it while the stored config is unchanged', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetDeleted!(target, { fileName: 'a.png', folderPath: '' })
    await module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' })

    assert.equal(driver.build.mock.callCount(), 1)
    assert.equal(driver.remove.mock.callCount(), 2)
    // -> both calls landed on the one activated client
    const [first, second] = driver.remove.mock.calls
    assert.equal(first!.arguments[0], second!.arguments[0])
  })

  test('rebuilds when the target config changes, keyed on JSON.stringify(config)', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetDeleted!(target, { fileName: 'a.png', folderPath: '' })
    target.config = { ...target.config, bucket: 'renamed' }
    await module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' })

    assert.equal(driver.build.mock.callCount(), 2)
    assert.equal(driver.build.mock.calls[1]!.arguments[0]!.bucket, 'renamed')
  })

  test('concurrent calls share a single activation', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await Promise.all([
      module.assetDeleted!(target, { fileName: 'a.png', folderPath: '' }),
      module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' })
    ])

    assert.equal(driver.build.mock.callCount(), 1)
  })

  test('a failed activation is not remembered: the next call activates again, and can succeed', async () => {
    const driver = makeDriver()
    driver.build.mock.mockImplementationOnce(async () => {
      throw new Error('bad credentials')
    })
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await assert.rejects(
      () => module.assetDeleted!(target, { fileName: 'a.png', folderPath: '' }),
      /bad credentials/
    )
    await module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' })

    assert.equal(driver.build.mock.callCount(), 2)
    assert.equal(driver.remove.mock.callCount(), 1)
  })
})

describe('blobBase / per-asset lifecycle', () => {
  test('assetUploaded fetches the bytes and puts them under the site-scoped key', async () => {
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => ({
      data: Buffer.from('hello'),
      mimeType: 'text/plain',
      fileName: 'notes.txt'
    }))
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetUploaded!(target, {
      id: 'asset-1',
      fileName: 'notes.txt',
      folderPath: 'docs',
      kind: 'document',
      fileSize: 5
    })

    assert.equal(driver.put.mock.callCount(), 1)
    const call = driver.put.mock.calls[0]!
    assert.equal(call.arguments[1], `${target.siteId}/docs/notes.txt`)
    assert.equal((call.arguments[2] as Buffer).toString(), 'hello')
    assert.equal(call.arguments[3], 'text/plain')
    assert.equal(call.arguments[4], target.config)
  })

  test('assetUploaded is a no-op when the asset was deleted again before delivery', async () => {
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => null)
    const driver = makeDriver()
    const module = blobStorageModule(driver)

    await module.assetUploaded!(makeTarget(), { id: 'gone', fileName: 'x.txt', folderPath: '' })

    assert.equal(driver.put.mock.callCount(), 0)
  })

  test('assetDeleted removes the site-scoped key', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

    assert.equal(driver.remove.mock.callCount(), 1)
    assert.equal(driver.remove.mock.calls[0]!.arguments[1], `${target.siteId}/images/old.png`)
  })

  test('assetRenamed copies to the new key, then removes the old one', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetRenamed!(target, {
      fileName: 'new-name.png',
      previousFileName: 'old-name.png',
      folderPath: 'images'
    })

    const sourceKey = `${target.siteId}/images/old-name.png`
    const destinationKey = `${target.siteId}/images/new-name.png`
    assert.equal(driver.copy.mock.callCount(), 1)
    assert.equal(driver.copy.mock.calls[0]!.arguments[1], sourceKey)
    assert.equal(driver.copy.mock.calls[0]!.arguments[2], destinationKey)
    assert.equal(driver.remove.mock.callCount(), 1)
    assert.equal(driver.remove.mock.calls[0]!.arguments[1], sourceKey)
  })
})

describe('blobBase / exportAll', () => {
  test('puts only the assets the target contentTypes cover, keyed under the site', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()
    target.contentTypes = { activeTypes: ['images'], largeThreshold: '1MB' }

    WIKI.models.assets.streamAll = async function* () {
      yield {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: 'gallery',
        kind: 'image',
        fileSize: 100,
        mimeType: 'image/png',
        data: Buffer.from('img')
      }
      yield {
        id: 'a2',
        fileName: 'report.pdf',
        folderPath: 'docs',
        kind: 'document',
        fileSize: 200,
        mimeType: 'application/pdf',
        data: Buffer.from('doc')
      }
    } as any

    await module.exportAll(target)

    assert.equal(driver.put.mock.callCount(), 1)
    assert.equal(driver.put.mock.calls[0]!.arguments[1], `${target.siteId}/gallery/pic.png`)
  })

  test('logs the count against the driver label', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    WIKI.models.assets.streamAll = async function* () {
      yield {
        id: 'a1',
        fileName: 'pic.png',
        folderPath: '',
        kind: 'image',
        fileSize: 100,
        mimeType: 'image/png',
        data: Buffer.from('img')
      }
    } as any

    await module.exportAll(target)

    const logged = (WIKI.logger.info as any).mock.calls.at(-1)!.arguments[0] as string
    assert.equal(logged, `(STORAGE/${target.title}) Exported 1 asset(s) to Fake Blob Store.`)
  })
})

describe('blobBase / getDirectUrl', () => {
  test('signs the asset key for the shared TTL', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    const url = await module.getDirectUrl!(
      {
        id: 'asset-1',
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        folderPath: 'images',
        fileName: 'pic.png'
      },
      target
    )

    assert.equal(url, `signed:${target.siteId}/images/pic.png`)
    assert.equal(driver.sign.mock.calls[0]!.arguments[2], DIRECT_ACCESS_TTL_SECONDS)
  })
})

describe('blobBase / error wrapping', () => {
  test('a driver failure reaches the caller as a readable Error naming the key and the action', async () => {
    const driver = makeDriver()
    driver.remove.mock.mockImplementationOnce(async () => {
      throw new Error('403 Forbidden')
    })
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await assert.rejects(
      () => module.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' }),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.equal(
          err.message,
          `Failed to delete "${target.siteId}/images/old.png": 403 Forbidden`
        )
        return true
      }
    )
  })

  /**
   * `getDirectUrl` is the one handler whose action name is a whole phrase rather than a verb, and
   * the only one that returns a value rather than resolving — so its wrapper is the easiest to
   * change without noticing. An admin whose bucket credentials cannot sign reads sees this string.
   */
  test('a signing failure names the direct-access action and the key, verbatim', async () => {
    const driver = makeDriver()
    driver.sign.mock.mockImplementationOnce(async () => {
      throw new Error('credentials cannot sign')
    })
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await assert.rejects(
      () =>
        module.getDirectUrl!(
          {
            id: 'asset-1',
            updatedAt: new Date('2024-01-01T00:00:00Z'),
            folderPath: 'images',
            fileName: 'pic.png'
          },
          target
        ),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.equal(
          err.message,
          `Failed to generate a direct-access URL for "${target.siteId}/images/pic.png": credentials cannot sign`
        )
        return true
      }
    )
  })
})
