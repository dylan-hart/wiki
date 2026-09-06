import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readyFields, workerInstanceId } from './bootSummary.ts'

/**
 * The two derivations `index.ts` and `worker.ts` feed to `WIKI.logger`. Pure by construction — no
 * `WIKI` global, no database — which is the whole reason they were lifted out of two entry points
 * that boot at import time and can never be imported by a test.
 */
describe('readyFields', () => {
  test('counts the sites and reports the first addressable hostname', () => {
    const fields = readyFields({
      sites: {
        'id-a': { hostname: 'docs.example.com' },
        'id-b': { hostname: 'wiki.example.com' }
      },
      bindIP: '0.0.0.0',
      port: 3000,
      ms: 1234
    })
    assert.deepEqual(fields, { sites: 2, url: 'docs.example.com', ms: 1234 })
  })

  test('skips the catch-all `*` site in favour of a real hostname, since `*` is not an address', () => {
    const fields = readyFields({
      sites: {
        'id-default': { hostname: '*' },
        'id-docs': { hostname: 'docs.example.com' }
      },
      bindIP: '0.0.0.0',
      port: 3000,
      ms: 10
    })
    assert.equal(fields.url, 'docs.example.com')
    // -> The skipped site is still counted: `sites=` is how many exist, not how many are named.
    assert.equal(fields.sites, 2)
  })

  test('falls back to the bound socket on a fresh install, whose only site is the catch-all', () => {
    const fields = readyFields({
      sites: { 'id-default': { hostname: '*' } },
      bindIP: '0.0.0.0',
      port: 3000,
      ms: 10
    })
    assert.deepEqual(fields, { sites: 1, url: '0.0.0.0:3000', ms: 10 })
  })

  test('falls back to the bound socket when no site has loaded at all', () => {
    const fields = readyFields({ sites: {}, bindIP: '127.0.0.1', port: '8080', ms: 0 })
    assert.deepEqual(fields, { sites: 0, url: '127.0.0.1:8080', ms: 0 })
  })

  test('tolerates a site row with no hostname rather than reporting `undefined` as a url', () => {
    const fields = readyFields({
      sites: { 'id-a': { hostname: null }, 'id-b': {} },
      bindIP: '0.0.0.0',
      port: 3000,
      ms: 5
    })
    assert.equal(fields.url, '0.0.0.0:3000')
  })

  test('passes `ms` through as a number, which the renderer needs to format it as a duration', () => {
    const fields = readyFields({ sites: {}, bindIP: '0.0.0.0', port: 3000, ms: 2500 })
    assert.equal(typeof fields.ms, 'number')
    assert.equal(fields.ms, 2500)
  })
})

describe('workerInstanceId', () => {
  test('joins the parent instance id and the thread ordinal', () => {
    assert.equal(workerInstanceId('a1b2c3d4e5', 3), 'a1b2c3d4e5/w3')
  })

  test('falls back to `worker` when there is no parent, as a pool-less worker has none', () => {
    assert.equal(workerInstanceId(undefined, 1), 'worker/w1')
    assert.equal(workerInstanceId(null, 1), 'worker/w1')
  })

  test('treats an empty or non-string parent id as absent rather than rendering it', () => {
    assert.equal(workerInstanceId('', 2), 'worker/w2')
    assert.equal(workerInstanceId(42, 2), 'worker/w2')
  })

  test('two threads of the same parent get distinct ids', () => {
    const parent = 'a1b2c3d4e5'
    assert.notEqual(workerInstanceId(parent, 1), workerInstanceId(parent, 2))
  })
})
