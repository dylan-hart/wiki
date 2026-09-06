import { describe, test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as notifyEventSubscriptionSubscribers } from './notify-event-subscription-subscribers.ts'
import type { NotifyEventSubscriptionSubscribersPayload } from './notify-event-subscription-subscribers.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * OpenProject #2484: unit coverage for this task's own branching (per-recipient resolution, the send
 * loop, per-recipient failure isolation) against a stubbed model layer — mirrors
 * `tasks/simple/notify-page-watchers.test.ts`'s own suite for the sibling page-watch task. Combined
 * with `models/hooks.test.ts`'s DB-backed "event-subscriber fan-out" suite (which proves a subscribed
 * user gets queued here and an unsubscribed one does not), this covers the WP's full subscribe →
 * trigger → send path: hooks.test.ts for who gets queued, this file for what happens to them once
 * queued.
 */

let wikiHandle: { restore(): void }
let getById: ReturnType<typeof mock.fn>
let sendEventSubscriptionNotification: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>
let loggerDebug: ReturnType<typeof mock.fn>

function payload(
  overrides: Partial<NotifyEventSubscriptionSubscribersPayload> = {}
): NotifyEventSubscriptionSubscribersPayload {
  return {
    event: 'page:edit',
    data: { id: 'page-1' },
    subscriberIds: ['subscriber-1'],
    ...overrides
  }
}

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  getById = mock.fn(async (id: string) => ({ id, name: 'Someone', email: `${id}@example.com` }))
  sendEventSubscriptionNotification = mock.fn(async () => {})
  loggerError = mock.fn()
  loggerDebug = mock.fn()
  wikiHandle = installTestWiki({
    logger: { info: mock.fn(), warn: mock.fn(), error: loggerError, debug: loggerDebug },
    models: {
      users: { getById },
      mail: { sendEventSubscriptionNotification }
    }
  })
})

describe('notify-event-subscription-subscribers task', () => {
  test('no payload is a no-op', async () => {
    await notifyEventSubscriptionSubscribers()
    assert.equal(sendEventSubscriptionNotification.mock.calls.length, 0)
  })

  test('an empty subscriberIds list is a no-op', async () => {
    await notifyEventSubscriptionSubscribers(payload({ subscriberIds: [] }))
    assert.equal(sendEventSubscriptionNotification.mock.calls.length, 0)
  })

  test('sends one notification per subscriber, to their resolved email', async () => {
    await notifyEventSubscriptionSubscribers(payload({ subscriberIds: ['user-a', 'user-b'] }))

    assert.equal(sendEventSubscriptionNotification.mock.calls.length, 2)
    const recipients = sendEventSubscriptionNotification.mock.calls
      .map((call) => (call.arguments[0] as any).to)
      .sort()
    assert.deepEqual(recipients, ['user-a@example.com', 'user-b@example.com'])
  })

  test('passes the event through to the mail call', async () => {
    await notifyEventSubscriptionSubscribers(
      payload({ event: 'comment:new', subscriberIds: ['user-a'] })
    )

    assert.equal(
      (sendEventSubscriptionNotification.mock.calls[0]!.arguments[0] as any).event,
      'comment:new'
    )
  })

  // -> `debug`, not `warn`, since the Phase 2 sweep (#2665): recurs every run for the same account.
  test('a subscriber with no email address is skipped, at debug, and does not stop the rest', async () => {
    getById.mock.mockImplementation(async (id: string) =>
      id === 'no-email'
        ? { id, name: 'No Email', email: null }
        : { id, name: 'Someone', email: `${id}@example.com` }
    )

    await notifyEventSubscriptionSubscribers(payload({ subscriberIds: ['no-email', 'has-email'] }))

    assert.equal(sendEventSubscriptionNotification.mock.calls.length, 1)
    assert.equal(
      (sendEventSubscriptionNotification.mock.calls[0]!.arguments[0] as any).to,
      'has-email@example.com'
    )
    assert.equal(loggerDebug.mock.calls.length, 1)
    assert.equal(loggerDebug.mock.calls[0]!.arguments[0], 'hooks')
  })

  test('one subscriber whose send fails does not stop a second subscriber from being sent to', async () => {
    sendEventSubscriptionNotification.mock.mockImplementationOnce(async () => {
      throw new Error('SMTP unreachable')
    })

    await notifyEventSubscriptionSubscribers(payload({ subscriberIds: ['fails', 'succeeds'] }))

    assert.equal(sendEventSubscriptionNotification.mock.calls.length, 2)
    // -> One record per failure, not the old sentence-plus-message pair.
    assert.equal(loggerError.mock.calls.length, 1)
    const [scope, message, fields] = loggerError.mock.calls[0]!.arguments as [string, string, any]
    assert.equal(scope, 'hooks')
    assert.equal(message, 'failed to send event-subscription notification')
    assert.ok(fields.error instanceof Error)
  })
})
