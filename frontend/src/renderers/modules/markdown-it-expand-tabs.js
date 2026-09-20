/**
 * Expands leading tabs in fenced code blocks to `opts.tabWidth` spaces each. "Leading" is exact, not
 * "any tab in the block": the scan stops at a line's first non-tab character, so a tab appearing
 * later in the same line is left untouched.
 *
 * @param {import('markdown-it')} md
 * @param {{ tabWidth?: number }} [opts] an explicit `0` is honored, not treated as "unset"
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

  while (idx > -1 && idx < content.length) {
    while (content[idx] === '\t') {
      content = content.slice(0, idx) + ' '.repeat(tabWidth) + content.slice(idx + 1)
      idx += tabWidth
    }
    idx = content.indexOf('\n', idx)

    if (idx === -1) {
      break
    }
    idx += 1
  }

  return content
}
