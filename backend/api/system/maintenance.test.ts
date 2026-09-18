import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import maintenanceRoutes from './maintenance.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * `POST /wysiwyg/convert` and `GET /wysiwyg/convert/:jobId` (OpenProject #3400) -- the queue-and-poll
 * pair `scanPageProblems`/`GET /pages/scan/:jobId` (`system/transfer.ts`) already establish, so this
 * only tests THIS pair's own HTTP-layer contract: it asks the scheduler to queue the right task with
 * the triggering user's id, records the audit entry, and reads `jobHistory`/the pending queue back the
 * same way the scan route does. `CARDINAL.scheduler`/`CARDINAL.models.jobs`/`CARDINAL.models.auditLog`
 * are stubbed -- what actually walks the `pages` table and converts a row is
 * `tasks/simple/convert-wysiwyg-json.ts`'s own task, covered separately (DB-backed) alongside
 * `models/pages.ts#convertLegacyWysiwygRow`.
 */
describe('POST /wysiwyg/convert, GET /wysiwyg/convert/:jobId', () => {
  let app: FastifyInstance
  let addJob: ReturnType<typeof mock.fn>
  let auditLogRecord: ReturnType<typeof mock.fn>
  let getHistoryEntry: ReturnType<typeof mock.fn>
  let getPendingEntry: ReturnType<typeof mock.fn>

  const userId = randomUUID()
  const jobId = randomUUID()

  before(async () => {
    addJob = mock.fn(async () => ({ id: jobId }))
    auditLogRecord = mock.fn(async () => {})
    getHistoryEntry = mock.fn(async (id: string) =>
      id === jobId
        ? {
            task: 'convertWysiwygJson',
            state: 'completed',
            result: { convertedCount: 2, failed: [] }
          }
        : null
    )
    getPendingEntry = mock.fn(async (id: string) =>
      id === jobId ? { task: 'convertWysiwygJson' } : null
    )

    app = await buildTestApp({
      routes: maintenanceRoutes,
      ajv: true,
      permissions: true,
      session: {
        authenticated: true,
        user: { id: userId, name: 'Fixture Admin' },
        permissions: ['manage:system'],
        destroy: async () => {}
      },
      wiki: {
        scheduler: { addJob },
        models: {
          auditLog: { record: auditLogRecord },
          jobs: { getHistoryEntry, getPendingEntry }
        }
      }
    })
  })

  beforeEach(() => {
    addJob.mock.resetCalls()
    auditLogRecord.mock.resetCalls()
    getHistoryEntry.mock.resetCalls()
    getPendingEntry.mock.resetCalls()
  })

  after(() => closeTestApp(app))

  test('POST queues the convertWysiwygJson task with the triggering user as actorId, and records an audit entry', async () => {
    const res = await app.inject({ method: 'POST', url: '/wysiwyg/convert' })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.id, jobId)

    assert.equal(addJob.mock.calls.length, 1)
    const [queued] = addJob.mock.calls[0]!.arguments as [
      { task: string; payload: { actorId: string } }
    ]
    assert.equal(queued.task, 'convertWysiwygJson')
    assert.equal(queued.payload.actorId, userId)

    assert.equal(auditLogRecord.mock.calls.length, 1)
    const [entry] = auditLogRecord.mock.calls[0]!.arguments as [
      { event: string; detail: { jobId: string } }
    ]
    assert.equal(entry.event, 'system.wysiwygJsonConverted')
    assert.equal(entry.detail.jobId, jobId)
  })

  test('POST 500s when the scheduler could not queue the job', async () => {
    addJob.mock.mockImplementationOnce(async () => undefined)
    const res = await app.inject({ method: 'POST', url: '/wysiwyg/convert' })
    assert.equal(res.statusCode, 500)
  })

  test('GET reads a completed job back off jobHistory', async () => {
    const res = await app.inject({ method: 'GET', url: `/wysiwyg/convert/${jobId}` })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.state, 'completed')
    assert.deepEqual(body.result, { convertedCount: 2, failed: [] })
  })

  test('GET reports queued for a job still on the pending queue', async () => {
    const pendingId = randomUUID()
    getHistoryEntry.mock.mockImplementationOnce(async () => null)
    getPendingEntry.mock.mockImplementationOnce(async (id: string) =>
      id === pendingId ? { task: 'convertWysiwygJson' } : null
    )
    const res = await app.inject({ method: 'GET', url: `/wysiwyg/convert/${pendingId}` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { state: 'queued', result: null })
  })

  test('GET 404s for an id belonging to a different task', async () => {
    getHistoryEntry.mock.mockImplementationOnce(async () => ({
      task: 'scanPageProblems',
      state: 'completed',
      result: {}
    }))
    const res = await app.inject({ method: 'GET', url: `/wysiwyg/convert/${jobId}` })
    assert.equal(res.statusCode, 404)
  })

  test('GET 404s for an id nothing knows about', async () => {
    getHistoryEntry.mock.mockImplementationOnce(async () => null)
    getPendingEntry.mock.mockImplementationOnce(async () => null)
    const res = await app.inject({ method: 'GET', url: `/wysiwyg/convert/${randomUUID()}` })
    assert.equal(res.statusCode, 404)
  })
})
