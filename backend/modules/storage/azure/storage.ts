import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  type ContainerClient
} from '@azure/storage-blob'
import type { Readable } from 'node:stream'
import { blobStorageModule } from '../blobBase.ts'

/**
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so there is no
 * page lifecycle here — only the asset side `blobStorageModule` builds from the driver below.
 */

/** No network I/O: constructing the client does not contact the account. */
export function buildServiceClient(config: Record<string, any>): BlobServiceClient {
  const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey)
  return new BlobServiceClient(`https://${config.accountName}.blob.core.windows.net`, credential)
}

export function isContainerAlreadyExists(err: any): boolean {
  return err?.statusCode === 409
}

export function isBlobNotFound(err: any): boolean {
  if (err?.code === 'ContainerNotFound' || err?.details?.errorCode === 'ContainerNotFound') {
    return false
  }
  return err?.statusCode === 404
}

/**
 * A 409 (`ContainerAlreadyExists`) is success: the container being there already is exactly what
 * activation is trying to ensure. Anything else is rethrown as a plain `Error` carrying the SDK's
 * own message, which is what reaches the admin UI through `executeAction`'s
 * `reply.badRequest(err.message)` rather than a raw SDK exception.
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
 * Only sets the tier a blob is *uploaded* at. Changing `storageTier` later leaves existing blobs on
 * whatever tier they were written with, short of a per-blob `setAccessTier` or a re-run of
 * `exportAll` — expected behavior, not a bug to work around here.
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
    // -> A server-side copy: no bytes round-trip through this process. The source blob (snapshots
    //    included) is deleted by `blobBase.ts` once the copy has landed.
    await container
      .getBlockBlobClient(destinationKey)
      .syncCopyFromURL(container.getBlockBlobClient(sourceKey).url)
  },
  /** Signed locally against the client's own credential: `generateSasUrl` makes no network call. */
  sign(container, key, ttlSeconds) {
    return container.getBlockBlobClient(key).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + ttlSeconds * 1000)
    })
  },
  async get(container, key) {
    try {
      const res = await container.getBlockBlobClient(key).download()
      if (!res.readableStreamBody) {
        throw new Error('the response carried no body')
      }
      return {
        body: res.readableStreamBody as Readable,
        size: res.contentLength ?? 0
      }
    } catch (err: any) {
      if (isBlobNotFound(err)) {
        return null
      }
      throw err
    }
  },
  async head(container, key) {
    try {
      const res = await container.getBlockBlobClient(key).getProperties()
      return { size: res.contentLength ?? 0 }
    } catch (err: any) {
      if (isBlobNotFound(err)) {
        return null
      }
      throw err
    }
  }
})

export default azureStorage
