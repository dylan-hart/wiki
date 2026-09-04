/**
 * Pure-unit coverage for the extraction/diff logic, plus one real-tree assertion that `en.json`'s
 * `blocks.*` namespace has not drifted from the actual `blocks/block-*` sources -- no `WIKI` global,
 * no database, per CLAUDE.md's "Testing (backend)".
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import {
  collectBlockLocaleEntries,
  diffBlockLocaleKeys,
  findVueI18nHazards
} from './blockLocaleKeys.ts'

const REPO_ROOT = path.join(import.meta.dirname, '../..')

/** Builds a throwaway tree of `block-*` directories, each with a `component.js`, returning its root. */
function makeFixtureBlocksDir(components: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-locale-keys-'))
  for (const [blockDir, source] of Object.entries(components)) {
    const full = path.join(dir, blockDir)
    fs.mkdirSync(full, { recursive: true })
    fs.writeFileSync(path.join(full, 'component.js'), source)
  }
  return dir
}

const SAMPLE_COMPONENT = `
import { LitElement } from 'lit'
export class BlockSampleElement extends LitElement {
  static definition = {
    block: 'sample',
    name: 'Sample',
    description: 'A sample block.',
    icon: 'star',
    props: [
      { name: 'url', type: 'string', label: 'URL', hint: 'Where to fetch from.' },
      { name: 'flag', type: 'boolean', label: 'Flag only, no hint.' }
    ]
  }
}
customElements.define('block-sample', BlockSampleElement)
`

describe('collectBlockLocaleEntries', () => {
  it('reads description, label and hint keys off a fixture block definition', () => {
    const dir = makeFixtureBlocksDir({ 'block-sample': SAMPLE_COMPONENT })
    const entries = collectBlockLocaleEntries(dir)
    assert.deepEqual(
      entries.map((e) => e.key),
      [
        'blocks.sample.description',
        'blocks.sample.props.url.label',
        'blocks.sample.props.url.hint',
        'blocks.sample.props.flag.label'
      ]
    )
    assert.equal(
      entries.find((e) => e.key === 'blocks.sample.props.url.hint')?.value,
      'Where to fetch from.'
    )
  })

  it('skips a directory with no component.js and one whose definition has no description', () => {
    const dir = makeFixtureBlocksDir({
      'block-empty': `import { LitElement } from 'lit'
export class E extends LitElement {
  static definition = { block: 'empty', name: 'Empty', icon: 'x' }
}
customElements.define('block-empty', E)
`
    })
    fs.mkdirSync(path.join(dir, 'block-no-source'))
    const entries = collectBlockLocaleEntries(dir)
    assert.deepEqual(entries, [])
  })

  it('throws with the block directory named, when a definition is not plain literals', () => {
    const dir = makeFixtureBlocksDir({
      'block-bad': `import { LitElement } from 'lit'
const computed = 'nope'
export class B extends LitElement {
  static definition = { block: computed, name: 'Bad', description: 'x', icon: 'x' }
}
`
    })
    assert.throws(() => collectBlockLocaleEntries(dir), /block-bad/)
  })

  it('throws naming the block and key when a description has an empty vue-i18n placeholder', () => {
    const dir = makeFixtureBlocksDir({
      'block-hazard': `import { LitElement } from 'lit'
export class H extends LitElement {
  static definition = {
    block: 'hazard',
    name: 'Hazard',
    description: 'Uses a literal command — \\\\ce{} here.',
    icon: 'x'
  }
}
`
    })
    assert.throws(
      () => collectBlockLocaleEntries(dir),
      /block-hazard.*blocks\.hazard\.description/s
    )
  })

  it('throws naming the block and key when a prop hint has unbalanced braces', () => {
    const dir = makeFixtureBlocksDir({
      'block-hazard2': `import { LitElement } from 'lit'
export class H extends LitElement {
  static definition = {
    block: 'hazard2',
    name: 'Hazard2',
    icon: 'x',
    props: [ { name: 'url', type: 'string', label: 'URL', hint: 'Ends with a stray { brace.' } ]
  }
}
`
    })
    assert.throws(
      () => collectBlockLocaleEntries(dir),
      /block-hazard2.*blocks\.hazard2\.props\.url\.hint/s
    )
  })

  it('does not flag a well-formed named interpolation like {url}', () => {
    const dir = makeFixtureBlocksDir({
      'block-ok': `import { LitElement } from 'lit'
export class O extends LitElement {
  static definition = {
    block: 'ok',
    name: 'OK',
    description: 'Fetches content from {url}.',
    icon: 'x'
  }
}
`
    })
    assert.doesNotThrow(() => collectBlockLocaleEntries(dir))
  })
})

