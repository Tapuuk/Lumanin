import type { PlatformProfile } from '../detect'
import { DEFAULT_HOTKEY, bindSpecs, type HotkeyChoice } from './actions'
import { planFixes, type BindPlan, type FixDirs, type FixPlan } from './index'
import type { Hotkey } from '../../shared/hotkey'
import { formatHotkey, parseHotkey, unsupportedModifiers } from '../../shared/hotkey'
import { panelTopFraction } from '../../shared/placement'
import type { ResolvedConfig } from '../../shared/config'

/**
 * The bind flow shared by `lumanin config` and the settings app: which desktops
 * can be written to, which slice of the fix plan binds a key, and what the
 * desktop needs before the key is live. Extracted from the CLI so the two
 * frontends ask the same question the same way on every desktop — including the
 * two that are not files at all (GNOME's dconf) and the two that do not take
 * effect on save (KDE, COSMIC).
 */

/**
 * Every desktop we know a bind mechanism for: Hyprland and sway through their
 * config files, KDE through kglobalshortcutsrc, COSMIC through its RON
 * shortcuts file, GNOME through gsettings. What is left — an unknown
 * compositor, a bare X11 session — gets the "bind it yourself" wording instead
 * of a broken promise.
 */
export function bindable(profile: PlatformProfile): boolean {
  return (
    profile.isHyprland || profile.isSway || profile.isKde || profile.isCosmic || bindableGnome(profile)
  )
}

/**
 * GNOME is bindable only when `gsettings` is there to bind with. A GNOME
 * session without it is unusual but not impossible — a minimal container, a
 * stripped image — and the screen that offers to write a bind has to be able
 * to write one.
 */
export function bindableGnome(profile: PlatformProfile): boolean {
  return profile.isGnome && profile.binaries.gsettings !== null
}

/**
 * The compositor-config half of the fix plan: the key binds and the panel
 * window rule, the two things a setting drives. Nothing else the desktop
 * needs - the autostart entry, the systemd unit - because the settings screens
 * ask one question; installing those is `doctor --fix`'s job, and it asks first.
 *
 * The window rule is in because `[general].top` lives in it: a position saved
 * in `config.toml` that the compositor never hears about is a setting that does
 * nothing, and on Hyprland the rule shares our managed block with the binds
 * anyway, so it was already in every diff.
 */
export function planBind(profile: PlatformProfile, dirs: FixDirs, choice: HotkeyChoice): BindPlan {
  const plan = planFixes(profile, dirs, choice)
  const edits = plan.edits.filter((edit) =>
    edit.actions.some((action) => BIND_ACTIONS.has(action.id) || action.id.startsWith('kde-desktop-'))
  )
  return {
    edits,
    commands: plan.commands,
    notes: [...reloadNotes(profile, { edits, commands: plan.commands }), ...unwritableNotes(profile, choice)]
  }
}

/** The chords this desktop's format cannot spell, which therefore were not written. */
function unwritableNotes(profile: PlatformProfile, choice: HotkeyChoice): readonly string[] {
  if (!profile.isKde && !profile.isCosmic) return []
  const dropped = bindSpecs(choice).filter((spec) => unsupportedModifiers(spec.hotkey).length > 0)
  if (dropped.length === 0) return []
  return [
    `${dropped.map((spec) => formatHotkey(spec.hotkey)).join(', ')}: ${
      profile.isKde ? 'KDE' : 'COSMIC'
    } cannot bind CapsLock as a modifier, so this key was not written. Pick another modifier.`
  ]
}

const BIND_ACTIONS = new Set([
  'hyprland-bind',
  'hyprland-rules',
  'hyprland-lua-bind',
  'hyprland-lua-rules',
  'hyprland-lua-float-guard',
  'hyprland-lua-require',
  'sway-rules',
  'kde-shortcuts',
  'cosmic-shortcuts'
])

/**
 * The full key set the managed block must carry, read from a resolved config.
 *
 * The block is rewritten whole, so every plan must carry *all* the binds — a
 * main-hotkey change that omitted the `[[hotkeys]]` entries would erase them.
 */
export function choiceFromConfig(config: ResolvedConfig): HotkeyChoice {
  const main = parseHotkey(config.general.hotkey.value) ?? DEFAULT_HOTKEY
  const fileSearchRaw = config.fileSearch.hotkey.value.trim()
  const fileSearch: Hotkey | null =
    fileSearchRaw.length === 0 ? null : parseHotkey(fileSearchRaw)

  return {
    hotkey: main,
    explicit: true,
    panelTop: panelTopFraction(config.general.top.value),
    fileSearch,
    extraBinds: config.hotkeys.value.flatMap((binding) => {
      const hotkey = parseHotkey(binding.bind)
      if (hotkey === null) return []
      return [{ hotkey, target: binding.target, ...(binding.title === undefined ? {} : { title: binding.title }) }]
    })
  }
}

/**
 * What has to happen before the changes are live, per desktop.
 *
 * Not a footnote: two of the five mechanisms do not take effect on save, and a
 * tool that writes a keybind and says nothing leaves the user pressing a key
 * that does nothing and concluding the launcher is broken. Only the desktops
 * that were actually written to are mentioned.
 */
export function reloadNotes(
  profile: Pick<PlatformProfile, 'isHyprland' | 'isSway' | 'isKde' | 'isGnome' | 'isCosmic'>,
  plan: Pick<FixPlan, 'edits' | 'commands'>
): readonly string[] {
  const touches = (name: string): boolean =>
    plan.edits.some((edit) => edit.path.includes(name) && edit.state !== 'not-applicable')
  const notes: string[] = []

  if (profile.isHyprland) {
    notes.push('Hyprland reloads its config on save; no restart needed.')
  }
  if (profile.isSway) {
    // sway has no config watcher — the file is re-read only on the reload
    // command. A written bind with no note here is a dead key.
    notes.push('Sway does not re-read its config on save - run: swaymsg reload')
  }
  for (const edit of plan.edits) {
    if (edit.seededFrom === undefined) continue
    notes.push(
      `${edit.path} did not exist, so sway was reading ${edit.seededFrom}. It was created as a copy of ` +
        "that file with Lumanin's block appended, so your defaults are kept - edit the copy from now on. " +
        '`lumanin doctor --unfix` removes our block and leaves the copy, which behaves exactly as the system config did.'
    )
  }
  if (profile.isGnome && plan.commands.length > 0) {
    notes.push('GNOME applies shortcut changes immediately.')
  }
  if (touches('kglobalshortcutsrc')) {
    // The D-Bus command fix (`kde-live-binds`) registers the same binds with
    // the running kglobalacceld, so no logout is needed when it ran. The note
    // stays for the case where only the file was written - a chord Qt could
    // not encode, or a run where the commands were declined or failed.
    if (plan.commands.some((command) => command.id === 'kde-live-binds')) {
      notes.push('KDE is told about the binds over D-Bus; the keys are live immediately.')
    } else {
      notes.push(
        'KDE reads global shortcuts when it starts, so the key is not live yet.\n' +
          '  Log out and back in, or run: systemctl --user restart plasma-kglobalaccel'
      )
    }
  }
  if (touches('kwinrulesrc')) {
    // busctl rather than qdbus: qdbus is `qdbus6` on Arch, `qdbus-qt6` on
    // Fedora and plain `qdbus` elsewhere, while busctl ships with systemd.
    notes.push(
      'KWin reloads its window rules on: busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure'
    )
  }
  if (touches('CosmicSettings.Shortcuts')) {
    notes.push('COSMIC watches its shortcut config; the key is live immediately.')
  }

  return notes
}
