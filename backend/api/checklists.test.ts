import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import checklistRoutes from './checklists.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Route-level tests for `api/checklists.ts` (OpenProject #869): permission gating and status-code
 * wiring. `WIKI.models.checklists` is stubbed with an in-memory fake — `models/checklists.test.ts`
 * covers the model's own SQL logic against a real database. `WIKI.models.pages.getPage` and
 * `WIKI.models.groups.{actorForRequest,checkAccess}` are stubbed too, standing in for page-rule
 * resolution, matching `api/comments.test.ts`'s own approach for the same kind of route.
 *
 * Auth is simulated per request via `x-test-user-id` / `x-test-permissions` headers, read by a
 * test-only `onRequest` hook — there is no real session plugin in this bare fastify instance.
 */
describe('checklist routes', () => {
  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const PAGE_ID = '22222222-2222-2222-2222-222222222222'
  const LOCKED_PAGE_ID = '33333333-3333-3333-3333-333333333333'
  const EXECUTION_ID = '44444444-4444-4444-4444-444444444444'
  const OTHER_PAGE_EXECUTION_ID = '55555555-5555-5555-5555-555555555555'

  const pagesById: Record<string, any> = {
    [PAGE_ID]: { id: PAGE_ID, path: 'en/ops/checklist', locale: 'en', tags: [], isLocked: false },
    [LOCKED_PAGE_ID]: {
      id: LOCKED_PAGE_ID,
      path: 'en/ops/locked',
      locale: 'en',
      tags: [],
      isLocked: true
    }
  }

  async function getPage({ id }: { id?: string }) {
    return id ? (pagesById[id] ?? null) : null
  }

  function actorForRequest(req: any) {
    return { permissions: req.session?.permissions ?? [] }
  }

  function checkAccess(actor: { permissions: string[] }, permission: string) {
    return actor.permissions.includes(permission)
  }

  function baseExecution(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: EXECUTION_ID,
      siteId: SITE_ID,
      pageId: PAGE_ID,
      blockKey: 'shift-open',
      itemCount: 3,
      startedAt: new Date('2026-01-01T08:00:00.000Z'),
      startedBy: 'user-1',
      startedByName: 'Test User',
      completedAt: null,
      completedBy: null,
      completedByName: null,
      checkedCount: 1,
      items: [
        {
          itemKey: 'item-0',
          checkedAt: new Date('2026-01-01T08:00:00.000Z'),
          checkedBy: 'user-1',
          checkedByName: 'Test User'
        }
      ],
      ...overrides
    }
  }

  let listExecutionsCalls: Array<{ pageId: string; blockKey: string }>
  let checkItemCalls: Array<Record<string, any>>

  async function listExecutions(pageId: string, blockKey: string) {
    listExecutionsCalls.push({ pageId, blockKey })
    if (pageId !== PAGE_ID) {
      return []
    }
    const { items: _items, ...summary } = baseExecution()
    return [summary]
  }

  async function getLatestExecution(pageId: string, blockKey: string) {
    if (pageId !== PAGE_ID || blockKey !== 'shift-open') {
      return null
    }
    return baseExecution()
  }

  async function getExecutionDetail(executionId: string) {
    if (executionId === EXECUTION_ID) {
      return baseExecution()
    }
    if (executionId === OTHER_PAGE_EXECUTION_ID) {
      return baseExecution({ id: OTHER_PAGE_EXECUTION_ID, pageId: 'some-other-page' })
    }
    return null
  }

  async function checkItem(input: Record<string, any>) {
    checkItemCalls.push(input)
    if (input.itemCount < 1) {
      throw new Error('itemCount must be a positive integer.')
    }
    return baseExecution({ checkedCount: 2, startedBy: input.userId })
  }

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: checklistRoutes,
      ajv: true,
      // -> This suite's own two headers, rather than the harness's `'header'` convention: it needs
      //    an `authenticated: false` session present (not absent) for the guest cases, and a
      //    `user.id` on the authenticated ones.
      session: (req: any) => {
        const userId = req.headers['x-test-user-id'] as string | undefined
        const permissions = ((req.headers['x-test-permissions'] as string | undefined) ?? '')
          .split(',')
          .filter(Boolean)
        return userId
          ? { authenticated: true, user: { id: userId }, permissions }
          : { authenticated: false, permissions }
      },
      wiki: {
        models: {
          pages: { getPage },
          groups: { actorForRequest, checkAccess, groupIdsForRequest: () => [] },
          checklists: { listExecutions, getLatestExecution, getExecutionDetail, checkItem }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    listExecutionsCalls = []
    checkItemCalls = []
  })

  const READ_ONLY = { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages' }
  const READ_WRITE = { 'x-test-user-id': 'user-1', 'x-test-permissions': 'read:pages,write:pages' }

  test('GET history: 404 when the page does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/00000000-0000-0000-0000-000000000000/checklist/shift-open/executions`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET history: 404 (not 403) when the caller may not read the page at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions`,
      headers: { 'x-test-user-id': 'user-1', 'x-test-permissions': '' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET history: 200 with the run history for a readable page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.length, 1)
    assert.equal(body[0].blockKey, 'shift-open')
    assert.equal(body[0].items, undefined, 'the summary shape carries no items array')
    assert.deepEqual(listExecutionsCalls, [{ pageId: PAGE_ID, blockKey: 'shift-open' }])
  })

  test('GET history: 403 on a password-protected page even though it is otherwise readable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${LOCKED_PAGE_ID}/checklist/shift-open/executions`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 403)
  })

  test('GET latest: returns null for a checklist that has never run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/never-run/executions/latest`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json(), null)
  })

  test('GET latest: returns the execution, items included', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/latest`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.id, EXECUTION_ID)
    assert.equal(body.items.length, 1)
  })

  test('GET one execution: 200 for an execution belonging to this page and block', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/${EXECUTION_ID}`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().id, EXECUTION_ID)
  })

  test('GET one execution: 404 for an execution id that belongs to a different page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/${OTHER_PAGE_EXECUTION_ID}`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 404)
  })

  test('GET one execution: 404 for an id nothing has', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/executions/99999999-9999-9999-9999-999999999999`,
      headers: READ_ONLY
    })
    assert.equal(res.statusCode, 404)
  })

  test('POST item: 401 when signed out — there is no identity to attribute the check to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      headers: { 'x-test-permissions': 'read:pages,write:pages' },
      payload: { itemKey: 'item-1', itemCount: 3 }
    })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(checkItemCalls, [])
  })

  test('POST item: 403 when signed in but write:pages is not granted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      headers: READ_ONLY,
      payload: { itemKey: 'item-1', itemCount: 3 }
    })
    assert.equal(res.statusCode, 403)
    assert.deepEqual(checkItemCalls, [])
  })

  test('POST item: 403 on a password-protected page even with write:pages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${LOCKED_PAGE_ID}/checklist/shift-open/items`,
      headers: READ_WRITE,
      payload: { itemKey: 'item-1', itemCount: 3 }
    })
    assert.equal(res.statusCode, 403)
  })

  test('POST item: 200 records the check, attributed to the session user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      headers: READ_WRITE,
      payload: { itemKey: 'item-1', itemCount: 3 }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().checkedCount, 2)
    assert.deepEqual(checkItemCalls, [
      {
        siteId: SITE_ID,
        pageId: PAGE_ID,
        blockKey: 'shift-open',
        itemKey: 'item-1',
        itemCount: 3,
        userId: 'user-1'
      }
    ])
  })

  test('POST item: 400 body validation rejects a missing itemKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      headers: READ_WRITE,
      payload: { itemCount: 3 }
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(checkItemCalls, [])
  })

  test('POST item: 400 body validation rejects itemCount below 1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/${PAGE_ID}/checklist/shift-open/items`,
      headers: READ_WRITE,
      payload: { itemKey: 'item-1', itemCount: 0 }
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(checkItemCalls, [])
  })

  test('POST item: 404 when the page does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/pages/00000000-0000-0000-0000-000000000000/checklist/shift-open/items`,
      headers: READ_WRITE,
      payload: { itemKey: 'item-1', itemCount: 3 }
    })
    assert.equal(res.statusCode, 404)
  })
})
