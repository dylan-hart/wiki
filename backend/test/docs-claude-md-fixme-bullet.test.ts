import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { listSourceFiles } from './sourceFiles.ts'

import { GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from '../helpers/permissions.ts'
import { SITE_PERMISSIONS } from '../helpers/siteRules.ts'

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
 *
 * Also carries a second drift check (OpenProject #1961), added once a real drift was found between
 * CLAUDE.md's Permissions section and `helpers/permissions.ts`/`helpers/siteRules.ts`: the three
 * enumerated lists there (global, page-rule, site-scoped) are asserted as sets against
 * `GLOBAL_PERMISSIONS`, `PAGE_PERMISSIONS` and `SITE_PERMISSIONS`, so adding a permission to either
 * constant without updating CLAUDE.md now fails `npm run test` instead of silently going stale.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const claudeMdPath = path.join(REPO_ROOT, 'CLAUDE.md')
const backendDir = path.join(REPO_ROOT, 'backend')

const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.mjs']

function countBackendFixmeMarkers(): number {
  let count = 0
  for (const file of listSourceFiles(backendDir, { skip: SKIP_FILE_SUFFIXES })) {
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

/**
 * Extracts the backtick-quoted permission tokens between two anchor phrases in CLAUDE.md's
 * "Permissions" section, e.g. the text right after "**Global permissions**" up to the prose that
 * names the backing constant. Bounding the slice before that parenthetical is what keeps the
 * constant's own name (`PAGE_PERMISSIONS`, `SITE_PERMISSIONS`, `GroupEditOverlay.vue`, …) out of the
 * extracted token list -- only the enumerated permission strings sit between the two anchors.
 */
function extractPermissionList(claudeMd: string, startAnchor: string, endAnchor: string): string[] {
  const start = claudeMd.indexOf(startAnchor)
  assert.notStrictEqual(start, -1, `expected to find "${startAnchor}" in CLAUDE.md`)
  const end = claudeMd.indexOf(endAnchor, start)
  assert.notStrictEqual(
    end,
    -1,
    `expected to find "${endAnchor}" in CLAUDE.md after "${startAnchor}"`
  )
  const slice = claudeMd.slice(start, end)
  return [...slice.matchAll(/`([a-z][\w-]*:[\w-]+)`/g)].map((m) => m[1])
}

describe("CLAUDE.md's three permission lists stay in sync with the backend constants", () => {
  const claudeMd = readFileSync(claudeMdPath, 'utf8')

  test('global permissions list matches GLOBAL_PERMISSIONS (helpers/permissions.ts)', () => {
    const listed = extractPermissionList(
      claudeMd,
      '**Global permissions** are held site-wide',
      '. That list is the whole of it'
    )
    assert.deepStrictEqual(new Set(listed), new Set(GLOBAL_PERMISSIONS))
  })

  test('page rule permissions list matches PAGE_PERMISSIONS (helpers/permissions.ts)', () => {
    const listed = extractPermissionList(
      claudeMd,
      '**Page rule permissions** are bound to paths',
      '(`PAGE_PERMISSIONS`'
    )
    assert.deepStrictEqual(new Set(listed), new Set(PAGE_PERMISSIONS))
  })

  test('site-scoped delegation permissions list matches SITE_PERMISSIONS (helpers/siteRules.ts)', () => {
    const listed = extractPermissionList(
      claudeMd,
      '**Site-scoped delegation permissions** are bound to a site',
      '(`SITE_PERMISSIONS`'
    )
    assert.deepStrictEqual(new Set(listed), new Set(SITE_PERMISSIONS))
  })
})

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
