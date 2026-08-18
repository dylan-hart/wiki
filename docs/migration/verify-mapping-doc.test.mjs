// Regression test for docs/migration/2.5x-to-3.0-mapping.md.
//
// It statically parses docs/migration/2.5x-source-schema.md (the Task 706 deliverable — the
// column-by-column inventory of the 2.5.x source schema) and asserts that every single column of
// every one of its 18 documented tables gets a corresponding row in the mapping doc: either naming
// its `backend/db/schema.ts` destination or carrying an explicit "NO DESTINATION YET" marker. This
// is what keeps the mapping doc from silently going stale if the source-schema doc ever gains a
// column that the mapping doc forgets to account for.
//
// It also asserts a handful of specific structural-transform facts the mapping doc is required to
// state explicitly (per Task 709's description): the assets three-table collapse, the pageTree ->
// ltree conversion, the single-siteId collapse, the groups.pageRules `deny` boolean -> `mode`
// ALLOW/DENY/FORCEALLOW enum reshape, the tags/pageTags -> pages.tags denormalization, the
// users.password/tfaSecret/providerKey -> users.auth jsonb reshape, at least one concrete
// definition.yml prop-name mismatch per spot-checked module (local auth, git storage, s3 storage),
// and the `comments` NO DESTINATION YET flagship row cross-referencing the sibling Comments epic.
//
// No database or network access needed at test time: both docs are read as plain text.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_SCHEMA_DOC_PATH = join(HERE, '2.5x-source-schema.md')
const MAPPING_DOC_PATH = join(HERE, '2.5x-to-3.0-mapping.md')
const DEFS_DIR = join(HERE, 'vendor', '2x-definitions')
const SCHEMA_TS_PATH = join(HERE, '..', '..', 'backend', 'db', 'schema.ts')
const GROUPS_MODEL_PATH = join(HERE, '..', '..', 'backend', 'models', 'groups.ts')
const LOCAL_AUTH_3X_PATH = join(
  HERE,
  '..',
  '..',
  'backend',
  'modules',
  'authentication',
  'local',
  'definition.yml'
)
const GIT_STORAGE_3X_PATH = join(
  HERE,
  '..',
  '..',
  'backend',
  'modules',
  'storage',
  'git',
  'definition.yml'
)
const S3_STORAGE_3X_PATH = join(
  HERE,
  '..',
  '..',
  'backend',
  'modules',
  'storage',
  's3',
  'definition.yml'
)

const sourceSchemaDoc = readFileSync(SOURCE_SCHEMA_DOC_PATH, 'utf8')
const mappingDoc = readFileSync(MAPPING_DOC_PATH, 'utf8')
const schemaTs = readFileSync(SCHEMA_TS_PATH, 'utf8')
const groupsModel = readFileSync(GROUPS_MODEL_PATH, 'utf8')
const localAuth2x = readFileSync(join(DEFS_DIR, 'authentication-local-definition.yml'), 'utf8')
const gitStorage2x = readFileSync(join(DEFS_DIR, 'storage-git-definition.yml'), 'utf8')
const s3Storage2x = readFileSync(join(DEFS_DIR, 'storage-s3-definition.yml'), 'utf8')
const group2xGraphql = readFileSync(join(DEFS_DIR, 'group.graphql'), 'utf8')
const localAuth3x = readFileSync(LOCAL_AUTH_3X_PATH, 'utf8')
const gitStorage3x = readFileSync(GIT_STORAGE_3X_PATH, 'utf8')
const s3Storage3x = readFileSync(S3_STORAGE_3X_PATH, 'utf8')

