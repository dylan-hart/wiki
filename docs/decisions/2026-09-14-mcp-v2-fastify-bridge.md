# Decision: hand-roll the MCP HTTP transport's Fastify bridge, don't add `@modelcontextprotocol/node` or `@modelcontextprotocol/fastify`

**Date:** 2026-09-14 · **Context:** OpenProject #3160 (Backend: migrate the in-process MCP server from `@modelcontextprotocol/sdk` v1 to the v2 `server` + Fastify adapter packages)

## Background

#3160's scope said to "rework `mcp/http.ts`'s transport and session layer onto the Fastify adapter
where it fits" and its acceptance criteria require `npm ls express hono` to show neither pulled in by
MCP (source: `docs/audits/2026-09-13-dependency-audit.md` §4/A — v1's runtime dependencies pull in
express, hono, `@hono/node-server`, cors, express-rate-limit, cross-spawn and jose, none of which this
codebase uses).

## What the v2 packages actually are

Installed and inspected directly (this environment's npm registry mirrors genuine v2.0.0 GA
packages):

- `@modelcontextprotocol/server` (deps: `zod`, `@modelcontextprotocol/core` only) exports `McpServer`,
  `isInitializeRequest`, `StdioServerTransport` (at `/stdio`), and
  `WebStandardStreamableHTTPServerTransport` — a Streamable HTTP transport built on the Fetch API's
  `Request`/`Response`, not Node's `IncomingMessage`/`ServerResponse`.
- `@modelcontextprotocol/fastify` — despite the name, this is NOT a routing/transport adapter. Its
  entire surface is `createMcpFastifyApp()` (builds a whole new standalone `FastifyInstance`
  pre-configured with DNS-rebinding protection) plus `hostHeaderValidation()`/`originValidation()`
  onRequest hooks. It contains no code that bridges a Fastify request/reply to the transport at all.
- `@modelcontextprotocol/node`'s `NodeStreamableHTTPServerTransport` IS the Node-req/res-shaped
  transport (`handleRequest(req.raw, reply.raw, req.body)` — the same call shape v1's
  `StreamableHTTPServerTransport` used), which is what the official codemod
  (`@modelcontextprotocol/codemod v1-to-v2`) rewrites v1 code onto by default. But its own
  `package.json` `dependencies` (not `peerDependencies`) field pulls in `@hono/node-server`, which
  itself peer-depends on `hono` — confirmed with a real `npm install` + `npm ls hono` in a scratch
  project: `hono@4.13.7` shows up in the tree the moment `@modelcontextprotocol/node` is installed,
  regardless of which of its exports are actually imported.

## Decision

- **Do not add `@modelcontextprotocol/node`** as a dependency — it reintroduces `hono`, which #3160
  exists specifically to remove.
- **Do not add `@modelcontextprotocol/fastify`** as a dependency either — it has nothing useful to
  offer this codebase's mounting shape (a route plugin registered inside the one existing Fastify
  app via `core/http/routes.ts`, not a standalone app), and its host/origin-validation hooks would be
  a new behavior this WP was told to keep unchanged ("keep the current HTTP surface and auth
  semantics unchanged" — host/origin allowlisting has never applied to this route, and a static
  allowlist doesn't fit a multi-site wiki addressed by arbitrary configured hostnames without further
  design work outside this WP's scope).
- **Add only `@modelcontextprotocol/server`**, and bridge Fastify's request/reply to the Fetch API
  `Request`/`Response` `WebStandardStreamableHTTPServerTransport` expects with a small, dependency-free
  adapter: `backend/mcp/webBridge.ts` (`toWebRequest()` / `sendWebResponse()`). It uses only Node's own
  global `fetch` API types (`Request`/`Response`/`Headers`, native since Node 18) and
  `node:stream`'s `Readable.fromWeb()` + `node:stream/promises`' `pipeline()` to stream an SSE
  response body back onto the hijacked raw reply.

## Consequences

- `npm ls express hono` shows neither, satisfying #3160's acceptance criterion directly.
- `mcp/http.ts` needs a few more lines per request handler (build a `Request`, then forward the
  returned `Response`) than the codemod's default output would have needed, in exchange for owning a
  ~50-line bridge file instead of a second SDK package plus its `hono` dependency.
- The `@modelcontextprotocol/codemod v1-to-v2` tool's default rewrite of `mcp/http.ts`/
  `mcp/http.test.ts` was NOT applied as-is for this reason; every other file it touched (the 18
  `mcp/tools/*.ts` files, `tools/index.ts`, `tools/shared.ts`, `server.ts`, `stdio.ts`) was a pure
  import-path rewrite with no such tradeoff and was taken as the codemod produced it (reformatted).
