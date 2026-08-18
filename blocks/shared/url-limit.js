/**
 * The GET-URL size guard shared by `block-kroki` and `block-plantuml`.
 *
 * Both blocks pack diagram source straight into the request URL -- deflate, then a URL-safe base64
 * alphabet -- with no POST fallback (see `docs/variances.md`'s "Kroki/PlantUML GET-URL transport"
 * entry for why). That transport has no ceiling of its own; a reverse proxy or server in front of the
 * diagram server does. 8,000 characters is comfortably under the most common defaults an author is
 * likely to sit behind (nginx's `large_client_header_buffers` leaves headroom past 8k by default;
 * most CDNs and IIS draw their own line in the same neighbourhood) while still generous for the
 * diagrams this transport is meant for.
 *
 * A diagram whose encoded URL would exceed this is past what GET-encoding can reliably deliver --
 * failing as a broken image with no explanation is the thing this guard exists to prevent. The
 * escape hatch is the Mermaid block (`block-diagram`): it renders entirely client-side, so it has
 * no URL to size-limit in the first place.
 */
export const MAX_DIAGRAM_URL_LENGTH = 8000

/**
 * The message shown in place of a diagram whose encoded URL is over `MAX_DIAGRAM_URL_LENGTH`.
 *
 * @param {number} length - the URL's actual length, for the reader to see how far over it is
 */
export function explainUrlTooLarge(length) {
  return (
    `This diagram is too large to draw: its encoded source is ${length.toLocaleString()} characters, ` +
    `over the ${MAX_DIAGRAM_URL_LENGTH.toLocaleString()}-character limit this block enforces for a ` +
    'GET request (many servers and reverse proxies refuse a URL past a similar length). Simplify the ' +
    'diagram, or, if it can be expressed as one, redraw it with the Mermaid block instead -- it ' +
    'renders entirely in the browser and has no URL-size limit to hit.'
  )
}
