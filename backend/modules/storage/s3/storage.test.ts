import { describe, test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import storageModule, {
  buildClient,
  encodeCopySourceKey,
  ensureBucket,
  isBucketNotFound,
  resolveCustomEndpoint,
  storageClassFor
} from './storage.ts'
import { installTestWiki } from '../../../test/mocks.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { runStorageModuleContract } from '../../../test/storageModuleContract.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Pure unit tests: no database, no real network. The S3 SDK's HTTP layer is stubbed via
 * `aws-sdk-client-mock`, which patches `S3Client.prototype.send` — every instance this module
 * constructs is caught by the one mock installed below. `WIKI.logger`/`WIKI.models.assets` are the
 * only `WIKI` members `storage.ts` touches, so that's all the global stub needs to carry — see
 * "Testing (backend)" in CLAUDE.md for the pure-unit-test convention this follows.
 */

const s3Mock = mockClient(S3Client)

installTestWiki({
  models: {
    assets: {
      getContent: mock.fn(async () => null),
      streamAll: async function* () {}
    }
  }
})

beforeEach(() => {
  s3Mock.reset()
  s3Mock.on(HeadBucketCommand).resolves({})
  ;(WIKI.models.assets.getContent as any).mock.resetCalls()
})

/** A fresh target per test, so the module's per-target client cache never leaks between cases. */
function makeTarget(configOverrides: Record<string, any> = {}): StorageTarget {
  return makeStorageTarget('s3', {
    title: 'Test S3',
    config: {
      mode: 'aws',
      awsRegion: 'us-east-1',
      bucket: 'my-bucket',
      accessKeyId: 'AKIAFAKE',
      secretAccessKey: 'fakesecret',
      storageTier: 'STANDARD',
      ...configOverrides
    }
  })
}

describe('s3 storage / resolveCustomEndpoint', () => {
  test('keeps an explicit https scheme as typed', () => {
    assert.equal(
      resolveCustomEndpoint({ endpoint: 'https://service.region.example.com' }),
      'https://service.region.example.com'
    )
  })

  test('adds https:// to a bare host', () => {
    assert.equal(
      resolveCustomEndpoint({ endpoint: 'minio.example.com' }),
      'https://minio.example.com'
    )
  })

  test('sslEnabled: false forces http:// even over an https-typed endpoint', () => {
    assert.equal(
      resolveCustomEndpoint({ endpoint: 'https://minio.example.com', sslEnabled: false }),
      'http://minio.example.com'
    )
  })
})

describe('s3 storage / buildClient mode branching', () => {
  test('aws mode uses awsRegion, no custom endpoint', async () => {
    const client = buildClient({
      mode: 'aws',
      awsRegion: 'eu-west-1',
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    assert.equal(await client.config.region(), 'eu-west-1')
  })

  test('do mode uses doRegion against the DigitalOcean Spaces endpoint shape', async () => {
    const client = buildClient({
      mode: 'do',
      doRegion: 'nyc3',
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    assert.equal(await client.config.region(), 'nyc3')
    const endpoint = await client.config.endpoint!()
    assert.equal(endpoint.hostname, 'nyc3.digitaloceanspaces.com')
  })

  test('custom mode wires endpoint/forcePathStyle/bucketEndpoint from the target config', async () => {
    const client = buildClient({
      mode: 'custom',
      endpoint: 'https://minio.example.com',
      s3ForcePathStyle: true,
      s3BucketEndpoint: true,
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    const endpoint = await client.config.endpoint!()
    assert.equal(endpoint.hostname, 'minio.example.com')
    assert.equal(client.config.forcePathStyle, true)
    assert.equal((client.config as any).bucketEndpoint, true)
  })

  test('custom mode defaults forcePathStyle/bucketEndpoint to false when unset', () => {
    const client = buildClient({
      mode: 'custom',
      endpoint: 'https://minio.example.com',
      accessKeyId: 'a',
      secretAccessKey: 'b'
    })
    assert.equal(client.config.forcePathStyle, false)
    assert.equal((client.config as any).bucketEndpoint, false)
  })
})

describe('s3 storage / storageClassFor', () => {
  test('aws mode with a storage tier returns it as the StorageClass', () => {
    assert.equal(storageClassFor({ mode: 'aws', storageTier: 'GLACIER' }), 'GLACIER')
  })

  test('do mode never returns a StorageClass, even if storageTier is populated', () => {
    assert.equal(storageClassFor({ mode: 'do', storageTier: 'STANDARD' }), undefined)
  })

  test('custom mode never returns a StorageClass, even if storageTier is populated', () => {
    assert.equal(storageClassFor({ mode: 'custom', storageTier: 'STANDARD' }), undefined)
  })
})

describe('s3 storage / encodeCopySourceKey', () => {
  test('leaves the `/` path separators literal', () => {
    assert.equal(encodeCopySourceKey('site-1/docs/report.pdf'), 'site-1/docs/report.pdf')
  })

  test('percent-encodes special characters within a segment', () => {
    assert.equal(
      encodeCopySourceKey('site-1/my folder/a file+name.png'),
      'site-1/my%20folder/a%20file%2Bname.png'
    )
  })

  test('a flat key with no folder is unaffected', () => {
    assert.equal(encodeCopySourceKey('site-1/logo.png'), 'site-1/logo.png')
  })
})

describe('s3 storage / ensureBucket (activation)', () => {
  test('a reachable bucket needs no create call', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }
    })
    await ensureBucket(client, { bucket: 'my-bucket', mode: 'aws', awsRegion: 'us-east-1' })
    assert.equal(s3Mock.commandCalls(CreateBucketCommand).length, 0)
  })

  test('a missing bucket (404) is created', async () => {
    s3Mock.on(HeadBucketCommand).rejects(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 }
      })
    )
    s3Mock.on(CreateBucketCommand).resolves({})
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }
    })
    await ensureBucket(client, { bucket: 'new-bucket', mode: 'aws', awsRegion: 'us-east-1' })
    assert.equal(s3Mock.commandCalls(CreateBucketCommand).length, 1)
  })

  test('creating a non-us-east-1 aws bucket sets LocationConstraint', async () => {
    s3Mock.on(HeadBucketCommand).rejects(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 }
      })
    )
    s3Mock.on(CreateBucketCommand).resolves({})
    const client = new S3Client({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }
    })
    await ensureBucket(client, { bucket: 'euro-bucket', mode: 'aws', awsRegion: 'eu-west-1' })
    const [call] = s3Mock.commandCalls(CreateBucketCommand)
    assert.deepEqual(call!.args[0].input.CreateBucketConfiguration, {
      LocationConstraint: 'eu-west-1'
    })
  })

  test('do mode never sets a LocationConstraint on create', async () => {
    s3Mock.on(HeadBucketCommand).rejects(
      Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 }
      })
    )
    s3Mock.on(CreateBucketCommand).resolves({})
    const client = new S3Client({
      region: 'nyc3',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }
    })
    await ensureBucket(client, { bucket: 'space', mode: 'do', doRegion: 'nyc3' })
    const [call] = s3Mock.commandCalls(CreateBucketCommand)
    assert.equal(call!.args[0].input.CreateBucketConfiguration, undefined)
  })

  test('a non-404 head failure throws a readable Error, and never attempts to create', async () => {
    s3Mock.on(HeadBucketCommand).rejects(
      Object.assign(new Error('Access Denied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 }
      })
    )
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }
    })
    await assert.rejects(
      () => ensureBucket(client, { bucket: 'locked-bucket', mode: 'aws', awsRegion: 'us-east-1' }),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /locked-bucket/)
        assert.match(err.message, /Access Denied/)
        return true
      }
    )
    assert.equal(s3Mock.commandCalls(CreateBucketCommand).length, 0)
  })

  test('isBucketNotFound recognizes a 404 status, NotFound, and NoSuchBucket', () => {
    assert.equal(isBucketNotFound({ $metadata: { httpStatusCode: 404 } }), true)
    assert.equal(isBucketNotFound({ name: 'NotFound' }), true)
    assert.equal(isBucketNotFound({ name: 'NoSuchBucket' }), true)
    assert.equal(
      isBucketNotFound({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
      false
    )
  })
})

