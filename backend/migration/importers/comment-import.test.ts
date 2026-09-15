import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createCommentImportState, importComment, resolveCommentReplies } from './comment-import.ts'
import type { SourceRecord } from '../connector.ts'
import type {
  CommentImportDeps,
  CommentImportOptions,
  CommentsWriteModel
} from './comment-import.ts'

const SITE_ID = 'site-1'

/** In-memory fake standing in for `CARDINAL.models.comments` — records every call so tests can assert on
 * what `importComment`/`resolveCommentReplies` actually sent it. */
class FakeCommentsModel implements CommentsWriteModel {
  created: Parameters<CommentsWriteModel['create']>[0][] = []
  replyToCalls: { id: string; replyTo: string }[] = []
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

  async setReplyTo(id: string, replyTo: string) {
    this.replyToCalls.push({ id, replyTo })
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

  // -------------------------------------------------------------------------------------------
  // createdAt/updatedAt threading (OpenProject #3204)
  // -------------------------------------------------------------------------------------------

  test('a real Date createdAt/updatedAt is threaded through create() as an ISO string', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: null,
      content: 'dated comment',
      createdAt: new Date('2019-05-01T12:00:00.000Z'),
      updatedAt: new Date('2019-05-02T08:30:00.000Z')
    }

    await importComment(raw, deps, buildOptions({ pageIdMap }))

    const input = commentsModel.created[0]!
    assert.equal(input.createdAt, '2019-05-01T12:00:00.000Z')
    assert.equal(input.updatedAt, '2019-05-02T08:30:00.000Z')
  })

  test('a missing/unparseable createdAt/updatedAt degrades to undefined rather than failing the comment', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: null,
      content: 'no dates',
      createdAt: 'not-a-real-date',
      updatedAt: null
    }

    const outcome = await importComment(raw, deps, buildOptions({ pageIdMap }))

    assert.equal(outcome.result, 'success')
    const input = commentsModel.created[0]!
    assert.equal(input.createdAt, undefined)
    assert.equal(input.updatedAt, undefined)
  })

  // -------------------------------------------------------------------------------------------
  // replyTo threading via CommentImportState + resolveCommentReplies (OpenProject #3204)
  // -------------------------------------------------------------------------------------------

  test('every comment is created top-level (replyTo never passed to create()) regardless of source replyTo', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const raw: SourceRecord = { id: 2, pageId: 100, authorId: null, content: 'a reply', replyTo: 1 }

    await importComment(raw, deps, buildOptions({ pageIdMap }))

    assert.equal(
      Object.prototype.hasOwnProperty.call(commentsModel.created[0]!, 'replyTo'),
      false,
      'create() is never handed a replyTo -- every comment starts top-level'
    )
  })

  test("2.x's 0-sentinel for top-level is not queued as a pending reply", async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const state = createCommentImportState()
    const raw: SourceRecord = {
      id: 1,
      pageId: 100,
      authorId: null,
      content: 'top level',
      replyTo: 0
    }

    await importComment(raw, deps, buildOptions({ pageIdMap }), state)

    assert.equal(state.pending.length, 0)
  })

  test('null/undefined replyTo is likewise not queued', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const state = createCommentImportState()

    await importComment(
      { id: 1, pageId: 100, authorId: null, content: 'a', replyTo: null },
      deps,
      buildOptions({ pageIdMap }),
      state
    )
    await importComment(
      { id: 2, pageId: 100, authorId: null, content: 'b' },
      deps,
      buildOptions({ pageIdMap }),
      state
    )

    assert.equal(state.pending.length, 0)
  })

  test('a forward-referencing reply (parent appears later in the stream) resolves correctly after resolveCommentReplies()', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const options = buildOptions({ pageIdMap })
    const state = createCommentImportState()

    // -> Old id 2's reply names old id 5, which has not been imported yet at this point in the
    //    stream -- the exact forward-reference case `state`/`resolveCommentReplies()` exist for.
    const replyOutcome = await importComment(
      { id: 2, pageId: 100, authorId: null, content: 'a reply', replyTo: 5 },
      deps,
      options,
      state
    )
    const parentOutcome = await importComment(
      { id: 5, pageId: 100, authorId: null, content: 'the parent, imported later' },
      deps,
      options,
      state
    )

    assert.equal(replyOutcome.result, 'success')
    assert.equal(parentOutcome.result, 'success')
    assert.equal(state.pending.length, 1)
    assert.equal(commentsModel.replyToCalls.length, 0, 'not resolved yet -- only queued')

    await resolveCommentReplies(deps, state)

    assert.equal(commentsModel.replyToCalls.length, 1)
    if (replyOutcome.result === 'success' && parentOutcome.result === 'success') {
      assert.equal(commentsModel.replyToCalls[0]!.id, replyOutcome.success.commentId)
      assert.equal(commentsModel.replyToCalls[0]!.replyTo, parentOutcome.success.commentId)
    }
  })

  test('a reply naming a comment that never imported is left top-level and logged, not a crash', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const state = createCommentImportState()
    const logs: string[] = []

    await importComment(
      { id: 2, pageId: 100, authorId: null, content: 'orphaned reply', replyTo: 999 },
      deps,
      buildOptions({ pageIdMap }),
      state
    )

    await resolveCommentReplies(deps, state, (message) => logs.push(message))

    assert.equal(commentsModel.replyToCalls.length, 0, 'never patched -- 999 was never imported')
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /replyTo 999 was never imported/)
  })

  test('a comment whose oldId fails to parse is still created but earns no idMap entry', async () => {
    const commentsModel = new FakeCommentsModel()
    const deps: CommentImportDeps = { commentsModel }
    const pageIdMap = new Map<number, string>()
    pageIdMap.set(100, 'page-uuid-100')
    const state = createCommentImportState()

    const outcome = await importComment(
      { id: 'not-a-number', pageId: 100, authorId: null, content: 'weird id' },
      deps,
      buildOptions({ pageIdMap }),
      state
    )

    assert.equal(outcome.result, 'success')
    assert.equal(state.idMap.size, 0)
  })
})

describe('createCommentImportState', () => {
  test('returns a fresh, independent state each call', () => {
    const a = createCommentImportState()
    const b = createCommentImportState()
    a.idMap.set(1, 'x')
    a.pending.push({ newId: 'x', oldReplyTo: 1 })

    assert.equal(b.idMap.size, 0)
    assert.equal(b.pending.length, 0)
  })
})
