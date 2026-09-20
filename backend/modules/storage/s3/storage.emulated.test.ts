import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import crypto from 'node:crypto'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from '@aws-sdk/client-s3'
import storageModule from './storage.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { CONTENT_TYPES } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Mirrors `test/db.ts#hasTestDatabase()`'s `DATABASE_URL` convention: one
 * `http://user:pass@host:port` URL carrying the credentials too, so there is exactly one thing to
 * set to turn this suite on.
 */
function s3TestConfig(): { endpoint: string; accessKeyId: string; secretAccessKey: string } | null {
  const raw = process.env.S3_TEST_ENDPOINT
  if (!raw) return null
  const url = new URL(raw)
  return {
    endpoint: `${url.protocol}//${url.host}`,
    accessKeyId: decodeURIComponent(url.username),
    secretAccessKey: decodeURIComponent(url.password)
  }
}

const s3Test = s3TestConfig()

/**
 * `storage.test.ts` mocks `S3Client.prototype.send`, which proves *which* SDK commands this module
 * issues with *which* parameters but never serializes, signs or sends one — a typo in a parameter
 * name or a wrong signing region type-checks and passes it unchanged. This file runs the real
 * handlers against a container-backed MinIO instead, gated `{ skip: !s3Test }` the way
 * `hasTestDatabase()` suites are: with `S3_TEST_ENDPOINT` unset it reports skipped rather than
 * failing, and there is no in-process fallback. The bucket name carries a random suffix and is torn
 * down in `after()`, so repeated runs against a long-lived devcontainer MinIO never collide.
 */
describe('s3 storage / against a real S3-compatible backend (MinIO)', { skip: !s3Test }, () => {
  const bucket = `wiki-emulated-test-${crypto.randomBytes(4).toString('hex')}`
  let verifyClient: S3Client
  let wikiHandle: { restore(): void }

  before(async () => {
    verifyClient = new S3Client({
      region: 'us-east-1',
      endpoint: s3Test!.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: s3Test!.accessKeyId, secretAccessKey: s3Test!.secretAccessKey }
    })
    await verifyClient.send(new CreateBucketCommand({ Bucket: bucket }))

    wikiHandle = installTestWiki({
      models: {
        assets: {
          getContent: async () => null,
          streamAll: async function* () {}
        }
      }
    })
  })

  after(async () => {
    const listed = await verifyClient.send(new ListObjectsV2Command({ Bucket: bucket }))
    for (const obj of listed.Contents ?? []) {
      if (obj.Key)
        await verifyClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
    }
    await verifyClient.send(new DeleteBucketCommand({ Bucket: bucket }))
    wikiHandle.restore()
  })

  /** A fresh target id per test, so each one activates a real client rather than a cached one. */
  function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
    return makeStorageTarget('s3', {
      title: 'Emulated S3',
      config: {
        mode: 'custom',
        endpoint: s3Test?.endpoint,
        sslEnabled: s3Test?.endpoint.startsWith('https:') ?? false,
        s3ForcePathStyle: true,
        s3BucketEndpoint: false,
        bucket,
        accessKeyId: s3Test?.accessKeyId,
        secretAccessKey: s3Test?.secretAccessKey,
        storageTier: 'STANDARD',
        ...configOverrides
      }
    })
  }

  test('ensureBucket creates the bucket on first activation, then assetUploaded round-trips real bytes', async () => {
    CARDINAL.models.assets.getContent = async () => ({
      data: Buffer.from('hello from the emulator'),
      mimeType: 'text/plain',
      fileName: 'hello.txt'
    })

    const target = makeTarget()
    await storageModule.assetUploaded!(target, {
      id: 'a1',
      folderPath: 'docs',
      fileName: 'hello.txt'
    })

    const res = await verifyClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: 'site-1/docs/hello.txt' })
    )
    assert.equal(await res.Body!.transformToString(), 'hello from the emulator')
    assert.equal(res.ContentType, 'text/plain')
  })

  test('assetDeleted removes an object that was actually there', async () => {
    CARDINAL.models.assets.getContent = async () => ({
      data: Buffer.from('to be deleted'),
      mimeType: 'text/plain',
      fileName: 'gone.txt'
    })
    const target = makeTarget()
    await storageModule.assetUploaded!(target, { id: 'a1', folderPath: '', fileName: 'gone.txt' })
    await verifyClient.send(new HeadObjectCommand({ Bucket: bucket, Key: 'site-1/gone.txt' }))

    await storageModule.assetDeleted!(target, { fileName: 'gone.txt', folderPath: '' })

    await assert.rejects(
      () => verifyClient.send(new HeadObjectCommand({ Bucket: bucket, Key: 'site-1/gone.txt' })),
      (err: any) => err.$metadata?.httpStatusCode === 404
    )
  })

  test('assetRenamed moves the real object to its new key and removes the old one', async () => {
    CARDINAL.models.assets.getContent = async () => ({
      data: Buffer.from('renamed content'),
      mimeType: 'text/plain',
      fileName: 'old.txt'
    })
    const target = makeTarget()
    await storageModule.assetUploaded!(target, { id: 'a1', folderPath: 'x', fileName: 'old.txt' })

    await storageModule.assetRenamed!(target, {
      folderPath: 'x',
      previousFileName: 'old.txt',
      fileName: 'new.txt'
    })

    const res = await verifyClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: 'site-1/x/new.txt' })
    )
    assert.equal(await res.Body!.transformToString(), 'renamed content')
    await assert.rejects(() =>
      verifyClient.send(new HeadObjectCommand({ Bucket: bucket, Key: 'site-1/x/old.txt' }))
    )
  })

  test('exportAll writes only the assets the target contentTypes cover, at the real computed keys', async () => {
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
        data: Buffer.from('a real png, allegedly')
      }
      yield {
        id: 'a2',
        fileName: 'report.pdf',
        folderPath: 'docs',
        kind: 'document',
        fileSize: 200,
        mimeType: 'application/pdf',
        data: Buffer.from('a real pdf, allegedly')
      }
    } as any

    await storageModule.exportAll(target)

    const included = await verifyClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: 'site-1/gallery/pic.png' })
    )
    assert.equal(await included.Body!.transformToString(), 'a real png, allegedly')
    await assert.rejects(() =>
      verifyClient.send(new HeadObjectCommand({ Bucket: bucket, Key: 'site-1/docs/report.pdf' }))
    )
  })

  test('an unreachable endpoint (e.g. revoked network access) surfaces as a readable Error, not a raw SDK exception', async () => {
    // -> Port 1 is privileged and never listening, so the connection is refused deterministically:
    //    `ensureBucket`'s HeadBucket fails with something that is not a 404 and is rethrown.
    const target = makeTarget({ endpoint: 'http://127.0.0.1:1' })

    await assert.rejects(
      () => storageModule.assetUploaded!(target, { id: 'a1', folderPath: '', fileName: 'x.txt' }),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, new RegExp(`Could not reach the "${bucket}" bucket`))
        return true
      }
    )
  })

  test('an invalid bucket name surfaces as a readable Error, not a raw SDK exception', async () => {
    // -> An empty Bucket fails the SDK's own client-side parameter validation before any request is
    //    sent, so this stays independent of MinIO's own bucket-naming rules.
    const target = makeTarget({ bucket: '' })

    await assert.rejects(
      () => storageModule.assetUploaded!(target, { id: 'a1', folderPath: '', fileName: 'x.txt' }),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Could not reach the "" bucket/)
        return true
      }
    )
  })
})
