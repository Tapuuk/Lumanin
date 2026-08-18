import type { ResolvedConfig } from '../shared/config'
import { BACKENDS } from './backends'
import { CAPABILITIES, selectBackend, type CapabilityReport, type Status } from './capability'
import { describePlatform, type PlatformProfile } from './detect'

/**
 * `lumanin doctor` — the capability report.
 *
 * The point of this command is to answer two questions without the user reading
 * any source: *what did you pick for each capability*, and *why not the other
 * one*. So every candidate backend is reported, not just the winner, and every
 * configuration value carries the layer that produced it.
 */

export interface ConfigValueReport {
  readonly key: string
  readonly value: string
  readonly layer: string
  readonly origin: string
}

export interface DoctorReport {
  readonly version: string
  readonly platform: string
  readonly session: {
    readonly type: string
    readonly desktops: readonly string[]
  }
  readonly probes: {
    readonly binaries: Readonly<Record<string, string | null>>
    readonly dbus: {
      readonly via: string
      readonly available: string
      readonly portal: string
      readonly globalShortcuts: string
      readonly settings: string
      readonly kwin: string
      readonly statusNotifierWatcher: string
    }
    readonly waylandProtocols: {
      readonly probed: boolean
      readonly detail: string
      readonly layerShell: string
      readonly dataControl: string
      readonly foreignToplevel: string
      readonly virtualKeyboard: string
    }
  }
  readonly capabilities: readonly CapabilityReport[]
  readonly config: readonly ConfigValueReport[]
  readonly configProblems: readonly string[]
}

const tri = (value: true | false | 'UNKNOWN'): string =>
  value === 'UNKNOWN' ? 'UNKNOWN' : value ? 'yes' : 'no'

export function buildReport(
  profile: PlatformProfile,
  config: ResolvedConfig,
  version: string
): DoctorReport {
  const capabilities = CAPABILITIES.map((capability) =>
    selectBackend(capability, BACKENDS[capability], profile)
  )

  const configValues: ConfigValueReport[] = [
    ...Object.entries(config.general),
    ...Object.entries(config.appearance)
  ].map(([key, resolved]) => ({
    key,
    value: String(resolved.value),
    layer: resolved.layer,
    origin: resolved.origin
  }))

  // `[search]` is reported by hand rather than by `Object.entries`: its values
  // are lists of records, and `String(…)` on those prints `[object Object]`.
  // These are worth the lines — "I pinned that and it never showed up" is the
  // same question `doctor` exists to answer for every other setting.
  const { search } = config
  configValues.push(
    {
      key: 'order',
      value: search.fallbackOrder.value.join(', '),
      layer: search.fallbackOrder.layer,
      origin: search.fallbackOrder.origin
    },
    {
      key: 'frecencyWeight',
      value: String(search.frecencyWeight.value),
      layer: search.frecencyWeight.layer,
      origin: search.frecencyWeight.origin
    },
    {
      key: 'engines',
      value:
        search.webSearches.value.length === 0
          ? 'none - no web search will be offered'
          : search.webSearches.value.map((engine) => `${engine.id} (${engine.keyword})`).join(', '),
      layer: search.webSearches.layer,
      origin: search.webSearches.origin
    },
    {
      key: 'pins',
      value: search.pins.value.length === 0 ? 'none' : search.pins.value.join(', '),
      layer: search.pins.layer,
      origin: search.pins.origin
    },
    {
      key: 'rules',
      value:
        search.rules.value.length === 0
          ? 'none'
          : search.rules.value.map((rule) => rule.match).join(', '),
      layer: search.rules.layer,
      origin: search.rules.origin
    },
    // `[file_search]`, by hand for the same reason and one more: its key is the
    // only way into file search, so "why does my key do nothing" has to be
    // answerable here — including the answer "you set it to nothing".
    {
      key: 'fileSearchHotkey',
      value: config.fileSearch.hotkey.value.length === 0 ? 'none - file search has no key' : config.fileSearch.hotkey.value,
      layer: config.fileSearch.hotkey.layer,
      origin: config.fileSearch.hotkey.origin
    },
    {
      key: 'fileSearchOrder',
      value: config.fileSearch.order.value.join(', '),
      layer: config.fileSearch.order.layer,
      origin: config.fileSearch.order.origin
    },
    {
      key: 'fileSearchHideOnOpen',
      value: config.fileSearch.hideOnOpen.value ? 'yes' : 'no',
      layer: config.fileSearch.hideOnOpen.layer,
      origin: config.fileSearch.hideOnOpen.origin
    }
  )

  return {
    version,
    platform: describePlatform(profile),
    session: { type: profile.sessionType, desktops: profile.desktops },
    probes: {
      binaries: profile.binaries,
      dbus: {
        via: profile.dbus.via,
        available: tri(profile.dbus.available),
        portal: tri(profile.dbus.hasPortal),
        globalShortcuts: tri(profile.dbus.hasGlobalShortcuts),
        settings: tri(profile.dbus.hasSettings),
        kwin: tri(profile.dbus.hasKWin),
        statusNotifierWatcher: tri(profile.dbus.hasStatusNotifierWatcher)
      },
      waylandProtocols: {
        probed: profile.protocols.probed,
        detail: profile.protocols.detail,
        layerShell: tri(profile.protocols.hasLayerShell),
        dataControl: tri(profile.protocols.hasDataControl),
        foreignToplevel: tri(profile.protocols.hasForeignToplevel),
        virtualKeyboard: tri(profile.protocols.hasVirtualKeyboard)
      }
    },
    capabilities,
    config: configValues,
    configProblems: config.problems
  }
}

