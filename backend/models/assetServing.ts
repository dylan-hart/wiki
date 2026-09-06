import fs from 'node:fs/promises'
import path from 'node:path'
import { belongsInTarget } from '../helpers/blobTarget.ts'
import { DB_MODULE } from './storage.ts'
import type { Readable } from 'node:stream'
import type { Asset, AssetKind } from './assets.ts'
import type { StorageTarget } from './storage.ts'

/**
 * How long a path resolution is trusted before it is looked up again.
 *
 * The backstop rather than the mechanism: the mutations that move an asset drop the entries they
 * affect, but only on the instance that ran them, and a second instance has no way to hear about it —
 * so every entry expires on its own as well. Short enough that a rename made elsewhere shows up
 * quickly, long enough that a busy page's images resolve once rather than once per request.
 */
const PATH_CACHE_TTL_MS = 60_000

/** How many path resolutions to hold per instance. Each is one row of metadata, so this is small. */
const PATH_CACHE_MAX = 5000

/** Ceiling for the disk cache when nothing is configured. */
const DEFAULT_CACHE_MAX_SIZE = 512 * 1024 * 1024

/** Sweep once this much of the ceiling has been written since the last one. */
const SWEEP_TRIGGER_RATIO = 0.25

/** How far under the ceiling a sweep trims, so that the next write does not trigger another. */
const SWEEP_TARGET_RATIO = 0.8

/**
 * The form a file path is cached under.
 *
 * Matches what the lookup does with it — empty segments dropped, lowercased — so that the spellings
 * of a path that reach the same asset share one cache entry instead of each getting their own.
 */
function normalizePath(filePath: string): string {
  return filePath.split('/').filter(Boolean).join('/').toLowerCase()
}

/**
 * Asset serving cache model
 *
 * The database is always the one durable copy of an asset's bytes (see `models/assets.ts`) — but not
 * the one that answers a request for a file. Serving goes through two caches, because `/_files/` is
 * hit by every image on every page view and neither half of that lookup needs the database twice:
 *
 * 1. **memory**, holding path → metadata for `PATH_CACHE_TTL_MS`, which is what decides the ETag and
 *    answers the conditional requests a browser sends once its own copy goes stale
 * 2. **disk**, under `<dataPath>/cache/files`, holding the bytes, streamed straight to the response
 *
 * Only the database is permanent; both caches are derived and can be deleted at any point, which is
 * also what makes a cold instance correct rather than empty-handed. That is why this is a model of
 * its own (MOD-F14): nothing in it is a source of truth, and the CRUD half of `models/assets.ts`
 * touches it only to say "forget what you had for this asset".
 */
class AssetServing {
  /** Path resolutions, keyed `siteId:path`. Insertion-ordered, so the oldest entry is evictable. */
  pathCache = new Map<string, { asset: Asset; cachedAt: number }>()

  /** Bytes written to the disk cache since the last sweep, for `SWEEP_TRIGGER_RATIO`. */
  writtenSinceSweep = 0

  /** Whether a sweep is running, so that a burst of writes queues no more than one. */
  sweeping = false

  /**
   * An asset addressed by path, answered from memory where it can be.
   *
   * What `/_files/` resolves every request through: the metadata decides whether the caller may read
   * the file and what its ETag is, both of which are needed before any bytes are worth fetching.
   */
  async resolveAssetPath(siteId: string, filePath: string): Promise<Asset | null> {
    const key = `${siteId}:${normalizePath(filePath)}`
    const cached = this.pathCache.get(key)
    if (cached && Date.now() - cached.cachedAt < PATH_CACHE_TTL_MS) {
      return cached.asset
    }

    const asset = await WIKI.models.assets.getAssetByPath(siteId, filePath)
    if (!asset) {
      // -> A path with nothing at it is not remembered as empty: a file uploaded there has no way to
      //    find the entry and clear it, and it would answer 404 for as long as the entry lived
      this.pathCache.delete(key)
      return null
    }
    if (this.pathCache.size >= PATH_CACHE_MAX) {
      const oldest = this.pathCache.keys().next().value
      if (oldest) {
        this.pathCache.delete(oldest)
      }
    }
    this.pathCache.set(key, { asset, cachedAt: Date.now() })
    return asset
  }

  /**
   * Forget what sits at a path, for a change that moved one asset
   */
  forgetPath(siteId: string, folderPath: string, fileName: string): void {
    this.pathCache.delete(
      `${siteId}:${normalizePath(folderPath ? `${folderPath}/${fileName}` : fileName)}`
    )
  }

  /**
   * Forget every path resolution, for a change that moved assets in bulk — a folder renamed or
   * deleted, where the paths that changed are no longer enumerable from what is left in the tree.
   */
  forgetAllPaths(): void {
    this.pathCache.clear()
  }

