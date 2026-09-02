/**
 * Reading a block's own body -- the light-DOM content markdown left behind under the element.
 */

/**
 * The source an author wrote in the block's body, and whether it came out of a fenced code block.
 *
 * `textContent` rather than `innerHTML` is what undoes the escaping that put `&amp;` and `--&gt;`
 * into the markup, giving back what was actually typed. A `<pre>` wins outright when there is one:
 * inside a fence the text arrives exactly as typed, where an unfenced body has been through
 * markdown's typographer -- quotes rewritten, `_`/`^` read as emphasis, a lone backslash dropped --
 * which is why every block that reads a body reports `fenced` back to the reader when something then
 * fails to parse (see `./figure.js`'s `explainSourceFailure`).
 *
 * @param {Element} el The block element itself.
 * @returns {{ source: string, fenced: boolean }}
 */
export function readFencedSource(el) {
  const fence = el.querySelector('pre')
  return {
    source: ((fence ?? el).textContent ?? '').trim(),
    fenced: Boolean(fence)
  }
}
