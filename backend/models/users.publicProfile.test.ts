import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { installTestWiki } from '../test/mocks.ts'
import { effectivePublicFields, forcedPublicFields, toPublicProfile, users } from './users.ts'

let handle: { restore(): void }

beforeEach(() => {
  handle = installTestWiki()
})

afterEach(() => handle.restore())

function row(overrides: Record<string, any> = {}): any {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    hasAvatar: true,
    avatarProviderUrl: null,
    isActive: true,
    isSystem: false,
    meta: { location: 'London', jobTitle: 'Analyst', pronouns: 'she/her', notes: 'admin only' },
    prefs: {},
    ...overrides
  }
}

describe('effectivePublicFields', () => {
  test('is empty when the user chose nothing and nothing is forced', () => {
    assert.deepEqual(effectivePublicFields(undefined), [])
    assert.deepEqual(effectivePublicFields([]), [])
  })

  test("is the user's own choice when nothing is forced", () => {
    assert.deepEqual(effectivePublicFields(['pronouns', 'location']), ['location', 'pronouns'])
  })

  test('is the forced list when the user chose nothing', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['jobTitle'] }
    assert.deepEqual(effectivePublicFields([]), ['jobTitle'])
  })

  test('is the union of both, once each', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['jobTitle', 'location'] }
    assert.deepEqual(effectivePublicFields(['location', 'pronouns']), [
      'location',
      'jobTitle',
      'pronouns'
    ])
  })

  test('drops keys that are not About Me fields, from either side', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['email', 'location'] }
    assert.deepEqual(forcedPublicFields(), ['location'])
    assert.deepEqual(effectivePublicFields(['email', 'password', 'pronouns']), [
      'location',
      'pronouns'
    ])
  })

  test('tolerates a stored value of the wrong shape', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: 'location' }
    assert.deepEqual(effectivePublicFields('pronouns'), [])
  })
})

describe('toPublicProfile', () => {
  test('carries only fields that are public', () => {
    const profile = toPublicProfile(row({ prefs: { publicFields: ['jobTitle'] } }))
    assert.deepEqual(profile?.fields, { jobTitle: 'Analyst' })
  })

  test('shows nothing beyond the identity when no field is public', () => {
    const profile = toPublicProfile(row())
    assert.deepEqual(profile, {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Ada Lovelace',
      hasAvatar: true,
      avatarProviderUrl: null,
      fields: {}
    })
  })

  test('never carries the email, or a meta key outside the About Me fields', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['location'] }
    const profile = toPublicProfile(
      row({ prefs: { publicFields: ['email', 'notes', 'jobTitle', 'pronouns'] } })
    )
    assert.ok(profile)
    assert.equal('email' in profile, false)
    assert.deepEqual(Object.keys(profile.fields).sort(), ['jobTitle', 'location', 'pronouns'])
    assert.equal(JSON.stringify(profile).includes('ada@example.com'), false)
    assert.equal(JSON.stringify(profile).includes('admin only'), false)
  })

  test('shows a forced field only when the user filled it in', () => {
    CARDINAL.config.profileVisibility = { forcedPublicFields: ['location', 'pronouns'] }
    const profile = toPublicProfile(row({ meta: { location: 'London', pronouns: '   ' } }))
    assert.deepEqual(profile?.fields, { location: 'London' })
  })

  test('refuses an inactive account', () => {
    assert.equal(toPublicProfile(row({ isActive: false })), null)
  })

  test('refuses a system account', () => {
    assert.equal(toPublicProfile(row({ isSystem: true })), null)
  })

  test('copes with an account that has no meta or prefs at all', () => {
    const profile = toPublicProfile(row({ meta: null, prefs: null }))
    assert.deepEqual(profile?.fields, {})
  })
})

describe('users.getPublicProfile', () => {
  test('answers null for an id nobody has', async () => {
    const original = users.getById
    users.getById = (async () => null) as any
    try {
      assert.equal(await users.getPublicProfile('nope'), null)
    } finally {
      users.getById = original
    }
  })

  test('reads the account through getById and applies the same rules', async () => {
    const original = users.getById
    users.getById = (async () => row({ isSystem: true })) as any
    try {
      assert.equal(await users.getPublicProfile('any'), null)
    } finally {
      users.getById = original
    }
  })
})
