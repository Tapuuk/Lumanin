import { createAppearance, type AppearanceBackend } from './appearance/index'
import { readToolkitTextScale } from './appearance/toolkit-scale'
import { BACKENDS } from './backends'
import { CAPABILITIES, selectBackend, type CapabilityReport } from './capability'
import { createClipboard, type ClipboardBackend, type SyncTextClipboard } from './clipboard/index'
import type { PlatformProfile } from './detect'
import { systemExec, type Exec } from './exec'
import { createPaste, type PasteBackend } from './paste/index'
import { createSelection, type SelectionBackend } from './selection/index'
import { createWindows, type WindowsBackend } from './windows/index'

/**
 * The platform layer as the rest of the app sees it.
 *
 * Selection happens once, at daemon start, and produces objects — not ids, not
 * booleans to branch on. Nothing above this line ever asks which backend won:
 * that is what keeps `if (isHyprland)` out of every other file, which CLAUDE.md
 * makes a hard rule.
 *
 * `report` is the same data `lumanin doctor` prints. Building it here rather than
 * separately means the report cannot drift from what is actually running — it
 * *is* what is actually running.
 */

export interface PlatformRuntime {
  readonly report: readonly CapabilityReport[]
  readonly clipboard: ClipboardBackend
  readonly paste: PasteBackend
  readonly selection: SelectionBackend
  readonly windows: WindowsBackend
  readonly appearance: AppearanceBackend
  /**
   * The text scale Chromium's toolkit already multiplied into the device scale
   * - see `appearance/toolkit-scale.ts`. Read per theme resolution, because it
   * changes with the same desktop setting the appearance watch reports.
   */
  readonly toolkitTextScale: () => Promise<number>
  /**
   * Whether the compositor will actually blur behind us.
   *
   * The theme engine needs this and must not learn it by asking which compositor
   * is running — a translucent theme falls back to `blurFallbackOpacity` whenever
   * this is false, whatever the reason (see THEMING.md §"Blur / Glass themes").
   */
  readonly blurGranted: boolean
}

export interface RuntimeDeps {
  readonly profile: PlatformProfile
  /** Electron's `clipboard`, injected so this layer never imports Electron. */
  readonly systemClipboard: SyncTextClipboard
  /** `$HOME` and `$XDG_DATA_HOME` — the GTK backend looks for theme directories. */
  readonly home: string
  readonly dataHome: string
  readonly exec?: Exec
}

export function createRuntime(deps: RuntimeDeps): PlatformRuntime {
  const { profile, systemClipboard } = deps
  const exec = deps.exec ?? systemExec

  const report = CAPABILITIES.map((capability) =>
    selectBackend(capability, BACKENDS[capability], profile)
  )
  const chosen = (capability: string): string | null =>
    report.find((entry) => entry.capability === capability)?.chosen ?? null

  // Clipboard has an always-usable backend at the end of its chain, so a null
  // here would mean the chain itself is broken rather than the machine being
  // limited — worth the explicit fallback rather than a non-null assertion.
  const clipboard = createClipboard(chosen('clipboard') ?? 'electron-clipboard', {
    exec,
    systemClipboard
  })

  return {
    report,
    clipboard,
    // Same reasoning: `copy-and-prompt` cannot fail to probe, by design.
    paste: createPaste(chosen('paste') ?? 'copy-and-prompt', { exec, clipboard }),
    // These two *can* legitimately resolve to nothing — GNOME Wayland has no way
    // to read a selection or enumerate windows — so null is passed through and
    // each module answers it in the way its callers can handle.
    selection: createSelection(chosen('selection'), { exec, binaries: profile.binaries }),
    windows: createWindows(chosen('windows'), exec),
    appearance: createAppearance(
      // `CAPABILITIES` is what `report` was built from, so this cannot miss —
      // but a fallback beats an assertion, because the failure mode of being
      // wrong here is an unthemed launcher rather than a caught error.
      report.find((entry) => entry.capability === 'appearance') ?? {
        capability: 'appearance',
        chosen: null,
        status: 'UNSUPPORTED',
        detail: 'the appearance capability was not reported',
        candidates: []
      },
      {
        exec,
        binaries: profile.binaries,
        sources: profile.appearance,
        home: deps.home,
        dataHome: deps.dataHome,
        // The one DE-shaped decision in this file, and it is a *preference*, not
        // a branch: it names which built-in pair a preference-only source should
        // land on. Everything about how that theme is then resolved is identical
        // on every desktop.
        ...(profile.isGnome ? { preferBase: 'adwaita' } : {})
      }
    ),
    toolkitTextScale: () => readToolkitTextScale(exec, profile.binaries.gsettings),
    // `none` is a real, always-usable backend at the end of the windowEffects
    // chain, so "the chain picked none" is the honest answer to "is blur
    // available", not a gap. On Hyprland we additionally *ask* for no blur —
    // most of our window is transparent backdrop — which is why this stays false
    // there until a glass theme turns the rule off (PLATFORM-MATRIX §12).
    blurGranted: chosen('windowEffects') !== null && chosen('windowEffects') !== 'none'
  }
}
