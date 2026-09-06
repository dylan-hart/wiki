/**
 * Structural checks for OpenProject #2684 ("Build the pinned CI-parity image, replacing
 * `.devcontainer/`'s current setup"), under Feature #2601.
 *
 * The image's claim is that a green run inside it means a green run in CI. That claim decays
 * silently -- nothing fails, the container just quietly stops being what the runner is -- so the
 * parts of it that ARE mechanically checkable are checked here:
 *
 *   * the Node patch is pinned exactly, declared once, and nothing downstream defeats the pin
 *     (all three of which were false before this WP: the Dockerfile digest-pinned 26.7.0,
 *     docker-compose.yml overrode it with a floating `VARIANT: 26`, and devcontainer.json layered
 *     a third, nvm-managed Node on top via the `devcontainers/features/node` feature);
 *   * every tool a workflow installs onto the runner before it can run the gate -- pandoc, a
 *     pinned git-cliff, Playwright's chromium -- is in the image, at the SAME version;
 *   * the git configuration is stated rather than inherited from the host (Bug #2586);
 *   * only what CI has starts by default; a developer-only service sits behind a compose profile.
 *
 * Deliberately NOT asserted here: that `.github/workflows/*.yml`'s own `node-version:` equals the
 * image's pin. Those files still say `26.x` and pinning them is sibling Task #2685's entire scope;
 * that cross-check belongs in this file once #2685 lands, and adding it now would fail on work
 * this WP is explicitly told not to do.
 *
 * Neither `.devcontainer/` nor `.github/` has a test workspace of its own to sit next to, so this
 * lives here as a structural/self-consistency check against repo-root files -- the same category
 * `devcontainerDatabaseUrl.test.ts`, `postgres-version-consistency.test.ts` and
 * `devcontainerPuppeteerVersion.test.ts` already establish for this exact directory.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const read = (relPath: string) => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')

/**
 * Drops whole-line comments (`#` for YAML/shell, `//` for the JSONC devcontainer.json).
 *
 * Every "this must NOT appear" check below is about the configuration, not about the prose
 * explaining it -- and the prose necessarily quotes the very things being forbidden ("it passed
 * `VARIANT: 26`...", "...no longer needs `npm run install-browsers`"). Without this, documenting a
 * rule is what breaks it.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n')
}

const DOCKERFILE = read('.devcontainer/Dockerfile')
const DEVCONTAINER_JSON = read('.devcontainer/devcontainer.json')
const APP_INIT = read('.devcontainer/app-init.sh')
const QUALITY_YML = read('.github/workflows/quality.yml')

const compose: any = load(read('.devcontainer/docker-compose.yml'))

/** The value of a single-valued `ARG <name>=<value>` line in the Dockerfile. */
function dockerArg(name: string): string {
  const matches = [...DOCKERFILE.matchAll(new RegExp(`^ARG ${name}=(.+)$`, 'gm'))]
  assert.equal(
    matches.length,
    1,
    `expected exactly one \`ARG ${name}=\` line in .devcontainer/Dockerfile, found ${matches.length}`
  )
  return matches[0]![1]!.trim()
}

/** A dependency's version from any of a package.json's dependency sections. */
function declaredVersion(relPath: string, name: string): string {
  const pkg = JSON.parse(read(relPath))
  const version =
    pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name]
  assert.ok(version, `expected ${relPath} to declare ${name}`)
  return version as string
}

