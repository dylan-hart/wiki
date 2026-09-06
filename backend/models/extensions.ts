import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readModuleDefinitions } from '../helpers/moduleRegistry.ts'

const execFileAsync = promisify(execFile)

/**
 * How long an install may run before it is given up on.
 *
 * Generous because of what the slowest one has to do: Puppeteer fetches a Chromium build of a few
 * hundred megabytes, which on a thin connection is minutes of transfer before npm has anything to
 * unpack. A ceiling rather than a wait — Sharp still finishes in seconds.
 */
const installTimeout = 20 * 60 * 1000

/** How much npm output is kept when reporting a failure, taken from the end where the error is. */
const installErrorLength = 800

/** How an extension's presence on this system is detected. */
export interface ExtensionDetection {
  /** `command` looks for an executable on PATH, `module` for a resolvable npm package. */
  type: 'command' | 'module'
  value: string
}

/** An extension as declared by its `definition.yml`. */
export interface ExtensionDefinition {
  key: string
  title: string
  description: string
  website?: string
  detect: ExtensionDetection
  /** Architectures the extension can run on. Any architecture when absent. */
  architectures?: string[]
  /** Platforms the extension can run on. Any platform when absent. */
  platforms?: string[]
  /** Whether the admin area can install it, as opposed to it being installed by hand. */
  isInstallable: boolean
  /**
   * The version `install()` asks npm for.
   *
   * For an extension that is not declared in `package.json` at all, which is the only place a version
   * would otherwise be written down — without it npm resolves whatever is newest today, and two
   * instances installed a month apart are running different software. An extension the manifest
   * already declares leaves this out, since a second pin here could only disagree with the first.
   */
  installVersion?: string
}

/** An extension plus its state on this system, as exposed by the API. */
export interface ExtensionState {
  key: string
  title: string
  description: string
  website: string
  isInstalled: boolean
  isInstallable: boolean
  isCompatible: boolean
  /**
   * Why `isCompatible` is false — the architecture(s) and/or platform(s) the extension requires versus
   * what this server reports (`os.arch()` / `process.platform`). Null when compatible.
   */
  incompatibleReason: string | null
  /**
   * Whether this process already tried and failed to load the extension's module, so it cannot be used
   * however healthy the files on disk now are.
   *
   * Computed from `hasLoadFailed()` on every call, independent of whether an admin has clicked install
   * this session — so a module that failed to load during, say, a page render shows the warning here
   * immediately rather than only after a one-shot install-response toast.
   */
  needsRestart: boolean
}

/**
 * Whether an executable of this name exists on PATH.
 *
 * Walks PATH rather than shelling out to `which` / `where`, which is both faster and free of any
 * quoting concerns around the name being looked up.
 */
async function commandExists(command: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  // -> On Windows the name on disk carries an extension, e.g. `git.exe`
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      try {
        await fs.access(path.join(dir, `${command}${suffix}`), fs.constants.X_OK)
        return true
      } catch {
        // -> Not in this directory, or not executable by us; keep looking
      }
    }
  }
  return false
}

/**
 * Whether an npm package is installed in the backend's `node_modules`.
 *
 * Not `import()`: optional dependencies like Sharp load native binaries, which is expensive and can
 * fail for reasons that have nothing to do with the package being there. Not `import.meta.resolve`
 * either — it caches package.json lookups, so a package removed after being resolved once keeps
 * reporting as present until the server restarts, which is the misleading direction here. Reading the
 * manifest is cheap and always current.
 */
async function moduleExists(specifier: string): Promise<boolean> {
  try {
    await fs.access(path.join(WIKI.SERVERPATH, 'node_modules', specifier, 'package.json'))
    return true
  } catch {
    return false
  }
}

/**
 * What npm is asked to install for this extension: the bare specifier when the manifest already pins
 * a version (Sharp, a declared optional dependency), or `specifier@installVersion` when it doesn't
 * (Puppeteer — see `install()`'s doc comment for why). What is checked for afterwards, by
 * `moduleExists()`, is the specifier on its own, since that's what lands in `node_modules` regardless
 * of which form was requested.
 */
