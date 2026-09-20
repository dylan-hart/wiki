/**
 * A block or a table written inside a fence is a code sample showing what one looks like, not one to
 * offer an editor for, so the readers of a page's own source walk their lines through here.
 */

/** The opening or closing line of a fenced block, indented up to the three spaces markdown allows. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * A fence closes only on the same character it opened with, and only on a run at least as long —
 * which is what lets a ```` ```` ```` block hold a ``` ``` ``` one.
 *
 * @param {(line: string, index: number) => number|void} visit Return the index of the last line
 *   consumed to resume after it; return nothing to carry on with the next line.
 */
export function linesOutsideFences(lines, visit) {
  let fence = null

  for (let index = 0; index < lines.length; index++) {
    const edge = FENCE.exec(lines[index])
    if (fence) {
      if (edge && edge[1][0] === fence[0] && edge[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (edge) {
      fence = edge[1]
      continue
    }

    const resumeAt = visit(lines[index], index)
    if (typeof resumeAt === 'number') {
      index = resumeAt
    }
  }
}
