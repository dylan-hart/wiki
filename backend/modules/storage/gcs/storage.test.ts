import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Bucket, File } from '@google-cloud/storage'
import storageModule, { buildClient, ensureBucket } from './storage.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { runStorageModuleContract } from '../../../test/storageModuleContract.ts'
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

describe('gcs storage / exportAll', () => {
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
  /** That it addresses the right key for the shared TTL is the contract's; that it asks for a `read`
   * action, and hands back exactly what the SDK signed, is this SDK's. */
  test("asks the SDK for a 'read' signed URL and returns it unchanged", async () => {
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
    assert.equal((getSignedUrlMock.mock.calls[0]!.arguments[0] as any).action, 'read')
  })
})

/**
 * The ten asset-lifecycle claims every blob storage module owes `models/storage.ts`, read out of
 * `@google-cloud/storage`'s own call shapes — see `test/storageModuleContract.ts` for what they are
 * and why they live in one place. Everything above this line is this module's alone.
 */
runStorageModuleContract('gcs', {
  makeTarget,
  stubSdk: () => ({
    module: storageModule,
    puts: () =>
      saveMock.mock.calls.map((call) => ({
        key: (call.this as File).name,
        body: (call.arguments[0] as Buffer).toString(),
        mimeType: (call.arguments[1] as any).contentType,
        storageTier: (call.arguments[1] as any).metadata.storageClass
      })),
    removes: () => deleteMock.mock.calls.map((call) => (call.this as File).name),
    copies: () =>
      copyMock.mock.calls.map((call) => ({
        sourceKey: (call.this as File).name,
        destinationKey: (call.arguments[0] as File).name
      })),
    // -> The URL itself is the SDK's canned answer here, carrying nothing to read back: `getSignedUrl`
    //    is the call that names the object and the expiry, so the request is what gets described.
    describeDirectUrl: () => {
      const call = getSignedUrlMock.mock.calls[0]!
      return {
        key: (call.this as File).name,
        ttlSeconds: ((call.arguments[0] as any).expires - Date.now()) / 1000
      }
    }
  })
})
