import { convert } from 'asciidoctor'

import { rewriteHtmlImages } from './htmlImages'

export class AsciidocRenderer {
  /**
   * @param {string} [pagePath] Path of the page this source belongs to, without a leading slash --
   *                            what a relative image resolves against.
   */
  async render(src, { pagePath = '' } = {}) {
    const html = await convert(src ?? '', {
      // -> Untrusted authoring content: no filesystem includes, no shelling out, no reading a
      //    `data-uri` image off disk.
      safe: 'secure',
      // -> Already the default, but said so explicitly: the result is embedded into the page's own
      //    HTML shell, never served as a document.
      header_footer: false,
      // -> Otherwise a document's own `= Title` line vanishes silently instead of becoming an `<h1>`
      //    in the body -- Asciidoctor's default assumes the title is used by the *wrapping* template
      //    (`header_footer: true`'s `<title>`), which this render has none of.
      attributes: { showtitle: true }
    })
    return rewriteHtmlImages(html, pagePath)
  }
}
