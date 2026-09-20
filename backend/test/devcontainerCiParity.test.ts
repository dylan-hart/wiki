/**
 * The devcontainer's claim is that a green run inside it means a green run in CI, and that claim
 * decays silently -- nothing fails, the container just quietly stops being what the runner is. The
 * mechanically checkable parts of it are asserted here so the decay has to announce itself.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const read = (relPath: string) => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')

/**
 * Every "this must NOT appear" check below is about the configuration, not the prose explaining it
 * -- and that prose necessarily quotes the very strings being forbidden. Without this, documenting
 * a rule is what breaks it.
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

function dockerArg(name: string): string {
  const matches = [...DOCKERFILE.matchAll(new RegExp(`^ARG ${name}=(.+)$`, 'gm'))]
  assert.equal(
    matches.length,
    1,
    `expected exactly one \`ARG ${name}=\` line in .devcontainer/Dockerfile, found ${matches.length}`
  )
  return matches[0]![1]!.trim()
}

function declaredVersion(relPath: string, name: string): string {
  const pkg = JSON.parse(read(relPath))
  const version =
    pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name]
  assert.ok(version, `expected ${relPath} to declare ${name}`)
  return version as string
}

const WORKFLOWS_DIR = '.github/workflows'

function workflowFiles(): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, WORKFLOWS_DIR))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
}

/**
 * Scanned out of the source text rather than the parsed YAML: the parse loses line numbers, and a
 * failure here is only actionable if it names the line to edit.
 */
