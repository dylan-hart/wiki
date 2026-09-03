import { after, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { task as notifyEventSubscribers } from './notify-event-subscribers.ts'
import type { NotifyEventSubscribersPayload } from './notify-event-subscribers.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * Task 2481: unit coverage for this task's own branching — the "no recipient email, skip and warn"
 * guard, per-recipient failure isolation, and what it actually hands `mail.sendEventNotification`.
 * The subscriber list it iterates was already resolved by `models/hooks.ts#Hooks.emit()` before
 * queueing (see that method's own doc comment for why), so this task does no subscription lookup of
 * its own to stub around.
 */

let wikiHandle: { restore(): void }
let getById: ReturnType<typeof mock.fn>
let sendEventNotification: ReturnType<typeof mock.fn>
let loggerError: ReturnType<typeof mock.fn>
let loggerWarn: ReturnType<typeof mock.fn>

function payload(
  overrides: Partial<NotifyEventSubscribersPayload> = {}
): NotifyEventSubscribersPayload {
  return {
    event: 'page:create',
    siteId: 'site-1',
    data: { id: 'page-1', path: 'docs/getting-started' },
    subscribers: [{ userId: 'user-1' }],
    ...overrides
  }
}

after(() => {
  wikiHandle.restore()
})

beforeEach(() => {
  getById = mock.fn(async (id: string) => ({
    id,
    email: `${id}@example.com`,
    prefs: { locale: 'en' }
  }))
  sendEventNotification = mock.fn(async () => {})
  loggerError = mock.fn()
  loggerWarn = mock.fn()
  wikiHandle = installTestWiki({
    logger: { info: mock.fn(), warn: loggerWarn, error: loggerError, debug: mock.fn() },
    models: {
      users: { getById },
      mail: { sendEventNotification }
    }
  })
})

describe('notify-event-subscribers task', () => {
  test('no payload is a no-op', async () => {
    await notifyEventSubscribers()
    assert.equal(sendEventNotification.mock.calls.length, 0)
  })

  test('an empty subscriber list is a no-op', async () => {
    await notifyEventSubscribers(payload({ subscribers: [] }))
    assert.equal(sendEventNotification.mock.calls.length, 0)
  })

  test('sends one email per subscriber, in their own locale', async () => {
    getById.mock.mockImplementation(async (id: string) => ({
      id,
      email: `${id}@example.com`,
      prefs: { locale: id === 'user-2' ? 'fr' : 'en' }
    }))

    await notifyEventSubscribers(
      payload({ subscribers: [{ userId: 'user-1' }, { userId: 'user-2' }] })
    )

    assert.equal(sendEventNotification.mock.calls.length, 2)
    const calls = sendEventNotification.mock.calls.map((call) => call.arguments[0] as any)
    assert.equal(calls[0].to, 'user-1@example.com')
    assert.equal(calls[0].locale, 'en')
    assert.equal(calls[1].to, 'user-2@example.com')
    assert.equal(calls[1].locale, 'fr')
  })

  test('passes the event, siteId and data straight through to sendEventNotification', async () => {
    await notifyEventSubscribers(
      payload({
        event: 'comment:new',
        siteId: 'site-2',
        data: { id: 'comment-1', pageId: 'page-1' }
      })
    )

    const call = sendEventNotification.mock.calls[0]!.arguments[0] as any
    assert.equal(call.event, 'comment:new')
    assert.equal(call.siteId, 'site-2')
    assert.deepEqual(call.data, { id: 'comment-1', pageId: 'page-1' })
  })

  test('skips a subscriber with no email on file, without failing the rest of the batch', async () => {
    getById.mock.mockImplementation(async (id: string) =>
      id === 'user-1'
        ? { id, email: null, prefs: {} }
        : { id, email: `${id}@example.com`, prefs: {} }
    )

    await notifyEventSubscribers(
      payload({ subscribers: [{ userId: 'user-1' }, { userId: 'user-2' }] })
    )

    assert.equal(sendEventNotification.mock.calls.length, 1)
    assert.equal(
      (sendEventNotification.mock.calls[0]!.arguments[0] as any).to,
      'user-2@example.com'
    )
    assert.equal(loggerWarn.mock.calls.length, 1)
  })

  test('a failed send is logged and does not stop the rest of the batch', async () => {
    sendEventNotification.mock.mockImplementation(async (opts: any) => {
      if (opts.to === 'user-1@example.com') {
        throw new Error('SMTP unavailable')
      }
    })

    await notifyEventSubscribers(
      payload({ subscribers: [{ userId: 'user-1' }, { userId: 'user-2' }] })
    )

    assert.equal(sendEventNotification.mock.calls.length, 2)
    assert.equal(loggerError.mock.calls.length, 2)
  })
})
