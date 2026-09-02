import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  createRecordingApp,
  listApiRouteFiles,
  recordRoutesFrom,
  referencesApiError,
  stubWikiForRegistration
} from './routeRecorder.ts'

const apiDir = path.join(import.meta.dirname, '../api')

stubWikiForRegistration()

describe('createRecordingApp', () => {
  test('records every method/path/options triple and no-ops the registration-time calls', () => {
    const { app, routes } = createRecordingApp()
    app.addHook('preHandler', () => {})
    app.addSchema({ $id: 'Thing' })
    app.addContentTypeParser('*', () => {})
    app.register(() => {})
    app.get('/a', { schema: { tags: ['A'] } })
    app.post('/b', { schema: { tags: ['B'] } })
    assert.deepEqual(
      routes.map((r) => `${r.method} ${r.path}`),
      ['get /a', 'post /b']
    )
    assert.deepEqual(routes[0]!.options.schema.tags, ['A'])
  })
})

describe('listApiRouteFiles', () => {
  const files = listApiRouteFiles(apiDir)

  test('finds every route file, and none of the ones that are not routes', () => {
    assert.ok(files.length >= 20, `expected at least 20 route files, found ${files.length}`)
    assert.ok(files.includes('pages.ts'))
    assert.ok(!files.includes('index.ts'))
    assert.ok(!files.some((f) => f.endsWith('.test.ts')))
    assert.ok(!files.some((f) => f.startsWith('schemas/')))
  })

  test('is sorted and free of duplicates, so a scan is reproducible', () => {
    assert.deepEqual(files, [...files].sort())
    assert.equal(new Set(files).size, files.length)
  })

  test('extra exclusions are honoured', () => {
    assert.ok(!listApiRouteFiles(apiDir, { exclude: ['sites.ts'] }).includes('sites.ts'))
  })
})

describe('recordRoutesFrom', () => {
  test('replays a real route file against the recorder', async () => {
    const routes = await recordRoutesFrom(apiDir, 'locales.ts')
    assert.ok(routes.length > 0)
    assert.ok(routes.every((r) => typeof r.path === 'string'))
  })
})

describe('referencesApiError', () => {
  test('sees a direct $ref, and one nested through allOf/oneOf', () => {
    assert.equal(referencesApiError({ $ref: 'ApiError#' }), true)
    assert.equal(referencesApiError({ allOf: [{ $ref: 'ApiError#' }] }), true)
    assert.equal(referencesApiError({ oneOf: [{ $ref: 'Other#' }, { $ref: 'ApiError#' }] }), true)
  })

  test('says no to anything else, undefined included', () => {
    assert.equal(referencesApiError(undefined), false)
    assert.equal(referencesApiError({ $ref: 'Site#' }), false)
    assert.equal(referencesApiError({ type: 'object' }), false)
  })
})
