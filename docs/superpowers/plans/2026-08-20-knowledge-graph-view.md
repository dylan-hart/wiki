# Interactive Knowledge Graph View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reader-facing `/_graph` view showing the whole current site's pages as an interactive, pannable/zoomable node graph — canvas-rendered via `d3-force` — with pages clustered into translucent, color-coded sectors by folder or tag, and drill-down filters (tag, folder depth, locale) that re-cluster live against data fetched once.

**Architecture:** `GET /_api/sites/:siteId/graph` returns the entire permitted graph for the site (all locales) in one response — nodes from `pages` rows the caller may `read:pages`, edges from `pages.relations` (labeled) and a new `pages.links` column (unlabeled, extracted from rendered content at save time). Every filter and re-cluster after the initial fetch runs client-side against data already in memory, no round trip per tweak — viable because real-world scale is low hundreds to low thousands of pages (per spike #871). The frontend is a new `frontend/src/pages/Graph.vue`, a full-viewport `<canvas>` driven by a `d3-force` simulation, redrawn on every tick (edges → cluster hulls → node dots → labels), with `d3-zoom` for pan/zoom and a `d3-quadtree` rebuilt each tick for click/hover hit-testing (canvas has no per-node DOM).

**Tech Stack:** Backend: TypeScript 7, Fastify route + JSON Schema, Drizzle/Postgres (`jsonb` column), cheerio (already in the save-time rendering pipeline). Frontend: Vue 3 `<script setup>`, `d3-force`/`d3-quadtree`/`d3-zoom`/`d3-drag`/`d3-selection`/`d3-polygon` (new deps), Vitest + `@vue/test-utils`.

**Spec:** `docs/superpowers/specs/2026-08-20-knowledge-graph-view-design.md` — read in full before starting; spike #871's decisions (edge sources, canvas rendering, reader-facing placement) are locked, not open questions.

**Epic:** OpenProject #848. **Features:** #872 (backend endpoint), #873 (graph component), #874 (clustering & color), #875 (drill-down filters), #876 (placement).

---

## Global Constraints

- **Formatting/linting, scoped to touched files only, after each task:**
  - Backend: `npx oxfmt <touched files>` then `npx oxlint <touched files>` from `backend/`.
  - Frontend: `npx oxfmt <touched files>` then `npx oxlint <touched files>` from `frontend/`.
- **Tests, scoped, never the full suite:**
  - Backend: `npx node --test <file>.test.ts` (or `npm run test -- <file>` equivalent) from `backend/`.
  - Frontend: `npx vitest run <file>.test.js` from `frontend/`.
- **TypeScript relative imports carry the real `.ts` extension** (`allowImportingTsExtensions`) — every new backend import (`./graph.ts`, `../models/pages.ts`, ...) is written that way, not extensionless.
- **`catch (err: any)`** at each new/converted backend catch site, per CLAUDE.md's TypeScript (backend) convention — none of this plan's backend code is expected to need a `try`/`catch`, but if a step adds one, annotate it this way rather than touching `tsconfig.json`.
- **Page-rule permission checks go in the route handler**, never `config.permissions` — `read:pages` is a page-rule permission (CLAUDE.md's Permissions section). Every route in this plan carries a `No route-level permissions:` comment explaining why, matching `api/pages.ts` / `api/notifications.ts`.
- **`npm run db-generate` must be run, never hand-written**, for Task 1's migration (from `backend/`) — commit the generated `backend/db/migrations/<timestamp>_main/` directory exactly as drizzle-kit writes it.
- **Commit messages carry a `(OpenProject #NNN)` suffix** naming the Task WP the commit closes out, matching the reference plan's convention (`docs/superpowers/plans/2026-08-20-markdown-editor-list-continuation.md`).
- **New icon literals** go through `npm run icons` (from `frontend/`) — never render an ad hoc Iconify reference without regenerating `src/assets/icons.generated.js`, per CLAUDE.md's Icons section.
- **`es-toolkit`, not `lodash-es`; native `Temporal`, not luxon`** — this plan's new code has no date handling and no obvious lodash-shaped helper, so this should not come up, but if a step reaches for either, use the repo's replacements instead.
- **Pure-unit tests preferred, no `WIKI` global / no database**, for every backend logic task below (#880–#884) — `assembleGraph`/`folderOf`/`extractInternalLinks` are all designed as plain functions or exercised through `rendering.postProcess()`'s existing minimal-stub pattern (`backend/models/rendering.test.ts`), never `backend/test/db.ts`'s DB-backed fixture. None of this epic's backend logic needs real SQL orchestration to verify.

## Sequencing note

Feature-level dependencies are already recorded in OpenProject: **873 blockedBy 872; 874 blockedBy 873; 875 blockedBy 873 and 874; 876 is independent** and can be worked any time, including in parallel with 872 — neither blocks the other. This plan orders tasks accordingly: **872's five tasks first** (Tasks 1–5), **then 876's four tasks** (Tasks 6–9, explicitly callable in parallel with Tasks 1–5 rather than strictly after them), **then 873's seven tasks** (Tasks 10–16), **then 874's six tasks** (Tasks 17–22), **then 875's five tasks** (Tasks 23–27).

---

# Feature #872 — Backend: graph data endpoint

## Task 1: `links` jsonb column + migration (OpenProject #880)

**Files:**
- Modify: `backend/db/schema.ts:561` (the `pages` table's column list, immediately after the existing `relations: jsonb().notNull().default([]),` line)
- Generate (do not hand-write): a new `backend/db/migrations/<timestamp>_main/` directory via `npm run db-generate`

**Interfaces:**
- Produces: the `pages.links` column — `jsonb`, `NOT NULL DEFAULT '[]'`, holding a `string[]` of internal-link target page paths. Consumed by Task 2 (`extractInternalLinks` writes it), Task 3 (`listAllForGraph` reads it), Task 5 (`assembleGraph` turns it into `link`-type edges).

- [ ] **Step 1: Add the column**

In `backend/db/schema.ts`, right after the existing `relations` column (line 561):

```ts
    relations: jsonb().notNull().default([]),
    // -> Internal-link target page paths found in the rendered content, resolved at save time by
    //    `models/rendering.ts#extractInternalLinks` (OpenProject #881). Unlike `relations` (authored,
    //    explicit) this is derived and gets fully overwritten on every save/re-render — never
    //    hand-edited, and never merged with a prior value.
    links: jsonb().notNull().default([]),
    content: text(),
```

- [ ] **Step 2: Generate and inspect the migration**

```bash
cd backend
npm run db-generate
```

Expected: a new `backend/db/migrations/<timestamp>_main/` directory containing one `.sql` file that adds the `links` column to `pages` with `DEFAULT '[]'::jsonb NOT NULL`, plus drizzle-kit's updated `meta/_journal.json` and a new `meta/<seq>_snapshot.json`. Read the generated SQL to confirm it touches only `pages.links` — nothing else in `db/schema.ts` should have drifted since the last migration.

- [ ] **Step 3: Typecheck**

```bash
cd backend
npm run typecheck
```

Expected: no errors — the column is additive and nothing yet reads `pages.links`, so no other file's types should be affected.

- [ ] **Step 4: Format, lint**

```bash
cd backend
npx oxfmt db/schema.ts
npx oxlint db/schema.ts
```

- [ ] **Step 5: Commit**

```bash
git add backend/db/schema.ts backend/db/migrations/
git commit -m "feat: add pages.links jsonb column for internal-link edges (OpenProject #880)"
```

---

## Task 2: `extractInternalLinks()` save-time pipeline step (OpenProject #881)

**Files:**
- Modify: `backend/models/rendering.ts`
  - `PostProcessResult` interface (line 85–92): add a `links: string[]` field
  - `postProcess()` (line 400–421): add a `pagePath` parameter, call the new step, include `links` in the return
  - New private method `extractInternalLinks($, pagePath)`, placed as a sibling of `anchorHeadings` (line 772) and `extractText` (line 831)
- Modify: `backend/models/pages.ts`
  - `createPage()` (~line 604): pass `path` as `postProcess`'s new 4th argument, store `links` on the insert
  - `updatePage()` (~line 792): pass `existing.path`, store `links` on the patch when `patch.render` is set
  - `storeRender()` (line 1150–1168): add a `pagePath: string` parameter, thread it through, store `links` on the update
- Modify: `backend/models/rendering.ts:1028-1036` (the render-queue drain loop, `storeRender`'s only caller) — pass `page.path`, already in scope there
- Modify: `backend/models/rendering.test.ts`: new `describe` block for the extraction

**Interfaces:**
- Produces: `PostProcessResult.links: string[]` — resolved internal-link target page paths, deduplicated. Consumed by Task 3 (`listAllForGraph`/`assembleGraph`).
- Consumes: nothing new; ports (not imports — this runs in Node, no `document`) the href-classification idea from `frontend/src/renderers/markdown.js`'s `isExternalHref`/`fileSrc`.

- [ ] **Step 1: Add a failing test**

In `backend/models/rendering.test.ts`, add a new `describe` block (after the existing diagram-block-handoff suites):

```ts
describe('rendering.postProcess: internal link extraction (OpenProject #881)', () => {
  test("resolves a relative link against the page's folder", async () => {
    const html = '<p><a href="../sibling">Sibling</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/child/page'
    )
    assert.deepEqual(result.links, ['docs/sibling'])
  })

  test('resolves a root-relative link as-is, dropping the leading slash', async () => {
    const html = '<p><a href="/getting-started">Start</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, ['getting-started'])
  })

  test('ignores external, mailto, and fragment-only links', async () => {
    const html =
      '<p><a href="https://example.com">Ext</a> <a href="mailto:a@b.com">Mail</a> <a href="#section">Frag</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, [])
  })

  test('de-duplicates repeated links to the same page', async () => {
    const html = '<p><a href="sibling">One</a> <a href="sibling">Two</a></p>'
    const result = await rendering.postProcess(
      'site-1',
      html,
      { scripts: false, styles: false },
      'docs/page'
    )
    assert.deepEqual(result.links, ['docs/sibling'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend
node --test models/rendering.test.ts
```

Expected: FAIL on all four new tests — `postProcess()` does not yet accept a 4th `pagePath` argument and `result.links` is `undefined`, so every `assert.deepEqual` fails.

- [ ] **Step 3: Implement `extractInternalLinks()` and thread `pagePath` through `postProcess()`**

In `backend/models/rendering.ts`, extend `PostProcessResult` (line 85):

```ts
export interface PostProcessResult {
  /** The HTML to store and serve. */
  render: string
  /** The table of contents, derived from the headings. */
  toc: TocNode[]
  /** Plain text, for the search index. */
  text: string
  /** Internal-link target page paths, deduplicated — see `extractInternalLinks`. */
  links: string[]
}
```

Update `postProcess()`'s signature and body (line 400):

```ts
  async postProcess(
    siteId: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string = ''
  ): Promise<PostProcessResult> {
    const enabledBlocks = await WIKI.models.blocks.getEnabledKeys(siteId)
    const clean = this.sanitize(html ?? '', permissions, enabledBlocks)

    const $ = cheerio.load(clean, null, false)

    this.stripEditorArtifacts($)
    this.unwrapOrphanedChildBlocks($)
    this.liftIconChildren($)
    await this.inlineIcons($)
    const toc = this.anchorHeadings($)
    const links = this.extractInternalLinks($, pagePath)

    return {
      render: $.html(),
      toc,
      text: this.extractText($),
      links
    }
  }
```

Add the new private method as a sibling of `anchorHeadings`/`extractText` (after `extractText`, line 835):

```ts
  /**
   * Internal link targets on the page, resolved to page paths — what `pages.links`
   * (`db/schema.ts`) stores and the knowledge graph endpoint (`api/graph.ts`, OpenProject #872)
   * reads as `link`-type edges.
   *
   * Ported rather than reused from `frontend/src/renderers/markdown.js`'s
   * `isExternalHref`/`fileSrc`: this runs in Node, with no `document` to resolve a bare-relative
   * href against, and only cares about anchors, not images — an internal image is a file under
   * `/_files/`, never another page.
   */
  private extractInternalLinks($: cheerio.CheerioAPI, pagePath: string): string[] {
    const folder = pagePath.split('/').slice(0, -1).join('/')
    const targets = new Set<string>()

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim()
      if (!href || href.startsWith('#') || href.startsWith('//')) {
        return
      }
      // -> Any other scheme (`http:`, `https:`, `mailto:`, `tel:`, ...) is not a page on this
      //    wiki -- `fileSrc` excludes the same set, for the same reason, for images.
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        return
      }
      try {
        const url = new URL(href, `http://page.invalid/${folder ? `${folder}/` : ''}`)
        const target = url.pathname.replace(/^\/+/, '')
        if (target) {
          targets.add(target)
        }
      } catch {
        // -> Malformed href written by an author; nothing to link.
      }
    })

    return [...targets]
  }
```

Thread `pagePath` through the three call sites in `backend/models/pages.ts`:

`createPage()` (~line 604) — `path` is already in scope:

```ts
    const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
      siteId,
      input.render ?? '',
      {
        scripts: hasPermission(actor, 'write:scripts', pageRef),
        styles: hasPermission(actor, 'write:styles', pageRef)
      },
      path
    )
```

...and add `links` to the row inserted a few lines below (alongside the existing `relations: input.relations ?? []`).

`updatePage()` (~line 792) — `existing.path` is already in scope:

```ts
    if (patch.render !== undefined) {
      const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
        siteId,
        patch.render,
        {
          scripts: hasPermission(actor, 'write:scripts', existingRef),
          styles: hasPermission(actor, 'write:styles', existingRef)
        },
        existing.path
      )
      values.render = render
      values.toc = toc
      values.searchContent = text
      values.links = links
    }
```

`storeRender()` (line 1150) gains a `pagePath` parameter and stores `links`:

```ts
  async storeRender(
    siteId: string,
    id: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string
  ): Promise<void> {
    const { render, toc, text, links } = await WIKI.models.rendering.postProcess(
      siteId,
      html,
      permissions,
      pagePath
    )

    const updated = await WIKI.db
      .update(pagesTable)
      .set({ render, toc, searchContent: text, links, updatedAt: sql`now()` })
      .where(and(eq(pagesTable.id, id), eq(pagesTable.siteId, siteId)))
      .returning()
```

...and its one caller, `backend/models/rendering.ts`'s render-queue drain loop (line 1033), passes the path it already has on hand (`page.path`, read at line 1031):

```ts
          await WIKI.models.pages.storeRender(
            entry.siteId,
            page.id,
            html,
            { scripts: entry.allowScripts, styles: entry.allowStyles },
            page.path
          )
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend
node --test models/rendering.test.ts
npm run typecheck
```

Expected: PASS — the four new tests, plus every existing test in the file (unaffected, since `pagePath` defaults to `''` and none of them pass a 4th argument). Typecheck clean across `models/pages.ts` and `models/rendering.ts`.

- [ ] **Step 5: Format, lint**

```bash
cd backend
npx oxfmt models/rendering.ts models/rendering.test.ts models/pages.ts
npx oxlint models/rendering.ts models/rendering.test.ts models/pages.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/models/rendering.ts backend/models/rendering.test.ts backend/models/pages.ts
git commit -m "feat: extract internal-link targets into pages.links at save time (OpenProject #881)"
```

---

## Task 3: `GET /_api/sites/:siteId/graph` endpoint (OpenProject #882)

**Files:**
- Create: `backend/api/graph.ts` — `GraphNode`/`GraphEdge`/`Graph` types, `folderOf()`, a stubbed `assembleGraph()` (real body lands in Task 5), the route
- Modify: `backend/models/pages.ts` — new `GraphPageRow` interface and `listAllForGraph(siteId)` method, placed near `listAllForSite` (line 478) and `listPagesForSitemap` (line 1206), following their exact `WIKI.db.select({...}).from(pagesTable).where(eq(pagesTable.siteId, siteId))` shape
- Modify: `backend/api/index.ts` — register the route (alphabetical: between `diagrams.ts` and `groups.ts`)

**Interfaces:**
- Produces: `GraphPageRow` (consumed by Task 5's `assembleGraph`), `GraphNode`/`GraphEdge`/`Graph` types (consumed by Task 4's schema and Task 11's frontend fetch), the live route (returns `{ nodes: [], edges: [] }` until Task 5 fills in `assembleGraph`).
- Consumes: `mayOnPage` (`api/pages.ts`), `guardSiteEnabled` (`helpers/common.ts`).

- [ ] **Step 1: Add `GraphPageRow` and `listAllForGraph()` to `backend/models/pages.ts`**

Add the interface near `Page`/`PageInput` (after `PageInput`, ~line 177):

```ts
/** One page's worth of raw data for the knowledge graph endpoint (OpenProject #872). */
export interface GraphPageRow {
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  relations: { pos: 'left' | 'center' | 'right'; label: string; caption: string; icon: string; target: string }[]
  links: string[]
}
```

Add the method near `listAllForSite`/`listPagesForSitemap` (after `listAllForSite`, ~line 490):

```ts
  /**
   * Every page on this site, with what the knowledge graph (OpenProject #872) needs to build
   * nodes and edges from — no content, no render, just enough for `api/graph.ts#assembleGraph`
   * to build and permission-filter the graph once.
   */
  async listAllForGraph(siteId: string): Promise<GraphPageRow[]> {
    return WIKI.db
      .select({
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        icon: pagesTable.icon,
        tags: pagesTable.tags,
        relations: pagesTable.relations,
        links: pagesTable.links
      })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, siteId)) as Promise<GraphPageRow[]>
  }
```

(The `as Promise<GraphPageRow[]>` cast matches how `relations`/`links` come back from Drizzle's `jsonb()` columns as loosely-typed `unknown`/`any` — the same looseness `relations: any[]` already has on the `Page` interface.)

- [ ] **Step 2: Create `backend/api/graph.ts`**

```ts
import type { FastifyInstance } from 'fastify'
import type { GraphPageRow } from '../models/pages.ts'
import { mayOnPage } from './pages.ts'
import { guardSiteEnabled } from '../helpers/common.ts'

/** One node in the knowledge graph (OpenProject #872) — a page the requester may read. */
export interface GraphNode {
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  /** The path's first segment — the grouping dimension 874's folder view clusters by. */
  folder: string
}

/** One edge — an authored relation or an extracted internal link, always between two visible nodes. */
export interface GraphEdge {
  source: string
  target: string
  type: 'relation' | 'link'
  label?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** A page's first path segment — `docs/child` -> `docs`, the home page (path `''`) -> `''`. */
export function folderOf(path: string): string {
  return path.split('/')[0] ?? ''
}

/**
 * Build the graph from a site's raw page rows, keeping only what `canRead` allows.
 *
 * A plain function taking a predicate rather than a request, so OpenProject #884 can exercise the
 * node/edge assembly + permission-filter logic against a fixture page list with no `WIKI` global
 * and no database (CLAUDE.md's "Testing (backend)" pure-unit convention). This stub is enough to
 * wire the route end to end first — Task 5 (#884) fills in the real body.
 */
export function assembleGraph(
  _rows: GraphPageRow[],
  _canRead: (row: GraphPageRow) => boolean
): Graph {
  return { nodes: [], edges: [] }
}

const siteIdParam = {
  type: 'object',
  properties: { siteId: { type: 'string', format: 'uuid' } },
  required: ['siteId']
}

/**
 * Knowledge Graph API Routes (OpenProject #848 / #872)
 *
 * No route-level `permissions`: `read:pages` is a page-rule permission, checked per page inside
 * `assembleGraph`'s `canRead` predicate below, not the group-wide list `config.permissions` reads.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET GRAPH
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/graph',
    { schema: { params: siteIdParam } },
    async (req, reply) => {
      if (guardSiteEnabled(WIKI.sites[req.params.siteId], reply)) {
        return
      }
      const rows = await WIKI.models.pages.listAllForGraph(req.params.siteId)
      return assembleGraph(rows, (row) => mayOnPage(req, 'read:pages', req.params.siteId, row))
    }
  )
}

export default routes
```

(Schema/tags/response `$ref`/Swagger description land in Task 4 — this task only needs `params` for request validation, and stays undocumented in Swagger UI since `hideUntagged` is on and there are no `tags` yet.)

- [ ] **Step 3: Register the route in `backend/api/index.ts`**

In the routes-registration block, insert alphabetically between `diagrams.ts` and `groups.ts`:

```ts
  app.register(import('./diagrams.ts'), { prefix: '/diagrams' })
  app.register(import('./graph.ts'))
  app.register(import('./groups.ts'), { prefix: '/groups' })
```

- [ ] **Step 4: Typecheck**

```bash
cd backend
npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Format, lint**

```bash
cd backend
npx oxfmt api/graph.ts api/index.ts models/pages.ts
npx oxlint api/graph.ts api/index.ts models/pages.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/api/graph.ts backend/api/index.ts backend/models/pages.ts
git commit -m "feat: wire GET /sites/:siteId/graph endpoint (assembly stubbed) (OpenProject #882)"
```

---

## Task 4: Route schema + Swagger docs (OpenProject #883)

**Files:**
- Create: `backend/api/schemas/graph.ts` — `GraphNode`/`GraphEdge`/`Graph` JSON Schemas
- Modify: `backend/api/index.ts` — register the schema module (alphabetical: between `flags.ts` and `group.ts`)
- Modify: `backend/api/graph.ts` — full route `schema` (summary, description, tags, response `$ref`)

**Interfaces:**
- Produces: the `Graph#`/`GraphNode#`/`GraphEdge#` shared schemas, referenced by the route's `response.200`.
- Consumes: nothing new.

- [ ] **Step 1: Create `backend/api/schemas/graph.ts`**

```ts
import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GRAPHNODE — one page the caller may read, as a knowledge-graph node (OpenProject #872).
   */
  app.addSchema({
    $id: 'GraphNode',
    type: 'object',
    properties: {
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      icon: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
      folder: {
        type: 'string',
        description: "The path's first segment, e.g. `docs` for `docs/child` — the grouping dimension 874's folder view clusters by."
      }
    }
  })

  /**
   * GRAPHEDGE — an authored relation or an extracted internal link between two visible nodes.
   */
  app.addSchema({
    $id: 'GraphEdge',
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Source node path.' },
      target: { type: 'string', description: 'Target node path.' },
      type: {
        type: 'string',
        enum: ['relation', 'link'],
        description: '`relation` comes from pages.relations (authored); `link` from extracted internal links.'
      },
      label: { type: 'string', description: 'Carried through from the relation. Absent for a `link` edge.' }
    }
  })

  /**
   * GRAPH — the whole permitted graph for one site, across all locales, in one response.
   */
  app.addSchema({
    $id: 'Graph',
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { $ref: 'GraphNode#' } },
      edges: { type: 'array', items: { $ref: 'GraphEdge#' } }
    }
  })
}
```

- [ ] **Step 2: Register the schema module in `backend/api/index.ts`**

Insert alphabetically between `flags.ts` and `group.ts`:

```ts
  await import('./schemas/flags.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/graph.ts').then((m) => m.registerSchemas(app))
  await import('./schemas/group.ts').then((m) => m.registerSchemas(app))
