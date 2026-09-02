import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #1663 ("Add `alt` to the 65 alt-less `<img>` elements under `frontend/src`").
 *
 * A screen reader announces a name-less `<img>` by guessing at the file path -- with none of the 65
 * `<img>` elements this fixed carrying `alt`, `:alt`, `aria-hidden` or `role="presentation"`, the
 * header read out `/_site/current/logo` and the account button read out the raw avatar URL. Every
 * one was fixed one of two ways: `alt=""` on a purely decorative image (a page-header icon, a
 * dashboard card icon, an empty-state illustration) that sits beside text already saying what it
 * shows, or a meaningful `:alt` on one that is the only thing conveying its own name (a site logo, a
 * user avatar, an uploaded asset preview, an auth strategy logo).
 *
 * This is a source-level regression test in the same style as `css/_page-contents.test.js` -- a
 * plain source scan rather than mounting every one of these components, since what is being pinned
 * down is a textual property of the template markup itself (every `<img>` carries SOME name-giving
 * attribute), not any rendered behaviour. It walks every `.vue` file under `src/`, looks only inside
 * each file's `<template>` block (a `<script>`-side string or comment mentioning `<img>` is not a
 * rendered element), strips HTML comments the same way `_page-contents.test.js` strips nothing else
 * needs stripping, and asserts every `<img>` tag it finds carries `alt=`, `:alt=`, `aria-hidden` or
 * `role="presentation"`.
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
    // -> A canary against `findVueFiles` silently walking the wrong directory (e.g. an empty one),
    //    which would otherwise make every case below vacuously pass.
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
