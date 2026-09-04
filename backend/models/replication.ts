import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { CronExpressionParser } from 'cron-parser'
import { runReplicationPostImport } from '../helpers/replicationPostImport.ts'

/** The task `tick()` queues once the configured schedule is due. */
export const REPLICATION_PULL_TASK = 'replicationPull'

/** How long `pull()` waits for the source instance's export job to finish before giving up. */
const EXPORT_POLL_TIMEOUT_MINUTES = 60

/** How often `pull()` re-polls the source instance's download route while the export is pending. */
const EXPORT_POLL_INTERVAL_MS = 5000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Scheduled clean-slate replication from another instance (OpenProject #2437): wires the
 * instance-level `WIKI.config.replication` schedule into `core/scheduler.ts`'s cron infrastructure
 * (`tick()`, run every 5 minutes by the `replicationTick` seed entry in `models/jobs.ts`) and, once a
 * pull is actually queued, performs it (`pull()`, run by `tasks/simple/replication-pull.ts`).
 *
 * Deliberately two tasks rather than one, mirroring `Storage#tickScheduledSyncs` /
 * `dispatchStorage`: the due-check runs on a short, cheap cron regardless of whether anything is
 * actually due, and the (potentially long-running, whole-instance) pull itself only ever runs as its
 * own queued job.
 *
 * `pull()`'s two halves talk to genuinely different things, and are decoupled from their sibling
 * WPs' code on purpose:
 * - The source-side half is a real HTTP round trip to another instance -- `downloadSnapshot()` calls
 *   OpenProject #2489's bulk-export API (`api/system/replicationExport.ts`), mirroring the exact
 *   `POST .../export` → `{ id }`, then poll `GET .../export/:id/download` for 200/409/404 contract
 *   `api/system/transfer.ts`'s per-site export/download pair already established.
 * - The target-side half is a same-process model call, not HTTP -- `importSnapshot()` below reaches
 *   for `WIKI.models.replicationImport.importSnapshot()` (OpenProject #2490,
 *   `models/replicationImport.ts`) through a narrow duck-typed lookup rather than a normal import, so
 *   this file stays testable in isolation from that model rather than binding to its exact shape.
 *
 * Once a snapshot has actually been restored, `pull()` runs the same post-import cache/index
 * invalidation `tasks/simple/replication-import.ts` runs for the manual-upload path (OpenProject
 * #2517) -- see `helpers/replicationPostImport.ts`, the implementation the two callers of
 * `replicationImport.importSnapshot()` share so they cannot drift out of sync with each other again.
 */
class Replication {
  /** `<dataPath>/replication` -- scratch space for a downloaded snapshot, cleaned up per-pull. */
  private get tempPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'replication')
  }

  /**
   * Check whether the configured replication schedule is due, and queue a pull if so.
   *
   * Due-ness mirrors `Storage#tickScheduledSyncs` exactly: no `lastRunAt` recorded yet counts as
   * immediately due, the same "a freshly configured schedule runs soon rather than silently waiting
   * out its first full period" choice that method already makes for a storage target. For a
   * wipe-and-replace pull that is a sharper edge than a storage sync (an admin flipping `isEnabled` on
   * fires a full pull on the very next tick), flagged in this WP's implementation plan for review
   * rather than silently diverging from the established pattern.
   *
   * @returns 1 if a pull was queued, 0 otherwise (disabled, unconfigured, not yet due, or the
   *          scheduler declined to queue it).
   */
  async tick(now: Temporal.Instant = Temporal.Now.instant()): Promise<number> {
    const cfg = WIKI.config.replication
    if (!cfg?.isEnabled || !cfg.sourceUrl || !cfg.cronSchedule) {
      return 0
    }

    if (cfg.lastRunAt) {
      let next
      try {
        next = CronExpressionParser.parse(cfg.cronSchedule, {
          startDate: Temporal.Instant.from(cfg.lastRunAt).toString({ smallestUnit: 'millisecond' }),
          tz: 'UTC'
        }).next()
      } catch (err: any) {
        WIKI.logger.warn(
          `Replication schedule has an unparseable cron expression "${cfg.cronSchedule}", skipping: ${err.message}`
        )
        return 0
      }
      if (next.getTime() > now.epochMilliseconds) {
        return 0
      }
    }

    const added = await WIKI.scheduler.addJob({ task: REPLICATION_PULL_TASK })
    if (!added?.id) {
      return 0
    }

    await this.recordRun(now)
    return 1
  }

  /** Persists `lastRunAt` -- `tick()`'s own due-check reads it back next time it runs. */
  private async recordRun(now: Temporal.Instant): Promise<void> {
    WIKI.config.replication = {
      ...WIKI.config.replication,
      lastRunAt: now.toString({ smallestUnit: 'millisecond' })
    }
    await WIKI.configSvc.saveToDb(['replication'])
  }

  /**
   * Pull a fresh full snapshot from the configured source instance and wipe-and-replace this
   * instance's own data with it. Run by `tasks/simple/replication-pull.ts`, itself only ever queued
   * by `tick()` above.
   *
   * A disabled/unconfigured instance is a no-op, not a thrown error: `tick()` is the only thing that
   * queues this task under normal operation and already checks `isEnabled`/`sourceUrl`, but an
   * on-demand run (the scheduler admin view's "run now") bypasses that check, so this re-validates
   * rather than trusting the caller.
   */
  async pull(): Promise<void> {
    const cfg = WIKI.config.replication
    if (!cfg?.isEnabled) {
      WIKI.logger.info('Replication pull skipped: replication is disabled.')
      return
    }
    if (!cfg.sourceUrl || !cfg.bearerToken) {
      WIKI.logger.warn('Replication pull skipped: source URL or token is not configured.')
      return
    }

    WIKI.logger.info(`Replication pull starting from ${cfg.sourceUrl}...`)

    const filePath = await this.downloadSnapshot(cfg.sourceUrl, cfg.bearerToken)
    try {
      await this.importSnapshot(filePath)
      // -> Only reached once the restore itself has actually succeeded (OpenProject #2517) -- a
      //    failed/partial import never reloads caches or queues a reindex as though it had landed.
      await this.runPostImportSideEffects()
      WIKI.logger.info('Replication pull: [ COMPLETED ]')
    } finally {
      await fs.rm(filePath, { force: true })
    }
  }

  /**
   * Requests a fresh export from the source instance, polls its download route until ready, and
   * streams the archive to `<dataPath>/replication/`.
   *
   * @returns The downloaded archive's local path.
   */
  private async downloadSnapshot(sourceUrl: string, sourceToken: string): Promise<string> {
    const exportResp = await fetch(new URL('/_api/system/replication/export', sourceUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${sourceToken}` }
    })
    if (!exportResp.ok) {
      throw new Error(
        `Source instance refused the replication export request (HTTP ${exportResp.status}).`
      )
    }
    const { id } = (await exportResp.json()) as { id?: string }
    if (!id) {
      throw new Error('Source instance did not return an export job id.')
    }

    const downloadUrl = new URL(`/_api/system/replication/export/${id}/download`, sourceUrl)
    const deadline = Temporal.Now.instant().add({ minutes: EXPORT_POLL_TIMEOUT_MINUTES })
    for (;;) {
      const downloadResp = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${sourceToken}` }
      })
      if (downloadResp.status === 200) {
        return this.saveResponseToDisk(downloadResp)
      }
      if (downloadResp.status !== 409) {
        throw new Error(
          `Source instance's replication export download failed (HTTP ${downloadResp.status}).`
        )
      }
      if (Temporal.Instant.compare(Temporal.Now.instant(), deadline) >= 0) {
        throw new Error("Timed out waiting for the source instance's replication export to finish.")
      }
      await sleep(EXPORT_POLL_INTERVAL_MS)
    }
  }

  /** Streams a finished export download response straight to disk -- never buffered in memory. */
  private async saveResponseToDisk(response: Response): Promise<string> {
    if (!response.body) {
      throw new Error('Source instance sent an empty replication export.')
    }
    await fs.mkdir(this.tempPath, { recursive: true })
    const filePath = path.join(this.tempPath, `${crypto.randomUUID()}.tar.gz`)
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(filePath))
    return filePath
  }

  /**
   * Hands the downloaded archive off to the target-side wipe-and-replace import.
   *
   * `WIKI.models.replicationImport` (OpenProject #2490) is looked up dynamically rather than
   * imported normally -- see this file's class-level doc comment for why.
   */
  private async importSnapshot(filePath: string): Promise<void> {
    const replicationImport = (WIKI.models as Record<string, any>).replicationImport
    if (typeof replicationImport?.importSnapshot !== 'function') {
      throw new Error('Replication import is not available on this instance (OpenProject #2490).')
    }
    await replicationImport.importSnapshot(filePath)
  }

  /**
   * Reload the `ClusterReloaded` caches a wipe-and-replace just invalidated wholesale, drop the
   * glossary and asset path-resolution caches, and queue a search reindex per restored site --
   * shared with `tasks/simple/replication-import.ts` via `helpers/replicationPostImport.ts` (see
   * this class's doc comment). Unlike `importSnapshot()` above, these five models are always
   * registered core models (not a feature-gated one that might not be installed), so a plain typed
   * `WIKI.models.*` read is used rather than a duck-typed lookup.
   */
  private async runPostImportSideEffects(): Promise<void> {
    await runReplicationPostImport({
      sites: WIKI.models.sites,
      groups: WIKI.models.groups,
      classificationLevels: WIKI.models.classificationLevels,
      glossary: WIKI.models.glossary,
      assetServing: WIKI.models.assetServing,
      addJob: (opts) => WIKI.scheduler.addJob(opts)
    })
  }
}

export const replication = new Replication()
