# Nav Sidebar Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click context menu to the reader-facing nav sidebar that lets an author create
a page, folder, or asset — or import one — right from an `auto`/`mixed`-mode generated tree entry,
reusing `PageNewMenu.vue`'s existing action set rather than building a new one.

**Architecture:** `generateFromTree` (backend) stamps each generated nav item with its raw tree
`path` and containing-folder `folderId`. The GET navigation endpoint starts reporting the resolved
menu's `mode` alongside its `items`. `PageNewMenu.vue` gains a `contextMenu` prop it forwards to its
own root `<w-menu>`. `NavSidebarItem.vue` and `NavSidebar.vue` place a right-click-triggered
`<page-new-menu context-menu>` on each qualifying row (and on the sidebar's own empty space),
computing `basePath`/`parentId` from the new item fields.

**Tech Stack:** TypeScript 7 (backend, `node --test`), Vue 3 / Vitest (frontend). No new
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-nav-sidebar-context-menu-design.md`

## Global Constraints

- Creation actions only (page/folder/asset/import) — no rename/move/delete/duplicate on nav items.
- No new permission surface: gating stays the existing `userStore.can('write:pages')` /
  `userStore.can('write:assets')` "may they do this somewhere" check; per-path enforcement remains
  server-side at save/import time, unchanged.
- No i18n additions — every label used is already sourced through `PageNewMenu.vue`'s existing
  `t(...)` calls.
- Backend DB-backed tests require `DATABASE_URL` (see `backend/test/db.ts`); run with e.g.
  `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres node --test <file>` from
  `backend/`.

---

## Task 1: Backend — `path`/`folderId` on generated `NavigationItem`s

**Files:**
- Modify: `backend/models/navigation.ts:41-65` (`NavigationItem` interface), `backend/models/navigation.ts:634-774` (`generateFromTree`)
- Modify: `backend/api/schemas/navigation.ts:10-47` (`NavigationItem` shared schema)
- Test: `backend/models/navigation.test.ts` (new tests in the existing `describe('navigation generateFromTree (DB-backed)', ...)` block, ~line 988)

**Interfaces:**
- Produces: `NavigationItem.path?: string` (raw tree path, no locale prefix — set on every
  `generated: true` item, both `folder` and `page` rows) and `NavigationItem.folderId?: string |
  null` (the tree-row id of the *containing* folder; `null` at locale root). Later tasks read both
  directly off items in `siteStore.nav.items`.

- [ ] **Step 1: Write the failing test**

Add to `backend/models/navigation.test.ts`, inside the existing
`describe('navigation generateFromTree (DB-backed)', ...)` block (after the
`'a nested override boundary...'` test, ~line 1098):

```typescript
  test('a generated item carries its own tree path and containing folderId', async () => {
    const sectionFolder = await treeModel.createFolder({
      parentPath: '',
      pathName: 'path-fields-section',
      title: 'Path Fields Section',
      locale: 'en',
      siteId: fixtures.siteId
    })
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'path-fields-section/inside-page', title: 'Inside Page' }),
      actor
    )

    const items = await generate()
    const folderItem = items.find((item) => item.label === 'Path Fields Section')
    assert.ok(folderItem)
    assert.equal(folderItem!.path, 'path-fields-section')
    assert.equal(folderItem!.folderId, null)

    const pageItem = folderItem!.children?.find((item) => item.label === 'Inside Page')
    assert.ok(pageItem)
    assert.equal(pageItem!.path, 'path-fields-section/inside-page')
    assert.equal(pageItem!.folderId, sectionFolder.id)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && DATABASE_URL=<your test db url> node --test models/navigation.test.ts`
Expected: FAIL — `folderItem!.path` and `pageItem!.folderId` are `undefined`, not the asserted
values (both fields don't exist on `NavigationItem` yet).

- [ ] **Step 3: Add the fields to the `NavigationItem` interface**

In `backend/models/navigation.ts`, inside `export interface NavigationItem { ... }` (currently
lines 41-65), add two properties after `target?: string`:

```typescript
  target?: string
  /**
   * `generated` items only: the raw tree path this item belongs to, no locale prefix (e.g.
   * `docs/setup`). Distinct from `target`, which is locale-prefixed and only ever set on a page
   * row. Never stored — computed fresh by `generateFromTree` on every read, same as `generated`
   * itself.
   */
  path?: string
  /**
   * `generated` items only: the tree-row id of the folder CONTAINING this item — `null` at locale
   * root. Needed because folder creation (`POST /sites/:siteId/tree/folders`) addresses its parent
   * by id while page creation addresses its target by path (`path` above) — this surfaces what
   * each one needs, not a third addressing scheme.
   */
  folderId?: string | null
