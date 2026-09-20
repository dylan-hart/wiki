import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRules } from './approvalRules.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * The guard inside the file-level hook is what a per-describe `{ skip }` cannot do: a root
 * `before()` runs even when every describe is skipped, so without it an unset `DATABASE_URL` throws
 * out of the hook.
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

// A mutator that reloads its own cache instead of broadcasting leaves every other instance stale.
describe('approvalRules.broadcastReload (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let approvalsModel: typeof import('./approvals.ts').approvals

  before(async () => {
    ;({ approvals: approvalsModel } = await import('./approvals.ts'))
  })

  test('createRule broadcasts reloadApprovals after refreshing this instance', async () => {
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.createRule(fixtures.siteId, {
      name: 'broadcast create',
      isEnabled: true,
      match: 'START',
      path: '',
      submitterGroups: [],
      reviewerGroups: [fixtures.groupId]
    })
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
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
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.updateRule(fixtures.siteId, rule.id, { isEnabled: false })
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
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
    ;(CARDINAL.events.outbound.emit as any).mock.resetCalls()
    await approvalRules.deleteRule(fixtures.siteId, rule.id)
    const calls = (CARDINAL.events.outbound.emit as any).mock.calls
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
      const onCalls = (CARDINAL.events.inbound.on as any).mock.calls
      const handler = onCalls.find((c: any) => c.arguments[0] === 'reloadApprovals')?.arguments[1]
      assert.ok(handler, 'expected subscribeToEvents to register a reloadApprovals handler')
      await handler()
      assert.equal(reloaded, true)
    } finally {
      approvalRules.reloadCache = originalReloadCache
    }
  })
})
