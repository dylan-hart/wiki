import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import {
  contentTypeBucketForAsset,
  exportAssets,
  parseSizeToBytes,
  remotePathForAsset,
  type AssetExportRow
} from './assets.ts'
import type { StorageTarget } from '../../../models/storage.ts'

function makeRow(overrides: Partial<AssetExportRow> = {}): AssetExportRow {
  return {
    id: '1',
    fileName: 'photo.png',
    folderPath: '',
    kind: 'image',
    fileSize: 1024,
    data: Buffer.from('fake-bytes'),
    ...overrides
  }
}

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 'target-1',
    siteId: 'site-1',
    module: 'sftp',
    isEnabled: true,
    title: 'SFTP',
    description: '',
    icon: '',
    banner: '',
    vendor: '',
    website: '',
    contentTypes: {
      activeTypes: ['images', 'documents', 'others', 'large'],
      largeThreshold: '5MB'
    },
    assetDelivery: {
      isStreamingSupported: false,
      isDirectAccessSupported: false,
      streaming: false,
      directAccess: false
    },
    versioning: { isSupported: false, isForceEnabled: false, enabled: false },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: false
    },
    props: {},
    config: { basePath: '/srv/wiki' },
    actions: [],
    ...overrides
  }
}

function makeStubClient(overrides: Record<string, any> = {}): any {
  return {
    exists: mock.fn(async () => 'd' as const),
    mkdir: mock.fn(async () => 'ok'),
    put: mock.fn(async () => 'ok'),
    ...overrides
  }
}

describe('remotePathForAsset', () => {
  test('joins folderPath and fileName when the asset is in a folder', () => {
    assert.equal(
      remotePathForAsset({ folderPath: 'diagrams/network', fileName: 'topology.png' }),
      'diagrams/network/topology.png'
    )
  })

  test('is just fileName at the site root', () => {
    assert.equal(remotePathForAsset({ folderPath: '', fileName: 'logo.svg' }), 'logo.svg')
  })
})

describe('parseSizeToBytes', () => {
  test('parses plain bytes', () => {
    assert.equal(parseSizeToBytes('512B'), 512)
  })

  test('parses KB/MB/GB/TB decimally, matching the `filesize` package this repo already formats with', () => {
    assert.equal(parseSizeToBytes('5MB'), 5_000_000)
    assert.equal(parseSizeToBytes('1KB'), 1_000)
    assert.equal(parseSizeToBytes('2GB'), 2_000_000_000)
    assert.equal(parseSizeToBytes('1TB'), 1_000_000_000_000)
  })

  test('is case-insensitive and tolerates a space before the unit', () => {
    assert.equal(parseSizeToBytes('5 mb'), 5_000_000)
  })

  test('rejects a malformed threshold', () => {
    assert.throws(() => parseSizeToBytes('huge'), /not a valid size threshold/)
  })
})

describe('contentTypeBucketForAsset', () => {
  test('classifies by kind when under the large threshold', () => {
    assert.equal(contentTypeBucketForAsset({ kind: 'image', fileSize: 1024 }, 5_000_000), 'images')
    assert.equal(
      contentTypeBucketForAsset({ kind: 'document', fileSize: 1024 }, 5_000_000),
      'documents'
    )
    assert.equal(contentTypeBucketForAsset({ kind: 'other', fileSize: 1024 }, 5_000_000), 'others')
  })

  test('reclassifies as large once fileSize exceeds the threshold, regardless of kind', () => {
    assert.equal(
      contentTypeBucketForAsset({ kind: 'image', fileSize: 6_000_000 }, 5_000_000),
      'large'
    )
  })

  test('a file exactly at the threshold is not yet large ("above" is strict)', () => {
    assert.equal(
      contentTypeBucketForAsset({ kind: 'image', fileSize: 5_000_000 }, 5_000_000),
      'images'
    )
  })
})

describe('exportAssets', () => {
  test('does nothing when no asset content type is active', async () => {
    const client = makeStubClient()
    const target = makeTarget({ contentTypes: { activeTypes: ['pages'], largeThreshold: '5MB' } })
    const fetchBatch = mock.fn(async () => [])

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(fetchBatch.mock.calls.length, 0)
    assert.equal(client.put.mock.calls.length, 0)
  })

  test('ensures the containing directory then writes the raw bytes for a foldered asset', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const row = makeRow({ folderPath: 'diagrams/network', fileName: 'topology.png' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 1)
    const [body, remotePath] = client.put.mock.calls[0].arguments
    assert.equal(remotePath, '/srv/wiki/diagrams/network/topology.png')
    assert.equal(Buffer.isBuffer(body), true)
    assert.equal(body.toString(), 'fake-bytes')

    const checkedPaths = client.exists.mock.calls.map((c: any) => c.arguments[0])
    assert.deepEqual(checkedPaths, ['/srv/wiki/diagrams', '/srv/wiki/diagrams/network'])
  })

  test('writes a root-level asset flat under basePath with no directory to ensure', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const row = makeRow({ folderPath: '', fileName: 'logo.svg' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 1)
    const [, remotePath] = client.put.mock.calls[0].arguments
    assert.equal(remotePath, '/srv/wiki/logo.svg')
    assert.equal(client.exists.mock.calls.length, 0)
  })

  test('skips a kind whose bucket is not in activeTypes', async () => {
    const client = makeStubClient()
    const target = makeTarget({
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    })
    const rows = [
      makeRow({ id: 'a', kind: 'image', fileName: 'a.png' }),
      makeRow({ id: 'b', kind: 'document', fileName: 'b.pdf' }),
      makeRow({ id: 'c', kind: 'other', fileName: 'c.bin' })
    ]
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? rows : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 1)
    assert.equal(client.put.mock.calls[0].arguments[1], '/srv/wiki/a.png')
  })

  test("skips a large asset when 'large' is not active, even though its kind's bucket is", async () => {
    const client = makeStubClient()
    const target = makeTarget({
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    })
    const row = makeRow({ kind: 'image', fileSize: 6_000_000, fileName: 'huge.png' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 0)
  })

  test("writes a large asset when 'large' is active, even though its kind's bucket is not", async () => {
    const client = makeStubClient()
    const target = makeTarget({
      contentTypes: { activeTypes: ['large'], largeThreshold: '5MB' }
    })
    const row = makeRow({ kind: 'document', fileSize: 6_000_000, fileName: 'huge.pdf' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 1)
  })

  test('skips an asset row with no data to write', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const row = makeRow({ data: null })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 0)
  })

  test('keyset-paginates across multiple batches until a short page is returned', async () => {
    const client = makeStubClient()
    const target = makeTarget()
    const batches: AssetExportRow[][] = [
      [makeRow({ id: 'a', fileName: 'a.png' }), makeRow({ id: 'b', fileName: 'b.png' })],
      [makeRow({ id: 'c', fileName: 'c.png' })],
      []
    ]
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) => {
      if (afterId === null) return batches[0]
      if (afterId === 'b') return batches[1]
      throw new Error(`unexpected afterId ${afterId}`)
    })

    await exportAssets(client as unknown as Client, target, { fetchBatch, pageSize: 2 })

    assert.equal(fetchBatch.mock.calls.length, 2)
    assert.equal(fetchBatch.mock.calls[0].arguments[0].afterId, null)
    assert.equal(fetchBatch.mock.calls[1].arguments[0].afterId, 'b')
    assert.equal(client.put.mock.calls.length, 3)
  })
})
