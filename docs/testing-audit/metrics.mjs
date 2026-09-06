#!/usr/bin/env node
//
// Objective numbers for the test-value audit (OpenProject Feature #2602).
//
// This script produces COUNTS ONLY. It does not classify anything: the category and the reason in
// `backend.md` / `frontend.md` are a human judgement, which is the whole point of the audit and is
// explicitly out of scope for a heuristic (see Feature #2602's resolved scope).
//
// Deliberately outside every workspace: a file under `backend/` would be picked up by that
// workspace's `oxlint` / `oxfmt` / `tsc` and would sit in the middle of the tree the pruning pass
// (#2690) is about to act on. It is also deliberately NOT wired into any `npm run` script — this is
// evidence-gathering, not a gate.
//
// Run from the repository root:
//
//   node docs/testing-audit/metrics.mjs            # human-readable summary
//   node docs/testing-audit/metrics.mjs --tsv      # one row per test file, tab-separated
//
// The committed output of the plain form is `backend-metrics.txt`, beside this file.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// The enumeration the audit documents are written against. The `-not -path '*/node_modules/*'`
// predicate below is load-bearing: without it the same glob returns 709 files for `backend/`,
// counting vendored dependencies' own suites.
const WORKSPACES = {
  backend: { root: 'backend', ext: '.test.ts', sourceExts: ['.ts'] },
  frontend: {
    root: 'frontend/src',
    ext: '.test.js',
    extraRoots: ['frontend/test'],
    sourceExts: ['.js', '.vue']
  },
  blocks: { root: 'blocks', ext: '.test.js', sourceExts: ['.js'] },
  // No source tree of its own: an e2e spec's "source" is the whole built stack.
  e2e: { root: 'e2e/tests', ext: '.spec.js', sourceExts: [] }
}

function findTestFiles(root, ext) {
  const out = execFileSync(
    'find',
    [root, '-name', `*${ext}`, '-not', '-path', '*/node_modules/*'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  return out.trim() ? out.trim().split('\n').sort() : []
}

function findSourceFiles(root, exts, testExt) {
  const files = exts.flatMap((ext) => {
    const out = execFileSync(
      'find',
      [root, '-name', `*${ext}`, '-not', '-path', '*/node_modules/*'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    return out.trim() ? out.trim().split('\n') : []
  })
  return files.filter((f) => !f.endsWith(testExt) && !f.endsWith('.d.ts'))
}

function loc(file) {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8').split('\n').length
}

/** Per-file facts. Every one of these is mechanical — none of them is a category. */
function factsFor(file) {
  const src = readFileSync(path.join(REPO_ROOT, file), 'utf8')
  return {
    file,
    loc: src.split('\n').length,
    // `test(` / `it(` at the start of a line: close enough for a magnitude, and it does not try to
    // resolve `describe.each` expansion.
    cases: (src.match(/^\s*(?:test|it)\(/gm) || []).length,
    // A REAL call, not a mention inside a comment.
    dbBacked: /^[^*/]*\bsetupTestDb\(/m.test(src) || /\bdbAvailable\b/.test(src),
    dbSuffixed: file.endsWith('.db.test.ts'),
    // Any `{ skip: !… }` gate — the suite silently reports skipped without the precondition.
    envGated: /\bskip:\s*!/.test(src),
    bootsFastify: /buildTestApp|createRecordingApp/.test(src),
    // Reads a file outside its own workspace: a docs/CI/lockfile consistency scan.
    scansRepoFiles: /REPO_ROOT|\.\.\/\.\.\/docs|\.github\/workflows|package-lock\.json/.test(src)
  }
}

function summarize(name, spec) {
  const roots = [spec.root, ...(spec.extraRoots ?? [])]
  const tests = roots.flatMap((r) => findTestFiles(r, spec.ext)).sort()
  const sources = findSourceFiles(spec.root, spec.sourceExts, spec.ext)
  const facts = tests.map(factsFor)
  return {
    name,
    files: tests.length,
    testLoc: facts.reduce((a, f) => a + f.loc, 0),
    cases: facts.reduce((a, f) => a + f.cases, 0),
    sourceFiles: sources.length,
    sourceLoc: sources.reduce((a, f) => a + loc(f), 0),
    dbBacked: facts.filter((f) => f.dbBacked).length,
    dbSuffixed: facts.filter((f) => f.dbSuffixed).length,
    envGated: facts.filter((f) => f.envGated).length,
    bootsFastify: facts.filter((f) => f.bootsFastify).length,
    scansRepoFiles: facts.filter((f) => f.scansRepoFiles).length,
    facts
  }
}

const asTsv = process.argv.includes('--tsv')
const only = process.argv.find((a) => Object.hasOwn(WORKSPACES, a))
const wanted = only ? { [only]: WORKSPACES[only] } : WORKSPACES

if (asTsv) {
  console.log(
    ['path', 'loc', 'cases', 'dbBacked', 'envGated', 'bootsFastify', 'scansRepoFiles'].join('\t')
  )
  for (const [name, spec] of Object.entries(wanted)) {
    for (const f of summarize(name, spec).facts) {
      console.log(
        [f.file, f.loc, f.cases, f.dbBacked, f.envGated, f.bootsFastify, f.scansRepoFiles].join(
          '\t'
        )
      )
    }
  }
} else {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  }).trim()
  console.log(`commit: ${sha}`)
  console.log('')
  for (const [name, spec] of Object.entries(wanted)) {
    const s = summarize(name, spec)
    console.log(`## ${s.name}`)
    console.log(`  test files                 ${s.files}`)
    console.log(`  test LOC                   ${s.testLoc}`)
    console.log(`  test cases (test|it)       ${s.cases}`)
    console.log(`  source files               ${s.sourceFiles || '—'}`)
    console.log(`  source LOC                 ${s.sourceLoc || '—'}`)
    console.log(
      `  test LOC / source LOC      ${s.sourceLoc ? (s.testLoc / s.sourceLoc).toFixed(2) : '—'}`
    )
    console.log(`  DB-backed suites           ${s.dbBacked}`)
    console.log(`  ...named *.db.test.*       ${s.dbSuffixed}`)
    console.log(`  suites behind a skip gate  ${s.envGated}`)
    console.log(`  suites booting Fastify     ${s.bootsFastify}`)
    console.log(`  suites scanning repo files ${s.scansRepoFiles}`)
    console.log('')
  }
}
