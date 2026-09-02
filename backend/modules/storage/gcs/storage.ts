import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage'
import { blobStorageModule } from '../blobBase.ts'

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
 * asset side (`assetUploaded`/`assetDeleted`/`assetRenamed`) plus `exportAll`, all of which
 * `blobStorageModule` provides from the driver below.
 */

/**
 * `definition.yml`'s own default for `apiEndpoint`. The client is only ever told an explicit
 * `apiEndpoint` when the configured value differs from this — an admin who left the field untouched
 * gets the SDK's own default behavior rather than this string round-tripped back at it.
 */
const DEFAULT_API_ENDPOINT = 'storage.google.com'

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

const gcsStorage = blobStorageModule<Bucket>({
  label: 'GCS',
  async build(config) {
    const bucket = buildClient(config).bucket(config.bucket)
    await ensureBucket(bucket)
    return bucket
  },
  async put(bucket, key, body, mimeType, config) {
    await bucket.file(key).save(body, {
      contentType: mimeType,
      // -> Buffers under a few MB (the vast majority of assets) don't benefit from a resumable
      //    upload's extra initial request; a resumable session is still used automatically for large
      //    buffers by the SDK's own thresholding regardless of this flag.
      resumable: false,
      metadata: { storageClass: config.storageTier }
    })
  },
  async remove(bucket, key) {
    await bucket.file(key).delete()
  },
  async copy(bucket, sourceKey, destinationKey) {
    await bucket.file(sourceKey).copy(bucket.file(destinationKey))
  },
  /**
   * A read-only signed URL, signed locally by the service-account credentials (`getSignedUrl` performs
   * no network call) — the same shape as `s3`'s presigned GET and `azure`'s read-only SAS URL.
   */
  async sign(bucket, key, ttlSeconds) {
    const [url] = await bucket.file(key).getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlSeconds * 1000
    })
    return url
  }
})

export default gcsStorage
