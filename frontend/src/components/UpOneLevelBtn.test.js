import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import FileManager from './FileManager.vue'
import NavBrowseMenu from './NavBrowseMenu.vue'
import TreeBrowserDialog from './TreeBrowserDialog.vue'
import UpOneLevelBtn from './UpOneLevelBtn.vue'

import { mountWithApp } from '../../test/mount.js'
import { createTestRouter } from '../../test/router.js'
import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2695 -- the up-one-level plate, as ONE control across its three call sites.
 *
 * The Browse panel already had the whole of it (absent at the root, a slide-in from the inline start,
 * a dimmed glyph, a focus ring); the File Manager and the save dialog had no up affordance at all.
 * This suite is what stops the three from drifting apart again: the control's own contract is
 * asserted once, then each call site is asserted to be USING it rather than drawing its own.
 *
 * The measured half runs in real headless Chromium. "A 28px square plate" and "an accent focus ring
 * 2px clear of the plate, not clipped by an ancestor that scrolls" are both facts about layout, and
 * neither `jsdom` nor `happy-dom` runs a layout engine -- every rect they report is zeroed. Reading
 * the CSS instead would have missed exactly the defect this Task found: the plate was 38px wide, not
 * 28px, because WBtn's `dense` padding sits in an inline style that the stylesheet declaring
 * `min-width: 28px` never beat.
 */

/** Real strings, flat with literal dots, exactly as `GET /locales/:code/strings` serves them. */
const MESSAGES = {
  'common.browse.upOneLevel': 'Up one level',
  'common.browse.openFolder': 'Open the {title} folder',
  'common.browse.empty': 'There is nothing here.',
  'common.sidebar.browse': 'Browse',
  'fileman.title': 'File Manager',
  'fileman.searchFolder': 'Search folder',
  'fileman.viewOptions': 'View options',
  'pageSaveDialog.title': 'Save page',
  'pageSaveDialog.pageTitle': 'Title',
  'pageSaveDialog.pathName': 'Path Name',
  'pageSaveDialog.newFolderHint': 'Right-click a folder to add one.'
}

/** One folder, `/docs`, sitting directly under the root -- so its parent id is `null`. */
const DOCS_NODE = { folderPath: '', fileName: 'docs', title: 'Docs', children: [] }
/** `/docs/setup`, whose parent is `docs` -- so going up lands on an id, not on the root. */
const SETUP_NODE = { folderPath: 'docs', fileName: 'setup', title: 'Setup', children: [] }

const ROOT_LEVEL = {
  title: '',
  items: [{ path: 'docs', title: 'Docs', isPage: false, isFolder: true }],
  truncated: false
}
const DOCS_LEVEL = {
  title: 'Docs',
  items: [{ path: 'docs/intro', title: 'Intro', isPage: true, isFolder: false, icon: null }],
  truncated: false
}

function mountControl(props = {}) {
  return mountWithApp(UpOneLevelBtn, {
    props,
    messages: MESSAGES,
    // -> The real Transition, not VTU's stub: `show: false` must leave NOTHING behind, which is a
    //    claim about the transition's own rendering and not just about the `v-if` inside it.
    stubs: { teleport: true, transition: false }
  }).wrapper
}

/**
 * The Browse panel, opened on a subfolder (the control is present) or on the root (it is absent).
 *
 * Mounted the way `NavBrowseMenu.test.js` mounts it -- attached to a real, connected element, then
 * clicked, because `WMenu` climbs to its own parent for a trigger.
 */
async function mountBrowseMenu({ atRoot = false } = {}) {
  globalThis.API_CLIENT.get.mockReturnValue({
    json: () => Promise.resolve(atRoot ? ROOT_LEVEL : DOCS_LEVEL)
  })
  const router = await createTestRouter(['/:pathMatch(.*)*'])
  const { wrapper } = mountWithApp(NavBrowseMenu, {
    attachTo: document.body,
    messages: MESSAGES,
    router,
    stores: {
      site: { id: 'site-1' },
      page: (store) => {
        store.$patch({ path: atRoot ? 'home' : 'docs/current-page', locale: 'en' })
      }
    },
    stubs: { teleport: true, transition: false }
  })
  wrapper.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
  return wrapper
}

