import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage'
import { belongsInTarget, objectKeyFor } from '../../../helpers/blobTarget.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * Google Cloud Storage. Unlike `s3` and `azure`, 2.5.x has no GCS module to port from — GCS is not
 * among 2.5.x's eleven storage directories — so this module is shaped after those two instead: a
 * `Storage` client authenticated from a pasted service-account JSON blob (`credentialsJSON`), and a
 * single `Bucket` for the configured `bucket` name, verified (not auto-created — see `ensureBucket`)
 * on first use.
 *
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so — as with `s3`
 * and `azure` — there is no page `created`/`updated`/`renamed`/`deleted` lifecycle to port, just the
 * asset side (`assetUploaded`/`assetDeleted`/`assetRenamed`) plus `exportAll`.
 */

/**
 * How long a direct-access URL stays valid. Minutes, not hours: it's generated per request for one
 * browser to fetch immediately, not something meant to be bookmarked or cached client-side. Matches
 * the `s3` and `azure` modules' TTL so the three targets behave the same from the admin's point of
 * view.
 */
const DIRECT_ACCESS_TTL_SECONDS = 5 * 60

/**
 * `definition.yml`'s own default for `apiEndpoint`. The client is only ever told an explicit
 * `apiEndpoint` when the configured value differs from this — an admin who left the field untouched
 * gets the SDK's own default behavior rather than this string round-tripped back at it.
 */
const DEFAULT_API_ENDPOINT = 'storage.google.com'

/**
 * One verified `Bucket` per target, keyed by target id and invalidated the moment the target's stored
 * config changes (a credential rotation, a bucket rename). This is what "activation" means here: the
 * bucket is verified once per config. Every write path below routes through `getClient()`, so the
 * first GCS call any target makes (an admin's "Export All" click, or a future dispatched write) both
 * builds the client and verifies the bucket.
 */
const activated = new Map<string, { bucket: Bucket; configKey: string; ready: Promise<void> }>()

/**
 * Build the GCS client for a target's config — no network I/O happens here. `credentialsJSON` is the
 * pasted contents of a service-account key file (`definition.yml`: `multiline: true, sensitive: true`);
 * `accountName` is the project ID, and `apiEndpoint` is only passed through when it differs from
 * `definition.yml`'s own default.
 */
export function buildClient(config: Record<string, any>): Storage {
  const options: StorageOptions = {
    projectId: config.accountName,
    credentials: JSON.parse(config.credentialsJSON)
  }
  const apiEndpoint = String(config.apiEndpoint ?? '').trim()
  if (apiEndpoint && apiEndpoint !== DEFAULT_API_ENDPOINT) {
    options.apiEndpoint = apiEndpoint
  }
  return new Storage(options)
}

/**
 * Verify the configured bucket exists and this target can reach it. Unlike `s3`/`azure`, a missing
 * bucket is not created here — `definition.yml` phrases the prop as "the unique bucket name" rather
 * than "...to create", and GCS bucket creation additionally needs a location/storage-class decision
 * this target's config doesn't collect — so a missing or unreachable bucket is a hard failure.
 *
 * Every failure — the existence check itself, or the bucket genuinely not being there — is rethrown as
 * a plain `Error` with a message built from the SDK's own, so it reaches the admin UI through
 * `executeAction`'s existing `catch (err) { reply.badRequest(err.message) }` rather than surfacing as
 * an unhandled SDK exception.
 */
export async function ensureBucket(bucket: Bucket): Promise<void> {
  let exists: boolean
  try {
    ;[exists] = await bucket.exists()
  } catch (err: any) {
    throw new Error(`Could not reach the "${bucket.name}" bucket: ${err.message ?? err}`)
  }
  if (!exists) {
    throw new Error(
      `The "${bucket.name}" bucket does not exist or is not reachable with the given credentials.`
    )
  }
}

/** The activated bucket for a target, (re-)verifying it whenever the stored config changed. */
async function getClient(target: StorageTarget): Promise<Bucket> {
  const configKey = JSON.stringify(target.config)
  const cached = activated.get(target.id)
  if (cached && cached.configKey === configKey) {
    await cached.ready
    return cached.bucket
  }

  const storage = buildClient(target.config)
  const bucket = storage.bucket(target.config.bucket)
  const ready = ensureBucket(bucket).catch((err) => {
    // -> A failed activation is not remembered as done: the next call — the admin retrying the action
    //    after fixing credentials, say — has to verify again rather than replay this same rejection
    activated.delete(target.id)
    throw err
  })
  activated.set(target.id, { bucket, configKey, ready })
  await ready
  return bucket
}

