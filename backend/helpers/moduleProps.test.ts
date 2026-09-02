import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  maskSensitiveConfig,
  SENSITIVE_CONFIG_MASK,
  unmaskSensitiveConfig,
  type ModuleProp
} from './moduleProps.ts'

function fakeProp(overrides: Partial<ModuleProp> = {}): ModuleProp {
  return {
    default: '',
    type: 'string',
    title: 'Fake Prop',
    hint: '',
    enum: false,
    enumDisplay: 'select',
    multiline: false,
    sensitive: false,
    readOnly: false,
    required: false,
    pattern: '',
    icon: 'text-box',
    order: 100,
    if: [],
    ...overrides
  }
}

describe('maskSensitiveConfig', () => {
  const props = {
    apiKey: fakeProp({ sensitive: true }),
    label: fakeProp({ sensitive: false })
  }

  test('replaces a non-empty sensitive value with the mask', () => {
    const masked = maskSensitiveConfig(props, { apiKey: 'super-secret', label: 'My Provider' })
    assert.deepEqual(masked, { apiKey: SENSITIVE_CONFIG_MASK, label: 'My Provider' })
  })

  test('leaves an empty sensitive value alone — nothing stored, nothing to hide', () => {
    const masked = maskSensitiveConfig(props, { apiKey: '', label: 'My Provider' })
    assert.deepEqual(masked, { apiKey: '', label: 'My Provider' })
  })

  test('leaves a non-string sensitive value alone (e.g. still undefined)', () => {
    const masked = maskSensitiveConfig(props, { label: 'My Provider' })
    assert.deepEqual(masked, { label: 'My Provider' })
  })

  test('does not mutate the config object passed in', () => {
    const config = { apiKey: 'super-secret' }
    maskSensitiveConfig(props, config)
    assert.equal(config.apiKey, 'super-secret')
  })

  test('returns the config unchanged when no prop is declared sensitive', () => {
    const masked = maskSensitiveConfig({ label: fakeProp() }, { label: 'value' })
    assert.deepEqual(masked, { label: 'value' })
  })
})

describe('unmaskSensitiveConfig', () => {
  const props = {
    apiKey: fakeProp({ sensitive: true }),
    label: fakeProp({ sensitive: false })
  }

  test('drops a sensitive key whose incoming value is exactly the mask', () => {
    const cleaned = unmaskSensitiveConfig(props, {
      apiKey: SENSITIVE_CONFIG_MASK,
      label: 'My Provider'
    })
    assert.deepEqual(cleaned, { label: 'My Provider' })
  })

  test('leaves a genuinely new sensitive value alone', () => {
    const cleaned = unmaskSensitiveConfig(props, { apiKey: 'brand-new-secret' })
    assert.deepEqual(cleaned, { apiKey: 'brand-new-secret' })
  })

  test('leaves a non-sensitive value equal to the mask string alone', () => {
    const cleaned = unmaskSensitiveConfig(props, { label: SENSITIVE_CONFIG_MASK })
    assert.deepEqual(cleaned, { label: SENSITIVE_CONFIG_MASK })
  })

  test('does not mutate the incoming object passed in', () => {
    const incoming = { apiKey: SENSITIVE_CONFIG_MASK }
    unmaskSensitiveConfig(props, incoming)
    assert.equal(incoming.apiKey, SENSITIVE_CONFIG_MASK)
  })
})
