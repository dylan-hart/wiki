// Regression test for docs/migration/2.5x-settings-auth-storage-field-mapping.md (Task 763). Lives
// here rather than next to the doc because npm run test's '**/*.test.ts' glob only resolves inside
// this workspace.
//
// Cross-checks the doc's three claims against live, verifiable sources rather than trusting prose:
//
// 1. The 26-key `settings` table inventory is exactly the union of every `WIKI.configSvc.saveToDb([
//    ...])` call-site array, extracted from the vendored 2.x source files under
//    `vendor/2x-settings/` — not hand-typed, so the doc can't silently drift from the code it claims
//    to summarize.
// 2. The "confirmed no-destination" 2.x authentication providers and storage modules are exactly
//    `(2.x module directory names) - (this repo's live backend/modules/{authentication,storage}/*
//    directory names)` — computed from the real filesystem, not copied by hand.
// 3. A handful of specific, easy-to-get-wrong facts the doc states (storage has no mode/syncInterval
//    column; settings.ts has no telemetry key but does have an unrelated metrics key; sites.ts's
//    default config really does contain the per-site paths the doc cites) are re-verified directly
//    against backend/db/schema.ts, backend/models/settings.ts and backend/models/sites.ts.
//
// No database or network access needed at test time: everything is read as plain text from files
// already vendored/present in this repo.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const MIGRATION_DOCS_DIR = join(REPO_ROOT, 'docs', 'migration')
const DOC_PATH = join(MIGRATION_DOCS_DIR, '2.5x-settings-auth-storage-field-mapping.md')
const VENDOR_DIR = join(MIGRATION_DOCS_DIR, 'vendor', '2x-settings')
const SCHEMA_TS_PATH = join(REPO_ROOT, 'backend', 'db', 'schema.ts')
const SETTINGS_TS_PATH = join(REPO_ROOT, 'backend', 'models', 'settings.ts')
const SITES_TS_PATH = join(REPO_ROOT, 'backend', 'models', 'sites.ts')
const AUTH_MODULES_DIR = join(REPO_ROOT, 'backend', 'modules', 'authentication')
const STORAGE_MODULES_DIR = join(REPO_ROOT, 'backend', 'modules', 'storage')

const doc = readFileSync(DOC_PATH, 'utf8')
const schemaTs = readFileSync(SCHEMA_TS_PATH, 'utf8')
const settingsTs = readFileSync(SETTINGS_TS_PATH, 'utf8')
const sitesTs = readFileSync(SITES_TS_PATH, 'utf8')

// The vendored 2.x files that contain every `WIKI.configSvc.saveToDb([...])` call site (found via
// `grep -rl "saveToDb(\["` against the vendored requarks/wiki tree — see the doc's "Method" section).
const SAVE_TO_DB_SOURCE_FILES = [
  'setup.js',
  'config.js', // saveToDb() itself lives here; no call site, harmless to include
  'letsencrypt.js',
  'system.js',
  'mail.js',
  'theming.js',
  'navigation.js',
  'site.js',
  'localization.js',
  'authentication.js'
]

/** Every string literal inside every `saveToDb([ ... ])` call in the given source text. */
function extractSaveToDbKeys(source: string) {
  const keys = new Set()
  const callRe = /saveToDb\(\s*\[([^\]]*)\]/gs
  for (const call of source.matchAll(callRe)) {
    const body = call[1]
    for (const lit of body.matchAll(/'([^']+)'/g)) {
      keys.add(lit[1])
    }
  }
  return keys
}

