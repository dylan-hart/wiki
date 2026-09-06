/**
 * Structural checks on `docs/operations.md` (task 1985, folded together with Feature #1900 /
 * Epic #1892's earlier, narrower version of the same document during a branch merge).
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
  'cache/files': 'backend/models/assetServing.ts',
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

    test('does not call the content export a backup', () => {
      assert.match(
        raw,
        /not.{0,80}(what|instance)?\s*backup/i,
        'the document should explicitly distinguish the content export from an instance backup'
      )
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

    test('documents the line shape and the two rendered field keys', () => {
      assert.match(raw, /key=value/)
      // -> `ms` is humanised and `error` carries the Error itself; both are renderer behaviour an
      //    operator reads off the line, not call-site formatting.
      assert.match(raw, /in 528ms/)
      assert.match(raw, /error="/)
    })

    test('names all four levels and says what each one means', () => {
      const logsSection = raw.slice(raw.indexOf('## Logs'), raw.indexOf('## Metrics'))
      for (const level of ['error', 'warn', 'info', 'debug']) {
        assert.ok(
          logsSection.includes(`\`${level}\``),
          `expected the Logs section to cover \`${level}\``
        )
      }
    })

    test('the scope table lists every name in core/logScopes.ts, and no others', () => {
      const scopesSource = fs.readFileSync(
        path.join(REPO_ROOT, 'backend/core/logScopes.ts'),
        'utf8'
      )
      const declared = [...scopesSource.matchAll(/^ {2}'([a-z]+)',?$/gm)].map((m) => m[1])
      assert.ok(declared.length > 0, 'expected to parse the LOG_SCOPES array')

      // -> The Scopes subsection alone: the Levels table one heading above has the same row shape.
      const scopeTable = raw.slice(raw.indexOf('### Scopes'), raw.indexOf('### Configuration'))
      const documented = [...scopeTable.matchAll(/^\| `([a-z]+)` \| /gm)].map((m) => m[1])

      assert.deepEqual(
        [...documented].sort(),
        [...declared].sort(),
        'the scope table in docs/operations.md#logs must match backend/core/logScopes.ts exactly — ' +
          'a scope added there without a row here leaves an operator with an undocumented column value'
      )
    })

    test('documents logLevel, logFormat and logScopes as the three validated config keys', () => {
      assert.match(raw, /`logLevel`/)
      assert.match(raw, /`logFormat`/)
      assert.match(raw, /`logScopes`/)
      assert.match(raw, /`text`/)
      assert.match(raw, /`json`/)
    })

    test('presents logScopes as a live config key, not a planned one', () => {
      // -> The inverse of the assertion this replaced: per-scope thresholds landed in OpenProject
      //    #2663, so `base.yml` declaring the key is what makes the doc's claim true, and the doc
      //    must no longer read as forward-looking.
      const logsSection = raw.slice(raw.indexOf('## Logs'), raw.indexOf('## Metrics'))
      assert.ok(logsSection.includes('logScopes'), 'the Logs section must document logScopes')
      assert.doesNotMatch(
        logsSection,
        /logScopes[^.]*\bplanned\b|\bplanned\b[^.]*logScopes/i,
        'per-scope thresholds are implemented — the doc must not still call them planned'
      )

      const baseYml = fs.readFileSync(path.join(REPO_ROOT, 'backend/base.yml'), 'utf8')
      assert.match(
        baseYml,
        /^ {4}logScopes:/m,
        'docs/operations.md documents logScopes, so base.yml must declare it — otherwise ' +
          'core/config.ts#warnUnknownConfigKeys flags a documented key as unrecognized on every boot'
      )
    })

    test('documents the two admin flags as scope overrides rather than separate switches', () => {
      const logsSection = raw.slice(raw.indexOf('## Logs'), raw.indexOf('## Metrics'))
      assert.match(logsSection, /`sqlLog`/)
      assert.match(logsSection, /`authDebug`/)
      assert.match(
        logsSection,
        /no restart/i,
        'the point of the flags being thresholds is that they take effect without a restart'
      )
    })

    test('states the in-memory backlog size, matching BACKLOG_SIZE in core/logger.ts', () => {
      const loggerSource = fs.readFileSync(path.join(REPO_ROOT, 'backend/core/logger.ts'), 'utf8')
      const match = loggerSource.match(/BACKLOG_SIZE\s*=\s*(\d+)/)
      assert.ok(match, 'expected BACKLOG_SIZE to be declared in backend/core/logger.ts')
      assert.match(
        raw,
        new RegExp(`\\b${match![1]}\\b`),
        `docs/operations.md should state the real backlog size (${match![1]} lines)`
      )
    })

    test('describes the admin log websocket as carrying structured frames', () => {
      assert.match(raw, /_terminal\/logs/)
      assert.match(raw, /structured frame/i)
    })

    test('distinguishes the audit log from stdout logging', () => {
      assert.match(raw, /audit log/i)
      assert.match(raw, /auditLog\.ts/)
    })
  })

  describe('container mounts', () => {
    test('names the required container mount as /wiki/data', () => {
      assert.match(raw, /\/wiki\/data\b/)
    })

    test('documents the container VOLUME declaration', () => {
      assert.match(raw, /VOLUME/)
    })

    test('states the mount covers the whole of /wiki/data, not just content/', () => {
      // The image's VOLUME was deliberately widened from a content/-only mount (Epic #1892) --
      // the doc should say so, not describe the old, narrower shape.
      assert.match(raw, /whole of `?\/wiki\/data`?/i)
    })

    test('cross-references docs/offline-deployment.md for locale sideloading', () => {
      assert.match(raw, /docs\/offline-deployment\.md/)
    })

    test('sanity: every cited dataPath writer file actually exists', () => {
      for (const sourceFile of Object.values(DATA_PATH_SUBDIRS)) {
        const full = path.join(REPO_ROOT, sourceFile)
        assert.ok(fs.existsSync(full), `expected ${full} to exist`)
      }
    })
  })

  describe('disaster recovery: multi-site / multi-instance topology (OpenProject #2436)', () => {
    test('has the section', () => {
      assert.match(raw, /## Disaster recovery: multi-site \/ multi-instance topology/)
    })

    test('recommends Postgres streaming replication', () => {
      assert.match(raw, /streaming replication/i)
    })

    test('recommends an object-storage backend (s3\\/azure\\/gcs) for DR, not a filesystem-based one', () => {
      assert.match(raw, /object-storage backend/i)
      assert.match(raw, /`s3`, `azure` or `gcs`/)
    })

    test('names the bidirectional-file-sync hazard for the disk/git/sftp storage modules', () => {
      assert.match(raw, /bidirectional file-sync/i)
      assert.match(raw, /`disk`, `git`, or `sftp`/)
    })

    test('explains the git storage target corruption risk specifically', () => {
      assert.match(raw, /corrupt the\s+local repo state/i)
    })

    test('explains the silent asset divergence risk specifically', () => {
      assert.match(raw, /diverge/i)
    })

    test('cross-references the section from the See also list', () => {
      assert.match(raw, /#disaster-recovery-multi-site-multi-instance-topology/)
    })
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

describe('admin.utilities.exportExclusions hint references a real doc (OpenProject #2360)', () => {
  const LOCALES_EN = path.join(REPO_ROOT, 'backend/locales/en.json')
  const locales = JSON.parse(fs.readFileSync(LOCALES_EN, 'utf8'))
  const hint: string = locales['admin.utilities.exportExclusions']

  test('the hint string exists', () => {
    assert.ok(
      hint,
      'expected admin.utilities.exportExclusions to be defined in backend/locales/en.json'
    )
  })

  test('the doc path it names actually exists in the repo', () => {
    // Parse the referenced path out of the hint itself, rather than hardcoding
    // 'docs/operations.md' here -- a future edit that points the hint at a different (or
    // misspelled) path should fail this check, not silently pass because the assertion was
    // pinned to the string this test happened to be written against.
    const match = hint.match(/\bdocs\/[\w/-]+\.md\b/)
    assert.ok(
      match,
      `expected admin.utilities.exportExclusions to reference a docs/*.md path, got: "${hint}"`
    )

    const referencedDoc = path.join(REPO_ROOT, match![0])
    assert.ok(
      fs.existsSync(referencedDoc),
      `admin.utilities.exportExclusions references "${match![0]}", which does not exist -- ` +
        'the export-exclusions hint must not point admins at a nonexistent doc (OpenProject #2360)'
    )
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