```

- [ ] **Step 3: Fill in the route's `schema` in `backend/api/graph.ts`**

Replace the Task 3 stub schema:

```ts
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/graph',
    {
      schema: {
        summary: "The site's knowledge graph",
        description:
          "Every page the caller may read on this site, across all locales, as nodes -- plus the relation and internal-link edges between pages that are both visible. Fetched once; every drill-down filter and re-cluster after that (OpenProject #874/#875) runs client-side against this response, per #848's design.",
        tags: ['Pages'],
        params: siteIdParam,
        response: {
          200: { $ref: 'Graph#' }
        }
      }
    },
    async (req, reply) => {
```

- [ ] **Step 4: Typecheck, then manually verify Swagger**

```bash
cd backend
npm run typecheck
npm run dev
```

With the dev server running, open `http://localhost:3000/_api` and confirm `GET /sites/{siteId}/graph` is listed under the **Pages** tag with the `Graph` response schema expanded correctly (`nodes`/`edges` arrays of `GraphNode`/`GraphEdge`). Stop the dev server once confirmed.

- [ ] **Step 5: Format, lint**

```bash
cd backend
npx oxfmt api/schemas/graph.ts api/index.ts api/graph.ts
npx oxlint api/schemas/graph.ts api/index.ts api/graph.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/api/schemas/graph.ts backend/api/index.ts backend/api/graph.ts
git commit -m "docs: add graph endpoint schema and Swagger docs (OpenProject #883)"
```

---

## Task 5: Node/edge assembly + permission-filter unit test (OpenProject #884)

**Files:**
- Modify: `backend/api/graph.ts` — replace the Task 3 `assembleGraph()` stub with the real implementation
- Create: `backend/api/graph.test.ts` — pure-unit fixture tests, no `WIKI` global, no database

**Interfaces:**
- Consumes: `assembleGraph`, `folderOf`, `GraphPageRow`, `GraphNode`, `GraphEdge` from `backend/api/graph.ts` (Task 3).
- Produces: nothing new consumed elsewhere — this is the last task in Feature #872.

- [ ] **Step 1: Add failing tests**

Create `backend/api/graph.test.ts`:

```ts
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleGraph, folderOf, type GraphPageRow } from './graph.ts'

function makeRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  return {
    path: 'docs/intro',
    locale: 'en',
    title: 'Intro',
    icon: null,
    tags: [],
    relations: [],
    links: [],
    ...overrides
  }
}

describe('folderOf', () => {
  test('takes the first path segment', () => {
    assert.equal(folderOf('docs/child/page'), 'docs')
  })

  test('is the whole path for a root-level page', () => {
    assert.equal(folderOf('about'), 'about')
  })

  test('is empty for the home page (path "")', () => {
    assert.equal(folderOf(''), '')
  })
})

describe('assembleGraph', () => {
  test('includes only nodes canRead allows', () => {
    const rows = [makeRow({ path: 'a' }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path === 'a')

    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['a']
    )
  })

  test('derives folder on each node', () => {
    const rows = [makeRow({ path: 'docs/child/page' })]

    const result = assembleGraph(rows, () => true)

    assert.equal(result.nodes[0]!.folder, 'docs')
  })

  test('builds a relation edge between two visible pages, carrying its label', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: 'See also', caption: '', icon: '', target: 'b' }]
      }),
      makeRow({ path: 'b' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [{ source: 'a', target: 'b', type: 'relation', label: 'See also' }])
  })

  test('builds a link edge between two visible pages, unlabeled', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [{ source: 'a', target: 'b', type: 'link' }])
  })

  test('drops a relation edge whose target is not readable', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: '', caption: '', icon: '', target: 'secret' }]
      }),
      makeRow({ path: 'secret' })
    ]

    const result = assembleGraph(rows, (row) => row.path !== 'secret')

    assert.deepEqual(result.edges, [])
  })

  test('drops a link edge whose source page is not readable', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path !== 'a')

    assert.deepEqual(result.edges, [])
    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['b']
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend
node --test api/graph.test.ts
```

Expected: FAIL on every `assembleGraph` test — the Task 3 stub always returns `{ nodes: [], edges: [] }` regardless of input, so every assertion expecting a populated result fails. The `folderOf` tests already pass (that function was fully implemented in Task 3).

- [ ] **Step 3: Implement `assembleGraph()`**

In `backend/api/graph.ts`, replace the stub:

```ts
export function assembleGraph(
  rows: GraphPageRow[],
  canRead: (row: GraphPageRow) => boolean
): Graph {
  const visible = rows.filter(canRead)
  const visiblePaths = new Set(visible.map((row) => row.path))

  const nodes: GraphNode[] = visible.map((row) => ({
    path: row.path,
    locale: row.locale,
    title: row.title,
    icon: row.icon,
    tags: row.tags,
    folder: folderOf(row.path)
  }))

  const edges: GraphEdge[] = []
  for (const row of visible) {
    for (const relation of row.relations) {
      if (visiblePaths.has(relation.target)) {
        edges.push({ source: row.path, target: relation.target, type: 'relation', label: relation.label })
      }
    }
    for (const target of row.links) {
      if (visiblePaths.has(target)) {
        edges.push({ source: row.path, target, type: 'link' })
      }
    }
  }

  return { nodes, edges }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend
node --test api/graph.test.ts
npm run typecheck
```

Expected: PASS, every test.

- [ ] **Step 5: Format, lint**

```bash
cd backend
npx oxfmt api/graph.ts api/graph.test.ts
npx oxlint api/graph.ts api/graph.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add backend/api/graph.ts backend/api/graph.test.ts
git commit -m "feat: implement graph node/edge assembly + permission filter (OpenProject #884)"
```

**Feature #872 status:** once Tasks 1–5 are all checked off and committed, Feature #872 ("Backend: graph data endpoint") is ready to move to review — the endpoint is live, documented in Swagger, and its core assembly logic has dedicated pure-unit coverage.

---

# Feature #876 — Placement & entry point

*Independent of #872 — these four tasks may be worked in parallel with Tasks 1–5 above, or any time before Feature #873 needs a route to land on (873 does not depend on 876, but a working `/_graph` route is a natural thing to have in place before wiring a real component into it).*

## Task 6: Add `/_graph` route (OpenProject #903)

**Files:**
- Modify: `frontend/src/router/routes.js:111-114` (insert the new route immediately after `/_error/:action?` and before the `// CREATE` comment block at line 116)

**Interfaces:**
- Produces: the `/_graph` route, rendered inside `MainLayout` with a `Graph.vue` child — matching the `/_create`/`/_edit` pattern (lines 119-123, 127-137), which also wrap `MainLayout` with a single-child `children` array rather than mounting the page component directly.
- Consumes: `frontend/src/pages/Graph.vue` (does not exist yet — created in Task 11). This task's route resolves to a 404-shaped blank import until then; that is expected and does not block committing this task on its own, since 876 has no dependency on 873.

- [ ] **Step 1: Add the route**

In `frontend/src/router/routes.js`, insert after the `/_error/:action?` route (line 114) and before the `// CREATE` section comment (line 116):

```js
  {
    path: '/_error/:action?',
    component: () => import('@/pages/ErrorGeneric.vue')
  },
  {
    path: '/_graph',
    component: () => import('../layouts/MainLayout.vue'),
    children: [{ path: '', component: () => import('../pages/Graph.vue') }]
  },

  // --------------------------------
  // CREATE
  // --------------------------------
```

- [ ] **Step 2: Format, lint**

```bash
cd frontend
npx oxfmt src/router/routes.js
npx oxlint src/router/routes.js
```

Expected: `npx oxlint` will report `Graph.vue` as an unresolved dynamic import target until Task 11 creates the file — if this fails the lint gate as an error (rather than warning), hold this step's commit until Task 11 lands, or create an empty placeholder `frontend/src/pages/Graph.vue` (`<template><div /></template>`) now and let Task 11 fill it in. Prefer the placeholder if `oxlint`/Vite dev server treat a missing dynamic-import target as a hard error.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/router/routes.js
git commit -m "feat: add /_graph route (OpenProject #903)"
```

---

## Task 7: `HeaderNav.vue` icon button (OpenProject #904)

**Files:**
- Modify: `frontend/src/components/HeaderNav.vue:62-71` (insert a new `<w-btn>` immediately after the File Manager button and before the Inbox button)

**Interfaces:**
- Consumes: `siteStore.features.browse` (already imported as `siteStore` in this file's `<script setup>`, line 148) — the exact gating condition `frontend/src/layouts/MainLayout.vue:340`'s `canBrowse` computed reads (`siteStore.features.browse`), per the spec's "gated the same way as the existing Browse button" instruction. `common.header.graph` i18n key (Task 9). `mdi:graph-outline` icon literal (Task 8).

- [ ] **Step 1: Add the button**

In `frontend/src/components/HeaderNav.vue`, insert immediately after the File Manager `<w-btn>` (line 71) and before the Inbox `<w-btn>` (line 72):

```html
          <w-btn
            v-if="siteStore.features.browse"
            class="header-nav-btn"
            flat
            icon="mdi:graph-outline"
            color="teal"
            to="/_graph"
            :aria-label="t(`common.header.graph`)">
            <w-tooltip>{{ t('common.header.graph') }}</w-tooltip>
          </w-btn>
```

- [ ] **Step 2: Format, lint**

```bash
cd frontend
npx oxfmt src/components/HeaderNav.vue
npx oxlint src/components/HeaderNav.vue
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HeaderNav.vue
git commit -m "feat: add knowledge graph entry point to header nav (OpenProject #904)"
```

*(Depends on Task 9's `common.header.graph` locale key existing for the tooltip/aria-label to resolve to real text rather than vue-i18n's raw-key fallback — commit this task after Task 9, or together in one commit if executing serially.)*

---

## Task 8: Icon literal + `npm run icons` (OpenProject #905)

**Files:**
- Modify: `frontend/src/assets/icons.generated.js` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: the `mdi:graph-outline` literal already written into `HeaderNav.vue` by Task 7 — confirmed present in the installed `@iconify-json/mdi` icon set (`node_modules/@iconify-json/mdi/icons.json`'s `icons["graph-outline"]` key) during this plan's own research, so the generator will find real SVG data for it, not silently skip it.

- [ ] **Step 1: Regenerate**

```bash
cd frontend
npm run icons
```

Expected: `src/assets/icons.generated.js` gains a new `"mdi:graph-outline"` entry (alongside the existing `"la:folder-open"`, `"la:plus-circle"`, etc.), sorted the way the rest of the generated file already is.

- [ ] **Step 2: Verify no drift**

```bash
cd frontend
npm run icons:check
```

Expected: passes (the file just written matches what the checker recomputes).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/assets/icons.generated.js
git commit -m "chore: inline mdi:graph-outline icon (OpenProject #905)"
```

---

## Task 9: i18n label/tooltip string (OpenProject #906)

**Files:**
- Modify: `backend/locales/en.json:1603-1604` (insert `common.header.graph` between the existing `common.header.duplicate` and `common.header.edit` entries, keeping the file's alphabetical ordering within the `common.header.*` group)

**Interfaces:**
- Produces: `common.header.graph`, consumed by Task 7's `HeaderNav.vue` button (`t('common.header.graph')`).

- [ ] **Step 1: Add the string**

In `backend/locales/en.json`, insert alphabetically:

```json
  "common.header.duplicate": "Duplicate",
  "common.header.edit": "Edit",
```

becomes:

```json
  "common.header.duplicate": "Duplicate",
  "common.header.edit": "Edit",
  "common.header.graph": "Knowledge Graph",
  "common.header.history": "History",
```

(Placed correctly the first time — "graph" sorts after "edit" and before "history".)

- [ ] **Step 2: Commit**

```bash
git add backend/locales/en.json
git commit -m "feat: add i18n string for the knowledge graph entry point (OpenProject #906)"
```

**Feature #876 status:** once Tasks 6–9 are all checked off, Feature #876 ("Placement & entry point") is ready to move to review, independent of every other feature in this epic — the route exists, the button is wired and gated, the icon is inlined, and the label is real.

---

# Feature #873 — Frontend: force-directed graph component

*Depends on #872 (Tasks 1–5) for the payload shape `Graph.vue` fetches.*

## Task 10: Add the five `d3-*` dependencies (OpenProject #885)

**Files:**
- Modify: `frontend/package.json` — `dependencies` block

**Interfaces:**
- Produces: `d3-force`, `d3-quadtree`, `d3-zoom`, `d3-drag`, `d3-selection` as installable dependencies, consumed by Tasks 11–15.

- [ ] **Step 1: Add the dependencies**

`frontend/package.json` currently has no `d3` dependency at all (confirmed by grep during this plan's research) — the dead `frontend/src/pages/AdminPagesVisualize.vue` is not a starting point (per the spec) and is left untouched. Insert into the `dependencies` block, alphabetically among the existing entries, pinned to the exact latest-stable versions (per CLAUDE.md's Currency convention — verify these are still current at implementation time, e.g. via `npm view d3-force version`, since time may have passed since this plan was written):

```json
    "d3-drag": "3.0.0",
    "d3-force": "3.0.0",
    "d3-quadtree": "3.0.1",
    "d3-selection": "3.0.0",
    "d3-zoom": "3.0.0",
```

- [ ] **Step 2: Install**

```bash
cd frontend
npm install
```

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "chore: add d3-force/quadtree/zoom/drag/selection dependencies (OpenProject #885)"
```

---

## Task 11: `Graph.vue` — full-viewport canvas + fetch (OpenProject #886)

**Files:**
- Create: `frontend/src/pages/Graph.vue` (or fill in the Task 6 placeholder if one was created)

**Interfaces:**
- Produces: the `Graph.vue` component, the `canvasRef`, `nodes`/`edges` reactive state, and a `loadGraph()` function. Consumed by Task 12 (simulation reads `nodes`/`edges`), Task 16 (component tests mount this file).
- Consumes: `GET sites/{siteId}/graph` (Task 3's endpoint) via `API_CLIENT`; `useSiteStore` for `siteStore.id`.

- [ ] **Step 1: Create the component**

```vue
<template>
  <div ref="containerRef" class="graph-view">
    <canvas ref="canvasRef" class="graph-view-canvas" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useSiteStore } from '@/stores/site'

/**
 * The knowledge graph view (OpenProject #848/#873): a full-viewport, canvas-rendered force graph
 * of every page the caller may read on this site. Fetched once on mount -- every filter and
 * re-cluster after that (#874/#875) runs against `nodes`/`edges` already in memory, no further
 * network round trip.
 */

const siteStore = useSiteStore()

const containerRef = ref(null)
const canvasRef = ref(null)

/** Raw payload from `GET sites/{siteId}/graph` -- see `backend/api/graph.ts#Graph`. */
const nodes = ref([])
const edges = ref([])
const isLoading = ref(true)
const loadError = ref(null)

async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    nodes.value = graph.nodes ?? []
    edges.value = graph.edges ?? []
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  loadGraph()
})
</script>

