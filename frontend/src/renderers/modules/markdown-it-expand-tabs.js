/**
 * Expands leading tabs in fenced code blocks to spaces, at `opts.tabWidth` (default `2`) spaces per
 * tab. Replaces the abandoned `markdown-it-expand-tabs` package (last published 2018, idle since
 * 2020, and pulling in `lodash.repeat` -- a lodash-family package this codebase otherwise has zero
 * of). Ported 1:1 from that package's 43-line source rather than reinvented, so behavior is
 * unchanged: `String.prototype.repeat` does the one thing it used `lodash.repeat` for.
 *
 * "Leading" is exact, not "any tab in the block": only a tab found at the scan position -- which
 * starts at the very first character of the fence content and, after each line, resumes at the
 * first character of the next line -- is expanded. A run of several tabs at a line's start is
 * expanded one at a time (so a line opening with three tabs becomes three groups of `tabWidth`
 * spaces); the scan stops at that line's first non-tab character and skips ahead to the next `\n`,
 * so a tab appearing later in the same line is left untouched.
 *
 * Only wraps `renderer.rules.fence` -- unfenced content, and anything other than the fence's code
 * content (its info string included), is never touched.
 *
 * @param {import('markdown-it')} md
 * @param {{ tabWidth?: number }} [opts] `tabWidth` clamped to `>= 0` when given; defaults to `2`
 *   when omitted entirely (an explicit `0` is honored, not treated as "unset").
 */
export default function markdownItExpandTabs(md, opts) {
  const tabWidth = opts?.tabWidth === undefined ? 2 : Math.max(0, opts.tabWidth)

  const originalRule = md.renderer.rules.fence
  md.renderer.rules.fence = function (tokens, idx, options, env, slf) {
    tokens[idx].content = expandLeadingTabs(tokens[idx].content, tabWidth)
    return originalRule.call(this, tokens, idx, options, env, slf)
  }
}

function expandLeadingTabs(content, tabWidth) {
  let idx = 0

  // While not at the end of the string: is the character at the current scan position a tab? Yes --
  // replace it with spaces and advance past them. No -- jump to the character after the next newline.
  while (idx > -1 && idx < content.length) {
    while (content[idx] === '\t') {
      content = content.slice(0, idx) + ' '.repeat(tabWidth) + content.slice(idx + 1)
      idx += tabWidth
    }
    idx = content.indexOf('\n', idx)

    // No more newlines -- nothing left to scan.
    if (idx === -1) {
      break
    }
    idx += 1
  }

  return content
}
