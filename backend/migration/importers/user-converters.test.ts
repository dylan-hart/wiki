import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { composeUserConverters, createLocalUserConverter } from './user-converters.ts'

const LOCAL_STRATEGY_ID = 'local-uuid'

describe('createLocalUserConverter', () => {
  const convert = createLocalUserConverter({ localStrategyId: LOCAL_STRATEGY_ID })

  test('copies the source bcrypt hash verbatim', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      providerKey: 'local'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    const authEntry = (outcome.row.auth as any)[LOCAL_STRATEGY_ID]
    assert.equal(authEntry.password, '$2a$12$fakehash')
  })

  test('flags a local user with no password hash to carry over, rather than minting one', async () => {
    const outcome = await convert({ email: 'a@b.com', name: 'A', providerKey: 'local' })

    assert.equal(outcome.status, 'flagged')
    assert.match((outcome as any).message, /password hash/)
  })

  test('skips a record with no email address', async () => {
    const outcome = await convert({ name: 'A', password: '$2a$12$fakehash', providerKey: 'local' })

    assert.equal(outcome.status, 'skipped')
    assert.match((outcome as any).message, /email/)
  })

  test('lowercases the email and falls back to it for name when the source has none', async () => {
    const outcome = await convert({ email: 'Mixed.Case@Example.com', password: '$2a$12$fakehash' })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.email, 'mixed.case@example.com')
    assert.equal(outcome.row.name, 'mixed.case@example.com')
  })

  test('widens mustChangePwd/isActive/isVerified to accept an export-bundle integer 0/1 (OpenProject #1845/#1850)', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      mustChangePwd: 1,
      isActive: 1,
      isVerified: 0
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal((outcome.row.auth as any)[LOCAL_STRATEGY_ID].mustChangePwd, true)
    assert.equal(outcome.row.isActive, true)
    assert.equal(outcome.row.isVerified, false)
  })

  test('degrades a malformed source timestamp to undefined rather than failing the whole record', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      createdAt: 'not-a-date'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.equal(outcome.row.createdAt, undefined)
  })

  test('carries an ISO-string createdAt over (export-bundle connector shape) same as a real Date', async () => {
    const outcome = await convert({
      email: 'a@b.com',
      name: 'A',
      password: '$2a$12$fakehash',
      createdAt: '2020-01-02T03:04:05.000Z'
    })

    assert.equal(outcome.status, 'created')
    if (outcome.status !== 'created') return
    assert.deepEqual(outcome.row.createdAt, new Date('2020-01-02T03:04:05.000Z'))
  })
})

describe('composeUserConverters', () => {
  test("routes a 'local' providerKey to the local converter", async () => {
    let localCalls = 0
    let fallbackCalls = 0
    const local = (() => {
      localCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const fallback = (() => {
      fallbackCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const convert = composeUserConverters(local, fallback)

    await convert({ providerKey: 'local' })

    assert.equal(localCalls, 1)
    assert.equal(fallbackCalls, 0)
  })

  test('routes every other providerKey to the fallback converter', async () => {
    let localCalls = 0
    let fallbackCalls = 0
    const local = (() => {
      localCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const fallback = (() => {
      fallbackCalls++
      return { status: 'created', row: {} } as const
    }) as any
    const convert = composeUserConverters(local, fallback)

    await convert({ providerKey: 'github' })
    await convert({}) // -> no providerKey at all also routes to fallback, not local

    assert.equal(localCalls, 0)
    assert.equal(fallbackCalls, 2)
  })
})