describe('devcontainer CI parity: the pinned Node patch (#2684)', () => {
  test('NODE_VERSION is an exact patch, not a range or a bare major', () => {
    assert.match(
      dockerArg('NODE_VERSION'),
      /^\d+\.\d+\.\d+$/,
      'the whole point of Feature #2601 is that the image and CI cannot resolve different patches ' +
        'on different days -- `26`, `26.x` and `^26.0.0` all reintroduce that'
    )
  })

  test('the base image is digest-pinned, and the FROM uses both the version and the digest', () => {
    assert.match(dockerArg('NODE_IMAGE_DIGEST'), /^sha256:[0-9a-f]{64}$/)
    assert.match(
      DOCKERFILE,
      /^FROM node:\$\{NODE_VERSION\}-\w+@\$\{NODE_IMAGE_DIGEST\}$/m,
      'the FROM must be built from both ARGs, so neither can be edited into irrelevance'
    )
  })

  test('the build asserts at image-build time that the running Node matches NODE_VERSION', () => {
    // A digest and a version literal can disagree -- someone bumps one and forgets the other. That
    // has to fail the build, or the image ships a runtime every comment in the repo misdescribes.
    assert.match(DOCKERFILE, /node -v/)
    assert.match(DOCKERFILE, /v\$\{NODE_VERSION\}/)
  })

  test('docker-compose.yml passes no build args, so it cannot override the pin', () => {
    // The concrete regression this guards: `VARIANT: 26` here silently defeated a carefully
    // digest-pinned Dockerfile for the whole life of the previous setup.
    assert.equal(
      compose.services.app.build.args,
      undefined,
      'a build arg here overrides the Dockerfile ARG that is meant to be the single declaration'
    )
  })

  test('devcontainer.json does not layer a second Node on top of the image', () => {
    assert.doesNotMatch(
      withoutComments(DEVCONTAINER_JSON),
      /"ghcr\.io\/devcontainers\/features\/node:/,
      'the devcontainers/features/node feature installs an nvm-managed Node over the pinned one, ' +
        'so the pinned Node is not the Node you get'
    )
  })

  test('the Node version is declared in exactly one file across .devcontainer/', () => {
    for (const [label, text] of [
      ['docker-compose.yml', read('.devcontainer/docker-compose.yml')],
      ['devcontainer.json', DEVCONTAINER_JSON],
      ['app-init.sh', APP_INIT]
    ] as const) {
      assert.doesNotMatch(
        withoutComments(text),
        /\bnode:2\d[.\d]*\b/,
        `${label} names a Node image version; the Dockerfile's ARG NODE_VERSION is the only place ` +
          'that may'
      )
    }
  })
})

