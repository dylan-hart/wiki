import type { Readable } from 'node:stream'
import { belongsInTarget, objectKeyFor } from '../../helpers/blobTarget.ts'
import type { StorageModule, StorageTarget } from '../../models/storage.ts'

/**
 * What every cloud blob storage target has in common — `s3`, `azure` and `gcs` differ only in which
 * SDK writes the bytes. A factory rather than a base class, since a storage module is a plain
 * object; each module keeps its own SDK imports, client construction and the driver callbacks below.
 *
 * Deliberately free of any cloud SDK import of its own, so a module pulling this in never drags in
 * another module's SDK.
 */

/**
 * Minutes, not hours: a direct-access URL is generated per request for one browser to fetch
 * immediately, not something meant to be bookmarked or cached client-side.
 */
export const DIRECT_ACCESS_TTL_SECONDS = 5 * 60

/**
 * Long enough that a broken credential is not re-probed — paying the SDK's own connect/retry latency
 * — on every image request an instance serves in that window; short enough that an admin who just
 * fixed the target's config sees it recover within one session rather than needing a restart.
 */
const ACTIVATION_FAILURE_TTL_MS = 30_000

export function keyFor(target: StorageTarget, folderPath: string, fileName: string): string {
  return objectKeyFor({ siteId: target.siteId, folderPath, fileName })
}

/**
 * The SDK-specific half of a blob target, parameterised on that SDK's own client type — everything
 * `blobStorageModule` cannot do without knowing which cloud it is talking to.
 */
export interface BlobDriver<C> {
  /** The target's name as the `exportAll` log line reads it. */
  label: string
  /**
   * Build the client and verify (where reasonable, create) its bucket/container — run once per
   * config by the activation cache below. Throw a plain `Error` with a readable message: that is
   * what reaches the admin UI through `executeAction`'s `reply.badRequest(err.message)`.
   */
  build(config: Record<string, any>): C | Promise<C>
  put(
    client: C,
    key: string,
    body: Buffer,
    mimeType: string,
    config: Record<string, any>
  ): Promise<void>
  remove(client: C, key: string): Promise<void>
  /** A server-side copy — no bytes round-trip here; the source is removed separately. */
  copy(
    client: C,
    sourceKey: string,
    destinationKey: string,
    config: Record<string, any>
  ): Promise<void>
  /** A read-only URL for `key`, signed locally wherever the SDK allows it. */
  sign(client: C, key: string, ttlSeconds: number): Promise<string>
  get(client: C, key: string): Promise<{ body: Readable; size: number } | null>
  head(client: C, key: string): Promise<{ size: number } | null>
}

