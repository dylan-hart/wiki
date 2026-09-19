import { CustomError } from '../helpers/common.ts'

/**
 * An agent has no `render` argument to retry with and no docs page to fall back on, so the two
 * refusals `ensureCanRender()` (`models/renderQueue.ts`) raises get a concrete next step appended.
 * `null` leaves any other error to the caller's generic handling.
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
