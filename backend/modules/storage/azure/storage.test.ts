import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { BlockBlobClient, ContainerClient } from '@azure/storage-blob'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import storageModule, {
  buildServiceClient,
  ensureContainer,
  isContainerAlreadyExists
} from './storage.ts'
import { keyFor } from '../blobBase.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Pure unit tests: no database, no real network. `@azure/storage-blob` has no equivalent of
 * `aws-sdk-client-mock` in this repo (see `s3/storage.test.ts`), so the SDK's own I/O methods are
 * stubbed directly on the class prototypes with `node:test`'s `mock.method` — every `ContainerClient`
 * / `BlockBlobClient` instance this module constructs is a real instance of those classes, so patching
 * the prototype catches every call. `generateSasUrl` is exercised for real (unmocked): it's pure local
 * signing against the `StorageSharedKeyCredential`, no network call — see `storage.ts`'s doc comment.
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

let createMock: ReturnType<typeof mock.method>
let uploadMock: ReturnType<typeof mock.method>
let deleteMock: ReturnType<typeof mock.method>
let syncCopyMock: ReturnType<typeof mock.method>

beforeEach(() => {
  createMock = mock.method(ContainerClient.prototype, 'create', async () => ({}) as any)
  uploadMock = mock.method(BlockBlobClient.prototype, 'upload', async () => ({}) as any)
  deleteMock = mock.method(BlockBlobClient.prototype, 'delete', async () => ({}) as any)
  syncCopyMock = mock.method(BlockBlobClient.prototype, 'syncCopyFromURL', async () => ({}) as any)
  ;(WIKI.models.assets.getContent as any).mock.resetCalls()
})

afterEach(() => {
  mock.restoreAll()
})

/** A fresh target per test, so the module's per-target client cache never leaks between cases. */
function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
  return makeStorageTarget('azure', {
    title: 'Test Azure',
    config: {
      accountName: 'testaccount',
      accountKey: Buffer.from('fake-account-key').toString('base64'),
      containerName: 'wiki',
      storageTier: 'cool',
      ...configOverrides
    }
  })
}

describe('azure storage / buildServiceClient', () => {
  test('builds a client against the account-scoped blob endpoint, no network I/O', () => {
    const client = buildServiceClient({
      accountName: 'myaccount',
      accountKey: Buffer.from('key').toString('base64')
    })
    assert.equal(client.url, 'https://myaccount.blob.core.windows.net/')
  })
})

describe('azure storage / isContainerAlreadyExists', () => {
  test('recognizes a 409 statusCode', () => {
    assert.equal(isContainerAlreadyExists({ statusCode: 409 }), true)
  })

  test('rejects anything else', () => {
    assert.equal(isContainerAlreadyExists({ statusCode: 403 }), false)
    assert.equal(isContainerAlreadyExists({}), false)
  })
})

describe('azure storage / ensureContainer (activation)', () => {
  test('a successful create() needs no special handling', async () => {
    const client = buildServiceClient({
      accountName: 'a',
      accountKey: Buffer.from('k').toString('base64')
    })
    const container = client.getContainerClient('wiki')
    await ensureContainer(container)
    assert.equal(createMock.mock.callCount(), 1)
  })

  test('a 409 (already exists) is swallowed, matching 2.5.x', async () => {
    createMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The specified container already exists.'), { statusCode: 409 })
    })
    const client = buildServiceClient({
      accountName: 'a',
      accountKey: Buffer.from('k').toString('base64')
    })
    const container = client.getContainerClient('wiki')
    await assert.doesNotReject(() => ensureContainer(container))
  })

  test('a non-409 failure throws a readable Error', async () => {
    createMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Server failed to authenticate the request.'), {
        statusCode: 403
      })
    })
    const client = buildServiceClient({
      accountName: 'a',
      accountKey: Buffer.from('k').toString('base64')
    })
    const container = client.getContainerClient('locked-container')
    await assert.rejects(
      () => ensureContainer(container),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /locked-container/)
        assert.match(err.message, /authenticate/)
        return true
      }
    )
  })
})

