import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nextTick, reactive, ref } from 'vue'

import { deriveDisplayName, useDerivedDisplayName } from './displayName.js'

/**
 * Feature #2608, Task #2642.
 *
 * `deriveDisplayName` has to agree, character for character, with
 * `backend/models/users.ts#deriveDisplayName` -- the server compares a submitted `name` against its
 * own derivation to decide whether the name is hand-authored, so any divergence here authors
 * accounts nobody meant to author.
 *
 * `useDerivedDisplayName` is what keeps a form's display-name field current while the reader edits a
 * half. It reads and writes plain reactive fields rather than owning any state of its own, so it is
 * exercised directly against a `reactive({...})` rather than through a mounted component; the two
 * surfaces that use it (`ProfileInfo.vue`, `UserEditOverlay.vue`) have their own suites for the
 * rendered behaviour.
 */
describe('deriveDisplayName', () => {
  it('joins the two halves with a single space', () => {
    expect(deriveDisplayName('Ada', 'Lovelace')).toBe('Ada Lovelace')
  })

  it('derives a mononym from the first name alone, with no trailing space', () => {
    expect(deriveDisplayName('Prince', '')).toBe('Prince')
  })

  it('handles a first name that is missing, without leaving a leading space', () => {
    expect(deriveDisplayName('', 'Lovelace')).toBe('Lovelace')
  })

  it('answers an empty string when neither half is there', () => {
    expect(deriveDisplayName('', '')).toBe('')
    expect(deriveDisplayName(undefined, undefined)).toBe('')
  })
})

function makeFields(overrides = {}) {
  return reactive({ name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', ...overrides })
}

describe('useDerivedDisplayName', () => {
  it('starts unauthored when the stored name is what the halves derive to', () => {
    const fields = makeFields()
    const { authored, syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    expect(authored.value).toBe(false)
  })

  it('starts authored when the stored name is something else', () => {
    const fields = makeFields({ name: 'Countess Lovelace' })
    const { authored, syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    expect(authored.value).toBe(true)
  })

  it('rewrites the name as a half changes, while it is still derived', async () => {
    const fields = makeFields()
    const { syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.firstName = 'Augusta'
    await nextTick()

    expect(fields.name).toBe('Augusta Lovelace')
  })

  it('leaves an authored name alone as a half changes', async () => {
    const fields = makeFields({ name: 'Countess Lovelace' })
    const { syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.firstName = 'Augusta'
    await nextTick()

    expect(fields.name).toBe('Countess Lovelace')
  })

  it('latches to authored the moment the name is written to something else', async () => {
    const fields = makeFields()
    const { authored, syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.name = 'Countess Lovelace'
    await nextTick()

    expect(authored.value).toBe(true)
  })

  it('resumes deriving when the name is written back to the derived value', async () => {
    const fields = makeFields()
    const { authored, syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.name = 'Countess Lovelace'
    await nextTick()
    fields.name = 'Ada Lovelace'
    await nextTick()

    expect(authored.value).toBe(false)

    fields.lastName = 'King'
    await nextTick()
    expect(fields.name).toBe('Ada King')
  })

  it('does not latch on its own derived write, which would freeze the field after one edit', async () => {
    const fields = makeFields()
    const { authored, syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.firstName = 'Augusta'
    await nextTick()
    expect(authored.value).toBe(false)

    fields.lastName = 'King'
    await nextTick()
    expect(fields.name).toBe('Augusta King')
  })

  it('tracks a mononym: clearing the last name derives the first name alone', async () => {
    const fields = makeFields()
    const { syncFromStored } = useDerivedDisplayName(() => fields)
    syncFromStored()

    fields.lastName = ''
    await nextTick()

    expect(fields.name).toBe('Ada')
  })

  /*
    `UserEditOverlay.vue` loads a record by REPLACING its container (`state.user = user`), so the
    getter is not a convenience -- watchers bound to the object it threw away would silently stop
    firing, which is the failure this covers.
  */
  it('follows a container that is replaced wholesale', async () => {
    const container = ref(makeFields())
    const { syncFromStored } = useDerivedDisplayName(() => container.value)
    syncFromStored()

    container.value = makeFields({ name: 'Grace Hopper', firstName: 'Grace', lastName: 'Hopper' })
    await nextTick()
    syncFromStored()

    container.value.firstName = 'Amazing'
    await nextTick()

    expect(container.value.name).toBe('Amazing Hopper')
  })

  it('tolerates a container that is not there yet', () => {
    const container = ref(null)
    const { authored, syncFromStored } = useDerivedDisplayName(() => container.value)

    expect(() => syncFromStored()).not.toThrow()
    expect(authored.value).toBe(false)
  })
})

/**
 * The one cross-workspace claim in this file, and the reason it is worth a source read rather than a
 * comment: a divergence between the two derivations is silent and permanent. The server decides
 * whether a display name is hand-authored by comparing a submitted `name` against ITS derivation, so
 * a form deriving even slightly differently -- a different separator, a missing trim -- would mark
 * every account it touched as authored, and no later half edit would ever move the name again.
 *
 * Asserted against the backend's source text rather than by importing it: `backend/` is a separate,
 * independently-installed TypeScript workspace with its own `WIKI` global, and pulling one of its
 * modules into a Vitest run would drag that whole boot surface in for a two-line function.
 */
describe('deriveDisplayName agrees with the backend', () => {
  const BACKEND_USERS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../backend/models/users.ts'
  )

  it("composes a name exactly the way models/users.ts's own deriveDisplayName does", () => {
    const source = readFileSync(BACKEND_USERS, 'utf8')

    const body = source.match(
      /export function deriveDisplayName\(firstName: string, lastName: string\): string \{\n\s*return ([^\n]+)\n\}/
    )
    // -> An existence check as well as a value one, so a rename or a signature change fails as
    //    itself rather than quietly retiring the guard.
    expect(body, `deriveDisplayName not found in ${BACKEND_USERS}`).not.toBeNull()
    expect(body[1]).toBe('`${firstName} ${lastName}`.trim()')
  })
})
