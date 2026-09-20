import { Storage, type Bucket, type StorageOptions } from '@google-cloud/storage'
import { blobStorageModule } from '../blobBase.ts'

/**
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so there is no
 * page lifecycle here — just the asset side, all of which `blobStorageModule` provides from the
 * driver below.
 */

/**
 * `definition.yml`'s own default for `apiEndpoint`. Round-tripping it back at the client would
 * override the SDK's own default behavior, so an explicit `apiEndpoint` is only ever passed when the
 * configured value differs from this.
 */
const DEFAULT_API_ENDPOINT = 'storage.google.com'

/**
 * No network I/O happens here. `credentialsJSON` is the pasted contents of a service-account key
 * file; `accountName` is the project ID.
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
 * Unlike `s3`/`azure`, a missing bucket is a hard failure rather than one this creates: GCS bucket
 * creation needs a location and storage class this target's config does not collect.
 *
 * Every failure is rethrown as a plain `Error` with a message built from the SDK's own, so it reaches
 * the admin UI through `executeAction`'s `catch (err) { reply.badRequest(err.message) }` rather than
 * surfacing as an unhandled SDK exception.
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
      // -> Buffers under a few MB don't benefit from a resumable upload's extra initial request; the
      //    SDK's own thresholding still uses a resumable session for large buffers regardless.
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
  /** Signed locally by the service-account credentials — `getSignedUrl` performs no network call. */
  async sign(bucket, key, ttlSeconds) {
    const [url] = await bucket.file(key).getSignedUrl({
      action: 'read',
      expires: Date.now() + ttlSeconds * 1000
    })
    return url
  }
})

export default gcsStorage
