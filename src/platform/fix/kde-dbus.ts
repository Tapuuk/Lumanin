import { APP_ID, APP_DISPLAY_NAME } from '../../shared/identity'
import type { Hotkey } from '../../shared/hotkey'
import type { PlatformProfile } from '../detect'
import type { BindSpec } from './actions'
import type { CommandFix } from './gnome'

/**
 * KDE, the live half: telling kglobalacceld about the bind over D-Bus.
 *
 * The file half (`kde-shortcuts` in actions.ts) writes
 * `[services][lumanin-<id>.desktop]` groups into `kglobalshortcutsrc` - but the
 * daemon reads that file only when a component is first created, which for a
 * fresh install is the next login. Until then the key does nothing, and "log
 * out and back in" is not a sentence a settings screen gets to say.
 *
 * kglobalaccel's own KCM solves this over D-Bus, and this module makes the
 * same calls with `busctl` (which ships with systemd everywhere; `qdbus` is
 * `qdbus6` on Arch and `qdbus-qt6` on Fedora). Verified against the daemon's
 * source (kglobalacceld.cpp, kserviceactioncomponent.cpp) and the Shortcuts
 * KCM (plasma-desktop kcms/keys/globalaccelmodel.cpp):
 *
 * 1. `doRegister(["<name>.desktop", "", "Lumanin", ""])` - the **dummy**
 *    registration. Naming a `.desktop` component makes the daemon materialise
 *    it: it parses the desktop file and registers `_launch` as present, keys
 *    read from the file group we just wrote. The ActionUnique is empty on
 *    purpose - `doRegister` unconditionally replaces the named action with a
 *    fresh, non-present one, so registering `_launch` itself would clobber the
 *    armed shortcut the parse just created. The KCM does exactly this dance.
 * 2. `unregister("<name>.desktop", "")` - drop the dummy again.
 * 3. `setForeignShortcutKeys(actionId, keys)` - set the chord on `_launch`,
 *    on behalf of a component we do not own (that is the "foreign"). The
 *    daemon re-grabs immediately and rewrites `kglobalshortcutsrc` itself
 *    ~500 ms later with the same content we wrote, so the file and the daemon
 *    agree by construction.
 *
 * An actionId is four strings: ComponentUnique, ActionUnique,
 * ComponentFriendly, ActionFriendly (kglobalaccel.h `actionIdFields`).
 *
 * Keys travel as QKeySequence structs: an array of exactly four ints,
 * zero-padded, each `Qt::Key | modifier bits` (kglobalshortcutinfo_dbus.cpp).
 */

const SERVICE = ['org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel'] as const

/** Qt modifier bits, from qnamespace.h (Qt 6). Meta is the Super/Windows key. */
const QT_MODIFIERS: Readonly<Record<string, number>> = {
  shift: 0x02000000,
  ctrl: 0x04000000,
  alt: 0x08000000,
  super: 0x10000000
}

/**
 * Qt::Key values for the non-printable keys our canonical names cover.
 * Letters and digits are their uppercase Latin-1 code; F-keys are
 * `Key_F1 = 0x01000030` upward.
 */
const QT_KEYS: Readonly<Record<string, number>> = {
  escape: 0x01000000,
  tab: 0x01000001,
  backspace: 0x01000003,
  return: 0x01000004,
  insert: 0x01000006,
  delete: 0x01000007,
  home: 0x01000010,
  end: 0x01000011,
  left: 0x01000012,
  up: 0x01000013,
  right: 0x01000014,
  down: 0x01000015,
  prior: 0x01000016,
  next: 0x01000017,
  space: 0x20
}

/**
 * `Qt::Key | modifiers` as one int - `QKeyCombination::toCombined()`.
 * `null` for a key we cannot name in Qt's terms; the caller skips the live
 * call for that bind and the file write remains the (login-delayed) truth.
 */
export function qtCombined(hotkey: Hotkey): number | null {
  let key: number | undefined = QT_KEYS[hotkey.key]
  if (key === undefined) {
    const fn = /^f([0-9]{1,2})$/.exec(hotkey.key)
    if (fn !== null) key = 0x01000030 + Number(fn[1]) - 1
    else if (/^[a-z0-9]$/.test(hotkey.key)) key = hotkey.key.toUpperCase().charCodeAt(0)
  }
  if (key === undefined) return null

  let combined = key
  for (const modifier of hotkey.mods) combined |= QT_MODIFIERS[modifier] ?? 0
  return combined
}

function desktopName(spec: BindSpec): string {
  return `${APP_ID}-${spec.id}.desktop`
}

/** The three busctl calls that make one written bind fire without a logout. */
function liveCalls(spec: BindSpec, combined: number): readonly (readonly string[])[] {
  const name = desktopName(spec)
  const busctl = ['busctl', '--user', 'call', ...SERVICE]
  return [
    [...busctl, 'doRegister', 'as', '4', name, '', APP_DISPLAY_NAME, ''],
    [...busctl, 'unregister', 'ss', name, ''],
    [
      ...busctl,
      'setForeignShortcutKeys',
      'asa(ai)',
      '4', name, '_launch', APP_DISPLAY_NAME, spec.label,
      // One QKeySequence: array of 1 struct, whose int array has 4 entries.
      '1', '4', String(combined), '0', '0', '0'
    ]
  ]
}

/** The undo: an empty key list de-grabs, then the action entry is dropped. */
function undoCalls(spec: BindSpec): readonly (readonly string[])[] {
  const name = desktopName(spec)
  const busctl = ['busctl', '--user', 'call', ...SERVICE]
  return [
    [
      ...busctl,
      'setForeignShortcutKeys',
      'asa(ai)',
      '4', name, '_launch', APP_DISPLAY_NAME, spec.label,
      '0'
    ],
    [...busctl, 'unregister', 'ss', name, '_launch']
  ]
}

/**
 * The live-bind command fix for KDE, shaped like GNOME's: previewed before
 * consent, argv arrays only, `undo` for `--unfix`.
 *
 * `will-add` rather than a read-compare: asking the daemon what is bound now
 * would need a D-Bus round trip at *plan* time, and planning is deliberately
 * read-only and instant. Repeating the calls is idempotent - the dummy
 * register/unregister of an existing component is a no-op pair, and setting
 * keys that are already set changes nothing.
 */
export function planKdeLiveBinds(profile: PlatformProfile, specs: readonly BindSpec[]): CommandFix {
  const bindable = profile.isKde
  const encoded = specs
    .map((spec) => ({ spec, combined: qtCombined(spec.hotkey) }))
    .filter((entry): entry is { spec: BindSpec; combined: number } => entry.combined !== null)

  return {
    id: 'kde-live-binds',
    title: 'Tell kglobalaccel about the binds now',
    why: 'The written shortcut file is only read at login; these D-Bus calls make the keys fire immediately.',
    state: bindable && encoded.length > 0 ? 'will-add' : 'not-applicable',
    commands: bindable ? encoded.flatMap(({ spec, combined }) => liveCalls(spec, combined)) : [],
    undo: bindable ? encoded.flatMap(({ spec }) => undoCalls(spec)) : [],
    preview: bindable
      ? encoded.map(
          ({ spec, combined }) =>
            `busctl call org.kde.KGlobalAccel setForeignShortcutKeys ${desktopName(spec)}/_launch key=${String(combined)}`
        )
      : []
  }
}
