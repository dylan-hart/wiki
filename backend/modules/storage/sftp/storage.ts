import { connectSftp } from './connection.ts'
import { exportAssets } from './assets.ts'
import { exportPages } from './pages.ts'
import type { SftpTargetConfig } from './connection.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * Pages and assets each no-op when their content type isn't active on the target, so both always
 * run — which of them writes anything is down to `target.contentTypes.activeTypes`. An export
 * failure propagates uncaught, because that is what surfaces its message to the admin area;
 * progress logging supplements that, never substitutes for it.
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
  const log = CARDINAL.logger.scope('storage', { module: 'sftp', target: target.id })

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
      // -> Never throw out of the `finally`: that would mask whatever the export itself threw.
      log.warn('could not cleanly close the SFTP connection', { error: err })
    }
  }
}

// -> No `assetRenamed`/`assetMoved` handler: this module writes only through the `exportAll` action
//    above (`supportsContentSync` is false for it), so a rename or a folder move is picked up whole
//    by the next export rather than propagated incrementally.
export default {
  exportAll
} as StorageModule
