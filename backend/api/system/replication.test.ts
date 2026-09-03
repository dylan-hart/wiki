import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import replicationRoutes from './replication.ts'
import { replicationImportModel } from '../../models/replicationImport.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Same shape as `transfer.test.ts`'s own `POST /import` coverage — the real `replicationRoutes`
 * plugin with the real `replicationImportModel` against a throwaway `dataPath`, so this proves the
 * archive actually lands on disk streamed (not buffered) and that `req.body` resolves to that path.
 * `WIKI.scheduler.addJob` and `WIKI.models.jobs` are mocked; a real restore is
 * `replicationImport.db.test.ts`'s concern.
 */
describe('POST /replication/import (streamed upload)', () => {
  let app: FastifyInstance
  let dataPath: string
  let addJob: ReturnType<typeof mock.fn>

  before(async () => {
    dataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-route-test-'))

    addJob = mock.fn(async () => ({ id: 'job-1' }))

    app = await buildTestApp({
      routes: replicationRoutes,
      ajv: true,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] },
      wiki: {
        ROOTPATH: process.cwd(),
        config: { dataPath },
        models: {
          replicationImport: replicationImportModel,
          auditLog: { record: async () => {} },
          jobs: { getHistoryEntry: async () => null, getPendingEntry: async () => null }
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
  })

  test('streams the upload straight to disk and queues a job pointing at the saved path, not a Buffer', async () => {
    const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    const body = Buffer.concat([
      gzipHeader,
      Buffer.from('a fake replication archive, not a real tarball')
    ])

    const res = await app.inject({
      method: 'POST',
      url: '/replication/import',
      headers: { 'content-type': 'application/gzip' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'Replication import queued successfully.',
      id: 'job-1'
    })

    assert.equal(addJob.mock.callCount(), 1)
    const call = addJob.mock.calls[0]!.arguments[0] as any
    assert.equal(call.task, 'replicationImport')
    assert.equal(typeof call.payload.filePath, 'string')
    assert.match(call.payload.filePath, /imports[/\\]replication[/\\].+\.tar\.gz$/)
    assert.deepEqual(await fsp.readFile(call.payload.filePath), body)
  })

  test('rejects a body whose first bytes are not gzip, and never queues a job for it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/replication/import',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from('not a gzip archive at all')
    })

    assert.equal(res.statusCode, 400)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('deletes the saved upload when the scheduler cannot queue the job', async () => {
    addJob.mock.mockImplementationOnce(async () => null)
    const before = await fsp
      .readdir(path.join(dataPath, 'imports', 'replication'))
      .catch(() => [] as string[])

    const res = await app.inject({
      method: 'POST',
      url: '/replication/import',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    })

    assert.equal(res.statusCode, 500)

    const afterFiles = await fsp.readdir(path.join(dataPath, 'imports', 'replication'))
    assert.equal(
      afterFiles.length,
      before.length,
      'expected the upload to have been deleted since the job could not be queued'
    )
  })
})

describe('GET /replication/import/:jobId', () => {
  let app: FastifyInstance
  let getHistoryEntry: ReturnType<typeof mock.fn>
  let getPendingEntry: ReturnType<typeof mock.fn>

  before(async () => {
    getHistoryEntry = mock.fn(async () => null)
    getPendingEntry = mock.fn(async () => null)

    app = await buildTestApp({
      routes: replicationRoutes,
      ajv: true,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] },
      wiki: {
        ROOTPATH: process.cwd(),
        config: { dataPath: '/tmp' },
        models: {
          replicationImport: replicationImportModel,
          auditLog: { record: async () => {} },
          jobs: { getHistoryEntry, getPendingEntry }
        },
        scheduler: { addJob: async () => ({ id: 'unused' }) }
      }
    })
  })

  after(async () => {
    await closeTestApp(app)
  })

  beforeEach(() => {
    getHistoryEntry.mock.resetCalls()
    getPendingEntry.mock.resetCalls()
  })

  test('reports the finished job with its restore counts', async () => {
    getHistoryEntry.mock.mockImplementationOnce(async () => ({
      task: 'replicationImport',
      state: 'completed',
      result: { sites: 1, pages: 3 }
    }))

    const res = await app.inject({
      method: 'GET',
      url: '/replication/import/00000000-0000-0000-0000-000000000001'
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { state: 'completed', result: { sites: 1, pages: 3 } })
  })

  test('reports queued when only pending, not yet in history', async () => {
    getPendingEntry.mock.mockImplementationOnce(async () => ({ task: 'replicationImport' }))

    const res = await app.inject({
      method: 'GET',
      url: '/replication/import/00000000-0000-0000-0000-000000000002'
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { state: 'queued', result: null })
  })

  test('404s when neither history nor a pending entry exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/replication/import/00000000-0000-0000-0000-000000000003'
    })

    assert.equal(res.statusCode, 404)
  })

  test('404s when the job id belongs to a different task', async () => {
    getHistoryEntry.mock.mockImplementationOnce(async () => ({
      task: 'exportContent',
      state: 'completed',
      result: {}
    }))

    const res = await app.inject({
      method: 'GET',
      url: '/replication/import/00000000-0000-0000-0000-000000000004'
    })

    assert.equal(res.statusCode, 404)
  })
})
