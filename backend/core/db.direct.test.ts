import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { PoolConfig } from 'pg'

import { resolveDirectConnection } from './db.ts'

const fileConfig: PoolConfig = {
  host: 'pgbouncer.internal',
  user: 'wiki',
  password: 'secret',
  database: 'wiki',
  port: 6432,
  ssl: { rejectUnauthorized: true }
}

const urlConfig: PoolConfig = {
  connectionString: 'postgres://wiki:secret@pgbouncer.internal:6432/wiki'
}

describe('resolveDirectConnection()', () => {
  test('with nothing set, the listener connection is the query config itself', () => {
    const result = resolveDirectConnection(fileConfig, { queryFromUrl: false })

    assert.equal(result.config, fileConfig)
    assert.equal(result.source, null)
    assert.equal(result.ignoredDirectBlock, false)
  })

  test('an all-null db.direct block (the base.yml default) changes nothing', () => {
    const result = resolveDirectConnection(fileConfig, {
      direct: { host: null, port: null },
      queryFromUrl: false
    })

    assert.equal(result.config, fileConfig)
    assert.equal(result.source, null)
  })

  test('empty strings, as an unset $(VAR:) substitution leaves them, count as unset', () => {
    const result = resolveDirectConnection(fileConfig, {
      directUrl: '  ',
      direct: { host: '', port: '' },
      queryFromUrl: false
    })

    assert.equal(result.config, fileConfig)
    assert.equal(result.source, null)
  })

  test('db.direct overrides host and port only, keeping credentials, database and TLS', () => {
    const result = resolveDirectConnection(fileConfig, {
      direct: { host: 'postgres.internal', port: 5432 },
      queryFromUrl: false
    })

    assert.equal(result.source, 'db.direct')
    assert.deepEqual(result.config, {
      host: 'postgres.internal',
      user: 'wiki',
      password: 'secret',
      database: 'wiki',
      port: 5432,
      ssl: { rejectUnauthorized: true }
    })
  })

  test('db.direct with only a host keeps the query port, and a string port is parsed', () => {
    const hostOnly = resolveDirectConnection(fileConfig, {
      direct: { host: 'postgres.internal', port: null },
      queryFromUrl: false
    })
    assert.equal(hostOnly.config.host, 'postgres.internal')
    assert.equal(hostOnly.config.port, 6432)

    const portOnly = resolveDirectConnection(fileConfig, {
      direct: { host: null, port: '5432' },
      queryFromUrl: false
    })
    assert.equal(portOnly.config.host, 'pgbouncer.internal')
    assert.equal(portOnly.config.port, 5432)
  })

  test('a db.direct port that is not a port number refuses rather than connecting somewhere odd', () => {
    for (const port of ['abc', 0, 70000, '54.32']) {
      assert.throws(
        () =>
          resolveDirectConnection(fileConfig, {
            direct: { host: null, port },
            queryFromUrl: false
          }),
        /db\.direct\.port must be a port number/
      )
    }
  })

  test('DATABASE_DIRECT_URL is used as a whole connection string, inheriting only TLS', () => {
    const result = resolveDirectConnection(fileConfig, {
      directUrl: 'postgres://wiki:secret@postgres.internal:5432/wiki',
      queryFromUrl: false
    })

    assert.equal(result.source, 'DATABASE_DIRECT_URL')
    assert.deepEqual(result.config, {
      connectionString: 'postgres://wiki:secret@postgres.internal:5432/wiki',
      ssl: { rejectUnauthorized: true }
    })
  })

  test('DATABASE_DIRECT_URL wins over a db.direct block', () => {
    const result = resolveDirectConnection(fileConfig, {
      directUrl: 'postgres://wiki:secret@postgres.internal:5432/wiki',
      direct: { host: 'elsewhere.internal', port: 5433 },
      queryFromUrl: false
    })

    assert.equal(result.source, 'DATABASE_DIRECT_URL')
    assert.equal(
      result.config.connectionString,
      'postgres://wiki:secret@postgres.internal:5432/wiki'
    )
    assert.equal(result.config.host, undefined)
  })

  test('with DATABASE_URL in use, a db.direct block is ignored and reported, not half-applied', () => {
    const result = resolveDirectConnection(urlConfig, {
      direct: { host: 'postgres.internal', port: 5432 },
      queryFromUrl: true
    })

    assert.equal(result.config, urlConfig)
    assert.equal(result.source, null)
    assert.equal(result.ignoredDirectBlock, true)
  })

  test('with DATABASE_URL in use, DATABASE_DIRECT_URL still applies', () => {
    const result = resolveDirectConnection(urlConfig, {
      directUrl: 'postgres://wiki:secret@postgres.internal:5432/wiki',
      queryFromUrl: true
    })

    assert.equal(result.source, 'DATABASE_DIRECT_URL')
    assert.deepEqual(result.config, {
      connectionString: 'postgres://wiki:secret@postgres.internal:5432/wiki'
    })
  })
})
