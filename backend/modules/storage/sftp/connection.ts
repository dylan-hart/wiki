import Client from 'ssh2-sftp-client'

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
 * A cross-field check `models/storage.ts`'s generic `validateConfig` cannot express — it validates
 * each prop against `definition.yml` in isolation, with no way to say "`privateKey` is required when
 * `authMode=privateKey`". Without this, a target saved with an empty credential field fails three
 * network round-trips later with ssh2's "All configured authentication methods failed", which says
 * nothing about why.
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
 * The admin area shows only the plain `Error#message` this throws (via `models/storage.ts`'s
 * `executeAction`), so every failure here is written as a complete, specific sentence rather than
 * left to whatever `ssh2-sftp-client` or the underlying `ssh2` library happened to say.
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
 * Writability is proven with a throwaway marker file rather than by inspecting permission bits: the
 * SFTP protocol never tells the client which uid/gid it authenticated as.
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
    // -> Already unwinding from a real error; a failed close isn't worth surfacing over it.
  }
}

/**
 * One segment at a time rather than `ssh2-sftp-client`'s recursive `mkdir(path, true)`, so a segment
 * created concurrently by another export (or left over from a prior run) is tolerated instead of
 * failing the whole export.
 *
 * `relativePath` is the directory a file will be written into, not the file itself.
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
        // -> A concurrent export may have just created it; only fail if it is still missing.
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
