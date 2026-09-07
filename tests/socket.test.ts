import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../src/node/logger'
import { assertPrivateRuntimeDir, ControlSocket } from '../src/main/socket'
import type { Request, Response } from '../src/shared/protocol'
import { coalesceToggle, TOGGLE_COALESCE_MS } from '../src/shared/toggle'

/**
 * Integration coverage for the control socket. This is the app's only local IPC
 * surface and it is treated as an attack surface, so the tests here are
 * about what it *refuses* as much as what it accepts.
 */

const silent = new Logger('error', [])
const uid = process.getuid?.() ?? 0

let dir: string
let socketPath: string
let server: ControlSocket | null = null
let seen: Request[] = []

/** Send a raw line and resolve with the raw reply line. */
function send(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => {
      socket.destroy()
      reject(new Error('timed out waiting for a reply'))
    })
    socket.on('error', reject)
    socket.on('connect', () => socket.write(line))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      socket.destroy()
      resolve(buffer.slice(0, newline))
    })
  })
}

async function startServer(): Promise<void> {
  seen = []
  server = new ControlSocket({
    socketPath,
    logger: silent,
    uid,
    handle: (request: Request): Response => {
      seen.push(request)
      return { id: request.id, ok: true }
    }
  })
  await server.listen()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumanin-socket-test-'))
  chmodSync(dir, 0o700)
  socketPath = join(dir, 'lumanin.sock')
})