describe('azure storage / keyFor', () => {
  test('scopes the key by siteId and joins the folder path', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, 'docs/reports', 'q1.pdf'), `${target.siteId}/docs/reports/q1.pdf`)
  })

  test('an empty folderPath yields a key straight under the site', () => {
    const target = makeTarget()
    assert.equal(keyFor(target, '', 'logo.png'), `${target.siteId}/logo.png`)
  })
})

describe('azure storage / per-asset lifecycle', () => {
  test('assetUploaded fetches the bytes and uploads them under the site-scoped key, with the configured tier', async () => {
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

    assert.equal(uploadMock.mock.callCount(), 1)
    const call = uploadMock.mock.calls[0]!
    assert.equal((call.arguments[0] as Buffer).toString(), 'hello')
    assert.equal(call.arguments[1], 5)
    const options = call.arguments[2] as any
    assert.equal(options.tier, 'cool')
    assert.equal(options.blobHTTPHeaders.blobContentType, 'text/plain')
    // -> the BlockBlobClient this call landed on is scoped to the site-prefixed key
    assert.equal((call.this as BlockBlobClient).name, `${target.siteId}/docs/notes.txt`)
  })

  test('assetUploaded is a no-op when the asset was deleted again before delivery', async () => {
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => null)
    const target = makeTarget()

    await storageModule.assetUploaded!(target, { id: 'gone', fileName: 'x.txt', folderPath: '' })

    assert.equal(uploadMock.mock.callCount(), 0)
  })

  test('assetDeleted deletes the site-scoped key with snapshots included', async () => {
    const target = makeTarget()

    await storageModule.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

    assert.equal(deleteMock.mock.callCount(), 1)
    const call = deleteMock.mock.calls[0]!
    assert.deepEqual(call.arguments[0], { deleteSnapshots: 'include' })
    assert.equal((call.this as BlockBlobClient).name, `${target.siteId}/images/old.png`)
  })

  test('assetRenamed copies to the new key via syncCopyFromURL, then deletes the old one', async () => {
    const target = makeTarget()

    await storageModule.assetRenamed!(target, {
      fileName: 'new-name.png',
      previousFileName: 'old-name.png',
      folderPath: 'images'
    })

    assert.equal(syncCopyMock.mock.callCount(), 1)
    const copyCall = syncCopyMock.mock.calls[0]!
    const destinationKey = `${target.siteId}/images/new-name.png`
    const sourceKey = `${target.siteId}/images/old-name.png`
    assert.equal((copyCall.this as BlockBlobClient).name, destinationKey)
    // -> unlike S3's CopySource, syncCopyFromURL takes the source client's own (unencoded) `.url`
    assert.ok((copyCall.arguments[0] as string).endsWith(`wiki/${sourceKey}`))

    assert.equal(deleteMock.mock.callCount(), 1)
    const deleteCall = deleteMock.mock.calls[0]!
    assert.equal((deleteCall.this as BlockBlobClient).name, sourceKey)
  })
})

describe('azure storage / exportAll', () => {
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

    assert.equal(uploadMock.mock.callCount(), 1)
    const call = uploadMock.mock.calls[0]!
    assert.equal((call.this as BlockBlobClient).name, `${target.siteId}/gallery/pic.png`)
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

    assert.equal(uploadMock.mock.callCount(), 1)
  })

  test('an activation failure (bad container) surfaces as a thrown Error rather than an unhandled SDK exception', async () => {
    createMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Server failed to authenticate the request.'), {
        statusCode: 403
      })
    })
    const target = makeTarget({ containerName: 'forbidden-container' })
    WIKI.models.assets.streamAll = async function* () {} as any

    await assert.rejects(
      () => storageModule.exportAll(target),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /forbidden-container/)
        return true
      }
    )
  })
})

describe('azure storage / getDirectUrl', () => {
  test('returns a short-TTL, read-only SAS URL for the blob', async () => {
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

    const parsed = new URL(url!)
    assert.ok(parsed.pathname.includes(`${target.siteId}/images/pic.png`))
    assert.equal(parsed.searchParams.get('sp'), 'r')
    const expiry = new Date(parsed.searchParams.get('se')!)
    const deltaSeconds = (expiry.getTime() - Date.now()) / 1000
    assert.ok(deltaSeconds > 290 && deltaSeconds <= 300, `expected ~300s TTL, got ${deltaSeconds}`)
  })
})
