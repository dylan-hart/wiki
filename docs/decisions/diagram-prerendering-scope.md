# Decision: server-side diagram pre-rendering stays per-diagram, not per-page

Status: Decided — descoped from Feature 402 to Task 785, which shipped the narrower version
Date: 2026-08-17 (Feature 402 descope), revisited when Task 785 shipped
Related: Feature 402 ("Extension-to-Feature Wiring: Pandoc Import & Puppeteer PDF/Diagram Export"),
Task 666, Task 785 (`backend/models/diagramRender.ts`)

## Context

Mermaid, PlantUML, and Kroki diagrams are drawn entirely client-side by `block-diagram` /
`block-plantuml` / `block-kroki` — Lit web components that read their fenced source out of the page
and render at _view time_, inside a live browser page that has loaded the full block-component
runtime. The existing headless surface (`backend/controllers/render.ts`'s `/_render`, driven by
`models/rendering.ts`) only re-runs the markdown-to-HTML pass (`frontend/src/renderers/headless.js`
→ `window.__wikiRender`); it is a bare shell that does not load block components at all, so it
cannot produce pre-rendered diagram markup today even in principle.

Making that headless *page*-render pipeline do so means running Lit block components inside a
headless context outside their current view-time-only execution model — a real design problem: how
a headless pass instantiates the block, waits for its diagram library to settle, extracts or
rasterizes the result, and where that output is cached relative to stored `page.render` HTML. Feature
402 (task 666) judged that out of proportion for its own scope and descoped it to a standalone
follow-up, OpenProject task 785 ("Puppeteer: server-side pre-rendered Mermaid/PlantUML diagrams").

## Decision

Task 785 built a capability that sidesteps the page-level problem above rather than solving it:
`backend/models/diagramRender.ts` (`WIKI.models.diagramRender.render()`, `POST
/_api/diagrams/render`) renders **one diagram from raw source, independent of any page** — there is
no page-render pipeline to extend and no render cache to invalidate, because nothing is wired into
`models/rendering.ts`'s stored-HTML pipeline.

- **Mermaid** still needs a real browser — `mermaid` lays out and paints via the DOM. Rather than
  adding a second `mermaid` dependency to the backend or reimplementing its render call directly,
  `diagramRender.ts` drives Puppeteer to load `block-diagram`'s own compiled bundle
  (`/_blocks/block-diagram.js` — the exact code a reader's browser runs) onto a blank page, mounts
  one instance of it, and waits with the same `blockSettleScript` `models/pdfExport.ts` uses for a
  whole page. A single block's `firstUpdated()`/`updateComplete` lifecycle needs nothing about being
  inside the full SPA shell, which is what makes "mount one block on an empty page" a real shortcut
  rather than a smaller version of the same architectural problem.
- **PlantUML** needs no browser at all: `block-plantuml` never draws locally — it deflates the
  source into a PlantUML server's GET URL and lets the reader's browser fetch an `<img>` from it.
  `diagramRender.ts` mirrors that transport server-side with Node's built-in `zlib.deflateRawSync`
  and fetches the bytes directly, so the Puppeteer extension is never required for a PlantUML
  request — only for Mermaid.

**Page-level pre-rendering — wiring per-diagram rendering into `models/rendering.ts`'s stored-HTML
pipeline so a whole page's diagrams pre-render together, e.g. as part of PDF export instead of
waiting on the live view to draw them one at a time — remains unbuilt and would be its own future
task if ever wanted.** The win is real but unproven without profiling data on where PDF export time
actually goes, and nothing about `diagramRender.ts`'s shape forecloses wiring it in later.