<style lang="scss" scoped>
.graph-view {
  position: relative;
  width: 100%;
  // -> Fills whatever height MainLayout's <w-page-container> gives it; the canvas itself is
  //    sized to match via a ResizeObserver wired up in Task 12/13, not a fixed value here.
  height: 100%;
  min-height: 480px;
}

.graph-view-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
```

- [ ] **Step 2: Manual smoke check**

```bash
cd frontend
npm run dev
```

Navigate to `/_graph` on a running instance (backend on :3000 per CLAUDE.md's dev workflow). Confirm: the route resolves, a blank canvas fills the page, and the Network tab shows a `GET /_api/sites/<id>/graph` request completing with a `{ nodes, edges }` body. Nothing draws yet — that is Task 13.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add Graph.vue canvas page with graph fetch (OpenProject #886)"
```

---

## Task 12: `d3-force` simulation + tick redraw loop (OpenProject #887)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a running `d3.forceSimulation`, a `redraw()` function called on every tick (body filled in by Task 13), a `ResizeObserver` keeping the canvas's pixel size matched to its container. Consumed by Task 13 (draws into the canvas this task sizes and clears), Task 14 (`d3.zoom` attaches to the same canvas element and needs the simulation's `alphaTarget` on drag-start/end), Task 19 (874 layers a `forceX`/`forceY` into this same simulation object).
- Consumes: `nodes`/`edges` from Task 11.

