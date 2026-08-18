import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { dirname } from 'node:path'
import { parseRequest, type Request, type Response } from '../shared/protocol'
import type { Logger } from '../node/logger'

/**
 * The control socket at `$XDG_RUNTIME_DIR/lumanin.sock`.
 *
 * This is what makes `lumanin toggle` a ~5 ms operation instead of an Electron
 * cold start, which is the difference between a launcher that feels instant and
 * one that does not. It is also the substrate for compositor binds and user
 * scripts, so its wire format is a contract, not an implementation detail.
 *
 * Framing: newline-delimited JSON, one `Request` per line, one `Response` per
 * line. Chosen over anything richer because `printf '{"id":1,"verb":{"kind":"toggle"}}\n'
 * | nc -U` should work.
 *
 * Local IPC rules:
 *   - Unix socket only. There is no TCP listener and there never will be.
 *   - Socket mode 0600, inside a directory this code verifies is user-owned and
 *     not group/world accessible.
 *   - Verbs are a closed allow-list; anything else is rejected without effect.
 */

const MAX_FRAME_BYTES = 4096

export type VerbHandler = (request: Request) => Response | Promise<Response>

export interface SocketServerDeps {
  readonly socketPath: string
  readonly logger: Logger
  readonly handle: VerbHandler
  readonly uid: number
}

/**
 * Node exposes no portable way to read a Unix peer's credentials (there is no
 * SO_PEERCRED binding), so peer identity is enforced structurally rather than per
 * connection: the socket lives in a directory that only this uid can traverse.
 * If that directory is not private, we refuse to listen at all rather than
 * pretend the socket is protected.
 */
export function assertPrivateRuntimeDir(dir: string, uid: number): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stats = statSync(dir)

  if (stats.uid !== uid) {
    throw new Error(`refusing to listen: ${dir} is owned by uid ${String(stats.uid)}, not ${String(uid)}`)
  }
  if ((stats.mode & 0o077) !== 0) {
    const mode = (stats.mode & 0o777).toString(8)
    throw new Error(`refusing to listen: ${dir} is group/world accessible (mode ${mode})`)
  }
}

/**
 * A socket file left behind by a crashed daemon would block `listen`. Removing it
 * is safe only once we know nobody is answering on it — otherwise a second daemon
 * would silently steal the first one's socket.
 */
async function clearStaleSocket(path: string, logger: Logger): Promise<void> {
  try {
    statSync(path)
  } catch {
    return // Nothing there; nothing to clear.
  }

  const alive = await new Promise<boolean>((resolve) => {
    const probe = new Socket()
    const done = (result: boolean): void => {
      probe.destroy()
      resolve(result)
    }
    probe.setTimeout(250, () => done(true))
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    probe.connect(path)
  })

  if (alive) {
    throw new Error(`another daemon is already listening on ${path}`)
  }

  logger.warn('removing stale socket from a previous run', { path })
  unlinkSync(path)
}

export class ControlSocket {
  private server: Server | null = null

  constructor(private readonly deps: SocketServerDeps) {}

  async listen(): Promise<void> {
    const { socketPath, logger, uid } = this.deps

    assertPrivateRuntimeDir(dirname(socketPath), uid)
    await clearStaleSocket(socketPath, logger)

    const server = createServer((socket) => this.onConnection(socket))
    this.server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    // Belt and braces alongside the directory check: the socket itself is 0600.
    chmodSync(socketPath, 0o600)
    logger.info('control socket listening', { path: socketPath })

    server.on('error', (error) => logger.error('control socket error', { error }))
  }

  private onConnection(socket: Socket): void {
    const { logger } = this.deps
    let buffer = ''

    socket.setEncoding('utf8')
    socket.on('error', (error) => logger.debug('client socket error', { error }))

    socket.on('data', (chunk: string) => {
      buffer += chunk

      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void this.dispatch(socket, line)
        newline = buffer.indexOf('\n')
      }

      // A client that never sends a newline must not be able to grow our heap.
      // The cap applies to the *unterminated remainder*, not to everything that
      // arrived: measuring the whole buffer killed clients that pipelined several
      // perfectly valid frames into one write, which is exactly what
      // `printf '…\n…\n' | nc -U` does — the usage the wire format promises.
      const pending = Buffer.byteLength(buffer, 'utf8')
      if (pending > MAX_FRAME_BYTES) {
        logger.warn('client exceeded frame limit; closing', { bytes: pending })
        socket.destroy()
      }
    })
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    const { logger, handle } = this.deps
    if (line.trim().length === 0) return

    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      this.reply(socket, { id: 0, ok: false, error: 'malformed frame: expected one JSON object per line' })
      return
    }

    const request = parseRequest(frame)
    if (request === null) {
      // Deliberately terse: we do not echo the rejected input back.
      this.reply(socket, { id: 0, ok: false, error: 'rejected: not a recognised verb' })
      logger.warn('rejected socket frame')
      return
    }

    try {
      this.reply(socket, await handle(request))
    } catch (error) {
      logger.error('verb handler threw', { verb: request.verb.kind, error })
      this.reply(socket, { id: request.id, ok: false, error: 'internal error' })
    }
  }

  private reply(socket: Socket, response: Response): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify(response)}\n`)
  }

  close(): void {
    this.server?.close()
    this.server = null
    try {
      unlinkSync(this.deps.socketPath)
    } catch {
      // Already gone, or never created. Either way there is nothing to clean up.
    }
  }
}
