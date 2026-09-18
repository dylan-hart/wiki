/**
 * Database storage module — the target every site starts on and can never be fully disabled (see
 * `validateTarget` in `models/storage.ts`), because content has to live somewhere.
 *
 * Unlike every other module, this one owns no external destination to push content out to: a page's
 * content already lives in the `pages`/`pageHistory` tables and an asset's bytes already live in the
 * `assets` table the moment either is written — `models/pages.ts` and `models/assets.ts` write there
 * directly, not through a storage module's handlers. So none of the write-path content-dispatch
 * handlers (`created`/`updated`/`assetUploaded`/...) have anything to do here; only the `purge`
 * action `definition.yml` declares has real work behind it.
 */
import { inArray } from 'drizzle-orm'
import { assets as assetsTable } from '../../../db/schema.ts'
import { DB_MODULE } from '../../../models/storage.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * `purge` ("Purge All Assets"): null out the stored bytes (`data`, `preview`) of every asset in this
 * target's site that some OTHER target can still actually serve, leaving the `assets` row's other
 * columns — and its matching `tree` entry — untouched for every asset, purged or not. That is exactly
 * what the action's `definition.yml` hint promises ("not the metadata"): a page or folder listing, a
 * file's name/size/kind, and every link pointing at it all keep working regardless.
 *
 * **Per-asset, gated on `assetServing.governingTargetFrom()` — the same predicate `readContent` uses
 * to decide where to serve a request from (OpenProject #3375).** Before this, the update was a single
 * unconditional `UPDATE ... WHERE siteId = ?`: an asset with no direct-access target covering it had
 * its only copy of its bytes deleted with no way back, since `/_files/` has exactly two ways to answer
 * a request — a redirect to a direct-access target's own URL, or the db column this just nulled — and
 * `BlobDriver` has no `get`/`head` to refill from. An asset is only purged when the site's targets
 * resolve, for that specific asset's kind/size, to a non-db governing target: a blob target
 * (`s3`/`azure`/`gcs`) with `assetDelivery.directAccess` on and `contentTypes` covering it. Everything
 * else — no direct-access target configured at all, or one configured but not covering this asset's
 * kind/size bucket — is left alone, by construction still servable exactly as it was before the purge.
 *
 * @returns `purged`/`skipped` counts, surfaced by `models/storage.ts#executeAction` and
 *   `api/storage.ts`'s action route into the reply so an admin sees what actually happened rather than
 *   a fixed "completed" message.
 */
export async function purge(target: StorageTarget): Promise<{ purged: number; skipped: number }> {
  const siteAssets = await CARDINAL.models.assets.listAllForSite(target.siteId)
  if (siteAssets.length < 1) {
    return { purged: 0, skipped: 0 }
  }

  const targets = await CARDINAL.models.storage.getSiteTargets(target.siteId)
  const purgeableIds: string[] = []
  let skipped = 0
  for (const asset of siteAssets) {
    const governingTarget = CARDINAL.models.assetServing.governingTargetFrom(targets, {
      kind: asset.kind,
      fileSize: asset.fileSize
    })
    if (governingTarget && governingTarget.module !== DB_MODULE) {
      purgeableIds.push(asset.id)
    } else {
      skipped++
    }
  }

  if (purgeableIds.length < 1) {
    return { purged: 0, skipped }
  }

  await CARDINAL.db
    .update(assetsTable)
    .set({ data: null, preview: null })
    .where(inArray(assetsTable.id, purgeableIds))

  // -> Drops the disk-cached bytes of every purged asset on this instance, so `/_files/` cannot go on
  //    serving content the database no longer has.
  await CARDINAL.models.assetServing.dropCachedContent(purgeableIds)
  // -> Every purged asset's metadata just changed under any path resolution already cached for this
  //    site (`hasPreview` in particular, now false for anything that had a thumbnail) — a bulk change
  //    with no single path to target individually, the same reasoning `deleteOrphaned` follows for its
  //    own bulk deletion in `models/assets.ts`.
  CARDINAL.models.assetServing.forgetAllPaths()

  return { purged: purgeableIds.length, skipped }
}

const dbStorageModule: StorageModule = {
  purge
}

export default dbStorageModule
