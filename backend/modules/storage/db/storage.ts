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
import { eq } from 'drizzle-orm'
import { assets as assetsTable } from '../../../db/schema.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * `purge` ("Purge All Assets"): null out every asset's stored bytes (`data`, `preview`) for this
 * target's site, leaving the `assets` row's other columns — and its matching `tree` entry — untouched.
 * That is exactly what the action's `definition.yml` hint promises ("not the metadata"): a page or
 * folder listing, a file's name/size/kind, and every link pointing at it all keep working: the row is
 * still there, it just answers a content request with nothing until re-uploaded or re-synced in from
 * another target.
 *
 * **Deliberately unconditional across every asset kind — not scoped to `target.contentTypes.activeTypes`.**
 * A page's content is untouched regardless, since it does not live in this table at all: the `pages`
 * bucket `validateTarget` forces on for this module has no bearing on what an asset purge does. For
 * assets, the db module keeps no separate physical copy per content type the way, say, a git checkout
 * or an S3 bucket would — every asset's bytes for this site live in exactly this one `data`/`preview`
 * pair, whichever buckets (`images`/`documents`/`others`/`large`) this target happens to be configured
 * to actively sync right now. Scoping the purge to `activeTypes` would mean an admin who flipped, say,
 * `images` off after moving images to another target could never reclaim that space through this
 * action — exactly the assets the action's own description ("useful if you moved assets to another
 * storage target and want to reduce the size of the database") means for it to free.
 */
export async function purge(target: StorageTarget): Promise<void> {
  const purged = await WIKI.db
    .update(assetsTable)
    .set({ data: null, preview: null })
    .where(eq(assetsTable.siteId, target.siteId))
    .returning({ id: assetsTable.id })

  if (purged.length < 1) {
    return
  }

  const ids = purged.map((row) => row.id)
  // -> Drops the disk-cached bytes of every purged asset on this instance, so `/_files/` cannot go on
  //    serving content the database no longer has.
  await WIKI.models.assetServing.dropCachedContent(ids)
  // -> Every purged asset's metadata just changed under any path resolution already cached for this
  //    site (`hasPreview` in particular, now false for anything that had a thumbnail) — a bulk change
  //    with no single path to target individually, the same reasoning `deleteOrphaned` follows for its
  //    own bulk deletion in `models/assets.ts`.
  WIKI.models.assetServing.forgetAllPaths()
}

const dbStorageModule: StorageModule = {
  purge
}

export default dbStorageModule
