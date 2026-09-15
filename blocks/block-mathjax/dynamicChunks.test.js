import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DYNAMIC_CHUNKS } from './dynamicChunks.js'

/*
  The installed package's own `svg/dynamic/` directory, not a copy of its file list -- so this fails
  the moment `dynamicChunks.js`'s hand-maintained map drifts from what `@mathjax/mathjax-newcm-font`
  actually ships (a version bump adding, removing or renaming a range), the same shape of guard
  `rolldown.config.mjs`'s `blocksManifest()` runs against block directories.

  `new URL(import.meta.url)` first, rather than handing the string straight to the second `new URL()`
  as its base: jsdom's `URL` (this suite's `environment: 'jsdom'`) silently resolves a plain-string
  `file:` base against its own default document URL instead of the string given, producing an
  `http://localhost:3000/...` result with no error -- passing an actual URL instance avoids it.
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
