import { connectSftp } from './connection.ts'
import { exportAssets } from './assets.ts'
import { exportPages } from './pages.ts'
import type { SftpTargetConfig } from './connection.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * The `sftp` module's `StorageModule` implementation — what `models/storage.ts`'s `ensureModule()`
 * dynamically imports and `executeAction()` calls a handler on (`mod[handler](target)`).
 *
 * This is the file whose mere presence flips `hasImplementation` on for the module (see
 * `connection.ts`'s header comment): everything it needs — the connection layer (Task 521), page
 * export (Task 522), and asset export (Task 523) — already exists as a sibling module. This file's
 * only job is orchestration: open the connection once, run both exports in sequence, log progress at
 * a granularity useful for a large export, and guarantee the connection closes no matter how the
 * export ends. Every line it writes goes through one `storage` child logger carrying `module=sftp`
 * and the target's id, so a line says which target it came from without spelling it out.
 */

/**
 * Run the `exportAll` action: write every eligible page and asset of the target's site to the remote
 * SFTP server, overwriting anything already there.
 *
 * Pages and assets each independently no-op when their content type isn't active on the target (see
 * `exportPages`/`exportAssets`), so this always calls both — which of them actually writes anything is
 * entirely down to `target.contentTypes.activeTypes`.
 *
 * @param deps Swappable for stubs in tests; `models/storage.ts`'s `executeAction` calls this with only
 *   `target` (`mod[handler](target)`), so every default here is what actually runs in production.
 * @throws Whatever `connectSftp`, `exportPages`, or `exportAssets` throws — a plain `Error` with a
 *   complete, specific message. This propagates straight through `models/storage.ts`'s `executeAction`
 *   uncaught (by design: `executeAction` adds no handling of its own), through `api/storage.ts`'s
 *   action route, which catches it and returns `400` with `err.message` as the body, to the admin
 *   area's `executeAction()` in `AdminStorage.vue`, which surfaces it as a negative toast. Logging
 *   progress here is a supplement to that failure surface, never a substitute for it — nothing in this
 *   function catches and swallows an export error.
 */
export async function exportAll(
  target: StorageTarget,
  deps: {
    connect?: typeof connectSftp
    runExportPages?: typeof exportPages
    runExportAssets?: typeof exportAssets
  } = {}
): Promise<void> {
  const connect = deps.connect ?? connectSftp
  const runExportPages = deps.runExportPages ?? exportPages
  const runExportAssets = deps.runExportAssets ?? exportAssets
  const config = target.config as SftpTargetConfig
  const log = WIKI.logger.scope('storage', { module: 'sftp', target: target.id })

  log.info('starting the export', {
    site: target.siteId,
    host: config.host,
    path: config.basePath
  })

  const client = await connect(config)
  try {
    await runExportPages(client, target, {
      onProgress: (count) => {
        log.debug('exporting pages', { pages: count })
      }
    })
    await runExportAssets(client, target, {
      onProgress: (count) => {
        log.debug('exporting assets', { assets: count })
      }
    })
    log.info('export completed', { site: target.siteId })
  } finally {
    try {
      await client.end()
    } catch (err: any) {
      // -> Closing the connection failed after the export already succeeded or failed on its own
      //    terms — worth knowing about, but not worth masking whatever `try` above actually threw
      //    (or didn't) by throwing a second, unrelated error out of a `finally` block.
      log.warn('could not cleanly close the SFTP connection', { error: err })
    }
  }
}

export default {
  exportAll
} as StorageModule
