# MCP: connecting an LLM agent to this wiki

Cardinal.js 3.x ships a real, built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server (`backend/mcp/`), running in-process inside the same server `node backend` already starts.
It exposes a small set of tools — search, read, browse and (for a real user) create/edit wiki pages,
plus a diagram renderer — to any MCP-speaking client: Claude Desktop, an IDE's agent mode, a
self-hosted agent framework, or a script talking the protocol directly. This is the guide for
turning that on: minting a token, the endpoint to point a client at, what each tool does, and how
site/permission scoping decides what a given token can see or do.

**Acceptance bar**: by the end of this page, you should be able to mint a token and successfully
call an MCP tool against your own instance — the [worked example](#a-worked-example-list_sites-with-curl)
at the bottom does exactly that with nothing but `curl`.

## 1. Mint a token

Every MCP call carries its own `Authorization: Bearer <token>` — the same bearer-token mechanism
`/_api/` already uses (`models/apiKeys.ts`), not a separate MCP-specific credential. There are two
places to mint one, and which you pick matters:

- **Personal Access Token** — **Profile → API Access** (`/_profile/api` in a running instance, or
  `POST /_api/users/profile/api-keys`). Any signed-in user can create one for themselves. A tool
  call made with this token is authorized as **that user's own current group membership and
  page-rule grants** — it can do exactly what they could do through the normal editor.
  **`create_page` and `update_page` only work with this kind of token**: a page written through MCP
  is attributed to a real author, and only a personal access token has one to offer.
- **Admin-issued API key** — **Admin → API Access** (`/_admin/api`, or `POST
/_api/system/api-keys`), for an administrator minting a key on behalf of an integration rather than
  a specific person. It can read anything its configured groups/scope grant, but has no user behind
  it — `create_page`/`update_page` refuse it outright with "requires a personal access token".

Either screen lets you narrow the token before copying it — worth doing for anything handed to an
LLM agent rather than kept for yourself:

- **Scope** — restrict which permissions the token carries (e.g. only `read:pages`), narrower than
  whatever the full account/key would otherwise hold.
- **Site** — pin the token to one site. An unscoped, multi-site instance's token must pass `siteId`
  explicitly on every call (see [Site scoping](#4-site-scoping) below); a pinned token never needs
  to, and is refused outright if it tries to name a different site.
- **Classification** — cap which classification levels the token may see, independent of what the
  underlying account/key otherwise holds.
- **Expiration** — a fixed lifetime (30 days out to 3 years); there is no non-expiring option.

The token's plaintext secret is shown exactly once, at creation. Store it in whatever secret store
your MCP client reads from — there is no way to retrieve it again afterwards, only revoke and mint a
replacement.

## 2. Two transports, one endpoint to actually use

`backend/mcp/` ships two transports sharing the same tools, models and database — pick the HTTP one
unless you have a specific reason not to:

- **Streamable HTTP** (`mcp/http.ts`) — mounted at **`/_mcp`** on the very same Fastify process
  `node backend` runs. This is the reference way to reach this wiki's MCP tools: point any
  HTTP-capable MCP client at `https://<your-instance>/_mcp` with the bearer token from step 1. One
  endpoint serves every caller; each request is authorized against its own token, so many people (or
  agents) can share it safely. Nothing extra to run or deploy.
- **stdio** (`mcp/stdio.ts`) — for a local desktop client (Claude Desktop, an IDE) that spawns a
  child process and speaks JSON-RPC over its stdin/stdout instead of HTTP. Run it as `node
backend/mcp/stdio.ts` from the repo root, with the token from step 1 in the `WIKI_MCP_API_KEY`
  environment variable. It re-verifies that token roughly every 30 seconds and before every tool
  call, so a revoked or regrouped token stops working on its next call without needing a restart —
  same as the HTTP transport's per-request verification, just on a timer instead of per-request
  since there is no per-request boundary on stdio.

The rest of this guide uses the HTTP transport, since that's what a client reaches from anywhere
other than the same machine.

### Session lifecycle (HTTP transport only)

The HTTP transport is the MCP spec's "Streamable HTTP": your client's `initialize` call gets back an
`Mcp-Session-Id` response header, which it then sends back on every subsequent request to the same
session. A session is tied to the token that opened it — a request naming someone else's session id
is refused — and is torn down automatically after 30 minutes of no requests, or on an explicit
`DELETE /_mcp` with that session's id. None of this is something you drive by hand; every MCP client
library handles it for you as part of speaking the protocol.

## 3. What's available: the tool list

| Tool              | What it does                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sites`      | List the wiki sites this token can see, with each site's id, hostname and default locale. Start here on a multi-site instance to learn what `siteId` to pass everywhere else.                                                                                                                                           |
| `search_pages`    | Full-text search over one site's pages, restricted to what the token may read. Returns matches with a highlighted excerpt.                                                                                                                                                                                              |
| `get_page`        | Read a single page by path — its rendered content and metadata, optionally its raw source.                                                                                                                                                                                                                              |
| `list_navigation` | List one folder of a site's page tree — the pages and sub-folders readable there.                                                                                                                                                                                                                                       |
| `list_assets`     | List the assets (uploaded files) in one folder of a site's tree, restricted to what the token may read.                                                                                                                                                                                                                 |
| `create_page`     | Create a new page from source content. **Requires a personal access token** with `write:pages` on the target path; refused if a page already exists there.                                                                                                                                                              |
| `update_page`     | Update an existing page — any subset of its fields, the rest left unchanged. **Requires a personal access token** with `write:pages` on the page.                                                                                                                                                                       |
| `upload_asset`    | Upload a file to the asset library (its bytes base64-encoded). **Requires a personal access token** — the upload is attributed to its owner — and `write:assets` on the destination folder.                                                                                                                             |
| `rename_asset`    | Rename an existing asset. Requires `manage:assets` on the folder it sits in.                                                                                                                                                                                                                                            |
| `delete_asset`    | Delete an asset. Requires `manage:assets` on the folder it sits in. This cannot be undone.                                                                                                                                                                                                                              |
| `render_diagram`  | Render a Mermaid or PlantUML diagram to a static SVG/PNG, server-side — independent of any site or page, since it renders posted source directly. Rate-limited the same as the web UI's own diagram export; Mermaid needs the Puppeteer extension installed on this instance, PlantUML needs the instance to be online. |

Every tool is always registered and visible to a client — nothing is hidden based on what a given
token happens to hold. `create_page`/`update_page`/`upload_asset` instead refuse **at call time**
with a clear error when the token can't use them (no personal access token behind it, or missing
the required page-rule permission), the same way the read tools refuse per-page rather than
per-tool. `delete_asset`/`rename_asset` refuse the same way for a token missing `manage:assets` on
the asset's folder.

## 4. Site scoping

A token that was pinned to a site at creation (step 1) always acts on that site; naming a different
`siteId` on a call is refused outright.

An **unscoped** token on a **single-site** instance needs nothing extra — every tool defaults to the
one enabled site. On a **multi-site** instance, an unscoped token must pass `siteId` explicitly on
every site-scoped call; `list_sites` is how it discovers what ids exist, mirroring what a client
does for a project id against `openproject-mcp` or similar multi-tenant MCP servers.

## 5. Page-rule permissions still apply

Beyond site scoping, every tool call is authorized against the calling token's real page-rule
permissions (`read:pages`, `write:pages`, …) exactly as if the request had gone through `/_api/` —
an MCP agent sees and can change nothing a human with the same token couldn't. A personal access
token acts as its owner's live group membership, re-checked on every call, so revoking a permission
(or the token itself) takes effect on the very next tool call, not merely on the next login.

## A worked example: `list_sites` with curl

MCP's Streamable HTTP transport is JSON-RPC 2.0 over POST, so it can be driven with nothing but
`curl` to prove a token works end to end. Replace `<token>` and `<your-instance>` below.

1. Open a session and call `list_sites` in one request — `initialize` first, `tools/call` after, is
   how every real client does it, but a single `tools/call` also implicitly opens a session on this
   server if none exists yet, which is the shortest path to a working example:

   ```sh
   curl -i https://<your-instance>/_mcp \
     -H 'Authorization: Bearer <token>' \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{
       "jsonrpc": "2.0",
       "id": 1,
       "method": "initialize",
       "params": {
         "protocolVersion": "2025-03-26",
         "capabilities": {},
         "clientInfo": { "name": "curl-example", "version": "0.0.0" }
       }
     }'
   ```

   The response carries an `Mcp-Session-Id` header — copy it for the next call.

2. List the available sites:

   ```sh
   curl -i https://<your-instance>/_mcp \
     -H 'Authorization: Bearer <token>' \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -H 'Mcp-Session-Id: <session id from step 1>' \
     -d '{
       "jsonrpc": "2.0",
       "id": 2,
       "method": "tools/call",
       "params": { "name": "list_sites", "arguments": {} }
     }'
   ```

   A working token and endpoint return the site (or sites) the token can see — id, hostname and
   default locale — confirming the round trip end to end. From here, any real MCP client (Claude
   Desktop, an IDE's agent mode, a framework like LangChain's MCP adapter) can be pointed at the same
   `/_mcp` endpoint and bearer token instead of raw curl.

## See also

- [`docs/operations.md`](operations.md) — backup/restore/upgrade for a running instance, including
  the API-key signing keypair MCP tokens rely on.
