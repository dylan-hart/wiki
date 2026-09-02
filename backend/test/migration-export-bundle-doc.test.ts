// Regression test for docs/migration/2.5x-export-bundle-format.md. Lives here rather than next to
// the doc because npm run test's '**/*.test.ts' glob only resolves inside this workspace.
//
// It statically parses the vendored export-implementation sources under vendor/export-bundle/
// (unmodified copies of the real resolver/core-service files from requarks/wiki) and asserts that
// every file name, batch-size limit, and entity switch-case they define is actually mentioned in the
// doc — so a future edit that drops a fact from the doc, or a future upstream change to the vendored
// source, fails loudly instead of silently going stale.
//
// This does not need a database or network access at test time: the vendored .js files are read as
// plain text and never executed (they use CommonJS `module.exports`, which we never import/run).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATION_DOCS_DIR = join(HERE, '..', '..', 'docs', 'migration')
const VENDOR_DIR = join(MIGRATION_DOCS_DIR, 'vendor', 'export-bundle')
const CORE_SYSTEM_PATH = join(VENDOR_DIR, 'core-system.js')
const RESOLVERS_SYSTEM_PATH = join(VENDOR_DIR, 'graph-resolvers-system.js')
const DOC_PATH = join(MIGRATION_DOCS_DIR, '2.5x-export-bundle-format.md')

const coreSystemSrc = readFileSync(CORE_SYSTEM_PATH, 'utf8')
const resolversSrc = readFileSync(RESOLVERS_SYSTEM_PATH, 'utf8')
const doc = readFileSync(DOC_PATH, 'utf8')

/** Every `path.join(opts.path, '<name>')` literal in core-system.js — the on-disk output files. */
function extractOutputFileNames(src: string) {
  return [...src.matchAll(/path\.join\(opts\.path,\s*'([^']+)'\)/g)].map((m) => m[1])
}

/** Every `case '<entity>':` label in the export() switch — the selectable export entities. */
function extractEntityCases(src: string) {
  return [...src.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1])
}

/** Every `.limit(<n>)` numeric batch size used by a paginated export loop. */
function extractBatchLimits(src: string) {
  return [...new Set([...src.matchAll(/\.limit\((\d+)\)/g)].map((m) => m[1]))]
}

describe('docs/migration/2.5x-export-bundle-format.md', () => {
  it('documents every on-disk output file name produced by WIKI.system.export()', () => {
    const files = extractOutputFileNames(coreSystemSrc)
    assert.ok(files.length > 0, 'expected to find output file names in vendored core-system.js')
    const missing = files.filter((f) => !doc.includes(f))
    assert.deepEqual(missing, [], `file names missing from the doc: ${missing.join(', ')}`)
  })

  it('documents every selectable export entity (switch-case label)', () => {
    const entities = extractEntityCases(coreSystemSrc)
    assert.deepEqual(entities, [
      'assets',
      'comments',
      'groups',
      'history',
      'navigation',
      'pages',
      'settings',
      'users'
    ])
    const missing = entities.filter((e) => !new RegExp(`\\b${e}\\b`).test(doc))
    assert.deepEqual(missing, [], `entities missing from the doc: ${missing.join(', ')}`)
  })

  it('documents every batch-size limit used by a paginated export loop', () => {
    const limits = extractBatchLimits(coreSystemSrc)
    assert.deepEqual(limits.sort(), ['10', '50'])
    for (const n of limits) {
      assert.ok(doc.includes(n), `batch size ${n} not mentioned in the doc`)
    }
  })

  it('confirms no archive library is used and the doc says so', () => {
    const archiveLibRe = /require\(\s*['"](tar|archiver|adm-zip|zip-stream|yazl|node-7z)['"]/i
    assert.equal(
      archiveLibRe.test(coreSystemSrc) || archiveLibRe.test(resolversSrc),
      false,
      'vendored source now requires an archive library - the "no tar/zip wrapper" doc claim needs review'
    )
    assert.match(doc.toLowerCase(), /no (top-level )?(tar|zip|archive)/)
  })

  it('documents the exportStatus fields returned by the exportStatus resolver', () => {
    // Fields the resolver actually reads off WIKI.system.exportStatus and returns to the client.
    for (const field of ['status', 'progress', 'message', 'startedAt']) {
      assert.ok(doc.includes(field), `exportStatus field "${field}" not mentioned in the doc`)
    }
  })

  it('documents the raw assets/{folderPath}/{filename} layout', () => {
    assert.match(doc, /assets\/\{folderPath\}\/\{filename\}/)
  })
})
