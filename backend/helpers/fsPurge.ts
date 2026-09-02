import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Delete every file in `dir` whose last-modified time is older than `ttlSeconds` ago.
 *
 * The sweep `models/export.ts` and `models/siteImport.ts` each wrote out in full for their own
 * directory under `<dataPath>`: an export nobody came back to download, an upload whose import job
 * crashed before it could clean up after itself. A missing directory is not a failure — until the
 * first export or import there is nothing there to sweep — so it counts as zero; anything else
 * `readdir` refuses is a real problem and is rethrown.
 *
 * @returns How many files were removed
 */
export async function purgeFilesOlderThan(dir: string, ttlSeconds: number): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return 0
    }
    throw err
  }

  const cutoff = Temporal.Now.instant().subtract({ seconds: ttlSeconds })
  let purged = 0
  for (const entry of entries) {
    const entryPath = path.join(dir, entry)
    const stat = await fs.stat(entryPath)
    if (Temporal.Instant.compare(stat.mtime.toTemporalInstant(), cutoff) < 0) {
      await fs.unlink(entryPath)
      purged++
    }
  }
  return purged
}
