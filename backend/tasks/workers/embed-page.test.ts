import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { embedPage, task } from './embed-page.ts'

/**
 * `embedPage`/`task` here are a cross-task coordination stub for Task #3098, not the real
 * implementation — see the file's own doc comment. This suite only pins the two properties #3104's
 * own code actually depends on: the function resolves (never throws) for a page id, and the
 * worker-thread `task()` entry forwards its payload's `pageId` the same way `tasks/workers/
 * dispatch-webhook.ts#task` forwards its own payload.
 */
describe('embedPage() stub', () => {
  test('resolves without throwing for any page id', async () => {
    await assert.doesNotReject(embedPage('page-1'))
  })
})

describe('task() worker entry stub', () => {
  test('resolves without throwing when the payload carries a pageId', async () => {
    await assert.doesNotReject(task({ payload: { pageId: 'page-1' } }))
  })

  test('resolves without throwing when the payload carries no pageId', async () => {
    await assert.doesNotReject(task({ payload: {} }))
    await assert.doesNotReject(task({}))
  })
})
