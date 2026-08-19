import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import {
  COMMENTS_STAGING_SCHEMA_VERSION,
  readCommentsStagingBundle,
  readCommentsStagingManifest,
  stageComment,
  writeCommentsStagingBundle,
  type PageIdMap,
  type SourceCommentRecord,
  type UserIdMap
} from './comments.ts'

function record(overrides: Partial<SourceCommentRecord> = {}): SourceCommentRecord {
  return {
    id: 1,
    content: 'Some **markdown**.',
    render: '<p>Some <strong>markdown</strong>.</p>',
    name: '',
    email: '',
    ip: '',
    authorId: 42,
    pageId: 7,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    ...overrides
  }
}

const mappedUserId = '11111111-1111-1111-1111-111111111111'
const mappedPageId = '22222222-2222-2222-2222-222222222222'

const userIdMap: UserIdMap = { get: (oldId) => (oldId === 42 ? mappedUserId : undefined) }
const pageIdMap: PageIdMap = { get: (oldId) => (oldId === 7 ? mappedPageId : undefined) }

describe('stageComment', () => {
  test('passes content/render through unchanged', () => {
    const staged = stageComment(record(), pageIdMap, userIdMap)
    assert.equal(staged.content, 'Some **markdown**.')
    assert.equal(staged.render, '<p>Some <strong>markdown</strong>.</p>')
  })

  test('remaps a resolvable pageId and marks it resolved', () => {
    const staged = stageComment(record({ pageId: 7 }), pageIdMap, userIdMap)
    assert.equal(staged.pageId, mappedPageId)
    assert.equal(staged.sourcePageId, 7)
    assert.equal(staged.unresolvedPageId, false)
  })

  test('remaps a resolvable non-null authorId', () => {
    const staged = stageComment(record({ authorId: 42 }), pageIdMap, userIdMap)
    assert.equal(staged.authorId, mappedUserId)
  })

  test('leaves authorId null and keeps name/email/ip intact for a guest comment', () => {
    const staged = stageComment(
      record({ authorId: null, name: 'Jane Guest', email: 'jane@example.com', ip: '203.0.113.5' }),
      pageIdMap,
      userIdMap
    )
    assert.equal(staged.authorId, null)
    assert.equal(staged.sourceAuthorId, null)
    assert.equal(staged.name, 'Jane Guest')
    assert.equal(staged.email, 'jane@example.com')
    assert.equal(staged.ip, '203.0.113.5')
  })

  test('does not substitute a system user for an authorId the map has no entry for', () => {
    // -> Unlike the asset-author fallback (Task 747), a comment whose author never got imported (or
    //    whose id-map has no entry yet) stays attributed to nobody rather than to an admin/system user.
    const staged = stageComment(record({ authorId: 999 }), pageIdMap, userIdMap)
    assert.equal(staged.authorId, null)
    assert.equal(staged.sourceAuthorId, 999)
  })

  test('flags an orphaned pageId (source page excluded from import scope) instead of dropping the row', () => {
    const staged = stageComment(record({ pageId: 999 }), pageIdMap, userIdMap)
    assert.equal(staged.pageId, null)
    assert.equal(staged.sourcePageId, 999)
    assert.equal(staged.unresolvedPageId, true)
  })

  test('flags a genuinely null source pageId as unresolved too', () => {
    const staged = stageComment(record({ pageId: null }), pageIdMap, userIdMap)
    assert.equal(staged.pageId, null)
    assert.equal(staged.sourcePageId, null)
    assert.equal(staged.unresolvedPageId, true)
  })

  test('serializes createdAt/updatedAt as ISO strings', () => {
    const staged = stageComment(record(), pageIdMap, userIdMap)
    assert.equal(staged.createdAt, '2024-01-01T00:00:00.000Z')
    assert.equal(staged.updatedAt, '2024-01-02T00:00:00.000Z')
  })

  test('carries the source comment id through unchanged', () => {
    const staged = stageComment(record({ id: 123 }), pageIdMap, userIdMap)
    assert.equal(staged.id, 123)
  })
})

