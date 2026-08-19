import { describe, expect, it } from 'vitest'

import { buildConfigEditor, buildConfigPayload } from './moduleConfig'

/**
 * `buildConfigEditor()`/`buildConfigPayload()`, extracted (task #556) out of what had been two
 * identical copies in `AdminStorage.vue` and `AdminSearch.vue` -- see `ModuleConfigForm.vue` for the
 * rendering half of the same extraction.
 */
describe('buildConfigEditor', () => {
  it('fills each declared prop with its stored value, falling back to the prop default', () => {
    const config = buildConfigEditor(
      {
        apiKey: { type: 'string', title: 'API Key', default: '' },
        retries: { type: 'number', title: 'Retries', default: 3 }
      },
      { apiKey: 'stored-key' }
    )

    expect(config.apiKey.value).toBe('stored-key')
    expect(config.retries.value).toBe(3)
    // -> The rest of the prop declaration rides along unchanged
    expect(config.apiKey.title).toBe('API Key')
  })

  it('expands a `value|label` enum entry into `{ value, label }` options', () => {
    const config = buildConfigEditor(
      {
        mode: { type: 'string', title: 'Mode', default: 'fast', enum: ['fast|Fast', 'accurate'] }
      },
      {}
    )

    expect(config.mode.enum).toEqual([
      { value: 'fast', label: 'Fast' },
      { value: 'accurate', label: 'accurate' }
    ])
  })

  it('returns an empty object for no declared props', () => {
    expect(buildConfigEditor(undefined, { anything: 1 })).toEqual({})
  })
})

describe('buildConfigPayload', () => {
  it('reads back the current value of each field', () => {
    const payload = buildConfigPayload({
      apiKey: { type: 'string', value: 'k' },
      enabled: { type: 'boolean', value: true }
    })
    expect(payload).toEqual({ apiKey: 'k', enabled: true })
  })

  it('coerces a number field’s value with Number()', () => {
    const payload = buildConfigPayload({ retries: { type: 'number', value: '5' } })
    expect(payload).toEqual({ retries: 5 })
  })

  it('drops a readOnly field entirely', () => {
    const payload = buildConfigPayload({
      computed: { type: 'string', value: 'x', readOnly: true },
      apiKey: { type: 'string', value: 'k' }
    })
    expect(payload).toEqual({ apiKey: 'k' })
  })
})
