import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { wrapAsBlock } from './blockFence.ts'

describe('wrapAsBlock', () => {
  test('wraps the body in an opening ::block-<name> line and a closing :: line', () => {
    assert.equal(
      wrapAsBlock('drawio', '```drawio\n<mxGraphModel/>\n```'),
      '::block-drawio\n```drawio\n<mxGraphModel/>\n```\n::'
    )
  })

  test('works for any block name and any body, verbatim', () => {
    assert.equal(
      wrapAsBlock('diagram', '```mermaid\ngraph TD;\n```'),
      '::block-diagram\n```mermaid\ngraph TD;\n```\n::'
    )
  })
})
