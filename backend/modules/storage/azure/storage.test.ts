import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { BlockBlobClient, ContainerClient } from '@azure/storage-blob'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { runStorageModuleContract } from '../../../test/storageModuleContract.ts'
import storageModule, {
  buildServiceClient,
  ensureContainer,
  isBlobNotFound,
  isContainerAlreadyExists
} from './storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * `@azure/storage-blob` has no `aws-sdk-client-mock` equivalent here, so its I/O methods are stubbed
 * on the class prototypes — every client this module constructs is a real instance of those classes,
 * so the patch catches every call. `generateSasUrl` is left unmocked: it is pure local signing
 * against the `StorageSharedKeyCredential`, with no network call to avoid.
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
let downloadMock: ReturnType<typeof mock.method>
let getPropertiesMock: ReturnType<typeof mock.method>

beforeEach(() => {
  createMock = mock.method(ContainerClient.prototype, 'create', async () => ({}) as any)
  uploadMock = mock.method(BlockBlobClient.prototype, 'upload', async () => ({}) as any)
  deleteMock = mock.method(BlockBlobClient.prototype, 'delete', async () => ({}) as any)
  syncCopyMock = mock.method(BlockBlobClient.prototype, 'syncCopyFromURL', async () => ({}) as any)
  downloadMock = mock.method(
    BlockBlobClient.prototype,
    'download',
    async () =>
      ({ readableStreamBody: Readable.from([Buffer.from('hello')]), contentLength: 5 }) as any
  )
  getPropertiesMock = mock.method(
    BlockBlobClient.prototype,
    'getProperties',
    async () => ({ contentLength: 42 }) as any
  )
  ;(CARDINAL.models.assets.getContent as any).mock.resetCalls()
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

describe('azure storage / isBlobNotFound', () => {
  test('recognizes a 404', () => {
    assert.equal(isBlobNotFound({ statusCode: 404 }), true)
  })

  test('a missing container is a failure, not a missing blob', () => {
    assert.equal(isBlobNotFound({ statusCode: 404, code: 'ContainerNotFound' }), false)
    assert.equal(
      isBlobNotFound({ statusCode: 404, details: { errorCode: 'ContainerNotFound' } }),
      false
    )
  })

  test('rejects anything else', () => {
    assert.equal(isBlobNotFound({ statusCode: 403 }), false)
    assert.equal(isBlobNotFound({}), false)
    assert.equal(isBlobNotFound(undefined), false)
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

/** What this SDK's call shapes carry that `test/storageModuleContract.ts`'s readers cannot see. */
describe('azure storage / per-asset lifecycle', () => {
  test('assetUploaded passes the byte length as upload()’s second, positional argument', async () => {
    ;(CARDINAL.models.assets.getContent as any).mock.mockImplementationOnce(async () => ({
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
    // -> `upload(body, contentLength, options)`: a wrong length here truncates or overruns the blob,
    //    and the SDK has no way to notice — it is not derived from the buffer.
    assert.equal(uploadMock.mock.calls[0]!.arguments[1], 5)
  })

  test('assetDeleted includes snapshots, so a versioned blob leaves nothing behind', async () => {
    const target = makeTarget()

    await storageModule.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

    assert.equal(deleteMock.mock.callCount(), 1)
    // -> Without `deleteSnapshots: 'include'` Azure REFUSES the delete outright for a blob that has
    //    snapshots, rather than deleting the base blob and orphaning them.
    assert.deepEqual(deleteMock.mock.calls[0]!.arguments[0], { deleteSnapshots: 'include' })
  })
})

describe('azure storage / exportAll', () => {
  test('an activation failure (bad container) surfaces as a thrown Error rather than an unhandled SDK exception', async () => {
    createMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Server failed to authenticate the request.'), {
        statusCode: 403
      })
    })
    const target = makeTarget({ containerName: 'forbidden-container' })
    CARDINAL.models.assets.streamAll = async function* () {} as any

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
  test('the SAS grants read and nothing else', async () => {
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

    assert.equal(new URL(url!).searchParams.get('sp'), 'r')
  })
})

describe('azure storage / readAsset and headAsset', () => {
  const asset = { folderPath: 'images', fileName: 'pic.png' }

  test('readAsset streams the blob body with its length, keyed under the site', async () => {
    const target = makeTarget()

    const result = await storageModule.readAsset!(asset, target)

    assert.equal(result!.size, 5)
    const chunks: Buffer[] = []
    for await (const chunk of result!.body) {
      chunks.push(chunk)
    }
    assert.equal(Buffer.concat(chunks).toString(), 'hello')
    assert.equal(
      (downloadMock.mock.calls[0]!.this as BlockBlobClient).name,
      `${target.siteId}/images/pic.png`
    )
  })

  test('readAsset maps a missing blob to null', async () => {
    downloadMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('The specified blob does not exist.'), { statusCode: 404 })
    })

    assert.equal(await storageModule.readAsset!(asset, makeTarget()), null)
  })

  test('readAsset wraps any other failure', async () => {
    downloadMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Server failed to authenticate the request.'), {
        statusCode: 403
      })
    })

    await assert.rejects(
      () => storageModule.readAsset!(asset, makeTarget()),
      /^Error: Failed to read ".*": Server failed to authenticate the request\.$/
    )
  })

  test('readAsset treats a missing container as a failure, not a not-found', async () => {
    downloadMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('no container'), {
        statusCode: 404,
        code: 'ContainerNotFound'
      })
    })

    await assert.rejects(() => storageModule.readAsset!(asset, makeTarget()), /no container/)
  })

  test('readAsset fails when the response carries no body', async () => {
    downloadMock.mock.mockImplementationOnce(async () => ({ contentLength: 5 }) as any)

    await assert.rejects(() => storageModule.readAsset!(asset, makeTarget()), /no body/)
  })

  test('headAsset returns the content length', async () => {
    const target = makeTarget()

    assert.deepEqual(await storageModule.headAsset!(asset, target), { size: 42 })
    assert.equal(
      (getPropertiesMock.mock.calls[0]!.this as BlockBlobClient).name,
      `${target.siteId}/images/pic.png`
    )
  })

  test('headAsset maps a missing blob to null', async () => {
    getPropertiesMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Not Found'), { statusCode: 404 })
    })

    assert.equal(await storageModule.headAsset!(asset, makeTarget()), null)
  })

  test('headAsset wraps any other failure', async () => {
    getPropertiesMock.mock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })

    await assert.rejects(
      () => storageModule.headAsset!(asset, makeTarget()),
      /^Error: Failed to inspect ".*": Forbidden$/
    )
  })
})

