import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/** The version this instance's MCP server reports to a connecting client. */
export function createMcpServer(version: string): McpServer {
  return new McpServer(
    { name: 'wikijs-mcp', version },
    {
      instructions:
        'Wiki.js content server: search this wiki, read a page, and browse its navigation tree. ' +
        'Read-only. Every call runs as the site-wide API key configured on this server — see the ' +
        "`McpAuthContext` doc comment in mcp/auth.ts for what that key's permissions actually decide."
    }
  )
}
