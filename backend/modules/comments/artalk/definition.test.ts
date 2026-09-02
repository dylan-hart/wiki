import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'

/**
 * Task 643 (Feature 396): scaffolds `definition.yml` only — no `comments.ts` sibling. Artalk is
 * pure client-side embed configuration (a backend URL and site name passed to Artalk's own script),
 * so unlike the `default` provider there is no server-side render/spam/rate-limit logic to implement
 * here.
 *
 * Fields ported verbatim from 2.5.x's `server/modules/comments/artalk/definition.yml`.
 */
describe('modules/comments/artalk definition.yml', () => {
  it('declares the top-level module metadata', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    assert.equal(parsed.key, 'artalk')
    assert.equal(parsed.title, 'Artalk')
    assert.equal(typeof parsed.description, 'string')
    assert.ok(parsed.description.length > 0)
    assert.equal(parsed.author, 'CDN18')
    assert.equal(parsed.logo, 'https://static.requarks.io/logo/artalk.png')
    assert.equal(parsed.website, 'https://artalk.js.org')
    assert.equal(parsed.codeTemplate, true)
    // -> OpenProject #1958: marked unavailable -- no page-view code renders a codeTemplate provider's
    //    embed, so this fork does not offer it as a live choice. See docs/variances.md.
    assert.equal(parsed.isAvailable, false)
  })

  it('parses and declares exactly the server and siteName props', async () => {
    const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>

    const props = parseModuleProps(parsed.props ?? {})
    assert.deepEqual(Object.keys(props).sort(), ['server', 'siteName'])

    assert.equal(props.server.type, 'string')
    assert.equal(props.server.default, '')
    assert.equal(props.server.title, 'Artalk Backend URL')
    assert.match(props.server.hint, /publicly accessible/i)
    assert.equal(props.server.order, 1)
    // -> maxWidth is verbatim from 2.5.x but parseModuleProps() does not carry unknown fields onto
    //    the resolved ModuleProp — asserted against the raw declaration instead, not the parsed one.
    assert.equal((parsed.props.server as Record<string, any>).maxWidth, 650)

    assert.equal(props.siteName.type, 'string')
    assert.equal(props.siteName.default, '')
    assert.equal(props.siteName.title, 'Site Name')
    assert.equal(props.siteName.order, 2)
    assert.equal((parsed.props.siteName as Record<string, any>).maxWidth, 450)
  })

  it('has no comments.ts sibling — this module is scaffold-only for now', async () => {
    const serverPath = path.join(import.meta.dirname, '..', '..', '..')
    await assert.rejects(
      fs.access(path.join(serverPath, 'modules/comments', 'artalk', 'comments.ts'))
    )
  })
})
