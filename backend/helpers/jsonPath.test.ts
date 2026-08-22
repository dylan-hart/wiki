import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJsonPathValue, JsonPathNoMatchError } from './jsonPath.ts'

describe('extractJsonPathValue', () => {
  test('extracts a nested scalar', () => {
    const data = { status: 'ok', metrics: { cpu: 42 } }
    assert.equal(extractJsonPathValue(data, '$.metrics.cpu'), 42)
  })

  test('extracts the root value with a bare $', () => {
    assert.equal(extractJsonPathValue(42, '$'), 42)
  })

  test('takes the first match when a path matches several nodes', () => {
    const data = { readings: [{ value: 1 }, { value: 2 }, { value: 3 }] }
    assert.equal(extractJsonPathValue(data, '$.readings[*].value'), 1)
  })

  test('throws JsonPathNoMatchError for a path that matches nothing', () => {
    const data = { a: 1 }
    assert.throws(() => extractJsonPathValue(data, '$.doesNotExist'), JsonPathNoMatchError)
  })

  test('throws for a path that fails to parse', () => {
    const data = { a: 1 }
    assert.throws(() => extractJsonPathValue(data, '$..[?(@.x==)]'))
  })
})
