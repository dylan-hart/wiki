import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { importComment } from './comment-import.ts'
import type { SourceRecord } from '../connector.ts'
import type {
  CommentImportDeps,
  CommentImportOptions,
  CommentsWriteModel
} from './comment-import.ts'

const SITE_ID = 'site-1'

/** In-memory fake standing in for `WIKI.models.comments` — records every call so tests can assert on
 * what `importComment` actually sent it. */
class FakeCommentsModel implements CommentsWriteModel {
  created: Parameters<CommentsWriteModel['create']>[0][] = []
  private nextId = 1
  failNextCreate: string | null = null

  async create(input: Parameters<CommentsWriteModel['create']>[0]) {
    if (this.failNextCreate) {
      const message = this.failNextCreate
      this.failNextCreate = null
      throw new Error(message)
    }
    this.created.push(input)
    return { id: `comment-${this.nextId++}` }
  }
}

function buildOptions(overrides: Partial<CommentImportOptions> = {}): CommentImportOptions {
  const pageIdMap = overrides.pageIdMap ?? new Map<number, string>()
  return {
    siteId: SITE_ID,
    pageIdMap,
    userIdMap: overrides.userIdMap ?? new Map<number, string>(),
    ...overrides
  }
}

describe('importComment', () => {
  test('a null/undefined record is reported as malformed-record, not a crash', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }

    const outcome = await importComment(null as unknown as SourceRecord, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'malformed-record')
      assert.ok(Number.isNaN(outcome.failure.oldId))
    }
    assert.equal(commentsModel.created.length, 0)
  })

  test('a pageId not in pageIdMap reports unknown-page and never calls create()', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const raw: SourceRecord = { id: 1, pageId: 999, authorId: null, content: 'orphaned' }

    const outcome = await importComment(raw, deps, buildOptions())

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'unknown-page')
      assert.equal(outcome.failure.oldId, 1)
      assert.match(outcome.failure.message, /pageId 999 was never imported/)
    }
    assert.equal(commentsModel.created.length, 0)
  })

  test('a guest comment (authorId null) writes guestName/guestEmail/guestIp and no authorId', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: null,
      content: 'Nice page!',
      name: 'Guest Person',
      email: 'guest@example.com',
      ip: '1.2.3.4'
    }

    const outcome = await importComment(raw, deps, buildOptions({ pageIdMap }))

    assert.equal(outcome.result, 'success')
    assert.equal(commentsModel.created.length, 1)
    const input = commentsModel.created[0]!
    assert.equal(input.authorId, null)
    assert.equal(input.guestName, 'Guest Person')
    assert.equal(input.guestEmail, 'guest@example.com')
    assert.equal(input.guestIp, '1.2.3.4')
    assert.equal(input.pageId, 'page-uuid-100')
  })

  test('a registered author resolves authorId and omits guest fields', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const userIdMap = new Map<number, string>()
    userIdMap.set(42, 'user-uuid-42')
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: 42,
      content: 'Registered author comment',
      name: 'Should be ignored',
      email: 'ignored@example.com'
    }

    const outcome = await importComment(raw, deps, buildOptions({ pageIdMap, userIdMap }))

    assert.equal(outcome.result, 'success')
    const input = commentsModel.created[0]!
    assert.equal(input.authorId, 'user-uuid-42')
    assert.equal(input.guestName, null)
    assert.equal(input.guestEmail, null)
    assert.equal(input.guestIp, null)
  })

  test('a registered author whose id has no entry in the user id map becomes a guest-shaped comment, not misattributed to the operator', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: 999, // -> not in userIdMap
      content: 'Unmapped author'
    }

    const outcome = await importComment(raw, deps, buildOptions({ pageIdMap }))

    assert.equal(outcome.result, 'success')
    const input = commentsModel.created[0]!
    assert.equal(input.authorId, null, 'not silently misattributed to any real actor')
  })

  test('a create() failure returns a failure outcome with reason create-error', async () => {
    const commentsModel = new FakeCommentsModel()
    commentsModel.failNextCreate = 'Comment content must be at least 2 characters.'
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = { id: 1, pageId: 100, authorId: null, content: 'x' }

    const outcome = await importComment(raw, deps, buildOptions({ pageIdMap }))

    assert.equal(outcome.result, 'failure')
    if (outcome.result === 'failure') {
      assert.equal(outcome.failure.reason, 'create-error')
      assert.match(outcome.failure.message, /at least 2 characters/)
    }
  })
})
