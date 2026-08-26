import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { collectMatchers, findUnreferenced } from './check-locales.mjs'

describe('findUnreferenced', () => {
  test('flags a key with no matcher at all', () => {
    const keys = ['admin.dev.title', 'admin.flags.title']
    const matchers = [{ kind: 'exact', value: 'admin.flags.title' }]

    expect(findUnreferenced(keys, matchers)).toEqual(['admin.dev.title'])
  })

  test('credits a key covered by an exact matcher', () => {
    const keys = ['common.actions.save']
    const matchers = [{ kind: 'exact', value: 'common.actions.save' }]

    expect(findUnreferenced(keys, matchers)).toEqual([])
  })

  test('credits a key covered only by a dynamic regex matcher', () => {
    const keys = ['admin.groups.userAlreadyInGroup']
    const matchers = [{ kind: 'regex', value: /^admin\.groups\..*$/ }]

    expect(findUnreferenced(keys, matchers)).toEqual([])
  })

  test('returns every key unreferenced when there are no matchers', () => {
    const keys = ['a.b', 'c.d']

    expect(findUnreferenced(keys, [])).toEqual(['a.b', 'c.d'])
  })
})

describe('collectMatchers', () => {
  test("credits a plain t('literal') call", () => {
    const dir = writeFixture({
      'Widget.vue': `<template>{{ t('admin.flags.title') }}</template>`
    })

    const matchers = collectMatchers(dir)

    expect(findUnreferenced(['admin.flags.title'], matchers)).toEqual([])
  })

  test('credits every key a dynamic template-literal prefix could resolve to', () => {
    const dir = writeFixture({
      'AuditLog.vue': '<script>t(`admin.audit.event.${ev}`)</script>'
    })

    const matchers = collectMatchers(dir)

    expect(
      findUnreferenced(['admin.audit.event.user.created', 'admin.audit.allEvents'], matchers)
    ).toEqual(['admin.audit.allEvents'])
  })

  test('credits a key reached through a lookup-table object passed to t(TABLE[key])', () => {
    const dir = writeFixture({
      'AdminStorage.vue': `<script>
const SYNC_MODE_HINT_KEYS = {
  sync: 'admin.storage.syncDirBiHint',
  push: 'admin.storage.syncDirPushHint'
}
const syncModeHint = computed(() => t(SYNC_MODE_HINT_KEYS[mode] ?? mode))
</script>`
    })

    const matchers = collectMatchers(dir)

    expect(
      findUnreferenced(
        ['admin.storage.syncDirBiHint', 'admin.storage.syncDirPushHint', 'admin.storage.unrelated'],
        matchers
      )
    ).toEqual(['admin.storage.unrelated'])
  })

  test('credits a key reached through a v-for loop variable resolved back to its array', () => {
    const dir = writeFixture({
      'TableEditorOverlay.vue': `<template>
  <div v-for="option of STYLE_CLASSES">{{ t(option.label) }}</div>
</template>
<script>
const STYLE_CLASSES = [{ value: 'a', label: 'editor.tableEditor.styleVerticalMiddle' }]
</script>`
    })

    const matchers = collectMatchers(dir)

    expect(findUnreferenced(['editor.tableEditor.styleVerticalMiddle'], matchers)).toEqual([])
  })

  test('credits a literal <i18n-t keypath> attribute, bound or not', () => {
    const dir = writeFixture({
      'PageDeleteDialog.vue': `<template>
  <i18n-t keypath="pageDeleteDialog.confirm" />
  <i18n-t :keypath="isCopyright ? \`common.footerCopyright\` : \`common.footerLicense\`" />
</template>`
    })

    const matchers = collectMatchers(dir)

    expect(
      findUnreferenced(
        ['pageDeleteDialog.confirm', 'common.footerCopyright', 'common.footerLicense'],
        matchers
      )
    ).toEqual([])
  })

  test('credits every key a string-concatenation key expression could resolve to', () => {
    const dir = writeFixture({
      'AdminScheduler.vue': `<script>
t('admin.scheduler.' + state.displayMode + 'None')
</script>`
    })

    const matchers = collectMatchers(dir)

    expect(
      findUnreferenced(
        ['admin.scheduler.activeNone', 'admin.scheduler.completedNone', 'admin.scheduler.other'],
        matchers
      )
    ).toEqual(['admin.scheduler.other'])
  })

  test('does not mistake API_CLIENT.get(...)/.post(...) for a t() call', () => {
    const dir = writeFixture({
      'store.js': "API_CLIENT.post(`sites/${id}/auth/logout`)\nAPI_CLIENT.get('users')"
    })

    const matchers = collectMatchers(dir)

    // Neither call should credit anything -- a real dead key with a similar shape stays flagged.
    expect(findUnreferenced(['sites.auth.logout'], matchers)).toEqual(['sites.auth.logout'])
  })

  test('credits the i18n.t(...) member-call form used off a global-scope useI18n() instance', () => {
    const dir = writeFixture({
      'App.vue': "<script>i18n.t('editor.unsaved.title')</script>"
    })

    const matchers = collectMatchers(dir)

    expect(findUnreferenced(['editor.unsaved.title'], matchers)).toEqual([])
  })

  test('skips *.test.js fixtures the same way the real scan does', () => {
    const dir = writeFixture({
      'Widget.test.js': "t('admin.flags.title')"
    })

    const matchers = collectMatchers(dir)

    expect(findUnreferenced(['admin.flags.title'], matchers)).toEqual(['admin.flags.title'])
  })
})

// -- fixture helper -----------------------------------------------------------------------------

/** Write `files` (relative-path -> content) into a fresh temp directory and return its path. */
function writeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-locales-test-'))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  return dir
}
