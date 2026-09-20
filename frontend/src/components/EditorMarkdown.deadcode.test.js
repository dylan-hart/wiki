import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Reads the raw source rather than mounting the component: `EditorMarkdown.vue` pulls in Monaco,
 * live-collab and several stores, and a full mount is out of proportion for asserting that some text
 * is simply gone. The names below are pre-Vue-3 event-bus and debugging leftovers, unreferenced by
 * anything, and this is what stops them being quietly reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'EditorMarkdown.vue'), 'utf-8')

describe('EditorMarkdown.vue dead code', () => {
  it('has no notImplemented() helper -- it was defined but never called', () => {
    expect(source).not.toMatch(/notImplemented/)
  })

  it('has no commented-out this.$root.$on(...) block from the pre-Vue-3 event bus', () => {
    expect(source).not.toMatch(/\$root\.\$on/)
    // -> `saveConflict` is deliberately not asserted: it is a real, actively-used identifier
    //    (`editorStore.saveConflict`), not a leftover from the dead event-bus block.
    expect(source).not.toMatch(/editorInsert|overwriteEditorContent/)
  })

  it('has no leftover window.edInstance debugging hook', () => {
    expect(source).not.toMatch(/edInstance/)
  })
})
