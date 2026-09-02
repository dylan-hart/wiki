import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  type ContainerClient
} from '@azure/storage-blob'
import { blobStorageModule } from '../blobBase.ts'

/**
 * Azure Blob Storage. Built the same way 2.5.x's `azure/storage.js` did — a `BlobServiceClient`
 * authenticated with a `StorageSharedKeyCredential` built from `accountName`/`accountKey`, and a
 * single `ContainerClient` for the configured `containerName`, created on first use if it doesn't
 * exist yet (swallowing the 409 "already exists" response, exactly as that file did).
 *
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so — as with the
 * `s3` module — there is no page `created`/`updated`/`renamed`/`deleted` lifecycle to port, just the
 * asset side (`assetUploaded`/`assetDeleted`/`assetRenamed`) plus `exportAll`, all of which
 * `blobStorageModule` provides from the driver below.
 */

/** Build the `BlobServiceClient` for a target's config — no network I/O happens here. */
export function buildServiceClient(config: Record<string, any>): BlobServiceClient {
  const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey)
  return new BlobServiceClient(`https://${config.accountName}.blob.core.windows.net`, credential)
}

/** Whether a container-create failure means "it's already there" rather than something else. */
export function isContainerAlreadyExists(err: any): boolean {
  return err?.statusCode === 409
}

/**
 * Create the container if it doesn't exist yet, matching 2.5.x's `init()`: call `create()`, and treat
 * a 409 (`ContainerAlreadyExists`) as success rather than an error — the container being there already
 * is exactly what activation is trying to ensure. Any other failure (bad credentials, no network,
 * account name typo'd) is rethrown as a plain `Error` built from the SDK's own message, so it reaches
 * the admin UI through `executeAction`'s existing `catch (err) { reply.badRequest(err.message) }`
 * rather than surfacing as a raw SDK exception.
 */
export async function ensureContainer(container: ContainerClient): Promise<void> {
  try {
    await container.create()
  } catch (err: any) {
    if (!isContainerAlreadyExists(err)) {
      throw new Error(
        `Could not create the "${container.containerName}" container: ${err.message ?? err}`
      )
    }
  }
}

/**
 * The access tier to upload with, straight from config — `hot` or `cool` per `definition.yml`'s enum,
 * passed through unchanged exactly as 2.5.x's `{ tier: this.config.storageTier }` did.
 *
 * NOTE: this only sets the tier a blob is *uploaded* at. Azure has no bulk retroactive re-tiering
 * built into a simple upload call — changing `storageTier` in this target's config later only affects
 * blobs written after the change; existing blobs stay on whatever tier they were uploaded with unless
 * someone calls `setAccessTier` on them individually (or re-runs `exportAll`, which re-uploads
 * everything at the now-current tier). That's expected behavior, not a bug to work around here.
 */
function tierFor(config: Record<string, any>): string | undefined {
  return config.storageTier
}

const azureStorage = blobStorageModule<ContainerClient>({
  label: 'Azure Blob Storage',
  async build(config) {
    const container = buildServiceClient(config).getContainerClient(config.containerName)
    await ensureContainer(container)
    return container
  },
  async put(container, key, body, mimeType, config) {
    await container.getBlockBlobClient(key).upload(body, body.length, {
      tier: tierFor(config),
      blobHTTPHeaders: { blobContentType: mimeType }
    })
  },
  async remove(container, key) {
    await container.getBlockBlobClient(key).delete({ deleteSnapshots: 'include' })
  },
  async copy(container, sourceKey, destinationKey) {
    // -> Same shape as 2.5.x: a server-side copy, no bytes round-tripping through this process. The
    //    source blob (snapshots included) is deleted by `blobBase.ts` once the copy has landed.
    await container
      .getBlockBlobClient(destinationKey)
      .syncCopyFromURL(container.getBlockBlobClient(sourceKey).url)
  },
  /**
   * A read-only Shared Access Signature URL, signed locally by the client's own
   * `StorageSharedKeyCredential` (`generateSasUrl` performs no network call) and scoped to read-only
   * (`BlobSASPermissions.parse('r')`) — the same shape as `s3`'s presigned GET.
   */
  sign(container, key, ttlSeconds) {
    return container.getBlockBlobClient(key).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + ttlSeconds * 1000)
    })
  }
})

export default azureStorage
