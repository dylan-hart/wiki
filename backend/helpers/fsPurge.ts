import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * A missing directory is not a failure — nothing has been written there yet — so it counts as zero;
 * anything else `readdir` refuses is rethrown.
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