/** The File Manager, listing the root or a subfolder. */
async function mountFileManager({ atRoot = false, folderId = 'f-setup' } = {}) {
  const { wrapper } = mountWithApp(FileManager, {
    attachTo: document.body,
    messages: MESSAGES,
    // -> It calls `useRouter()` for the edit/open actions in its row menus; without one the mount
    //    warns and every one of those bindings is undefined.
    router: await createTestRouter(['/:pathMatch(.*)*']),
    stores: { site: { id: 'site-1' }, page: { locale: 'en' } },
    stubs: { teleport: true, transition: false }
  })
  await flushPromises()
  if (!atRoot) {
    wrapper.vm.state.treeNodes = { 'f-docs': { ...DOCS_NODE }, [folderId]: { ...SETUP_NODE } }
    wrapper.vm.state.currentFolderId = folderId
    await flushPromises()
  }
  return wrapper
}

/** The save dialog, browsing the root or a subfolder. */
async function mountSaveDialog({ atRoot = false, folderId = 'f-setup' } = {}) {
  globalThis.API_CLIENT.get.mockReturnValue({ json: vi.fn().mockResolvedValue([]) })
  const { wrapper } = mountWithApp(TreeBrowserDialog, {
    props: { mode: 'savePage' },
    messages: MESSAGES,
    stores: { site: { id: 'site-1' } },
    // -> Opts out of the default `teleport: true`: `w-dialog` really teleports its body to
    //    `document.body`, which is where the plate ends up and where this suite reads it.
    stubs: { transition: false }
  })
  await flushPromises()
  if (!atRoot) {
    wrapper.vm.state.treeNodes = { 'f-docs': { ...DOCS_NODE }, [folderId]: { ...SETUP_NODE } }
    wrapper.vm.state.currentFolderId = folderId
    await flushPromises()
  }
  return wrapper
}

function plates() {
  return document.querySelectorAll('.up-one-level-btn')
}

describe('UpOneLevelBtn', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is absent from the DOM at the root, not merely hidden', () => {
    const wrapper = mountControl({ show: false })

    // -> Both halves: no plate, and no footprint either. A hidden-but-present control is still
    //    focusable, still read out, and still occupies its slot -- which is what the design rejects.
    expect(wrapper.find('.up-one-level-btn').exists()).toBe(false)
    expect(wrapper.find('.up-one-level-slot').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('Up one level')
  })

  it('renders a labelled plate once there is a level above', () => {
    const wrapper = mountControl({ show: true })

    const plate = wrapper.get('.up-one-level-btn')
    expect(plate.attributes('aria-label')).toBe('Up one level')
    // -> Resolved, not the raw key: every call site reads the same `common.browse.upOneLevel`
    expect(plate.attributes('aria-label')).not.toBe('common.browse.upOneLevel')
    expect(wrapper.find('[data-icon="tabler:arrow-up"]').exists()).toBe(true)
  })

  it('emits click when pressed, and not while disabled', async () => {
    const wrapper = mountControl({ show: true })
    await wrapper.get('.up-one-level-btn').trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)

    const disabled = mountControl({ show: true, disabled: true })
    await disabled.get('.up-one-level-btn').trigger('click')
    expect(disabled.emitted('click')).toBeUndefined()
  })

  it('composes plateClass onto the plate rather than onto its animated footprint', () => {
    const wrapper = mountControl({ show: true, plateClass: 'acrylic-btn' })

    expect(wrapper.get('.up-one-level-btn').classes()).toContain('acrylic-btn')
    expect(wrapper.get('.up-one-level-slot').classes()).not.toContain('acrylic-btn')
  })
})

/**
 * One control, three call sites. Each case asserts the SHARED plate is what the surface renders --
 * `.up-one-level-btn` is `UpOneLevelBtn.vue`'s own class, so a call site that grew a look-alike
 * button of its own would fail here rather than quietly drift.
 */
