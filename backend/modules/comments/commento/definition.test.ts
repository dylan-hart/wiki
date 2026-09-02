import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

/**
 * Task 643 (Feature 396): scaffolds `definition.yml` only — no `comments.ts` sibling. Commento is
 * pure client-side embed configuration (an instance URL passed to Commento's own script), so unlike
 * the `default` provider there is no server-side render/spam/rate-limit logic to implement here.
 *
 * Fields ported verbatim from 2.5.x's `server/modules/comments/commento/definition.yml`.
 */
describe('modules/comments/commento definition.yml', () => {
  it('declares the top-level module metadata', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    assert.equal(parsed.key, 'commento')
    assert.equal(parsed.title, 'Commento')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.author, 'requarks.io')
    assert.equal(parsed.logo, 'https://static.requarks.io/logo/commento.svg')
    assert.equal(parsed.website, 'https://commento.io/')
    assert.equal(parsed.codeTemplate, true)
    // -> OpenProject #1958: marked unavailable -- no page-view code renders a codeTemplate provider's
    //    embed, so this fork does not offer it as a live choice. See docs/variances.md.
    assert.equal(parsed.isAvailable, false)
  })

  it('parses and declares exactly the instanceUrl prop', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    const props = parseModuleProps(parsed.props ?? {})
    assert.deepEqual(Object.keys(props), ['instanceUrl'])

    assert.equal(props.instanceUrl.type, 'string')
    assert.equal(props.instanceUrl.default, 'https://cdn.commento.io')
    assert.equal(props.instanceUrl.title, 'Instance URL')
    assert.match(props.instanceUrl.hint, /cloud-hosted/)
    assert.equal(props.instanceUrl.order, 1)
  })

  it('has no comments.ts sibling — this module is scaffold-only for now', async () => {
    const serverPath = path.join(import.meta.dirname, '..', '..', '..')
    await assert.rejects(
      fs.access(path.join(serverPath, 'modules/comments', 'commento', 'comments.ts'))
    )
  })
})