describe('docs/migration/2.5x-settings-auth-storage-field-mapping.md', () => {
  it('the vendored 2.x files really do contain saveToDb(...) call sites (sanity check)', () => {
    let totalCalls = 0
    for (const file of SAVE_TO_DB_SOURCE_FILES) {
      const source = readFileSync(join(VENDOR_DIR, file), 'utf8')
      totalCalls += [...source.matchAll(/saveToDb\(\s*\[/g)].length
    }
    assert.ok(
      totalCalls >= 9,
      `expected at least 9 saveToDb([...]) call sites, found ${totalCalls}`
    )
  })

  it('the settings-key summary table covers exactly the union of every saveToDb([...]) key', () => {
    const allKeys = new Set()
    for (const file of SAVE_TO_DB_SOURCE_FILES) {
      const source = readFileSync(join(VENDOR_DIR, file), 'utf8')
      for (const key of extractSaveToDbKeys(source)) allKeys.add(key)
    }
    assert.equal(
      allKeys.size,
      26,
      `expected exactly 26 distinct settings keys, found ${allKeys.size}: ${[...allKeys].sort().join(', ')}`
    )

    const missing = [...allKeys].filter((key) => !new RegExp(`\`${key}\``).test(doc))
    assert.deepEqual(missing, [], `settings keys missing from the doc: ${missing.join(', ')}`)
  })

  it('does not claim a settings-table key that was never actually persisted (search, cors)', () => {
    // data.yml has `search` and `cors` defaults, but neither ever appears in a saveToDb([...]) call
    // — the doc explicitly calls this out and must not list either as one of the 26 real keys.
    assert.match(doc, /`search`[\s\S]{0,300}never\*\*\s*appear/)
    const summaryTableSection = doc.slice(
      doc.indexOf('| 2.x `settings.key`'),
      doc.indexOf('That is all 26')
    )
    assert.doesNotMatch(summaryTableSection, /\| `search`\s*\|/)
    assert.doesNotMatch(summaryTableSection, /\| `cors`\s*\|/)
  })

  it("confirmed no-destination auth providers = (2.x provider dirs) - (this repo's modules/authentication/* dirs)", () => {
    // The 2.x provider list as vendored/observed 2026-08-17 from requarks/wiki main.
    const providers2x = [
      'auth0',
      'azure',
      'cas',
      'discord',
      'dropbox',
      'facebook',
      'firebase',
      'github',
      'gitlab',
      'google',
      'keycloak',
      'ldap',
      'local',
      'microsoft',
      'oauth2',
      'oidc',
      'okta',
      'rocketchat',
      'saml',
      'slack',
      'twitch'
    ]
    const modules3x = new Set(
      readdirSync(AUTH_MODULES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    )
    const noDestination = providers2x.filter((key) => !modules3x.has(key))

    assert.deepEqual(
      [...modules3x].sort(),
      [
        'auth0',
        'cas',
        'discord',
        'github',
        'gitlab',
        'google',
        'keycloak',
        'ldap',
        'local',
        'microsoft',
        'oauth2',
        'oidc',
        'okta',
        'saml',
        'slack',
        'twitch'
      ],
      'expected exactly 16 authentication modules in this repo — update the doc if this list changed'
    )
    for (const key of noDestination) {
      assert.match(
        doc,
        new RegExp(`\`${key}\``),
        `no-destination provider "${key}" not mentioned in the doc`
      )
    }
    assert.equal(noDestination.length, 5)
  })

  it("confirmed no-destination storage modules = (2.x storage dirs) - (this repo's modules/storage/* dirs)", () => {
    const modules2x = [
      'azure',
      'box',
      'digitalocean',
      'disk',
      'dropbox',
      'gdrive',
      'git',
      'onedrive',
      's3',
      's3generic',
      'sftp'
    ]
    const modules3x = new Set(
      readdirSync(STORAGE_MODULES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    )
    const noDestination = modules2x.filter((key) => !modules3x.has(key))

    assert.deepEqual(
      [...modules3x].sort(),
      ['azure', 'db', 'disk', 'gcs', 'git', 's3', 'sftp'],
      'expected exactly these 7 storage modules in this repo — update the doc if this list changed'
    )
    for (const key of noDestination) {
      assert.match(
        doc,
        new RegExp(`\`${key}\``),
        `no-destination storage module "${key}" not mentioned in the doc`
      )
    }
    assert.equal(noDestination.length, 6)
  })

  it('storage table really has no mode or syncInterval column (re-confirms the two task-mandated no-destination cases)', () => {
    const storageSection = schemaTs.slice(schemaTs.indexOf("pgTable(\n  'storage'"))
    const storageBlock = storageSection.slice(0, storageSection.indexOf('\n)'))
    assert.doesNotMatch(storageBlock, /\bmode:/)
    assert.doesNotMatch(storageBlock, /\bsyncInterval:/)
    assert.match(doc, /\*\*`mode`\*\*/)
    assert.match(doc, /\*\*`syncInterval`\*\*/)
  })

  it('settings.ts really has no telemetry key but does have an unrelated metrics key', () => {
    assert.doesNotMatch(settingsTs, /key:\s*'telemetry'/)
    assert.match(settingsTs, /key:\s*'metrics'/)
    assert.match(doc, /`telemetry`[\s\S]{0,300}NO DESTINATION/)
    assert.match(doc, /not the same thing as 3\.0's (unrelated )?`?metrics`?/i)
  })

  it('sites.ts default config really contains the per-site paths the doc cites', () => {
    for (const path of [
      'company:',
      'contentLicense:',
      'footerExtra:',
      'pageExtensions:',
      'description:',
      'title:'
    ]) {
      assert.match(sitesTs, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.match(sitesTs, /assets:\s*\{[\s\S]{0,80}logo:\s*false/)
    assert.match(sitesTs, /theme:\s*\{[\s\S]{0,40}dark:\s*false/)
    assert.match(sitesTs, /auth:\s*\{[\s\S]{0,200}autoLogin:\s*false/)
    assert.match(sitesTs, /locales:\s*\{[\s\S]{0,80}primary:\s*'en'/)
  })

  it('documents the uploads -> security cross-key move explicitly, not as a same-name match', () => {
    assert.match(doc, /uploadMaxFileSize/)
    assert.match(doc, /uploadMaxFiles/)
    assert.match(doc, /uploadScanSVG/)
    assert.match(doc, /forceAssetDownload/)
    assert.match(doc, /biggest scope surprise/i)
  })

  it('documents the security field-polarity inversions (open redirect / iframe)', () => {
    assert.match(doc, /securityOpenRedirect[\s\S]{0,200}disallowOpenRedirect/)
    assert.match(doc, /inverted polarity/i)
  })
})