afterEach(() => {
  server?.close()
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('assertPrivateRuntimeDir', () => {
  it('accepts a 0700 directory owned by us', () => {
    expect(() => assertPrivateRuntimeDir(dir, uid)).not.toThrow()
  })

  it('refuses to listen in a group- or world-accessible directory', () => {
    // Node cannot read a Unix peer's credentials, so directory privacy is the
    // enforcement. If it does not hold we must not pretend the socket is safe.
    chmodSync(dir, 0o755)
    expect(() => assertPrivateRuntimeDir(dir, uid)).toThrow(/group\/world accessible/)
  })

  it('refuses a directory owned by another uid', () => {
    expect(() => assertPrivateRuntimeDir(dir, uid + 1)).toThrow(/owned by uid/)
  })
})

describe('ControlSocket', () => {
  it('creates the socket with mode 0600', async () => {
    await startServer()
    expect(statSync(socketPath).mode & 0o777).toBe(0o600)
  })

  it('dispatches an allow-listed verb', async () => {
    await startServer()
    const reply = await send(socketPath, '{"id":7,"verb":{"kind":"toggle"}}\n')

    expect(JSON.parse(reply)).toEqual({ id: 7, ok: true })
    expect(seen).toEqual([{ id: 7, verb: { kind: 'toggle' } }])
  })

  it('rejects an unknown verb without invoking the handler', async () => {
    await startServer()
    const reply = await send(socketPath, '{"id":7,"verb":{"kind":"eval","code":"process.exit()"}}\n')

    expect(JSON.parse(reply)).toMatchObject({ ok: false })
    expect(seen).toEqual([])
  })

  it('rejects a malformed frame', async () => {
    await startServer()
    const reply = await send(socketPath, 'not json at all\n')

    expect(JSON.parse(reply)).toMatchObject({ ok: false, error: expect.stringContaining('malformed') })
    expect(seen).toEqual([])
  })

  it('handles several requests on one connection', async () => {
    await startServer()

    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath)
      let replies = 0
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('connect', () => {
        socket.write('{"id":1,"verb":{"kind":"show"}}\n{"id":2,"verb":{"kind":"hide"}}\n')
      })
      socket.on('data', (chunk: string) => {
        replies += chunk.split('\n').filter((line) => line.length > 0).length
        if (replies < 2) return
        socket.destroy()
        resolve()
      })
    })

    expect(seen.map((r) => r.verb.kind)).toEqual(['show', 'hide'])
  })

  it('serves a burst of frames larger than the frame limit', async () => {
    // The cap exists to stop an unterminated frame growing the heap. Applying it
    // to the whole buffer instead of the remainder killed clients that pipelined
    // valid frames — `printf '…\n…\n' | nc -U` is the documented wire usage, and
    // 150 toggles is well past 4 KiB in total while no single frame is close.
    await startServer()
    const count = 150
    const burst = '{"id":1,"verb":{"kind":"toggle"}}\n'.repeat(count)
    expect(burst.length).toBeGreaterThan(4096)

    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath)
      let replies = 0
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('close', () => {
        if (replies < count) reject(new Error(`connection closed after ${String(replies)} replies`))
      })
      socket.on('connect', () => socket.write(burst))
      socket.on('data', (chunk: string) => {
        replies += chunk.split('\n').filter((line) => line.length > 0).length
        if (replies < count) return
        socket.destroy()
        resolve()
      })
    })

    expect(seen).toHaveLength(count)
  })

  it('drops a client that never sends a newline', async () => {
    await startServer()

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(socketPath)
      socket.on('error', () => resolve(true))
      socket.on('close', () => resolve(true))
      socket.on('connect', () => socket.write('x'.repeat(8192)))
      setTimeout(() => resolve(false), 2000)
    })

    expect(closed).toBe(true)
    expect(seen).toEqual([])
  })

  it('refuses to start when another daemon already holds the socket', async () => {
    await startServer()

    const second = new ControlSocket({
      socketPath,
      logger: silent,
      uid,
      handle: (request) => ({ id: request.id, ok: true })
    })

    await expect(second.listen()).rejects.toThrow(/already listening/)
  })

  it('reclaims a socket left behind by a crashed daemon', async () => {
    // A real dangling socket, not an approximation: Node unlinks the file on a
    // graceful `close()`, so the only way to produce the state a crash leaves
    // behind is to have a process bind it and die without closing.
    const child = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer(()=>{}).listen(${JSON.stringify(socketPath)},()=>process.kill(process.pid,'SIGKILL'))`
    ])
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
    expect(statSync(socketPath).isSocket()).toBe(true)

    await expect(startServer()).resolves.toBeUndefined()
    expect(JSON.parse(await send(socketPath, '{"id":1,"verb":{"kind":"ping"}}\n'))).toMatchObject({
      ok: true
    })
  })
})

describe('toggle coalescing', () => {
  it('collapses a held hotkey into one flip', () => {
    // The defect this exists for, reported as "spam the shortcut and it takes
    // longer and longer to open": a compositor bind fires once per key event, so
    // holding the key produced a map/unmap of a Wayland surface every ~30 ms.
    let last: number | null = null
    let flips = 0
    for (const now of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270]) {
      if (!coalesceToggle(now, last)) flips += 1
      // Trailing window: recorded whether or not it acted. With a leading one,
      // every fourth press of a 30 ms repeat gets through — which is how the
      // panel ended up open or closed at random.
      last = now
    }
    expect(flips).toBe(1)
  })

  it('still lets a deliberate second press through', () => {
    expect(coalesceToggle(0, null)).toBe(false)
    expect(coalesceToggle(TOGGLE_COALESCE_MS, 0)).toBe(false)
    expect(coalesceToggle(TOGGLE_COALESCE_MS - 1, 0)).toBe(true)
  })

  it('lets a fast hand through while a 40 Hz repeat still collapses', () => {
    // Hammering the key by hand lands presses about 80-100 ms apart; a held key
    // repeats every 25 ms. Every press of the hand must flip, the repeat must not.
    let last: number | null = null
    let flips = 0
    for (const now of [0, 90, 180, 270, 360]) {
      if (!coalesceToggle(now, last)) flips += 1
      last = now
    }
    expect(flips).toBe(5)
    last = null
    flips = 0
    for (const now of [0, 25, 50, 75, 100, 125, 150]) {
      if (!coalesceToggle(now, last)) flips += 1
      last = now
    }
    expect(flips).toBe(1)
  })
})
