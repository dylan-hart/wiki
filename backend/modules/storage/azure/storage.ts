import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  type ContainerClient
} from '@azure/storage-blob'
import { belongsInTarget, objectKeyFor } from '../../../helpers/blobTarget.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * Azure Blob Storage. Built the same way 2.5.x's `azure/storage.js` did — a `BlobServiceClient`
 * authenticated with a `StorageSharedKeyCredential` built from `accountName`/`accountKey`, and a
 * single `ContainerClient` for the configured `containerName`, created on first use if it doesn't
 * exist yet (swallowing the 409 "already exists" response, exactly as that file did).
 *
 * Only assets are handled: this target's `definition.yml` excludes `pages` from
 * `contentTypes.defaultTypesEnabled` and declares `versioning.isSupported: false`, so — as with the
 * `s3` module — there is no page `created`/`updated`/`renamed`/`deleted` lifecycle to port, just the
 * asset side (`assetUploaded`/`assetDeleted`/`assetRenamed`) plus `exportAll`.
 */

/**
 * How long a direct-access URL stays valid. Minutes, not hours: it's generated per request for one
 * browser to fetch immediately, not something meant to be bookmarked or cached client-side. Matches
 * the `s3` module's TTL so the two targets behave the same from the admin's point of view.
 */
const DIRECT_ACCESS_TTL_SECONDS = 5 * 60

/**
 * One verified `ContainerClient` per target, keyed by target id and invalidated the moment the
 * target's stored config changes (a key rotation, a container rename). This is what "activation"
 * means here: the container is verified/created once per config, matching 2.5.x's `init()` — which
 * ran once when the module was enabled — without a corresponding lifecycle hook existing yet on this
 * branch's `models/storage.ts` to call it from. Every write path below routes through `getClient()`,
 * so the first Azure call any target makes both builds the client and verifies the container.
 */
const activated = new Map<
  string,
  { container: ContainerClient; configKey: string; ready: Promise<void> }
>()

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

/** The activated container for a target, (re-)verifying it whenever the stored config changed. */
async function getClient(target: StorageTarget): Promise<ContainerClient> {
  const configKey = JSON.stringify(target.config)
  const cached = activated.get(target.id)
  if (cached && cached.configKey === configKey) {
    await cached.ready
    return cached.container
  }

  const serviceClient = buildServiceClient(target.config)
  const container = serviceClient.getContainerClient(target.config.containerName)
  const ready = ensureContainer(container).catch((err) => {
    // -> A failed activation is not remembered as done: the next call — the admin retrying the action
    //    after fixing credentials, say — has to verify again rather than replay this same rejection
    activated.delete(target.id)
    throw err
  })
  activated.set(target.id, { container, configKey, ready })
  await ready
  return container
}

/** Where one asset of a target lives in the container. */
export function keyFor(target: StorageTarget, folderPath: string, fileName: string): string {
  return objectKeyFor({ siteId: target.siteId, folderPath, fileName })
}

/** Wrap an Azure SDK call so a failure reaches the caller as a readable `Error`, not a raw SDK exception. */
async function withAzureErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err: any) {
    throw new Error(`Failed to ${action}: ${err.message ?? err}`)
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
function tierFor(target: StorageTarget): string | undefined {
  return target.config.storageTier
}

/** An asset was created, or an existing one had its bytes replaced. */
async function assetUploaded(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const container = await getClient(target)
  const content = await WIKI.models.assets.getContent(data.id)
  if (!content) {
    // -> Deleted again between the write that triggered this and this handler actually running;
    //    nothing left to push
    return
  }
  const key = keyFor(target, data.folderPath ?? '', data.fileName ?? content.fileName)
  const blockBlobClient = container.getBlockBlobClient(key)
  await withAzureErrors(`upload "${key}"`, () =>
    blockBlobClient.upload(content.data, content.data.length, {
      tier: tierFor(target),
      blobHTTPHeaders: { blobContentType: content.mimeType }
    })
  )
}

/** An asset was deleted. */
async function assetDeleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const container = await getClient(target)
  const key = keyFor(target, data.folderPath ?? '', data.fileName)
  const blockBlobClient = container.getBlockBlobClient(key)
  await withAzureErrors(`delete "${key}"`, () =>
    blockBlobClient.delete({ deleteSnapshots: 'include' })
  )
}

