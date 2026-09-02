import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRules } from './approvalRules.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * One schema for the whole file rather than one per describe (TEST-F14): every `setupTestDb()` call
 * is a `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same
 * fixture. Anything a describe needs on top of that stays in its own `before()`.
 *
 * The `hasTestDatabase()` guard below is what a per-describe `{ skip }` cannot do for a FILE-level
 * hook: `describe(..., { skip })` skips the describe's own hooks and tests, but a root `before()`
 * runs regardless, so without this an unset `DATABASE_URL` would report every describe skipped AND
 * still throw out of the hook. Same shape as `models/contentSync.test.ts`'s own file-level fixture.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

/**
 * OpenProject #966: same fix, and the same reasoning, as `models/groups.ts`'s
 * `groups.broadcastReload` suite — `createRule`/`updateRule`/`deleteRule` used to call
 * `reloadCache()` directly, refreshing only this instance's own cache. See that suite's doc comment
 * for the full writeup; this one just re-proves the wiring for the approvals model.
 */
describe('approvalRules.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let approvalsModel: typeof import('./approvals.ts').approvals

  before(async () => {
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
  })

  test('createRule broadcasts reloadApprovals after refreshing this instance', async () => {
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.createRule(fixtures.siteId, {
      name: 'broadcast create',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('updateRule broadcasts reloadApprovals after refreshing this instance', async () => {
    const rule = await approvalRules.createRule(fixtures.siteId, {
      name: 'broadcast update',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.updateRule(fixtures.siteId, rule.id, { isEnabled: false })
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('deleteRule broadcasts reloadApprovals after refreshing this instance', async () => {
    const rule = await approvalRules.createRule(fixtures.siteId, {
      name: 'broadcast delete',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    ;(WIKI.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.deleteRule(fixtures.siteId, rule.id)
    const calls = (WIKI.events.outbound.emit as any).mock.calls
    assert.ok(calls.some((c: any) => c.arguments[0] === 'reloadApprovals'))
  })

  test('subscribeToEvents wires the inbound reloadApprovals event to reloadCache', async () => {
    let reloaded = false
    const originalReloadCache = approvalRules.reloadCache.bind(approvalsModel)
    approvalRules.reloadCache = async () => {
      reloaded = true
      await originalReloadCache()
    }
    try {
      approvalRules.subscribeToEvents()
      const onCalls = (WIKI.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadApprovals')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadApprovals handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      approvalRules.reloadCache = originalReloadCache
    }
  })
})
