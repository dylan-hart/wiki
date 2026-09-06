import Client from 'ssh2-sftp-client'

/**
 * Connecting to an sftp storage target, and the small directory-creation primitive every write to it
 * needs first.
 *
 * This is deliberately a sibling of `storage.ts` rather than `storage.ts` itself: `models/storage.ts`'s
 * `hasImplementation()` gates the admin area's "Export All" action purely on whether a `storage.ts`
 * file exists next to this module's `definition.yml` (see CLAUDE.md's note on extension-sensitive
 * dynamic paths). The connection layer is real and usable on its own, but `exportAll` itself — the
 * handler that action actually calls — is built by later tasks under this Feature; putting the
 * connection logic here keeps the action hidden until there is something behind it to run.
 */

/** The `sftp` module's config props, as stored on the target row (`storage.config`). */
export interface SftpTargetConfig {
  host: string
  port: number
  username: string
  authMode: 'privateKey' | 'password'
  password?: string
  privateKey?: string
  passphrase?: string
  basePath: string
}

export type SftpClientFactory = () => Client

/**
 * Cross-field check `models/storage.ts`'s generic `validateConfig` cannot express: it only checks
 * each prop's own type/enum against `definition.yml` in isolation, with no way to say "`privateKey`
 * is required when `authMode=privateKey`, `password` required when `authMode=password`" — so without
 * this, a target can be saved with `authMode=privateKey` and an empty `privateKey` field, and the
 * first sign of trouble is `ssh2` failing three network round-trips later with something like "All
 * configured authentication methods failed", which says nothing about *why*.
 *
 * This stays a small, explicit check local to this module rather than growing `StorageModule`'s
 * contract with a per-module validation hook: `authMode`/`password`/`privateKey` is the only
 * cross-field pair the `sftp` module's config has, so a general hook would be built and coordinated
 * across `models/storage.ts` for a single call site. Called at the very top of `connectSftp`, before
 * any network I/O, so a misconfigured target fails fast with one complete, specific sentence.
 */
function validateAuthConfig(config: SftpTargetConfig): void {
  if (config.authMode === 'password') {
    if (!config.password || !config.password.trim()) {
      throw new Error(
        'This target uses password authentication, but no password is configured. Set a password, or switch to private-key authentication.'
      )
    }
  } else if (config.authMode === 'privateKey') {
    if (!config.privateKey || !config.privateKey.trim()) {
      throw new Error(
        'This target uses private-key authentication, but no private key is configured. Paste the private key contents, or switch to password authentication.'
      )
    }
  } else {
    throw new Error(
      `"${config.authMode}" is not a supported authentication method. Use "password" or "privateKey".`
    )
  }
}

/**
 * Open a connected, verified SFTP client for a target's config.
 *
 * Verifies that `basePath` exists, is a directory, and is writable by the configured user — the admin
 * area only ever shows the plain `Error#message` this throws (via `models/storage.ts`'s
 * `executeAction`), so every failure here is written as a complete, specific sentence rather than
 * left to whatever `ssh2-sftp-client` or the underlying `ssh2` library happened to say.
 *
 * @param createClient Swappable for a stub in tests; defaults to a real `ssh2-sftp-client` instance.
 * @throws A Error describing what went wrong: an `authMode`/credential mismatch caught before any
 *   network I/O (`validateAuthConfig`), bad credentials, an unreachable host, or a `basePath` that is
 *   missing, not a directory, or not writable.
 */
export async function connectSftp(
  config: SftpTargetConfig,
  createClient: SftpClientFactory = () => new Client()
): Promise<Client> {
  validateAuthConfig(config)

  const client = createClient()

  const connectOptions: Record<string, unknown> = {
    host: config.host,
    port: config.port,
    username: config.username
  }
  if (config.authMode === 'password') {
    connectOptions.password = config.password
  } else {
    connectOptions.privateKey = config.privateKey
    if (config.passphrase) {
      connectOptions.passphrase = config.passphrase
    }
  }

  try {
    await client.connect(connectOptions)
  } catch (err: any) {
    throw new Error(
      `Could not connect to ${config.host}:${config.port} over SFTP as "${config.username}": ${err.message}`
    )
  }

  try {
    await verifyBasePath(client, config)
  } catch (err) {
    await closeQuietly(client)
    throw err
  }

  return client
}

/**
 * Confirm `basePath` exists, is a directory, and can actually be written to — checked with a
 * throwaway marker file rather than inspecting permission bits, since the SFTP protocol never tells
 * the client which uid/gid it authenticated as.
 */
async function verifyBasePath(client: Client, config: SftpTargetConfig): Promise<void> {
  const basePath = config.basePath

  let entryType: false | 'd' | '-' | 'l'
  try {
    entryType = await client.exists(basePath)
  } catch (err: any) {
    throw new Error(
      `Could not read the base directory "${basePath}" on ${config.host}: ${err.message}`
    )
  }
  if (entryType === false) {
    throw new Error(
      `The base directory "${basePath}" does not exist on ${config.host}. Create it first, or fix the configured path.`
    )
  }
  if (entryType !== 'd') {
    throw new Error(`"${basePath}" exists on ${config.host}, but is not a directory.`)
  }

  const marker = `${basePath.replace(/\/+$/, '')}/.cardinaljs-write-test-${Date.now()}`
  try {
    await client.put(Buffer.from(''), marker)
    await client.delete(marker)
  } catch (err: any) {
    throw new Error(
      `The base directory "${basePath}" is not writable by "${config.username}" on ${config.host}: ${err.message}`
    )
  }
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.end()
  } catch {
    // -> Already unwinding from a real error; a second failure closing the connection isn't worth
    //    surfacing over the one that got us here.
  }
}

/**
 * Create every path segment of `relativePath` under `basePath` that doesn't already exist, one
 * segment at a time — mirroring the segment-by-segment approach 2.5.x's own `ensureDirectory` took,
 * rather than relying on `ssh2-sftp-client`'s own recursive `mkdir(path, true)`, so that a segment
 * created concurrently by another process (or already present from a prior run) is tolerated instead
 * of failing the whole export.
 *
 * `relativePath` is a directory path relative to `basePath` — the folder a file will be written into,
 * not the file itself.
 */
export async function ensureDirectory(
  client: Client,
  basePath: string,
  relativePath: string
): Promise<void> {
  const segments = relativePath.split('/').filter((segment) => segment.length > 0)
  let current = basePath.replace(/\/+$/, '')

  for (const segment of segments) {
    current = `${current}/${segment}`

    let entryType: false | 'd' | '-' | 'l'
    try {
      entryType = await client.exists(current)
    } catch (err: any) {
      throw new Error(`Could not check directory "${current}" on the SFTP target: ${err.message}`)
    }

    if (entryType === false) {
      try {
        await client.mkdir(current)
      } catch (err: any) {
        // -> Tolerate a segment that already exists (e.g. created by a concurrent export): only fail
        //    if it's still genuinely missing after the attempt.
        const recheck = await client.exists(current)
        if (recheck === false) {
          throw new Error(
            `Could not create directory "${current}" on the SFTP target: ${err.message}`
          )
        }
        entryType = recheck
      }
    }

    if (entryType !== false && entryType !== 'd') {
      throw new Error(`"${current}" exists on the SFTP target, but is not a directory.`)
    }
  }
}
