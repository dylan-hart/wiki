import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Drift check for the "## TODO/FIXME audit" section of docs/variances.md (task #780, section added
 * by #959).
 *
 * backend/docs-todo-fixme-audit.test.ts locks down one specific, durable outcome of the original
 * audit pass, but it hard-codes what it checks, so it cannot notice a marker the audit never looked
 * at in the first place. This test is the "re-run the grep before trusting this list" instruction
 * automated: it walks backend/ and frontend/src/ for TODO/FIXME/FLAG-FOR-FOLLOW-UP markers and fails
 * if any file carrying one isn't named anywhere in the audit section (task #1951 also added the
 * reverse direction: a bulleted file that no longer carries its marker fails too).
 *
 * Deliberately checks by file path, not file:line: line numbers shift on unrelated edits to the same
 * file, which would make this test flake on changes it doesn't care about. A new marker landing in a
 * file the audit already discusses still wants a human read, but re-flagging every whitespace-shifted
 * line number would be noise, not signal.
 *
 * Three defects task #1951 closed, all in one pass so the guard's diff reads as one coherent repair:
 *
 * 1. **One-directional.** The forward check alone can't notice a bullet whose marker is gone --
 *    `docs/variances.md` once carried a stale one for `frontend/src/layouts/AdminLayout.vue` for
 *    exactly this reason. A second assertion below re-scans every bulleted path and fails if its
 *    marker is gone, per the section's own "Resolved when" rule.
 * 2. **Unbounded section.** `auditSection` used to run from the `## TODO/FIXME audit` heading to the
 *    end of the file, silently swallowing every later, unrelated `## ` entry -- a mention 900 lines
 *    away in a different entry satisfied the check just as well as a real bullet. It is now bounded
 *    to the next `\n## ` heading, verified independently below.
 * 3. **Open marker vocabulary.** `MARKER` used to be `/\b(TODO|FIXME)\b/`, which can't see
 *    `backend/api/comments.ts`'s `FLAG FOR FOLLOW-UP` deferral. The vocabulary is now the *closed*
 *    `KNOWN_MARKERS` list, cross-checked against the wider `CANDIDATE_MARKER` pattern so a novel
 *    deferral phrasing (`HACK`, `XXX`, a bare `FOLLOW-UP`, ...) fails loudly instead of passing
 *    through unrecognized.
 *
 * Was docs/todo-fixme-drift.test.mjs, unrun by anything (OpenProject #959) and failing (the audit
 * section didn't exist yet). Moved into backend/, logic unchanged, so `npm run test` actually runs
 * it -- this file is exactly the kind of drift-guard suite CLAUDE.md's own "TODO/FIXME audit" note
 * points at, so it belongs where the thing it guards against (a scoped, narrow-cast marker going
 * unreviewed) actually gets caught.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const variancesPath = path.join(REPO_ROOT, 'docs', 'variances.md')

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Closed vocabulary: only these exact phrasings count as an audited deferral marker. Ordered
// longest-first, since `FLAG FOR FOLLOW-UP` must be matched whole rather than only its `FOLLOW-UP`
// tail once CANDIDATE_MARKER below is scanning for both.
const KNOWN_MARKERS = ['FLAG FOR FOLLOW-UP', 'TODO', 'FIXME']

const MARKER = new RegExp(`\\b(${KNOWN_MARKERS.map(escapeForRegex).join('|')})\\b`)

// Deliberately wider than KNOWN_MARKERS: a handful of other ALL-CAPS deferral idioms seen in the
// wild (`XXX`, `HACK`, a bare `FOLLOW-UP`, `DEFERRED`) that, if one ever lands unrecognized, should
// fail the "no unknown deferral phrasing" test below and ask a human to add it to KNOWN_MARKERS (and
// audit the file it's in) -- rather than pass silently the way an open-ended MARKER regex would have
// let `FLAG FOR FOLLOW-UP` do before task #1951. Matched case-sensitively and ALL-CAPS-only, same as
// KNOWN_MARKERS: the convention this repo actually follows is shouting the marker, and matching case-
// insensitively would flag ordinary English prose ("a follow-up email", "deferred until later") as
// if it were a deferral comment.
const CANDIDATE_PHRASES = [...KNOWN_MARKERS, 'FOLLOW-UP', 'XXX', 'HACK', 'DEFERRED']
const CANDIDATE_MARKER = new RegExp(
  `\\b(${CANDIDATE_PHRASES.map(escapeForRegex).join('|')})\\b`,
  'g'
)

function classifyMarkerPhrases(content: string): { known: string[]; unknown: string[] } {
  const matches = content.match(CANDIDATE_MARKER) ?? []
  const known: string[] = []
  const unknown: string[] = []
  for (const match of matches) {
    if (KNOWN_MARKERS.includes(match)) {
      known.push(match)
    } else {
      unknown.push(match)
    }
  }
  return { known, unknown }
}

// Matches this task's stated scope: "under backend/ and frontend/src/".
const SCAN_ROOTS = ['backend', 'frontend/src']

const SKIP_DIR_NAMES = new Set(['node_modules', 'compiled'])
// Test files that talk *about* markers in prose/regex (this file included) aren't markers to
// classify themselves; generated bundles are machine output, not something to triage by hand.
const SKIP_FILE_SUFFIXES = ['.test.ts', '.test.js', '.test.mjs', '.generated.js']

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

function scanTree(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root)
    for (const file of walk(absRoot, [])) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      files.push({ path: path.relative(REPO_ROOT, file), content })
    }
  }
  return files
}