function nodeVersionsIn(relPath: string): { line: number; value: string }[] {
  return read(relPath)
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => /^\s*node-version:/.test(text))
    .map(({ text, line }) => ({ line, value: text.replace(/^\s*node-version:\s*/, '').trim() }))
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
    // A digest and a version literal can disagree -- one bumped, the other forgotten. That has to
    // fail the build rather than ship an image whose runtime nothing in the repo describes.
    assert.match(DOCKERFILE, /node -v/)
    assert.match(DOCKERFILE, /v\$\{NODE_VERSION\}/)
  })

  test('docker-compose.yml passes no build args, so it cannot override the pin', () => {
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

describe('devcontainer CI parity: CI runs the same pinned patch (#2685)', () => {
  // `26.8.1` in the image and `26.5.0` on the runner are both "Node 26", so this divergence
  // produces no error anywhere -- just a test that passes in one place and not the other.
  const workflows = workflowFiles()

  test('there are workflow files to scan at all', () => {
    assert.ok(
      workflows.length > 0,
      `expected .yml workflow files under ${WORKFLOWS_DIR}/, found none -- the scan below is only ` +
        'meaningful if it actually reads something'
    )
  })

  test('every node-version: under .github/workflows/ is the exact patch the image pins', () => {
    const pinned = dockerArg('NODE_VERSION')
    const seen: string[] = []

    for (const name of workflows) {
      for (const { line, value } of nodeVersionsIn(`${WORKFLOWS_DIR}/${name}`)) {
        seen.push(`${name}:${line}`)
        assert.equal(
          value,
          pinned,
          `${WORKFLOWS_DIR}/${name}:${line} says \`${value}\`, but .devcontainer/Dockerfile pins ` +
            `\`ARG NODE_VERSION=${pinned}\`. That ARG is the single declaration; raising it is a ` +
            'three-file change made in one commit (the ARG, NODE_IMAGE_DIGEST beside it, and every ' +
            'node-version: here) -- see the Dockerfile header, which states the rule.'
        )
      }
    }

    assert.ok(
      seen.length > 0,
      'no workflow declares a node-version at all, which means this scan is asserting nothing'
    )
  })

  test('every setup-node step declares a node-version, rather than taking the runner default', () => {
    // setup-node with no node-version installs whatever the runner image ships: the same floating
    // resolution a range gives, reintroduced by omission and invisible to a grep for `26.x`.
    for (const name of workflows) {
      const text = read(`${WORKFLOWS_DIR}/${name}`)
      const setupSteps = [...text.matchAll(/uses:\s*actions\/setup-node@/g)].length
      assert.equal(
        nodeVersionsIn(`${WORKFLOWS_DIR}/${name}`).length,
        setupSteps,
        `${WORKFLOWS_DIR}/${name} has ${setupSteps} setup-node step(s) but does not give every one ` +
          'of them a node-version'
      )
    }
  })
})

describe('the pin and `engines` answer different questions (#2685)', () => {
  // `engines` deliberately does NOT move with the pin: the pin is "what we run" (one exact patch,
  // so image and runner cannot resolve different ones), `engines` is "what this code is compatible
  // with" (a floor, for whoever installs it). Collapsing them would make `npm ci` refuse a
  // compatible 26.9.0 and turn every bump into a four-file lockstep edit, buying no correctness.
  // Only the pair drifting a whole major apart is a real incompatibility, so that is what is
  // asserted.
  const WORKSPACES = ['backend', 'frontend', 'blocks', 'e2e'] as const

  function enginesNode(workspace: string): string | null {
    return JSON.parse(read(`${workspace}/package.json`)).engines?.node ?? null
  }

  test('at least one workspace declares engines.node, so this block is not vacuous', () => {
    assert.ok(WORKSPACES.some((workspace) => enginesNode(workspace) !== null))
  })

  for (const workspace of WORKSPACES) {
    test(`${workspace}/package.json's engines.node stays a floor, not a second copy of the pin`, () => {
      const declared = enginesNode(workspace)
      if (declared === null) {
        // No `engines` is legitimate for a workspace nobody installs as a dependency: the rule is
        // about the shape of the statement when one IS made, not about making one.
        return
      }
      assert.match(
        declared,
        /^>=\s*\d+/,
        `${workspace}/package.json declares engines.node as \`${declared}\`; it is a compatibility ` +
          'floor and must stay one. The exact patch belongs to .devcontainer/Dockerfile ARG ' +
          'NODE_VERSION and the workflows, not here.'
      )
    })
  }

  test('the floor and the pin agree on the major', () => {
    const pinnedMajor = dockerArg('NODE_VERSION').split('.')[0]
    for (const workspace of WORKSPACES) {
      const declared = enginesNode(workspace)
      if (declared === null) {
        continue
      }
      assert.equal(
        declared.match(/(\d+)/)![1],
        pinnedMajor,
        `${workspace}/package.json allows Node ${declared} while CI and the devcontainer run ` +
          `${dockerArg('NODE_VERSION')} -- a floor a whole major below what anything is ever run ` +
          'on is a claim nothing tests'
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
    // The image is built natively on arm64 too; an x86_64-only tarball installs a binary that
    // cannot execute there at all.
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
    // invisible to it, and a browser-backed suite reports that as a SKIP, not a failure.
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

describe('devcontainer CI parity: a pinned, newer git built from source (#3215)', () => {
  test('GIT_VERSION is an exact release, not a range or a bare major', () => {
    assert.match(
      dockerArg('GIT_VERSION'),
      /^\d+\.\d+\.\d+$/,
      'the same reasoning as NODE_VERSION applies: a range lets the image resolve a different git ' +
        'on different days'
    )
  })

  test('the source tarball is checksummed', () => {
    assert.match(dockerArg('GIT_SHA256'), /^[0-9a-f]{64}$/)
    assert.match(
      DOCKERFILE,
      /sha256sum -c -/,
      'GIT_SHA256 is only worth pinning if the build actually verifies the download against it'
    )
  })

  test('git is built with make prefix=/usr, not the default /usr/local', () => {
    // Installing to /usr rather than /usr/local keeps the system config at /etc/gitconfig, which
    // the git-configuration RUN depends on -- the reason for building from source at all.
    assert.match(DOCKERFILE, /make prefix=\/usr NO_RUST=1 -j"\$\(nproc\)" all/)
    assert.match(DOCKERFILE, /make prefix=\/usr NO_RUST=1 install/)
  })

  test('the build asserts at image-build time that the installed git matches GIT_VERSION', () => {
    assert.match(DOCKERFILE, /actual="\$\(git --version \| awk '\{print \$3\}'\)"/)
    assert.match(DOCKERFILE, /if \[ "\$actual" != "\$\{GIT_VERSION\}" \]; then/)
  })

  test('the git feature is still not enabled, which would install a different (and un-pinned) git', () => {
    assert.doesNotMatch(
      withoutComments(DEVCONTAINER_JSON),
      /"ghcr\.io\/devcontainers\/features\/git:/,
      'devcontainers/features/git builds its own git under /usr/local; this Dockerfile pins and ' +
        'builds its own instead, at /usr, so both the version and the gitconfig path stay under this ' +
        'project’s control'
    )
  })
})

describe('devcontainer CI parity: git is configured, not inherited (#2684, Bug #2586)', () => {
  test('init.defaultBranch is stated explicitly', () => {
    // An inherited init.defaultBranch is how a `git init` fixture passes on the author's host and
    // fails on the runner, reproducible on neither machine from the other.
    assert.match(DOCKERFILE, /git config --system init\.defaultBranch \S+/)
  })

  test('a user identity is stated explicitly', () => {
    assert.match(DOCKERFILE, /git config --system user\.name /)
    assert.match(DOCKERFILE, /git config --system user\.email /)
  })

  test('the git feature is not enabled, which would orphan those settings', () => {
    // That feature's git lives under /usr/local, whose system config is /usr/local/etc/gitconfig --
    // so everything written to /etc/gitconfig above stays on disk and is silently no longer read.
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
  test('every service beyond app, db and minio is behind a compose profile', () => {
    // `minio` is CI-equivalent, not a developer tool: quality.yml runs a MinIO container of its
    // own, so this one has to start by default the same way `db` does.
    for (const [name, service] of Object.entries<any>(compose.services)) {
      if (name === 'app' || name === 'db' || name === 'minio') {
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
