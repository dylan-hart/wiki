import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `frontend/src/helpers/blocks.js#blockMarkdown()` already wraps `definition.template` in its own
 * `::block-<name>{…}` / `::` fence, so a template that opens with its *own* block's fence is always
 * a bug: it ends up nested one level inside an identical outer block, invisible at read time (most
 * blocks have no `<slot>` into their light DOM) while stealing whatever the outer block reads out
 * of that light DOM.
 */

const blockDirNames = readdirSync(import.meta.dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('block-'))
  .map((entry) => entry.name)
  .sort()

/**
 * Evaluates the `static definition = { … }` literal's source text rather than importing the module:
 * several blocks pull in rendering libraries that touch browser APIs jsdom lacks at import time,
 * none of which this check needs. Every value in the literal is a plain literal by convention, so a
 * quote-aware, brace-matched slice is safe.
 *
 * Comments are skipped outright rather than left to the quote tracker: an apostrophe in one (a
 * contraction) would read as opening a string and desync the scan from there on.
 */
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

describe('block definition templates', () => {
  for (const dirName of blockDirNames) {
    it(`${dirName}'s template does not nest its own block opener`, () => {
      const source = readFileSync(path.join(import.meta.dirname, dirName, 'component.js'), 'utf8')
      const definition = readDefinition(source)

      expect(definition, `${dirName}/component.js has no static definition object`).not.toBeNull()

      const template = definition.template ?? ''
      const selfOpener = new RegExp(`(^|\\n)\\s*:::?block-${definition.block}\\b`)

      expect(template).not.toMatch(selfOpener)
    })
  }
})

/** The same shape `frontend/scripts/generate-icons.mjs` matches, minus its surrounding quotes. */
const ICONIFY_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:[-.][a-z0-9]+)*$/

/**
 * `definition.icon` reaches `WIcon` unchanged, and `WIcon` draws nothing at all for a name that is
 * not an Iconify reference — a bare `todo-list` renders an empty slot rather than failing anywhere.
 */
describe('block definition icons', () => {
  for (const dirName of blockDirNames) {
    it(`${dirName} declares an Iconify icon reference`, () => {
      const source = readFileSync(path.join(import.meta.dirname, dirName, 'component.js'), 'utf8')
      const definition = readDefinition(source)

      expect(definition, `${dirName}/component.js has no static definition object`).not.toBeNull()
      expect(
        definition.icon,
        `${dirName}'s icon must be an Iconify reference like 'tabler:sitemap', not '${definition.icon}'`
      ).toMatch(ICONIFY_REF)
    })
  }
})
