import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { CustomError } from '../../helpers/common.ts'
import { McpToolError } from '../auth.ts'
import { handleRenderDiagram } from './renderDiagram.ts'
import { installTestWiki } from '../../test/mocks.ts'

const CTX = {
  keyId: 'key-1',
  permissions: [] as string[],
  siteId: null as string | null,
  groupIds: [] as string[],
  userId: 'user-1' as string | null,
  scope: null as string[] | null
}

let wikiHandle: { restore(): void }

after(() => {
  wikiHandle.restore()
})

function install({
  allowed = true,
  render
}: {
  allowed?: boolean
  render?: (request: any) => Promise<{ contentType: string; data: Buffer }>
} = {}) {
  const consumeCalls: any[] = []
  const renderCalls: any[] = []
  wikiHandle = installTestWiki({
    models: {
      rateLimits: {
        consume: async (key: string, policy: any) => {
          consumeCalls.push({ key, policy })
          return allowed
            ? { allowed: true, hits: 1, retryAfter: 0 }
            : { allowed: false, hits: 999, retryAfter: 120 }
        }
      },
      diagramRender: {
        render:
          render ??
          (async () => ({ contentType: 'image/svg+xml', data: Buffer.from('<svg></svg>') }))
      }
    }
  })
  return { consumeCalls, renderCalls }
}

test('handleRenderDiagram: returns the rendered image as a base64 content block', async () => {
  install({
    render: async (request) => {
      assert.equal(request.type, 'mermaid')
      assert.equal(request.source, 'graph TD; A-->B')
      return { contentType: 'image/svg+xml', data: Buffer.from('<svg>ok</svg>') }
    }
  })

  const result = await handleRenderDiagram(CTX, { type: 'mermaid', source: 'graph TD; A-->B' })
  assert.equal(result.content.length, 1)
  const block = result.content[0] as any
  assert.equal(block.type, 'image')
  assert.equal(block.mimeType, 'image/svg+xml')
  assert.equal(Buffer.from(block.data, 'base64').toString('utf8'), '<svg>ok</svg>')
})

test('handleRenderDiagram: consumes the render rate limit keyed by the caller’s user id', async () => {
  const { consumeCalls } = install()
  await handleRenderDiagram(CTX, { type: 'plantuml', source: '@startuml\n@enduml' })
  assert.equal(consumeCalls.length, 1)
  assert.equal(consumeCalls[0].key, 'render:user-1')
})

test('handleRenderDiagram: an admin-issued key with no userId gets its own key-keyed bucket', async () => {
  const { consumeCalls } = install()
  await handleRenderDiagram(
    { ...CTX, userId: null },
    { type: 'mermaid', source: 'graph TD; A-->B' }
  )
  assert.equal(consumeCalls[0].key, 'render:mcp:key-1')
})

test('handleRenderDiagram: refuses once the render rate limit is exceeded', async () => {
  install({ allowed: false })
  await assert.rejects(
    () => handleRenderDiagram(CTX, { type: 'mermaid', source: 'graph TD; A-->B' }),
    (err: any) => {
      assert.ok(err instanceof McpToolError)
      assert.match(err.message, /Too many render requests.*2 minute/)
      return true
    }
  )
})

test('handleRenderDiagram: manage:system bypasses the rate limit', async () => {
  const { consumeCalls } = install({ allowed: false })
  const result = await handleRenderDiagram(
    { ...CTX, permissions: ['manage:system'] },
    { type: 'mermaid', source: 'graph TD; A-->B' }
  )
  assert.equal(consumeCalls.length, 0)
  assert.equal((result.content[0] as any).type, 'image')
})

test('handleRenderDiagram: maps the missing-Puppeteer CustomError onto a usable McpToolError', async () => {
  install({
    render: async () => {
      throw new CustomError(
        'diagramRenderPuppeteerMissing',
        'Rendering a Mermaid diagram on the server needs the Puppeteer extension, which is not installed.',
        503
      )
    }
  })
  await assert.rejects(
    () => handleRenderDiagram(CTX, { type: 'mermaid', source: 'graph TD; A-->B' }),
    (err: any) => {
      assert.ok(err instanceof McpToolError)
      assert.equal(
        err.message,
        'Rendering a Mermaid diagram on the server needs the Puppeteer extension, which is not installed.'
      )
      return true
    }
  )
})

test('handleRenderDiagram: maps the offline PlantUML CustomError onto a usable McpToolError', async () => {
  install({
    render: async () => {
      throw new CustomError(
        'diagramRenderOffline',
        'Cardinal.js is in offline mode and cannot reach a PlantUML server to render this diagram.',
        503
      )
    }
  })
  await assert.rejects(
    () => handleRenderDiagram(CTX, { type: 'plantuml', source: '@startuml\n@enduml' }),
    (err: any) => {
      assert.ok(err instanceof McpToolError)
      assert.equal(
        err.message,
        'Cardinal.js is in offline mode and cannot reach a PlantUML server to render this diagram.'
      )
      return true
    }
  )
})
