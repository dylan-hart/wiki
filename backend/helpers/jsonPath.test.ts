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

  describe('eval: false hardening (OpenProject #3157)', () => {
    test('refuses a filter expression and never evaluates it', () => {
      const data = { a: 1 }
      let evaluated = false
      // The filter body itself sets `evaluated`, so a thrown-but-still-ran regression is caught the
      // same way a silently-accepted one would be: `evaluated` must stay false either way.
      ;(globalThis as any).__jsonPathEvalProbe = () => {
        evaluated = true
        return true
      }
      try {
        assert.throws(
          () => extractJsonPathValue(data, '$..[?(globalThis.__jsonPathEvalProbe())]'),
          /Eval.*prevented/
        )
        assert.equal(evaluated, false)
      } finally {
        delete (globalThis as any).__jsonPathEvalProbe
      }
    })

    test('refuses a constructor-chain script probe', () => {
      const data = { a: 1 }
      assert.throws(
        () => extractJsonPathValue(data, '$..[?(@.constructor.constructor("return 1")())]'),
        /Eval.*prevented/
      )
    })

    test('still resolves a documented member path', () => {
      const data = { data: { temperature: 21.5 } }
      assert.equal(extractJsonPathValue(data, '$.data.temperature'), 21.5)
    })

    test('still resolves a documented bracket/index path', () => {
      const data = { readings: [{ value: 10 }, { value: 20 }] }
      assert.equal(extractJsonPathValue(data, '$.readings[0].value'), 10)
    })

    test('still resolves a documented wildcard path', () => {
      const data = { readings: [{ value: 10 }, { value: 20 }] }
      assert.equal(extractJsonPathValue(data, '$.readings[*].value'), 10)
    })

    test('still resolves a documented recursive-descent path', () => {
      const data = { a: { temperature: 1 }, b: { temperature: 2 } }
      assert.equal(extractJsonPathValue(data, '$..temperature'), 1)
    })
  })
})