describe('s3 storage / per-asset lifecycle', () => {
  /**
   * The key, the bytes and the content type are `test/storageModuleContract.ts`'s to assert. `Bucket`
   * is not part of that contract and could not be: `azure` and `gcs` bind their container/bucket into
   * the client object itself, while every S3 command carries it as an input field of its own — so an
   * unset or wrong `Bucket` here would be an S3-only defect the shared readers cannot see.
   */
  test('every per-asset command names the configured bucket', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
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
    await storageModule.assetDeleted!(target, { fileName: 'old.png', folderPath: 'images' })

    assert.equal(s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input.Bucket, 'my-bucket')
    assert.equal(s3Mock.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Bucket, 'my-bucket')
  })

  test('assetUploaded omits StorageClass in do mode even though storageTier is set', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    ;(WIKI.models.assets.getContent as any).mock.mockImplementationOnce(async () => ({
      data: Buffer.from('hi'),
      mimeType: 'text/plain',
      fileName: 'notes.txt'
    }))
    const target = makeTarget({ mode: 'do', doRegion: 'nyc3', storageTier: 'STANDARD' })

    await storageModule.assetUploaded!(target, {
      id: 'asset-2',
      fileName: 'notes.txt',
      folderPath: ''
    })

    const [call] = s3Mock.commandCalls(PutObjectCommand)
    assert.equal(call!.args[0].input.StorageClass, undefined)
  })

  test('assetRenamed copies to the new key (fully bucket-qualified CopySource) then deletes the old one', async () => {
    s3Mock.on(CopyObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
    const target = makeTarget()

    await storageModule.assetRenamed!(target, {
      fileName: 'new-name.png',
      previousFileName: 'old-name.png',
      folderPath: 'images'
    })

    const [copyCall] = s3Mock.commandCalls(CopyObjectCommand)
    const sourceKey = `${target.siteId}/images/old-name.png`
    const destinationKey = `${target.siteId}/images/new-name.png`
    assert.equal(copyCall!.args[0].input.Bucket, 'my-bucket')
    // -> Every segment of the key is percent-encoded, but the `/` separators between them stay
    //    literal — `encodeURIComponent(sourceKey)` whole would turn those into `%2F` and address a
    //    source object that does not exist, a regression `storage.emulated.test.ts` caught against a
    //    real S3-compatible server (this mocked assertion alone could not: it would happily match
    //    whatever the code produced, correct or not).
    assert.equal(
      copyCall!.args[0].input.CopySource,
      `my-bucket/${target.siteId}/images/old-name.png`
    )
    assert.equal(copyCall!.args[0].input.Key, destinationKey)

    const [deleteCall] = s3Mock.commandCalls(DeleteObjectCommand)
    assert.equal(deleteCall!.args[0].input.Key, sourceKey)
  })

  test('assetRenamed percent-encodes special characters within a segment without touching the `/` separators', async () => {
    s3Mock.on(CopyObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
    const target = makeTarget()

    await storageModule.assetRenamed!(target, {
      fileName: 'renamed.png',
      previousFileName: 'a file+name.png',
      folderPath: 'my folder'
    })

    const [copyCall] = s3Mock.commandCalls(CopyObjectCommand)
    assert.equal(
      copyCall!.args[0].input.CopySource,
      `my-bucket/${target.siteId}/my%20folder/a%20file%2Bname.png`
    )
  })
})