// The 18 tables Task 706 documents column-by-column (see its "Sources" section). Two more headings
// exist in that doc ("Out-of-scope tables referenced only as FK targets", "Other tables observed in
// the vendored migrations, not covered by this doc") but are deliberately not in this list: they are
// not full column inventories, so this task's "one row per 2.x column" mandate does not apply to them.
const SOURCE_TABLES = [
  'pages',
  'pageHistory',
  'pageTree',
  'pageLinks',
  'comments',
  'users',
  'groups',
  'userGroups',
  'assets',
  'assetData',
  'assetFolders',
  'tags',
  'pageTags',
  'pageHistoryTags',
  'navigation',
  'settings',
  'authentication',
  'storage'
]

/** Split the source-schema doc into { tableName: sectionBody } for each `## <tableName>` heading. */
function extractTableSections(doc, tableNames) {
  const sections = {}
  const headingRe = /^## (\S+)$/gm
  const matches = [...doc.matchAll(headingRe)]
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1]
    if (!tableNames.includes(name)) continue
    const start = matches[i].index + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index : doc.length
    sections[name] = doc.slice(start, end)
  }
  return sections
}

/** Every backtick-quoted column name in the first cell of a markdown table row. */
function extractColumns(sectionBody) {
  return [...sectionBody.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|/gm)].map((m) => m[1])
}

const sourceSections = extractTableSections(sourceSchemaDoc, SOURCE_TABLES)