  /**
   * The target that governs how this site's assets are served.
   *
   * An asset's bytes always live in the assets table regardless of what else is configured (the disk
   * module only dumps/imports/backs up on request, and a file-backed or blob module keeps its own
   * copy in sync via `dispatchStorage` rather than being where `readContent` reads from directly) — so
   * the db target's `assetDelivery` settings are the default answer for whether to cache to disk and
   * whether to redirect.
   *
   * A blob target (`s3`/`azure`/`gcs`) that both has direct access turned on and actually holds a copy
   * of the asset being served — its `contentTypes` cover the asset's kind/size, per
   * `helpers/blobTarget.ts`'s `belongsInTarget` — governs instead: it is the one place besides the db
   * itself with a URL of its own for the file, so its `assetDelivery` settings decide whether that URL
   * gets used. Passing no `asset` (or omitting a kind a target's `contentTypes` distinguish by) skips
   * this check entirely and falls straight to the db target, same as before this existed.
   *
   * @returns Null when the site has no db target row at all, which `readContent` treats as the
   *   documented defaults (streaming on, no direct access) rather than as a hard failure
   */
  async governingTarget(
    siteId: string,
    asset?: { kind: AssetKind; fileSize: number }
  ): Promise<StorageTarget | null> {
    const targets = await WIKI.models.storage.getSiteTargets(siteId)
    if (asset) {
      const directAccessTarget = targets.find(
        (t) =>
          t.isEnabled &&
          t.assetDelivery.isDirectAccessSupported &&
          t.assetDelivery.directAccess &&
          belongsInTarget(asset, t.contentTypes)
      )
      if (directAccessTarget) {
        return directAccessTarget
      }
    }
    return targets.find((t) => t.module === DB_MODULE && t.isEnabled) ?? null
  }

  /**
   * A direct URL to serve an asset from instead of proxying it, if the governing target both allows
   * one and has a module behind it that can produce one. See `StorageModule.getDirectUrl`.
   */
  async directUrlFor(
    asset: { id: string; updatedAt: Date; fileName: string; folderPath: string },
    target: StorageTarget
  ): Promise<string | null> {
    if (!target.assetDelivery.directAccess || !target.assetDelivery.isDirectAccessSupported) {
      return null
    }
    const mod = await WIKI.models.storage.ensureModule(target.module)
    if (!mod?.getDirectUrl) {
      return null
    }
    return (await mod.getDirectUrl(asset, target)) ?? null
  }

  /**
   * An asset's bytes, ready to be sent — from the disk cache, or from the database and into it — or a
   * URL to redirect the request to instead, per the site's governing storage target.
   *
   * `assetDelivery.streaming` (on by default) decides whether the disk cache is used at all: off means
   * every request is a buffered read straight from the database, with nothing written to local disk —
   * the point of turning it off is that asset bytes never touch this instance's disk. `directAccess`
   * is checked first, since a target that can hand out its own URL should never have its bytes read at
   * all, cache or no cache.
   *
   * @returns A stream when the disk cache holds the file, the buffer when it had to be read from the
   *   database, a `redirectUrl` in place of either when the target supplied one, and null when there
   *   is no such asset, i.e. when a cached path resolution has outlived the row behind it
   */
  async readContent(
    asset: {
      id: string
      updatedAt: Date
      fileName: string
      folderPath: string
      kind: AssetKind
      fileSize: number
    },
    siteId: string
  ): Promise<{ body: Readable | Buffer; size: number } | { redirectUrl: string } | null> {
    const target = await this.governingTarget(siteId, {
      kind: asset.kind,
      fileSize: asset.fileSize
    })

    if (target) {
      const redirectUrl = await this.directUrlFor(asset, target)
      if (redirectUrl) {
        return { redirectUrl }
      }
    }

    // -> Absent a target row (should not normally happen — every site gets one, see `syncSite`) the
    //    documented default applies: streaming on, exactly today's pre-target-aware behavior
    const streaming = target?.assetDelivery.streaming ?? true

    if (streaming) {
      const cached = await this.readContentCache(asset)
      if (cached) {
        return cached
      }
    }

    const content = await WIKI.models.assets.getContent(asset.id)
    if (!content) {
      return null
    }
    if (streaming) {
      await this.writeContentCache(asset, content.data)
    }
    return { body: content.data, size: content.data.length }
  }

  /**
   * Where an asset's bytes sit in the disk cache.
   *
   * Named for the ID and the modification time together, which is what makes an entry immutable:
   * anything that changes a file changes the name it would be cached under, so a stale entry is never
   * read, only left behind for the sweep. Sharded by the first byte of the ID, to keep a wiki's worth
   * of files out of a single directory.
   */
  contentCachePath(asset: { id: string; updatedAt: Date }): string {
    return path.join(
      this.cachePath,
      asset.id.slice(0, 2),
      `${asset.id}-${asset.updatedAt.getTime()}.bin`
    )
  }

