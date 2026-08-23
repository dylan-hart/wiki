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
 * automated: it walks backend/ and frontend/src/ for TODO/FIXME markers and fails if any file
 * carrying one isn't named anywhere in the audit section.
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
 * unreviewed) actually gets caught.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const variancesPath = path.join(REPO_ROOT, 'docs', 'variances.md')

const MARKER = /\b(TODO|FIXME)\b/

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

function findMarkerFiles(): string[] {
  const files = new Set<string>()
  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root)
    for (const file of walk(absRoot, [])) {
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

describe('docs/variances.md TODO/FIXME audit stays current', () => {
  const variances = readFileSync(variancesPath, 'utf8')
  const auditStart = variances.indexOf('## TODO/FIXME audit')

  test('variances.md has a TODO/FIXME audit section', () => {
    assert.notEqual(auditStart, -1, 'expected a "## TODO/FIXME audit" section')
  })

  const auditSection = auditStart === -1 ? '' : variances.slice(auditStart)

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
})