describe('UpOneLevelBtn adoption', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('the Browse panel draws the shared plate below the root, and nothing at the root', async () => {
    await mountBrowseMenu({ atRoot: false })
    expect(plates()).toHaveLength(1)
    expect(document.querySelector('.up-one-level-btn').getAttribute('aria-label')).toBe(
      'Up one level'
    )
    // -> The one call site on a translucent surface, and the only one passing the acrylic treatment
    expect(document.querySelector('.up-one-level-btn').classList).toContain('acrylic-btn')

    document.body.innerHTML = ''
    await mountBrowseMenu({ atRoot: true })
    expect(plates()).toHaveLength(0)
  })

  it('the File Manager draws the shared plate in a folder, and nothing at the root', async () => {
    await mountFileManager({ atRoot: true })
    expect(plates()).toHaveLength(0)

    document.body.innerHTML = ''
    const wrapper = await mountFileManager({ atRoot: false })
    expect(plates()).toHaveLength(1)
    // -> Not the acrylic treatment: the toolbar it sits in is opaque
    expect(document.querySelector('.up-one-level-btn').classList).not.toContain('acrylic-btn')
    expect(wrapper.vm.state.currentFolderId).toBe('f-setup')
  })

  it('the save dialog draws the shared plate in a folder, and nothing at the root', async () => {
    await mountSaveDialog({ atRoot: true })
    expect(plates()).toHaveLength(0)

    document.body.innerHTML = ''
    await mountSaveDialog({ atRoot: false })
    expect(plates()).toHaveLength(1)
  })

  it('goes up to the parent folder in the File Manager, and to the root from one level down', async () => {
    const wrapper = await mountFileManager({ atRoot: false })

    await document.querySelector('.up-one-level-btn').click()
    await flushPromises()
    // -> `/docs/setup` -> `/docs`, resolved out of the tree map rather than out of a parent field
    expect(wrapper.vm.state.currentFolderId).toBe('f-docs')

    await document.querySelector('.up-one-level-btn').click()
    await flushPromises()
    // -> `/docs` -> the root, which is `null` here and NOT a failed lookup. The plate itself is
    //    asserted absent by mounting AT the root above, rather than here: a real leave transition
    //    keeps the element around until a `transitionend` no DOM emulator ever fires.
    expect(wrapper.vm.state.currentFolderId).toBeNull()
  })

  it('goes up to the parent folder in the save dialog without touching the path field', async () => {
    const wrapper = await mountSaveDialog({ atRoot: false })
    wrapper.vm.state.title = 'Install guide'
    await flushPromises()
    const pathBefore = wrapper.vm.state.path

    await document.querySelector('.up-one-level-btn').click()
    await flushPromises()

    expect(wrapper.vm.state.currentFolderId).toBe('f-docs')
    // -> `e2e/helpers/admin.js#savePage` drives the path field's auto-slug-until-focused behaviour;
    //    moving WHERE a page is saved must not disturb WHAT it is called or whether the field is dirty
    expect(wrapper.vm.state.path).toBe(pathBefore)
    expect(wrapper.vm.state.pathDirty).toBe(false)
  })
})

/**
 * The measured half. `{ skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT }` so a `npm run test` after a plain `npm ci` reports
 * these as skipped rather than failing on a missing browser binary -- `npm run install-browsers`
 * fetches it, once per machine.
 */
