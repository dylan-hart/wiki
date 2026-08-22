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
import { belongsInTarget, objectKeyFor } from '../../../helpers/blobTarget.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

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
 * contract `models/storage.ts` documents) plus `exportAll`.
 */

/**
 * How long a direct-access URL stays valid. Minutes, not hours: it's generated per request for one
 * browser to fetch immediately, not something meant to be bookmarked or cached client-side.
 */
const DIRECT_ACCESS_TTL_SECONDS = 5 * 60

/**
 * One verified S3 client per target, keyed by target id and invalidated the moment the target's
 * stored config changes (a credential rotation, a bucket rename). This is what "activation" means
 * here: the client is built and its bucket verified/created once per config, matching 2.5.x's `init()`
 * — which ran once when the module was enabled — without a corresponding lifecycle hook existing yet
 * on this branch's `models/storage.ts` to call it from. Every write path below routes through
 * `getClient()`, so the first S3 call any target makes (an admin's "Export All" click, or a future
 * dispatched write) both builds the client and verifies the bucket.
 */
const activated = new Map<string, { client: S3Client; configKey: string; ready: Promise<void> }>()

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

/** The activated client for a target, (re-)verifying its bucket whenever the stored config changed. */
async function getClient(target: StorageTarget): Promise<S3Client> {
  const configKey = JSON.stringify(target.config)
  const cached = activated.get(target.id)
  if (cached && cached.configKey === configKey) {
    await cached.ready
    return cached.client
  }

  const client = buildClient(target.config)
  const ready = ensureBucket(client, target.config).catch((err) => {
    // -> A failed activation is not remembered as done: the next call — the admin retrying the action
    //    after fixing credentials, say — has to verify again rather than replay this same rejection
    activated.delete(target.id)
    throw err
  })
  activated.set(target.id, { client, configKey, ready })
  await ready
  return client
}

/** Where one asset of a target lives in the bucket. */
export function keyFor(target: StorageTarget, folderPath: string, fileName: string): string {
  return objectKeyFor({ siteId: target.siteId, folderPath, fileName })
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

/** Wrap an S3 SDK call so a failure reaches the caller as a readable `Error`, not a raw SDK exception. */
async function withS3Errors<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    throw new Error(`Failed to ${action}: ${err.message ?? err}`)
  }
}

/** An asset was created, or an existing one had its bytes replaced. */
async function assetUploaded(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const client = await getClient(target)
  const content = await WIKI.models.assets.getContent(data.id)
  if (!content) {
    // -> Deleted again between the write that triggered this and this handler actually running;
    //    nothing left to push
    return
  }
  const key = keyFor(target, data.folderPath ?? '', data.fileName ?? content.fileName)
  await withS3Errors(`upload "${key}"`, () =>
    client.send(
      new PutObjectCommand({
        Bucket: target.config.bucket,
        Key: key,
        Body: content.data,
        ContentType: content.mimeType,
        StorageClass: storageClassFor(target.config)
      })
    )
  )
}

/** An asset was deleted. */
async function assetDeleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const client = await getClient(target)
  const key = keyFor(target, data.folderPath ?? '', data.fileName)
  await withS3Errors(`delete "${key}"`, () =>
    client.send(new DeleteObjectCommand({ Bucket: target.config.bucket, Key: key }))
  )
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

/** An asset moved to a new name within the same folder. */
async function assetRenamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const client = await getClient(target)
  const bucket = target.config.bucket
  const sourceKey = keyFor(target, data.folderPath ?? '', data.previousFileName ?? data.fileName)
  const destinationKey = keyFor(target, data.folderPath ?? '', data.fileName)

  await withS3Errors(`rename "${sourceKey}" to "${destinationKey}"`, async () => {
    // -> `CopySource` always needs the bucket prefixed and the key encoded, regardless of
    //    `s3BucketEndpoint`: the parameter addresses the source object directly rather than being
    //    resolved against the client's own endpoint routing. 2.5.x hit exactly this omission as
    //    upstream #3745 ("S3 copyObject usage - Missing bucket name").
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeCopySourceKey(sourceKey)}`,
        Key: destinationKey,
        StorageClass: storageClassFor(target.config)
      })
    )
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: sourceKey }))
  })
}

/**
 * Push every asset of this target's site to S3, filtered through the target's own `contentTypes`
 * (`activeTypes` / `largeThreshold`) exactly as configured in the admin area — nothing upstream of
 * this filters assets by content type, so `exportAll` is the one place it has to happen. This is also
 * where a target gets its first real activation for a target that has never had a write dispatched to
 * it yet: `getClient()` verifies (and where reasonable, creates) the bucket before anything is sent.
 */
async function exportAll(target: StorageTarget): Promise<void> {
  const client = await getClient(target)
  const bucket = target.config.bucket
  const storageClass = storageClassFor(target.config)

  let exported = 0
  for await (const asset of WIKI.models.assets.streamAll(target.siteId)) {
    if (!belongsInTarget(asset, target.contentTypes)) {
      continue
    }
    const key = keyFor(target, asset.folderPath, asset.fileName)
    await withS3Errors(`export "${key}"`, () =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: asset.data,
          ContentType: asset.mimeType,
          StorageClass: storageClass
        })
      )
    )
    exported++
  }
  WIKI.logger.info(`(STORAGE/${target.title}) Exported ${exported} asset(s) to S3.`)
}

/**
 * A short-lived, presigned GET URL for one asset — the primitive `assetDelivery.directAccess` needs
 * to redirect a browser straight to the bucket instead of streaming the file through the wiki server.
 * Called by `models/assets.ts`'s `directUrlFor()`, per `StorageModule.getDirectUrl` — asset first,
 * target second, matching every other `StorageModule` handler's argument order.
 */
async function getDirectUrl(
  asset: { folderPath: string; fileName: string },
  target: StorageTarget
): Promise<string> {
  const client = await getClient(target)
  const key = keyFor(target, asset.folderPath, asset.fileName)
  return withS3Errors(`presign "${key}"`, () =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: target.config.bucket, Key: key }), {
      expiresIn: DIRECT_ACCESS_TTL_SECONDS
    })
  )
}

const s3Storage: StorageModule = {
  assetUploaded,
  assetDeleted,
  assetRenamed,
  exportAll,
  getDirectUrl
}

export default s3Storage