export function installRequest(definition: ExtensionDefinition): string {
  const specifier = definition.detect.value
  return definition.installVersion ? `${specifier}@${definition.installVersion}` : specifier
}

/**
 * The exact npm argv `install()` passes to `execFile`, pulled out as its own pure function so
 * OpenProject #2291's test can lock it down by asserting on this directly, without stubbing `execFile`
 * or mocking the `node:child_process` module — Node refuses to let a test do that without the
 * `--experimental-test-module-mocks` flag, which this project's `test` script does not set, and core
 * module exports aren't reconfigurable without it. `models/import.ts`'s `buildPandocArgs`/`pandocCwd`
 * (OpenProject #2191) hit the identical wall for the same class of problem — a spawned argv that is
 * itself a security/policy boundary — and settled on the same fix.
 *
 * Every flag below has a paragraph justifying it in the doc comment on `install()`. Keep the two in
 * lockstep: a flag added or removed here without updating that comment is exactly what the test this
 * function exists for is meant to catch.
 */
export function buildInstallArgs(definition: ExtensionDefinition): string[] {
  return [
    'install',
    '--no-save',
    '--force',
    '--include=optional',
    '--no-ignore-scripts',
    '--no-audit',
    '--no-fund',
    installRequest(definition)
  ]
}

/**
 * Extensions model
 *
 * Optional third-party tooling that unlocks extra functionality — a Git binary, Pandoc, Sharp,
 * Puppeteer. Each lives in `modules/extensions/<key>/definition.yml`, which declares how to detect it,
 * what it is compatible with, and whether it can be installed from here.
 *
 * The `command` ones cannot be installed from here: a Git or Pandoc binary comes from the system
 * package manager, and the admin area links out to the instructions instead. An extension detected as
 * a `module` is an npm package, which `install()` can fetch — Sharp to replace a native binary that
 * is missing or does not match the platform, Puppeteer because it is deliberately not shipped and has
 * to come from somewhere.
 */
class Extensions {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: ExtensionDefinition[] = []

  /**
   * npm specifiers this process tried to load and could not, reported by whoever attempted it.
   *
   * Node caches a failed module load for the lifetime of the process: an `import()` that threw keeps
   * throwing the same error afterwards, even once the files it was missing are back on disk. So a
   * repaired install does not take effect here until the server restarts, and the only way to know
   * that is to remember having failed.
   */
  loadFailures = new Set<string>()