/** An asset moved to a new name within the same folder. */
async function assetRenamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
  const container = await getClient(target)
  const sourceKey = keyFor(target, data.folderPath ?? '', data.previousFileName ?? data.fileName)
  const destinationKey = keyFor(target, data.folderPath ?? '', data.fileName)
  const sourceBlockBlobClient = container.getBlockBlobClient(sourceKey)
  const destBlockBlobClient = container.getBlockBlobClient(destinationKey)

  await withAzureErrors(`rename "${sourceKey}" to "${destinationKey}"`, async () => {
    // -> Same shape as 2.5.x: a server-side copy (no bytes round-trip through this process) followed
    //    by deleting the source, including its snapshots, once the copy has landed.
    await destBlockBlobClient.syncCopyFromURL(sourceBlockBlobClient.url)
    await sourceBlockBlobClient.delete({ deleteSnapshots: 'include' })
  })
}

/**
 * Push every asset of this target's site to Azure Blob Storage, filtered through the target's own
 * `contentTypes` (`activeTypes` / `largeThreshold`) exactly as configured in the admin area — nothing
 * upstream of this filters assets by content type, so `exportAll` is the one place it has to happen.
 * This is also a target's first real activation if it has never had a write dispatched to it yet:
 * `getClient()` verifies (and where reasonable, creates) the container before anything is sent.
 */
async function exportAll(target: StorageTarget): Promise<void> {
  const container = await getClient(target)
  const tier = tierFor(target)

  let exported = 0
  for await (const asset of WIKI.models.assets.streamAll(target.siteId)) {
    if (!belongsInTarget(asset, target.contentTypes)) {
      continue
    }
    const key = keyFor(target, asset.folderPath, asset.fileName)
    const blockBlobClient = container.getBlockBlobClient(key)
    await withAzureErrors(`export "${key}"`, () =>
      blockBlobClient.upload(asset.data, asset.data.length, {
        tier,
        blobHTTPHeaders: { blobContentType: asset.mimeType }
      })
    )
    exported++
  }
  WIKI.logger.info(`(STORAGE/${target.title}) Exported ${exported} asset(s) to Azure Blob Storage.`)
}

/**
 * A short-lived, read-only Shared Access Signature URL for one blob — the primitive
 * `assetDelivery.directAccess` needs to redirect a browser straight to Azure instead of streaming the
 * file through the wiki server. Signed locally by the client's own `StorageSharedKeyCredential`
 * (`generateSasUrl` performs no network call), scoped to read-only (`BlobSASPermissions.parse('r')`)
 * on a short expiry — the same shape as `s3`'s presigned GET, `getSignedUrl`.
 *
 * This module only supplies the URL-generation half of that: `s3`/`azure`/`gcs` are the only targets
 * that declare `assetDelivery.isDirectAccessSupported: true`, and nothing calls this yet — the
 * `/content` serving path that would (Feature 368) and the write-path dispatch hook that would keep a
 * target's container in sync in the first place (Feature 370) both land separately.
 */
async function getDirectAccessUrl(
  target: StorageTarget,
  asset: { folderPath: string; fileName: string }
): Promise<string> {
  const container = await getClient(target)
  const key = keyFor(target, asset.folderPath, asset.fileName)
  const blockBlobClient = container.getBlockBlobClient(key)
  return withAzureErrors(`generate a direct-access URL for "${key}"`, () =>
    blockBlobClient.generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + DIRECT_ACCESS_TTL_SECONDS * 1000)
    })
  )
}

const azureStorage: StorageModule = {
  assetUploaded,
  assetDeleted,
  assetRenamed,
  exportAll,
  getDirectAccessUrl
}

export default azureStorage
