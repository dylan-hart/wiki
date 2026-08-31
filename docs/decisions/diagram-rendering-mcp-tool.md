# Decision: server-side diagram rendering ships as an MCP tool, not retired

Status: **Decided — expose as `render_diagram` (option a)**
Date: 2026-08-31
Related: Epic 1941 ("Expose `models/diagramRender` as an MCP `render_diagram` tool, or retire the
endpoint"), Task 1944 (this decision), Task 1946 (carry-out)

## Context

`backend/api/diagrams.ts` (one route, `POST /_api/diagrams/render`) and
`backend/models/diagramRender.ts` (384 lines: a Puppeteer-driven Mermaid path, a hand-rolled
PlantUML deflate/encode, size caps, timeouts, and rate limiting via `limitRenders`) render a
Mermaid or PlantUML diagram to SVG/PNG server-side.

Nothing in the product calls it today. `grep -rn 'diagramRender' backend --include='*.ts' | grep -v
'\.test\.'` returns only the model's own internals, its registration in `models/index.ts`, a
comment in `models/liveData.ts` referencing its `launchBrowser` pattern, and `api/diagrams.ts`
itself. `frontend/src`, `blocks/` and `e2e/` make zero fetches to it — `block-diagram` and
`block-plantuml` draw client-side, and `models/pdfExport.ts` uses its own headless-Chromium path
that mounts the real Lit block components rather than calling this route.

It is not undocumented dead code, though: the route carries a full Fastify `schema` with
`tags: ['Diagrams']` and is published in Swagger UI at `/_api`, so an external integrator can
already discover and call it. Deleting it removes a documented endpoint, not just reclaims
unreachable internal code.

Separately, `backend/mcp/tools/` (the in-process MCP server's tool surface) ships six tools —
`list_sites`, `search_pages`, `get_page`, `list_navigation`, `create_page`, `update_page` — and none
of them can hand an MCP-speaking agent a rendered image of anything.

## Options considered

**(a) Ship it as an MCP tool.** Add a `render_diagram` tool under `backend/mcp/tools/`, following
the shape of the existing six (a `register*Tool(server, getCtx)` export, wired into
`registerAllTools` in `backend/mcp/tools/index.ts`), delegating to
`WIKI.models.diagramRender.render()` — the same call `api/diagrams.ts`'s handler already makes.
Auth, the `limitRenders` rate limit, size caps and timeouts all already exist in the model; the new
code is a thin adapter, not a reimplementation. The REST route stays as-is.

**(b) Retire it.** Delete `backend/api/diagrams.ts`, `backend/models/diagramRender.ts`, their
registration in `models/index.ts`, and their test suites; record the removal of a published,
Swagger-documented endpoint in `docs/variances.md`.

## Decision

**Option (a): ship `render_diagram` as an MCP tool.** The REST route and the model are unchanged;
Task 1946 adds the tool wrapper. No `docs/variances.md` entry is needed, since nothing is being
removed.

## Reasoning

- **The infrastructure is already built and already maintained.** Auth, `limitRenders` rate
  limiting, size caps, timeouts, the Mermaid/Puppeteer path and the PlantUML encode/deflate path all
  exist and are exercised by the REST route's own tests today. Wiring an MCP tool is a thin adapter
  over `WIKI.models.diagramRender.render()` (mirroring exactly what `api/diagrams.ts`'s handler
  does), not new rendering logic — the epic's own effort estimate is "small" on this basis.
- **Retiring destroys more than it reclaims.** The route is a published, `tags: ['Diagrams']`,
  Swagger-documented endpoint — an external integrator can already be calling it. Deleting it is a
  breaking change to a documented public contract, not a cleanup of dead internal code; the "nothing
  in-product calls it" fact is about first-party callers, not about whether the surface has
  consumers at all.
- **The gap it fills is real and matches the MCP server's own trajectory.** `backend/mcp/tools/`
  currently has read tools (list/search/get pages, list navigation) and two write tools
  (create/update page), but nothing that returns rendered visual output — a natural, previously
  missing capability for an agent that wants to embed or inspect a diagram without running the
  block's client-side JS itself, which is exactly the scenario `api/diagrams.ts`'s own route
  comment already documents as its reason to exist.
- **Deleting would still need to be re-justified later.** If `render_diagram` shipped and then went
  unused too, that would be a separate, later observation to make about the MCP tool specifically —
  not a reason to avoid finding out. Retiring now forecloses that option for a comparatively small
  wiring cost.

## When to revisit

If `render_diagram` ships (Task 1946) and sees no use — neither via the MCP surface nor the
existing REST route — by a future audit pass, revisit retirement then with both call sites' real
usage data in hand, rather than the current call graph alone.

## Non-decision

No application code changes accompany this document — per Task 1944's own scope, the tool
implementation is Task 1946's. `backend/api/diagrams.ts`, `backend/models/diagramRender.ts`, and
`backend/mcp/tools/` are unchanged by this commit.
