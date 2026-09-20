import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Cron } from 'croner'
import { runReplicationPostImport } from '../helpers/replicationPostImport.ts'

export const REPLICATION_PULL_TASK = 'replicationPull'

const EXPORT_POLL_TIMEOUT_MINUTES = 60

const EXPORT_POLL_INTERVAL_MS = 5000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Scheduled clean-slate replication from another instance. Deliberately two tasks rather than one:
 * `tick()` is a cheap due-check that runs on a short cron whether or not anything is due, and the
 * potentially long whole-instance `pull()` only ever runs as its own queued job.
 */
class Replication {
  private get tempPath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'replication')
  }

  /**
   * No `lastRunAt` counts as immediately due, as `Storage#tickScheduledSyncs` does for a storage
   * target, so a freshly configured schedule runs soon rather than waiting out a full period. For a
   * wipe-and-replace that is a sharp edge: flipping `isEnabled` on pulls on the very next tick.
   */
  async tick(now: Temporal.Instant = Temporal.Now.instant()): Promise<number> {
    const cfg = CARDINAL.config.replication
    if (!cfg?.isEnabled || !cfg.sourceUrl || !cfg.cronSchedule) {
      return 0
    }

    if (cfg.lastRunAt) {
      let next: Date | null
      try {
        next = new Cron(cfg.cronSchedule, { timezone: 'UTC', paused: true }).nextRun(
          new Date(Temporal.Instant.from(cfg.lastRunAt).epochMilliseconds)
        )
      } catch (err: any) {
        CARDINAL.logger.warn('jobs', 'unparseable replication cron expression, skipping', {
          schedule: cfg.cronSchedule,
          error: err
        })
        return 0
      }
      if (!next || next.getTime() > now.epochMilliseconds) {
        return 0
      }
    }

    const added = await CARDINAL.scheduler.addJob({ task: REPLICATION_PULL_TASK })
    if (!added?.id) {
      return 0
    }

    await this.recordRun(now)
    return 1
  }

  private async recordRun(now: Temporal.Instant): Promise<void> {
    CARDINAL.config.replication = {
      ...CARDINAL.config.replication,
      lastRunAt: now.toString({ smallestUnit: 'millisecond' })
    }
    await CARDINAL.configSvc.saveToDb(['replication'])
  }

  /**
   * A disabled or unconfigured instance is a no-op, not a thrown error, and the check is repeated
   * here rather than trusted to `tick()`: an on-demand "run now" from the scheduler admin view
   * queues this task without going through it.
   */
  async pull(): Promise<void> {
    const cfg = CARDINAL.config.replication
    if (!cfg?.isEnabled) {
      CARDINAL.logger.debug('jobs', 'replication pull skipped, replication is disabled')
      return
    }
    if (!cfg.sourceUrl || !cfg.bearerToken) {
      CARDINAL.logger.warn('jobs', 'replication pull skipped, no source URL or token configured')
      return
    }

    const filePath = await this.downloadSnapshot(cfg.sourceUrl, cfg.bearerToken)
    try {
      await this.importSnapshot(filePath)
      // -> Only reached once the restore itself succeeded: a failed or partial import must not
      //    reload caches or queue a reindex as though it had landed
      await this.runPostImportSideEffects()
      CARDINAL.logger.info('jobs', 'replication pull complete', { source: cfg.sourceUrl })
    } finally {
      await fs.rm(filePath, { force: true })
    }
  }

  /** 409 is the source instance's "export still running" answer, and the only status polled on. */
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

  /** Streamed to disk rather than buffered: a whole-instance archive has no business in memory. */
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
   * `replicationImport` is duck-typed out of `CARDINAL.models` rather than imported, so this file
   * stays testable in isolation from that model instead of binding to its exact shape.
   */
  private async importSnapshot(filePath: string): Promise<void> {
    const replicationImport = (CARDINAL.models as Record<string, any>).replicationImport
    if (typeof replicationImport?.importSnapshot !== 'function') {
      throw new Error('Replication import is not available on this instance (OpenProject #2490).')
    }
    await replicationImport.importSnapshot(filePath)
  }

  /**
   * The cache reloads and reindex jobs a wipe-and-replace needs, implemented once in
   * `helpers/replicationPostImport.ts` so this and the manual-upload path
   * (`tasks/simple/replication-import.ts`) cannot drift apart.
   */
  private async runPostImportSideEffects(): Promise<void> {
    await runReplicationPostImport({
      sites: CARDINAL.models.sites,
      groups: CARDINAL.models.groups,
      classificationLevels: CARDINAL.models.classificationLevels,
      glossary: CARDINAL.models.glossary,
      assetServing: CARDINAL.models.assetServing,
      addJob: (opts) => CARDINAL.scheduler.addJob(opts)
    })
  }
}

export const replication = new Replication()
