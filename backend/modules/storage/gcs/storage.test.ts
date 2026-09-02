import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Bucket, File } from '@google-cloud/storage'
import storageModule, { buildClient, ensureBucket } from './storage.ts'
import { keyFor } from '../blobBase.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Pure unit tests: no database, no real network. `@google-cloud/storage` has no equivalent of
 * `aws-sdk-client-mock` in this repo (see `s3/storage.test.ts`), so the SDK's own I/O methods are
 * stubbed directly on the class prototypes with `node:test`'s `mock.method` — every `Bucket` / `File`
 * instance this module constructs is a real instance of those classes, so patching the prototype
 * catches every call, exactly as `azure/storage.test.ts` does for `@azure/storage-blob`.
 * `WIKI.logger`/`WIKI.models.assets` are the only `WIKI` members `storage.ts` touches — see "Testing
 * (backend)" in CLAUDE.md for the pure-unit-test convention this follows.
 */

installTestWiki({
  models: {
    assets: {
      getContent: mock.fn(async () => null),
      streamAll: async function* () {}
    }
  }
})

const FAKE_CREDENTIALS = JSON.stringify({
  client_email: 'wiki@test-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n'
})

let existsMock: ReturnType<typeof mock.method>
let saveMock: ReturnType<typeof mock.method>
let deleteMock: ReturnType<typeof mock.method>
let copyMock: ReturnType<typeof mock.method>
let getSignedUrlMock: ReturnType<typeof mock.method>

beforeEach(() => {
  existsMock = mock.method(Bucket.prototype, 'exists', async () => [true] as any)
  saveMock = mock.method(File.prototype, 'save', async () => {})
  deleteMock = mock.method(File.prototype, 'delete', async () => [{}] as any)
  copyMock = mock.method(File.prototype, 'copy', async () => [{}, {}] as any)
  getSignedUrlMock = mock.method(
    File.prototype,
    'getSignedUrl',
    async () => ['https://storage.googleapis.com/signed'] as any
  )
  ;(WIKI.models.assets.getContent as any).mock.resetCalls()
})

afterEach(() => {
  mock.restoreAll()
})

/** A fresh target per test, so the module's per-target client cache never leaks between cases. */
function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
  return makeStorageTarget('gcs', {
    title: 'Test GCS',
    config: {
      accountName: 'test-project',
      credentialsJSON: FAKE_CREDENTIALS,
      bucket: 'wiki-assets',
      storageTier: 'STANDARD',
      apiEndpoint: 'storage.google.com',
      ...configOverrides
    }
  })
}

describe('gcs storage / buildClient', () => {
  test('builds a client from accountName as projectId and parsed credentialsJSON, no network I/O', () => {
    const storage = buildClient({
      accountName: 'my-project',
      credentialsJSON: FAKE_CREDENTIALS
    })
    assert.equal((storage as any).projectId, 'my-project')
  })

  test('omits apiEndpoint when it matches the definition default, falling back to the SDK default', () => {
    const withDefault = buildClient({
      accountName: 'my-project',
      credentialsJSON: FAKE_CREDENTIALS,
      apiEndpoint: 'storage.google.com'
    })
    const withNoneGiven = buildClient({
      accountName: 'my-project',
      credentialsJSON: FAKE_CREDENTIALS
    })
    assert.equal((withDefault as any).apiEndpoint, (withNoneGiven as any).apiEndpoint)
  })

  test('passes apiEndpoint through when it differs from the default', () => {
    const storage = buildClient({
      accountName: 'my-project',
      credentialsJSON: FAKE_CREDENTIALS,
      apiEndpoint: 'private.googleapis.example.com'
    })
    assert.equal((storage as any).apiEndpoint, 'https://private.googleapis.example.com')
  })
})

describe('gcs storage / ensureBucket (activation)', () => {
  test('an existing, reachable bucket needs no special handling', async () => {
    const storage = buildClient({ accountName: 'p', credentialsJSON: FAKE_CREDENTIALS })
    const bucket = storage.bucket('wiki-assets')
    await assert.doesNotReject(() => ensureBucket(bucket))
    assert.equal(existsMock.mock.callCount(), 1)
  })

  test('a bucket that does not exist throws a clear, readable Error', async () => {
    existsMock.mock.mockImplementationOnce(async () => [false] as any)
    const storage = buildClient({ accountName: 'p', credentialsJSON: FAKE_CREDENTIALS })
    const bucket = storage.bucket('missing-bucket')
    await assert.rejects(
      () => ensureBucket(bucket),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /missing-bucket/)
        return true
      }
    )
  })

  test('an unreachable bucket (bad credentials, network) throws a clear, readable Error', async () => {
    existsMock.mock.mockImplementationOnce(async () => {
      throw new Error('invalid_grant: account not found')
    })
    const storage = buildClient({ accountName: 'p', credentialsJSON: FAKE_CREDENTIALS })
    const bucket = storage.bucket('wiki-assets')
    await assert.rejects(
      () => ensureBucket(bucket),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /wiki-assets/)
        assert.match(err.message, /invalid_grant/)
        return true
      }
    )
  })
})

