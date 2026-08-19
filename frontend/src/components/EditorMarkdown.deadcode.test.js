import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression test for the dead-code survey (OpenProject task 477): a handful of leftovers from the
 * pre-Vue-3 `this.$root.$on`/`$emit` event bus and an ad-hoc debugging hook had survived the
 * migration to the Composition API + mitt `EVENT_BUS`, unreferenced by anything. This reads the raw
 * source rather than mounting the component -- `EditorMarkdown.vue` pulls in Monaco, live-collab and
 * several stores, and a full mount is out of proportion for asserting that some text is simply gone --
 * so it also guards against any of it quietly being reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'EditorMarkdown.vue'), 'utf-8')

describe('EditorMarkdown.vue dead code', () => {
  it('has no notImplemented() helper -- it was defined but never called', () => {
    expect(source).not.toMatch(/notImplemented/)
  })

  it('has no commented-out this.$root.$on(...) block from the pre-Vue-3 event bus', () => {
    expect(source).not.toMatch(/\$root\.\$on/)
    // -> `saveConflict` is deliberately not asserted here: it's since become a real,
    //    actively-used identifier (`editorStore.saveConflict`, the concurrent-edit 409 snapshot),
    //    not a leftover from the dead event-bus block this test guards against.
    expect(source).not.toMatch(/editorInsert|overwriteEditorContent/)
  })

  it('has no leftover window.edInstance debugging hook', () => {
    expect(source).not.toMatch(/edInstance/)
  })
})
