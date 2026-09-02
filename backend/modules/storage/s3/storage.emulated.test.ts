import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import S3rver from 's3rver'
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import storageModule from './storage.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * `storage.test.ts` mocks `S3Client.prototype.send` via `aws-sdk-client-mock`, which proves *which*
 * SDK commands this module issues with *which* parameters, but never actually serializes a request,
 * signs it, sends it over a socket, or parses a response — a typo in a parameter name or a wrong
 * signing region would type-check and pass that suite unchanged. This file instead runs the module's
 * real handlers against `s3rver`, an in-process server that speaks the actual S3 REST API (bucket
 * creation, PUT/GET/HEAD/COPY/DELETE object, real request signing), started fresh per test file and
 * torn down after. It exists to satisfy task 545's requirement to prove the SDK wiring is functional,
 * not just type-correct, against at least one of the three cloud targets — chosen here because s3rver
 * is a pure-npm devDependency with no Docker/daemon dependency, unlike LocalStack or Azurite.
 *
 * `allowMismatchedSignatures: true` is set so these tests exercise the object lifecycle rather than
 * s3rver's own signature-verification edge cases — SigV4 signing still runs on every request (the SDK
 * always signs), this only tells s3rver not to reject a signature it can't independently recompute.
 */
describe('s3 storage / against an emulated S3 backend (s3rver)', () => {
  let server: InstanceType<typeof S3rver>
  let dataDir: string
  let endpoint: string
  let verifyClient: S3Client
  let wikiHandle: { restore(): void }
  const bucket = 'wiki-emulated-test'

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 's3rver-'))
    server = new S3rver({
      address: '127.0.0.1',
      port: 0,
      silent: true,
      directory: dataDir,
      resetOnClose: true,
      allowMismatchedSignatures: true
    })
    const address = await server.run()
    endpoint = `http://127.0.0.1:${address.port}`
    verifyClient = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' }
    })

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
    await server.close()
    await rm(dataDir, { recursive: true, force: true })
    wikiHandle.restore()
  })

  /** A fresh target per test: a real (never-yet-activated) client per id, pointed at the emulator. */
  function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
    return makeStorageTarget('s3', {
      title: 'Emulated S3',
      config: {
        mode: 'custom',
        endpoint,
        sslEnabled: false,
        s3ForcePathStyle: true,
        s3BucketEndpoint: false,
        bucket,
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
        storageTier: 'STANDARD',
        ...configOverrides
      }
    })
  }

  test('ensureBucket creates the bucket on first activation, then assetUploaded round-trips real bytes', async () => {
    WIKI.models.assets.getContent = async () => ({
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
    WIKI.models.assets.getContent = async () => ({
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
    WIKI.models.assets.getContent = async () => ({
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
    target.contentTypes = { activeTypes: ['images'], largeThreshold: '1MB' }
    WIKI.models.assets.streamAll = async function* () {
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
    // -> Port 1 is a privileged, never-listening port: connection is refused deterministically, the
    //    same shape of failure a revoked-credentials or wrong-region misconfiguration produces —
    //    ensureBucket's HeadBucket attempt fails, is not a 404, and is rethrown as a plain Error.
    const target = makeTarget({ endpoint: 'http://127.0.0.1:1' })

    await assert.rejects(
      () => storageModule.assetUploaded!(target, { id: 'a1', folderPath: '', fileName: 'x.txt' }),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /Could not reach the "wiki-emulated-test" bucket/)
        return true
      }
    )
  })

  test('an invalid bucket name surfaces as a readable Error, not a raw SDK exception', async () => {
    // -> An empty Bucket fails the SDK's own client-side parameter validation before any request is
    //    sent — the "wrong bucket" half of task 545's broken-config requirement, deterministic and
    //    independent of s3rver's own bucket-naming rules.
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
