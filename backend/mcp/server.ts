import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** The version this instance's MCP server reports to a connecting client. */
export function createMcpServer(version: string): McpServer {
  return new McpServer(
    { name: 'cardinaljs-mcp', version },
    {
      instructions:
        'Cardinal.js content server: search this wiki, read a page, browse its navigation tree, and (with ' +
        'a personal access token) create or update a page. Every call is authorized as the bearer ' +
        "token's own identity — a personal access token acts as its owner's real page-rule grants, an " +
        'admin-issued key acts as its own configured groups. See the `McpAuthContext` doc comment in ' +
        'mcp/auth.ts for exactly what that decides. Write tools refuse an admin-issued key outright: ' +
        'saving a page always needs a personal access token, the same requirement `/_api/` enforces.'
    }
  )
}
