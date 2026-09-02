import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { listSourceFiles } from './sourceFiles.ts'

/**
 * Drift check for the "## TODO/FIXME audit" section of docs/variances.md (task #780, section added
 * by #959; made bidirectional, bounded, and closed over its marker vocabulary by #1951).
 *
 * backend/test/docs-todo-fixme-audit.test.ts locks down one specific, durable outcome of the original
 * audit pass, but it hard-codes what it checks, so it cannot notice a marker the audit never looked
 * at in the first place. This test is the "re-run the grep before trusting this list" instruction
 * automated: it walks backend/ and frontend/src/ for TODO/FIXME markers and fails if any file
 * carrying one isn't named anywhere in the audit section -- and, the other direction, fails if a
 * bullet names a file that no longer actually carries one (a stale entry is exactly as much drift as
 * a missing one).
 *
 * Deliberately checks by file path, not file:line: line numbers shift on unrelated edits to the same
 * file, which would make this test flake on changes it doesn't care about. A new marker landing in a
 * file the audit already discusses still wants a human read, but re-flagging every whitespace-shifted
 * line number would be noise, not signal.
 *
 * Was docs/todo-fixme-drift.test.mjs, unrun by anything (OpenProject #959) and failing (the audit
 * section didn't exist yet). Moved into backend/, logic unchanged, so `npm run test` actually runs
 * it -- this file is exactly the kind of drift-guard suite CLAUDE.md's own "TODO/FIXME audit" note
 * points at, so it belongs where the thing it guards against (a scoped, narrow-cast marker going
 * unreviewed) actually gets caught. Moved again, into backend/test/, by #1949, alongside its
 * `docs-*.test.ts` / `localazy-config.test.ts` siblings -- see CLAUDE.md's "Testing (backend)"
 * section for the co-located-test-fixture rule this falls under.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const variancesPath = path.join(REPO_ROOT, 'docs', 'variances.md')

const MARKER = /\b(TODO|FIXME)\b/

// Matches this task's stated scope: "under backend/ and frontend/src/".
const SCAN_ROOTS = ['backend', 'frontend/src']

// Test files that talk *about* markers in prose/regex (this file included) aren't markers to
// classify themselves; generated bundles are machine output, not something to triage by hand.
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.mjs', '.generated.js']

function findMarkerFiles(): string[] {
  const files = new Set<string>()
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root)
    for (const file of listSourceFiles(absRoot, { skip: SKIP_FILE_SUFFIXES })) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (MARKER.test(content)) {
        files.add(path.relative(REPO_ROOT, file))
      }
    }
  }
  return [...files].sort()
}

// The audit section's own bullet list of marker-carrying files, so the reverse direction (a bullet
// naming a file that no longer carries a marker) can be checked as well as the forward one. Each
// entry looks like `- **`path/to/file.ts`** (TODO) -- ...`; later prose in the same section may
// mention a bare filename (`apiKeys.ts` below`) as a cross-reference rather than a file entry, so
// this only matches the bolded-backtick-path-at-bullet-start shape, not every backtick span.
const AUDIT_BULLET_FILE = /^- \*\*`([^`]+)`\*\*/gm

function findBulletedFiles(section: string): string[] {
  return [...section.matchAll(AUDIT_BULLET_FILE)].map((m) => m[1])
}

/**
 * Deferral-marker phrasings this codebase recognizes as deliberate, reviewed deferrals -- a
 * deliberately closed set, distinct from (and broader than) MARKER above, which exists only to
 * drive the TODO/FIXME-specific audit section by name. `backend/api/comments.ts`'s "FLAG FOR
 * FOLLOW-UP" deferral is a real, already-justified example of a marker MARKER can't see by
 * construction, simply because it isn't spelled TODO or FIXME. Rather than widen MARKER to match
 * that one extra phrase -- which would leave the *next* novel phrasing just as invisible, since an
 * open-ended regex can only ever match wording someone already thought to add -- this list is what
 * a match against the wider net below is checked against: anything the net catches that ISN'T in
 * this list fails the guard as unrecognized, rather than passing through unclassified.
 */
const KNOWN_DEFERRAL_MARKERS = ['TODO', 'FIXME', 'FLAG FOR FOLLOW-UP']

