import type { BinaryMap } from './binaries'
import { run } from './run'

/**
 * D-Bus probe (detection step 4).
 *
 * Deliberately shells out to `busctl`/`gdbus` rather than taking a D-Bus client
 * dependency. We need four yes/no answers at startup, and the dependency set
 * around anything touching the session bus is kept deliberately small.
 * The real D-Bus traffic (portal GlobalShortcuts binds, Settings subscriptions)
 * is a separate concern from *detection* and can take a proper client later.
 */

/**
 * A probe that could not run is not the same answer as a probe that ran and found
 * nothing. A missing probe must never look like "absent", so every finding is
 * three-valued.
 */
export type Tri = true | false | 'UNKNOWN'

export interface DbusProbe {
  /** False when no session bus is reachable at all. */
  readonly available: Tri
  /** Well-known names currently on the session bus. Empty when unavailable. */
  readonly names: ReadonlySet<string>
  /** Interfaces exposed by `org.freedesktop.portal.Desktop`. */
  readonly portalInterfaces: ReadonlySet<string>
  readonly hasPortal: Tri
  readonly hasGlobalShortcuts: Tri
  readonly hasSettings: Tri
  readonly hasKWin: Tri
  readonly hasStatusNotifierWatcher: Tri
  /** How the answers were obtained, for `doctor` to show its working. */
  readonly via: 'busctl' | 'gdbus' | 'none'
}

const UNKNOWN_PROBE: DbusProbe = {
  available: 'UNKNOWN',
  names: new Set(),
  portalInterfaces: new Set(),
  hasPortal: 'UNKNOWN',
  hasGlobalShortcuts: 'UNKNOWN',
  hasSettings: 'UNKNOWN',
  hasKWin: 'UNKNOWN',
  hasStatusNotifierWatcher: 'UNKNOWN',
  via: 'none'
}

const PORTAL_NAME = 'org.freedesktop.portal.Desktop'
const PORTAL_PATH = '/org/freedesktop/portal/desktop'

function parseBusctlNames(stdout: string): Set<string> {
  const names = new Set<string>()
  for (const line of stdout.split('\n')) {
    const name = line.trim().split(/\s+/)[0]
    // Unique names (`:1.42`) are connections, not services worth reporting.
    if (name !== undefined && name.length > 0 && !name.startsWith(':')) names.add(name)
  }
  return names
}

function parseInterfaces(stdout: string): Set<string> {
  const interfaces = new Set<string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*interface\s+([\w.]+)\s*\{?/.exec(line)
    if (match?.[1] !== undefined) interfaces.add(match[1])
  }
  return interfaces
}

export async function probeDbus(binaries: BinaryMap): Promise<DbusProbe> {
  const busctl = binaries.busctl
  const gdbus = binaries.gdbus

  let names = new Set<string>()
  let via: DbusProbe['via'] = 'none'

  if (busctl !== null) {
    const result = await run(busctl, ['--user', 'list', '--no-pager', '--no-legend'])
    if (result.ok) {
      names = parseBusctlNames(result.stdout)
      via = 'busctl'
    }
  }

  if (via === 'none' && gdbus !== null) {
    const result = await run(gdbus, ['call', '--session', '--dest', 'org.freedesktop.DBus',
      '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.ListNames'])
    if (result.ok) {
      for (const match of result.stdout.matchAll(/'([\w.\-:]+)'/g)) {
        const name = match[1]
        if (name !== undefined && !name.startsWith(':')) names.add(name)
      }
      via = 'gdbus'
    }
  }

  // Neither tool present or neither worked: we know nothing, and must say so
  // rather than reporting every D-Bus-backed feature as unsupported.
  if (via === 'none') return UNKNOWN_PROBE

  const hasPortal = names.has(PORTAL_NAME)

  let portalInterfaces = new Set<string>()
  if (hasPortal && gdbus !== null) {
    const result = await run(gdbus, ['introspect', '--session', '--dest', PORTAL_NAME,
      '--object-path', PORTAL_PATH])
    if (result.ok) portalInterfaces = parseInterfaces(result.stdout)
  }

  // With the portal up but introspection unavailable, we cannot tell which
  // portal interfaces exist — that is UNKNOWN, not absent.
  const interfaceKnown = portalInterfaces.size > 0
  const portalInterface = (name: string): Tri =>
    !hasPortal ? false : interfaceKnown ? portalInterfaces.has(name) : 'UNKNOWN'

  return {
    available: true,
    names,
    portalInterfaces,
    hasPortal,
    hasGlobalShortcuts: portalInterface('org.freedesktop.portal.GlobalShortcuts'),
    hasSettings: portalInterface('org.freedesktop.portal.Settings'),
    hasKWin: names.has('org.kde.KWin'),
    hasStatusNotifierWatcher: names.has('org.kde.StatusNotifierWatcher'),
    via
  }
}
