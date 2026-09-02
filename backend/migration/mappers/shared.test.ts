import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isPlainObject,
  pickDefined,
  pickPresent,
  transformConfig,
  unwrapKnexValue
} from './shared.ts'

describe('isPlainObject', () => {
  test('accepts an object literal and a class instance, rejects arrays and null', () => {
    class Row {
      value = 1
    }
    assert.equal(isPlainObject({}), true)
    assert.equal(isPlainObject(new Row()), true)
    assert.equal(isPlainObject([]), false)
    assert.equal(isPlainObject(null), false)
    assert.equal(isPlainObject('nope'), false)
  })
})

describe('pickDefined vs pickPresent', () => {
  test('both copy an explicitly falsy value, which is a real 2.x setting', () => {
    const source = { secure: false, port: 0, name: '' }
    const keys = ['secure', 'port', 'name']
    assert.deepEqual(pickDefined(source, keys), source)
    assert.deepEqual(pickPresent(source, keys), source)
  })

  test('they differ on an explicit undefined: pickDefined drops it, pickPresent keeps it', () => {
    const source = { clientId: undefined, clientSecret: 'shh' }
    assert.deepEqual(pickDefined(source, ['clientId', 'clientSecret']), { clientSecret: 'shh' })
    assert.deepEqual(Object.keys(pickPresent(source, ['clientId', 'clientSecret'])), [
      'clientId',
      'clientSecret'
    ])
  })

  test('neither invents a key the source never had', () => {
    assert.deepEqual(pickDefined({}, ['absent']), {})
    assert.deepEqual(pickPresent({}, ['absent']), {})
  })
})

describe('transformConfig', () => {
  test('applies the named module transform', () => {
    const transforms = { disk: (raw: Record<string, unknown>) => pickDefined(raw, ['path']) }
    assert.deepEqual(transformConfig(transforms, 'disk', { path: '/data', extra: 1 }), {
      path: '/data'
    })
  })

  test('a module with no transform, and a non-object config, both produce an empty config', () => {
    const transforms = { disk: (raw: Record<string, unknown>) => raw }
    assert.deepEqual(transformConfig(transforms, 'gcs', { bucket: 'b' }), {})
    assert.deepEqual(transformConfig(transforms, 'disk', null), {})
  })
})

describe('unwrapKnexValue', () => {
  test("unwraps 2.x's { v: ... } wrapper and leaves everything else alone", () => {
    assert.deepEqual(unwrapKnexValue({ v: ['example.com'] }), ['example.com'])
    assert.equal(unwrapKnexValue({ v: 3 }), 3)
    assert.deepEqual(unwrapKnexValue(['example.com']), ['example.com'])
    assert.deepEqual(unwrapKnexValue({ host: 'smtp' }), { host: 'smtp' })
    assert.equal(unwrapKnexValue(null), null)
  })
})