describe('docs/migration/2.5x-to-3.0-mapping.md', () => {
  it('the source-schema doc actually has all 18 expected table sections (sanity check on the parser)', () => {
    const found = Object.keys(sourceSections)
    for (const table of SOURCE_TABLES) {
      assert.ok(found.includes(table), `2.5x-source-schema.md is missing a "## ${table}" section`)
    }
  })

  for (const table of SOURCE_TABLES) {
    it(`documents a destination (or NO DESTINATION YET) for every column of 2.x "${table}"`, () => {
      const columns = extractColumns(sourceSections[table])
      assert.ok(columns.length > 0, `expected to find columns in the "## ${table}" section`)
      // Every table gets its own "## <table>" section in the mapping doc too.
      assert.match(
        mappingDoc,
        new RegExp(`^## ${table}\\b`, 'm'),
        `mapping doc has no "## ${table}" section heading`
      )
      const missing = columns.filter((col) => !new RegExp(`\`${col}\``).test(mappingDoc))
      assert.deepEqual(
        missing,
        [],
        `columns of 2.x "${table}" missing a row in the mapping doc: ${missing.join(', ')}`
      )
    })
  }

  it('flags comments as the flagship NO DESTINATION YET row and cross-references the Comments epic', () => {
    // backend/db/schema.ts really has no comments table to point at (confirmed, not assumed).
    assert.doesNotMatch(schemaTs, /pgTable\(\s*'comments'/)
    assert.match(mappingDoc, /comments[\s\S]{0,400}NO DESTINATION YET/)
    assert.match(mappingDoc, /Comments.{0,40}epic/i)
    assert.match(mappingDoc, /#?335\b/, 'expected the Comments epic id (335) to be cited')
  })

  it('flags pageLinks as its own distinct NO DESTINATION YET, not folded into pages.relations', () => {
    // backend/db/schema.ts really has no pageLinks/link-index table (confirmed, not assumed).
    assert.doesNotMatch(schemaTs, /pgTable\(\s*'pageLinks'/)
    assert.match(schemaTs, /relations:\s*jsonb/)
    assert.match(mappingDoc, /pageLinks[\s\S]{0,600}NO DESTINATION YET/)
    assert.match(mappingDoc, /pages\.relations/)
  })

  it('documents the assets/assetData/assetFolders three-table collapse into one assets row', () => {
    assert.match(mappingDoc, /assetData/)
    assert.match(mappingDoc, /assetFolders/)
    assert.match(mappingDoc, /`data`/)
    assert.match(mappingDoc, /`preview`/)
    assert.match(mappingDoc, /`storageInfo`/)
  })

  it('documents pageTree -> tree.folderPath as an ltree conversion', () => {
    assert.match(mappingDoc, /ltree/)
    assert.match(mappingDoc, /folderPath/)
  })

  it('documents the single-siteId collapse (2.x has no multi-site concept)', () => {
    assert.match(mappingDoc, /siteId/)
    assert.match(mappingDoc, /(single|one)[\s\S]{0,30}site/i)
  })

  it('documents groups.pageRules -> groups.rules, including the deny-boolean vs mode-enum mismatch', () => {
    // The 2.x rule shape really does use `deny: Boolean!`, not a mode enum (confirmed against the
    // vendored 2.x GraphQL schema, not just asserted in prose).
    assert.match(group2xGraphql, /deny:\s*Boolean!/)
    assert.doesNotMatch(group2xGraphql, /\bmode\b/)
    // The 3.0 shape really does use a 3-state `mode`, confirmed against the actual TS interface.
    assert.match(groupsModel, /mode:\s*GroupRuleMode/)
    assert.match(groupsModel, /'ALLOW'\s*\|\s*'DENY'\s*\|\s*'FORCEALLOW'/)
    assert.doesNotMatch(groupsModel, /deny:\s*boolean/)
    // And the doc actually says so.
    assert.match(mappingDoc, /pageRules/)
    assert.match(mappingDoc, /\brules\b/)
    assert.match(mappingDoc, /\bdeny\b/)
    assert.match(mappingDoc, /ALLOW/)
    assert.match(mappingDoc, /DENY/)
    assert.match(mappingDoc, /FORCEALLOW/)
  })

  it('documents tags/pageTags collapsing into pages.tags, with 3.0 tags as a usage-count cache', () => {
    assert.match(mappingDoc, /pages\.tags/)
    assert.match(mappingDoc, /usageCount|usage.count/i)
  })

  it('documents users.password/tfaSecret/providerKey reshaping into users.auth jsonb', () => {
    assert.match(mappingDoc, /users\.auth/)
    assert.match(mappingDoc, /tfaSecret/)
    assert.match(mappingDoc, /providerKey/)
  })

  it('spot-checks the local auth module: 2.x really has empty props, 3.0 really added three', () => {
    assert.match(localAuth2x, /props:\s*\{\}/)
    for (const prop of ['enforceTfa', 'emailValidation', 'allowForgotPassword']) {
      assert.match(localAuth3x, new RegExp(`^\\s{2}${prop}:`, 'm'))
    }
    assert.match(mappingDoc, /\blocal\b[\s\S]{0,2000}definition\.yml/i)
    assert.match(mappingDoc, /enforceTfa/)
  })

  it('spot-checks the git storage module: sshPrivateKeyMode enum value really was renamed', () => {
    assert.match(gitStorage2x, /-\s*'contents'/)
    assert.doesNotMatch(gitStorage2x, /inline/)
    assert.match(gitStorage3x, /inline\|Inline Contents/)
    assert.doesNotMatch(gitStorage3x, /-\s*'contents'/)
    assert.match(gitStorage2x, /alwaysNamespace/)
    assert.doesNotMatch(gitStorage3x, /alwaysNamespace/)
    assert.match(mappingDoc, /sshPrivateKeyMode/)
    assert.match(mappingDoc, /contents/)
    assert.match(mappingDoc, /inline/)
    assert.match(mappingDoc, /alwaysNamespace/)
  })

  it('spot-checks the s3 storage module: region really became mode + awsRegion/doRegion/endpoint', () => {
    assert.match(s3Storage2x, /^\s{2}region:/m)
    assert.doesNotMatch(s3Storage2x, /awsRegion/)
    assert.doesNotMatch(s3Storage2x, /^\s{2}mode:/m)
    assert.match(s3Storage3x, /^\s{2}mode:/m)
    assert.match(s3Storage3x, /awsRegion/)
    assert.match(s3Storage3x, /doRegion/)
    assert.match(mappingDoc, /awsRegion/)
    assert.match(mappingDoc, /\bmode\b/)
  })
})
