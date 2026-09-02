import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { BlockBlobClient, ContainerClient } from '@azure/storage-blob'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { runStorageModuleContract } from '../../../test/storageModuleContract.ts'
import storageModule, {
  buildServiceClient,
  ensureContainer,
  isContainerAlreadyExists
} from './storage.ts'
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

describe('azure storage / exportAll', () => {
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
  /** That it addresses the right key for the shared TTL is the contract's; that it grants READ only,
   * as an SAS permission string, is this SDK's. */
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

/**
 * The ten asset-lifecycle claims every blob storage module owes `models/storage.ts`, read out of
 * `@azure/storage-blob`'s own call shapes — see `test/storageModuleContract.ts` for what they are
 * and why they live in one place. Everything above this line is this module's alone.
 */
runStorageModuleContract('azure', {
  makeTarget,
  stubSdk: () => {
    /** `<container>/<key>` off a blob URL's path, dropping the container the target is configured for. */
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
