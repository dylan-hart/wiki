import { readFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * Nothing compiles Sass in this build, so Sass-only syntax that survives in a stylesheet is
 * invalid plain CSS: the browser drops the declaration or rule without any error. oxlint does not
 * parse `<style>` blocks and no stylelint is installed, so this source scan is the guard.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

const RULES = [
  { name: '`#{...}` interpolation', pattern: /#\{/ },
  { name: '`rgba(#hex, alpha)` colour', pattern: /rgba?\(\s*#/ },
  { name: '`&--x` / `&__x` / `&-x` suffix concatenation', pattern: /&(?:--|__|-[A-Za-z])/ }
]

// Blanked rather than removed so a hit's line number still matches the file.
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

function styleBlocks(file, source) {
  if (file.endsWith('.css')) return [{ css: source, offset: 0 }]
  const blocks = []
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    const start = match.index + match[0].indexOf('>') + 1
    blocks.push({ css: match[1], offset: source.slice(0, start).split('\n').length - 1 })
  }
  return blocks
}

export function findSassSyntax(file, source) {
  const hits = []
  for (const { css, offset } of styleBlocks(file, source)) {
    blankComments(css)
      .split('\n')
      .forEach((line, index) => {
        for (const { name, pattern } of RULES) {
          if (pattern.test(line)) {
            hits.push(`${file}:${offset + index + 1}: ${name}: ${line.trim()}`)
          }
        }
      })
  }
  return hits
}

describe('findSassSyntax (the scanner itself)', () => {
  it('flags each Sass-only construct inside a .vue <style> block', () => {
    const source = [
      '<template><div /></template>',
      '<style>',
      '.a {',
      '  --x: #{var(--y)};',
      '  border: 1px solid rgba(#fff, 0.08);',
      '  &--over { color: red; }',
      '  &__icon { color: red; }',
      '}',
      '</style>'
    ].join('\n')
    const hits = findSassSyntax('a.vue', source)
    expect(hits).toHaveLength(4)
    expect(hits[0]).toContain('a.vue:4:')
  })

  it('flags a plain .css file', () => {
    expect(findSassSyntax('a.css', '.a {\n  &--b { color: red; }\n}')).toHaveLength(1)
  })

  it('ignores comments, script, template and valid nesting', () => {
    const source = [
      '<template><div class="a--b" /></template>',
      '<script>const s = `#{x}`; const t = "&--y"</script>',
      '<style>',
      '/* `&--over` and `#{x}` and rgba(#fff, 1) are Sass */',
      '.a {',
      '  color: rgb(255 255 255 / 8%);',
      '  & .b { color: red; }',
      '  .body--dark & { color: red; }',
      '  &:hover { color: red; }',
      '  &.is-x { color: red; }',
      '}',
      '</style>'
    ].join('\n')
    expect(findSassSyntax('a.vue', source)).toEqual([])
  })
})

describe('no Sass-only syntax remains in frontend/src stylesheets', () => {
  const files = listSourceFiles(SRC_ROOT, { ext: ['.vue', '.css'] })

  it('has at least one file to check (scan is not silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('finds no `#{`, `rgba(#`, or `&--`/`&__` suffix nesting in a <style> block or .css file', () => {
    const offenders = files.flatMap((file) =>
      findSassSyntax(relative(SRC_ROOT, file), readFileSync(file, 'utf-8'))
    )
    expect(offenders).toEqual([])
  })
})
