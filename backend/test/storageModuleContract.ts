import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from './mocks.ts'
import { DIRECT_ACCESS_TTL_SECONDS } from '../modules/storage/blobBase.ts'
import type { StorageModule, StorageTarget } from '../models/storage.ts'

/**
 * The asset lifecycle every cloud blob storage module owes `models/storage.ts`, run once per module.
 *
 * `blobBase.test.ts` proves the shared implementation against a fake driver; what this runner adds
 * is that each module's real SDK callbacks carry the same behaviour out to the real client objects.
 * What stays in a module's own `storage.test.ts` is everything genuinely about its cloud: client
 * construction and endpoint/mode branching, bucket or container activation and how each reports a
 * failure, and each SDK's own copy/tier quirks.
 *
 * `sftp`, `git`, `disk` and `db` are not blob targets, are not built on `blobStorageModule`, and do
 * not run this.
 */

export interface StorageSdkStub {
  module: StorageModule
  puts(): { key: string; body: string; mimeType: string; storageTier?: string }[]
  removes(): string[]
  copies(): { sourceKey: string; destinationKey: string }[]
  /**
   * Takes the URL because two of the three sign it locally and hand back a real one to parse, while
   * GCS's `getSignedUrl` is an SDK call whose request is what carries the key and the expiry — so
   * only the module itself knows where to read them from.
   */
  describeDirectUrl(url: string): { key: string; ttlSeconds: number }
}

export interface StorageContractOptions {
  /** Fresh per test: a module's per-target activation cache must not leak between cases. */
  makeTarget(configOverrides?: Record<string, any>): StorageTarget
  stubSdk(): StorageSdkStub
}

function streamedAsset(overrides: Record<string, any> = {}) {
  return {
    id: 'a1',
    fileName: 'pic.png',
    folderPath: 'gallery',
    kind: 'image',
    fileSize: 100,
    mimeType: 'image/png',
    data: Buffer.from('img'),
    ...overrides
  }
}

