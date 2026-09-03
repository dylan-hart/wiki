import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import systemRoutes from './index.ts'
import { importModel } from '../../models/siteImport.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

/**
 * Task 2213: `POST /import`'s content-type parser used to be `parseAs: 'buffer'`, materialising the
 * whole archive as one in-memory `Buffer` before a single byte reached `<dataPath>/imports/`. It now
 * has no `parseAs` at all, which is what hands the parser the raw request stream instead — this
 * suite runs the real `systemRoutes` plugin with the real `importModel` (against a throwaway
 * `dataPath`) rather than mocking either, so what it actually asserts is that the archive lands on
 * disk at all, with the exact bytes sent, and that `req.body` resolves to that file's path rather
 * than a `Buffer` — the architectural change this task made. Only `WIKI.models.sites.getSiteById` and
 * `WIKI.scheduler.addJob` are mocked, since a real target site and a real job queue are their own
 * suites' concerns.
 */
describe('POST /import (streamed upload)', () => {
  let app: FastifyInstance
  let dataPath: string
  let currentSite: any
  let getSiteById: ReturnType<typeof mock.fn>
  let addJob: ReturnType<typeof mock.fn>

  before(async () => {
    dataPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'wiki-import-route-test-'))

    getSiteById = mock.fn(async () => currentSite)
    addJob = mock.fn(async () => ({ id: 'job-1' }))

    app = await buildTestApp({
      routes: systemRoutes,
      ajv: true,
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] },
      wiki: {
        ROOTPATH: process.cwd(),
        config: { dataPath },
        models: {
          sites: { getSiteById },
          import: importModel,
          auditLog: { record: async () => {} }
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
    currentSite = { id: 'site-1' }
    getSiteById.mock.resetCalls()
    addJob.mock.resetCalls()
  })

  test('streams the upload straight to disk and queues a job pointing at the saved path, not a Buffer', async () => {
    const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    const body = Buffer.concat([gzipHeader, Buffer.from('a fake archive body, not a real tarball')])

    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000001',
      headers: { 'content-type': 'application/gzip' },
      payload: body
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      ok: true,
      message: 'Content import queued successfully.',
      id: 'job-1'
    })

    assert.equal(addJob.mock.callCount(), 1)
    const jobPayload = (addJob.mock.calls[0]!.arguments[0] as any).payload
    // -> The content-type parser resolved `req.body` (what `addJob`'s payload carries as `filePath`)
    //    to a string path on disk, never a `Buffer` -- proof the archive was streamed to
    //    `<dataPath>/imports/` rather than held whole in the request thread's memory.
    assert.equal(typeof jobPayload.filePath, 'string')
    assert.match(jobPayload.filePath, /imports[/\\].+\.tar\.gz$/)
    assert.deepEqual(await fsp.readFile(jobPayload.filePath), body)
  })

  test('rejects a body whose first bytes are not gzip, and never queues a job for it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000001',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from('not a gzip archive at all')
    })

    assert.equal(res.statusCode, 400)
    assert.equal(addJob.mock.callCount(), 0)
  })

  test('deletes the saved upload when the target site does not exist, and never queues a job', async () => {
    currentSite = null
    const before = await fsp.readdir(path.join(dataPath, 'imports')).catch(() => [] as string[])

    const res = await app.inject({
      method: 'POST',
      url: '/import?targetSiteId=00000000-0000-0000-0000-000000000002',
      headers: { 'content-type': 'application/gzip' },
      payload: Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    })

    assert.equal(res.statusCode, 404)
    assert.equal(addJob.mock.callCount(), 0)

    const after = await fsp.readdir(path.join(dataPath, 'imports'))
    assert.equal(
      after.length,
      before.length,
      'expected the upload to have been deleted since the target site does not exist'
    )
  })
})
