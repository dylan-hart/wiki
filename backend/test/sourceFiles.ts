/**
 * The recursive source-file walker every structural scanner needs (TEST-F15).
 *
 * `test/docs-todo-fixme-drift.test.ts` and `test/docs-claude-md-fixme-bullet.test.ts` carried
 * identical copies of it, differing only in one skipped suffix — and a scanner that walks the tree
 * slightly differently from its neighbour is exactly how two "the same scan" tests end up disagreeing
 * about what the repo contains.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface ListSourceFilesOptions {
  /** Keep only files ending in one of these (e.g. `['.ts', '.vue']`). Omit for every file. */
  ext?: string[]
  /** File-name suffixes to leave out (e.g. `['.test.ts', '.generated.js']`). */
  skip?: string[]
  /** Directory names to skip anywhere in the tree. Defaults to build/dependency output. */
  skipDirs?: string[]
}

/** Machine output and dependencies — never something to scan as this repo's own source. */
const DEFAULT_SKIP_DIRS = ['node_modules', 'compiled']

/** Every file under `root`, recursively, as absolute paths in directory-entry order. */
export function listSourceFiles(root: string, opts: ListSourceFilesOptions = {}): string[] {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS)
  const out: string[] = []

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        if (skipDirs.has(entry)) {
          continue
        }
        walk(full)
      } else if (stat.isFile()) {
        if (opts.skip?.some((suffix) => entry.endsWith(suffix))) {
          continue
        }
        if (opts.ext && !opts.ext.some((suffix) => entry.endsWith(suffix))) {
          continue
        }
        out.push(full)
      }
    }
  }

  walk(root)
  return out
}