function findMarkerFiles(): string[] {
  const files = new Set<string>()
  for (const file of scanTree()) {
    if (MARKER.test(file.content)) files.add(file.path)
  }
  return [...files].sort()
}

function extractBulletedFiles(section: string): string[] {
  return [...section.matchAll(/^- \*\*`([^`]+)`\*\*/gm)].map((m) => m[1])
}

describe('classifyMarkerPhrases (closed marker vocabulary)', () => {
  test('recognizes every phrasing in the closed vocabulary', () => {
    const { known, unknown } = classifyMarkerPhrases(
      '// TODO: fix this\n// FIXME: also this\n// FLAG FOR FOLLOW-UP: and this later'
    )
    assert.deepEqual(unknown, [])
    assert.deepEqual(
      known.map((m) => m.toUpperCase()),
      ['TODO', 'FIXME', 'FLAG FOR FOLLOW-UP']
    )
  })

  test('rejects a novel deferral phrasing outside the closed vocabulary', () => {
    const { known, unknown } = classifyMarkerPhrases('// HACK: quick and dirty, revisit later')
    assert.deepEqual(known, [])
    assert.deepEqual(unknown, ['HACK'])
  })
})

describe('docs/variances.md TODO/FIXME audit stays current', () => {
  const variances = readFileSync(variancesPath, 'utf8')
  const auditHeading = '## TODO/FIXME audit'
  const auditStart = variances.indexOf(auditHeading)

  test('variances.md has a TODO/FIXME audit section', () => {
    assert.notEqual(auditStart, -1, 'expected a "## TODO/FIXME audit" section')
  })

  // Bounded to the *next* "## " heading, not to end-of-file -- otherwise every later, unrelated
  // entry in the document is silently swallowed into "the audit section" and a filename mentioned
  // anywhere past this point would satisfy the check below with no real bullet backing it.
  const nextHeadingOffset =
    auditStart === -1 ? -1 : variances.indexOf('\n## ', auditStart + auditHeading.length)
  const auditSection =
    auditStart === -1
      ? ''
      : variances.slice(auditStart, nextHeadingOffset === -1 ? undefined : nextHeadingOffset)

  test('audit section is bounded to the next heading, not the rest of the document', () => {
    // Cross-checked independently of the slice above: enumerate every "## " heading offset in the
    // whole document and assert none of them fall inside auditSection except its own.
    const allHeadingOffsets = [...variances.matchAll(/\n## /g)].map((m) => m.index + 1)
    const otherHeadingsInSection = allHeadingOffsets.filter(
      (offset) => offset > auditStart && offset < auditStart + auditSection.length
    )
    assert.deepEqual(
      otherHeadingsInSection,
      [],
      'auditSection leaked past the next "## " heading and swallowed unrelated entries'
    )
  })

  test('every file with a TODO/FIXME/FLAG-FOR-FOLLOW-UP marker under backend/ or frontend/src/ is named in the audit', () => {
    const markerFiles = findMarkerFiles()
    assert.ok(markerFiles.length > 0, 'expected at least one TODO/FIXME marker to audit against')

    const unmentioned = markerFiles.filter((file) => !auditSection.includes(file))
    assert.deepEqual(
      unmentioned,
      [],
      `these files carry a TODO/FIXME/FLAG-FOR-FOLLOW-UP marker but aren't named in the audit section: ${unmentioned.join(', ')}`
    )
  })

  test('every file bulleted in the audit section still carries a recognized marker', () => {
    const bulletedFiles = extractBulletedFiles(auditSection)
    assert.ok(bulletedFiles.length > 0, 'expected at least one bulleted file in the audit section')

    const stale = bulletedFiles.filter((file) => {
      let content: string
      try {
        content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      } catch {
        return true // the file itself is gone -- definitely stale
      }
      return !MARKER.test(content)
    })
    assert.deepEqual(
      stale,
      [],
      `these files are bulleted in the audit section but no longer carry a recognized marker -- ` +
        `per the section's own "Resolved when" rule, remove their bullet: ${stale.join(', ')}`
    )
  })

  test('no file under backend/ or frontend/src/ uses a deferral phrasing outside the closed vocabulary', () => {
    const unrecognized: string[] = []
    for (const file of scanTree()) {
      const { unknown } = classifyMarkerPhrases(file.content)
      if (unknown.length > 0) {
        unrecognized.push(`${file.path}: ${[...new Set(unknown)].join(', ')}`)
      }
    }
    assert.deepEqual(
      unrecognized,
      [],
      `unrecognized deferral phrasing found -- add it to KNOWN_MARKERS in this file and bullet the ` +
        `file in docs/variances.md's audit section, or reword the comment: ${unrecognized.join('; ')}`
    )
  })
})
