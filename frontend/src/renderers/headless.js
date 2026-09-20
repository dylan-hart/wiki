/**
 * The server cannot render markdown -- the pipeline lives here, in the browser, and a second
 * implementation would drift from what the editor preview shows. A server-side re-render therefore
 * drives a real browser: Puppeteer loads the `/_render` shell, which loads this bundle and calls
 * `__wikiRender`.
 *
 * Built to a fixed filename (`_assets/renderer.js`, see `vite.config.js`): the backend references it
 * from a static page and cannot resolve a hashed one.
 */
import { MarkdownRenderer } from './markdown'

/**
 * @param {object} context `pagePath`, which a relative image resolves against, and `siteOrigin`,
 *                         which only this caller passes: a headless browser's `location` is its own
 *                         loopback address, never the site's -- see `markdown.js#isExternalHref`.
 */
window.__wikiRender = function (content, config = {}, context = {}) {
  const renderer = new MarkdownRenderer(config)
  return renderer.render(content ?? '', context)
}

// -> Polled by the caller: a module script is deferred, so the page can be "loaded" before this ran
window.__wikiRenderReady = true