export function runStorageModuleContract(name: string, options: StorageContractOptions): void {
  const { makeTarget, stubSdk } = options

  describe('blob storage asset lifecycle', () => {
    let wikiHandle: { restore(): void }

    before(() => {
      // -> Its own `CARDINAL`, not whatever the module's suite installed: what a contract test stages
      //    must not depend on another test in the same file leaving the global in some state.
      wikiHandle = installTestWiki({
        models: {
          assets: {
            getContent: mock.fn(async () => null),
            streamAll: async function* () {}
          }
        }
      })
    })

    after(() => {
      wikiHandle.restore()
    })

    function stageContent(content: unknown): void {
      ;(CARDINAL.models.assets.getContent as any).mock.mockImplementationOnce(async () => content)
    }

    test(`${name}: assetUploaded writes the fetched bytes under the site-scoped key`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()
      stageContent({ data: Buffer.from('hello'), mimeType: 'text/plain', fileName: 'notes.txt' })

      await sdk.module.assetUploaded!(target, {
        id: 'asset-1',
        fileName: 'notes.txt',
        folderPath: 'docs',
        kind: 'document',
        fileSize: 5
      })

      assert.equal(sdk.puts().length, 1)
      assert.equal(sdk.puts()[0]!.key, `${target.siteId}/docs/notes.txt`)
      assert.equal(sdk.puts()[0]!.body, 'hello')
    })

    test(`${name}: assetUploaded sends the fetched content type and the target's storage tier`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()
      stageContent({ data: Buffer.from('hi'), mimeType: 'text/plain', fileName: 'notes.txt' })

      await sdk.module.assetUploaded!(target, {
        id: 'asset-1',
        fileName: 'notes.txt',
        folderPath: '',
        fileSize: 2
      })

      assert.equal(sdk.puts()[0]!.mimeType, 'text/plain')
      assert.equal(sdk.puts()[0]!.storageTier, target.config.storageTier)
    })

    test(`${name}: assetUploaded is a no-op when the asset was deleted again before delivery`, async () => {
      const sdk = stubSdk()
      stageContent(null)

      await sdk.module.assetUploaded!(makeTarget(), {
        id: 'gone',
        fileName: 'x.txt',
        folderPath: ''
      })

      assert.deepEqual(sdk.puts(), [])
    })

    test(`${name}: assetDeleted removes the site-scoped key`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      await sdk.module.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

      assert.deepEqual(sdk.removes(), [`${target.siteId}/images/old.png`])
    })

    test(`${name}: assetRenamed copies the source key to the destination key`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      await sdk.module.assetRenamed!(target, {
        fileName: 'new-name.png',
        previousFileName: 'old-name.png',
        folderPath: 'images'
      })

      assert.deepEqual(sdk.copies(), [
        {
          sourceKey: `${target.siteId}/images/old-name.png`,
          destinationKey: `${target.siteId}/images/new-name.png`
        }
      ])
    })

    test(`${name}: assetRenamed removes the source key once the copy has landed`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      await sdk.module.assetRenamed!(target, {
        fileName: 'new-name.png',
        previousFileName: 'old-name.png',
        folderPath: 'images'
      })

      assert.deepEqual(sdk.removes(), [`${target.siteId}/images/old-name.png`])
    })

    test(`${name}: assetMoved copies the source key to the destination key (OpenProject #3384)`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      await sdk.module.assetMoved!(target, {
        fileName: 'pic.png',
        folderPath: 'gallery',
        previousFolderPath: 'images'
      })

      assert.deepEqual(sdk.copies(), [
        {
          sourceKey: `${target.siteId}/images/pic.png`,
          destinationKey: `${target.siteId}/gallery/pic.png`
        }
      ])
    })

    test(`${name}: assetMoved removes the source key once the copy has landed`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      await sdk.module.assetMoved!(target, {
        fileName: 'pic.png',
        folderPath: 'gallery',
        previousFolderPath: 'images'
      })

      assert.deepEqual(sdk.removes(), [`${target.siteId}/images/pic.png`])
    })

    /**
     * Nothing upstream of `exportAll` filters assets by content type, so its own `contentTypes` read
     * is the only place a target's `activeTypes` is honoured.
     */
    test(`${name}: exportAll pushes only the assets the target's contentTypes cover`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()
      target.contentTypes = { activeTypes: ['images'], largeThreshold: '1MB' }
      CARDINAL.models.assets.streamAll = async function* () {
        yield streamedAsset()
        yield streamedAsset({
          id: 'a2',
          fileName: 'report.pdf',
          folderPath: 'docs',
          kind: 'document',
          fileSize: 200,
          mimeType: 'application/pdf',
          data: Buffer.from('doc')
        })
      } as any

      await sdk.module.exportAll(target)

      assert.equal(sdk.puts().length, 1)
      assert.equal(sdk.puts()[0]!.key, `${target.siteId}/gallery/pic.png`)
    })

    test(`${name}: exportAll pushes a large asset under the large bucket when large is active`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()
      target.contentTypes = { activeTypes: ['large'], largeThreshold: '1B' }
      CARDINAL.models.assets.streamAll = async function* () {
        yield streamedAsset({
          fileName: 'huge.bin',
          folderPath: '',
          kind: 'other',
          fileSize: 999,
          mimeType: 'application/octet-stream',
          data: Buffer.from('x')
        })
      } as any

      await sdk.module.exportAll(target)

      assert.equal(sdk.puts().length, 1)
      assert.equal(sdk.puts()[0]!.key, `${target.siteId}/huge.bin`)
    })

    test(`${name}: getDirectUrl addresses the site-scoped key`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      const url = await sdk.module.getDirectUrl!(
        {
          id: 'asset-1',
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          folderPath: 'images',
          fileName: 'pic.png'
        },
        target
      )

      assert.equal(sdk.describeDirectUrl(url!).key, `${target.siteId}/images/pic.png`)
    })

    /**
     * Minutes, not hours: generated per request for one browser to fetch immediately, never
     * something meant to be bookmarked.
     */
    test(`${name}: getDirectUrl expires within the shared direct-access TTL`, async () => {
      const sdk = stubSdk()
      const target = makeTarget()

      const url = await sdk.module.getDirectUrl!(
        {
          id: 'asset-1',
          updatedAt: new Date('2024-01-01T00:00:00Z'),
          folderPath: 'images',
          fileName: 'pic.png'
        },
        target
      )

      const { ttlSeconds } = sdk.describeDirectUrl(url!)
      assert.ok(
        ttlSeconds > DIRECT_ACCESS_TTL_SECONDS - 10 && ttlSeconds <= DIRECT_ACCESS_TTL_SECONDS,
        `expected ~${DIRECT_ACCESS_TTL_SECONDS}s TTL, got ${ttlSeconds}`
      )
    })
  })
}
