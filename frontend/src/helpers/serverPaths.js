/**
 * Paths the server owns rather than the page tree.
 *
 * One list, because two different things ask the same question of a URL and must not drift apart:
 * which links the router should keep its hands off (`renderedContent.js`), and which image sources
 * are already pointing at a file rather than at something to resolve (`renderers/markdown.js`).
 */
export const SERVER_PATHS = [
  '/_assets/',
  '/_api/',
  '/_blocks/',
  '/_files/',
  '/_icons/',
  '/_site/',
  '/_thumb/',
  '/_user/'
]

/** `path` must be root-relative: this is a prefix test, not a URL parse. */
export function isServerPath(path) {
  return SERVER_PATHS.some((prefix) => path.startsWith(prefix))
}
