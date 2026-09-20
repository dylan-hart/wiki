import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sorted, so a scanner's failure message names the same file first on every machine regardless of
 * readdir order.
 */
export function listSourceFiles(root, { ext = ['.vue', '.js'], skip = [] } = {}) {
  const rejects =
    typeof skip === 'function' ? skip : (full) => skip.some((fragment) => full.includes(fragment))
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (rejects(full)) continue
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full, { ext, skip }))
    } else if (ext.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(full)
    }
  }
  return out.sort()
}
