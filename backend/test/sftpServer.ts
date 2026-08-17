/**
 * A real, in-process SFTP server backed by an actual directory on local disk — for integration tests
 * that need to exercise the SFTP wire protocol itself (auth, directory creation, file writes) rather
 * than a stub of `ssh2-sftp-client`'s API surface. Built directly on `ssh2`'s `Server` (already an
 * indirect dependency via `ssh2-sftp-client`, and a direct `devDependency` here) rather than any
 * higher-level "sftp server" package: the ones on npm are either unmaintained (last published years
 * before the `ssh2` major version this repo runs) or pull in dependencies of their own, and the actual
 * protocol surface this backend's SFTP module needs (`connectSftp`/`ensureDirectory`/`client.put`/
 * `client.delete` — see `modules/storage/sftp/connection.ts`) is small enough to implement directly
 * against `ssh2`'s documented server events.
 *
 * Deliberately narrow: only the SFTP requests `ssh2-sftp-client`'s `connect`/`exists`/`mkdir`/`put`/
 * `delete` actually issue are handled (`OPEN`/`FSETSTAT`/`WRITE`/`CLOSE`, `LSTAT`/`STAT`, `MKDIR`,
 * `REMOVE`) — see each SFTP method's `README.md#Commands` history in `ssh2-sftp-client` or the SFTP.md
 * protocol notes shipped with `ssh2` for the full protocol this deliberately doesn't implement (READ,
 * RENAME, SYMLINK, extended attributes, etc.) — this fork's SFTP storage module never issues those.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
// -> `ssh2` is CJS without a `cjs-module-lexer`-detectable named-exports shape, so Node's ESM
//    interop only gives a default export here — destructure from that rather than a named import.
import ssh2 from 'ssh2'
import type { AuthContext, Connection, ParsedKey } from 'ssh2'

const { Server, utils: ssh2Utils } = ssh2
const { STATUS_CODE, OPEN_MODE } = ssh2Utils.sftp

/**
 * `@types/ssh2` only models the *client* half of the SFTP protocol (`SFTPWrapper`'s `open`/`write`/
 * `stat`/... methods, documented there as "Client-only"). The server-side surface this fixture needs
 * — the `OPEN`/`WRITE`/`CLOSE`/`MKDIR`/`STAT`/`LSTAT`/`REMOVE`/`FSETSTAT` request events and the
 * `status`/`handle`/`attrs` response methods `ssh2`'s own server examples use — has no upstream types
 * at all, so this narrows exactly the subset actually used here rather than reaching for a blanket
 * `any` on the object `session.on('sftp', accept => ...)` hands back.
 */
interface ServerSftpStream {
  on(event: 'OPEN', listener: (reqid: number, filename: string, flags: number) => void): this
  on(event: 'FSETSTAT', listener: (reqid: number, handle: Buffer) => void): this
  on(
    event: 'WRITE',
    listener: (reqid: number, handle: Buffer, offset: number, data: Buffer) => void
  ): this
  on(event: 'CLOSE', listener: (reqid: number, handle: Buffer) => void): this
  on(event: 'MKDIR', listener: (reqid: number, path: string) => void): this
  on(event: 'REMOVE', listener: (reqid: number, path: string) => void): this
  on(event: 'STAT' | 'LSTAT', listener: (reqid: number, path: string) => void): this
  status(reqid: number, code: number): void
  handle(reqid: number, handle: Buffer): void
  attrs(reqid: number, attrs: Record<string, number>): void
}

/** One account the test server accepts a connection for. */
export interface TestSftpUser {
  username: string
  /** Present to allow password auth for this user. */
  password?: string
  /** Present (an OpenSSH-format public key line) to allow private-key auth for this user. */
  publicKey?: string
}

export interface TestSftpServer {
  port: number
  /** The real directory on local disk every SFTP path is resolved into. */
  rootDir: string
  /** Read back a file this server wrote, relative to `rootDir` — the assertion surface for a test. */
  readFile(relativePath: string): Buffer
  /** Whether a path exists on disk, relative to `rootDir`. */
  exists(relativePath: string): boolean
  /** Every file path written so far, relative to `rootDir`, sorted — a full "remote file tree". */
  listFiles(): string[]
  stop(): Promise<void>
}

/** A freshly generated RSA keypair, PEM-encoded, optionally passphrase-protected — for private-key
 *  auth tests. RSA rather than `ed25519`: broadest compatibility with what a real SFTP host offers,
 *  and this repo's own `connectSftp` treats every algorithm identically. */
export function generateTestKeyPair(passphrase?: string): {
  privateKey: string
  publicKey: string
} {
  const pair = passphrase
    ? ssh2Utils.generateKeyPairSync('rsa', {
        bits: 2048,
        passphrase,
        cipher: 'aes256-cbc',
        rounds: 16
      })
    : ssh2Utils.generateKeyPairSync('rsa', { bits: 2048 })
  return { privateKey: pair.private, publicKey: pair.public }
}

/**
 * Start an in-process SFTP server on `127.0.0.1` (an ephemeral port), backed by a fresh temp
 * directory. `users` is the whole of what it will authenticate — password auth checks a plain string
 * equality (test-only; never do this in production code), private-key auth verifies both that the
 * offered key matches the configured public key and that its signature is valid.
 */
