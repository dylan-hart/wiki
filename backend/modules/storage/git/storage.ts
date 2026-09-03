/**
 * Local Git storage module — assembles the module's exported handler surface.
 *
 * Repo lifecycle (`ensureRepo`) and its auth wiring live in the leaf `repo.ts`, which every sibling
 * imports downward from — see `repo.ts`'s header comment for why that leaf exists.
 *
 * The content-dispatch handlers (`created`/`updated`/`renamed`/`deleted`/`assetUploaded`/
 * `assetRenamed`/`assetDeleted`) live in `content.ts`; the `sync` action lives in `sync.ts`; the
 * remaining `syncUntracked`/`importAll`/`purge` actions live in `actions.ts`. All are re-exported onto
 * `gitStorageModule` below.
 */
import type { StorageModule } from '../../../models/storage.ts'
import {
  assetDeleted,
  assetRenamed,
  assetUploaded,
  created,
  deleted,
  renamed,
  updated
} from './content.ts'
import { sync } from './sync.ts'
import { importAll, purge, syncUntracked } from './actions.ts'

const gitStorageModule: StorageModule = {
  // -> Content-dispatch handlers (task 506) — see `content.ts` for the mapping and commit logic.
  //    Called as `handler(target, data)` by the `dispatchStorage` task, per `StorageModule`.
  created,
  updated,
  renamed,
  deleted,
  assetUploaded,
  assetRenamed,
  assetDeleted,
  // -> The `sync` action declared in `definition.yml` (task 507) — see `sync.ts`. Called as
  //    `handler(target)` by `Storage.executeAction()`, per `StorageModule`.
  sync,
  // -> The remaining `definition.yml` actions (task 508) — see `actions.ts`. Same `handler(target)`
  //    calling convention as `sync`.
  syncUntracked,
  importAll,
  purge
}

export default gitStorageModule
