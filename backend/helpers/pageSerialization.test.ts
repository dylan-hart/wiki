import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import {
  extensionForContentType,
  injectFrontMatter,
  parseFrontMatter
} from './pageSerialization.ts'

/**
 * `injectFrontMatter` converts a page's `createdAt`/`updatedAt` via `Date#toTemporalInstant()`.
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it — the same environment gap `core/scheduler.test.ts` works around
 * (see its `installFakeTemporal`). `toTemporalInstant` is a `Date.prototype` method rather than a
 * `globalThis.Temporal` member, so it's stubbed directly here instead.
 */
let previousToTemporalInstant: any

before(() => {
  previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
  ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
    const epochMs = this.getTime()
    return {
      toString: ({ smallestUnit }: { smallestUnit?: string } = {}) => {
        const iso = new Date(epochMs).toISOString()
        return smallestUnit === 'second' ? iso.replace(/\.\d{3}Z$/, 'Z') : iso
      }
    }
  }
})

after(() => {
  ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
})

describe('extensionForContentType', () => {
  test('maps markdown to .md', () => {
    assert.equal(extensionForContentType('markdown'), '.md')
  })

  test('maps asciidoc to .adoc', () => {
    assert.equal(extensionForContentType('asciidoc'), '.adoc')
  })

  test('maps html to .html', () => {
    assert.equal(extensionForContentType('html'), '.html')
  })

  test('maps text to a plain-text fallback', () => {
    assert.equal(extensionForContentType('text'), '.txt')
  })

  test('maps redirect to a plain-text fallback', () => {
    assert.equal(extensionForContentType('redirect'), '.txt')
  })

  test('falls back to plain text for an unrecognized contentType', () => {
    assert.equal(extensionForContentType('something-new'), '.txt')
  })
})

describe('injectFrontMatter', () => {
  test('prepends a header with the title and the body follows it', () => {
    const result = injectFrontMatter('# Hello\n\nBody text.', { title: 'Hello Page' })
    assert.match(result, /^---\ntitle: Hello Page\n---\n\n# Hello\n\nBody text\.$/)
  })

  test('includes description and tags when present', () => {
    const result = injectFrontMatter('Body.', {
      title: 'My Page',
      description: 'A short description',
      tags: ['alpha', 'beta']
    })
    const header = result.split('---\n')[1]
    assert.match(header, /title: My Page/)
    assert.match(header, /description: A short description/)
    assert.match(header, /tags:\n\s+- alpha\n\s+- beta/)
  })

  test('omits description and tags when absent or empty', () => {
    const result = injectFrontMatter('Body.', { title: 'My Page', description: '', tags: [] })
    const header = result.split('---\n')[1]
    assert.doesNotMatch(header, /description/)
    assert.doesNotMatch(header, /tags/)
  })

  test('includes formatted dateCreated and dateModified when present', () => {
    const createdAt = new Date('2026-01-01T12:00:00.000Z')
    const updatedAt = new Date('2026-02-01T08:30:00.000Z')
    const result = injectFrontMatter('Body.', { title: 'My Page', createdAt, updatedAt })
    assert.match(result, /dateCreated: ['"]?2026-01-01T12:00:00Z['"]?/)
    assert.match(result, /dateModified: ['"]?2026-02-01T08:30:00Z['"]?/)
  })

  test('treats missing content as an empty body', () => {
    const result = injectFrontMatter(undefined, { title: 'Empty' })
    assert.equal(result, '---\ntitle: Empty\n---\n\n')
  })
})

describe('parseFrontMatter', () => {
  test('round-trips what injectFrontMatter writes', () => {
    const written = injectFrontMatter('# Hello\n\nBody text.', {
      title: 'My Page',
      description: 'A short description',
      tags: ['alpha', 'beta']
    })
    const parsed = parseFrontMatter(written)
    assert.equal(parsed.title, 'My Page')
    assert.equal(parsed.description, 'A short description')
    assert.deepEqual(parsed.tags, ['alpha', 'beta'])
    assert.equal(parsed.content, '# Hello\n\nBody text.')
  })

  test('passes content through unchanged when there is no leading --- block', () => {
    const parsed = parseFrontMatter('# Hello\n\nJust a page, no header.')
    assert.equal(parsed.title, undefined)
    assert.equal(parsed.description, undefined)
    assert.equal(parsed.tags, undefined)
    assert.equal(parsed.content, '# Hello\n\nJust a page, no header.')
  })

  test('omits title/description/tags the header does not carry', () => {
    const parsed = parseFrontMatter('---\ntitle: Only A Title\n---\n\nBody.')
    assert.equal(parsed.title, 'Only A Title')
    assert.equal(parsed.description, undefined)
    assert.equal(parsed.tags, undefined)
    assert.equal(parsed.content, 'Body.')
  })

  test('falls back to the raw text when the header is not valid YAML', () => {
    const raw = '---\ntitle: [unterminated\n---\n\nBody.'
    const parsed = parseFrontMatter(raw)
    assert.equal(parsed.title, undefined)
    assert.equal(parsed.content, raw)
  })

  test('falls back to the raw text when the header parses to a non-object (a bare scalar or list)', () => {
    const raw = '---\n- just\n- a\n- list\n---\n\nBody.'
    const parsed = parseFrontMatter(raw)
    assert.equal(parsed.title, undefined)
    assert.equal(parsed.content, raw)
  })

  test('ignores non-string tags entries', () => {
    const parsed = parseFrontMatter('---\ntitle: T\ntags:\n  - alpha\n  - 42\n---\n\nBody.')
    assert.deepEqual(parsed.tags, ['alpha'])
  })

  test('drops an all-non-string tags list entirely rather than returning an empty array', () => {
    const parsed = parseFrontMatter('---\ntitle: T\ntags:\n  - 1\n  - 2\n---\n\nBody.')
    assert.equal(parsed.tags, undefined)
  })

  test('falls back to the raw text rather than expanding a YAML alias bomb ("billion laughs")', () => {
    // -> A handful of nested anchors, each referencing the previous one nine times: unbounded, this
    //    expands to 9^8 (~43M) leaf elements from a header a few hundred bytes long. `load` is called
    //    with `maxAliases: 0`, so the first `*a0` reference throws before any of that expansion runs.
    const raw =
      '---\n' +
      'a0: &a0 [x,x,x,x,x,x,x,x,x]\n' +
      'a1: &a1 [*a0,*a0,*a0,*a0,*a0,*a0,*a0,*a0,*a0]\n' +
      'a2: &a2 [*a1,*a1,*a1,*a1,*a1,*a1,*a1,*a1,*a1]\n' +
      '---\n\nBody.'
    const parsed = parseFrontMatter(raw)
    assert.equal(parsed.title, undefined)
    assert.equal(parsed.content, raw)
  })
})