/**
 * The asset-lifecycle claims every blob storage module owes `models/storage.ts`, translated into
 * this SDK's call shapes. Everything above this line is this module's alone.
 */
runStorageModuleContract('azure', {
  makeTarget,
  stubSdk: () => {
    /** `<container>/<key>` off a blob URL's path, dropping the container segment. */
    const keyFromUrl = (url: string) =>
      new URL(url).pathname.replace(/^\//, '').split('/').slice(1).join('/')
    return {
      module: storageModule,
      puts: () =>
        uploadMock.mock.calls.map((call) => ({
          key: (call.this as BlockBlobClient).name,
          body: (call.arguments[0] as Buffer).toString(),
          mimeType: (call.arguments[2] as any).blobHTTPHeaders.blobContentType,
          storageTier: (call.arguments[2] as any).tier
        })),
      removes: () => deleteMock.mock.calls.map((call) => (call.this as BlockBlobClient).name),
      copies: () =>
        syncCopyMock.mock.calls.map((call) => ({
          // -> unlike S3's CopySource, syncCopyFromURL takes the source client's own (unencoded) URL
          sourceKey: keyFromUrl(call.arguments[0] as string),
          destinationKey: (call.this as BlockBlobClient).name
        })),
      describeDirectUrl: (url: string) => {
        const parsed = new URL(url)
        const expiry = new Date(parsed.searchParams.get('se')!)
        return {
          key: keyFromUrl(url),
          ttlSeconds: (expiry.getTime() - Date.now()) / 1000
        }
      }
    }
  }
})
