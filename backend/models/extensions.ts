import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readModuleDefinitions } from '../helpers/moduleRegistry.ts'

const execFileAsync = promisify(execFile)

/**
 * Generous because of what the slowest install has to do: Puppeteer fetches a Chromium build of a
 * few hundred megabytes. A ceiling rather than a wait — Sharp still finishes in seconds.
 */
const installTimeout = 20 * 60 * 1000

/** Kept from the end of npm's output, where the error is. */
const installErrorLength = 800

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
  /** Any architecture when absent. */
  architectures?: string[]
  /** Any platform when absent. */
  platforms?: string[]
  /** Whether the admin area can install it, as opposed to it being installed by hand. */
  isInstallable: boolean
  /**
   * Only for an extension `package.json` does not declare, the one other place a version would be
   * written down: without a pin npm resolves whatever is newest today, and two instances installed a
   * month apart run different software. A declared extension leaves this out, since a second pin
   * could only disagree with the first.
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
  /** The architecture(s)/platform(s) the extension requires versus what this server reports. */
  incompatibleReason: string | null
  /**
   * Whether this process already tried and failed to load the extension's module, so it cannot be
   * used however healthy the files on disk now are. Recomputed on every call, independent of whether
   * an admin has clicked install this session.
   */
  needsRestart: boolean
}

/**
 * Walks PATH rather than shelling out to `which` / `where`, which is both faster and free of any
 * quoting concerns around the name being looked up.
 */
