import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThemeService } from '../src/main/theme'
import { Logger } from '../src/node/logger'
import type { AppearanceBackend, AppearanceSignal } from '../src/platform/appearance/index'
import { loadConfig } from '../src/shared/config'
import { contrast, parseHex } from '../src/shared/theme/colour'
import type { ThemePayload } from '../src/shared/ipc'

/**
 * The resolution chain from THEMING.md: forced theme → desktop appearance →
 * built-in default, first hit wins, live-swapped on change.
 */

const silent = new Logger('error', [])

function config(file = ''): ReturnType<typeof loadConfig> {
  return loadConfig({ fileContents: file, env: {} })
}

class FakeAppearance implements AppearanceBackend {
  readonly id = 'fake'
  private listener: (() => void) | null = null

  constructor(private signal: AppearanceSignal | null) {}

  read(): Promise<AppearanceSignal | null> {
    return Promise.resolve(this.signal)
  }

  watch(onChange: () => void): () => void {
    this.listener = onChange
    return () => {
      this.listener = null
    }
  }

  /** Pretend the desktop changed theme. */
  emit(signal: AppearanceSignal | null): void {
    this.signal = signal
    this.listener?.()
  }
}

const OMARCHY_SIGNAL: AppearanceSignal = {
  source: 'Omarchy theme "gruvbox"',
  seed: {
    meta: { name: 'gruvbox', id: 'omarchy:gruvbox' },
    colours: { bg: '#282828', text: '#ebdbb2', accent: '#458588' }
  }
}

function service(
  options: { file?: string; appearance?: AppearanceBackend; configDir?: string } = {}
): { theme: ThemeService; changes: ThemePayload[] } {
  const changes: ThemePayload[] = []
  const theme = new ThemeService({
    config: () => config(options.file ?? ''),
    configDir: options.configDir ?? mkdtempSync(join(tmpdir(), 'lumanin-cfg-')),
    logger: silent,
    onChange: (payload) => changes.push(payload)
  })
  return { theme, changes }
}

