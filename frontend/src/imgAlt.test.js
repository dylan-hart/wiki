import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * A screen reader announces a name-less `<img>` by guessing at its file path. A decorative image
 * beside text that already says what it shows takes `alt=""`; one that alone conveys its own name
 * takes a meaningful `:alt`. Only each file's `<template>` block is scanned: a `<script>`-side
 * string mentioning `<img>` is not a rendered element.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url))

function findAltlessImgTags(source) {
  const templateMatch = source.match(/<template[^>]*>([\s\S]*)<\/template>/)
  if (!templateMatch) return []
  const template = templateMatch[1].replace(/<!--[\s\S]*?-->/g, '')
  const tags = template.match(/<img\b[^>]*?\/?>/g) ?? []
  return tags.filter(
    (tag) =>
      !/\balt\s*=/.test(tag) &&
      !/:alt\s*=/.test(tag) &&
      !/aria-hidden/.test(tag) &&
      !/role\s*=\s*"presentation"/.test(tag)
  )
}

describe('every <img> under frontend/src carries a name-giving attribute', () => {
  const vueFiles = listSourceFiles(SRC_DIR, { ext: ['.vue'] })

  it('scans a non-trivial number of .vue files', () => {
    // -> A walk that matched nothing would pass every case below vacuously
    expect(vueFiles.length).toBeGreaterThan(100)
  })

  for (const file of vueFiles) {
    const relPath = file.slice(SRC_DIR.length + 1)
    it(`${relPath} has no <img> lacking alt/:alt/aria-hidden/role="presentation"`, () => {
      const source = readFileSync(file, 'utf-8')
      const offenders = findAltlessImgTags(source)
      expect(offenders).toEqual([])
    })
  }
})
