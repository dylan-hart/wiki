// Drift check for CLAUDE.md's "Pre-existing bugs are preserved, not fixed" bullet (task #782).
//
// That bullet used to tell readers to "Search `FIXME:` under `backend/` for the list — they are
// genuine open bugs, not type-checker noise." Four of those markers (`sites.ts`'s
// `req.querystring.strict`, `config.ts`'s `Promise.trim()`, and two in `scheduler.ts`) were the
// ones sibling feature #422 exists to close — but this branch fixed the same bugs independently
// while standing up its own test infrastructure (commit c608b179), which also deleted their
// `FIXME:` comments. See docs/variances.md's "## TODO/FIXME audit" section for the full account.
//
// That leaves the bullet pointing at a "list" that, as of this branch, does not exist: grep
// `backend/` for `FIXME:` and nothing comes back. This test is that grep, automated, checked
// against what the bullet actually claims — so if a future change adds a new preserved-bug FIXME
// (or removes the last one, as already happened here), the bullet's wording has to be reconciled
// rather than silently going stale again.
//
// Run directly:
//   node --test docs/claude-md-fixme-bullet.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const docsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(docsDir, '..')
const claudeMdPath = path.join(repoRoot, 'CLAUDE.md')
const backendDir = path.join(repoRoot, 'backend')

const SKIP_DIR_NAMES = new Set(['node_modules', 'compiled'])
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.mjs']

function walk(dir, out) {
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

function countBackendFixmeMarkers() {
  let count = 0
  for (const file of walk(backendDir, [])) {
    let content
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

function extractBullet(claudeMd) {
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
    assert.match(bullet, /narrow cast/i)
    assert.match(bullet, /FIXME:/)
  })

  test('bullet does not claim a searchable FIXME "list" exists under backend/ when none does', () => {
    if (backendFixmeCount === 0) {
      assert.doesNotMatch(
        bullet,
        /for the list/i,
        `backend/ currently has zero FIXME: markers, but the bullet still points readers at ` +
          `"the list" to search for — that claim is stale and must be trimmed`
      )
    } else {
      // If markers do exist, the bullet pointing readers at them is accurate again.
      assert.match(bullet, /FIXME:/)
    }
  })
})