describe('UpOneLevelBtn real layout', { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT }, () => {
  let browser
  let appCss

  beforeAll(async () => {
    browser = await chromium.launch()
    appCss = await buildAppCss()
  }, 120000)

  afterAll(async () => {
    await browser?.close()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  /**
   * Every `<style>` the SFCs under test injected into this test document.
   *
   * `buildAppCss()` compiles `css/tailwind.css` alone, which carries the utilities and the theme
   * tokens but none of a component's own block -- and the clipping this test exists to check comes
   * from component CSS (`overflow: hidden` on the browser column, the toolbar, the animated slot).
   * Shipping both to the page is what keeps the measurement real rather than vacuous. Vitest injects
   * these at import time (`test.css: true` in `vitest.config.js`), scope hashes and all, matching the
   * `data-v-*` attributes the serialized markup carries.
   */
  function componentCss() {
    return [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
  }

  /**
   * Lays the real mounted markup out in Chromium, tabs to the plate, and reports what the browser
   * actually computed for it.
   */
  async function measurePlate(html) {
    const page = await browser.newPage()
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${appCss}</style><style>${componentCss()}</style></head>` +
          `<body class="body--light">${html}</body></html>`
      )
      // -> Reached by keyboard, which is also what makes `:focus-visible` match: a programmatic
      //    `focus()` does not, and the ring only exists in that state.
      let focused = false
      for (let i = 0; i < 60 && !focused; i++) {
        await page.keyboard.press('Tab')
        focused = await page.evaluate(() =>
          Boolean(document.activeElement?.classList?.contains('up-one-level-btn'))
        )
      }
      return await page.evaluate((reachedByKeyboard) => {
        const el = document.querySelector('.up-one-level-btn')
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)

        // -> The nearest ancestor that would cut the ring off, whichever axis it clips on
        let clip = null
        for (let node = el.parentElement; node; node = node.parentElement) {
          const s = getComputedStyle(node)
          if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
            const r = node.getBoundingClientRect()
            clip = { tag: node.className, x: r.x, y: r.y, right: r.right, bottom: r.bottom }
            break
          }
        }

        return {
          reachedByKeyboard,
          focusVisible: el.matches(':focus-visible'),
          width: rect.width,
          height: rect.height,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
          outlineStyle: style.outlineStyle,
          outlineColor: style.outlineColor,
          glyphOpacity: getComputedStyle(el.querySelector('.w-icon')).opacity,
          ring: {
            x: rect.x - 4,
            y: rect.y - 4,
            right: rect.right + 4,
            bottom: rect.bottom + 4
          },
          clip
        }
      }, focused)
    } finally {
      await page.close()
    }
  }

  /**
   * Everything the mount put on the page, teleported dialogs and menus included -- with the
   * transition's transient classes taken back off first.
   *
   * Vue drops `*-enter-from`/`*-enter-active` on the next frame and again on `transitionend`, and a
   * DOM emulator fires neither, so anything mounted already-showing serializes mid-enter and would
   * be measured at the animation's FIRST frame rather than at rest. Both transitions in play here
   * distort the measurement, in different ways and by different amounts: the slot's own leaves it
   * `width: 0` and `overflow: hidden` (so the plate reads as sitting outside its own clipping
   * footprint), and `w-dialog`'s scales the whole card, which `getBoundingClientRect` folds into
   * every rect inside it -- a 28px plate measuring 26.32px is the scale, not the plate. Stripping
   * every transition's transient classes is the emulator's missing half, not a workaround for
   * anything a browser does.
   */
  const TRANSIENT_TRANSITION_CLASS = /-enter-(from|active|to)$/

  function restingBodyMarkup() {
    for (const el of document.querySelectorAll('[class*="-enter-"]')) {
      // -> Collected before any removal: `classList` is live, and dropping from it mid-iteration
      //    skips the entry that shuffles into the freed index
      const transient = el.className.split(/\s+/).filter((n) => TRANSIENT_TRANSITION_CLASS.test(n))
      el.classList.remove(...transient)
    }
    return document.body.innerHTML
  }

  const CALL_SITES = [
    ['the Browse panel header', async () => (await mountBrowseMenu(), restingBodyMarkup())],
    ['the File Manager toolbar', async () => (await mountFileManager(), restingBodyMarkup())],
    ['the save dialog folder row', async () => (await mountSaveDialog(), restingBodyMarkup())]
  ]

  it.each(CALL_SITES)('draws a 28px square plate in %s', async (_name, markup) => {
    const measured = await measurePlate(await markup())

    expect(measured.width).toBeCloseTo(28, 1)
    expect(measured.height).toBeCloseTo(28, 1)
  })

  it.each(CALL_SITES)('keeps the focus ring 2px clear and unclipped in %s', async (_n, markup) => {
    const measured = await measurePlate(await markup())

    expect(measured.reachedByKeyboard).toBe(true)
    expect(measured.focusVisible).toBe(true)
    expect(measured.outlineStyle).not.toBe('none')
    expect(measured.outlineWidth).toBe('2px')
    // -> "2px clear of the plate": the offset, not the width. Both have to be right for the gap.
    expect(measured.outlineOffset).toBe('2px')
    // -> The Cardinal accent (`--color-accent`, #c14a52), not WBtn's inherited `currentColor`
    expect(measured.outlineColor).toBe('rgb(193, 74, 82)')

    // -> The whole ring box, not the plate: an ancestor that clips 2px inside the plate's own edge
    //    would still contain the plate and eat the ring, which is the failure this asserts against.
    if (measured.clip) {
      expect(measured.ring.x).toBeGreaterThanOrEqual(measured.clip.x)
      expect(measured.ring.y).toBeGreaterThanOrEqual(measured.clip.y)
      expect(measured.ring.right).toBeLessThanOrEqual(measured.clip.right)
      expect(measured.ring.bottom).toBeLessThanOrEqual(measured.clip.bottom)
    }
  })

  it('dims the glyph at rest, at the same 70% everywhere', async () => {
    await mountBrowseMenu()
    const measured = await measurePlate(restingBodyMarkup())

    expect(measured.glyphOpacity).toBe('0.7')
  })
})