const MARK: Record<Status, string> = {
  OK: '✔',
  DEGRADED: '~',
  UNSUPPORTED: '✘',
  UNVERIFIED: '?',
  PLANNED: '·'
}

/**
 * Human-readable rendering. Deliberately plain text with no colour: this output
 * gets pasted into bug reports, and escape codes make that worse.
 */
export function formatReport(report: DoctorReport, verbose = false): string {
  const lines: string[] = []
  const pad = (text: string, width: number): string => text.padEnd(width)

  lines.push(`Lumanin ${report.version} - ${report.platform}`)
  lines.push('')

  lines.push('Session')
  lines.push(`  type      ${report.session.type}`)
  lines.push(`  desktops  ${report.session.desktops.join(', ') || '(none reported)'}`)
  lines.push('')

  lines.push('Capabilities')
  for (const capability of report.capabilities) {
    lines.push(
      `  ${MARK[capability.status]} ${pad(capability.capability, 17)} ${pad(capability.status, 12)} ${
        capability.chosen ?? '(none)'
      }`
    )
    lines.push(`      ${capability.detail}`)
    if (verbose) {
      for (const candidate of capability.candidates) {
        if (candidate.id === capability.chosen) continue
        lines.push(`      · ${pad(candidate.id, 24)} ${pad(candidate.status, 12)} ${candidate.detail}`)
      }
    }
  }
  lines.push('')

  const missing = Object.entries(report.probes.binaries)
    .filter(([, path]) => path === null)
    .map(([name]) => name)
  const present = Object.entries(report.probes.binaries)
    .filter(([, path]) => path !== null)
    .map(([name]) => name)

  lines.push('Helpers')
  lines.push(`  found    ${present.join(', ') || '(none)'}`)
  lines.push(`  missing  ${missing.join(', ') || '(none)'}`)
  lines.push('')

  lines.push('D-Bus')
  lines.push(`  probed via            ${report.probes.dbus.via}`)
  lines.push(`  desktop portal        ${report.probes.dbus.portal}`)
  lines.push(`  GlobalShortcuts       ${report.probes.dbus.globalShortcuts}`)
  lines.push(`  Settings              ${report.probes.dbus.settings}`)
  lines.push(`  KWin                  ${report.probes.dbus.kwin}`)
  lines.push(`  StatusNotifierWatcher ${report.probes.dbus.statusNotifierWatcher}`)
  lines.push('')

  lines.push('Wayland protocols')
  lines.push(`  ${report.probes.waylandProtocols.detail}`)
  if (report.probes.waylandProtocols.probed) {
    lines.push(`  layer-shell           ${report.probes.waylandProtocols.layerShell}`)
    lines.push(`  data-control          ${report.probes.waylandProtocols.dataControl}`)
    lines.push(`  foreign-toplevel      ${report.probes.waylandProtocols.foreignToplevel}`)
    lines.push(`  virtual-keyboard      ${report.probes.waylandProtocols.virtualKeyboard}`)
  }
  lines.push('')

  lines.push('Configuration (winning layer per value)')
  // Sized to the widest value rather than fixed: a search order or a pin list is
  // far longer than a window height, and a ragged origin column is one more
  // thing to read past when someone is already looking for why a setting lost.
  const valueWidth = Math.min(
    44,
    Math.max(12, ...report.config.map((value) => value.value.length))
  )
  for (const value of report.config) {
    lines.push(`  ${pad(value.key, 16)} ${pad(value.value, valueWidth)} ${value.origin}`)
  }
  if (report.configProblems.length > 0) {
    lines.push('')
    lines.push('Configuration problems')
    for (const problem of report.configProblems) lines.push(`  ! ${problem}`)
  }

  const unverified = report.capabilities.filter((c) => c.status === 'UNVERIFIED')
  if (unverified.length > 0) {
    lines.push('')
    lines.push(
      `${String(unverified.length)} capabilit${unverified.length === 1 ? 'y' : 'ies'} marked UNVERIFIED:`
    )
    lines.push('  the backend probed fine but has never been confirmed working on this desktop.')
    lines.push('  These need a human on that desktop to confirm, not a code change.')
  }

  const planned = report.capabilities.filter((c) => c.status === 'PLANNED')
  if (planned.length > 0) {
    lines.push('')
    lines.push(
      `${String(planned.length)} capabilit${planned.length === 1 ? 'y is' : 'ies are'} PLANNED:`
    )
    lines.push('  your machine supports these; we have not built them yet. Not a fault on your side.')
  }

  if (!verbose) {
    lines.push('')
    lines.push('Run `lumanin doctor --verbose` to see every candidate backend and why it lost.')
  }

  return lines.join('\n')
}
