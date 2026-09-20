/**
 * One walker for every structural scanner: two scanners walking the tree slightly differently is
 * exactly how two "the same scan" tests end up disagreeing about what the repo contains.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface ListSourceFilesOptions {
  /** Suffix match, dot included (`['.ts', '.vue']`); omit for every file. */
  ext?: string[]
  /** File-name suffixes to leave out (`['.test.ts', '.generated.js']`). */
  skip?: string[]
  /** Directory names to skip anywhere in the tree, not just at the root. */
  skipDirs?: string[]
}

const DEFAULT_SKIP_DIRS = ['node_modules', 'compiled']

/** Absolute paths, in directory-entry order — not sorted. */
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
