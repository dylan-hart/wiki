import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const extensionsDir = path.dirname(fileURLToPath(import.meta.url))

/** An extension as declared by its `definition.yml`, narrowed to what these tests check. */
interface ParsedDefinition {
  title: string
  description: string
}

async function readDefinition(key: string): Promise<ParsedDefinition> {
  const raw = await fs.readFile(path.join(extensionsDir, key, 'definition.yml'), 'utf8')
  return load(raw) as ParsedDefinition
}

// Regression coverage for the scope decision recorded in docs/variances.md (OpenProject task 666,
// Feature 402): puppeteer/definition.yml must describe only what Feature 402 actually built (PDF
// export), not the server-side diagram pre-rendering that was explicitly deferred to task 785. If
// this ever starts failing because someone re-added the diagram-rendering claim, that claim needs
// either a real implementation behind it or to stay out of the description — not a silent revert of
// this decision.
describe('puppeteer extension definition', () => {
  test('promises PDF export', async () => {
    const definition = await readDefinition('puppeteer')
    assert.match(definition.description, /PDF/)
  })

  test('does not promise server-side diagram rendering (deferred, see docs/variances.md)', async () => {
    const definition = await readDefinition('puppeteer')
    assert.doesNotMatch(definition.description, /mermaid/i)
    assert.doesNotMatch(definition.description, /plantuml/i)
    assert.doesNotMatch(definition.description, /diagram/i)
  })
})

describe('pandoc extension definition', () => {
  test('still promises multi-format page import', async () => {
    const definition = await readDefinition('pandoc')
    assert.match(definition.description, /import/i)
  })
})
