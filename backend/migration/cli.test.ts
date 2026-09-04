import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseMigrationArgs } from './cli.ts'

describe('parseMigrationArgs', () => {
  test('parses a live Postgres source with defaults', () => {
    const args = parseMigrationArgs([
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
      dryRun: false,
      only: undefined,
      renderMode: 'auto'
    })
  })

  test('parses --source-port and --source-ssl', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--source-host',
      'db.internal',
      '--source-port',
      '55432',
      '--source-database',
      'wiki25',
      '--source-user',
      'wiki',
      '--source-password',
      'secret',
      '--source-ssl'
    ])
    assert.equal(args.source.kind, 'postgres')
    assert.equal(args.source.kind === 'postgres' && args.source.config.port, 55432)
    assert.equal(args.source.kind === 'postgres' && args.source.config.ssl, true)
  })

  test('parses an export-bundle source', () => {
    const args = parseMigrationArgs(['--site-id', 'site-1', '--bundle-path', '/exports/2025-01-01'])
    assert.deepEqual(args.source, { kind: 'export-bundle', path: '/exports/2025-01-01' })
  })

  test('parses --dry-run', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--dry-run'
    ])
    assert.equal(args.dryRun, true)
  })

  test('parses --only into a phase id array', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--only',
      'content,users'
    ])
    assert.deepEqual(args.only, ['content', 'users'])
  })

  test('rejects an unknown --only phase id', () => {
    assert.throws(
      () =>
        parseMigrationArgs([
          '--site-id',
          'site-1',
          '--bundle-path',
          '/bundle',
          '--only',
          'comments'
        ]),
      /Unknown phase\(s\) in --only: comments/
    )
  })

  test('requires --site-id', () => {
    assert.throws(() => parseMigrationArgs(['--bundle-path', '/bundle']))
  })

  test('rejects when neither a bundle path nor Postgres source fields are given', () => {
    assert.throws(() => parseMigrationArgs(['--site-id', 'site-1']), /No source given/)
  })

  test('rejects an incomplete Postgres source', () => {
    assert.throws(
      () =>
        parseMigrationArgs([
          '--site-id',
          'site-1',
          '--source-host',
          'db.internal',
          '--source-database',
          'wiki25'
          // missing --source-user / --source-password
        ]),
      /Incomplete Postgres source.*--source-user.*--source-password/s
    )
  })

  test('parses --report-file', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--report-file',
      '/tmp/report.json'
    ])
    assert.equal(args.reportFile, '/tmp/report.json')
  })

  test('omits reportFile entirely when --report-file is not given', () => {
    const args = parseMigrationArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    assert.equal('reportFile' in args, false)
  })

  test('defaults --render-mode to "auto"', () => {
    const args = parseMigrationArgs(['--site-id', 'site-1', '--bundle-path', '/bundle'])
    assert.equal(args.renderMode, 'auto')
  })

  test('parses an explicit --render-mode', () => {
    const args = parseMigrationArgs([
      '--site-id',
      'site-1',
      '--bundle-path',
      '/bundle',
      '--render-mode',
      'passthrough'
    ])
    assert.equal(args.renderMode, 'passthrough')
  })

  test('rejects an unknown --render-mode', () => {
    assert.throws(
      () =>
        parseMigrationArgs([
          '--site-id',
          'site-1',
          '--bundle-path',
          '/bundle',
          '--render-mode',
          'sometimes'
        ]),
      /Unknown --render-mode "sometimes"/
    )
  })

  test('rejects a non-numeric --source-port', () => {
    assert.throws(() =>
      parseMigrationArgs([
        '--site-id',
        'site-1',
        '--source-host',
        'db.internal',
        '--source-port',
        'not-a-port',
        '--source-database',
        'wiki25',
        '--source-user',
        'wiki',
        '--source-password',
        'secret'
      ])
    )
  })
})
