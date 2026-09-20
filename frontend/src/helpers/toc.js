/**
 * `minDepth`/`maxDepth` are heading levels, never tree positions: `H1 → H2` shows `h1` and `h2` and
 * nothing else, so an `h3` written straight under an `h1` is still out of range.
 *
 * `depth` is rebased on the shallowest level that survived, so a page whose headings start at `h2`
 * opens at the list's top tier rather than spending one on a level it never uses.
 *
 * @param {Array<{ key: string, label: string, level: number, children?: Array }>} nodes
 * @param {object} [opts]
 * @param {number} [opts.minDepth] Shallowest heading level to include, from 1.
 * @param {number} [opts.maxDepth] Deepest heading level to include, from 1.
 * @returns {Array<{ key: string, label: string, depth: number }>} Rows, in document order.
 */
export function flattenToc(nodes, { minDepth = 1, maxDepth = 2 } = {}) {
  const included = []

  // -> Walk every node, shown or not: a heading outside the range can still hold ones that are in it
  const walk = (level) => {
    for (const node of level) {
      if (node.level >= minDepth && node.level <= maxDepth) {
        included.push(node)
      }
      if (node.children?.length) {
        walk(node.children)
      }
    }
  }

  walk(nodes ?? [])
  if (included.length < 1) {
    return []
  }

  const base = Math.min(...included.map((node) => node.level))
  return included.map((node) => ({
    key: node.key,
    label: node.label,
    depth: node.level - base
  }))
}