- [ ] **Step 1: Wire up the simulation**

Add to `Graph.vue`'s `<script setup>`:

```js
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'

let simulation = null
let ctx = null
let resizeObserver = null

function sizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) {
    return
  }
  const { width, height } = container.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  simulation?.force('center', forceCenter(width / 2, height / 2))
}

function redraw() {
  // -> Filled in by Task 13 (#888): edges -> cluster hulls -> node dots -> labels.
}

function startSimulation() {
  const { width, height } = containerRef.value.getBoundingClientRect()

  simulation = forceSimulation(nodes.value)
    .force(
      'link',
      forceLink(edges.value)
        .id((d) => d.path)
        .distance(60)
    )
    .force('charge', forceManyBody().strength(-120))
    .force('collide', forceCollide(14))
    .force('center', forceCenter(width / 2, height / 2))
    .on('tick', redraw)
}

async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    nodes.value = graph.nodes ?? []
    edges.value = graph.edges ?? []
    sizeCanvas()
    startSimulation()
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    sizeCanvas()
    redraw()
  })
  resizeObserver.observe(containerRef.value)
  loadGraph()
})

onBeforeUnmount(() => {
  simulation?.stop()
  resizeObserver?.disconnect()
})
```

`d3.forceLink`'s distance (`60`) and `d3.forceManyBody`'s charge strength (`-120`) are starting points, not verified-correct constants — this is exploratory visual tuning per this plan's own instructions; adjust them in the browser against a real graph once Task 13 makes something visible, rather than trusting these numbers as final. `forceCollide(14)` is sized off a plausible node-dot radius, same caveat.

