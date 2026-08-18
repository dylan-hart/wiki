import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseVerifyArgs } from './verify-cli.ts'

describe('parseVerifyArgs', () => {
  test('parses a live Postgres source with defaults', () => {
    const args = parseVerifyArgs([
      '--site-id',
      'site-1',
      '--source-host',
      'db.internal',
      '--source-database',
      'wiki25',
      '--source-user',
      'wiki',
      '--source-password',
      'secret'
    ])
    assert.deepEqual(args, {
      source: {
        kind: 'postgres',
        config: {
          host: 'db.internal',
          port: 5432,
          database: 'wiki25',
          user: 'wiki',
          password: 'secret',
          ssl: undefined
        }
      },
      siteId: 'site-1',
      sampleSize: 20
    })
  })

  test('parses an export-bundle source', () => {
    const args = parseVerifyArgs(['--site-id', 'site-1', '--bundle-path', '/exports/2025-01-01'])
    assert.deepEqual(args.source, { kind: 'export-bundle', path: '/exports/2025-01-01' })
  })

  test('defaults --sample-size to 20', () => {
    const args = parseVerifyArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    assert.equal(args.sampleSize, 20)
  })

  test('parses a custom --sample-size', () => {
    const args = parseVerifyArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--sample-size',
      '50'
    ])
    assert.equal(args.sampleSize, 50)
  })

  test('rejects a non-numeric --sample-size', () => {
    assert.throws(() =>
      parseVerifyArgs([
        '--site-id',
        'site-1',
        '--bundle-path',
        '/bundle',
        '--sample-size',
        'not-a-number'
      ])
    )
  })

  test('rejects a zero or negative --sample-size', () => {
    assert.throws(() =>
      parseVerifyArgs(['--site-id', 'site-1', '--bundle-path', '/bundle', '--sample-size', '0'])
    )
  })

  test('parses --sample-paths into an array', () => {
    const args = parseVerifyArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--sample-paths',
      'en/home,en/about'
    ])
    assert.deepEqual(args.samplePaths, ['en/home', 'en/about'])
  })

  test('omits samplePaths entirely when --sample-paths is not given', () => {
    const args = parseVerifyArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    assert.equal('samplePaths' in args, false)
  })

  test('parses --against-report', () => {
    const args = parseVerifyArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--against-report',
      '/tmp/dry-run-report.json'
    ])
    assert.equal(args.againstReport, '/tmp/dry-run-report.json')
  })

  test('omits againstReport entirely when --against-report is not given', () => {
    const args = parseVerifyArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    assert.equal('againstReport' in args, false)
  })

  test('requires --site-id', () => {
    assert.throws(() => parseVerifyArgs(['--bundle-path', '/bundle']))
  })

  test('rejects when neither a bundle path nor Postgres source fields are given', () => {
    assert.throws(() => parseVerifyArgs(['--site-id', 'site-1']), /No source given/)
  })

  test('rejects an incomplete Postgres source', () => {
    assert.throws(
      () =>
        parseVerifyArgs([
          '--site-id',
          'site-1',
          '--source-host',
          'db.internal',
          '--source-database',
          'wiki25'
        ]),
      /Incomplete Postgres source.*--source-user.*--source-password/s
    )
  })
})