export async function commandExists(command: string): Promise<boolean> {
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
 * Not `import()`: optional dependencies like Sharp load native binaries, which is expensive and can
 * fail for reasons that have nothing to do with the package being there. Not `import.meta.resolve`
 * either — it caches package.json lookups, so a package removed after being resolved once keeps
 * reporting as present until the server restarts, which is the misleading direction here.
 */
async function moduleExists(specifier: string): Promise<boolean> {
  try {
    await fs.access(path.join(CARDINAL.SERVERPATH, 'node_modules', specifier, 'package.json'))
    return true
  } catch {
    return false
  }
}

/**
 * The bare specifier when the manifest already pins a version, or `specifier@installVersion` when it
 * doesn't. `moduleExists()` checks for the specifier on its own either way, since that is what lands
 * in `node_modules` regardless of which form was requested.
 */
export function installRequest(definition: ExtensionDefinition): string {
  const specifier = definition.detect.value
  return definition.installVersion ? `${specifier}@${definition.installVersion}` : specifier
}

/**
 * Pulled out as a pure function so a test can lock this argv down by asserting on it directly: core
 * module exports are not reconfigurable, so `node:test` cannot stub `node:child_process`'s
 * `execFile` without `--experimental-test-module-mocks`, which this project's `test` script does not
 * set.
 *
 * Every flag here is justified in `install()`'s doc comment, and a test asserts the two agree — keep
 * them in lockstep.
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
 * Optional third-party tooling that unlocks extra functionality — a Git binary, Pandoc, Sharp,
 * Puppeteer. Each lives in `modules/extensions/<key>/definition.yml`, which declares how to detect
 * it, what it is compatible with, and whether it can be installed from here.
 *
 * A `command` extension cannot be installed from here: it comes from the system package manager, and
 * the admin area links out to the instructions instead. A `module` extension is an npm package,
 * which `install()` can fetch.
 */
class Extensions {
  definitions: ExtensionDefinition[] = []

  /**
   * npm specifiers this process tried to load and could not.
   *
   * Node caches a failed module load for the lifetime of the process: an `import()` that threw keeps
   * throwing the same error afterwards, even once the files it was missing are back on disk. So a
   * repaired install does not take effect until the server restarts, and the only way to know that
   * is to remember having failed.
   */
  loadFailures = new Set<string>()

  async refreshFromDisk(): Promise<void> {
    const extensionsPath = path.join(CARDINAL.SERVERPATH, 'modules/extensions')
    try {
      // -> No `parseProps`: an extension declares how to detect and install itself, not a config form
      const definitions = await readModuleDefinitions<ExtensionDefinition>(extensionsPath)
      this.definitions = definitions.sort((a, b) => a.title.localeCompare(b.title))
      CARDINAL.logger.debug('ext', 'loaded extension definitions', {
        extensions: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      CARDINAL.logger.warn('ext', 'reading the extension definitions failed', {
        path: extensionsPath,
        error: err
      })
    }
  }

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
   * Null when compatible. Both dimensions are checked rather than stopping at the first failure, so
   * an extension restricted on both counts explains both at once.
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

  async isInstalled(definition: ExtensionDefinition): Promise<boolean> {
    switch (definition.detect?.type) {
      case 'command':
        return commandExists(definition.detect.value)
      case 'module':
        return moduleExists(definition.detect.value)
      default:
        CARDINAL.logger.warn('ext', 'no usable detection method', { extension: definition.key })
        return false
    }
  }

  /**
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
        // -> An incompatible extension cannot be present, and skipping the check saves a PATH walk
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
   * Only a `module` extension can be installed from here. Detection is repeated afterwards, since
   * npm exiting zero and the module actually being there are not the same claim.
   *
   * Both installable extensions are declared optional dependencies, so reaching this method at all
   * means either that an install skipped optional dependencies or that what landed is unusable: this
   * is a repair, not a first install. Sharp's usual failure is its *native* binary, left missing for
   * this OS and architecture with the JavaScript package in place; Puppeteer's is the browser under
   * it, which its own postinstall downloads. `PUPPETEER_SKIP_DOWNLOAD`/`PUPPETEER_EXECUTABLE_PATH`
   * are deliberately not set here — npm inherits this process's environment, so an install from the
   * admin area sees exactly what the operator set for the server and nothing else.
   *
   * Hence the flags:
   *
   * - `--no-save` because an HTTP request has no business rewriting the manifests the release was
   *   built from.
   * - `--force` so npm refetches rather than deciding an already-present but unusable copy is fine.
   * - `--include=optional` because the per-platform binaries are themselves optional dependencies of
   *   the package, and omitting them is the usual cause of the failure being repaired here.
   * - `--no-ignore-scripts` because the browser IS Puppeteer's postinstall. An operator who has set
   *   `ignore-scripts` would otherwise get the package with no browser under it, npm exiting zero,
   *   and this model reporting it as installed — the failure surfacing much later, as a render that
   *   cannot start a browser. This runs every install script in the resolved tree unmediated: npm
   *   has no per-package allowlist and this codebase installs no tool (such as
   *   `@lavamoat/allow-scripts`) that would add one. Accepted rather than mediated because the
   *   caller must already hold `manage:system`, and so can already run arbitrary code on this server
   *   by other means.
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
          cwd: CARDINAL.SERVERPATH,
          timeout: installTimeout,
          windowsHide: true,
          // -> `npm.cmd` is a batch file, which Node will not run without a shell. Nothing here comes
          //    from a request: the package name is read from a definition on disk.
          shell: process.platform === 'win32'
        }
      )
      CARDINAL.logger.debug('ext', 'npm output', {
        extension: definition.key,
        package: request,
        output: stdout.trim()
      })
    } catch (err: any) {
      const detail: string = (err.stderr || err.stdout || err.message || '').toString().trim()
      CARDINAL.logger.warn('ext', 'installing the extension failed', {
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
    CARDINAL.logger.info('ext', 'installed extension', {
      extension: definition.key,
      package: request
    })
  }

  noteLoadFailure(specifier: string): void {
    this.loadFailures.add(specifier)
  }

  hasLoadFailed(definition: ExtensionDefinition): boolean {
    return definition.detect?.type === 'module' && this.loadFailures.has(definition.detect.value)
  }

  getDefinition(key: string): ExtensionDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

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
    // -> One line for the whole set: which extensions are present is a single fact about the instance
    CARDINAL.logger.info('ext', 'extensions detected', {
      installed: installed.join(', ') || 'none',
      missing: missing.join(', ') || 'none',
      incompatible: incompatible.join(', ') || 'none'
    })
  }
}

export const extensions = new Extensions()
