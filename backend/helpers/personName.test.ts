import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { fillNameHalves, splitDisplayName } from './personName.ts'

describe('splitDisplayName', () => {
  test('two words split into first and last', () => {
    assert.deepEqual(splitDisplayName('Ada Lovelace'), {
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('a mononym keeps an empty last name rather than fabricating one', () => {
    assert.deepEqual(splitDisplayName('Prince'), { firstName: 'Prince', lastName: '' })
  })

  test('three or more words keep the whole remainder as the last name', () => {
    assert.deepEqual(splitDisplayName('Ada Byron King'), {
      firstName: 'Ada',
      lastName: 'Byron King'
    })
    assert.deepEqual(splitDisplayName('Jean Claude Van Damme'), {
      firstName: 'Jean',
      lastName: 'Claude Van Damme'
    })
  })

  test('leading and trailing whitespace is trimmed off both halves', () => {
    assert.deepEqual(splitDisplayName('   Ada Lovelace   '), {
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('internal whitespace runs collapse rather than surviving into the last name', () => {
    assert.deepEqual(splitDisplayName('Ada\t B\n Lovelace'), {
      firstName: 'Ada',
      lastName: 'B Lovelace'
    })
  })

  test('an empty string yields two empty strings', () => {
    assert.deepEqual(splitDisplayName(''), { firstName: '', lastName: '' })
  })

  test('a whitespace-only string yields two empty strings', () => {
    assert.deepEqual(splitDisplayName('   \t \n '), { firstName: '', lastName: '' })
  })

  test('absent input yields two empty strings rather than throwing', () => {
    assert.deepEqual(splitDisplayName(undefined), { firstName: '', lastName: '' })
    assert.deepEqual(splitDisplayName(null), { firstName: '', lastName: '' })
  })

  test('is deliberately naive: a particle surname splits the same way as any other', () => {
    // -> Feature #2608 rejected a name-parsing library precisely so this stays an obvious guess a
    //    person can correct, rather than a confident wrong answer nobody looks at.
    assert.deepEqual(splitDisplayName('Ludwig van Beethoven'), {
      firstName: 'Ludwig',
      lastName: 'van Beethoven'
    })
  })
})

describe('fillNameHalves', () => {
  test('splits the display string when neither half is known', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace'), { firstName: 'Ada', lastName: 'Lovelace' })
  })

  test('an absent `known` argument behaves as neither half being known', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace', {}), {
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('a claim-sourced pair wins over the display string outright', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace', { firstName: 'Augusta', lastName: 'King' }), {
      firstName: 'Augusta',
      lastName: 'King'
    })
  })

  test('a claim-sourced first name alone is a mononym, not a prompt to re-guess the surname', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace', { firstName: 'Ada' }), {
      firstName: 'Ada',
      lastName: ''
    })
  })

  test('a claim-sourced last name alone is kept the same way, with no invented first name', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace', { lastName: 'Lovelace' }), {
      firstName: '',
      lastName: 'Lovelace'
    })
  })

  test('two empty claim halves fall through to the split, they are not "known"', () => {
    assert.deepEqual(fillNameHalves('Ada Lovelace', { firstName: '', lastName: '' }), {
      firstName: 'Ada',
      lastName: 'Lovelace'
    })
  })

  test('nothing known and nothing to split yields two empty strings', () => {
    assert.deepEqual(fillNameHalves(undefined), { firstName: '', lastName: '' })
  })
})