export function blobStorageModule<C>(driver: BlobDriver<C>): StorageModule {
  /**
   * One activated client per target, invalidated the moment the target's stored config changes (a
   * credential rotation, a bucket rename). `models/storage.ts` has no enable-time lifecycle hook to
   * build it from, so every handler below routes through `getClient()` instead: the first call any
   * target makes both builds the client and verifies its destination.
   */
  const activated = new Map<string, { configKey: string; ready: Promise<C>; failedAt?: number }>()

  /**
   * A failed activation is cached too, for `ACTIVATION_FAILURE_TTL_MS`: within that window this
   * replays the same rejection rather than re-probing the SDK, and once it elapses the next call
   * verifies again. A successful activation always replaces whatever was cached, failed or not, so
   * there is no separate "clear the failure" path to call.
   */
  async function getClient(target: StorageTarget): Promise<C> {
    const configKey = JSON.stringify(target.config)
    const cached = activated.get(target.id)
    if (cached && cached.configKey === configKey) {
      if (
        cached.failedAt === undefined ||
        Date.now() - cached.failedAt < ACTIVATION_FAILURE_TTL_MS
      ) {
        return cached.ready
      }
    }

    const entry: { configKey: string; ready: Promise<C>; failedAt?: number } = {
      configKey,
      ready: Promise.resolve(driver.build(target.config))
    }
    entry.ready = entry.ready.catch((err) => {
      entry.failedAt = Date.now()
      throw err
    })
    activated.set(target.id, entry)
    return entry.ready
  }

  async function withErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: any) {
      throw new Error(`Failed to ${action}: ${err.message ?? err}`)
    }
  }

  async function assetUploaded(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const content = await CARDINAL.models.assets.getContent(data.id)
    if (!content) {
      // -> Deleted again between the write that triggered this and this handler running
      return
    }
    const key = keyFor(target, data.folderPath, data.fileName)
    await withErrors(`upload "${key}"`, () =>
      driver.put(client, key, content.data, content.mimeType, target.config)
    )
  }

  async function assetDeleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const key = keyFor(target, data.folderPath, data.fileName)
    await withErrors(`delete "${key}"`, () => driver.remove(client, key))
  }

  async function assetRenamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const sourceKey = keyFor(target, data.folderPath, data.previousFileName)
    const destinationKey = keyFor(target, data.folderPath, data.fileName)

    await withErrors(`rename "${sourceKey}" to "${destinationKey}"`, async () => {
      await driver.copy(client, sourceKey, destinationKey, target.config)
      await driver.remove(client, sourceKey)
    })
  }

  async function assetMoved(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const sourceKey = keyFor(target, data.previousFolderPath, data.fileName)
    const destinationKey = keyFor(target, data.folderPath, data.fileName)

    await withErrors(`move "${sourceKey}" to "${destinationKey}"`, async () => {
      await driver.copy(client, sourceKey, destinationKey, target.config)
      await driver.remove(client, sourceKey)
    })
  }

  /**
   * Filtered through the target's own `contentTypes`: nothing upstream of this filters assets by
   * content type, so it is the one place that can happen. Also where a target that has never had a
   * write dispatched to it gets its first activation, destination verification included.
   */
  async function exportAll(target: StorageTarget): Promise<void> {
    const client = await getClient(target)

    let exported = 0
    for await (const asset of CARDINAL.models.assets.streamAll(target.siteId)) {
      if (!belongsInTarget(asset, target.contentTypes)) {
        continue
      }
      const key = keyFor(target, asset.folderPath, asset.fileName)
      await withErrors(`export "${key}"`, () =>
        driver.put(client, key, asset.data, asset.mimeType, target.config)
      )
      exported++
    }
    CARDINAL.logger.info('storage', 'exported every asset', {
      module: target.module,
      target: target.id,
      assets: exported,
      driver: driver.label
    })
  }

  /**
   * What `assetDelivery.directAccess` needs to redirect a browser straight to the bucket instead of
   * streaming the file through the wiki server. Asset first, target second, matching every other
   * `StorageModule` handler's argument order.
   */
  async function getDirectUrl(
    asset: { folderPath: string; fileName: string },
    target: StorageTarget
  ): Promise<string> {
    const client = await getClient(target)
    const key = keyFor(target, asset.folderPath, asset.fileName)
    return withErrors(`generate a direct-access URL for "${key}"`, () =>
      driver.sign(client, key, DIRECT_ACCESS_TTL_SECONDS)
    )
  }

  async function readAsset(
    asset: { folderPath: string; fileName: string },
    target: StorageTarget
  ): Promise<{ body: Readable; size: number } | null> {
    const client = await getClient(target)
    const key = keyFor(target, asset.folderPath, asset.fileName)
    return withErrors(`read "${key}"`, () => driver.get(client, key))
  }

  async function headAsset(
    asset: { folderPath: string; fileName: string },
    target: StorageTarget
  ): Promise<{ size: number } | null> {
    const client = await getClient(target)
    const key = keyFor(target, asset.folderPath, asset.fileName)
    return withErrors(`inspect "${key}"`, () => driver.head(client, key))
  }

  return {
    assetUploaded,
    assetDeleted,
    assetRenamed,
    assetMoved,
    exportAll,
    getDirectUrl,
    readAsset,
    headAsset
  }
}