describe('findVueI18nHazards', () => {
  it('finds nothing wrong with plain text or a well-formed {identifier} interpolation', () => {
    assert.deepEqual(findVueI18nHazards('A plain description.'), [])
    assert.deepEqual(findVueI18nHazards('Fetches content from {url}.'), [])
  })

  it('flags an empty interpolation placeholder', () => {
    assert.deepEqual(findVueI18nHazards('Uses \\ce{} and \\pu{}.'), ['empty interpolation `{}`'])
  })

  it('flags unbalanced braces', () => {
    assert.deepEqual(findVueI18nHazards('Ends with a stray { brace.'), ['unbalanced `{`/`}`'])
    assert.deepEqual(findVueI18nHazards('Ends with a stray } brace.'), ['unbalanced `{`/`}`'])
  })

  it('flags linked-message @: syntax', () => {
    assert.deepEqual(findVueI18nHazards('See @:common.actions.apply.'), [
      'linked-message `@:` syntax'
    ])
  })

  it('can report more than one hazard on the same string', () => {
    assert.deepEqual(findVueI18nHazards('Bad {} and @:x too'), [
      'empty interpolation `{}`',
      'linked-message `@:` syntax'
    ])
  })
})

describe('diffBlockLocaleKeys', () => {
  const entries = [
    { key: 'blocks.sample.description', value: 'A sample block.', source: 'x' },
    { key: 'blocks.sample.props.url.label', value: 'URL', source: 'x' }
  ]

  it('reports nothing missing and nothing orphaned when en.json already matches', () => {
    const { missing, orphaned } = diffBlockLocaleKeys(entries, {
      'blocks.sample.description': 'A sample block.',
      'blocks.sample.props.url.label': 'URL'
    })
    assert.deepEqual(missing, [])
    assert.deepEqual(orphaned, [])
  })

  it('flags a key with a stale value as missing, not just an absent one', () => {
    const { missing } = diffBlockLocaleKeys(entries, {
      'blocks.sample.description': 'An outdated description.',
      'blocks.sample.props.url.label': 'URL'
    })
    assert.deepEqual(
      missing.map((m) => m.key),
      ['blocks.sample.description']
    )
  })

  it('flags a blocks.* key no current entry asks for as orphaned, leaving other namespaces alone', () => {
    const { orphaned } = diffBlockLocaleKeys(entries, {
      'blocks.sample.description': 'A sample block.',
      'blocks.sample.props.url.label': 'URL',
      'blocks.gone.description': 'A block that no longer exists.',
      'admin.adminArea': 'Administration Area'
    })
    assert.deepEqual(orphaned, ['blocks.gone.description'])
  })

  it('never flags a blocks.<tag>.errors.* key -- that namespace is #1638s, not derived here', () => {
    const { orphaned } = diffBlockLocaleKeys(entries, {
      'blocks.sample.description': 'A sample block.',
      'blocks.sample.props.url.label': 'URL',
      'blocks.youtube.errors.invalidUrl': '{url} is not the address of a YouTube video.'
    })
    assert.deepEqual(orphaned, [])
  })
})

describe('the real blocks/ tree against locales/en.json', () => {
  it('has no drift -- every blocks.* string is minted and none are orphaned', () => {
    const entries = collectBlockLocaleEntries(path.join(REPO_ROOT, 'blocks'))
    const enStrings: Record<string, string> = JSON.parse(
      readFileSync(path.join(import.meta.dirname, '../locales/en.json'), 'utf8')
    )
    const { missing, orphaned } = diffBlockLocaleKeys(entries, enStrings)
    assert.deepEqual(
      missing.map((m) => m.key),
      [],
      'run `npm run block-locale-keys` from backend/ to add these'
    )
    assert.deepEqual(orphaned, [], 'run `npm run block-locale-keys` from backend/ to remove these')
  })
})
