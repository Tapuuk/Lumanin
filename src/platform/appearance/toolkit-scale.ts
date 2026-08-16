import type { Exec } from '../exec'

/**
 * The text scale the toolkit under Chromium has *already* applied.
 *
 * Measured on Omarchy 4 / Hyprland, Electron 43, 2026-08-16: with GNOME's
 * `text-scaling-factor` at 1.18 (what `omarchy display text size 14` writes,
 * beside the shell's `base-size = 14`) the renderer reports
 * `devicePixelRatio = 1.25 × 1.18 × zoom` on a 1.25-scale output. Chromium's
 * GTK layer reads `gtk-xft-dpi` - which GTK derives from that gsettings key on
 * Wayland - and multiplies it into the device scale factor. So the desktop's
 * text size reaches us twice if we also zoom by it: once from Chromium, once
 * from us. The zoom we apply is therefore `wanted / alreadyApplied`.
 *
 * Only gsettings is consulted, because that is what GTK reads (via GSettings on
 * Wayland, via XSETTINGS - fed from the same key by gsd-xsettings - on X11). A
 * machine with no `gsettings` binary has no GTK text scaling to double-count.
 */
export async function readToolkitTextScale(exec: Exec, gsettings: string | null): Promise<number> {
  if (gsettings === null) return 1
  const result = await exec.run(gsettings, ['get', 'org.gnome.desktop.interface', 'text-scaling-factor'])
  if (!result.ok) return 1
  const factor = Number(result.stdout.trim())
  return Number.isFinite(factor) && factor >= 0.5 && factor <= 4 ? factor : 1
}
