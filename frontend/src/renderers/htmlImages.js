import { isServerPath } from '../helpers/serverPaths'
import { FILES_PREFIX } from '../helpers/assets'

/**
 * A page's source addresses a picture the way a file sitting next to it would -- `photo.png`,
 * `img/photo.png`, `/media/photo.png` -- which is what the same markup means in a repository. None of
 * those is a URL this server answers (uploaded files live under `/_files/`), so the rewrite happens
 * at render time and the source keeps the path the author wrote, readable wherever else it is read.
 * Relative resolves against the page's FOLDER, root-relative against the site root.
 *
 * Only images. A relative LINK is a link to another page and means exactly what it says, so the same
 * treatment would break it -- an image is the one thing that is always a file.
 *
 * A path the server already owns is left alone, `/_files/` included, so rendering a render is a
 * no-op.
 *
 * @param {string} pagePath Path of the page being rendered, without a leading slash. The site root
 *                          when it is not known, which is where a render with no page behind it --
 *                          a review, a history entry -- resolves from.
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
    `URL` so that `..`, `.`, a query and a fragment behave as they do everywhere else and a space in
    a file name comes out encoded. The origin is a placeholder: only the path it works out is used.
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
 * The required whitespace before `src` is what keeps `data-src` -- and any other attribute ending in
 * those three characters -- out of the match, since a word boundary alone sits happily after a hyphen.
 */
const HTML_IMAGE_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi

/**
 * For HTML the renderer never tokenized -- an author's raw HTML in a markdown page, and every `<img>`
 * Asciidoctor produces, since `asciidoc.js` gets back finished HTML with no token stream to walk.
 * markdown-it's own `<img>` tokens are resolved directly instead (`markdown.js`'s `image` rule).
 * Every value `fileSrc` returns has been through `URL`, so re-quoting it is safe.
 */
export function rewriteHtmlImages(html, pagePath) {
  return html.replace(HTML_IMAGE_SRC, (match, before, quoted, singleQuoted, bare) => {
    const value = quoted ?? singleQuoted ?? bare
    const resolved = fileSrc(value, pagePath)
    return resolved === value ? match : `${before}"${resolved}"`
  })
}
