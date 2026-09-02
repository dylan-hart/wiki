import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

/**
 * Task 643 (Feature 396): scaffolds `definition.yml` only — no `comments.ts` sibling. Disqus is
 * pure client-side embed configuration (a shortname passed to Disqus's own script), so unlike the
 * `default` provider there is no server-side render/spam/rate-limit logic to implement here.
 *
 * Fields ported verbatim from 2.5.x's `server/modules/comments/disqus/definition.yml`.
 */
describe('modules/comments/disqus definition.yml', () => {
  it('declares the top-level module metadata', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    assert.equal(parsed.key, 'disqus')
    assert.equal(parsed.title, 'Disqus')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.author, 'requarks.io')
    assert.equal(parsed.logo, 'https://static.requarks.io/logo/disqus.svg')
    assert.equal(parsed.website, 'https://disqus.com/')
    assert.equal(parsed.codeTemplate, true)
    // -> OpenProject #1958: marked unavailable -- no page-view code renders a codeTemplate provider's
    //    embed, so this fork does not offer it as a live choice. See docs/variances.md.
    assert.equal(parsed.isAvailable, false)
  })

  it('parses and declares exactly the accountName prop', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    const props = parseModuleProps(parsed.props ?? {})
    assert.deepEqual(Object.keys(props), ['accountName'])

    assert.equal(props.accountName.type, 'string')
    assert.equal(props.accountName.default, '')
    assert.equal(props.accountName.title, 'Shortname')
    assert.equal(props.accountName.hint, 'Unique identifier from Disqus to identify your website')
    assert.equal(props.accountName.order, 1)
  })

  it('has no comments.ts sibling — this module is scaffold-only for now', async () => {
    const serverPath = path.join(import.meta.dirname, '..', '..', '..')
    await assert.rejects(
      fs.access(path.join(serverPath, 'modules/comments', 'disqus', 'comments.ts'))
    )
  })
})