  /**
   * Open an asset's cached bytes.
   *
   * The file is opened before it is streamed rather than as it is streamed, so that a sweep removing
   * it midway through a response cannot truncate what is being sent: the handle keeps the bytes
   * readable until the stream closes it, whatever happens to the directory entry.
   *
   * @returns Null when this instance has not cached the file, which is the normal state of a fresh
   *   container and the state of every entry after a change to the file
   */
  async readContentCache(asset: {
    id: string
    updatedAt: Date
  }): Promise<{ body: Readable; size: number } | null> {
    let handle
    try {
      handle = await fs.open(this.contentCachePath(asset), 'r')
    } catch {
      return null
    }
    try {
      const { size } = await handle.stat()
      return { body: handle.createReadStream({ autoClose: true }), size }
    } catch {
      await handle.close().catch(() => {})
      return null
    }
  }

  /**
   * Write an asset's bytes to the disk cache, best effort.
   *
   * A full or read-only disk must not stop a file from being served, hence the swallowed error — the
   * database answers every request the cache cannot. The file is written under a temporary name and
   * renamed, so a concurrent reader sees either nothing or the whole thing.
   */
  async writeContentCache(asset: { id: string; updatedAt: Date }, data: Buffer): Promise<void> {
    // -> A file larger than the whole cache would be evicted by the sweep it triggers
    if (this.cacheMaxSize < 1 || data.length > this.cacheMaxSize) {
      return
    }
    const filePath = this.contentCachePath(asset)
    const tempPath = `${filePath}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(tempPath, data)
      await fs.rename(tempPath, filePath)
    } catch (err: any) {
      WIKI.logger.warn('assets', 'writing to the file cache failed', { path: filePath, error: err })
      await fs.rm(tempPath, { force: true }).catch(() => {})
      return
    }

    this.writtenSinceSweep += data.length
    if (this.writtenSinceSweep >= this.cacheMaxSize * SWEEP_TRIGGER_RATIO) {
      // -> Nothing waits on this: the request that filled the cache is not the one that should pay
      //    for measuring it
      void this.sweepCache()
    }
  }

  /**
   * Drop whatever the disk cache holds for these assets.
   *
   * Every entry an asset has, not just its current one — a file renamed twice leaves two behind, and
   * the point of this is to reclaim the space rather than to correct an answer, which the naming
   * already does.
   */
  async dropCachedContent(ids: string[]): Promise<void> {
    for (const id of ids) {
      const shard = path.join(this.cachePath, id.slice(0, 2))
      try {
        const entries = await fs.readdir(shard)
        await Promise.all(
          entries
            .filter((name) => name.startsWith(`${id}-`))
            .map((name) => fs.rm(path.join(shard, name), { force: true }))
        )
      } catch {
        // -> Nothing cached for it on this instance, which is not worth reporting
      }
    }
  }

  /**
   * Trim the disk cache back under its ceiling, oldest entry first.
   *
   * Oldest by when it was written rather than when it was last read: keeping a true LRU would mean
   * touching a file on every hit, which puts a write back on the path this cache exists to keep
   * writes off. An entry evicted while still in demand is refilled by the next request for it.
   */
  async sweepCache(): Promise<void> {
    if (this.sweeping) {
      return
    }
    this.sweeping = true
    this.writtenSinceSweep = 0
    try {
      const files: { path: string; size: number; writtenAt: number }[] = []
      let total = 0
      const entries = await fs.readdir(this.cachePath, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bin')) {
          continue
        }
        const filePath = path.join(entry.parentPath, entry.name)
        const stat = await fs.stat(filePath).catch(() => null)
        if (!stat) {
          continue
        }
        files.push({ path: filePath, size: stat.size, writtenAt: stat.mtimeMs })
        total += stat.size
      }
      if (total <= this.cacheMaxSize) {
        return
      }

      files.sort((a, b) => a.writtenAt - b.writtenAt)
      const target = this.cacheMaxSize * SWEEP_TARGET_RATIO
      let removed = 0
      for (const file of files) {
        if (total <= target) {
          break
        }
        await fs.rm(file.path, { force: true })
        total -= file.size
        removed++
      }
      WIKI.logger.debug('assets', 'trimmed the file cache', { files: removed })
    } catch (err: any) {
      WIKI.logger.warn('assets', 'sweeping the file cache failed', { error: err })
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Drop both serving caches of this instance.
   *
   * Nothing is lost: the metadata is read back from the database on the next request for a path, and
   * the bytes on the next request for a file. What it costs is the refill — every image on the next
   * page view goes to the database once — which is the price of being certain nothing stale is being
   * served.
   */
  async purgeCache(): Promise<void> {
    this.pathCache.clear()
    this.writtenSinceSweep = 0
    await fs.rm(this.cachePath, { recursive: true, force: true })
    await fs.mkdir(this.cachePath, { recursive: true })
    WIKI.logger.info('assets', 'purged the file cache')
  }

  /** Where the disk cache lives. Derived data — deleting it costs a refill and nothing else. */
  get cachePath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'cache/files')
  }

  /** How large the disk cache may grow, in bytes. Zero turns it off. */
  get cacheMaxSize(): number {
    return WIKI.config.files?.cacheMaxSize ?? DEFAULT_CACHE_MAX_SIZE
  }
}

export const assetServing = new AssetServing()
