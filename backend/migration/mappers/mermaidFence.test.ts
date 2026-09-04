import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { convertMermaidFences } from './mermaidFence.ts'

describe('convertMermaidFences', () => {
  test('wraps a bare ```mermaid fence in ::block-diagram, body untouched', () => {
    const content = '# Title\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nAfter.'
    const result = convertMermaidFences(content)
    assert.equal(result.converted, 1)
    assert.equal(
      result.content,
      '# Title\n\n::block-diagram\n```mermaid\ngraph TD;\n  A-->B;\n```\n::\n\nAfter.'
    )
  })

  test('wraps every mermaid fence on a page carrying more than one', () => {
    const content =
      '```mermaid\ngraph TD;\n  A-->B;\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```'
    const result = convertMermaidFences(content)
    assert.equal(result.converted, 2)
    assert.ok(result.content.includes('::block-diagram\n```mermaid\ngraph TD;\n  A-->B;\n```\n::'))
    assert.ok(
      result.content.includes('::block-diagram\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n::')
    )
  })

  test('leaves content with no mermaid fence at all untouched', () => {
    const content = '# Plain page\n\nJust markdown, no diagrams.'
    const result = convertMermaidFences(content)
    assert.equal(result.converted, 0)
    assert.equal(result.content, content)
  })

  test('does not touch an unrelated fenced code block', () => {
    const content = '```js\nconsole.log("mermaid")\n```'
    const result = convertMermaidFences(content)
    assert.equal(result.converted, 0)
    assert.equal(result.content, content)
  })
})
