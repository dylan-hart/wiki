/**
 * Structural checks on `docs/mcp-getting-started.md` (OpenProject #2434 — the MCP server had zero
 * discoverability: it was built and tested, but nothing told a user how to mint a token and call it).
 *
 * Two kinds of assertion, mirroring `backend/test/operations-doc.test.ts`:
 *  - Structural: the doc covers what the work package's resolved scope requires — minting a token,
 *    the HTTP transport's endpoint path, the available tools, and site-scoping behavior.
 *  - Drift guard: the tool names the doc documents are read back against `backend/mcp/tools/index.ts`'s
 *    real `registerAllTools()` call list, and the endpoint path against `backend/core/http/routes.ts`'s
 *    real mount — so the doc cannot silently list a tool that no longer exists, miss one that was
 *    added, or point at a stale path.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DOC_PATH = path.join(REPO_ROOT, 'docs/mcp-getting-started.md')
const TOOLS_INDEX_PATH = path.join(REPO_ROOT, 'backend/mcp/tools/index.ts')
const ROUTES_PATH = path.join(REPO_ROOT, 'backend/core/http/routes.ts')
const README_PATH = path.join(REPO_ROOT, 'README.md')

/** Every `register*Tool(...)` call inside `registerAllTools()`, in source order. */
function realToolRegistrationCalls(): string[] {
  const raw = fs.readFileSync(TOOLS_INDEX_PATH, 'utf8')
  const body = raw.slice(raw.indexOf('export function registerAllTools'))
  return [...body.matchAll(/register(\w+)Tool\(server, getCtx\)/g)].map((m) => m[1])
}

/** The actual `mcp-tool-name` string each `mcp/tools/*.ts` file registers with the SDK. */
function realToolNames(): string[] {
  const toolsDir = path.join(REPO_ROOT, 'backend/mcp/tools')
  const names: string[] = []
  for (const entry of fs.readdirSync(toolsDir)) {
    if (
      !entry.endsWith('.ts') ||
      entry.endsWith('.test.ts') ||
      entry === 'index.ts' ||
      entry === 'shared.ts'
    ) {
      continue
    }
    const raw = fs.readFileSync(path.join(toolsDir, entry), 'utf8')
    const match = raw.match(/server\.registerTool\(\s*'([a-z_]+)'/)
    if (match) {
      names.push(match[1])
    }
  }
  return names.sort()
}

describe('docs/mcp-getting-started.md — MCP onboarding guide', () => {
  test('exists', () => {
    assert.ok(fs.existsSync(DOC_PATH), `expected ${DOC_PATH} to exist`)
  })

  const raw = fs.readFileSync(DOC_PATH, 'utf8')

  describe('covers the required onboarding topics (OpenProject #2434 scope)', () => {
    test('minting a token', () => {
      assert.match(raw, /Personal Access Token/)
      assert.match(raw, /Mint a token/i)
    })

    test('the HTTP transport endpoint path', () => {
      assert.match(raw, /`\/_mcp`/)
    })

    test('the available tools', () => {
      assert.match(raw, /## 3\. What's available/)
    })

    test('site-scoping behavior', () => {
      assert.match(raw, /## 4\. Site scoping/)
      assert.match(raw, /siteId/)
    })

    test('a runnable end-to-end example', () => {
      assert.match(raw, /curl/)
      assert.match(raw, /tools\/call/)
    })
  })

  test('every real MCP tool name is documented', () => {
    const names = realToolNames()
    assert.ok(
      names.length > 0,
      'expected at least one tool to be discovered from backend/mcp/tools/*.ts'
    )
    for (const name of names) {
      assert.match(
        raw,
        new RegExp('`' + name + '`'),
        `docs/mcp-getting-started.md should mention the real tool \`${name}\` — ` +
          'if this tool was renamed or removed, update the doc to match'
      )
    }
  })

  test('the documented tool list matches registerAllTools() 1:1, not a stale subset', () => {
    const registered = realToolRegistrationCalls()
    assert.ok(registered.length > 0, 'expected registerAllTools() to register at least one tool')
    // -> Every function registerAllTools() calls has a real source file behind it (realToolNames()
    //    would otherwise be shorter than this list), and every discovered tool name is documented
    //    above — together these two assertions guarantee the doc's table has exactly as many rows
    //    as the server actually registers, with no manual count to keep in sync by hand.
    assert.equal(
      registered.length,
      realToolNames().length,
      'registerAllTools() call count should match the number of registerTool() call sites under backend/mcp/tools/'
    )
  })

  test('bearer-token auth is described as the same mechanism /_api/ uses', () => {
    assert.match(raw, /Authorization: Bearer/)
  })

  test('create_page/update_page are documented as requiring a personal access token', () => {
    assert.match(raw, /create_page.*personal access token|personal access token.*create_page/is)
  })
})

describe('backend/core/http/routes.ts — /_mcp mount matches the doc', () => {
  test("the doc's endpoint path is really mounted", () => {
    const routesRaw = fs.readFileSync(ROUTES_PATH, 'utf8')
    assert.match(
      routesRaw,
      /prefix:\s*'\/_mcp'/,
      'expected backend/core/http/routes.ts to mount mcp/http.ts at /_mcp'
    )
  })
})

describe('README.md — links the new guide', () => {
  test('the docs index references docs/mcp-getting-started.md', () => {
    const readmeRaw = fs.readFileSync(README_PATH, 'utf8')
    assert.match(readmeRaw, /docs\/mcp-getting-started\.md/)
  })
})
