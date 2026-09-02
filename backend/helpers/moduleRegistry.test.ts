import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mergeModuleConfig, validateModuleConfig } from './moduleRegistry.ts'
import type { ModuleProp } from './moduleProps.ts'

/** A prop shaped the way `parseModuleProps` (helpers/common.ts) normalizes a `definition.yml` entry. */
function fakeProp(overrides: Partial<ModuleProp> = {}): ModuleProp {
  return {
    default: false,
    type: 'boolean',
    title: 'Term Highlighting',
    hint: '',
    enum: false,
    enumDisplay: 'select',
    multiline: false,
    sensitive: false,
    readOnly: false,
    required: false,
    pattern: '',
    icon: 'text-box-search',
    order: 100,
    if: [],
    ...overrides
  }
}

/**
 * The prop set every case below validates against: a sensitive string, an enum, a plain boolean, a
 * number and a read-only string — one of each branch `validateModuleConfig`'s switch has, plus the
 * two `mergeModuleConfig` treats specially (`sensitive`, `readOnly`).
 */
const props: Record<string, ModuleProp> = {
  apiKey: fakeProp({ default: '', type: 'string', title: 'API Key', sensitive: true }),
  mode: fakeProp({
    default: 'fast',
    type: 'string',
    title: 'Mode',
    enum: ['fast|Fast', 'accurate|Accurate']
  }),
  termHighlighting: fakeProp({ default: false, type: 'boolean', title: 'Term Highlighting' }),
  maxResults: fakeProp({ default: 20, type: 'number', title: 'Max Results' }),
  region: fakeProp({ default: 'us-east-1', type: 'string', title: 'Region', readOnly: true })
}

/** A second set, for the `required` / `pattern` pass only search's engine picker turns on. */
const strictProps: Record<string, ModuleProp> = {
  apiKey: fakeProp({ default: '', type: 'string', title: 'API Key', required: true }),
  hosts: fakeProp({
    default: '',
    type: 'string',
    title: 'Host(s)',
    pattern: '^https?://[\\w.-]+(:\\d+)?$'
  })
}

describe('mergeModuleConfig()', () => {
  test('fills every declared prop from incoming, falling back to existing, falling back to default', () => {
    const config = mergeModuleConfig(props, { apiKey: 'new-key' }, { mode: 'accurate' })
    assert.deepEqual(config, {
      apiKey: 'new-key',
      mode: 'accurate',
      termHighlighting: false,
      maxResults: 20,
      region: 'us-east-1'
    })
  })

  test('drops a key the module does not declare', () => {
    const config = mergeModuleConfig(props, { nonsense: true }, {})
    assert.equal('nonsense' in config, false)
  })

  test('returns an empty object when the module declares no props', () => {
    assert.deepEqual(mergeModuleConfig({}, { anything: 1 }, { stored: 2 }), {})
  })

  test('never takes a read-only prop from incoming, keeping the stored value', () => {
    const config = mergeModuleConfig(props, { region: 'mars-central-1' }, { region: 'eu-west-1' })
    assert.equal(config.region, 'eu-west-1')
  })

  test('never takes a read-only prop from incoming, falling back to the declared default', () => {
    const config = mergeModuleConfig(props, { region: 'mars-central-1' }, {})
    assert.equal(config.region, 'us-east-1')
  })

  test('drops a sensitive value that is just the mask echoed back, keeping the real existing one', () => {
    const config = mergeModuleConfig(
      props,
      { apiKey: '********', mode: 'accurate' },
      { apiKey: 'real-existing-secret', mode: 'fast' }
    )
    assert.equal(config.apiKey, 'real-existing-secret')
    assert.equal(config.mode, 'accurate')
  })

  test('accepts a genuinely new sensitive value that happens not to be the mask', () => {
    const config = mergeModuleConfig(
      props,
      { apiKey: 'brand-new-secret' },
      { apiKey: 'old-secret' }
    )
    assert.equal(config.apiKey, 'brand-new-secret')
  })

  test('keeps a stored falsy value rather than falling back to the default', () => {
    const config = mergeModuleConfig(props, {}, { maxResults: 0 })
    assert.equal(config.maxResults, 0)
  })
})

