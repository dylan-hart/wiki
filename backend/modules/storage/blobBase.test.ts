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
import { CONTENT_TYPES } from '../../models/storage.ts'
import type { StorageTarget } from '../../models/storage.ts'

/**
 * Driven by a fake driver rather than any cloud SDK: what is under test is the part `s3`, `azure`
 * and `gcs` do not each own — the activation cache, the handlers, the key computation and the error
 * wrapping. Each module's own `storage.test.ts` covers its SDK callbacks.
 */

installTestWiki({
  // -> `info` is a `mock.fn()` rather than the silent default: one test asserts on what was logged.
  logger: { ...createSilentLogger(), info: mock.fn() },
  models: {
    assets: {
      getContent: mock.fn(async () => null),
      streamAll: async function* () {}
    }
  }
})

/** An opaque token, so a test can assert the same client reached every callback. */
interface FakeClient {
  id: string
}

/**
 * Returned unannotated rather than as a `BlobDriver<FakeClient>` so each callback keeps its
 * `mock.fn` type — what lets a test assert call arguments and use `mockImplementationOnce`.
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
  ;(CARDINAL.models.assets.getContent as any).mock.resetCalls()
  ;(CARDINAL.logger.info as any).mock.resetCalls()
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

  test('a failed activation is negative-cached: a retry inside the window replays the same rejection without re-probing', async () => {
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
    await assert.rejects(
      () => module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' }),
      /bad credentials/
    )

    assert.equal(driver.build.mock.callCount(), 1)
    assert.equal(driver.remove.mock.callCount(), 0)
  })

  test('a failed activation retries once the negative-cache window elapses, and can succeed', async () => {
    mock.timers.enable({ apis: ['Date'] })
    try {
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

      mock.timers.tick(30_000)

      await module.assetDeleted!(target, { fileName: 'b.png', folderPath: '' })

      assert.equal(driver.build.mock.callCount(), 2)
      assert.equal(driver.remove.mock.callCount(), 1)
    } finally {
      mock.timers.reset()
    }
  })
})

describe('blobBase / per-asset lifecycle', () => {
  test('assetUploaded fetches the bytes and puts them under the site-scoped key', async () => {
    ;(CARDINAL.models.assets.getContent as any).mock.mockImplementationOnce(async () => ({
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
    ;(CARDINAL.models.assets.getContent as any).mock.mockImplementationOnce(async () => null)
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

  test('assetMoved copies to the new folder key, then removes the old one (OpenProject #3384)', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetMoved!(target, {
      fileName: 'pic.png',
      folderPath: 'gallery',
      previousFolderPath: 'images'
    })

    const sourceKey = `${target.siteId}/images/pic.png`
    const destinationKey = `${target.siteId}/gallery/pic.png`
    assert.equal(driver.copy.mock.callCount(), 1)
    assert.equal(driver.copy.mock.calls[0]!.arguments[1], sourceKey)
    assert.equal(driver.copy.mock.calls[0]!.arguments[2], destinationKey)
    assert.equal(driver.remove.mock.callCount(), 1)
    assert.equal(driver.remove.mock.calls[0]!.arguments[1], sourceKey)
  })

  test('assetMoved from the site root to a folder', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()

    await module.assetMoved!(target, {
      fileName: 'pic.png',
      folderPath: 'gallery',
      previousFolderPath: ''
    })

    assert.equal(driver.copy.mock.calls[0]!.arguments[1], `${target.siteId}/pic.png`)
    assert.equal(driver.copy.mock.calls[0]!.arguments[2], `${target.siteId}/gallery/pic.png`)
  })
})

describe('blobBase / exportAll', () => {
  test('puts only the assets the target contentTypes cover, keyed under the site', async () => {
    const driver = makeDriver()
    const module = blobStorageModule(driver)
    const target = makeTarget()
    target.contentTypes = {
      activeTypes: ['images'],
      supportedTypes: [...CONTENT_TYPES],
      largeThreshold: '1MB'
    }

    CARDINAL.models.assets.streamAll = async function* () {
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

    CARDINAL.models.assets.streamAll = async function* () {
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

    const logged = (CARDINAL.logger.info as any).mock.calls.at(-1)!.arguments as [
      string,
      string,
      Record<string, unknown>
    ]
    assert.deepEqual(logged[0], 'storage')
    assert.deepEqual(logged[1], 'exported every asset')
    assert.deepEqual(logged[2], {
      module: target.module,
      target: target.id,
      assets: 1,
      driver: 'Fake Blob Store'
    })
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

  /** Asserted verbatim: this exact string is what an admin whose credentials cannot sign reads. */
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