// Wide net of common deferral/flag-style code-comment conventions -- fixed (closed), not a
// catch-all, but wide enough that a differently-worded deferral (XXX, HACK, ...) is still caught and
// fails as unrecognized instead of silently never being scanned for in the first place.
const CANDIDATE_DEFERRAL_MARKER =
  /\b(TODO|FIXME|XXX|HACK|WONTFIX|NOCOMMIT|DEFERRED|FLAG FOR FOLLOW-UP)\b/g

function findUnrecognizedDeferralMarkers(content: string): string[] {
  const matches = content.match(CANDIDATE_DEFERRAL_MARKER) ?? []
  return [...new Set(matches)].filter((marker) => !KNOWN_DEFERRAL_MARKERS.includes(marker))
}

describe('docs/variances.md TODO/FIXME audit stays current', () => {
  const variances = readFileSync(variancesPath, 'utf8')
  const auditStart = variances.indexOf('## TODO/FIXME audit')

  test('variances.md has a TODO/FIXME audit section', () => {
    assert.notEqual(auditStart, -1, 'expected a "## TODO/FIXME audit" section')
  })

  // Bounded to the next "## " heading (or end of file, if this were the last section) -- otherwise
  // every later section's own unrelated prose can satisfy a mention, defeating the whole check. This
  // is exactly how a stale `frontend/src/layouts/AdminLayout.vue` bullet went unnoticed: that file
  // stopped carrying a marker, but the file's name still appears in a later, unrelated RTL section
  // (docs/variances.md's own "Feature 413" entry), which an unbounded `.slice(auditStart)` treated as
  // satisfying the audit-section mention.
  const auditEnd = auditStart === -1 ? -1 : variances.indexOf('\n## ', auditStart + 1)
  const auditSection =
    auditStart === -1
      ? ''
      : auditEnd === -1
        ? variances.slice(auditStart)
        : variances.slice(auditStart, auditEnd)

  test('every file with a TODO/FIXME marker under backend/ or frontend/src/ is named in the audit', () => {
    const markerFiles = findMarkerFiles()
    assert.ok(markerFiles.length > 0, 'expected at least one TODO/FIXME marker to audit against')

    const unmentioned = markerFiles.filter((file) => !auditSection.includes(file))
    assert.deepEqual(
      unmentioned,
      [],
      `these files carry a TODO/FIXME marker but aren't named in the audit section: ${unmentioned.join(', ')}`
    )
  })

  test('every file named in the audit still carries a TODO/FIXME marker', () => {
    const markerFiles = new Set(findMarkerFiles())
    const bulletedFiles = findBulletedFiles(auditSection)
    assert.ok(bulletedFiles.length > 0, 'expected at least one bulleted file entry to check')

    const stale = bulletedFiles.filter((file) => !markerFiles.has(file))
    assert.deepEqual(
      stale,
      [],
      `these files are named in the audit section but no longer carry a TODO/FIXME marker -- fix ` +
        `the entry or delete the bullet: ${stale.join(', ')}`
    )
  })
})

describe('deferral-marker vocabulary stays closed', () => {
  test('a phrasing outside the recognized vocabulary fails the guard', () => {
    const unrecognized = findUnrecognizedDeferralMarkers('// XXX: patch this up properly later')
    assert.deepEqual(unrecognized, ['XXX'])
  })

  test('recognized phrasings, including FLAG FOR FOLLOW-UP, are not flagged', () => {
    const unrecognized = findUnrecognizedDeferralMarkers(
      '// TODO: x\n// FIXME: y\n// FLAG FOR FOLLOW-UP: z'
    )
    assert.deepEqual(unrecognized, [])
  })

  test('no file under backend/ or frontend/src/ uses an unrecognized deferral phrasing', () => {
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      const absRoot = path.join(REPO_ROOT, root)
      for (const file of listSourceFiles(absRoot, { skip: SKIP_FILE_SUFFIXES })) {
        let content: string
        try {
          content = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        const unrecognized = findUnrecognizedDeferralMarkers(content)
        if (unrecognized.length > 0) {
          offenders.push(`${path.relative(REPO_ROOT, file)}: ${unrecognized.join(', ')}`)
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these files use an unrecognized deferral phrasing -- vet it and add it to ` +
        `KNOWN_DEFERRAL_MARKERS, or reword the comment: ${offenders.join('; ')}`
    )
  })
})