```

- [ ] **Step 4: Stamp both fields in `generateFromTree`**

In `backend/models/navigation.ts`, `generateFromTree` (currently lines 634-774) needs to know its
own caller's folder id so it can hand it to every item it builds. Change its signature to accept
that as a parameter, defaulting to `null` for the initial (root) call:

```typescript
  private async generateFromTree(
    siteId: string,
    rootFolderPath: string,
    locale: string,
    actor: AccessActor | null,
    depth = 0,
    parentFolderId: string | null = null
  ): Promise<NavigationItem[]> {
```

Then, in the recursive call inside the `candidates.map(...)` block (currently around line 745),
pass the current row's own id down as the child items' `parentFolderId`:

```typescript
        const children =
          isFolder && !isBoundary
            ? await this.generateFromTree(siteId, childFolderPath, locale, actor, depth + 1, row.id)
            : []
```

And in the returned item object (currently around lines 757-769), add both new fields:

```typescript
        return {
          id: row.id,
          type: 'link',
          label: row.title,
          path,
          folderId: parentFolderId,
          ...(row.icon && { icon: row.icon }),
          ...(row.type === 'page' && {
            target: localizedPagePath(path, locale, locales)
          }),
          ...(children.length > 0 && { children })
        }
```

(`path` is already computed a few lines above this return, as `const path = parentPath ? ... :
row.fileName` — reused unchanged, just now also assigned onto the item itself.)

The one other call site of `generateFromTree` — `getGeneratedTree` (line 561) — is the *initial*
call and correctly leaves the new parameter at its default (`null`, meaning locale root has no
containing folder): no change needed there.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && DATABASE_URL=<your test db url> node --test models/navigation.test.ts`
Expected: PASS

- [ ] **Step 6: Add the fields to the shared OpenAPI schema**

In `backend/api/schemas/navigation.ts`, inside the `NavigationItem` schema's `properties` (after
`target`, before `openInNewWindow`), add:

```typescript
      target: { type: 'string' },
      path: {
        type: 'string',
        readOnly: true,
        description:
          'Generated items only: the raw tree path this item belongs to, no locale prefix. Never sent in a request body — computed fresh on every read, same as `generated`.'
      },
      folderId: {
        type: 'string',
        nullable: true,
        readOnly: true,
        description:
          "Generated items only: the tree-row id of the folder containing this item, or null at locale root. Never sent in a request body."
      },
      openInNewWindow: { type: 'boolean' },
```

- [ ] **Step 7: Typecheck and commit**

Run: `cd backend && npm run typecheck`
Expected: no errors.

```bash
git add backend/models/navigation.ts backend/models/navigation.test.ts backend/api/schemas/navigation.ts
git commit -m "Add path/folderId to generated NavigationItems"
```

---

## Task 2: Backend — expose the resolved menu `mode` from the navigation GET endpoint

**Files:**
- Modify: `backend/api/navigation.ts:39-88` (`GET /sites/:siteId/navigation/:navId`)
- Modify: `frontend/src/components/NavItemEditor.vue:793-810` (`loadMenuItems`)
- Test: `frontend/src/components/NavItemEditor.test.js` (`mountEditor` helper, ~line 71-90)

**Interfaces:**
- Produces: `GET /sites/:siteId/navigation/:navId` now returns `{ mode: 'static' | 'auto' |
  'mixed', items: NavigationItem[] }` instead of a bare `NavigationItem[]` array. Task 3 (the
  reader-facing consumer) depends on this.

- [ ] **Step 1: Write the failing test**

`NavItemEditor.test.js`'s `mountEditor()` helper (~line 71-83) currently mocks the navigation GET
call to resolve a bare items array:

```javascript
function mountEditor({ items = SERVER_ITEMS, groups = [], menuMode, roots = [], sites = [] } = {}) {
  API_CLIENT.get.mockImplementation((url) => {
    if (url === 'groups') {
      return { json: vi.fn().mockResolvedValue(groups) }
    }
    if (url === 'sites') {
      return { json: vi.fn().mockResolvedValue(sites) }
    }
    if (url === 'sites/site-1/navigation/roots') {
      return { json: vi.fn().mockResolvedValue(roots) }
    }
    return { json: vi.fn().mockResolvedValue(items) }
  })
```

Change the fallback branch to match the real endpoint's new shape:

```javascript
    return { json: vi.fn().mockResolvedValue({ mode: 'static', items }) }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/NavItemEditor.test.js`
