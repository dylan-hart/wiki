# Variances

Genuine, justified deviations from spec. An entry here means something promised elsewhere (a
`definition.yml` description, a spec doc, an epic) is deliberately not being built as originally
worded, and why. This file does not record resolved CI noise or lint/type exceptions — those get
fixed, not logged. Delete an entry once it is resolved.

## Feature 402 — Puppeteer: server-side diagram pre-rendering descoped

**Decided in:** Task 666 ("Decide and record scope per promised capability; correct definition.yml
wording for whatever is descoped"), part of Feature 402 ("Extension-to-Feature Wiring: Pandoc Import
& Puppeteer PDF/Diagram Export").

Feature 402 covers three capabilities that `backend/modules/extensions/pandoc/definition.yml` and
`backend/modules/extensions/puppeteer/definition.yml` promised but that nothing in the codebase
actually implemented:

1. **Pandoc multi-format page import** (MediaWiki, AsciiDoc, Textile, DocBook, …) — **building now**
   (Feature 402 tasks 667/668). A straightforward `execFile` shell-out, comparable in shape to the
   extension-install pattern already used elsewhere in `models/extensions.ts`.
2. **Puppeteer PDF export** of a page — **building now** (Feature 402 tasks 669/670). A headless
   Chromium print-to-PDF against the real, live page-view URL, waiting for async block components
   (Mermaid, PlantUML) to settle before calling `page.pdf()`. See the cross-branch note below — a
   materially simpler PDF export (printing the already-stored `page.render` HTML, not the live SPA
   view) also exists on the unmerged `feature/page-version-export` branch (Feature 371, task 496).
   Both are real, different designs solving overlapping problems on two different unmerged branches;
   this is flagged for a human to reconcile at merge-review time, not resolved here.
3. **Puppeteer server-side pre-rendered Mermaid/PlantUML diagrams** — **deferred**. Tracked as
   OpenProject task 785 ("Puppeteer: server-side pre-rendered Mermaid/PlantUML diagrams (deferred
   from Feature #402)").

### Why #3 is deferred and #1/#2 are not

Web research (recorded on Feature 402) confirms none of the three ever shipped in Wiki.js 2.5.x —
each surfaces only as a community feature request, never a delivered feature. So none of the three
required migration or compatibility handling; the only question was whether to build each for real
now or correct the `definition.yml` claim.

\#1 and #2 are both straightforward: a CLI conversion piped through `execFile`, and a headless-browser
print of a page that already renders correctly in a live browser context. Both fit cleanly into
existing patterns in this codebase.

\#3 is architecturally heavier. Mermaid, PlantUML, and Kroki diagrams are drawn entirely client-side
today by `block-diagram` / `block-plantuml` / `block-kroki` — Lit web components that read their
fenced source out of the page and render at _view time_, inside a live browser page that has loaded
the full block-component runtime. The existing headless surface
(`backend/controllers/render.ts` `/_render`, driven by `models/rendering.ts`) only re-runs the
markdown-to-HTML pass (`frontend/src/renderers/headless.js` → `window.__wikiRender`); it is a bare
shell that does not load block components at all, so it cannot produce pre-rendered diagram markup
today even in principle. Making it do so means running Lit block components inside a headless
context outside their current view-time-only execution model — a real design problem (how a headless
pass instantiates the block, waits for its diagram library to settle, extracts or rasterizes the
result, and where that output is cached relative to stored `page.render` HTML), not a shell-out or a
print job. That is out of proportion for this Feature, so it is descoped to task 785 rather than
built now.

### Correction made

`backend/modules/extensions/puppeteer/definition.yml`'s `description` previously read:

> Headless Chromium browser. Required to export pages as PDF and to render content elements on the
> server, such as Mermaid or PlantUML diagrams. …

It now describes only PDF export, matching what Feature 402 actually builds. Resolve/delete this
entry once task 785 ships and the description can honestly mention server-side diagram rendering
again.
