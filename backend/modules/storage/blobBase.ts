import { belongsInTarget, objectKeyFor } from '../../helpers/blobTarget.ts'
import type { StorageModule, StorageTarget } from '../../models/storage.ts'

/**
 * The shape every cloud blob storage target has in common — `s3`, `azure` and `gcs`.
 *
 * The three modules differ only in which SDK writes the bytes: the activation cache, the object key,
 * the error wrapping and all five handlers (`assetUploaded`/`assetDeleted`/`assetRenamed`/`exportAll`/
 * `getDirectUrl`) were byte-identical across them modulo the SDK noun. That shared half lives here, as
 * a factory rather than a base class since a storage module is a plain object; each module keeps its
 * own SDK imports, its client construction, its bucket/container verification and the five driver
 * callbacks below, and exports `blobStorageModule(driver)` as its default.
 *
 * Deliberately free of any cloud SDK import of its own — like `helpers/blobTarget.ts`, which it builds
 * on — so a module pulling this in never drags in another module's SDK.
 */

/**
 * How long a direct-access URL stays valid. Minutes, not hours: it's generated per request for one
 * browser to fetch immediately, not something meant to be bookmarked or cached client-side. Shared by
 * all three blob targets so they behave the same from the admin's point of view.
 */
export const DIRECT_ACCESS_TTL_SECONDS = 5 * 60

/** Where one asset of a target lives in the bucket/container. */
export function keyFor(target: StorageTarget, folderPath: string, fileName: string): string {
  return objectKeyFor({ siteId: target.siteId, folderPath, fileName })
}

/**
 * The SDK-specific half of a blob target — everything `blobStorageModule` cannot do without knowing
 * which cloud it is talking to.
 *
 * @typeParam C The client this driver hands back from `build` and receives on every other callback:
 *   an `S3Client`, a `ContainerClient`, a `Bucket`.
 */
export interface BlobDriver<C> {
  /** The target's name as the `exportAll` log line reads it, e.g. `S3`, `Azure Blob Storage`, `GCS`. */
  label: string
  /**
   * Build the client for a target's config and verify (where reasonable, create) its bucket/container
   * — 2.5.x's `init()`, run once per config by the activation cache below. Every failure should be
   * thrown as a plain `Error` with a readable message, so it reaches the admin UI through
   * `executeAction`'s existing `catch (err) { reply.badRequest(err.message) }`.
   */
  build(config: Record<string, any>): C | Promise<C>
  /** Write an asset's bytes at `key`, replacing whatever is there. */
  put(
    client: C,
    key: string,
    body: Buffer,
    mimeType: string,
    config: Record<string, any>
  ): Promise<void>
  /** Delete the object at `key`. */
  remove(client: C, key: string): Promise<void>
  /** Server-side copy `sourceKey` to `destinationKey` — the source is removed separately. */
  copy(
    client: C,
    sourceKey: string,
    destinationKey: string,
    config: Record<string, any>
  ): Promise<void>
  /** A short-lived, read-only URL for `key`, signed locally wherever the SDK allows it. */
  sign(client: C, key: string, ttlSeconds: number): Promise<string>
}

/**
 * The `StorageModule` for one blob driver: the five handlers `models/storage.ts` dispatches to, over a
 * per-target activation cache.
 */
export function blobStorageModule<C>(driver: BlobDriver<C>): StorageModule {
  /**
   * One activated client per target, keyed by target id and invalidated the moment the target's stored
   * config changes (a credential rotation, a bucket rename). This is what "activation" means here: the
   * client is built and its bucket/container verified once per config, matching 2.5.x's `init()` —
   * which ran once when the module was enabled — without a corresponding lifecycle hook existing yet
   * on this branch's `models/storage.ts` to call it from. Every handler below routes through
   * `getClient()`, so the first call any target makes (an admin's "Export All" click, or a dispatched
   * write) both builds the client and verifies its destination.
   */
  const activated = new Map<string, { configKey: string; ready: Promise<C> }>()

  /** The activated client for a target, (re-)verifying it whenever the stored config changed. */
  async function getClient(target: StorageTarget): Promise<C> {
    const configKey = JSON.stringify(target.config)
    const cached = activated.get(target.id)
    if (cached && cached.configKey === configKey) {
      return cached.ready
    }

    const ready = Promise.resolve(driver.build(target.config)).catch((err) => {
      // -> A failed activation is not remembered as done: the next call — the admin retrying the action
      //    after fixing credentials, say — has to verify again rather than replay this same rejection
      activated.delete(target.id)
      throw err
    })
    activated.set(target.id, { configKey, ready })
    return ready
  }

  /** Wrap an SDK call so a failure reaches the caller as a readable `Error`, not a raw SDK exception. */
  async function withErrors<T>(action: string, fn: () => Promise<T>): Promise<T> {
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
    const key = keyFor(target, data.folderPath, data.fileName)
    await withErrors(`upload "${key}"`, () =>
      driver.put(client, key, content.data, content.mimeType, target.config)
    )
  }

  /** An asset was deleted. */
  async function assetDeleted(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const key = keyFor(target, data.folderPath, data.fileName)
    await withErrors(`delete "${key}"`, () => driver.remove(client, key))
  }

  /** An asset moved to a new name within the same folder. */
  async function assetRenamed(target: StorageTarget, data: Record<string, any>): Promise<void> {
    const client = await getClient(target)
    const sourceKey = keyFor(target, data.folderPath, data.previousFileName)
    const destinationKey = keyFor(target, data.folderPath, data.fileName)

    await withErrors(`rename "${sourceKey}" to "${destinationKey}"`, async () => {
      // -> A server-side copy (no bytes round-trip through this process) followed by deleting the
      //    source once the copy has landed, the same shape 2.5.x used.
      await driver.copy(client, sourceKey, destinationKey, target.config)
      await driver.remove(client, sourceKey)
    })
  }

  /**
   * Push every asset of this target's site to the target, filtered through its own `contentTypes`
   * (`activeTypes` / `largeThreshold`) exactly as configured in the admin area — nothing upstream of
   * this filters assets by content type, so `exportAll` is the one place it has to happen. This is also
   * where a target gets its first real activation if it has never had a write dispatched to it yet:
   * `getClient()` verifies (and where reasonable, creates) the destination before anything is sent.
   */
  async function exportAll(target: StorageTarget): Promise<void> {
    const client = await getClient(target)

    let exported = 0
    for await (const asset of WIKI.models.assets.streamAll(target.siteId)) {
      if (!belongsInTarget(asset, target.contentTypes)) {
        continue
      }
      const key = keyFor(target, asset.folderPath, asset.fileName)
      await withErrors(`export "${key}"`, () =>
        driver.put(client, key, asset.data, asset.mimeType, target.config)
      )
      exported++
    }
    WIKI.logger.info('storage', 'exported every asset', {
      module: target.module,
      target: target.id,
      assets: exported,
      driver: driver.label
    })
  }

  /**
   * A short-lived, read-only URL for one asset — the primitive `assetDelivery.directAccess` needs to
   * redirect a browser straight to the bucket instead of streaming the file through the wiki server.
   * `s3`/`azure`/`gcs` are the only targets that declare `assetDelivery.isDirectAccessSupported: true`;
   * `models/assetServing.ts`'s `directUrlFor()` calls this (as `StorageModule.getDirectUrl`) whenever a
   * target both enables `assetDelivery.directAccess` and has a module implementing it — asset first,
   * target second, matching every other `StorageModule` handler's argument order.
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

  return {
    assetUploaded,
    assetDeleted,
    assetRenamed,
    exportAll,
    getDirectUrl
  }
}
