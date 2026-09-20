import type { StorageModule } from '../../../models/storage.ts'
import {
  assetDeleted,
  assetMoved,
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
  // -> Content-dispatch handlers, called as `handler(target, data)` by the `dispatchStorage` task.
  created,
  updated,
  renamed,
  deleted,
  assetUploaded,
  assetRenamed,
  assetMoved,
  assetDeleted,
  // -> `definition.yml` actions, called as `handler(target)` by `Storage.executeAction()`.
  sync,
  syncUntracked,
  importAll,
  purge
}

export default gitStorageModule
