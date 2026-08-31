/**
 * Structural checks on `docs/operations.md` (Feature #1900, part of Epic #1892).
 *
 * Mirrors the style of `release-checklist-doc.test.ts` / `releasing-doc.test.ts`: the document
 * exists, is linked from `README.md`, and names the real `dataPath` subdirectories the models
 * actually write (`locales`, `cache/icons`, `cache/files`, `exports`, `imports`) so this doc
 * cannot silently drift from the code the moment one of those writers' paths changes.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const OPERATIONS_MD = path.join(REPO_ROOT, 'docs/operations.md')
const README_MD = path.join(REPO_ROOT, 'README.md')

/** The five `dataPath` subdirectories the models actually write, and the file/line writing them. */
const DATA_PATH_WRITERS: Array<{ subdir: string; file: string }> = [
  { subdir: 'locales', file: 'models/locales.ts' },
  { subdir: 'cache/icons', file: 'models/icons.ts' },
  { subdir: 'cache/files', file: 'models/assets.ts' },
  { subdir: 'exports', file: 'models/export.ts' },
  { subdir: 'imports', file: 'models/siteImport.ts' }
]

describe('docs/operations.md — backup/restore and container mounts', () => {
  test('exists', () => {
    assert.ok(fs.existsSync(OPERATIONS_MD), `expected ${OPERATIONS_MD} to exist`)
  })

  const raw = fs.readFileSync(OPERATIONS_MD, 'utf8')

  test('is linked from README.md', () => {
    const readme = fs.readFileSync(README_MD, 'utf8')
    assert.match(readme, /docs\/operations\.md/, 'README.md should link to docs/operations.md')
  })

  test('states the two-source backup scope: Postgres plus the dataPath volume', () => {
    assert.match(raw, /postgres/i)
    assert.match(raw, /pg_dump/)
    assert.match(raw, /dataPath/)
    assert.match(raw, /config\.yml/)
  })

  test('does not call the content export a backup', () => {
    assert.match(
      raw,
      /not.{0,80}(what|instance)?\s*backup/i,
      'the document should explicitly distinguish the content export from an instance backup'
    )
  })

  test('describes a restore order', () => {
    assert.match(raw, /restore order/i)
  })

  test('names the required container mount as /wiki/data', () => {
    assert.match(raw, /\/wiki\/data\b/)
  })

  for (const { subdir, file } of DATA_PATH_WRITERS) {
    test(`names the "${subdir}" dataPath subdirectory (written by ${file})`, () => {
      assert.match(
        raw,
        new RegExp(subdir.replace('/', '\\/')),
        `expected docs/operations.md to name the "${subdir}" subdirectory, written by ${file}`
      )
    })
  }

  test('cross-references docs/offline-deployment.md for locale sideloading', () => {
    assert.match(raw, /docs\/offline-deployment\.md/)
  })

  test('sanity: every cited writer file actually exists', () => {
    for (const { file } of DATA_PATH_WRITERS) {
      const full = path.join(REPO_ROOT, 'backend', file)
      assert.ok(fs.existsSync(full), `expected ${full} to exist`)
    }
  })
})