Expected: FAIL — `loadMenuItems()` still does `state.items = flattenMenuItems(items)` where `items`
is the whole `{ mode, items }` object (since the endpoint hasn't changed yet), so `flattenMenuItems`
receives the wrong shape and every test asserting on rendered items breaks.

- [ ] **Step 3: Change the backend route to return `{ mode, items }`**

In `backend/api/navigation.ts`, the `GET /sites/:siteId/navigation/:navId` route (lines 39-88):
update the `response.200` schema (currently `type: 'array', items: { $ref: 'NavigationItem#' }`,
lines 65-70) to:

```typescript
        response: {
          200: {
            description: "The resolved menu's own source mode, plus its items in the order they are shown",
            type: 'object',
            properties: {
              mode: { type: 'string', enum: NAVIGATION_SOURCE_MODES },
              items: {
                type: 'array',
                items: { $ref: 'NavigationItem#' }
              }
            },
            required: ['mode', 'items']
          },
          403: { $ref: 'ApiError#' }
        }
```

(`NAVIGATION_SOURCE_MODES` is already imported in this file — it's used a few lines below at the
`/mode` route, line 118.)

Then update the handler (currently lines 75-87) to fetch both and return them together:

```typescript
    async (req, reply) => {
      const unfiltered = Boolean(req.query.full)
      if (unfiltered && !canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden(
          'Reading a menu in full requires manage:navigation, or site:navigation on this site.'
        )
      }
      const [mode, items] = await Promise.all([
        WIKI.models.navigation.getMode(req.params.siteId, req.params.navId),
        WIKI.models.navigation.getNav(req.params.siteId, req.params.navId, {
          actor: WIKI.models.groups.actorForRequest(req),
          userGroups: req.session?.authenticated ? (req.session.groups ?? []) : [],
          unfiltered
        })
      ])
      return { mode, items }
    }
```

Also update the route's `description` string (lines 45) to mention the new response shape — append
a sentence: `" The response wraps the resolved items alongside the menu's own source mode, so a caller doesn't need a second request to learn it."`

- [ ] **Step 4: Fix `NavItemEditor.vue`'s consumption**

In `frontend/src/components/NavItemEditor.vue`, `loadMenuItems()` (currently lines 793-810):

```javascript
async function loadMenuItems() {
  state.loading++
  try {
    // -> `full`, because the editor has to see items limited to groups the editor is not in:
    //    saving without them would delete them
    const { items } = await API_CLIENT.get(`sites/${props.siteId}/navigation/${props.navId}`, {
      searchParams: { full: true }
    }).json()
    state.items = flattenMenuItems(items)
    state.selected = null
    state.current = {}
  } catch (err) {
```

(Only the destructuring on the `API_CLIENT.get(...)` line changes — everything else in the
function is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npm run typecheck` (verify the route change typechecks)
Run: `cd frontend && npx vitest run src/components/NavItemEditor.test.js`
Expected: both PASS

- [ ] **Step 6: Commit**

```bash
git add backend/api/navigation.ts frontend/src/components/NavItemEditor.vue frontend/src/components/NavItemEditor.test.js
git commit -m "Expose resolved menu mode from the navigation GET endpoint"
```

---

## Task 3: Frontend — site store stores the resolved `mode`

**Files:**
- Modify: `frontend/src/stores/site.js:198-203` (`nav` state), `frontend/src/stores/site.js:344-378` (`fetchNavigation`)
- Test: `frontend/src/stores/site.test.js:203-331` (`describe('site store: fetchNavigation()', ...)`)

**Interfaces:**
- Consumes: `GET /sites/:siteId/navigation/:navId` → `{ mode, items }` (Task 2).
- Produces: `siteStore.nav.mode: 'static' | 'auto' | 'mixed'`. Tasks 4 and 5 read this to decide
  whether a context menu is offered on a given item / on the sidebar's empty space.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/stores/site.test.js`, `describe('site store: fetchNavigation()', ...)` (lines
203-331), every mocked response and every `toEqual`/`store.nav` assertion needs the new `mode`
field. Replace the whole block's bodies as follows (structure and test names unchanged, only the
mocked payload shape and the `nav` assertions change):

```javascript
describe('site store: fetchNavigation()', () => {
  it('fetches and caches the menu for a not-yet-seen id', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'item-1' }] })
    })

    await store.fetchNavigation('nav-1')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav).toEqual({
      currentId: 'nav-1',
      items: [{ id: 'item-1' }],
      mode: 'static',
      inFlightId: 'nav-1'
    })
  })

  it('skips the request for an id already cached, unless forceRefresh is passed', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'stale' }], mode: 'static' } })

    await store.fetchNavigation('nav-1')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(store.nav.items).toEqual([{ id: 'stale' }])

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'auto', items: [{ id: 'fresh' }] })
    })
    await store.fetchNavigation('nav-1', true)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-1')
    expect(store.nav.items).toEqual([{ id: 'fresh' }])
    expect(store.nav.mode).toBe('auto')
  })

  it('does nothing for a falsy id, forceRefresh or not', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    await store.fetchNavigation(null)
    await store.fetchNavigation(undefined, true)

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('still refetches a DIFFERENT id even without forceRefresh, same as before', async () => {
    const store = useSiteStore()
    store.id = 'site-1'
    store.$patch({ nav: { currentId: 'nav-1', items: [{ id: 'old' }], mode: 'static' } })

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ mode: 'static', items: [{ id: 'new' }] })
    })
    await store.fetchNavigation('nav-2')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/navigation/nav-2')
    expect(store.nav).toEqual({
      currentId: 'nav-2',
      items: [{ id: 'new' }],
      mode: 'static',
      inFlightId: 'nav-2'
    })
  })

  it('discards a stale response when an earlier call resolves after a later one', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    let resolveFirst
    let resolveSecond
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => firstResponse })
    API_CLIENT.get.mockReturnValueOnce({ json: () => secondResponse })

    const firstCall = store.fetchNavigation('nav-1')
    const secondCall = store.fetchNavigation('nav-2')

    // The later call (nav-2) resolves first; the earlier call (nav-1) resolves last.
    resolveSecond({ mode: 'static', items: [{ id: 'nav-2-item' }] })
    await secondCall
    expect(store.nav.currentId).toBe('nav-2')

    resolveFirst({ mode: 'static', items: [{ id: 'nav-1-item' }] })
    await firstCall

    // The stale nav-1 response must not have overwritten the newer nav-2 menu.
    expect(store.nav.currentId).toBe('nav-2')
    expect(store.nav.items).toEqual([{ id: 'nav-2-item' }])
  })

  it('leaves the correct menu rendered when switching sites twice in quick succession', async () => {
    const store = useSiteStore()
    store.id = 'site-1'

    let resolveSiteA
    let resolveSiteB
    const siteAResponse = new Promise((resolve) => {
      resolveSiteA = resolve
    })
    const siteBResponse = new Promise((resolve) => {
      resolveSiteB = resolve
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => siteAResponse })
    API_CLIENT.get.mockReturnValueOnce({ json: () => siteBResponse })

    // Two rapid site switches, each kicking off a fetch for that site's nav before the previous one
    // has resolved.
    const fetchA = store.fetchNavigation('site-a-nav')
    const fetchB = store.fetchNavigation('site-b-nav')

    // Site A's slower response lands after site B's, as it would for a genuinely slower request.
    resolveSiteB({ mode: 'static', items: [{ id: 'site-b-item' }] })
    await fetchB
    resolveSiteA({ mode: 'static', items: [{ id: 'site-a-item' }] })
    await fetchA

    expect(store.nav.currentId).toBe('site-b-nav')
    expect(store.nav.items).toEqual([{ id: 'site-b-item' }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/stores/site.test.js`
Expected: FAIL — `store.nav` has no `mode` field yet, and `fetchNavigation` still destructures the
response as a bare array.

- [ ] **Step 3: Add `mode` to the `nav` state and `fetchNavigation`**

In `frontend/src/stores/site.js`, the `nav` state (currently lines 198-203):

```javascript
    nav: {
      currentId: null,
      items: [],
      mode: 'static',
      inFlightId: null
    }
```

And `fetchNavigation` (currently lines 344-378):

```javascript
    async fetchNavigation(id, forceRefresh = false) {
      if (!id || (!forceRefresh && id === this.nav.currentId)) {
        return
      }
      // -> Set synchronously, before the request goes out, so a second overlapping call can mark
      //    this one stale the instant it starts -- not only once it too has a response in hand.
      this.nav.inFlightId = id
      try {
        const { mode, items } = await API_CLIENT.get(`sites/${this.id}/navigation/${id}`).json()
        // -> A newer call may have started (and even finished) while this one was in flight; if so,
        //    its id is no longer the one this response is for, so discard rather than clobber it.
        if (this.nav.inFlightId !== id) {
          return
        }
        this.$patch({
          nav: {
            currentId: id,
            items: items ?? [],
            mode: mode ?? 'static'
          }
        })
      } catch (err) {
        if (this.nav.inFlightId !== id) {
          return
        }
        // -> An empty sidebar is the right outcome for a menu nobody has set up, rather than an error
        //    in front of a reader who cannot act on it
        console.warn(err.message)
        this.$patch({
          nav: {
            currentId: id,
            items: [],
            mode: 'static'
          }
        })
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/stores/site.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stores/site.js frontend/src/stores/site.test.js
git commit -m "Store the resolved nav menu mode in the site store"
```

---

## Task 4: Frontend — `PageNewMenu.vue` `contextMenu` prop + `NavSidebarItem.vue` per-item context menu

**Files:**
- Modify: `frontend/src/components/PageNewMenu.vue` (add `contextMenu` prop)
- Modify: `frontend/src/components/NavSidebarItem.vue`
- Test: `frontend/src/components/PageNewMenu.test.js` (new test), `frontend/src/components/NavSidebar.test.js` (new tests — `NavSidebarItem.vue` is exercised through `NavSidebar.vue`'s existing `mountNav` helper, per that file's own convention)

**Interfaces:**
- Consumes: `item.generated`, `item.path`, `item.folderId`, `item.children` (Tasks 1 & 3);
  `userStore.can('write:pages' | 'write:assets')` (existing).
- Produces: `PageNewMenu` prop `contextMenu: Boolean` (default `false`), forwarded to its root
  `<w-menu :context-menu="...">`. `NavSidebarItem.vue`'s local `basePathFor(item)` /
  `parentIdFor(item)` — read by Task 5 for the root/empty-space case, so keep their exact shape:
  `basePathFor(item): string`, `parentIdFor(item): string | null`.

- [ ] **Step 1: Write the failing test for `PageNewMenu.vue`'s new prop**

Add to `frontend/src/components/PageNewMenu.test.js`, inside the existing `describe('PageNewMenu',
...)` block:

```javascript
  it('forwards the contextMenu prop to its own root w-menu, off by default', async () => {
    const CapturingWMenu = {
      name: 'CapturingWMenu',
      props: ['contextMenu'],
      template: '<div :data-context-menu="contextMenu"><slot /></div>'
    }
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.editors = { asciidoc: false, code: false, markdown: true, wysiwyg: false }
    const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

    const off = mount(PageNewMenu, {
      global: { plugins: [i18n], components: { BlueprintIcon }, stubs: { WMenu: CapturingWMenu } }
    })
    expect(off.findComponent(CapturingWMenu).props('contextMenu')).toBe(false)

    const on = mount(PageNewMenu, {
      props: { contextMenu: true },
      global: { plugins: [i18n], components: { BlueprintIcon }, stubs: { WMenu: CapturingWMenu } }
    })
    expect(on.findComponent(CapturingWMenu).props('contextMenu')).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PageNewMenu.test.js`
Expected: FAIL — `PageNewMenu` has no `contextMenu` prop, so `off.findComponent(CapturingWMenu)`
either doesn't resolve the prop or the component throws on the unknown prop mismatch.

- [ ] **Step 3: Add the prop**

In `frontend/src/components/PageNewMenu.vue`, the template's root element (currently line 2):

```html
  <w-menu
    class="translucent-menu"
    :context-menu="props.contextMenu"
    auto-close
    anchor="bottom right"
    self="top right">
```

And in the `<script setup>` block's `defineProps` (currently lines 85-98), add:

```javascript
const props = defineProps({
  hideAssetBtn: {
    type: Boolean,
    default: false
  },
  showNewFolder: {
    type: Boolean,
    default: false
  },
  basePath: {
    type: String,
    default: null
  },
  /** Opens on right-click at the pointer instead of on left-click at the anchor — see WMenu.vue's
   *  own `contextMenu` prop. Off by default so every existing click-triggered call site (the
   *  header toolbar button, the phone overflow menu, File Manager) is unaffected. */
  contextMenu: {
    type: Boolean,
    default: false
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PageNewMenu.test.js`
Expected: PASS

- [ ] **Step 5: Write the failing tests for `NavSidebarItem.vue`**

Add to `frontend/src/components/NavSidebar.test.js`, a new `describe` block (after the existing
`describe('NavSidebar mixed folder/page side-tree ...)` block, before the RTL one):

```javascript
describe('NavSidebarItem context menu', () => {
  function generatedTree() {
    return [
      {
        id: 'folder-1',
        type: 'link',
        icon: 'mdi:folder',
        label: 'Docs',
        path: 'docs',
        folderId: null,
        generated: true,
        children: [
          {
            id: 'page-1',
            type: 'link',
            icon: 'mdi:file',
            label: 'Setup',
            path: 'docs/setup',
            folderId: 'folder-1',
            target: '/docs/setup',
            generated: true
          }
        ]
      }
    ]
  }

  async function mountWithPermission(items, canWrite) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.nav.items = items
    const userStore = useUserStore()
    userStore.permissions = canWrite ? ['write:pages'] : []

    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    await router.isReady()

    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { common: { sidebar: { browse: 'Browse' } } } }
    })

    const wrapper = mount(NavSidebar, { global: { plugins: [router, i18n] } })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('renders a PageNewMenu on a generated item when the viewer can write pages', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(true)
  })

  it('renders no PageNewMenu when the viewer cannot write pages', async () => {
    const wrapper = await mountWithPermission(generatedTree(), false)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('renders no PageNewMenu on a non-generated (static) item, even when the viewer can write pages', async () => {
    const staticItems = [
      { id: 'static-1', type: 'link', icon: 'mdi:link', label: 'Static Link', target: '/somewhere' }
    ]
    const wrapper = await mountWithPermission(staticItems, true)
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('resolves basePath/parentId for a folder item as "create inside it"', async () => {
    const wrapper = await mountWithPermission(generatedTree(), true)
    const folderMenu = wrapper.findComponent(PageNewMenu)
    expect(folderMenu.props('basePath')).toBe('docs')
  })

  it('resolves basePath for a page item as "create as a sibling"', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    // -> Expanded so the page's own row (not just its folder ancestor's) is in the mounted tree
    siteStore.nav.items = generatedTree()
    const userStore = useUserStore()
    userStore.permissions = ['write:pages']

    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/docs/setup')
    await router.isReady()

    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { common: { sidebar: { browse: 'Browse' } } } }
    })

    const wrapper = mount(NavSidebar, { global: { plugins: [router, i18n] } })
    await wrapper.vm.$nextTick()

    const menus = wrapper.findAllComponents(PageNewMenu)
    const pageMenu = menus.find((m) => m.props('basePath') === 'docs')
    expect(pageMenu).toBeTruthy()
  })
})
```

Add the two new imports this needs at the top of `NavSidebar.test.js`:

```javascript
import PageNewMenu from './PageNewMenu.vue'
import { useUserStore } from '@/stores/user'
```

(`router` is already imported as `routes` from `@/router/routes` at the top of this file, matching
the existing `mountNav` helper — the new tests above build their own router the same way rather
than reusing `mountNav`, since they need `useUserStore()` set up before mount, which `mountNav`
doesn't do.)

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NavSidebar.test.js`
Expected: FAIL — `NavSidebarItem.vue` renders no `PageNewMenu` anywhere yet.

- [ ] **Step 7: Implement the context menu in `NavSidebarItem.vue`**

Replace the full file:

```vue
<template>
  <!-- -> Open from the start when the page being read is one of its descendants, so a reader arriving
          by URL sees where they are in the tree -- or when the menu says this group opens that way
          whatever is being read. Not `v-model`: after that first render the group is the reader's
          to open and close, and a bound value would fight them -->
  <w-expansion-item
    v-if="item.children?.length > 0"
    dense
    :default-opened="item.expandByDefault || containsCurrent(item)">
    <!-- The icon goes through a header slot rather than the `icon` prop, so that an Iconify -->
    <!-- reference is drawn by w-icon like everywhere else -->
    <template #header>
      <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
      <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
      <!-- -> Create inside this folder: right-click anywhere on its own header row -->
      <page-new-menu
        v-if="canCreate"
        context-menu
        :base-path="basePathFor(item)"
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(parentIdFor(item))" />
    </template>
    <w-list dense dark>
      <!-- -> One nav item, plus its own expansion behavior if it has children -- rendered for each
              child so a folder nested any number of levels deep still draws its own contents,
              rather than only the first level under the sidebar root -->
      <nav-sidebar-item v-for="child of item.children" :key="child.id" :item="child" />
    </w-list>
  </w-expansion-item>
  <w-item v-else v-bind="destination(item)">
    <w-item-section side><w-icon :name="item.icon" color="white" /></w-item-section>
    <w-item-section class="text-wordbreak-all text-white">{{ item.label }}</w-item-section>
    <!-- -> Create as a sibling, in the folder this page lives in: right-click anywhere on its row -->
    <page-new-menu
      v-if="canCreate"
      context-menu
      :base-path="basePathFor(item)"
      :hide-asset-btn="!canUploadAsset"
      @new-folder="openFolderDialog(parentIdFor(item))" />
  </w-item>
</template>

<script setup>
import { computed } from 'vue'

import { useNavSidebarDestination } from '@/composables/navSidebarDestination'
import { dialog } from '@/composables/dialog'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import PageNewMenu from '@/components/PageNewMenu.vue'

// -> Self-imported so the recursive tag below resolves explicitly, rather than relying on the SFC
//    filename-based self-reference Vue infers implicitly for `<script setup>` components
import NavSidebarItem from './NavSidebarItem.vue'

const props = defineProps({
  /** One nav item -- a `link`, possibly carrying `children` of its own. */
  item: {
    type: Object,
    required: true
  }
})

const { destination, containsCurrent } = useNavSidebarDestination()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// COMPUTED

/**
 * A right-click context menu only makes sense on an item backed by a real page/folder -- a
 * `generated` (auto/mixed-mode tree-walk) item, never a hand-authored `static` link, which may not
 * correspond to any page at all. Gated the same coarse "may they create pages somewhere" way the
 * toolbar's own "+ New Page" button already is -- real per-path enforcement stays server-side.
 */
const canCreate = computed(() => Boolean(props.item.generated) && userStore.can('write:pages'))
const canUploadAsset = computed(
  () => userStore.can('write:assets') || userStore.can('write:pages')
)

// METHODS

/**
 * Where a creation action targets, for a generated item: right-click a FOLDER item (one with
 * children -- every generated folder item has at least one, or it would have been dropped) creates
 * INSIDE it; right-click a PAGE item creates as a SIBLING, in the folder it lives in.
 */
function basePathFor(item) {
  if (item.children?.length > 0) {
    return item.path ?? ''
  }
  const segments = (item.path ?? '').split('/')
  segments.pop()
  return segments.join('/')
}

/** The `parentId` a new FOLDER (not page) is created under -- see `basePathFor` above for the same
 *  inside-vs-sibling rule, addressed by id rather than path since folder creation takes a `parentId`. */
function parentIdFor(item) {
  return item.children?.length > 0 ? item.id : (item.folderId ?? null)
}

function openFolderDialog(parentId) {
  dialog({
    component: FolderCreateDialog,
    componentProps: { parentId }
  }).onOk(() => {
    siteStore.fetchNavigation(pageStore.navigationId, true)
  })
}
</script>
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NavSidebar.test.js`
Expected: PASS — including every pre-existing test in this file (the new markup only adds a
conditionally-rendered `PageNewMenu`, never changing existing row structure).

- [ ] **Step 9: Full frontend suite**

Run: `cd frontend && npm run test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/PageNewMenu.vue frontend/src/components/PageNewMenu.test.js frontend/src/components/NavSidebarItem.vue frontend/src/components/NavSidebar.test.js
git commit -m "Add right-click create-here context menu to generated nav sidebar items"
```

---

## Task 5: Frontend — `NavSidebar.vue` empty-space (locale-root) context menu

**Files:**
- Modify: `frontend/src/components/NavSidebar.vue`
- Test: `frontend/src/components/NavSidebar.test.js`

**Interfaces:**
- Consumes: `siteStore.nav.mode` (Task 3); `PageNewMenu`'s `contextMenu` prop (Task 4);
  `basePathFor`/`parentIdFor`-equivalent logic for the root case (trivial here: always `''`/`null`,
  no item to read).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/NavSidebar.test.js`, a new `describe` block (after the
`NavSidebarItem context menu` block added in Task 4):

```javascript
describe('NavSidebar empty-space context menu', () => {
  async function mountRoot({ mode = 'static', canWrite = true } = {}) {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.nav.items = []
    siteStore.nav.mode = mode
    const userStore = useUserStore()
    userStore.permissions = canWrite ? ['write:pages'] : []

    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    await router.isReady()

    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { common: { sidebar: { browse: 'Browse' } } } }
    })

    const wrapper = mount(NavSidebar, { global: { plugins: [router, i18n] } })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('offers a root-level create menu when the resolved mode is auto', async () => {
    const wrapper = await mountRoot({ mode: 'auto' })
    const menu = wrapper.findComponent(PageNewMenu)
    expect(menu.exists()).toBe(true)
    expect(menu.props('basePath')).toBe('')
  })

  it('offers a root-level create menu when the resolved mode is mixed', async () => {
    const wrapper = await mountRoot({ mode: 'mixed' })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(true)
  })

  it('offers no root-level create menu on a static menu -- nothing to create "into"', async () => {
    const wrapper = await mountRoot({ mode: 'static' })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })

  it('offers no root-level create menu when the viewer cannot write pages', async () => {
    const wrapper = await mountRoot({ mode: 'auto', canWrite: false })
    expect(wrapper.findComponent(PageNewMenu).exists()).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/NavSidebar.test.js`
Expected: FAIL — `NavSidebar.vue` renders no `PageNewMenu` for the empty-space case yet.

- [ ] **Step 3: Implement the root-level context menu**

In `frontend/src/components/NavSidebar.vue`, add the menu as the last child of the `<nav>` element
(after the closing `</w-list>`, still inside `<nav>`):

```vue
<template>
  <!-- -> The dent marking the current page is cut out of the edge FACING the content, which is the
          right one only while the sidebar is on the left; see the stylesheet -->
  <w-scroll-area
    class="sidebar-nav"
    :class="siteStore.theme.sidebarPosition === `right` ? `sidebar-nav--flipped` : ``">
    <!-- -> The primary navigation landmark: distinct from `PageToc`'s own `<nav>` so the two are
            reachable and tellable apart from the landmarks rotor -->
    <nav :aria-label="t(`common.sidebar.browse`)">
      <w-list class="sidebar-nav-list" dense dark>
        <template v-for="item of siteStore.nav.items" :key="item.id">
          <w-item-label
            class="sidebar-nav-header text-caption text-wordbreak-all"
            v-if="item.type === `header`"
            header
            >{{ item.label }}</w-item-label
          >
          <!-- -> One nav item, plus its expansion behavior if it has children -- recursive, so a
                  folder nested any number of levels deep still draws its own contents rather than
                  only the first level under the sidebar root -->
          <nav-sidebar-item v-else-if="item.type === `link`" :item="item" />
          <w-separator v-else-if="item.type === `separator`" dark />
        </template>
      </w-list>
      <!-- -> Right-click empty space to create at the locale root -- only meaningful when there is
              a real tree backing this menu (auto/mixed); a static menu's links may not correspond
              to any page at all -->
      <page-new-menu
        v-if="canCreateAtRoot"
        context-menu
        base-path=""
        :hide-asset-btn="!canUploadAsset"
        @new-folder="openFolderDialog(null)" />
    </nav>
  </w-scroll-area>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import PageNewMenu from '@/components/PageNewMenu.vue'
import NavSidebarItem from './NavSidebarItem.vue'

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// I18N

const { t } = useI18n()

// COMPUTED

const canUploadAsset = computed(
  () => userStore.can('write:assets') || userStore.can('write:pages')
)
const canCreateAtRoot = computed(
  () =>
    (siteStore.nav.mode === 'auto' || siteStore.nav.mode === 'mixed') &&
    userStore.can('write:pages')
)

// METHODS

function openFolderDialog(parentId) {
  dialog({
    component: FolderCreateDialog,
    componentProps: { parentId }
  }).onOk(() => {
    siteStore.fetchNavigation(pageStore.navigationId, true)
  })
}

// WATCHERS

watch(
  () => pageStore.navigationId,
  (newValue) => {
    // -> The "already showing this menu" gate now lives in `fetchNavigation()` itself (OpenProject
    //    #1012), so a same-tab invalidation elsewhere in the app can bypass it with `forceRefresh`
    //    without this watcher needing to know why.
    siteStore.fetchNavigation(newValue)
  },
  { immediate: true }
)
</script>

<style lang="scss">
```

(Everything from the `<style lang="scss">` line to the end of the file is unchanged — only the
template's new `<page-new-menu>` line and the script's new imports/stores/computed/method are
added, alongside the existing `watch`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/NavSidebar.test.js`
Expected: PASS — including every pre-existing test in this file.

- [ ] **Step 5: Full frontend suite**

Run: `cd frontend && npm run test`
Expected: PASS

- [ ] **Step 6: Full backend suite** (confirms Tasks 1-2's backend changes are still clean alongside
  everything else)

Run: `cd backend && npm run typecheck && DATABASE_URL=<your test db url> npm run test`
Expected: PASS

- [ ] **Step 7: Lint and format**

Run: `cd backend && npx oxlint`
Run: `cd frontend && npx oxlint`
Run: `npx --prefix backend oxfmt --check backend frontend`
Expected: clean on all three.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/NavSidebar.vue frontend/src/components/NavSidebar.test.js
git commit -m "Add root-level create context menu to the auto/mixed-mode nav sidebar"
```

---

## Follow-up (not part of this plan)

File a Task once this ships: give `WMenu`'s `context-menu` mode a touch (long-press) and
keyboard-accessible trigger — a pre-existing gap in `TreeNode.vue`'s own context menu (File
Manager, `TreeBrowserDialog`) that this plan's new context menus inherit rather than introduce. See
the spec's "Open follow-up" section.
