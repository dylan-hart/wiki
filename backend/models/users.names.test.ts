import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveDisplayName, resolveNameFields } from './users.ts'

/**
 * The insert half of Feature #2608's `name` derivation invariant, as pure functions — no `WIKI`, no
 * database. The update half needs a stored row to reconcile against and so is covered by
 * `models/users.names.db.test.ts` instead.
 */

describe('deriveDisplayName', () => {
  test('joins the two halves with a single space', () => {
    assert.equal(deriveDisplayName('Dylan', 'Hart'), 'Dylan Hart')
  })

  test('derives a mononym to the first name alone', () => {
    assert.equal(deriveDisplayName('Prince', ''), 'Prince')
  })

  test('derives a surname-only account to the surname alone', () => {
    assert.equal(deriveDisplayName('', 'Hart'), 'Hart')
  })

  test('derives the empty string when neither half is set', () => {
    assert.equal(deriveDisplayName('', ''), '')
  })

  test('keeps an interior space in a multi-part half', () => {
    assert.equal(deriveDisplayName('Ada', 'King-Noel Byron'), 'Ada King-Noel Byron')
  })
})

describe('resolveNameFields', () => {
  test('derives the name and leaves the row unmarked when given only the two halves', () => {
    assert.deepEqual(resolveNameFields({ firstName: 'Dylan', lastName: 'Hart' }), {
      name: 'Dylan Hart',
      firstName: 'Dylan',
      lastName: 'Hart',
      nameLocallyEdited: false
    })
  })

  test('derives a mononym from the first name alone, still unmarked', () => {
    assert.deepEqual(resolveNameFields({ firstName: 'Prince' }), {
      name: 'Prince',
      firstName: 'Prince',
      lastName: '',
      nameLocallyEdited: false
    })
  })

  test('trims each half before deriving, so stray whitespace never reaches the display name', () => {
    assert.deepEqual(resolveNameFields({ firstName: '  Dylan ', lastName: ' Hart  ' }), {
      name: 'Dylan Hart',
      firstName: 'Dylan',
      lastName: 'Hart',
      nameLocallyEdited: false
    })
  })

  test('marks a single-string name with no halves as authored — nothing could derive it', () => {
    assert.deepEqual(resolveNameFields({ name: 'Sukarno' }), {
      name: 'Sukarno',
      firstName: '',
      lastName: '',
      nameLocallyEdited: true
    })
  })

  test('does NOT split a single-string name into halves', () => {
    const resolved = resolveNameFields({ name: 'Dylan Hart' })
    assert.equal(resolved.firstName, '')
    assert.equal(resolved.lastName, '')
  })

  test('leaves a name that matches its halves unmarked', () => {
    assert.deepEqual(
      resolveNameFields({ name: 'Dylan Hart', firstName: 'Dylan', lastName: 'Hart' }),
      {
        name: 'Dylan Hart',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: false
      }
    )
  })

  test('marks a name that its halves do not derive to', () => {
    assert.deepEqual(
      resolveNameFields({ name: 'Dr. D. Hart', firstName: 'Dylan', lastName: 'Hart' }),
      {
        name: 'Dr. D. Hart',
        firstName: 'Dylan',
        lastName: 'Hart',
        nameLocallyEdited: true
      }
    )
  })

  test('resolves to the empty display name when given nothing at all', () => {
    assert.deepEqual(resolveNameFields({}), {
      name: '',
      firstName: '',
      lastName: '',
      nameLocallyEdited: false
    })
  })

  test('is idempotent — re-resolving its own output changes nothing', () => {
    for (const input of [
      { firstName: 'Dylan', lastName: 'Hart' },
      { name: 'Sukarno' },
      { name: 'Dr. D. Hart', firstName: 'Dylan', lastName: 'Hart' },
      {}
    ]) {
      const once = resolveNameFields(input)
      assert.deepEqual(resolveNameFields(once), once)
    }
  })
})