- [ ] **Step 2: Manual smoke check**

```bash
cd frontend
npm run dev
```

Navigate to `/_graph`. Add a temporary `console.log(nodes.value[0]?.x, nodes.value[0]?.y)` inside `redraw()` and confirm the logged coordinates change across ticks (proof the simulation is actually running) before removing the log.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: wire d3-force simulation and tick redraw loop (OpenProject #887)"
```

---

## Task 13: Canvas draw function (OpenProject #888)

**Files:**
- Modify: `frontend/src/pages/Graph.vue` — fill in `redraw()`

**Interfaces:**
- Produces: a real `redraw()` implementation: clears the canvas, draws edges, then cluster-sector hulls (accepts a `clusters` argument that Task 20 supplies — an empty array until then, so this task draws no hulls yet but the call shape is ready), then node dots, then labels once zoomed in enough to read them.
- Consumes: `nodes.value`/`edges.value` (positions mutated in place by the simulation each tick), `zoomTransform` (module-level ref, `null` until Task 14 attaches `d3.zoom` — guarded so this task's draw works standalone first).

- [ ] **Step 1: Implement `redraw()`**

```js
const zoomTransform = ref(null)
/** Populated by Task 20 (#895); an empty array here draws no hulls, which is correct pre-874. */
const clusters = ref([])

function drawEdges() {
  ctx.strokeStyle = 'rgba(128, 128, 128, 0.35)'
  ctx.lineWidth = 1
  for (const edge of edges.value) {
    const source = edge.source
    const target = edge.target
    if (!source?.x || !target?.x) {
      continue
    }
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
  }
}

function drawClusterHulls() {
  for (const cluster of clusters.value) {
    if (!cluster.hullPoints?.length) {
      continue
    }
    ctx.beginPath()
    ctx.moveTo(cluster.hullPoints[0][0], cluster.hullPoints[0][1])
    for (const point of cluster.hullPoints.slice(1)) {
      ctx.lineTo(point[0], point[1])
    }
    ctx.closePath()
    ctx.fillStyle = cluster.color
    ctx.globalAlpha = 0.12
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

function drawNodes() {
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    ctx.beginPath()
    ctx.arc(node.x, node.y, 5, 0, Math.PI * 2)
    ctx.fillStyle = node.color ?? '#888'
    ctx.fill()
  }
}

function drawLabels() {
  const scale = zoomTransform.value?.k ?? 1
  // -> Below this zoom level a label is unreadably small anyway; skipping the fillText calls
  //    entirely is also what keeps a dense graph's label layer from becoming visual noise.
  if (scale < 1.5) {
    return
  }
  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#333'
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    ctx.fillText(node.title ?? node.path, node.x + 8, node.y + 3)
  }
}

function redraw() {
  if (!ctx) {
    return
  }
  const canvas = canvasRef.value
  const dpr = window.devicePixelRatio || 1
  ctx.save()
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
  if (zoomTransform.value) {
    ctx.translate(zoomTransform.value.x, zoomTransform.value.y)
    ctx.scale(zoomTransform.value.k, zoomTransform.value.k)
  }
  drawEdges()
  drawClusterHulls()
  drawNodes()
  drawLabels()
  ctx.restore()
}
```

Node radius (`5`), edge stroke color/opacity, and the `scale < 1.5` label threshold are starting points for visual tuning, not verified-correct constants — adjust them against a real graph in the browser.

- [ ] **Step 2: Manual smoke check**

```bash
cd frontend
npm run dev
```

Navigate to `/_graph` on a site with a handful of pages. Acceptance criteria: node dots are visible and visibly settle into a stable layout as the simulation cools (no longer jittering after a few seconds); edges are drawn as thin lines between related dots; nothing throws in the console.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: implement canvas draw function for nodes/edges/hulls/labels (OpenProject #888)"
```

---

## Task 14: `d3-zoom` pan/zoom (OpenProject #889)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: pan/zoom on the canvas, writing into `zoomTransform` (already read by Task 13's `redraw()`).
- Consumes: `d3.select`/`d3.zoom` (`d3-selection`/`d3-zoom`), `canvasRef`.

- [ ] **Step 1: Attach `d3.zoom`**

```js
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom'

function attachZoom() {
  const selection = select(canvasRef.value)
  const behavior = d3zoom()
    .scaleExtent([0.1, 8])
    .on('zoom', (event) => {
      zoomTransform.value = event.transform
      redraw()
    })
  selection.call(behavior)
  zoomTransform.value = zoomIdentity
}
```

Call `attachZoom()` from `loadGraph()`'s success path, after `startSimulation()`. `scaleExtent([0.1, 8])` is a starting point (wide enough to read a single node's label at max zoom and see the whole graph at min zoom on a typical viewport) — tune visually once there's real data to zoom around in.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: scroll/pinch zooms in and out smoothly, drag pans, and both redraw the graph without lag or flicker; `drawLabels()`'s zoom-gated labels (Task 13) appear once zoomed in past the threshold.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: wire d3-zoom pan/zoom on the graph canvas (OpenProject #889)"
```

---

## Task 15: `d3-quadtree` hit-testing (OpenProject #890)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: click-to-navigate (router push to the clicked node's page) and a hover tooltip showing the node's title.
- Consumes: `d3.quadtree` (`d3-quadtree`), `nodes.value` (rebuilt each tick), `localizedPagePath` (`@/helpers/pagePaths.js`) + `siteStore.useLocales`/`siteStore.locales` for the same locale-aware path resolution `routes.js`'s `/a/:alias` route already uses.

- [ ] **Step 1: Build the quadtree each tick and wire click/hover**

```js
import { quadtree as d3quadtree } from 'd3-quadtree'
import { useRouter } from 'vue-router'
import { localizedPagePath } from '@/helpers/pagePaths'

const router = useRouter()
let nodeQuadtree = null
const hoveredNode = ref(null)

function redraw() {
  nodeQuadtree = d3quadtree(
    nodes.value,
    (d) => d.x,
    (d) => d.y
  )
  // ...existing redraw body from Task 13 continues here...
}

/** Screen coordinates -> the simulation's own coordinate space, undoing the current zoom transform. */
function toGraphSpace(clientX, clientY) {
  const rect = canvasRef.value.getBoundingClientRect()
  const t = zoomTransform.value ?? zoomIdentity
  return {
    x: (clientX - rect.left - t.x) / t.k,
    y: (clientY - rect.top - t.y) / t.k
  }
}

function findNodeAt(clientX, clientY) {
  if (!nodeQuadtree) {
    return null
  }
  const { x, y } = toGraphSpace(clientX, clientY)
  return nodeQuadtree.find(x, y, 12)
}

function onCanvasClick(event) {
  const node = findNodeAt(event.clientX, event.clientY)
  if (!node) {
    return
  }
  router.push(
    localizedPagePath(node.path, node.locale, {
      useLocales: siteStore.useLocales,
      primary: siteStore.locales.primary,
      forcePrefix: siteStore.locales.forcePrefix
    })
  )
}

function onCanvasMouseMove(event) {
  hoveredNode.value = findNodeAt(event.clientX, event.clientY)
}
```

Bind `@click="onCanvasClick"` and `@mousemove="onCanvasMouseMove"` on the `<canvas>` in the template, and render a small tooltip near the cursor bound to `hoveredNode.value.title` when set (a plain positioned `<div>` is enough — this is not a `<w-tooltip>` case, since there is no DOM element under the cursor to anchor one to). The `12`px hit radius passed to `quadtree.find()` is a starting point matched to Task 13's `5`px node-dot radius plus some slack for an imprecise click — tune visually.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: hovering a node dot shows its title in a tooltip that follows the cursor; clicking a node navigates to that page; clicking empty canvas space does nothing.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add d3-quadtree hit-testing for click-to-navigate and hover (OpenProject #890)"
```

---

## Task 16: Component test(s) (OpenProject #891)

**Files:**
- Create: `frontend/src/pages/Graph.test.js`

**Interfaces:**
- Consumes: `Graph.vue` (Tasks 11–15), `API_CLIENT`/`EVENT_BUS` globals rebuilt per-test by `frontend/test/setup.js`, the `createPinia()`/`setActivePinia()` + mocked `API_CLIENT.get` pattern `NavBrowseMenu.test.js` already establishes for a component that fetches on mount.

- [ ] **Step 1: Write the smoke test**

```js
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import Graph from './Graph.vue'
import { useSiteStore } from '@/stores/site'

const FIXTURE_GRAPH = {
  nodes: [
    { path: 'a', locale: 'en', title: 'A', icon: null, tags: [], folder: '' },
    { path: 'b', locale: 'en', title: 'B', icon: null, tags: [], folder: '' }
  ],
  edges: [{ source: 'a', target: 'b', type: 'link' }]
}

async function mountGraph() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_GRAPH) })

  const wrapper = mount(Graph, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/*
 * Asserting actual pixel output is out of practical reach for a unit test -- a real
 * testing-strategy limitation, not an oversight (per the design spec's own admission). This suite
 * checks the simulation initializes and the canvas element exists, without throwing.
 */
describe('Graph.vue (OpenProject #891)', () => {
  it('mounts, fetches the graph, and renders a canvas with no console errors', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/graph')
  })

  it('recovers from a fetch failure without throwing', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const wrapper = mount(Graph, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests**

```bash
cd frontend
npx vitest run src/pages/Graph.test.js
```

Expected: PASS. If `canvas.getContext('2d')` is unavailable under happy-dom (frontend's Vitest environment, per `vitest.config.js` — unlike `blocks/`'s jsdom, canvas 2D context support is not guaranteed), guard `sizeCanvas()`/`redraw()` with an `if (!ctx) return` (already present from Task 13) so a null context under test is a no-op rather than a throw — this is exactly the situation that guard exists for.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.test.js
npx oxlint src/pages/Graph.test.js
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.test.js
git commit -m "test: add Graph.vue mount/fetch smoke tests (OpenProject #891)"
```

**Feature #873 status:** once Tasks 10–16 are all checked off, Feature #873 ("Frontend: force-directed graph component") is ready to move to review — pan/zoom/click/hover all work manually and the smoke test suite is green.

---

# Feature #874 — Frontend: clustering & color coding

*Depends on #873 (Tasks 10–16) for the simulation/draw loop this layers onto.*

## Task 17: Grouping-dimension selector (OpenProject #892)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: `groupBy` (`ref('folder')`, one of `'folder' | 'tag'` — `'site'` is explicitly dropped, per the spec's architecture note: a single loaded graph only ever has one site value, so grouping by it is meaningless). Consumed by Task 18 (color assignment groups nodes by this), Task 19 (centroid force targets per-group), Task 20 (hulls are computed per group).
- Consumes: nothing new.

- [ ] **Step 1: Add the selector**

```js
/** 'site' is deliberately not an option here -- see the spec's architecture note: a single loaded
 *  graph has exactly one site value, so grouping by it would be a no-op UI control. */
const groupBy = ref('folder')

function groupKeyFor(node) {
  if (groupBy.value === 'tag') {
    return node.tags?.[0] ?? '(untagged)'
  }
  return node.folder || '(root)'
}
```

Add a small control to the template (a `w-btn-toggle` or two `w-btn`s bound to `groupBy`, styled as an overlay panel corner control rather than inline in the header — the exact placement/markup is a UI-polish detail to settle visually against Task 20's legend, which shares the same panel):

```html
<div class="graph-view-controls">
  <w-btn-toggle v-model="groupBy" :options="[{ label: 'Folder', value: 'folder' }, { label: 'Tag', value: 'tag' }]" dense />
</div>
```

`groupKeyFor` taking only a node's *first* tag when `groupBy === 'tag'` is a deliberate simplification worth flagging: a page can carry several tags, and "which one wins for clustering" has no single right answer from the spec. First-tag-wins is the simplest rule that produces exactly one group per node (required for a single hull per node) — revisit if product feedback wants something richer (e.g. a node appearing in multiple tag-hulls at once, which is a materially bigger change to Task 20's hull computation).

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Toggling the control changes `groupBy.value` (verify via Vue devtools or a temporary log) — no visible clustering effect yet, since Tasks 18–20 haven't landed.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add folder/tag grouping-dimension selector (OpenProject #892)"
```

---

## Task 18: Categorical color assignment (OpenProject #893)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: `colorForGroup(key)`, and a `node.color` written onto each node before every draw. Consumed by Task 13's `drawNodes()` (already reads `node.color`), Task 20's hulls (`cluster.color`), Task 22's legend.
- Consumes: `groupBy`/`groupKeyFor` (Task 17).

- [ ] **Step 1: Load the `dataviz` skill and follow its palette guidance**

Before writing the palette, invoke the `dataviz` skill (per this plan's own instructions: "chosen per the `dataviz` skill's palette guidance at implementation time rather than picked in this spec") and follow its categorical-color method and validator rather than hand-picking hex values here. Implement a `colorForGroup(key)` function that assigns a stable color per distinct group key (same key always gets the same color across redraws and across a filter changing which nodes are visible), backed by the skill's documented palette.

```js
const groupColors = new Map()

function colorForGroup(key) {
  if (!groupColors.has(key)) {
    // -> Palette source: `dataviz` skill's categorical guidance (references/palette.md) --
    //    assign the next unused swatch in the skill's documented order, not an ad hoc hue.
    groupColors.set(key, nextPaletteColor(groupColors.size))
  }
  return groupColors.get(key)
}
```

(`nextPaletteColor` is the skill-provided lookup — its exact shape depends on what the `dataviz` skill hands back at implementation time; do not fabricate palette hex values in this plan.)

Wire it into `redraw()` (or a `recomputeClusters()` step Task 21 formalizes) so every node gets `node.color = colorForGroup(groupKeyFor(node))` before `drawNodes()` runs.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: nodes render in visually distinct colors, one color per folder (or tag, once toggled); the same folder's nodes keep the same color across a page reload (stable assignment, not per-render-random).

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: assign categorical colors per group (OpenProject #893)"
```

---

## Task 19: Per-group centroid force (OpenProject #894)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a low-strength `forceX`/`forceY` layered into the Task 12 simulation, pulling each node toward its group's running centroid.
- Consumes: `groupBy`/`groupKeyFor` (Task 17), the `simulation` instance (Task 12).

- [ ] **Step 1: Add the centroid force**

```js
import { forceX, forceY } from 'd3-force'

function groupCentroids() {
  const sums = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    const key = groupKeyFor(node)
    const entry = sums.get(key) ?? { x: 0, y: 0, count: 0 }
    entry.x += node.x
    entry.y += node.y
    entry.count += 1
    sums.set(key, entry)
  }
  const centroids = new Map()
  for (const [key, { x, y, count }] of sums) {
    centroids.set(key, { x: x / count, y: y / count })
  }
  return centroids
}

let centroids = new Map()

function applyClusteringForce() {
  centroids = groupCentroids()
  simulation
    .force(
      'clusterX',
      forceX((d) => centroids.get(groupKeyFor(d))?.x ?? 0).strength(0.05)
    )
    .force(
      'clusterY',
      forceY((d) => centroids.get(groupKeyFor(d))?.y ?? 0).strength(0.05)
    )
}
```

Call `applyClusteringForce()` once after `startSimulation()` in `loadGraph()`, and again whenever `groupBy` changes (a `watch(groupBy, ...)` that also calls `simulation.alpha(0.3).restart()` to let the layout resettle around the new grouping). The `0.05` strength is a starting point — low enough that `forceLink`/`forceManyBody`/`forceCollide` still dominate local layout (per the spec: "link/charge/collision forces alone won't produce visually coherent clusters — nodes need an additional pull toward their group", i.e. this force is meant to be a *bias*, not the dominant force) — tune visually against a real graph.

Centroids computed from the *previous* tick's positions (a "running" centroid, per the spec) rather than recomputed from scratch before every force application, since a per-tick recompute of every group's centroid is what "running" describes and matches how `d3-force`'s own forces read `x`/`y` off nodes mutated in place by the previous tick.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: nodes from the same folder visibly drift toward each other over a few seconds of simulation, forming loose spatial clusters, without the whole graph collapsing into one dense blob (the `0.05` strength should keep `forceCollide`'s spacing intact within a cluster).

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add per-group centroid force to the simulation (OpenProject #894)"
```

---

## Task 20: Convex-hull sector computation (OpenProject #895)

**Files:**
- Modify: `frontend/package.json` — add `d3-polygon` (a dependency the spec's Task list for #873 did not enumerate; `d3.polygonHull` lives in this separate package, not `d3-force`. Flagged explicitly — see this plan's closing summary)
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: `clusters.value` (already read by Task 13's `drawClusterHulls()`) — one entry per visible group with `{ key, color, hullPoints }` for a group with ≥3 nodes, or `{ key, color, circle: { x, y, r } }` for a 1–2-node group (no hull possible).
- Consumes: `groupKeyFor`/`colorForGroup` (Tasks 17–18), `nodes.value` positions.

- [ ] **Step 1: Add the `d3-polygon` dependency**

```bash
cd frontend
```

In `package.json`, alphabetically among the other `d3-*` entries added in Task 10:

```json
    "d3-drag": "3.0.0",
    "d3-force": "3.0.0",
    "d3-polygon": "3.0.1",
    "d3-quadtree": "3.0.1",
```

```bash
npm install
```

- [ ] **Step 2: Compute hulls / fallback circles**

```js
import { polygonHull } from 'd3-polygon'

const HULL_PADDING = 16

function padHull(points, padding) {
  // -> Pads outward from the hull's own centroid so the fill visually contains the node dots
  //    rather than passing through their centers, per the spec's "Obsidian-style" requirement.
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length
  return points.map(([x, y]) => {
    const dx = x - cx
    const dy = y - cy
    const len = Math.hypot(dx, dy) || 1
    return [x + (dx / len) * padding, y + (dy / len) * padding]
  })
}

function computeClusters() {
  const byGroup = new Map()
  for (const node of nodes.value) {
    if (node.x === undefined) {
      continue
    }
    const key = groupKeyFor(node)
    const list = byGroup.get(key) ?? []
    list.push(node)
    byGroup.set(key, list)
  }

  const result = []
  for (const [key, groupNodes] of byGroup) {
    const color = colorForGroup(key)
    if (groupNodes.length >= 3) {
      const hull = polygonHull(groupNodes.map((n) => [n.x, n.y]))
      if (hull) {
        result.push({ key, color, hullPoints: padHull(hull, HULL_PADDING) })
        continue
      }
      // -> `polygonHull` returns null for degenerate input (e.g. every point collinear) even with
      //    >=3 nodes; fall through to the circle case below rather than drawing nothing.
    }
    // -> 1-2 nodes (or a degenerate >=3-node group): a small padded circle/ellipse instead of a
    //    hull, centered on the group's own centroid.
    const cx = groupNodes.reduce((s, n) => s + n.x, 0) / groupNodes.length
    const cy = groupNodes.reduce((s, n) => s + n.y, 0) / groupNodes.length
    const maxDist = Math.max(...groupNodes.map((n) => Math.hypot(n.x - cx, n.y - cy)), 0)
    result.push({ key, color, circle: { x: cx, y: cy, r: maxDist + HULL_PADDING } })
  }
  clusters.value = result
}
```

Update Task 13's `drawClusterHulls()` to also draw the circle case:

```js
function drawClusterHulls() {
  for (const cluster of clusters.value) {
    ctx.fillStyle = cluster.color
    ctx.globalAlpha = 0.12
    if (cluster.hullPoints?.length) {
      ctx.beginPath()
      ctx.moveTo(cluster.hullPoints[0][0], cluster.hullPoints[0][1])
      for (const point of cluster.hullPoints.slice(1)) {
        ctx.lineTo(point[0], point[1])
      }
      ctx.closePath()
      ctx.fill()
    } else if (cluster.circle) {
      ctx.beginPath()
      ctx.arc(cluster.circle.x, cluster.circle.y, cluster.circle.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}
```

`HULL_PADDING`'s value (`16`) is a starting point sized against Task 13's `5`px node radius — tune visually so the hull clearly contains the dots without ballooning past neighboring clusters.

- [ ] **Step 3: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: a folder/tag with 3+ visible pages gets a translucent colored hull drawn behind its nodes; a folder/tag with 1–2 pages gets a small colored circle instead; hulls don't flicker every tick (should track the settling layout smoothly, not jump discontinuously) — call `computeClusters()` from the tick handler or throttle it if it visibly lags with a large graph.

- [ ] **Step 4: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/pages/Graph.vue
git commit -m "feat: compute convex-hull cluster sectors with small-group fallback (OpenProject #895)"
```

---

## Task 21: Recompute wiring (OpenProject #896)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a single `recomputeClusters()` entry point that Task 18's coloring, Task 19's centroid force, and Task 20's hull computation all funnel through, called on every tick and whenever `groupBy` or the visible node set changes.
- Consumes: everything from Tasks 17–20; the visible-node-set change signal Task 26 (#901, Feature #875) will fire.

- [ ] **Step 1: Consolidate into one recompute function**

```js
function recomputeClusters() {
  for (const node of nodes.value) {
    node.color = colorForGroup(groupKeyFor(node))
  }
  computeClusters()
}

watch(groupBy, () => {
  applyClusteringForce()
  recomputeClusters()
  simulation?.alpha(0.3).restart()
})
```

Call `recomputeClusters()` once from `redraw()` (or from the simulation's `tick` handler directly, before `drawClusterHulls()` reads `clusters.value`) so hulls/colors stay in step with the live layout rather than only updating on `groupBy` changes. Task 26 (#901) will additionally call `recomputeClusters()` after it mutates which nodes are in `nodes.value` (a filter change) — that hook is a one-line addition once #901 exists; nothing here needs to anticipate its exact shape further than "a function this task already exposes."

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Toggle the Task 17 grouping selector between folder and tag — acceptance criteria: colors and hulls visibly re-derive against the new grouping within a second or two, without a page reload.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: wire cluster recompute on tick and grouping-dimension change (OpenProject #896)"
```

---

## Task 22: Legend (OpenProject #897)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a legend panel listing each visible group's color swatch and label.
- Consumes: `groupColors` (Task 18), `groupKeyFor`/`groupBy` (Task 17), `nodes.value`.

- [ ] **Step 1: Add the legend**

```js
const legendEntries = computed(() => {
  const seen = new Map()
  for (const node of nodes.value) {
    const key = groupKeyFor(node)
    if (!seen.has(key)) {
      seen.set(key, colorForGroup(key))
    }
  }
  return [...seen.entries()].map(([key, color]) => ({ key, color }))
})
```

```html
<div class="graph-view-legend">
  <div v-for="entry in legendEntries" :key="entry.key" class="graph-view-legend-item">
    <span class="graph-view-legend-swatch" :style="{ backgroundColor: entry.color }" />
    <span class="graph-view-legend-label">{{ entry.key }}</span>
  </div>
</div>
```

Placed alongside Task 17's grouping-selector control (`.graph-view-controls`) — both are overlay panels on top of the canvas, positioned with `position: absolute` in `.graph-view`'s scoped styles; exact corner/spacing is a visual-polish detail to settle by eye against the canvas, not a value to fabricate here.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: the legend lists one entry per distinct folder/tag currently in the graph, each swatch matching the color used for that group's nodes and hull; toggling the grouping selector updates the legend's entries and labels together.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add group/color legend to the graph view (OpenProject #897)"
```

**Feature #874 status:** once Tasks 17–22 are all checked off, Feature #874 ("Frontend: clustering & color coding") is ready to move to review — grouping, coloring, the centroid force, hulls, recompute wiring, and the legend all work manually against a real graph.

---

# Feature #875 — Frontend: drill-down filter controls

*Depends on #873 (Tasks 10–16, simulation add/remove) and #874 (Tasks 17–22, recompute hooks).*

## Task 23: Filter panel UI (OpenProject #898)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: `activeFilters` reactive state (`{ tags: string[], folderDepth: number | null, locale: string | null }`) and the panel markup. `'site'` is not a field here — dropped per the spec's architecture note, same reasoning as Task 17's grouping selector. Consumed by Task 25 (#900 computes the visible subset from this state).
- Consumes: `siteStore.locales.showMenu` — the exact gating condition `frontend/src/layouts/MainLayout.vue`/`HeaderNav.vue` already use for their own locale selector, reused here per the spec ("shown only if `siteStore.locales.showMenu`").

- [ ] **Step 1: Add filter state and the panel skeleton**

```js
import { useSiteStore } from '@/stores/site'
// (siteStore already imported in Task 11 -- reused here)

const activeFilters = reactive({
  tags: [],
  folderDepth: null,
  locale: null
})
```

```html
<div class="graph-view-filters">
  <w-select
    v-model="activeFilters.tags"
    multiple
    chips
    :options="tagOptions"
    :label="t('graph.filters.tags')" />
  <w-input v-model.number="activeFilters.folderDepth" type="number" min="0" :label="t('graph.filters.folderDepth')" />
  <w-select
    v-if="siteStore.locales.showMenu"
    v-model="activeFilters.locale"
    :options="localeOptions"
    clearable
    :label="t('graph.filters.locale')" />
</div>
```

(`tagOptions`/`localeOptions` are populated by Task 24; `w-select`'s real prop surface should be checked against `frontend/src/components/shared/WSelect.vue` before finalizing this markup — the component library scopes each `w-*` component to how the app actually uses it, per CLAUDE.md, so confirm `multiple`/`chips`/`clearable` are real supported props there rather than assuming Quasar's original API.)

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`. Acceptance criteria: the filter panel renders; the locale dropdown is present only on a multi-locale site (`siteStore.locales.showMenu` true) and absent otherwise — verify against a single-locale site config if one is available, or by toggling `siteStore.locales.showMenu` in Vue devtools.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add drill-down filter panel UI (OpenProject #898)"
```

---

## Task 24: Derive filter options from the node set (OpenProject #899)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`
- Create: `frontend/src/pages/Graph.test.js` gains new test cases (or a co-located pure-function test if this logic is extracted — see Step 1)

**Interfaces:**
- Produces: `tagOptions`/`localeOptions` computed properties (consumed by Task 23's `w-select`s), and a pure `deriveFilterOptions(nodes)` function extracted for testability.
- Consumes: `nodes.value`.

This is deterministic, easily-testable logic (per this plan's TDD guidance for such tasks) — write it as a plain function and test it directly, the same reasoning Task 5 (#884) used for `assembleGraph`.

- [ ] **Step 1: Add a failing test**

In `frontend/src/pages/Graph.test.js`, add:

```js
import { deriveFilterOptions } from './Graph.vue'
```

Wait — a `<script setup>` SFC cannot export a named function for a test file to import directly. Extract `deriveFilterOptions` into a small sibling module instead: `frontend/src/pages/graphFilters.js`. Add the test there:

```js
import { describe, expect, it } from 'vitest'
import { deriveFilterOptions } from './graphFilters.js'

const NODES = [
  { path: 'a', locale: 'en', tags: ['foo', 'bar'] },
  { path: 'b', locale: 'fr', tags: ['foo'] },
  { path: 'c', locale: 'en', tags: [] }
]

describe('deriveFilterOptions (OpenProject #899)', () => {
  it('collects every distinct tag across all nodes, sorted', () => {
    const { tags } = deriveFilterOptions(NODES)
    expect(tags).toEqual(['bar', 'foo'])
  })

  it('collects every distinct locale across all nodes, sorted', () => {
    const { locales } = deriveFilterOptions(NODES)
    expect(locales).toEqual(['en', 'fr'])
  })

  it('returns empty arrays for an empty node set', () => {
    expect(deriveFilterOptions([])).toEqual({ tags: [], locales: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: FAIL — `frontend/src/pages/graphFilters.js` does not exist yet.

- [ ] **Step 3: Implement `deriveFilterOptions`**

Create `frontend/src/pages/graphFilters.js`:

```js
/**
 * The tag and locale values a viewer can filter the graph by, derived from whichever nodes are
 * currently loaded — no separate endpoint (OpenProject #875's design). Folder depth has no
 * discrete "options" list the way tags/locale do (it's a numeric range), so it isn't part of this
 * function; `Graph.vue`'s folder-depth control just clamps against the graph's max folder depth.
 */
export function deriveFilterOptions(nodes) {
  const tags = new Set()
  const locales = new Set()
  for (const node of nodes) {
    for (const tag of node.tags ?? []) {
      tags.add(tag)
    }
    if (node.locale) {
      locales.add(node.locale)
    }
  }
  return {
    tags: [...tags].sort(),
    locales: [...locales].sort()
  }
}
```

Wire it into `Graph.vue`:

```js
import { deriveFilterOptions } from './graphFilters.js'

const filterOptions = computed(() => deriveFilterOptions(nodes.value))
const tagOptions = computed(() => filterOptions.value.tags)
const localeOptions = computed(() => filterOptions.value.locales)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: PASS.

- [ ] **Step 5: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/graphFilters.js src/pages/graphFilters.test.js src/pages/Graph.vue
npx oxlint src/pages/graphFilters.js src/pages/graphFilters.test.js src/pages/Graph.vue
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/graphFilters.js frontend/src/pages/graphFilters.test.js frontend/src/pages/Graph.vue
git commit -m "feat: derive filter options from the loaded node set (OpenProject #899)"
```

---

## Task 25: Compute visible node/edge subset (OpenProject #900)

**Files:**
- Modify: `frontend/src/pages/graphFilters.js` — add `computeVisibleSubset`
- Modify: `frontend/src/pages/graphFilters.test.js`

**Interfaces:**
- Produces: `computeVisibleSubset(nodes, edges, filters)` → `{ visibleNodes, visibleEdges }` — the AND of all active filters; an edge is visible only if both endpoints are. Consumed by Task 26 (#901).
- Consumes: `activeFilters` shape from Task 23.

- [ ] **Step 1: Add failing tests**

```js
import { computeVisibleSubset } from './graphFilters.js'

const NODES2 = [
  { path: 'a', locale: 'en', tags: ['foo'], folder: 'docs' },
  { path: 'b', locale: 'fr', tags: ['bar'], folder: 'docs/child' },
  { path: 'c', locale: 'en', tags: [], folder: '' }
]
const EDGES2 = [
  { source: 'a', target: 'b', type: 'link' },
  { source: 'a', target: 'c', type: 'link' }
]

describe('computeVisibleSubset (OpenProject #900)', () => {
  it('with no active filters, everything is visible', () => {
    const { visibleNodes, visibleEdges } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: null,
      locale: null
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a', 'b', 'c'])
    expect(visibleEdges).toHaveLength(2)
  })

  it('filters by tag', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: null
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a'])
  })

  it('filters by locale', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: null,
      locale: 'fr'
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['b'])
  })

  it('filters by folder depth (segment count)', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: 1,
      locale: null
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a', 'c'])
  })

  it('drops an edge when either endpoint is filtered out', () => {
    const { visibleEdges } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: null
    })
    expect(visibleEdges).toEqual([])
  })

  it('ANDs multiple active filters', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: 'en'
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: FAIL — `computeVisibleSubset` does not exist yet.

- [ ] **Step 3: Implement `computeVisibleSubset`**

```js
/**
 * The AND of every active filter (OpenProject #875's design) — a node passes only if it passes
 * every non-empty filter, and an edge survives only if both endpoints do. `folderDepth` counts
 * path segments (`docs/child` has depth 2); `null`/`0` on any filter means "no restriction" for
 * that dimension.
 */
export function computeVisibleSubset(nodes, edges, filters) {
  const passesTag = (node) => filters.tags.length === 0 || filters.tags.some((t) => node.tags?.includes(t))
  const passesLocale = (node) => !filters.locale || node.locale === filters.locale
  const passesFolderDepth = (node) =>
    !filters.folderDepth || (node.path?.split('/').length ?? 0) <= filters.folderDepth

  const visibleNodes = nodes.filter((n) => passesTag(n) && passesLocale(n) && passesFolderDepth(n))
  const visiblePaths = new Set(visibleNodes.map((n) => n.path))
  const visibleEdges = edges.filter((e) => visiblePaths.has(e.source) && visiblePaths.has(e.target))

  return { visibleNodes, visibleEdges }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend
npx vitest run src/pages/graphFilters.test.js
```

Expected: PASS.

- [ ] **Step 5: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/graphFilters.js src/pages/graphFilters.test.js
npx oxlint src/pages/graphFilters.js src/pages/graphFilters.test.js
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/graphFilters.js frontend/src/pages/graphFilters.test.js
git commit -m "feat: compute visible node/edge subset as AND of active filters (OpenProject #900)"
```

---

## Task 26: Wire filter changes into simulation + recompute (OpenProject #901)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a `watch(activeFilters, ...)` that recomputes the visible subset (Task 25), removes/re-adds nodes from the live `d3-force` simulation (`simulation.nodes(...)`, `simulation.force('link').links(...)`) rather than merely hiding them in the draw call, and calls Task 21's `recomputeClusters()` afterward.
- Consumes: `computeVisibleSubset` (Task 25), `simulation` (Task 12), `recomputeClusters` (Task 21).

- [ ] **Step 1: Wire the watcher**

```js
import { computeVisibleSubset } from './graphFilters.js'

/** The full, unfiltered graph as fetched -- kept separate from `nodes.value`/`edges.value`, which
 *  after this task are the CURRENTLY VISIBLE subset the simulation actually runs on. */
const allNodes = ref([])
const allEdges = ref([])

// Updated `loadGraph()`: fetch into allNodes/allEdges, then apply the (initially empty) filter.
async function loadGraph() {
  isLoading.value = true
  loadError.value = null
  try {
    const graph = await API_CLIENT.get(`sites/${siteStore.id}/graph`).json()
    allNodes.value = graph.nodes ?? []
    allEdges.value = graph.edges ?? []
    applyFilters()
    sizeCanvas()
    startSimulation()
    applyClusteringForce()
    attachZoom()
  } catch (err) {
    loadError.value = err
  } finally {
    isLoading.value = false
  }
}

function applyFilters() {
  const { visibleNodes, visibleEdges } = computeVisibleSubset(allNodes.value, allEdges.value, activeFilters)
  nodes.value = visibleNodes
  edges.value = visibleEdges
}

watch(
  activeFilters,
  () => {
    applyFilters()
    if (simulation) {
      simulation.nodes(nodes.value)
      simulation.force('link')?.links(edges.value)
      recomputeClusters()
      simulation.alpha(0.5).restart()
    }
  },
  { deep: true }
)
```

A node re-added after being filtered back in loses whatever `x`/`y`/velocity it had before removal (it is a fresh entry to `d3-force` as far as the simulation is concerned) — accepted per the spec's own framing ("removed nodes exit the simulation so the remainder re-settles, rather than just being drawn hidden"): re-settling is the explicitly wanted behavior, not a bug to work around.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`, apply a tag filter. Acceptance criteria: filtered-out nodes visibly leave the canvas (not just fade/hide — the remaining graph re-settles into a new layout, confirming they actually left the simulation); hulls (Task 20) recompute against the new visible set; clearing the filter brings the nodes back and the layout re-settles again.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: wire filter changes into the simulation and cluster recompute (OpenProject #901)"
```

---

## Task 27: "Clear filters" control (OpenProject #902)

**Files:**
- Modify: `frontend/src/pages/Graph.vue`

**Interfaces:**
- Produces: a `clearFilters()` function and a button, resetting `activeFilters` to its Task 23 defaults.
- Consumes: `activeFilters` (Task 23), the Task 26 watcher (fires automatically once `activeFilters` is reset, no separate wiring needed).

- [ ] **Step 1: Add the control**

```js
function clearFilters() {
  activeFilters.tags = []
  activeFilters.folderDepth = null
  activeFilters.locale = null
}
```

```html
<w-btn
  v-if="activeFilters.tags.length || activeFilters.folderDepth || activeFilters.locale"
  flat
  dense
  :label="t('graph.filters.clear')"
  @click="clearFilters" />
```

The `v-if` (only shown once a filter is actually active) mirrors the "Clear filters" affordance pattern elsewhere in the app rather than always showing a no-op button — check `frontend/src/pages/Search.vue`'s own filter-clearing control, if it has one, for a closer precedent before finalizing this markup.

- [ ] **Step 2: Manual smoke check**

Navigate to `/_graph`, apply a filter, confirm the clear button appears; click it — acceptance criteria: every filter resets, the full graph re-settles back in (via Task 26's watcher), and the button disappears again.

- [ ] **Step 3: Format, lint**

```bash
cd frontend
npx oxfmt src/pages/Graph.vue
npx oxlint src/pages/Graph.vue
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/Graph.vue
git commit -m "feat: add clear-filters control to the graph view (OpenProject #902)"
```

**Feature #875 status:** once Tasks 23–27 are all checked off, Feature #875 ("Frontend: drill-down filter controls") is ready to move to review — filters compose correctly, the simulation genuinely adds/removes nodes rather than just hiding them, clustering recomputes against the filtered set, and clearing restores the full graph.

**Epic #848 status:** once every Feature above (#872, #873, #874, #875, #876) has moved to review and the reviews pass, Epic #848 ("Interactive knowledge graph view with filterable, color-coded clusters") is ready to close.