describe('s3 storage / exportAll', () => {
  test('an activation failure (bad bucket) surfaces as a thrown Error rather than an unhandled SDK exception', async () => {
    s3Mock.on(HeadBucketCommand).rejects(
      Object.assign(new Error('Forbidden'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 }
      })
    )
    const target = makeTarget({ bucket: 'forbidden-bucket' })
    WIKI.models.assets.streamAll = async function* () {} as any

    await assert.rejects(
      () => storageModule.exportAll(target),
      (err: any) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /forbidden-bucket/)
        return true
      }
    )
  })
})

/**
 * The ten asset-lifecycle claims every blob storage module owes `models/storage.ts`, read out of the
 * S3 SDK's own command inputs — see `test/storageModuleContract.ts` for what they are and why they
 * live in one place. Everything above this line is this module's alone.
 */
runStorageModuleContract('s3', {
  makeTarget,
  stubSdk: () => {
    s3Mock.on(PutObjectCommand).resolves({})
    s3Mock.on(DeleteObjectCommand).resolves({})
    s3Mock.on(CopyObjectCommand).resolves({})
    return {
      module: storageModule,
      puts: () =>
        s3Mock.commandCalls(PutObjectCommand).map((call) => ({
          key: call.args[0].input.Key!,
          body: (call.args[0].input.Body as Buffer).toString(),
          mimeType: call.args[0].input.ContentType!,
          storageTier: call.args[0].input.StorageClass
        })),
      removes: () =>
        s3Mock.commandCalls(DeleteObjectCommand).map((call) => call.args[0].input.Key!),
      copies: () =>
        s3Mock.commandCalls(CopyObjectCommand).map((call) => ({
          // -> `CopySource` is bucket-qualified and per-segment percent-encoded (its own tests below
          //    pin that shape); the contract asks about the key, so both are undone here.
          sourceKey: call.args[0].input
            .CopySource!.split('/')
            .slice(1)
            .map((segment) => decodeURIComponent(segment))
            .join('/'),
          destinationKey: call.args[0].input.Key!
        })),
      describeDirectUrl: (url: string) => {
        const parsed = new URL(url)
        return {
          key: parsed.pathname.replace(/^\//, ''),
          ttlSeconds: Number(parsed.searchParams.get('X-Amz-Expires'))
        }
      }
    }
  }
})
