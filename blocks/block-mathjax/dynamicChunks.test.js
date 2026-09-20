import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DYNAMIC_CHUNKS } from './dynamicChunks.js'

/*
  `new URL(import.meta.url)` rather than the bare string as the base: jsdom's `URL` silently resolves
  a plain-string `file:` base against its own document URL instead, producing an
  `http://localhost:3000/...` result with no error. A URL instance avoids it.
*/
const DYNAMIC_DIR = fileURLToPath(
  new URL('../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/', new URL(import.meta.url))
)

describe('block-mathjax dynamicChunks', () => {
  it('has exactly one entry per file @mathjax/mathjax-newcm-font ships under svg/dynamic/', () => {
    const shipped = fs
      .readdirSync(DYNAMIC_DIR)
      .filter((name) => name.endsWith('.js'))
      .map((name) => name.slice(0, -'.js'.length))
      .sort()

    expect(Object.keys(DYNAMIC_CHUNKS).sort()).toEqual(shipped)
  })
})
