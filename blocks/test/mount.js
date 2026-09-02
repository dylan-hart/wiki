import { vi } from 'vitest'

/**
 * The three things every block suite used to re-write for itself.
 *
 * A block has no props to pass and no framework to mount it with: the markdown renderer leaves its
 * content in the LIGHT DOM as the element's children, and the picker's attributes arrive as real
 * HTML attributes. So "mounting" one is always the same five steps -- create the element, give it a
 * body, set what the picker would have set, append it, wait for Lit -- which is why all 26 suites
 * carried their own near-identical `mountX()` (TEST-F8), differing only in which of the body shapes
 * they used and how long they waited afterwards.
 *
 * Helpers only: this file is deliberately NOT named `*.test.js`, so the recursive `.test.js` glob
 * `vitest.config.js` includes never tries to run it as a suite.
 */

/** The site id `stubSiteFetch` answers `/_api/sites/current` with. */
export const TEST_SITE_ID = 'site-1'

/**
 * Appends a block element and waits for it to have rendered.
 *
 * The three body shapes are the three the markdown renderer actually produces, and a call gives at
 * most one of them:
 *
 * - `pre` -- the contents of a fenced code block, exactly as typed (```` ```mermaid ````, ```` ```drawio ````,
 *   a YAML infobox), which the renderer leaves inside a `<pre>` child.
 * - `text` -- an unfenced body, one line per entry (`block-gallery`'s addresses) or a bare formula.
 * - `html` -- markup the renderer leaves behind for a block that reads structure rather than text
 *   (`block-checklist`'s `<ul><li>`).
 *
 * @param {string} tag the custom element name, e.g. `'block-gallery'`
 * @param {object} [options]
 * @param {string} [options.pre] body placed inside a `<pre>` child
 * @param {string} [options.text] body set as `textContent`
 * @param {string} [options.html] body set as `innerHTML`
 * @param {Record<string, unknown>} [options.props] JS properties, the way a saved prop value arrives
 * @param {Record<string, string>} [options.attrs] real HTML attributes, the way the picker writes them
 * @param {Element} [options.parent] where to append, for a block nested inside another one
 *   (`block-include`'s cycle detection climbs its ancestors). Defaults to `document.body`.
 * @param {number | ((el: Element) => Promise<unknown>)} [options.settle] what to wait for beyond the
 *   first render. A number is that many macrotask turns, each followed by another render wait --
 *   enough to drain a chain of awaited `fetch`es however many hops deep it goes, which is what the
 *   six suites with an async `connectedCallback` were each spelling out for themselves. A function
 *   is awaited instead, for a block that exposes its own handle on the work (`el._ready`).
 * @returns {Promise<Element>} the mounted element
 */
export async function mountBlock(tag, { pre, text, html, props, attrs, parent, settle = 0 } = {}) {
  if ([pre, text, html].filter((body) => body !== undefined).length > 1) {
    throw new Error('mountBlock: pass at most one of pre, text or html')
  }

  const el = document.createElement(tag)

  for (const [name, value] of Object.entries(attrs ?? {})) {
    el.setAttribute(name, value)
  }
  if (pre !== undefined) {
    const fence = document.createElement('pre')
    fence.textContent = pre
    el.appendChild(fence)
  }
  if (text !== undefined) {
    el.textContent = text
  }
  if (html !== undefined) {
    el.innerHTML = html
  }
  Object.assign(el, props ?? {})

  ;(parent ?? document.body).appendChild(el)
  // -> `block-tab` is a plain `HTMLElement` with no update cycle at all, so it has no
  //    `updateComplete` to await -- awaiting `undefined` is a resolved turn, which is all it needs
  await el.updateComplete

  if (typeof settle === 'function') {
    await settle(el)
    await el.updateComplete
  } else {
    for (let turn = 0; turn < settle; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await el.updateComplete
    }
  }
  return el
}

/**
 * Clears the page between tests: the blocks that were mounted, and the theme class a dark-mode test
 * left on `<body>`.
 *
 * Every suite cleared the children; the twelve with a dark-mode assertion also cleared the class,
 * and the ones that did not simply had nothing to clear -- so doing both unconditionally is the same
 * afterEach for all of them.
 */
export function resetBlockDom() {
  document.body.replaceChildren()
  document.body.className = ''
}

/**
 * Stubs `fetch` with the `/_api/sites/current` hop every block that talks to the API makes first.
 *
 * A block in page content has no site id of its own (see `blocks/shared/site.js`), so `getSiteId`,
 * `getSiteLocales`, `getCurrentPage`, `getCurrentPageAccess` and `getBlockConfig` all start from
 * that one public route -- which is why four suites each opened with their own `stubFetch` whose
 * first branch was this exact response. Only that branch is shared: what a block asks for AFTER it
 * knows its site is the block's own business, and is what `onRequest` answers.
 *
 * @param {object} [options]
 * @param {object} [options.site] extra fields for the `/_api/sites/current` body, merged over
 *   `{ id: TEST_SITE_ID }` -- `locales` for a block that resolves the reader's locale,
 *   `blocksConfig` for one that reads its site-wide settings.
 * @param {boolean} [options.ok] whether the site lookup itself succeeds, for the "no site could be
 *   resolved" branch every one of these blocks has to degrade into.
 * @param {(url: string, init?: RequestInit) => unknown} [options.onRequest] answers every other
 *   request. Left out, any other request throws, so a call the block was not expected to make
 *   surfaces as a failure rather than as a silent `undefined`.
 * @returns {import('vitest').Mock} the `fetch` mock, for asserting on what was requested
 */
export function stubSiteFetch({ site, ok = true, onRequest } = {}) {
  /*
    Not an `async` function, deliberately: `return onRequest(...)` from one would ADOPT the promise
    an async `onRequest` returns, which costs two extra microtask turns over the single inline
    `async` branch each suite used to have -- enough to break a test that awaits exactly one
    `queueMicrotask` turn after a click. `Promise.resolve` on an existing promise hands back that
    same promise, so a block sees the same number of turns however `onRequest` is written.
  */
  const fetchMock = vi.fn((url, init) => {
    if (url === '/_api/sites/current') {
      return Promise.resolve(
        ok
          ? { ok: true, json: async () => ({ id: TEST_SITE_ID, ...site }) }
          : { ok: false, json: async () => null }
      )
    }
    if (!onRequest) {
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    }
    return Promise.resolve(onRequest(url, init))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