describe('writeCommentsStagingBundle / readCommentsStagingBundle', () => {
  let bundleDir: string

  beforeEach(async () => {
    bundleDir = await mkdtemp(path.join(tmpdir(), 'wiki-comments-staging-'))
  })

  test('round-trips a batch of comments through the NDJSON file and manifest', async () => {
    const records = [
      record({ id: 1, authorId: 42, pageId: 7 }),
      record({ id: 2, authorId: null, name: 'Guest', pageId: 999 }),
      record({ id: 3, authorId: 42, pageId: null })
    ]

    const manifest = await writeCommentsStagingBundle(
      bundleDir,
      'site-a',
      records,
      pageIdMap,
      userIdMap
    )

    assert.equal(manifest.schemaVersion, COMMENTS_STAGING_SCHEMA_VERSION)
    assert.equal(manifest.siteId, 'site-a')
    assert.equal(manifest.rowCount, 3)
    assert.equal(manifest.unresolvedPageIdCount, 2)
    assert.ok(manifest.generatedAt)

    const readManifest = await readCommentsStagingManifest(bundleDir, 'site-a')
    assert.deepEqual(readManifest, manifest)

    const staged = []
    for await (const row of readCommentsStagingBundle(bundleDir, 'site-a')) {
      staged.push(row)
    }
    assert.equal(staged.length, 3)
    assert.deepEqual(
      staged.map((r) => r.id),
      [1, 2, 3]
    )
    assert.equal(staged[0].pageId, mappedPageId)
    assert.equal(staged[1].unresolvedPageId, true)
    assert.equal(staged[1].name, 'Guest')
    assert.equal(staged[2].unresolvedPageId, true)
  })

  test('writes a valid, readable empty bundle when there are no comments', async () => {
    const manifest = await writeCommentsStagingBundle(
      bundleDir,
      'site-empty',
      [],
      pageIdMap,
      userIdMap
    )
    assert.equal(manifest.rowCount, 0)
    assert.equal(manifest.unresolvedPageIdCount, 0)

    const staged = []
    for await (const row of readCommentsStagingBundle(bundleDir, 'site-empty')) {
      staged.push(row)
    }
    assert.equal(staged.length, 0)
  })

  test('keeps per-site bundles independent within the same bundle directory', async () => {
    await writeCommentsStagingBundle(bundleDir, 'site-a', [record({ id: 1 })], pageIdMap, userIdMap)
    await writeCommentsStagingBundle(
      bundleDir,
      'site-b',
      [record({ id: 2 }), record({ id: 3 })],
      pageIdMap,
      userIdMap
    )

    const manifestA = await readCommentsStagingManifest(bundleDir, 'site-a')
    const manifestB = await readCommentsStagingManifest(bundleDir, 'site-b')
    assert.equal(manifestA.rowCount, 1)
    assert.equal(manifestB.rowCount, 2)
  })

  test('accepts an async-iterable source of records, not just an array', async () => {
    async function* generate() {
      yield record({ id: 1 })
      yield record({ id: 2 })
    }
    const manifest = await writeCommentsStagingBundle(
      bundleDir,
      'site-a',
      generate(),
      pageIdMap,
      userIdMap
    )
    assert.equal(manifest.rowCount, 2)
  })

  test('readCommentsStagingManifest rejects a bundle written by a newer, unsupported schema version', async () => {
    await writeCommentsStagingBundle(bundleDir, 'site-a', [record()], pageIdMap, userIdMap)
    const manifestPath = path.join(bundleDir, 'comments', 'site-a.manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.schemaVersion = COMMENTS_STAGING_SCHEMA_VERSION + 1
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    await assert.rejects(() => readCommentsStagingManifest(bundleDir, 'site-a'), /schema version/)
  })

  test('readCommentsStagingBundle rejects a truncated data file whose row count disagrees with the manifest', async () => {
    await writeCommentsStagingBundle(
      bundleDir,
      'site-a',
      [record({ id: 1 }), record({ id: 2 })],
      pageIdMap,
      userIdMap
    )
    const dataPath = path.join(bundleDir, 'comments', 'site-a.ndjson')
    const original = await readFile(dataPath, 'utf8')
    await writeFile(dataPath, original.split('\n')[0] + '\n', 'utf8')

    async function drain() {
      for await (const _row of readCommentsStagingBundle(bundleDir, 'site-a')) {
        // drain
      }
    }
    await assert.rejects(drain, /row count/)
  })
})
