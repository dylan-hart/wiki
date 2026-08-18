# Variances

Genuine, justified deviations from spec — not a changelog. An entry is removed once resolved rather
than left as historical prose.

## 2026-08-17 — Kroki/PlantUML GET-URL transport, no server-side POST proxy (Feature 365 / Task 488)

`block-kroki` and `block-plantuml` (`blocks/block-kroki/component.js`,
`blocks/block-plantuml/component.js`) draw a diagram by GET: deflate the source, pack it into a
URL-safe encoding (Kroki's alphabet is plain base64url; PlantUML's is its own custom one), and set
that URL as an `<img src>`. Neither block has a POST fallback, and this fork has no backend proxy
route that would give it one. This is not a regression from 2.5.x — its own Kroki and PlantUML
markdown renderers (`server/modules/rendering/markdown-kroki`, `markdown-plantuml`, both gone from
this branch's tree, read from history) worked the same way: encode into the URL, hand it to the
browser as an `<img>`, nothing server-side in the request path at all.

**Why not build the proxy instead.** A generic `POST /_api/sites/:siteId/diagrams/kroki`-style
endpoint is not a thin passthrough: Kroki and PlantUML shape a POST request differently (Kroki takes
JSON with a `diagram_source`/`diagram_type`/`output_format` body; PlantUML's POST form is
implementation-specific to whichever server is configured), each needs its own timeout and
response-size handling so one slow or hostile upstream can't tie up a backend worker, and the
response has to carry CORS/caching headers a plain `<img>` never needed in the first place. That is
real, scoped backend work — a new route, request shaping per diagram type, and a decision about who
is allowed to point this instance's server at an arbitrary URL — not something to fold into a
frontend size-guard task. It is recorded as a follow-on rather than attempted here.

**What ships instead.** Both blocks now measure their own encoded URL in `firstUpdated()` before
setting `src` (`blocks/shared/url-limit.js`, `MAX_DIAGRAM_URL_LENGTH`). A diagram whose encoded URL
would exceed **8,000 characters** is refused with a clear `.error` explaining why and naming the
escape hatch, instead of silently attempting a request that many reverse proxies and servers would
have truncated or refused outright (previously surfacing only as `_explain()`'s generic "could not
be drawn" message once the browser's own `error` event fired). 8,000 was chosen as comfortably under
the most common default ceilings an author is likely to sit behind — nginx's
`large_client_header_buffers` default leaves headroom past 8k, and IIS/most CDNs draw their own line
in the same neighbourhood — while remaining generous for the diagrams this transport is meant for.

The documented workaround for a diagram that hits the limit is to redraw it as a Mermaid diagram
with the Diagram block (`block-diagram`), which renders entirely client-side via `mermaid` and has
no URL to size at all. This is not a hypothetical escape hatch invented for this entry: Kroki's own
`mermaid` type is already one of `block-kroki`'s supported diagram types, and `block-diagram` already
exists in this repo specifically as the URL-free alternative, so the guard's error message can point
at working, already-shipped functionality rather than a future feature.
