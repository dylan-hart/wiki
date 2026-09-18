/**
 * Test-only: every block's own `static definition`, read straight out of each `blocks/block-<name>`
 * directory's `component.js` source text rather than imported -- the same reason
 * `blocks/definitions.test.js` does it this way.
 * Importing every block for real pulls in whatever rendering library each one wraps (mermaid, KaTeX,
 * Leaflet, swagger-ui, pdfjs-dist, …), several of which touch browser APIs happy-dom doesn't implement
 * at module scope; none of that has any bearing on a markdown round-trip, which only ever reads
 * `definition.block`/`.template`/`.props`. `blocks/` is a separate, independently-installed workspace
 * from `frontend/` (root `CLAUDE.md`'s workspace table) with no dependency this one could import
 * through even if it wanted to, so this is a deliberate duplicate of `readDefinition()` rather than a
 * shared import -- see that file's own doc comment for the quote/comment-aware brace matching this
 * mirrors.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const BLOCKS_DIR = path.join(import.meta.dirname, '../../../../blocks')

function readDefinition(source) {
  const marker = 'static definition ='
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  const braceStart = source.indexOf('{', markerIndex)
  let depth = 0
  let quote = null
  let end = -1
  for (let i = braceStart; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === '\\') {
        i++
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i)
      i = lineEnd === -1 ? source.length : lineEnd
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      const commentEnd = source.indexOf('*/', i + 2)
      i = commentEnd === -1 ? source.length : commentEnd + 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) {
    return null
  }
  const literal = source.slice(braceStart, end)
  return new Function(`return (${literal})`)()
}

/**
 * Every block under `blocks/block-*`, as its own `static definition` object -- `{ block, name,
 * props?, template? }` -- keyed by directory name and sorted the same way `blocks/definitions.test.js`
 * sorts them, so a new block picked up by both suites lands in the same relative place in each.
 *
 * @returns {Array<{ dirName: string, definition: object }>}
 */
export function readAllBlockDefinitions() {
  const blockDirNames = readdirSync(BLOCKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('block-'))
    .map((entry) => entry.name)
    .sort()

  return blockDirNames.map((dirName) => {
    const source = readFileSync(path.join(BLOCKS_DIR, dirName, 'component.js'), 'utf8')
    const definition = readDefinition(source)
    if (!definition) {
      throw new Error(`${dirName}/component.js has no static definition object`)
    }
    return { dirName, definition }
  })
}
