import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Route-level test for the instance-wide replication export pair (WP #2489): `POST
 * /replication/export` (queue) and `GET /replication/export/:jobId/download` (poll/download once).
 * Mirrors `transfer.test.ts`'s shape for the analogous per-site pair, but this route takes no
 * `siteId` at all — the whole point is instance-wide scope — so there is no site-pin/enforcement
 * concern to cover here, only the job lifecycle and the download's 404/409/200 states.
 * `WIKI.scheduler.addJob`, `WIKI.models.jobs.getHistoryEntry` and `WIKI.models.auditLog.record` are
 * mocked; `WIKI.models.replicationExport.deleteExport` runs for real against a throwaway file so the
 * "downloaded once" delete-after-stream behavior is actually exercised.
 */
describe('replication export routes', () => {
  let app: FastifyInstance
  let dataPath: string
  let addJob: ReturnType<typeof mock.fn>
  let record: ReturnType<typeof mock.fn>
  let getHistoryEntry: ReturnType<typeof mock.fn>
  let deleteExport: ReturnType<typeof mock.fn>

  before(async () => {
    dataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-export-route-test-'))

    addJob = mock.fn(async () => ({ id: 'job-1' }))
    record = mock.fn(async () => {})
    getHistoryEntry = mock.fn(async () => null)
    deleteExport = mock.fn(async (filePath: string) => {
      await fsp.unlink(filePath).catch(() => {})
    })

    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      session: {
        authenticated: true,
        user: { id: 'user-1', name: 'Root' },
        permissions: ['manage:system']
      },
      wiki: {
        ROOTPATH: process.cwd(),
        config: { dataPath },
        models: {
          jobs: { getHistoryEntry },
          auditLog: { record },
          replicationExport: { deleteExport }
        },
        scheduler: { addJob }
      }
    })
  })

  after(async () => {
    await closeTestApp(app)
    await fsp.rm(dataPath, { recursive: true, force: true })
  })

  beforeEach(() => {
    addJob.mock.resetCalls()
    record.mock.resetCalls()
    getHistoryEntry.mock.resetCalls()
    deleteExport.mock.resetCalls()
    getHistoryEntry.mock.mockImplementation(async () => null)
  })

  describe('POST /replication/export', () => {
    test('queues the exportReplication task with no siteId, and audits it', async () => {
      const res = await app.inject({ method: 'POST', url: '/replication/export' })

      assert.equal(res.statusCode, 200)
      assert.deepEqual(res.json(), {
        ok: true,
        message: 'Replication snapshot export queued successfully.',
        id: 'job-1'
      })

      assert.equal(addJob.mock.callCount(), 1)
      assert.deepEqual(addJob.mock.calls[0]!.arguments[0], { task: 'exportReplication' })

      assert.equal(record.mock.callCount(), 1)
      const recorded = record.mock.calls[0]!.arguments[0] as any
      assert.equal(recorded.event, 'system.replicationSnapshotExported')
      assert.deepEqual(recorded.detail, { jobId: 'job-1' })
    })

    test('answers 500 and records no audit entry when the scheduler cannot queue the job', async () => {
      addJob.mock.mockImplementationOnce(async () => undefined)

      const res = await app.inject({ method: 'POST', url: '/replication/export' })

      assert.equal(res.statusCode, 500)
      assert.equal(record.mock.callCount(), 0)
    })
  })

  describe('GET /replication/export/:jobId/download', () => {
    const jobId = '11111111-1111-4111-8111-111111111111'

    test('404s when no such job exists', async () => {
      getHistoryEntry.mock.mockImplementation(async () => null)

      const res = await app.inject({
        method: 'GET',
        url: `/replication/export/${jobId}/download`
      })

      assert.equal(res.statusCode, 404)
    })

    test("404s when the job exists but isn't a replication export", async () => {
      getHistoryEntry.mock.mockImplementation(async () => ({
        id: jobId,
        task: 'exportContent',
        state: 'completed'
      }))

      const res = await app.inject({
        method: 'GET',
        url: `/replication/export/${jobId}/download`
      })

      assert.equal(res.statusCode, 404)
    })

    test('409s when the job has not finished yet', async () => {
      getHistoryEntry.mock.mockImplementation(async () => ({
        id: jobId,
        task: 'exportReplication',
        state: 'active'
      }))

      const res = await app.inject({
        method: 'GET',
        url: `/replication/export/${jobId}/download`
      })

      assert.equal(res.statusCode, 409)
    })

    test('streams the finished tarball and deletes it once the stream closes', async () => {
      const filePath = path.join(dataPath, 'a-real-snapshot.tar.gz')
      const fileBody = Buffer.from('fake tarball bytes')
      await fsp.writeFile(filePath, fileBody)

      getHistoryEntry.mock.mockImplementation(async () => ({
        id: jobId,
        task: 'exportReplication',
        state: 'completed',
        result: { filePath, fileSize: fileBody.length }
      }))

      const res = await app.inject({
        method: 'GET',
        url: `/replication/export/${jobId}/download`
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-type'], 'application/gzip')
      assert.match(res.headers['content-disposition'] as string, /replication-export-.*\.tar\.gz/)
      assert.deepEqual(res.rawPayload, fileBody)

      // -> `stream.on('close', ...)` fires asynchronously relative to `inject()` resolving — poll
      //    briefly rather than assuming one tick is enough.
      for (let i = 0; i < 50 && deleteExport.mock.callCount() < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(deleteExport.mock.callCount(), 1)
      assert.equal(deleteExport.mock.calls[0]!.arguments[0], filePath)
      await assert.rejects(fs.promises.access(filePath))
    })

    test('404s when the completed job left no file behind on disk', async () => {
      const filePath = path.join(dataPath, 'never-written.tar.gz')
      getHistoryEntry.mock.mockImplementation(async () => ({
        id: jobId,
        task: 'exportReplication',
        state: 'completed',
        result: { filePath, fileSize: 123 }
      }))

      const res = await app.inject({
        method: 'GET',
        url: `/replication/export/${jobId}/download`
      })

      assert.equal(res.statusCode, 404)
    })
  })
})