describe('ThemeService', () => {
  it('has a complete theme before any probe has run', async () => {
    // The hotkey can fire before the platform probes finish. A renderer handed
    // no tokens paints invisible text, so "not resolved yet" is not an option.
    const { theme } = service()
    expect(theme.payloadNow.meta.id).toBe('tokyo-night')
    expect(theme.payloadNow.cssVars['--lumanin-bg']).toBe('#1a1b26')
    await Promise.resolve()
  })

  it("adopts the desktop's palette once the appearance backend attaches", async () => {
    const { theme, changes } = service()
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.meta.id).toBe('omarchy:gruvbox')
    expect(theme.payloadNow.cssVars['--lumanin-bg']).toBe('#282828')
    expect(changes).toHaveLength(1)
    theme.dispose()
  })

  it('hot-swaps when the desktop theme changes, without a reload', async () => {
    // The flagship integration: `omarchy theme set` has to land here instantly,
    // or we merely know about the desktop rather than following it.
    const appearance = new FakeAppearance(OMARCHY_SIGNAL)
    const { theme, changes } = service({ appearance })
    await theme.attach(appearance, false)

    appearance.emit({
      source: 'Omarchy theme "latte"',
      seed: { meta: { name: 'latte', id: 'omarchy:latte' }, colours: { bg: '#eff1f5', text: '#4c4f69' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(theme.payloadNow.meta.id).toBe('omarchy:latte')
    expect(theme.payloadNow.meta.variant).toBe('light')
    expect(changes).toHaveLength(2)
    theme.dispose()
  })

  it('does not repaint when the source rewrote the same palette', async () => {
    // `omarchy theme set` regenerates `colors.toml` every time, including when
    // the theme did not actually change. Repainting on that is a visible flash
    // for no reason.
    const appearance = new FakeAppearance(OMARCHY_SIGNAL)
    const { theme, changes } = service({ appearance })
    await theme.attach(appearance, false)
    appearance.emit({ ...OMARCHY_SIGNAL })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(changes).toHaveLength(1)
    theme.dispose()
  })

  it('lets a forced theme beat the desktop', async () => {
    const { theme } = service({ file: '[appearance]\ntheme = "tokyo-day"\n' })
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.meta.id).toBe('tokyo-day')
    theme.dispose()
  })

  it('falls through the chain when the forced theme does not exist', async () => {
    // A typo in `config.toml` must not leave the launcher unthemed.
    const { theme } = service({ file: '[appearance]\ntheme = "no-such-theme"\n' })
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.meta.id).toBe('omarchy:gruvbox')
    theme.dispose()
  })

  it('refuses a forced theme name that is a path', async () => {
    const { theme } = service({ file: '[appearance]\ntheme = "../../../etc/passwd"\n' })
    await theme.attach(new FakeAppearance(null), false)

    expect(theme.payloadNow.meta.id).toBe('tokyo-night')
    theme.dispose()
  })

  it('loads a theme pack from the user config directory', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'lumanin-cfg-'))
    mkdirSync(join(configDir, 'themes', 'mine'), { recursive: true })
    writeFileSync(
      join(configDir, 'themes', 'mine', 'lumanin.toml'),
      '[meta]\nname = "Mine"\n[colors]\nbg = "#010203"\ntext = "#fefefe"\n'
    )

    const { theme } = service({ file: '[appearance]\ntheme = "mine"\n', configDir })
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.meta.name).toBe('Mine')
    expect(theme.payloadNow.cssVars['--lumanin-bg']).toBe('#010203')
    theme.dispose()
  })

  it('stops following the desktop when the user asked it not to', async () => {
    const { theme } = service({ file: '[appearance]\nfollow_system = false\n' })
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.meta.id).toBe('tokyo-night')
    theme.dispose()
  })

  it('zooms by the text size the desktop wants, less what the toolkit already applied', async () => {
    // Omarchy 4 at `omarchy display text size 14`: the shell says 14/12 and
    // gsettings says 1.1818, and Chromium has already multiplied the latter into
    // its device scale. Zooming by 14/12 on top would show text a third larger
    // than the shell's. Within 3% of 1 snaps to exactly 1 - no blur for nothing.
    const { theme } = service()
    await theme.attach(new FakeAppearance({ ...OMARCHY_SIGNAL, textScale: 14 / 12 }), false, () =>
      Promise.resolve(1.1818)
    )
    expect(theme.payloadNow.textScale).toBe(1)
    theme.dispose()
  })

  it('zooms by the whole desktop text scale where the toolkit applied none', async () => {
    const { theme } = service()
    await theme.attach(new FakeAppearance({ ...OMARCHY_SIGNAL, textScale: 1.5 }), false)
    expect(theme.payloadNow.textScale).toBe(1.5)
    theme.dispose()
  })

  it('lets [appearance].text_scale fix the size, still net of the toolkit', async () => {
    const { theme } = service({ file: '[appearance]\ntext_scale = 1.6\n' })
    await theme.attach(new FakeAppearance({ ...OMARCHY_SIGNAL, textScale: 1.1 }), false, () =>
      Promise.resolve(1.25)
    )
    expect(theme.payloadNow.textScale).toBe(1.28)
    theme.dispose()
  })

  it('applies text size even when not following the desktop for colour', async () => {
    const { theme } = service({ file: '[appearance]\nfollow_system = false\n' })
    await theme.attach(new FakeAppearance({ ...OMARCHY_SIGNAL, textScale: 1.5 }), false)
    expect(theme.payloadNow.meta.id).toBe('tokyo-night')
    expect(theme.payloadNow.textScale).toBe(1.5)
    theme.dispose()
  })

  it('picks a light base and tints it from a preference-only source', async () => {
    // What KDE and GNOME give us: no palette, just light/dark and an accent.
    const { theme } = service()
    await theme.attach(
      new FakeAppearance({ source: 'portal', variant: 'light', accent: '#8b2f5a' }),
      false
    )

    expect(theme.payloadNow.meta.id).toBe('tokyo-day')
    expect(theme.payloadNow.cssVars['--lumanin-accent']).toBe('#8b2f5a')
    theme.dispose()
  })

  it('darkens a system accent that would be illegible on the base it landed on', async () => {
    // A desktop accent is chosen to look good in *its* UI, and nothing makes it
    // legible in ours — GNOME's default pink is 2.9:1 on our light base. Taking
    // it literally would make selected rows and the panel outline vanish.
    const { theme } = service()
    await theme.attach(
      new FakeAppearance({ source: 'portal', variant: 'light', accent: '#ff0066' }),
      false
    )

    const accent = theme.payloadNow.cssVars['--lumanin-accent'] as string
    expect(accent).not.toBe('#ff0066')
    expect(contrast(parseHex(accent)!, parseHex(theme.payloadNow.cssVars['--lumanin-bg'] as string)!))
      .toBeGreaterThanOrEqual(3)
    theme.dispose()
  })

  it('keeps motion off when the user turned it off, whatever the theme says', async () => {
    // THEMING.md ORs the user setting with the theme flag and with
    // prefers-reduced-motion. Switching themes must not turn motion back on.
    const { theme } = service({ file: '[appearance]\nanimations = false\n' })
    await theme.attach(new FakeAppearance(OMARCHY_SIGNAL), false)

    expect(theme.payloadNow.cssVars['--lumanin-motion-duration']).toBe('0ms')
    theme.dispose()
  })

  it('renders a glass theme near-opaque until the compositor grants blur', async () => {
    const glass: AppearanceSignal = {
      source: 'Omarchy theme "catppuccin-glass"',
      seed: {
        meta: { name: 'glass', id: 'omarchy:glass' },
        colours: { bg: '#1a1b1e', text: '#cdd6f4' },
        ui: { blur: true, opacity: 0.5 }
      }
    }

    const denied = service()
    await denied.theme.attach(new FakeAppearance(glass), false)
    expect(denied.theme.payloadNow.cssVars['--lumanin-surface-opacity']).toBe('0.97')
    denied.theme.dispose()

    const granted = service()
    await granted.theme.attach(new FakeAppearance(glass), true)
    expect(granted.theme.payloadNow.cssVars['--lumanin-surface-opacity']).toBe('0.5')
    granted.theme.dispose()
  })
})
