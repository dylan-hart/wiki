/**
 * Built directly on `ssh2`'s `Server` rather than any higher-level "sftp server" package: those are
 * either unmaintained (last published years before the `ssh2` major version this repo runs) or pull
 * in dependencies of their own, and the protocol surface this backend's SFTP module needs is small
 * enough to implement against `ssh2`'s server events.
 *
 * Deliberately narrow: only the requests `ssh2-sftp-client` actually issues are handled. READ,
 * RENAME, SYMLINK and extended attributes are unimplemented, because this fork's SFTP storage
 * module never issues them.
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
 * `@types/ssh2` models only the *client* half of the SFTP protocol, so the server-side request
 * events and `status`/`handle`/`attrs` response methods this fixture needs have no upstream types at
 * all — hence a hand-written subset rather than a blanket `any` on the object
 * `session.on('sftp', accept => ...)` hands back.
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

export interface TestSftpUser {
  username: string
  /** Present enables password auth for this user. */
  password?: string
  /** Present (an OpenSSH-format public key line) enables private-key auth for this user. */
  publicKey?: string
}

export interface TestSftpServer {
  port: number
  /** Every SFTP path resolves into this directory on local disk. */
  rootDir: string
  readFile(relativePath: string): Buffer
  exists(relativePath: string): boolean
  /** Every file written so far, relative to `rootDir`, sorted. */
  listFiles(): string[]
  stop(): Promise<void>
}

/** RSA rather than `ed25519`: broadest compatibility with what a real SFTP host offers, and this
 *  repo's own `connectSftp` treats every algorithm identically. */
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
 * `users` is the whole of what this will authenticate. Password auth checks a plain string equality
 * — test-only, never do this in production code; private-key auth verifies both that the offered key
 * matches the configured public key and that its signature is valid.
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

  /** `path.join`, not `path.resolve`, so a leading `/` on the SFTP side is treated as another
   *  segment rather than a reset to filesystem root. */
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
                //    OPEN, and there is nothing meaningful to change here: just acknowledge it.
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
        // -> A rejected auth attempt raises this too; nothing to do beyond not crashing.
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

export function randomSuffix(): string {
  return randomBytes(4).toString('hex')
}
