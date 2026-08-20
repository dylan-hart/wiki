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
// Feature 402, later revisited by task 785): puppeteer/definition.yml must describe exactly what is
// actually implemented, no more and no less. PDF export (task 669/670) and Mermaid diagram
// pre-rendering (task 785, `models/diagramRender.ts`) both need this extension; PlantUML rendering
// does not (`DiagramRender` fetches it directly — see that model's class comment), so the
// description must not claim it needs Puppeteer either. If any of these three assertions ever starts
// failing, the claim that changed needs either a real implementation behind it or to stay out of the
// description — not a silent drift from what is true.
describe('puppeteer extension definition', () => {
  test('promises PDF export', async () => {
    const definition = await readDefinition('puppeteer')
    assert.match(definition.description, /PDF/)
  })

  test('promises Mermaid diagram pre-rendering, which genuinely needs this extension', async () => {
    const definition = await readDefinition('puppeteer')
    assert.match(definition.description, /mermaid/i)
  })

  test('does not claim PlantUML needs this extension — it is fetched directly, no browser involved', async () => {
    const definition = await readDefinition('puppeteer')
    assert.doesNotMatch(definition.description, /plantuml/i)
  })
})

describe('pandoc extension definition', () => {
  test('still promises multi-format page import', async () => {
    const definition = await readDefinition('pandoc')
    assert.match(definition.description, /import/i)
  })
})
