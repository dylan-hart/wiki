import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

/**
 * Task 441: the admin "Add Strategy" picker renders each module's `icon` as an `<img>` (via
 * `w-icon :name="'img:' + str.icon"` in `frontend/src/pages/AdminAuth.vue`), and the configured-
 * strategy detail panel separately renders `logo`, `color` and `title`. None of that fails loudly --
 * a typo'd `icon` path just draws a blank avatar, not an error, which is exactly what the task asked
 * to guard against for every preset Feature 355 is adding (Auth0, Okta, Microsoft, Keycloak, GitLab,
 * Twitch, Discord, Slack, plus the generic `oidc` / `oauth2` presets).
 *
 * This reads every module's `definition.yml` off disk the same way `models/authentication.ts`'s
 * `refreshStrategiesFromDisk()` does, and asserts `icon` resolves to a real file under
 * `frontend/public` -- what `/_assets/icons/...` is served from -- plus that `logo` and `color` are
 * present and well-formed. A future preset with a typo'd path fails THIS test, rather than shipping
 * as a silently blank row in the picker.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const authModulesDir = __dirname
const frontendPublicDir = path.join(__dirname, '..', '..', '..', 'frontend', 'public')

interface ParsedDefinition {
  key: string
  title?: string
  icon?: string
  logo?: string
  color?: string
  isAvailable?: boolean
}

function loadDefinitions(): ParsedDefinition[] {
  const dirs = readdirSync(authModulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const definitions: ParsedDefinition[] = []
  for (const dir of dirs) {
    const defPath = path.join(authModulesDir, dir, 'definition.yml')
    if (!existsSync(defPath)) {
      continue
    }
    const parsed = load(readFileSync(defPath, 'utf-8')) as Record<string, any>
    if (parsed?.isAvailable !== true) {
      continue
    }
    definitions.push({ ...parsed, key: dir })
  }
  return definitions
}

describe('authentication module preset assets (icon/logo/color)', () => {
  const definitions = loadDefinitions()

  test('discovers every installed, available module (sanity check the fixture is not empty)', () => {
    assert.ok(
      definitions.length >= 12,
      `expected at least 12 available modules (the built-ins plus Feature 355's presets), found ${definitions.length}`
    )
    // -> Every branded preset Task 437-440 were meant to deliver is actually on disk and available
    const keys = definitions.map((d) => d.key)
    for (const expectedKey of [
      'local',
      'oidc',
      'oauth2',
      'auth0',
      'okta',
      'microsoft',
      'keycloak',
      'gitlab',
      'twitch',
      'discord',
      'slack'
    ]) {
      assert.ok(keys.includes(expectedKey), `expected module "${expectedKey}" to be installed`)
    }
  })

  for (const def of loadDefinitions()) {
    test(`${def.key}: icon resolves to a real file under frontend/public`, () => {
      assert.match(
        def.icon ?? '',
        /^\/_assets\/icons\/[a-z0-9-]+\.svg$/,
        `${def.key}.icon should be a /_assets/icons/*.svg path, got ${JSON.stringify(def.icon)}`
      )
      const resolved = path.join(frontendPublicDir, def.icon as string)
      assert.ok(
        existsSync(resolved),
        `${def.key}.icon points at "${def.icon}", but no file exists at ${resolved} -- this is exactly the "typo'd icon path renders a blank avatar" failure mode this test guards against`
      )
    })

    test(`${def.key}: logo is a well-formed https URL to an svg`, () => {
      assert.match(
        def.logo ?? '',
        /^https:\/\/.+\.svg$/,
        `${def.key}.logo should be an https URL ending in .svg, got ${JSON.stringify(def.logo)}`
      )
    })

    test(`${def.key}: color is a non-empty theme color token`, () => {
      assert.ok(
        typeof def.color === 'string' && def.color.length > 0,
        `${def.key}.color should be a non-empty string, got ${JSON.stringify(def.color)}`
      )
    })
  }

  test('every preset has a distinct icon path (no two presets sharing, and thus masking, one file)', () => {
    const iconsByKey = new Map<string, string>()
    for (const def of definitions) {
      if (def.icon) {
        iconsByKey.set(def.key, def.icon)
      }
    }
    const seen = new Map<string, string>()
    for (const [key, icon] of iconsByKey) {
      const collidesWith = seen.get(icon)
      assert.ok(!collidesWith, `"${key}" and "${collidesWith}" both declare icon "${icon}"`)
      seen.set(icon, key)
    }
  })
})
