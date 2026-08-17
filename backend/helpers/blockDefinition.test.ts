import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBlockDefinition } from './blockDefinition.ts'

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