  /**
   * Load the extension definitions from disk.
   */
  async refreshFromDisk(): Promise<void> {
    const extensionsPath = path.join(WIKI.SERVERPATH, 'modules/extensions')
    try {
      // -> No `parseProps`: an extension declares how to detect and install itself, not a config form
      const definitions = await readModuleDefinitions<ExtensionDefinition>(extensionsPath)
      this.definitions = definitions.sort((a, b) => a.title.localeCompare(b.title))
      WIKI.logger.debug('ext', 'loaded extension definitions', {
        extensions: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.warn('ext', 'reading the extension definitions failed', {
        path: extensionsPath,
        error: err
      })
    }
  }

  /**
   * Whether this system can run the extension at all, regardless of whether it is installed
   */
  isCompatible(definition: ExtensionDefinition): boolean {
    if (definition.architectures && !definition.architectures.includes(os.arch())) {
      return false
    }
    if (definition.platforms && !definition.platforms.includes(process.platform)) {
      return false
    }
    return true
  }

  /**
   * Why `isCompatible(definition)` is false, naming what the extension needs against what this server
   * reports — or null when it is compatible. Checks both dimensions rather than stopping at the first
   * failure, so an extension restricted on both counts explains both at once.
   */
  incompatibilityReason(definition: ExtensionDefinition): string | null {
    const problems: string[] = []
    if (definition.architectures && !definition.architectures.includes(os.arch())) {
      problems.push(
        `requires architecture ${definition.architectures.join(' or ')}, but this server is running ${os.arch()}`
      )
    }
    if (definition.platforms && !definition.platforms.includes(process.platform)) {
      problems.push(
        `requires platform ${definition.platforms.join(' or ')}, but this server is running ${process.platform}`
      )
    }
    return problems.length > 0 ? problems.join('; ') : null
  }

  /**
   * Whether the extension is present on this system
   */
  async isInstalled(definition: ExtensionDefinition): Promise<boolean> {
    switch (definition.detect?.type) {
      case 'command':
        return commandExists(definition.detect.value)
      case 'module':
        return moduleExists(definition.detect.value)
      default:
        WIKI.logger.warn('ext', 'no usable detection method', { extension: definition.key })
        return false
    }
  }

  /**
   * Every extension with its current state.
   *
   * Detection runs on each call rather than being cached at boot, so that installing a tool and
   * hitting refresh in the admin area reflects reality without restarting the server.
   */
  async getExtensions(): Promise<ExtensionState[]> {
    const results: ExtensionState[] = []
    for (const definition of this.definitions) {
      const isCompatible = this.isCompatible(definition)
      results.push({
        key: definition.key,
        title: definition.title,
        description: definition.description,
        website: definition.website ?? '',
        // -> An incompatible extension cannot be present, and skipping the check keeps a pointless
        //    PATH walk out of the way
        isInstalled: isCompatible ? await this.isInstalled(definition) : false,
        isInstallable: definition.isInstallable === true,
        isCompatible,
        incompatibleReason: isCompatible ? null : this.incompatibilityReason(definition),
        needsRestart: this.hasLoadFailed(definition)
      })
    }
    return results
  }

  /**
   * Install, or reinstall, an extension with npm.
   *
   * Only a `module` extension can be installed from here — a `command` extension is an operating
   * system package, and no amount of npm will produce one. Callers are expected to have checked
   * `isInstallable` and `isCompatible` first; this repeats the detection check afterwards, since npm
   * exiting zero and the module actually being there are not the same claim.
   *
   * The two installable extensions ask for different things, and the flags below serve both.
   *
   * Both are declared optional dependencies now (`backend/package.json`), so an ordinary
   * `npm ci`/`npm install` already has them — reaching this method at all means either that install
   * skipped optional dependencies (`--omit=optional`) or that what landed is unusable, and calling it
   * here is a repair, not a first install.
   *
   * Sharp's usual failure is its *native* binary: an image built on one platform and run on another, or
   * an install that skipped optional dependencies, leaves the JavaScript package in place and the
   * binary for this OS and architecture missing.
   *
   * Puppeteer's is the browser under it. Nothing has to be arranged for a fresh fetch: Puppeteer's own
   * postinstall downloads one into its cache, which is the ordinary case and the one an install straight
   * onto Linux takes. A server that already has a browser opts out with `PUPPETEER_SKIP_DOWNLOAD` and
   * points at it with `PUPPETEER_EXECUTABLE_PATH` — what the Docker image does with the Chromium it
   * takes from the distro, installed via the same `npm ci` as everything else now that Puppeteer is
   * declared. Neither env var is required, and neither is set here: npm inherits this process's
   * environment, so an install from the admin area sees exactly what the operator set for the server and
   * nothing else.
   *
   * Hence the flags:
   *
   * - `--no-save` because an HTTP request has no business rewriting the manifests the release was
   *   built from — true of both packages, whether or not the manifest happens to declare them
   *   already (Sharp does, as an optional dependency; Puppeteer doesn't, per the paragraph above).
   * - `--force` so npm refetches rather than deciding an already-present but unusable copy is fine.
   * - `--include=optional` because the per-platform binaries are themselves optional dependencies of
   *   the package, and omitting them is the usual cause of the failure being repaired here.
   * - `--no-ignore-scripts` because the browser IS Puppeteer's postinstall. An operator who has set
   *   `ignore-scripts` — a reasonable thing to harden an npm config with — would otherwise get the
   *   package with no browser under it, npm exiting zero, and this model reporting it as installed:
   *   the failure would surface much later, as a render that cannot start a browser. This runs every
   *   install script in the resolved tree unmediated — nothing here reads `package.json` to decide
   *   which scripts to trust, npm itself has no such per-package allowlist, and this codebase installs
   *   no tool (such as `@lavamoat/allow-scripts`) that would add one. That is accepted rather than
   *   mediated because the caller must already hold `manage:system` (see the route's
   *   `config.permissions` in `api/system/extensions.ts`) — an operator with that permission can already run
   *   arbitrary code on this server by other means, so gating install scripts specifically would add
   *   friction without adding a boundary.
   *
   * @throws If the extension cannot be installed this way, if npm fails, or if the module is still
   *         missing afterwards
   */
  async install(definition: ExtensionDefinition): Promise<void> {
    if (definition.detect?.type !== 'module') {
      throw new Error(`${definition.title} is not an npm package, so it cannot be installed here.`)
    }
    const specifier = definition.detect.value
    const request = installRequest(definition)

    try {
      const { stdout } = await execFileAsync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        buildInstallArgs(definition),
        {
          cwd: WIKI.SERVERPATH,
          timeout: installTimeout,
          windowsHide: true,
          // -> `npm.cmd` is a batch file, which Node will not run without a shell. Nothing here comes
          //    from a request: the package name is read from a definition on disk.
          shell: process.platform === 'win32'
        }
      )
      WIKI.logger.debug('ext', 'npm output', {
        extension: definition.key,
        package: request,
        output: stdout.trim()
      })
    } catch (err: any) {
      // -> npm says what went wrong on stderr, and the tail of it is the part worth passing on
      const detail: string = (err.stderr || err.stdout || err.message || '').toString().trim()
      WIKI.logger.warn('ext', 'installing the extension failed', {
        extension: definition.key,
        package: request,
        ...(detail ? { detail } : {}),
        error: err
      })
      throw new Error(
        `npm could not install ${request}: ${detail.slice(-installErrorLength) || 'no output'}`
      )
    }

    if (!(await this.isInstalled(definition))) {
      throw new Error(
        `npm reported success but ${specifier} is still not present in node_modules. Check the server logs.`
      )
    }
    WIKI.logger.info('ext', 'installed extension', {
      extension: definition.key,
      package: request
    })
  }

  /**
   * Record that loading a module failed in this process, so that a later reinstall can say a restart is
   * needed rather than claim the extension is ready to use.
   */
  noteLoadFailure(specifier: string): void {
    this.loadFailures.add(specifier)
  }

  /**
   * Whether this process has already failed to load the extension's module, and therefore cannot use it
   * however healthy the files on disk now are.
   */
  hasLoadFailed(definition: ExtensionDefinition): boolean {
    return definition.detect?.type === 'module' && this.loadFailures.has(definition.detect.value)
  }

  /**
   * A single definition, or null if there is no extension with this key
   */
  getDefinition(key: string): ExtensionDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Log which extensions were found, the way the other module types report at boot
   */
  async logState(): Promise<void> {
    const installed: string[] = []
    const missing: string[] = []
    const incompatible: string[] = []
    for (const extension of await this.getExtensions()) {
      if (!extension.isCompatible) {
        incompatible.push(extension.key)
      } else if (extension.isInstalled) {
        installed.push(extension.key)
      } else {
        missing.push(extension.key)
      }
    }
    // -> One line for the whole set rather than one per extension: which extensions are present is a
    //    single fact about the instance, and the keys are what an operator reads it for.
    WIKI.logger.info('ext', 'extensions detected', {
      installed: installed.join(', ') || 'none',
      missing: missing.join(', ') || 'none',
      incompatible: incompatible.join(', ') || 'none'
    })
  }
}

export const extensions = new Extensions()
