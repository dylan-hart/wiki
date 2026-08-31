/**
 * Structural checks on `docs/operations.md` (task 1985).
 *
 * Two kinds of assertion here, mirroring `release-checklist-doc.test.ts`:
 *  - Structural: the doc actually covers the sections the task requires (backup scope, restore
 *    order, upgrade, troubleshooting) and names the real config keys/permissions it describes.
 *  - Drift guard: the `<dataPath>` subdirectories the doc claims a running instance populates are
 *    checked against the actual model source that writes to them, so the doc cannot silently go
 *    stale the moment a model starts (or stops) writing to a `<dataPath>` subdirectory it doesn't
 *    already mention.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const OPERATIONS_MD = path.join(REPO_ROOT, 'docs/operations.md')

/** `<dataPath>` subdirectory -> a backend source file that references it via `WIKI.config.dataPath`. */
const DATA_PATH_SUBDIRS: Record<string, string> = {
  locales: 'backend/models/locales.ts',
  'cache/icons': 'backend/models/icons.ts',
  'cache/files': 'backend/models/assets.ts',
  exports: 'backend/models/export.ts',
  imports: 'backend/models/siteImport.ts'
}

describe('docs/operations.md — operations reference', () => {
  test('exists', () => {
    assert.ok(fs.existsSync(OPERATIONS_MD), `expected ${OPERATIONS_MD} to exist`)
  })

  const raw = fs.readFileSync(OPERATIONS_MD, 'utf8')

  describe('dataPath subdirectories named in the doc are the ones the models actually write', () => {
    for (const [subdir, sourceFile] of Object.entries(DATA_PATH_SUBDIRS)) {
      test(`names <dataPath>/${subdir}, backed by a real reference in ${sourceFile}`, () => {
        assert.match(
          raw,
          new RegExp(subdir.replace('/', '\\/')),
          `docs/operations.md should mention <dataPath>/${subdir}`
        )

        const sourcePath = path.join(REPO_ROOT, sourceFile)
        assert.ok(fs.existsSync(sourcePath), `expected ${sourcePath} to exist`)
        const sourceRaw = fs.readFileSync(sourcePath, 'utf8')
        assert.match(
          sourceRaw,
          /WIKI\.config\.dataPath/,
          `${sourceFile} should still resolve a path under WIKI.config.dataPath — ` +
            'if this model stopped writing under <dataPath>, the doc entry above is stale'
        )
        assert.match(
          sourceRaw,
          new RegExp(subdir.split('/').pop()!),
          `${sourceFile} should still reference '${subdir}' — if the subdirectory name changed, ` +
            'update docs/operations.md to match'
        )
      })
    }

    test('does not claim any dataPath subdirectory beyond the ones models actually populate', () => {
      // Every fenced-off dataPath subdir row in the backup-scope table should be one of the known
      // ones above -- this guards against a stale/renamed entry sneaking back in.
      const tableRowPattern = /`<dataPath>\/([a-z/]+)`/g
      const mentioned = new Set<string>()
      let match: RegExpExecArray | null
      while ((match = tableRowPattern.exec(raw)) !== null) {
        mentioned.add(match[1]!.replace(/\/$/, ''))
      }
      for (const subdir of mentioned) {
        assert.ok(
          Object.keys(DATA_PATH_SUBDIRS).includes(subdir),
          `docs/operations.md references <dataPath>/${subdir}, which is not a known model-backed ` +
            'subdirectory -- either a real one is missing from DATA_PATH_SUBDIRS above, or the doc ' +
            "has a stale/typo'd path"
        )
      }
    })
  })

  describe('backup scope', () => {
    test('covers the Postgres schema / db.schema config key', () => {
      assert.match(raw, /db\.schema/)
      assert.match(raw, /pg_dump/)
    })

    test('covers uploaded asset bytes living in the database, not just on disk', () => {
      assert.match(raw, /bytea/)
      assert.match(raw, /assets\.data/)
    })

    test('covers the API-key signing keypair and session secret in the settings table', () => {
      assert.match(raw, /auth\.certs/)
      assert.match(raw, /auth\.secret/)
    })

    test('covers config.yml as part of the backup', () => {
      assert.match(raw, /config\.yml/)
    })

    test('explains that sideloaded locale strings are captured by a DB-only backup, but source JSON is not', () => {
      assert.match(raw, /sideloadFromDataPath/)
    })

    test('excludes external storage targets (disk/git/sftp/s3/etc.) from scope', () => {
      assert.match(raw, /out of scope/i)
    })
  })

  test('states a restore order', () => {
    assert.match(raw, /## Restore order/)
  })

  describe('upgrade procedure', () => {
    test('states migrations run automatically at boot', () => {
      assert.match(raw, /automatically at boot/i)
    })

    test('tells the operator to back up first', () => {
      assert.match(raw, /[Bb]ack up first/)
    })

    test('warns to scale to a single replica until a migration lock exists', () => {
      assert.match(raw, /single replica/i)
      assert.match(raw, /advisory lock/i)
    })

    test('warns that regenerating certificates invalidates every API key on every instance', () => {
      assert.match(raw, /every API key/i)
      assert.match(raw, /\/certificates/)
    })

    test('cross-references the 2.5.x migration runbook as a distinct procedure', () => {
      assert.match(raw, /migration\/migration-runbook\.md/)
    })
  })

  describe('metrics and logs', () => {
    test('documents what /metrics exposes and its permission gate', () => {
      assert.match(raw, /\/metrics/)
      assert.match(raw, /manage:system/)
    })

    test('states there is no log file, and where the in-app log terminal is', () => {
      assert.match(raw, /no log/i)
      assert.match(raw, /[Tt]erminal/)
    })
  })

  test('documents the container volume mount', () => {
    assert.match(raw, /VOLUME/)
    assert.match(raw, /\/wiki\/data\/content/)
  })

  describe('troubleshooting', () => {
    test('covers the unknownsite redirect', () => {
      assert.match(raw, /unknownsite/)
    })

    test('covers the frontend-not-built 503', () => {
      assert.match(raw, /frontend has not been built yet/)
    })

    test('covers jobs stuck active via staleJobTimeout', () => {
      assert.match(raw, /staleJobTimeout/)
    })
  })
})

describe('README.md links docs/operations.md', () => {
  const readmeRaw = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')

  test('links docs/operations.md', () => {
    assert.match(readmeRaw, /docs\/operations\.md/)
  })

  test('links docs/ generally', () => {
    assert.match(readmeRaw, /\]\(docs\)/)
  })

  test('links CLAUDE.md', () => {
    assert.match(readmeRaw, /\]\(CLAUDE\.md\)/)
  })
})
