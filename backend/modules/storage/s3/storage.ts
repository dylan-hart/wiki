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
 * selected by the `mode` prop `definition.yml` declares (`aws` / `do` / `custom`). Folds what 2.5.x
 * split across three module directories (`s3`, `s3generic`, `digitalocean` — all subclasses of the
 * shared `S3CompatibleStorage` in `s3/common.js`) into the one client-construction branch below.
 *
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so unlike 2.5.x's
 * S3 module there is no `created`/`updated`/`renamed`/`deleted` page lifecycle to port — just the
 * asset side (`assetUploaded`/`assetDeleted`/`assetRenamed`, named to match the write-path dispatch
 * contract `models/storage.ts` documents) plus `exportAll`, all of which `blobStorageModule` provides
 * from the driver below.
 */

/** DigitalOcean Spaces' endpoint shape: one hostname per region, not a separately configured URL. */
function doEndpoint(region: string): string {
  return `https://${region}.digitaloceanspaces.com`
}

/**
 * A `custom` mode endpoint as configured. `sslEnabled` is an override, not just a fallback: turning
 * it off is expected to force `http://` even if the endpoint field still reads `https://…`, since
 * that toggle is the whole reason it exists. Left on (the default), an explicit scheme in the field
 * is kept as typed; a bare host gets `https://` added.
 */
export function resolveCustomEndpoint(config: Record<string, any>): string {
  const raw = String(config.endpoint ?? '').trim()
  const host = raw.replace(/^https?:\/\//i, '')
  if (config.sslEnabled === false) {
    return `http://${host}`
  }
  return /^https?:\/\//i.test(raw) ? raw : `https://${host}`
}

/**
 * Build the S3 client for a target's config, branching on `mode` exactly as `definition.yml` declares
 * it: `aws` uses `awsRegion` against the real AWS endpoints, `do` uses `doRegion` against the
 * DigitalOcean Spaces endpoint shape, `custom` uses the endpoint/SSL/path-style/bucket-endpoint props.
 */
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
      // -> SigV4 signing needs a region even against a non-AWS endpoint; the SDK has no "regionless"
      //    mode, and every S3-compatible provider accepts an arbitrary value here.
      region: 'us-east-1',
      endpoint: resolveCustomEndpoint(config),
      forcePathStyle: Boolean(config.s3ForcePathStyle),
      // -> Whether `endpoint` already addresses this one bucket rather than the provider's root API —
      //    the SDK's own name (`bucketEndpoint`) for the concept `definition.yml` calls
      //    `s3BucketEndpoint` (a holdover from the identically-named AWS SDK v2 option). This is what
      //    changes how the client builds request URLs for a single-bucket endpoint; it does not
      //    change the object key this module computes, which stays the same either way.
      bucketEndpoint: Boolean(config.s3BucketEndpoint),
      credentials
    })
  }

  // -> 'aws', and the fallback for anything unrecognized
  return new S3Client({ region: config.awsRegion, credentials })
}

/** Whether an S3 error means "no such bucket" rather than something else (bad credentials, network). */
export function isBucketNotFound(err: any): boolean {
  return (
    err?.$metadata?.httpStatusCode === 404 ||
    err?.name === 'NotFound' ||
    err?.name === 'NoSuchBucket'
  )
}

/**
 * Verify the configured bucket exists and this target can reach it — matching 2.5.x's `init()`, which
 * called `headBucket()` before anything else. Where reasonable, a missing bucket is created rather
 * than treated as a hard failure: 2.5.x's `definition.yml` phrased the prop as "the unique bucket name
 * to create", so a target pointed at a bucket that doesn't exist yet is meant to work on first
 * activation, not require the admin to have created it out of band first.
 *
 * Every failure — reaching the bucket, or creating it — is rethrown as a plain `Error` with a message
 * built from the SDK's own, so it reaches the admin UI through `executeAction`'s existing
 * `catch (err) { reply.badRequest(err.message) }` rather than surfacing as an unhandled SDK exception.
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

/** Only `aws` mode may set a `StorageClass` — `storageTier` is gated `if: mode eq aws` in
 *  `definition.yml`, but `models/storage.ts`'s `buildConfig()` still fills every prop with its
 *  default regardless of that UI-only gate, so `do`/`custom` targets carry a leftover `storageTier`
 *  value that must never be sent as their `StorageClass`. */
export function storageClassFor(config: Record<string, any>): StorageClass | undefined {
  return config.mode === 'aws' && config.storageTier
    ? (config.storageTier as StorageClass)
    : undefined
}

/**
 * A key as `CopySource` needs it: every path segment percent-encoded, but the `/` separators between
 * them left literal. `encodeURIComponent` alone also encodes `/` to `%2F`, which is fine for a flat
 * key but corrupts every key with a folder in it — and `keyFor` always prefixes with `<siteId>/`, so
 * that is every key this module ever builds. Caught only by `storage.emulated.test.ts`'s real S3
 * server: `aws-sdk-client-mock` asserts the exact string this function used to produce, so a wrong but
 * internally-consistent value passed that suite regardless of whether a real bucket could resolve it.
 */
export function encodeCopySourceKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

/**
 * What this module's driver hands `blobBase.ts` as its client: unlike Azure's `ContainerClient` or
 * GCS's `Bucket`, an `S3Client` carries no bucket of its own — every command names one — so the
 * activated pair is the client plus the bucket its target is configured against.
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
    //    `s3BucketEndpoint`: the parameter addresses the source object directly rather than being
    //    resolved against the client's own endpoint routing. 2.5.x hit exactly this omission as
    //    upstream #3745 ("S3 copyObject usage - Missing bucket name").
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
