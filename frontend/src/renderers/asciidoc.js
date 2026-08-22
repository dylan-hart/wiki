import { convert } from 'asciidoctor'

import { rewriteHtmlImages } from './htmlImages'

/**
 * The `asciidoc` editor's render path: AsciiDoc source in, sanitizer-ready HTML out, feeding
 * `pageStore.render` exactly the way `MarkdownRenderer.render` (`markdown.js`) does for the markdown
 * editor -- what `EditorAsciidoc.vue` computes on every change is what `pageSave` sends up, and the
 * server post-processes whichever HTML it receives the same way regardless of which editor produced
 * it (`models/rendering.ts`'s `postProcess` has no editor-specific branch).
 *
 * No token stream to walk the way `markdown.js` resolves an `image` token's `src` -- Asciidoctor hands
 * back finished HTML -- so image resolution runs as a post-process pass over the whole string with the
 * same `rewriteHtmlImages` markdown's own raw-HTML `<img>` tags go through.
 */
export class AsciidocRenderer {
  /**
   * @param {string} src AsciiDoc source.
   * @param {string} [pagePath] Path of the page this source belongs to, without a leading slash. What
   *                            a relative image resolves against -- see `htmlImages.js`'s `fileSrc`.
   */
  async render(src, { pagePath = '' } = {}) {
    const html = await convert(src ?? '', {
      // -> Untrusted authoring content: no filesystem includes, no shelling out, no reading a
      //    `data-uri` image off disk -- the same defense-in-depth `texMathHtml` in `markdown.js`
      //    applies by leaving KaTeX's `trust` option off.
      safe: 'secure',
      // -> A fragment, not a full document: `header_footer` defaults to false, but said so
      //    explicitly, since `EditorAsciidoc.vue` embeds this into the page's own HTML shell.
      header_footer: false,
      // -> Otherwise a document's own `= Title` line vanishes silently instead of becoming an `<h1>`
      //    in the body -- Asciidoctor's default assumes the title is used by the *wrapping* template
      //    (`header_footer: true`'s `<title>`), which this render has none of.
      attributes: { showtitle: true }
    })
    return rewriteHtmlImages(html, pagePath)
  }
}