describe('validateModuleConfig()', () => {
  test('accepts a config with only declared keys of the right type', () => {
    assert.equal(
      validateModuleConfig(props, {
        apiKey: 'abc',
        mode: 'fast',
        termHighlighting: true,
        maxResults: 5
      }),
      null
    )
  })

  test('rejects a value not in the declared enum', () => {
    const message = validateModuleConfig(props, { mode: 'ludicrous' })
    assert.match(message ?? '', /"ludicrous" is not a valid value for Mode/)
  })

  test('rejects a wrong-typed boolean prop', () => {
    const message = validateModuleConfig(props, { termHighlighting: 'yes' })
    assert.match(message ?? '', /Term Highlighting must be true or false/)
  })

  test('rejects a wrong-typed number prop', () => {
    assert.match(
      validateModuleConfig(props, { maxResults: '5' }) ?? '',
      /Max Results must be a number/
    )
    assert.match(
      validateModuleConfig(props, { maxResults: Number.NaN }) ?? '',
      /Max Results must be a number/
    )
  })

  test('rejects a wrong-typed string prop', () => {
    const message = validateModuleConfig(props, { apiKey: 42 })
    assert.match(message ?? '', /API Key must be a string/)
  })

  test('accepts an unknown key by default, since buildConfig drops it rather than refusing', () => {
    assert.equal(validateModuleConfig(props, { notARealProp: 'whatever' }), null)
  })

  test('skips a read-only prop, whatever was sent for it', () => {
    assert.equal(validateModuleConfig(props, { region: 12345 }), null)
  })

  test('skips a key whose value is undefined', () => {
    assert.equal(validateModuleConfig(props, { termHighlighting: undefined }), null)
  })

  describe('refuseUnknown', () => {
    test('rejects an unrecognized prop, naming the module', () => {
      const message = validateModuleConfig(
        props,
        { bogus: 'x' },
        { refuseUnknown: true, moduleTitle: 'Custom Engine' }
      )
      assert.match(message ?? '', /"bogus"/)
      assert.match(message ?? '', /Custom Engine/)
    })

    test('still accepts a config whose keys are all declared', () => {
      assert.equal(
        validateModuleConfig(
          props,
          { apiKey: 'abc', mode: 'fast' },
          { refuseUnknown: true, moduleTitle: 'Custom Engine' }
        ),
        null
      )
    })
  })

  describe('requiredAndPattern', () => {
    test('rejects a required prop left empty, naming the module', () => {
      const message = validateModuleConfig(
        strictProps,
        { hosts: 'http://x:1' },
        { requiredAndPattern: true, moduleTitle: 'Strict Engine' }
      )
      assert.match(message ?? '', /API Key is required/)
      assert.match(message ?? '', /Strict Engine/)
    })

    test('accepts a required prop that was already stored, without it being resent', () => {
      assert.equal(
        validateModuleConfig(
          strictProps,
          { hosts: 'http://x:1' },
          {
            requiredAndPattern: true,
            moduleTitle: 'Strict Engine',
            existing: { apiKey: 'stored-key' }
          }
        ),
        null
      )
    })

    test('rejects a value that fails the declared pattern', () => {
      const message = validateModuleConfig(
        strictProps,
        { apiKey: 'k', hosts: 'not-a-url' },
        { requiredAndPattern: true, moduleTitle: 'Strict Engine' }
      )
      assert.match(message ?? '', /Host\(s\) is not valid for Strict Engine/)
    })

    test('accepts a value that matches the declared pattern', () => {
      assert.equal(
        validateModuleConfig(
          strictProps,
          { apiKey: 'k', hosts: 'http://x:1' },
          { requiredAndPattern: true, moduleTitle: 'Strict Engine' }
        ),
        null
      )
    })

    test('leaves an empty, non-required value alone even when it declares a pattern', () => {
      assert.equal(
        validateModuleConfig(
          strictProps,
          { apiKey: 'k' },
          { requiredAndPattern: true, moduleTitle: 'Strict Engine' }
        ),
        null
      )
    })

    test('is not run at all when the option is off', () => {
      assert.equal(validateModuleConfig(strictProps, { hosts: 'http://x:1' }), null)
    })
  })
})
