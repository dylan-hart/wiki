import { isServerPath } from '../helpers/serverPaths'
import { FILES_PREFIX } from '../helpers/assets'

/**
 * Where an image in a page should actually load from.
 *
 * A page's source addresses a picture the way a file sitting next to it would -- `photo.png`,
 * `img/photo.png`, `/media/photo.png` -- which is what the same markup means in a repository, and
 * what an author who wrote it elsewhere expects it to mean here. None of those is a URL this server
 * answers: uploaded files live under `/_files/`. So the resolution happens at render time and the
 * source is left holding the path that was written, which is what keeps the file readable on GitHub.
 *
 * Relative is relative to the page's FOLDER, as it would be to a file's directory in a repository, so
 * a picture beside the page is found from a page at any depth. A path that starts at the root means
 * the site root.
 *
 * Only images. A relative LINK is a link to another page and means exactly what it says, so the same
 * treatment would break it -- an image is the one thing that is always a file.
 *
 * Left alone: anything carrying a scheme of its own (`http:`, `data:`, and the `blob:` a pending
 * upload sits behind until the save that uploads it), a protocol-relative URL, a bare fragment, and a
 * path the server already owns -- `/_files/` included, so rendering a render changes nothing.
 *
 * Shared by `markdown.js` (whose own images resolve token by token) and `asciidoc.js` (which has no
 * tokens to walk -- Asciidoctor hands back finished HTML, so it goes through `rewriteHtmlImages`
 * below like markdown's own raw-HTML `<img>` tags do).
 *
 * @param {string} src The source as written.
 * @param {string} pagePath Path of the page being rendered, without a leading slash. The site root
 *                          when it is not known, which is where a render with no page behind it --
 *                          a review, a history entry -- resolves from.
 * @returns {string} The source to render with.
 */
export function fileSrc(src, pagePath = '') {
  const value = (src ?? '').trim()
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return src
  }
  if (isServerPath(value)) {
    return src
  }
  /*
    Resolved with `URL` so that `..`, `.`, a query and a fragment all behave the way they do
    everywhere else, and so that a space in a file name comes out encoded. The origin is a
    placeholder that never survives -- only the path it works out does.
  */
  const folder = pagePath.split('/').slice(0, -1).join('/')
  try {
    const url = new URL(value, `http://page.invalid/${folder ? `${folder}/` : ''}`)
    return `${FILES_PREFIX}${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`
  } catch {
    return src
  }
}

/**
 * An `<img>` written as HTML rather than as markdown, matched on its `src` and nothing else.
 *
 * The whitespace before `src` is what keeps `data-src` -- and any other attribute ending in those
 * three characters -- out of it, since a word boundary alone sits happily after the hyphen.
 */
const HTML_IMAGE_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/**
 * The same resolution, run over a finished HTML string rather than over a token's attributes.
 *
 * markdown-it's own `<img>` tokens are resolved directly (see `markdown.js`'s `image` renderer rule);
 * this is for HTML the renderer never tokenized -- an author's raw HTML in a markdown page, and every
 * `<img>` Asciidoctor produces, since `asciidoc.js` gets back finished HTML with no token stream to
 * walk. Every value it produces has been through `URL`, so quoting it is safe.
 */
export function rewriteHtmlImages(html, pagePath) {
  return html.replace(HTML_IMAGE_SRC, (match, before, quoted, singleQuoted, bare) => {
    const value = quoted ?? singleQuoted ?? bare
    const resolved = fileSrc(value, pagePath)
    return resolved === value ? match : `${before}"${resolved}"`
  })
}
