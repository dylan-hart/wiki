import {
  type BucketLocationConstraint,
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type StorageClass
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { blobStorageModule } from '../blobBase.ts'

/**
 * S3-compatible blob storage — AWS S3, DigitalOcean Spaces, or any other S3-compatible endpoint,
 * selected by the `mode` prop `definition.yml` declares (`aws` / `do` / `custom`). Assets only:
 * `definition.yml` excludes `pages` from `contentTypes.defaultTypesEnabled` and declares
 * `versioning.isSupported: false`, so there is no page lifecycle to serve here.
 */

/** DigitalOcean Spaces' endpoint shape: one hostname per region, not a separately configured URL. */
function doEndpoint(region: string): string {
  return `https://${region}.digitaloceanspaces.com`
}

/**
 * `sslEnabled` is an override, not just a fallback: turning it off forces `http://` even when the
 * endpoint field still reads `https://…`, since that toggle is the whole reason it exists. Left on,
 * an explicit scheme is kept as typed and a bare host gets `https://` added.
 */
export function resolveCustomEndpoint(config: Record<string, any>): string {
  const raw = String(config.endpoint ?? '').trim()
  const host = raw.replace(/^https?:\/\//i, '')
  if (config.sslEnabled === false) {
    return `http://${host}`
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${host}`
}

export function buildClient(config: Record<string, any>): S3Client {
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }

  if (config.mode === 'do') {
    return new S3Client({
      region: config.doRegion,
      endpoint: doEndpoint(config.doRegion),
      credentials
    })
  }

  if (config.mode === 'custom') {
    return new S3Client({
      // -> SigV4 signing needs a region even against a non-AWS endpoint, and the signature is
      //    cryptographically bound to it — a self-hosted S3-compatible server (Garage's
      //    `s3_region`) validates the signed region against its own — so it must stay
      //    user-configurable rather than a fixed literal. The fallback is not redundant with
      //    `definition.yml`'s default: this is also called with a bare config that never went
      //    through `models/storage.ts#buildConfig`, and the SDK throws "Region is missing" outright.
      region: config.region || 'us-east-1',
      endpoint: resolveCustomEndpoint(config),
      forcePathStyle: Boolean(config.s3ForcePathStyle),
      // -> Whether `endpoint` already addresses this one bucket rather than the provider's root
      //    API. The SDK's name for what `definition.yml` calls `s3BucketEndpoint`; it changes how
      //    the client builds request URLs, never the object key this module computes.
      bucketEndpoint: Boolean(config.s3BucketEndpoint),
      credentials
    })
  }

  // -> 'aws', and the fallback for anything unrecognized
  return new S3Client({ region: config.awsRegion, credentials })
}

export function isBucketNotFound(err: any): boolean {
  return (
    err?.$metadata?.httpStatusCode === 404 ||
    err?.name === 'NotFound' ||
    err?.name === 'NoSuchBucket'
  )
}

/**
 * A missing bucket is created rather than treated as a hard failure: the bucket prop names a bucket
 * *to create*, so a target is meant to work on first activation without the admin having created it
 * out of band. Every failure is rethrown as a plain `Error` carrying the SDK's message, so it
 * reaches the admin UI through `executeAction`'s `reply.badRequest(err.message)` rather than
 * surfacing as an unhandled SDK exception.
 */
export async function ensureBucket(client: S3Client, config: Record<string, any>): Promise<void> {
  const bucket = config.bucket
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    return
  } catch (err: any) {
    if (!isBucketNotFound(err)) {
      throw new Error(`Could not reach the "${bucket}" bucket: ${err.message ?? err}`)
    }
  }

  try {
    const params: {
      Bucket: string
      CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint }
    } = { Bucket: bucket }
    // -> AWS refuses a bucket creation outside 'us-east-1' without an explicit LocationConstraint;
    //    DigitalOcean Spaces and a generic custom endpoint have no such requirement.
    if (config.mode === 'aws' && config.awsRegion && config.awsRegion !== 'us-east-1') {
      params.CreateBucketConfiguration = {
        LocationConstraint: config.awsRegion as BucketLocationConstraint
      }
    }
    await client.send(new CreateBucketCommand(params))
  } catch (err: any) {
    throw new Error(
      `The "${bucket}" bucket does not exist and could not be created: ${err.message ?? err}`
    )
  }
}

/** `storageTier`'s `if: mode eq aws` in `definition.yml` is a UI-only gate: `models/storage.ts`'s
 *  `buildConfig()` fills every prop with its default regardless, so a `do`/`custom` target carries a
 *  leftover `storageTier` that must never be sent as its `StorageClass`. */
export function storageClassFor(config: Record<string, any>): StorageClass | undefined {
  return config.mode === 'aws' && config.storageTier
    ? (config.storageTier as StorageClass)
    : undefined
}

/**
 * Every path segment percent-encoded, the `/` separators between them left literal.
 * `encodeURIComponent` alone also encodes `/` to `%2F`, which corrupts every key with a folder in it
 * — and `keyFor` always prefixes `<siteId>/`, so that is every key this module builds. Only a real
 * S3 server catches a wrong value here; a mock asserts whatever string this produces.
 */
export function encodeCopySourceKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * Unlike Azure's `ContainerClient` or GCS's `Bucket`, an `S3Client` carries no bucket of its own —
 * every command names one — so what `blobBase.ts` activates is the client plus that bucket.
 */
interface S3Target {
  client: S3Client
  bucket: string
}

const s3Storage = blobStorageModule<S3Target>({
  label: 'S3',
  async build(config) {
    const client = buildClient(config)
    await ensureBucket(client, config)
    return { client, bucket: config.bucket }
  },
  async put({ client, bucket }, key, body, mimeType, config) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        StorageClass: storageClassFor(config)
      })
    )
  },
  async remove({ client, bucket }, key) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  },
  async copy({ client, bucket }, sourceKey, destinationKey, config) {
    // -> `CopySource` always needs the bucket prefixed and the key encoded, regardless of
    //    `s3BucketEndpoint`: it addresses the source object directly rather than being resolved
    //    against the client's own endpoint routing.
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeCopySourceKey(sourceKey)}`,
        Key: destinationKey,
        StorageClass: storageClassFor(config)
      })
    )
  },
  sign({ client, bucket }, key, ttlSeconds) {
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: ttlSeconds
    })
  }
})

export default s3Storage
