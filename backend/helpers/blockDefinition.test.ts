import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBlockDefinition, extractDefinedElementTag } from './blockDefinition.ts'

const WELL_FORMED = `
import { LitElement, html } from 'lit'

export class BlockWidget extends LitElement {
  static definition = {
    block: 'widget',
    name: 'Widget',
    description: 'A test widget.',
    icon: 'mdi:cube',
    props: [
      {
        name: 'title',
        type: 'string',
        label: 'Title',
        required: true,
        default: 'Untitled'
      },
      {
        name: 'fit',
        type: 'select',
        options: ['cover', 'contain']
      }
    ],
    isChild: false,
    template: \`line one
line two\`
  }

  render () {
    return html\`<div>\${this.title}</div>\`
  }
}

customElements.define('block-widget', BlockWidget)
`

describe('extractBlockDefinition', () => {
  test('accepts a well-formed static definition', () => {
    const result = extractBlockDefinition(WELL_FORMED)
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.deepEqual(result.definition, {
      block: 'widget',
      name: 'Widget',
      description: 'A test widget.',
      icon: 'mdi:cube',
      props: [
        { name: 'title', type: 'string', label: 'Title', required: true, default: 'Untitled' },
        { name: 'fit', type: 'select', options: ['cover', 'contain'] }
      ],
      isChild: false,
      template: 'line one\nline two'
    })
  })

  test('accepts a definition on a class re-exported via export class', () => {
    const source = `
      export class BlockPlain extends HTMLElement {
        static definition = { block: 'plain', name: 'Plain', description: 'd', icon: 'i' }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, true)
  })

  test('rejects source that is not valid JavaScript', () => {
    const result = extractBlockDefinition('class Broken extends {{{')
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'parse-error')
  })

  test('rejects a class with no static definition', () => {
    const source = `
      export class BlockNoDefinition extends HTMLElement {
        connectedCallback () {}
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'no-definition')
  })

  test('rejects source with no class at all', () => {
    const result = extractBlockDefinition('export const notAClass = 42')
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'no-definition')
  })

  test('rejects an interpolated template literal', () => {
    const source = `
      export class BlockInterpolated extends HTMLElement {
        static definition = {
          block: 'interpolated',
          name: 'Interpolated',
          description: 'd',
          icon: 'i',
          template: \`hello \${1 + 1}\`
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'interpolated-template')
  })

  test('rejects a non-literal expression as a property value', () => {
    const source = `
      const external = 'computed'
      export class BlockComputedValue extends HTMLElement {
        static definition = {
          block: external,
          name: 'Computed',
          description: 'd',
          icon: 'i'
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'non-literal')
  })

  test('rejects a function call as a property value', () => {
    const source = `
      export class BlockFunctionCall extends HTMLElement {
        static definition = {
          block: 'call',
          name: 'Call',
          description: describe(),
          icon: 'i'
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'non-literal')
  })

  test('rejects a computed property key inside the definition object', () => {
    const source = `
      const key = 'block'
      export class BlockComputedKey extends HTMLElement {
        static definition = {
          [key]: 'computed-key',
          name: 'Computed Key',
          description: 'd',
          icon: 'i'
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'non-literal')
  })

  test('rejects a spread element inside an array prop', () => {
    const source = `
      const extra = ['a', 'b']
      export class BlockSpreadArray extends HTMLElement {
        static definition = {
          block: 'spread',
          name: 'Spread',
          description: 'd',
          icon: 'i',
          props: [...extra]
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'non-literal')
  })

  test('rejects a computed static member name that happens to read "definition"', () => {
    const source = `
      const name = 'definition'
      export class BlockComputedMember extends HTMLElement {
        static [name] = { block: 'x', name: 'X', description: 'd', icon: 'i' }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'no-definition')
  })

  /*
   * OpenProject #2132: `helpers/htmlSanitizePolicy.ts#blockAllowances()` now admits a custom block's `props`
   * straight into the sanitizer's per-tag attribute allowlist, trusting each `name` unvalidated --
   * sanitize-html matches attribute names with `*`-glob support, so an uploaded prop named `on*` or
   * `*` would otherwise silently open inline event handlers (or every attribute at all) on that
   * element for every page author, not merely describe one authorable field. This is the check that
   * closes that gap: a prop name has to look like a plain attribute name to be accepted at all.
   */
  test('rejects a prop name shaped like an inline-event-handler wildcard (on*)', () => {
    const source = `
      export class BlockTrap extends HTMLElement {
        static definition = {
          block: 'trap',
          name: 'Trap',
          description: 'd',
          icon: 'i',
          props: [{ name: 'on*', type: 'string' }]
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'invalid-prop-name')
    assert.match(result.error.message, /"on\*"/)
  })

  test('rejects a prop name that is a bare glob (*)', () => {
    const source = `
      export class BlockTrap extends HTMLElement {
        static definition = {
          block: 'trap',
          name: 'Trap',
          description: 'd',
          icon: 'i',
          props: [
            { name: 'caption', type: 'string' },
            { name: '*', type: 'string' }
          ]
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'invalid-prop-name')
  })

  test('rejects a prop name with an uppercase letter or an underscore, same as any other non-attribute-shaped name', () => {
    const source = `
      export class BlockTrap extends HTMLElement {
        static definition = {
          block: 'trap',
          name: 'Trap',
          description: 'd',
          icon: 'i',
          props: [{ name: 'My_Prop', type: 'string' }]
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, false)
    if (result.ok) {
      return
    }
    assert.equal(result.error.reason, 'invalid-prop-name')
  })

  test('accepts ordinary dash-separated prop names', () => {
    const source = `
      export class BlockFine extends HTMLElement {
        static definition = {
          block: 'fine',
          name: 'Fine',
          description: 'd',
          icon: 'i',
          props: [
            { name: 'caption', type: 'string' },
            { name: 'unlock-aspect-ratio', type: 'boolean' }
          ]
        }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, true)
  })

  test('uses the last matching class when more than one static definition exists', () => {
    const source = `
      class BlockFirst extends HTMLElement {
        static definition = { block: 'first', name: 'First', description: 'd', icon: 'i' }
      }
      export class BlockSecond extends HTMLElement {
        static definition = { block: 'second', name: 'Second', description: 'd', icon: 'i' }
      }
    `
    const result = extractBlockDefinition(source)
    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.definition.block, 'second')
  })
})

describe('extractDefinedElementTag', () => {
  test('finds a bare customElements.define call', () => {
    const source = `
      export class BlockWidget extends HTMLElement {}
      customElements.define('block-widget', BlockWidget)
    `
    assert.equal(extractDefinedElementTag(source), 'block-widget')
  })

  test('finds a window.customElements.define call, the convention every block in this repo uses', () => {
    const source = `
      export class BlockWidget extends HTMLElement {}
      window.customElements.define('block-widget', BlockWidget)
    `
    assert.equal(extractDefinedElementTag(source), 'block-widget')
  })

  test('returns null when the source registers no element at all', () => {
    const source = `
      export class BlockWidget extends HTMLElement {}
    `
    assert.equal(extractDefinedElementTag(source), null)
  })

  test('returns null when the tag argument is not a literal string', () => {
    const source = `
      const tag = 'block-widget'
      export class BlockWidget extends HTMLElement {}
      customElements.define(tag, BlockWidget)
    `
    assert.equal(extractDefinedElementTag(source), null)
  })

  test('returns null for unparseable source rather than throwing', () => {
    assert.equal(extractDefinedElementTag('this is not valid javascript {{{'), null)
  })

  test('ignores a call to an unrelated .define method', () => {
    const source = `
      const registry = { define: () => {} }
      registry.define('block-widget', class {})
    `
    assert.equal(extractDefinedElementTag(source), null)
  })

  test('returns the last top-level define call when more than one exists', () => {
    const source = `
      customElements.define('block-first', class {})
      customElements.define('block-second', class {})
    `
    assert.equal(extractDefinedElementTag(source), 'block-second')
  })
})
