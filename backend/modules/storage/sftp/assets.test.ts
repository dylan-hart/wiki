import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { describe, test } from 'node:test'
import type Client from 'ssh2-sftp-client'
import { exportAssets, remotePathForAsset, type AssetExportRow } from './assets.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
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
  return makeStorageTarget('sftp', {
    id: 'target-1',
    title: 'SFTP',
    assetDelivery: {
      isStreamingSupported: false,
      isDirectAccessSupported: false,
      streaming: false,
      directAccess: false
    },
    sync: {
      supportedModes: ['push'],
      schedule: false,
      mode: 'push',
      scheduleOverride: null,
      supportsContentSync: false
    },
    config: { basePath: '/srv/wiki' },
    ...overrides
  })
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

/**
 * The large-file threshold is `helpers/blobTarget.ts`'s, not this module's own any more: binary
 * (1024-based) units and `>=` at the boundary, the same classification `models/storage.ts`'s
 * write-path dispatch gate and the s3/azure/gcs targets apply. This module used to parse 1000-based
 * units and test `>`, so a 5,000,000-byte file on a `5MB` target was "large" here and nowhere else.
 * `helpers/blobTarget.test.ts` covers the parser and `categoryOf` directly; these two cases pin the
 * converged semantics where `exportAssets` actually acts on them.
 */
describe('exportAssets / large-file classification', () => {
  test('a file exactly at the threshold IS large (">=", 5MB = 5 * 1024²)', async () => {
    const client = makeStubClient()
    const target = makeTarget({
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    })
    const row = makeRow({ kind: 'image', fileSize: 5 * 1024 ** 2, fileName: 'exactly-5mb.png' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 0)
  })

  test('units are binary: a 5,000,000-byte file is still under a 5MB threshold', async () => {
    const client = makeStubClient()
    const target = makeTarget({
      contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
    })
    const row = makeRow({ kind: 'image', fileSize: 5_000_000, fileName: 'just-under.png' })
    const fetchBatch = mock.fn(async ({ afterId }: { afterId: string | null }) =>
      afterId === null ? [row] : []
    )

    await exportAssets(client as unknown as Client, target, { fetchBatch })

    assert.equal(client.put.mock.calls.length, 1)
    assert.equal(client.put.mock.calls[0].arguments[1], '/srv/wiki/just-under.png')
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
