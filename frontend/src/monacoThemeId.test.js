import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * Every Monaco-mounting surface registers the same theme pair (`defineMonacoThemes(monaco, …)` in
 * `helpers/monacoTheme.js`) immediately before setting `theme: monacoThemeName(<aesthetic>)`. Two
 * ids rather than one because Monaco takes plain hex and can't resolve a CSS custom property, so the
 * aesthetic switches by swapping themes. Registration happens per-component, not once at boot,
 * because any surface can be first to mount and Monaco's theme registry is global (re-registering is
 * a no-op).
 *
 * The gate exists because an unregistered id fails silently: Monaco falls back to its own light `vs`
 * theme with nothing thrown or logged, and every surface mocks Monaco in its own suite, so only
 * reading the source text catches a missing or mismatched registration.
 *
 * `MONACO_SURFACES` is checked against disk first so a renamed/moved component fails as a missing
 * guard rather than silently shrinking the scan; a new surface needs no edit here since the scan
 * covers the whole tree.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

const THEME_IDS = ['cardinaljs', 'cardinaljs-cobalt']

const MONACO_SURFACES = [
  'components/EditorAsciidoc.vue',
  'components/EditorCode.vue',
  'components/EditorMarkdown.vue',
  'components/GlossaryImportDialog.vue',
  'components/PageSaveConflictDialog.vue',
  'composables/monacoDiff.js',
  'pages/InboxReview.vue'
]

// A registration is the shared helper's call, not a raw `defineTheme`, and a reference is
// `monacoThemeName(...)`, not a quoted id -- matched by call site rather than literal id so the
// two ids stay defined in exactly one place, `helpers/monacoTheme.js`.
const DEFINE_THEME = /\bdefineMonacoThemes\(\s*monaco\b/g
const THEME_OPTION = /\btheme:\s*monacoThemeName\(/g
const RAW_DEFINE = /monaco\.editor\.defineTheme\(/
const RAW_THEME_OPTION = /\btheme:\s*(['"])(cardinaljs[^'"]*)\1/

// One `THEME_IDS` pair per call site matched, not per unique id.
function idsMatching(source, pattern) {
  return [...source.matchAll(pattern)].flatMap(() => THEME_IDS)
}

/** `{ path, registered, referenced }` for every source file under `src/`. */
function scanSourceFiles() {
  return listSourceFiles(SRC_ROOT, { skip: (full) => full.endsWith('.test.js') }).map((file) => {
    const source = readFileSync(file, 'utf-8')
    return {
      path: relative(SRC_ROOT, file).split(sep).join('/'),
      registered: idsMatching(source, DEFINE_THEME),
      referenced: idsMatching(source, THEME_OPTION)
    }
  })
}

describe('the Monaco theme id (OpenProject #2656)', () => {
  const scanned = scanSourceFiles()
  const registering = scanned.filter((file) => file.registered.length > 0)

  it('still has every listed Monaco surface on disk, so a rename cannot silently retire the guard', () => {
    const present = new Set(registering.map((file) => file.path))
    expect(MONACO_SURFACES.filter((path) => !present.has(path))).toEqual([])
  })

  it('finds a theme registration in every listed surface and nowhere unaccounted for', () => {
    // -> A floor, not an exact count: a new surface may register too. Refuses only fewer than the
    //    known seven, which is how a broken regex would otherwise pass vacuously.
    expect(registering.length).toBeGreaterThanOrEqual(MONACO_SURFACES.length)
  })

  describe.each(MONACO_SURFACES)('%s', (path) => {
    const file = () => registering.find((candidate) => candidate.path === path)

    it('registers the theme it goes on to reference', () => {
      const { registered, referenced } = file()
      expect(referenced).not.toEqual([])
      expect([...new Set(referenced)]).toEqual([...new Set(registered)])
    })

    it(`names those themes ${THEME_IDS.join(' and ')}`, () => {
      expect([...new Set(file().registered)]).toEqual(THEME_IDS)
    })

    it('goes through the shared helper rather than naming an id itself', () => {
      const source = readFileSync(join(SRC_ROOT, ...path.split('/')), 'utf-8')
      expect(source, `${path} should register through defineMonacoThemes`).not.toMatch(RAW_DEFINE)
      expect(source, `${path} should reference through monacoThemeName`).not.toMatch(
        RAW_THEME_OPTION
      )
    })
  })

  it('registers the same pair of ids across every surface, since they redefine two shared themes', () => {
    const ids = [...new Set(registering.flatMap((file) => file.registered))]
    expect(ids).toEqual(THEME_IDS)
  })

  it('has no file referencing a Monaco theme it does not register itself', () => {
    const registeredIds = new Set(registering.flatMap((file) => file.registered))
    const orphans = scanned
      .filter((file) => file.registered.length === 0)
      .flatMap((file) =>
        file.referenced.filter((id) => registeredIds.has(id)).map((id) => `${file.path}: ${id}`)
      )
    expect(orphans).toEqual([])
  })

  it('carries no surviving `wikijs` theme id anywhere under src/', () => {
    const survivors = scanned
      .filter((file) =>
        [...file.registered, ...file.referenced].some((id) => id.includes('wikijs'))
      )
      .map((file) => file.path)
    expect(survivors).toEqual([])
  })
})
