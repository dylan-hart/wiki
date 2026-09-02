import { CustomError } from '../helpers/common.ts'

/**
 * `ensureCanRender()` (`models/renderQueue.ts`) throws `renderUnsupportedEditor`/`renderPuppeteerMissing`
 * -- via `createPage()`/`updatePage()` (OpenProject #1716) -- when a render-less write can't be safely
 * accepted. `create_page`/`update_page` (`mcp/tools/createPage.ts`, `mcp/tools/updatePage.ts`) already
 * forward `err.message` as an `McpToolError`, but an agent calling either tool has no `render` argument
 * to retry with and no docs page to fall back on the way a REST client does -- so the two named codes
 * get a concrete next step appended, rather than just the bare model message (OpenProject #1720). Any
 * other error is left to the caller's own generic `McpToolError(err.message)` handling.
 */
export function renderRefusalGuidance(err: any): string | null {
  if (!(err instanceof CustomError)) {
    return null
  }
  if (err.name === 'renderUnsupportedEditor') {
    return `${err.message} Retry with editor: 'markdown', the only editor this server can render.`
  }
  if (err.name === 'renderPuppeteerMissing') {
    return `${err.message} Ask an administrator to install the Puppeteer extension, or create/edit the page through the web editor instead, which renders locally in the browser.`
  }
  return null
}
