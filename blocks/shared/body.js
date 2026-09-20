/**
 * `textContent` rather than `innerHTML` undoes the escaping that put `&amp;` and `--&gt;` into the
 * markup, giving back what was actually typed. A `<pre>` wins outright: inside a fence the text
 * arrives exactly as typed, where an unfenced body has been through markdown's typographer --
 * quotes rewritten, `_`/`^` read as emphasis, a lone backslash dropped. That is why `fenced` is
 * reported back, for a block to pass on when the source then fails to parse.
 *
 * @param {Element} el
 * @returns {{ source: string, fenced: boolean }}
 */
export function readFencedSource(el) {
  const fence = el.querySelector('pre')
  return {
    source: ((fence ?? el).textContent ?? '').trim(),
    fenced: Boolean(fence)
  }
}