export async function startTestSftpServer(users: TestSftpUser[]): Promise<TestSftpServer> {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'wiki-sftp-test-'))
  const hostKey = ssh2Utils.generateKeyPairSync('rsa', { bits: 2048 })

  const userMap = new Map<string, { password?: string; allowedKey?: ParsedKey }>()
  for (const user of users) {
    let allowedKey: ParsedKey | undefined
    if (user.publicKey) {
      const parsed = ssh2Utils.parseKey(user.publicKey)
      if (parsed instanceof Error) {
        throw parsed
      }
      allowedKey = parsed
    }
    userMap.set(user.username, { password: user.password, allowedKey })
  }

  /** Resolve an absolute SFTP-side path onto the real backing directory — `path.join` (not
   *  `path.resolve`) so a leading `/` on the SFTP side is treated as another segment, not reset to
   *  filesystem root. */
  const resolveReal = (sftpPath: string): string => path.join(rootDir, sftpPath)

  const server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
    client
      .on('authentication', (ctx: AuthContext) => {
        const account = userMap.get(ctx.username)
        if (!account) {
          return ctx.reject()
        }

        if (ctx.method === 'password') {
          if (account.password && ctx.password === account.password) {
            return ctx.accept()
          }
          return ctx.reject()
        }

        if (ctx.method === 'publickey') {
          const allowedKey = account.allowedKey
          if (
            !allowedKey ||
            ctx.key.algo !== allowedKey.type ||
            !allowedKey.getPublicSSH().equals(ctx.key.data)
          ) {
            return ctx.reject()
          }
          if (ctx.signature && ctx.blob) {
            const verified = allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)
            if (verified !== true) {
              return ctx.reject()
            }
          }
          return ctx.accept()
        }

        return ctx.reject()
      })
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp() as unknown as ServerSftpStream
            const openFiles = new Map<number, number>()
            let nextHandle = 0

            sftp
              .on('OPEN', (reqid: number, filename: string, flags: number) => {
                if (!(flags & OPEN_MODE.WRITE)) {
                  return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
                }
                let fd: number
                try {
                  fd = fs.openSync(resolveReal(filename), 'w')
                } catch {
                  return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                }
                const handleId = nextHandle++
                openFiles.set(handleId, fd)
                const handle = Buffer.alloc(4)
                handle.writeUInt32BE(handleId, 0)
                sftp.handle(reqid, handle)
              })
              .on('FSETSTAT', (reqid: number) => {
                // -> ssh2's client-side WriteStream always issues an FSETSTAT (fchmod) right after
                //    OPEN; a real filesystem-backed server has nothing meaningful to change here, so
                //    this just acknowledges it.
                sftp.status(reqid, STATUS_CODE.OK)
              })
              .on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
                const fd = openFiles.get(handle.readUInt32BE(0))
                if (fd === undefined) {
                  return sftp.status(reqid, STATUS_CODE.FAILURE)
                }
                try {
                  fs.writeSync(fd, data, 0, data.length, offset)
                  sftp.status(reqid, STATUS_CODE.OK)
                } catch {
                  sftp.status(reqid, STATUS_CODE.FAILURE)
                }
              })
              .on('CLOSE', (reqid: number, handle: Buffer) => {
                const handleId = handle.readUInt32BE(0)
                const fd = openFiles.get(handleId)
                if (fd !== undefined) {
                  fs.closeSync(fd)
                  openFiles.delete(handleId)
                }
                sftp.status(reqid, STATUS_CODE.OK)
              })
              .on('MKDIR', (reqid: number, dirPath: string) => {
                try {
                  fs.mkdirSync(resolveReal(dirPath))
                  sftp.status(reqid, STATUS_CODE.OK)
                } catch (err: any) {
                  sftp.status(
                    reqid,
                    err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE
                  )
                }
              })
              .on('REMOVE', (reqid: number, filePath: string) => {
                try {
                  fs.unlinkSync(resolveReal(filePath))
                  sftp.status(reqid, STATUS_CODE.OK)
                } catch {
                  sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                }
              })
              .on('STAT', onStat)
              .on('LSTAT', onStat)

            function onStat(reqid: number, statPath: string) {
              let stat: fs.Stats
              try {
                stat = fs.statSync(resolveReal(statPath))
              } catch {
                return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              }
              const typeBits = stat.isDirectory() ? fs.constants.S_IFDIR : fs.constants.S_IFREG
              sftp.attrs(reqid, {
                mode: typeBits | 0o755,
                uid: 0,
                gid: 0,
                size: stat.size,
                atime: Math.floor(stat.atimeMs / 1000),
                mtime: Math.floor(stat.mtimeMs / 1000)
              })
            }
          })
        })
      })
      .on('error', () => {
        // -> A rejected auth attempt (e.g. the "wrong password" test case) raises a client-side
        //    error event too; nothing for the server side to do beyond not crashing the process.
      })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const listFiles = (): string[] => {
    const results: string[] = []
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel)
        } else {
          results.push(rel)
        }
      }
    }
    walk(rootDir, '')
    return results.sort()
  }

  return {
    port,
    rootDir,
    readFile: (relativePath: string) => fs.readFileSync(path.join(rootDir, relativePath)),
    exists: (relativePath: string) => fs.existsSync(path.join(rootDir, relativePath)),
    listFiles,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(rootDir, { recursive: true, force: true })
    }
  }
}

/** A short random suffix, handy for keeping fixture usernames/base paths unique per test. */
export function randomSuffix(): string {
  return randomBytes(4).toString('hex')
}
