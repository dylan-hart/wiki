import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  orderCommentsByReplyDepth,
  REPLICATION_FORMAT_VERSION,
  stripDerivedPageColumns
} from './replicationImport.ts'

describe('stripDerivedPageColumns (pure, no DB)', () => {
  test('drops ts and searchContent, keeps everything else', () => {
    const row = {
      id: 'page-1',
      title: 'Hello',
      content: '# Hello',
      ts: 'some-tsvector-text',
      searchContent: 'hello world'
    }
    assert.deepEqual(stripDerivedPageColumns(row), {
      id: 'page-1',
      title: 'Hello',
      content: '# Hello'
    })
  })

  test('is a no-op when neither column is present', () => {
    const row = { id: 'page-1', title: 'Hello' }
    assert.deepEqual(stripDerivedPageColumns(row), row)
  })
})

describe('orderCommentsByReplyDepth (pure, no DB)', () => {
  test('a flat list of top-level comments passes through unordered-but-complete', () => {
    const rows = [
      { id: 'c1', replyTo: null },
      { id: 'c2', replyTo: null },
      { id: 'c3', replyTo: null }
    ]
    const ordered = orderCommentsByReplyDepth(rows)
    assert.equal(ordered.length, 3)
    assert.deepEqual(new Set(ordered.map((r) => r.id)), new Set(['c1', 'c2', 'c3']))
  })

  test('every reply comes after the row it replies to, even when the archive lists it first', () => {
    // -> Deliberately out of order: the reply (`c2`) is listed before its parent (`c1`).
    const rows = [
      { id: 'c2', replyTo: 'c1' },
      { id: 'c1', replyTo: null }
    ]
    const ordered = orderCommentsByReplyDepth(rows)
    const indexOf = (id: string) => ordered.findIndex((r) => r.id === id)
    assert.ok(indexOf('c1') < indexOf('c2'))
  })

  test('a multi-level reply chain is ordered root-first regardless of input order', () => {
    const rows = [
      { id: 'grandchild', replyTo: 'child' },
      { id: 'root', replyTo: null },
      { id: 'child', replyTo: 'root' }
    ]
    const ordered = orderCommentsByReplyDepth(rows)
    const indexOf = (id: string) => ordered.findIndex((r) => r.id === id)
    assert.ok(indexOf('root') < indexOf('child'))
    assert.ok(indexOf('child') < indexOf('grandchild'))
  })

  test('a genuine cycle is refused rather than looped on forever', () => {
    const rows = [
      { id: 'a', replyTo: 'b' },
      { id: 'b', replyTo: 'a' }
    ]
    assert.throws(() => orderCommentsByReplyDepth(rows), /replyTo that never resolves/)
  })

  test('a dangling replyTo (no such row in the archive) is refused', () => {
    const rows = [{ id: 'a', replyTo: 'does-not-exist' }]
    assert.throws(() => orderCommentsByReplyDepth(rows), /replyTo that never resolves/)
  })
})

/**
 * `readArchive`/`readJson` themselves are already covered by `models/siteImport.test.ts` (the module
 * that owns them) — this only proves `importSnapshot` refuses an archive whose format version it does
 * not recognize before touching the database, mirroring `siteImport.ts`'s own precedent, using a
 * fixture built the same way that file's own pure describe builds one.
 */
describe('importSnapshot format version guard (pure, no DB)', () => {
  let importSnapshot: typeof import('./replicationImport.ts').replicationImportModel.importSnapshot
  let tmpDir: string

  before(async () => {
    ;({
      replicationImportModel: { importSnapshot }
    } = await import('./replicationImport.ts'))
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-version-test-'))
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('refuses an archive with no manifest.json#formatVersion at all', async () => {
    const { create: createTarball } = await import('tar')
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-stage-'))
    const manifestPath = path.join(stagingDir, 'manifest.json')
    await fs.writeFile(manifestPath, JSON.stringify({ generatedAt: new Date().toISOString() }))
    const filePath = path.join(tmpDir, `${crypto.randomUUID()}.tar.gz`)
    await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, ['manifest.json'])
    await fs.rm(stagingDir, { recursive: true, force: true })

    await assert.rejects(importSnapshot(filePath), /Unsupported replication archive version/)
  })

  test('refuses an archive naming a version this instance does not recognize', async () => {
    const { create: createTarball } = await import('tar')
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-stage-'))
    const manifestPath = path.join(stagingDir, 'manifest.json')
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ formatVersion: REPLICATION_FORMAT_VERSION + 1 })
    )
    const filePath = path.join(tmpDir, `${crypto.randomUUID()}.tar.gz`)
    await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, ['manifest.json'])
    await fs.rm(stagingDir, { recursive: true, force: true })

    await assert.rejects(importSnapshot(filePath), /Unsupported replication archive version/)
  })
})
