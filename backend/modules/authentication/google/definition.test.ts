import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { load } from 'js-yaml'

const definition = load(readFileSync(new URL('./definition.yml', import.meta.url), 'utf8')) as {
  description: string
  props: Record<string, Record<string, any>>
}

describe('google definition.yml group mapping props', () => {
  test('mapGroups is a Boolean defaulting to off', () => {
    assert.equal(definition.props.mapGroups.type, 'Boolean')
    assert.equal(definition.props.mapGroups.default, false)
    assert.equal(definition.props.mapGroups.if, undefined)
  })

  test('serviceAccountKey is a sensitive String shown only when mapGroups is on', () => {
    const prop = definition.props.serviceAccountKey
    assert.equal(prop.type, 'String')
    assert.equal(prop.sensitive, true)
    assert.deepEqual(prop.if, [{ key: 'mapGroups', eq: true }])
  })

  test('delegatedAdminEmail is a String shown only when mapGroups is on', () => {
    const prop = definition.props.delegatedAdminEmail
    assert.equal(prop.type, 'String')
    assert.notEqual(prop.sensitive, true)
    assert.deepEqual(prop.if, [{ key: 'mapGroups', eq: true }])
  })

  test('the hints document the Workspace requirements', () => {
    const hints = [
      definition.props.mapGroups.hint,
      definition.props.serviceAccountKey.hint,
      definition.props.delegatedAdminEmail.hint
    ].join(' ')
    assert.match(hints, /service account/i)
    assert.match(hints, /domain-wide delegation/i)
    assert.match(hints, /admin\.directory\.group\.readonly/)
    assert.match(hints, /impersonat/i)
  })

  test('the description offers group sync through this module as well as SAML', () => {
    assert.match(definition.description, /Map Groups/)
    assert.match(definition.description, /SAML/)
  })

  test('the props keep unique order values', () => {
    const orders = Object.values(definition.props).map((p) => p.order)
    assert.equal(new Set(orders).size, orders.length)
  })
})