describe('gcs storage / keyFor', () => {
  test('scopes the key by siteId and joins the folder path', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, 'docs/reports', 'q1.pdf'), `${target.siteId}/docs/reports/q1.pdf`)
  })

  test('an empty folderPath yields a key straight under the site', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, '', 'logo.png'), `${target.siteId}/logo.png`)
  })
})

describe('gcs storage / per-asset lifecycle', () => {
  test('assetUploaded fetches the bytes and saves them under the site-scoped key, with the configured tier', async () => {
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => ({
      data: Buffer.from('hello'),
      mimeType: 'text/plain',
      fileName: 'notes.txt'
    }))
    const target = makeTarget()

    await storageModule.assetUploaded!(target, {
      id: 'asset-1',
      fileName: 'notes.txt',
      folderPath: 'docs',
      kind: 'document',
      fileSize: 5
    })

    assert.equal(saveMock.mock.callCount(), 1)
    const call = saveMock.mock.calls[0]!
    assert.equal((call.arguments[0] as Buffer).toString(), 'hello')
    const options = call.arguments[1] as any
    assert.equal(options.contentType, 'text/plain')
    assert.equal(options.metadata.storageClass, 'STANDARD')
    // -> the File this call landed on is scoped to the site-prefixed key
    assert.equal((call.this as File).name, `${target.siteId}/docs/notes.txt`)
  })

  test('assetUploaded is a no-op when the asset was deleted again before delivery', async () => {
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => null)
    const target = makeTarget()

    await storageModule.assetUploaded!(target, { id: 'gone', fileName: 'x.txt', folderPath: '' })

    assert.equal(saveMock.mock.callCount(), 0)
  })

  test('assetDeleted deletes the site-scoped key', async () => {
    const target = makeTarget()

    await storageModule.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

    assert.equal(deleteMock.mock.callCount(), 1)
    const call = deleteMock.mock.calls[0]!
    assert.equal((call.this as File).name, `${target.siteId}/images/old.png`)
  })

  test('assetRenamed copies to the new key, then deletes the old one', async () => {
    const target = makeTarget()

    await storageModule.assetRenamed!(target, {
      fileName: 'new-name.png',
      previousFileName: 'old-name.png',
      folderPath: 'images'
    })

    assert.equal(copyMock.mock.callCount(), 1)
    const copyCall = copyMock.mock.calls[0]!
    const destinationKey = `${target.siteId}/images/new-name.png`
    const sourceKey = `${target.siteId}/images/old-name.png`
    assert.equal((copyCall.this as File).name, sourceKey)
    assert.equal((copyCall.arguments[0] as File).name, destinationKey)

    assert.equal(deleteMock.mock.callCount(), 1)
    const deleteCall = deleteMock.mock.calls[0]!
    assert.equal((deleteCall.this as File).name, sourceKey)
  })
})

describe('gcs storage / exportAll', () => {
  test('pushes only assets the target contentTypes cover, keyed under the site', async () => {
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

    await storageModule.exportAll(target)

    assert.equal(saveMock.mock.callCount(), 1)
    const call = saveMock.mock.calls[0]!
    assert.equal((call.this as File).name, `${target.siteId}/gallery/pic.png`)
  })

  test('a large asset is exported under the large bucket instead of its kind, when large is active', async () => {
    const target = makeTarget()
    target.contentTypes = { activeTypes: ['large'], largeThreshold: '1B' }

    WIKI.models.assets.streamAll = async function* () {
      yield {
        id: 'a1',
        fileName: 'huge.bin',
        folderPath: '',
        kind: 'other',
        fileSize: 999,
        mimeType: 'application/octet-stream',
        data: Buffer.from('x')
      }
    } as any

    await storageModule.exportAll(target)

    assert.equal(saveMock.mock.callCount(), 1)
  })

  test('an activation failure (missing bucket) surfaces as a thrown Error rather than an unhandled SDK exception', async () => {
    existsMock.mock.mockImplementationOnce(async () => [false] as any)
    const target = makeTarget({ bucket: 'nonexistent-bucket' })
    WIKI.models.assets.streamAll = async function* () {} as any

    await assert.rejects(
      () => storageModule.exportAll(target),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /nonexistent-bucket/)
        return true
      }
    )
  })
})

describe('gcs storage / getDirectUrl', () => {
  test('requests a short-TTL, read-only signed URL for the object', async () => {
    const target = makeTarget()

    const url = await storageModule.getDirectUrl!(
      {
        id: 'asset-1',
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        folderPath: 'images',
        fileName: 'pic.png'
      },
      target
    )

    assert.equal(url, 'https://storage.googleapis.com/signed')
    assert.equal(getSignedUrlMock.mock.callCount(), 1)
    const call = getSignedUrlMock.mock.calls[0]!
    assert.equal((call.this as File).name, `${target.siteId}/images/pic.png`)
    const config = call.arguments[0] as any
    assert.equal(config.action, 'read')
    const deltaSeconds = (config.expires - Date.now()) / 1000
    assert.ok(deltaSeconds > 290 && deltaSeconds <= 300, `expected ~300s TTL, got ${deltaSeconds}`)
  })
})