/** Where one asset of a target lives in the bucket. */
export function keyFor(target: StorageTarget, folderPath: string, fileName: string): string {
  return objectKeyFor({ siteId: target.siteId, folderPath, fileName })
}

/** Wrap a GCS SDK call so a failure reaches the caller as a readable `Error`, not a raw SDK exception. */
async function withGcsErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    throw new Error(`Failed to ${action}: ${err.message ?? err}`)
  }
}

/** An asset was created, or an existing one had its bytes replaced. */
async function assetUploaded(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const bucket = await getClient(target)
  const content = await WIKI.models.assets.getContent(data.id)
  if (!content) {
    // -> Deleted again between the write that triggered this and this handler actually running;
    //    nothing left to push
    return
  }
  const key = keyFor(target, data.folderPath ?? '', data.fileName ?? content.fileName)
  await withGcsErrors(`upload "${key}"`, () =>
    bucket.file(key).save(content.data, {
      contentType: content.mimeType,
      // -> Buffers under a few MB (the vast majority of assets) don't benefit from a resumable
      //    upload's extra initial request; a resumable session is still used automatically for large
      //    buffers by the SDK's own thresholding regardless of this flag.
      resumable: false,
      metadata: { storageClass: target.config.storageTier }
    })
  )
}

/** An asset was deleted. */
async function assetDeleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const bucket = await getClient(target)
  const key = keyFor(target, data.folderPath ?? '', data.fileName)
  await withGcsErrors(`delete "${key}"`, () => bucket.file(key).delete())
}

/** An asset moved to a new name within the same folder. */
async function assetRenamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const bucket = await getClient(target)
  const sourceKey = keyFor(target, data.folderPath ?? '', data.previousFileName ?? data.fileName)
  const destinationKey = keyFor(target, data.folderPath ?? '', data.fileName)

  await withGcsErrors(`rename "${sourceKey}" to "${destinationKey}"`, async () => {
    await bucket.file(sourceKey).copy(bucket.file(destinationKey))
    await bucket.file(sourceKey).delete()
  })
}

/**
 * Push every asset of this target's site to GCS, filtered through the target's own `contentTypes`
 * (`activeTypes` / `largeThreshold`) exactly as configured in the admin area — nothing upstream of
 * this filters assets by content type, so `exportAll` is the one place it has to happen. This is also
 * where a target gets its first real activation for a target that has never had a write dispatched to
 * it yet: `getClient()` verifies the bucket before anything is sent.
 */
async function exportAll(target: StorageTarget): Promise<void> {
  const bucket = await getClient(target)
  const storageClass = target.config.storageTier

  let exported = 0
  for await (const asset of WIKI.models.assets.streamAll(target.siteId)) {
    if (!belongsInTarget(asset, target.contentTypes)) {
      continue
    }
    const key = keyFor(target, asset.folderPath, asset.fileName)
    await withGcsErrors(`export "${key}"`, () =>
      bucket.file(key).save(asset.data, {
        contentType: asset.mimeType,
        resumable: false,
        metadata: { storageClass }
      })
    )
    exported++
  }
  WIKI.logger.info(`(STORAGE/${target.title}) Exported ${exported} asset(s) to GCS.`)
}

/**
 * A short-lived, read-only signed URL for one object — the primitive `assetDelivery.directAccess`
 * needs to redirect a browser straight to the bucket instead of streaming the file through the wiki
 * server. Signed locally by the service-account credentials (`getSignedUrl` performs no network call),
 * scoped to `action: 'read'` on a short expiry — the same shape as `s3`'s presigned GET and `azure`'s
 * read-only SAS URL.
 *
 * Called by `models/assets.ts`'s `directUrlFor()`, per `StorageModule.getDirectUrl` — asset first,
 * target second, matching every other `StorageModule` handler's argument order.
 */
async function getDirectUrl(
  asset: { folderPath: string; fileName: string },
  target: StorageTarget
): Promise<string> {
  const bucket = await getClient(target)
  const key = keyFor(target, asset.folderPath, asset.fileName)
  return withGcsErrors(`generate a direct-access URL for "${key}"`, async () => {
    const [url] = await bucket.file(key).getSignedUrl({
      action: 'read',
      expires: Date.now() + DIRECT_ACCESS_TTL_SECONDS * 1000
    })
    return url
  })
}

const gcsStorage: StorageModule = {
  assetUploaded,
  assetDeleted,
  assetRenamed,
  exportAll,
  getDirectUrl
}

export default gcsStorage