describe('devcontainer CI parity: the tools the gate needs (#2684)', () => {
  test('pandoc is installed, because quality.yml installs it', () => {
    assert.match(QUALITY_YML, /install -y pandoc/)
    assert.match(
      DOCKERFILE,
      /^\s+pandoc \\?$/m,
      'backend/models/import.test.ts SKIPS its real-pandoc test without the binary, so an image ' +
        'without pandoc runs strictly fewer tests than CI and still reports green'
    )
  })

  test('git-cliff is pinned to the same release quality.yml installs', () => {
    const inWorkflow = QUALITY_YML.match(/git-cliff\/releases\/download\/v(\d+\.\d+\.\d+)/)
    assert.ok(inWorkflow, 'expected quality.yml to install a pinned git-cliff release')
    assert.equal(
      dockerArg('GIT_CLIFF_VERSION'),
      inWorkflow![1],
      'backend/test/changelog.test.ts runs the real binary; a different version here is a ' +
        'different changelog'
    )
  })

  test('git-cliff is fetched for the running architecture, not hard-coded to x86_64', () => {
    // This image is built natively on arm64 too (Apple Silicon); an x86_64-only tarball installs a
    // binary that cannot execute at all there.
    assert.match(DOCKERFILE, /dpkg --print-architecture/)
    assert.match(DOCKERFILE, /aarch64-unknown-linux-gnu/)
    assert.match(DOCKERFILE, /x86_64-unknown-linux-gnu/)
  })

  test("Playwright's browser is baked in at the version both workspaces declare", () => {
    const pinned = dockerArg('PLAYWRIGHT_VERSION')
    assert.equal(pinned, declaredVersion('frontend/package.json', 'playwright'))
    assert.equal(pinned, declaredVersion('e2e/package.json', '@playwright/test'))
    assert.match(DOCKERFILE, /playwright@\$\{PLAYWRIGHT_VERSION\}" install --with-deps chromium/)
  })

  test('the browser lives on a shared path, not in the installing user\u2019s home', () => {
    // The install runs as root; the container runs as `node`. A browser under /root/.cache is
    // invisible to it, and frontend/test/realGridLayout.js reports that as a SKIP, not a failure.
    assert.match(DOCKERFILE, /^ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright$/m)
    assert.match(DOCKERFILE, /chmod -R a\+rX "\$PLAYWRIGHT_BROWSERS_PATH"/)
  })

  test('all four workspaces are installed, and with npm ci', () => {
    for (const workspace of ['backend', 'frontend', 'blocks', 'e2e']) {
      assert.match(
        APP_INIT,
        new RegExp(`cd /workspace/${workspace}\\nnpm ci`),
        `expected app-init.sh to \`npm ci\` in ${workspace}/ -- CI runs npm ci, so this does too`
      )
    }
  })

  test('app-init.sh no longer asks for a per-machine browser install', () => {
    assert.doesNotMatch(
      withoutComments(APP_INIT),
      /playwright install|install-browsers/,
      'the browser is in the image; a second per-machine install step is exactly the ambient ' +
        'prerequisite this WP removes'
    )
  })
})

describe('devcontainer CI parity: git is configured, not inherited (#2684, Bug #2586)', () => {
  test('init.defaultBranch is stated explicitly', () => {
    // #2586: a fixture ran `git init` with no --initial-branch and pushed `main`. The developer's
    // host had init.defaultBranch=main configured and the runner did not, so fifteen subtests
    // passed locally and failed in CI and could not be reproduced on the machine that wrote them.
    assert.match(DOCKERFILE, /git config --system init\.defaultBranch \S+/)
  })

  test('a user identity is stated explicitly', () => {
    assert.match(DOCKERFILE, /git config --system user\.name /)
    assert.match(DOCKERFILE, /git config --system user\.email /)
  })

  test('the git feature is not enabled, which would orphan those settings', () => {
    // devcontainers/features/git builds git under /usr/local, whose system config is
    // /usr/local/etc/gitconfig -- so everything written to /etc/gitconfig above would still be on
    // disk and silently no longer read.
    assert.doesNotMatch(
      withoutComments(DEVCONTAINER_JSON),
      /"ghcr\.io\/devcontainers\/features\/git:/
    )
  })

  test('the workspace is marked safe, since the bind mount is owned by the host uid', () => {
    assert.match(DOCKERFILE, /safe\.directory \/workspace/)
  })
})

describe('devcontainer CI parity: only what CI has starts by default (#2684)', () => {
  test('every service beyond app and db is behind a compose profile', () => {
    for (const [name, service] of Object.entries<any>(compose.services)) {
      if (name === 'app' || name === 'db') {
        assert.equal(
          service.profiles,
          undefined,
          `${name} is part of the CI-equivalent environment and must start by default`
        )
        continue
      }
      assert.ok(
        Array.isArray(service.profiles) && service.profiles.length > 0,
        `service "${name}" is not in CI, so it must sit behind a docker-compose profile rather ` +
          'than starting with the environment that gates'
      )
    }
  })

  test('pgAdmin specifically is one of them', () => {
    // Named because the parent Feature calls it out by name as the worked example.
    assert.deepEqual(compose.services.pgadmin.profiles, ['tools'])
  })

  test('an apt upgrade does not run at container-create time', () => {
    assert.doesNotMatch(
      withoutComments(DEVCONTAINER_JSON),
      /"upgradePackages":\s*"?true"?/,
      'upgradePackages resolves against whatever the Debian archive holds that morning, which is ' +
        'unpinnable drift in an image whose whole purpose is reproducibility'
    )
  })
})

describe('devcontainer CI parity: the feature lock stays in step (#2684)', () => {
  test('devcontainer-lock.json locks exactly the features devcontainer.json declares', () => {
    const declared = [
      ...withoutComments(DEVCONTAINER_JSON).matchAll(/^\s*"(ghcr\.io\/[^"]+)":\s*\{/gm)
    ].map((m) => m[1]!)
    const locked = Object.keys(JSON.parse(read('.devcontainer/devcontainer-lock.json')).features)
    assert.deepEqual(
      [...declared].sort(),
      [...locked].sort(),
      'a lock entry for a feature that is no longer declared (or a declared feature with no lock ' +
        'entry) means the lock file is not describing what actually gets built'
    )
  })
})
