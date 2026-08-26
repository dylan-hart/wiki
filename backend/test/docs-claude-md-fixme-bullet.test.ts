import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Drift check for CLAUDE.md's "Pre-existing bugs are preserved, not fixed" bullet (task #782).
 *
 * That bullet used to tell readers to search `FIXME:` under `backend/` "for the list — they are
 * genuine open bugs, not type-checker noise." All four of those original markers were fixed
 * independently and their `FIXME:` comments removed with them, which left the bullet pointing at a
 * "list" that briefly did not exist. This test is that grep, automated, checked against what the
 * bullet actually claims -- so a future change adding or removing a preserved-bug FIXME has to
 * reconcile the bullet's wording rather than let it go stale again either direction.
 *
 * Was docs/claude-md-fixme-bullet.test.mjs, unrun by anything (OpenProject #959). Moved into
 * backend/, logic unchanged, so `npm run test` actually runs it.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const claudeMdPath = path.join(REPO_ROOT, 'CLAUDE.md')
const backendDir = path.join(REPO_ROOT, 'backend')

const SKIP_DIR_NAMES = new Set(['node_modules', 'compiled'])
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.mjs']

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue
      walk(full, out)
    } else if (st.isFile()) {
      if (SKIP_FILE_SUFFIXES.some((suf) => entry.endsWith(suf))) continue
      out.push(full)
    }
  }
  return out
}

function countBackendFixmeMarkers(): number {
  let count = 0
  for (const file of walk(backendDir, [])) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const matches = content.match(/FIXME:/g)
    if (matches) count += matches.length
  }
  return count
}

function extractBullet(claudeMd: string): string | null {
  const start = claudeMd.indexOf('**Pre-existing bugs are preserved, not fixed')
  if (start === -1) return null
  // Bullet runs from its own "- **" marker to the next top-level "- **" bullet or heading.
  const bulletStart = claudeMd.lastIndexOf('\n-', start)
  const rest = claudeMd.slice(start)
  const nextBulletOffset = rest.search(/\n- \*\*|\n##/)
  const bulletEnd = nextBulletOffset === -1 ? claudeMd.length : start + nextBulletOffset
  return claudeMd.slice(bulletStart, bulletEnd)
}

describe("CLAUDE.md's FIXME-preservation bullet stays honest about backend/'s actual markers", () => {
  const claudeMd = readFileSync(claudeMdPath, 'utf8')
  const bulletRaw = extractBullet(claudeMd)
  // Markdown hard-wraps prose across lines, so a phrase like "for the list" can have a
  // newline+indentation in the middle of it. Normalize whitespace before matching phrases.
  const bullet = bulletRaw === null ? null : bulletRaw.replace(/\s+/g, ' ')
  const backendFixmeCount = countBackendFixmeMarkers()

  test('the "Pre-existing bugs are preserved, not fixed" bullet still exists', () => {
    assert.ok(bullet, 'expected to find the pre-existing-bugs bullet in CLAUDE.md')
  })

  test('bullet still describes the narrow-cast-plus-FIXME-comment convention for future migrations', () => {
    assert.match(bullet!, /narrow cast/i)
    assert.match(bullet!, /FIXME:/)
  })

  test('bullet does not claim a searchable FIXME "list" exists under backend/ when none does', () => {
    if (backendFixmeCount === 0) {
      assert.doesNotMatch(
        bullet!,
        /for the list/i,
        `backend/ currently has zero FIXME: markers, but the bullet still points readers at ` +
          `"the list" to search for — that claim is stale and must be trimmed`
      )
    } else {
      // If markers do exist, the bullet pointing readers at them is accurate again.
      assert.match(bullet!, /FIXME:/)
    }
  })
})
