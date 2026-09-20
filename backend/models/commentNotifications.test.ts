import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { extractMentionCandidates } from '../helpers/mentions.ts'
import { pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { createSilentLogger, installTestWiki } from '../test/mocks.ts'
import { commentNotifications } from './commentNotifications.ts'

function stringParams(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    found.push(node)
  } else if (Array.isArray(node)) {
    for (const item of node) {
      stringParams(item, found)
    }
  } else if (node && typeof node === 'object') {
    const { queryChunks, value } = node as { queryChunks?: unknown; value?: unknown }
    if (typeof value === 'string') {
      found.push(value)
    }
    if (queryChunks) {
      stringParams(queryChunks, found)
    }
  }
  return found
}

interface FakeUser {
  id: string
  handle: string
  email: string | null
  prefs: Record<string, unknown> | null
}

const ANN: FakeUser = { id: 'u-ann', handle: 'Ann', email: 'ann@example.com', prefs: null }
const BOB: FakeUser = {
  id: 'u-bob',
  handle: 'bob',
  email: 'bob@example.com',
  prefs: { locale: 'fr' }
}
const CARA: FakeUser = { id: 'u-cara', handle: 'cara', email: 'cara@example.com', prefs: null }

describe('commentNotifications.notifyMentions', () => {
  let wiki: { restore(): void }
  let users: FakeUser[]
  let page: Record<string, unknown> | null
  let deniedByUser: Record<string, string[]>
  let subscribers: Record<string, string[]>
  let sent: Record<string, any>[]
  let sendFailures: Set<string>
  let warn: ReturnType<typeof mock.fn>
  let userLookupError: Error | null

  function makeDb() {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: (where: unknown) => ({
            limit: async () => {
              if (table === usersTable) {
                if (userLookupError) {
                  throw userLookupError
                }
                const handles = stringParams(where)
                return users
                  .filter((user) => handles.includes(user.handle.toLowerCase()))
                  .map(({ handle: _handle, ...rest }) => rest)
              }
              if (table === pagesTable) {
                return page ? [page] : []
              }
              return []
            }
          })
        })
      })
    }
  }

  beforeEach(() => {
    users = [ANN, BOB, CARA]
    page = {
      path: 'guides/intro',
      locale: 'en',
      tags: [],
      classification: null,
      title: 'Intro <Guide>'
    }
    deniedByUser = {}
    subscribers = { 'comment:new': [], 'comment:edit': [] }
    sent = []
    sendFailures = new Set()
    userLookupError = null
    warn = mock.fn()

    wiki = installTestWiki({
      db: makeDb(),
      logger: { ...createSilentLogger(), warn },
      sites: { s1: { config: { title: 'Team & Wiki' } } },
      models: {
        comments: {
          resolveMentions: async (_siteId: string, content: string) => {
            const known = new Map(users.map((user) => [user.handle.toLowerCase(), user.handle]))
            const resolved = new Map<string, string>()
            for (const candidate of extractMentionCandidates(content)) {
              const handle = known.get(candidate)
              if (handle) {
                resolved.set(candidate, handle)
              }
            }
            return resolved
          }
        },
        users: {
          listEmailSubscribers: async (event: string) =>
            (subscribers[event] ?? []).map((id) => ({ id }))
        },
        groups: {
          actorForUserId: async (userId: string) => ({ userId, groupIds: [], permissions: [] }),
          checkAccess: (actor: { userId: string }, permission: string) =>
            !(deniedByUser[actor.userId] ?? []).includes(permission)
        },
        mail: {
          resolveMailBaseURL: () => 'https://wiki.example.com',
          buildLink: (path: string, base: string) => `${base}${path}`,
          send: async (message: Record<string, any>) => {
            if (sendFailures.has(message.userId)) {
              throw new Error('smtp down')
            }
            sent.push(message)
          }
        },
        locales: {
          resolveString: async (locale: string | undefined, key: string, params: any = {}) =>
            `${locale ?? 'default'}|${key}|${params.author}|${params.title}|${params.site}|${params.link}`
        }
      }
    })
  })

  afterEach(() => {
    wiki.restore()
  })

  function comment(overrides: Record<string, unknown> = {}) {
    return {
      id: 'c1',
      siteId: 's1',
      pageId: 'p1',
      authorId: 'u-author',
      content: 'hello',
      ...overrides
    } as any
  }

  it('mails each distinct mentioned user once, however often they are named', async () => {
    await commentNotifications.notifyMentions({
      comment: comment({ content: 'cc @ann @bob and again @ann, plus @ANN' }),
      authorName: 'Dana'
    })

    assert.deepEqual(sent.map((message) => message.to).sort(), [
      'ann@example.com',
      'bob@example.com'
    ])
    assert.ok(sent.every((message) => message.kind === 'commentMention'))
    assert.ok(sent.every((message) => message.userId !== undefined))
  })

  it('mails nobody when nothing resolves to a user', async () => {
    await commentNotifications.notifyMentions({
      comment: comment({ content: 'cc @nobody and a@b.com' }),
      authorName: 'Dana'
    })

    assert.equal(sent.length, 0)
  })

  it('never mails the comment author about their own mention', async () => {
    await commentNotifications.notifyMentions({
      comment: comment({ authorId: ANN.id, content: 'note to self @ann, and @bob' }),
      authorName: 'Ann'
    })

    assert.deepEqual(
      sent.map((message) => message.to),
      ['bob@example.com']
    )
  })

  it('skips a mentioned account with no email address on file', async () => {
    users = [{ ...ANN, email: null }, BOB]
    await commentNotifications.notifyMentions({
      comment: comment({ content: '@ann @bob' }),
      authorName: 'Dana'
    })

    assert.deepEqual(
      sent.map((message) => message.to),
      ['bob@example.com']
    )
  })

  it('skips a user who cannot read the page, so its title does not leak', async () => {
    deniedByUser[BOB.id] = ['read:pages']
    await commentNotifications.notifyMentions({
      comment: comment({ content: '@ann @bob' }),
      authorName: 'Dana'
    })

    assert.deepEqual(
      sent.map((message) => message.to),
      ['ann@example.com']
    )
  })

  it('skips a user who cannot read comments on the page', async () => {
    deniedByUser[ANN.id] = ['read:comments']
    await commentNotifications.notifyMentions({
      comment: comment({ content: '@ann @bob' }),
      authorName: 'Dana'
    })

    assert.deepEqual(
      sent.map((message) => message.to),
      ['bob@example.com']
    )
  })

  it('sends nothing when the page is gone', async () => {
    page = null
    await commentNotifications.notifyMentions({
      comment: comment({ content: '@ann' }),
      authorName: 'Dana'
    })

    assert.equal(sent.length, 0)
  })

  it('resolves the copy in the recipient’s own locale and escapes html params', async () => {
    await commentNotifications.notifyMentions({
      comment: comment({ content: '@bob' }),
      authorName: 'Dana <b>'
    })

    assert.equal(sent.length, 1)
    const [message] = sent
    assert.match(message.subject, /^fr\|mail\.commentMention\.subject\|Dana <b>\|Intro <Guide>\|/)
    assert.match(message.subject, /\|https:\/\/wiki\.example\.com\/guides\/intro$/)
    assert.match(message.text, /^fr\|mail\.commentMention\.text\|/)
    assert.match(
      message.html,
      /^fr\|mail\.commentMention\.html\|Dana &lt;b&gt;\|Intro &lt;Guide&gt;\|Team &amp; Wiki\|/
    )
  })

  describe('on an edit', () => {
    it('mails only handles the edit added', async () => {
      await commentNotifications.notifyMentions({
        comment: comment({ content: 'cc @ann and now @bob' }),
        authorName: 'Dana',
        previousContent: 'cc @ann'
      })

      assert.deepEqual(
        sent.map((message) => message.to),
        ['bob@example.com']
      )
    })

    it('mails nobody when the edit did not add a handle', async () => {
      await commentNotifications.notifyMentions({
        comment: comment({ content: 'cc @ann, reworded' }),
        authorName: 'Dana',
        previousContent: 'cc @ann'
      })

      assert.equal(sent.length, 0)
    })

    it('compares handles case-insensitively, so recasing is not an addition', async () => {
      await commentNotifications.notifyMentions({
        comment: comment({ content: 'cc @ANN' }),
        authorName: 'Dana',
        previousContent: 'cc @ann'
      })

      assert.equal(sent.length, 0)
    })

    it('mails a handle the previous content did not carry', async () => {
      await commentNotifications.notifyMentions({
        comment: comment({ content: 'cc @ann again' }),
        authorName: 'Dana',
        previousContent: 'cc nobody'
      })

      assert.deepEqual(
        sent.map((message) => message.to),
        ['ann@example.com']
      )
    })
  })

  describe('against the comment:new / comment:edit email subscription', () => {
    it('skips a user already subscribed to comment:new when a comment is created', async () => {
      subscribers['comment:new'] = [ANN.id]
      await commentNotifications.notifyMentions({
        comment: comment({ content: '@ann @bob' }),
        authorName: 'Dana'
      })

      assert.deepEqual(
        sent.map((message) => message.to),
        ['bob@example.com']
      )
    })

    it('still mails a comment:edit subscriber when a comment is created', async () => {
      subscribers['comment:edit'] = [ANN.id]
      await commentNotifications.notifyMentions({
        comment: comment({ content: '@ann' }),
        authorName: 'Dana'
      })

      assert.equal(sent.length, 1)
    })

    it('skips a user already subscribed to comment:edit when a comment is edited', async () => {
      subscribers['comment:edit'] = [ANN.id]
      await commentNotifications.notifyMentions({
        comment: comment({ content: '@ann @bob' }),
        authorName: 'Dana',
        previousContent: 'nothing yet'
      })

      assert.deepEqual(
        sent.map((message) => message.to),
        ['bob@example.com']
      )
    })

    it('still mails a comment:new subscriber when a comment is edited', async () => {
      subscribers['comment:new'] = [ANN.id]
      await commentNotifications.notifyMentions({
        comment: comment({ content: '@ann' }),
        authorName: 'Dana',
        previousContent: 'nothing yet'
      })

      assert.equal(sent.length, 1)
    })
  })

  describe('failure handling', () => {
    it('does not throw when a send fails, and still mails the other recipients', async () => {
      sendFailures.add(ANN.id)
      await assert.doesNotReject(
        commentNotifications.notifyMentions({
          comment: comment({ content: '@ann @bob @cara' }),
          authorName: 'Dana'
        })
      )

      assert.deepEqual(sent.map((message) => message.to).sort(), [
        'bob@example.com',
        'cara@example.com'
      ])
      assert.equal(warn.mock.callCount(), 1)
      assert.equal(
        warn.mock.calls[0].arguments[1],
        'sending the comment mention notification failed'
      )
      assert.equal((warn.mock.calls[0].arguments[2] as { recipient: string }).recipient, ANN.id)
    })

    it('does not throw when the recipient lookup fails', async () => {
      userLookupError = new Error('db down')
      await assert.doesNotReject(
        commentNotifications.notifyMentions({
          comment: comment({ content: '@ann' }),
          authorName: 'Dana'
        })
      )

      assert.equal(sent.length, 0)
      assert.equal(warn.mock.callCount(), 1)
      assert.equal(warn.mock.calls[0].arguments[1], 'notifying the users a comment mentions failed')
    })
  })
})
