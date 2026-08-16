import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectPlatform, type PlatformProfile } from '../src/platform/detect'
import { applyPlan, planFixes, planRevert, readManagedBinds, type FixDirs } from '../src/platform/fix/index'
import { mergeKwinRule, removeKwinRule } from '../src/platform/fix/kwin'
import { parseStringList, planGnomeBinds, readGnomeBinds, type SettingReader } from '../src/platform/fix/gnome'
import { bindSpecs, desktopExec, ronString, shellQuote } from '../src/platform/fix/actions'
import { planKdeLiveBinds, qtCombined } from '../src/platform/fix/kde-dbus'
import { toCosmic, toGnome, toKde, parseHotkey } from '../src/shared/hotkey'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import type { DbusProbe } from '../src/platform/probe/dbus'
import type { WaylandProtocols } from '../src/platform/probe/wayland'

/**
 * Binding a key on the desktops that are not Hyprland.
 *
 * A launcher whose hotkey cannot be bound is a launcher nobody uses, and until
 * this landed KDE, GNOME and COSMIC had no bind path at all: `doctor --fix`
 * wrote window rules and an autostart entry, and left the actual key to the
 * user. Each of the three stores shortcuts somewhere different and none of them
 * is a list of directives in a text file, which is why they need their own
 * tests rather than another row in the Hyprland ones.
 *
 * All three are **UNVERIFIED** on a real session — the dev machine is Hyprland.
 * What is asserted here is the thing that can be asserted from here: that we
 * produce the file each desktop documents, that we produce it idempotently, and
 * that we never damage what the user already had.
 */

const roots: string[] = []
function temp(): FixDirs {
  const dir = mkdtempSync(join(tmpdir(), 'lumanin-binds-'))
  roots.push(dir)
  return { config: join(dir, 'config'), data: join(dir, 'data') }
}

function binaries(present: readonly string[] = []): BinaryMap {
  const map = {} as Record<string, string | null>
  for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
  return map as BinaryMap
}

const DBUS: DbusProbe = {
  via: 'none',
  available: false,
  hasPortal: 'UNKNOWN',
  hasGlobalShortcuts: 'UNKNOWN',
  hasSettings: 'UNKNOWN',
  hasKWin: 'UNKNOWN',
  hasStatusNotifierWatcher: 'UNKNOWN',
  names: new Set<string>(),
  portalInterfaces: new Set<string>()
}

const PROTOCOLS: WaylandProtocols = {
  hasLayerShell: 'UNKNOWN',
  hasDataControl: 'UNKNOWN',
  hasForeignToplevel: 'UNKNOWN',
  hasVirtualKeyboard: 'UNKNOWN',
  probed: false,
  detail: 'unprobed'
}

function profile(env: Record<string, string>, tools: readonly string[] = []): PlatformProfile {
  return {
    ...detectPlatform(env),
    binaries: binaries(tools),
    dbus: DBUS,
    protocols: PROTOCOLS,
    appearance: {
      configHome: '/nonexistent',
      stateHome: '/nonexistent',
      omarchy: { present: false, currentDir: null, themeDir: null, themeName: null },
      kdeglobals: null,
      cosmicMode: null,
      gtkCss: [],
      niriConfig: null
    }
  }
}

const KDE = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }
const GNOME = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }
const COSMIC = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'COSMIC' }

const SUPER_K = parseHotkey('Super+K') ?? { mods: ['super'] as const, key: 'k' }
const CHOICE = { hotkey: SUPER_K, explicit: true }

function apply(plan: ReturnType<typeof planFixes>): void {
  applyPlan(
    plan.edits.filter((edit) => edit.state === 'will-add' || edit.state === 'will-update'),
    'test'
  )
}

const read = (path: string): string => readFileSync(path, 'utf8')

// ---------------------------------------------------------------------------

describe('each desktop’s spelling of a chord', () => {
  it('writes GTK accelerators for GNOME', () => {
    expect(toGnome(SUPER_K)).toBe('<Super>k')
    expect(toGnome(parseHotkey('Ctrl+Alt+Space') as never)).toBe('<Control><Alt>space')
  })

  it('writes Qt key sequences for KDE, with Qt’s punctuation', () => {
    expect(toKde(SUPER_K)).toBe('Meta+K')
    expect(toKde(parseHotkey('Super+Space') as never)).toBe('Meta+Space')
    // The one that silently produces an empty shortcut if you get it wrong:
    // Qt writes the character, not the keysym name.
    expect(toKde(parseHotkey('Super+period') as never)).toBe('Meta+.')
    expect(toKde(parseHotkey('Ctrl+PageUp') as never)).toBe('Ctrl+PgUp')
  })

  it('writes RON chords for COSMIC, with bare enum modifiers', () => {
    expect(toCosmic(SUPER_K)).toBe('(modifiers: [Super], key: "k")')
    expect(toCosmic(parseHotkey('Super+Shift+grave') as never)).toBe(
      '(modifiers: [Super, Shift], key: "grave")'
    )
    // xkb canonical capitalisation for the multi-character keysyms: COSMIC
    // resolves lowercase too, but only through a fallback that warns in the
    // compositor log on every keymap load.
    expect(toCosmic(parseHotkey('Super+Enter') as never)).toBe(
      '(modifiers: [Super], key: "Return")'
    )
    expect(toCosmic(parseHotkey('Super+PageUp') as never)).toBe(
      '(modifiers: [Super], key: "Prior")'
    )
    expect(toCosmic(parseHotkey('Super+F2') as never)).toBe('(modifiers: [Super], key: "F2")')
  })
})

describe('KDE', () => {
  it('writes a .desktop under the data dir and a shortcut group in the config dir', () => {
    const dirs = temp()
    const plan = planFixes(profile(KDE), dirs, CHOICE)
    apply(plan)

    // The shortcut target has to be somewhere the desktop looks for
    // applications, which is not a config directory.
    const entry = read(join(dirs.data, 'applications', 'lumanin-toggle.desktop'))
    expect(entry).toContain('Exec=lumanin toggle')
    expect(entry).toContain('NoDisplay=true')
    expect(entry).toContain('X-KDE-GlobalAccel-CommandShortcut=true')

    const shortcuts = read(join(dirs.config, 'kglobalshortcutsrc'))
    // Plasma 6 keeps .desktop shortcuts in a nested group with a single-field
    // value; the Plasma 5 triplet (`Meta+K,none,Lumanin`) is migrated-then-
    // deleted by the daemon, which would erase our markers on every login.
    expect(shortcuts).toContain('[services][lumanin-toggle.desktop]')
    expect(shortcuts).toContain('_launch=Meta+K\n')
    expect(shortcuts).not.toContain(',none,')
  })

  it('is idempotent, and reversible', () => {
    const dirs = temp()
    apply(planFixes(profile(KDE), dirs, CHOICE))
    const once = read(join(dirs.config, 'kglobalshortcutsrc'))

    apply(planFixes(profile(KDE), dirs, CHOICE))
    expect(read(join(dirs.config, 'kglobalshortcutsrc'))).toBe(once)

    // The header is a comment, and preserving the *whole* block on a rerun once
    // re-added it above the new copy — one extra line per run, forever.
    expect(once.match(/Added by Lumanin/g)).toHaveLength(1)

    // The file did not exist before us, so reverting takes the whole thing —
    // leaving an empty husk of somebody else's config format is not tidier.
    applyPlan(planRevert(dirs), 'test')
    expect(existsSync(join(dirs.config, 'kglobalshortcutsrc'))).toBe(false)
    expect(existsSync(join(dirs.data, 'applications', 'lumanin-toggle.desktop'))).toBe(false)
  })

  it('gives every [[hotkeys]] bind its own target, and reports them back', () => {
    const dirs = temp()
    const choice = {
      ...CHOICE,
      extraBinds: [{ hotkey: parseHotkey('Super+P') as never, target: 'app:firefox.desktop' }]
    }
    apply(planFixes(profile(KDE), dirs, choice))

    expect(read(join(dirs.data, 'applications', 'lumanin-open-1.desktop'))).toContain(
      'Exec=lumanin open app:firefox.desktop'
    )
    expect(read(join(dirs.config, 'kglobalshortcutsrc'))).toContain('[services][lumanin-open-1.desktop]')

    // What the hotkeys screen shows: the keys that are really bound now.
    expect(readManagedBinds(profile(KDE), dirs).map((bind) => bind.keyText)).toEqual([
      'Meta+K',
      'Meta+P'
    ])
  })

  it('leaves the rest of kglobalshortcutsrc alone', () => {
    const dirs = temp()
    mkdirSync(dirs.config, { recursive: true })
    const theirs = '[kwin]\nShow Desktop=Meta+D,none,Show Desktop\n'
    writeFileSync(join(dirs.config, 'kglobalshortcutsrc'), theirs)

    apply(planFixes(profile(KDE), dirs, CHOICE))
    expect(read(join(dirs.config, 'kglobalshortcutsrc'))).toContain('Show Desktop=Meta+D')

    applyPlan(planRevert(dirs), 'test')
    expect(read(join(dirs.config, 'kglobalshortcutsrc'))).toBe(theirs)
  })

  it('still reports binds after KConfig has stripped our markers', () => {
    // KConfig regenerates the file without comment lines on any Settings
    // change, so the block markers are expected casualties. The binds must be
    // found anyway — and other applications' _launch lines must not be.
    const dirs = temp()
    mkdirSync(dirs.config, { recursive: true })
    writeFileSync(
      join(dirs.config, 'kglobalshortcutsrc'),
      '[services][org.kde.konsole.desktop]\n_launch=Ctrl+Alt+T\n\n' +
        '[services][lumanin-toggle.desktop]\n_launch=Meta+K\n'
    )

    expect(readManagedBinds(profile(KDE), dirs)).toEqual([
      {
        path: join(dirs.config, 'kglobalshortcutsrc'),
        keyText: 'Meta+K',
        hotkey: { mods: ['super'], key: 'k' },
        target: null
      }
    ])
  })
})

describe('KWin window rules', () => {
  it('declares the rule as well as writing it', () => {
    // The failure this exists to prevent: a group KWin never reads, because the
    // file's own [General] manifest does not list it. It would diff cleanly and
    // do nothing.
    const merged = mergeKwinRule('', '{lumanin}', ['wmclass=lumanin', 'noborder=true'])

    expect(merged).toContain('[{lumanin}]')
    expect(merged).toContain('rules={lumanin}')
    expect(merged).toContain('count=1')
  })

  it('keeps rules the user already had, and their order', () => {
    const before = '[{a}]\nwmclass=konsole\n\n[General]\ncount=1\nrules={a}\n'
    const merged = mergeKwinRule(before, '{lumanin}', ['wmclass=lumanin'])

    expect(merged).toContain('rules={a},{lumanin}')
    expect(merged).toContain('count=2')
    expect(merged).toContain('wmclass=konsole')
  })

  it('reconstructs the manifest of a file too old to have one', () => {
    // Plasma used to number its rule groups and record only a count. Reading
    // that as "no rules" and writing a list holding only ours would disable
    // every rule the user has — the one genuinely destructive mistake here.
    const legacy = '[1]\nwmclass=empathy\n\n[2]\nwmclass=icedove\n\n[General]\ncount=2\n'
    const merged = mergeKwinRule(legacy, '{lumanin}', ['wmclass=lumanin'])

    expect(merged).toContain('rules=1,2,{lumanin}')
    expect(merged).toContain('count=3')
  })

  it('is idempotent and removable', () => {
    const before = '[{a}]\nwmclass=konsole\n\n[General]\ncount=1\nrules={a}\n'
    const once = mergeKwinRule(before, '{lumanin}', ['wmclass=lumanin'])
    expect(mergeKwinRule(once, '{lumanin}', ['wmclass=lumanin'])).toBe(once)

    const removed = removeKwinRule(once, '{lumanin}')
    expect(removed).not.toContain('{lumanin}')
    expect(removed).toContain('wmclass=konsole')
    expect(removed).toContain('count=1')
  })

  it('is offered on KDE and nowhere else', () => {
    const dirs = temp()
    const ids = (p: PlatformProfile): string[] =>
      planFixes(p, dirs, CHOICE)
        .edits.filter((edit) => edit.state !== 'not-applicable')
        .flatMap((edit) => edit.actions.map((action) => action.id))

    expect(ids(profile(KDE))).toContain('kwin-rules')
    expect(ids(profile(GNOME))).not.toContain('kwin-rules')
    expect(ids(profile(COSMIC))).not.toContain('kwin-rules')
  })
})

describe('COSMIC', () => {
  const CUSTOM = join('cosmic', 'com.system76.CosmicSettings.Shortcuts', 'v1', 'custom')

  it('writes a RON map, commented the way RON comments', () => {
    const dirs = temp()
    apply(planFixes(profile(COSMIC), dirs, CHOICE))

    const custom = read(join(dirs.config, CUSTOM))
    expect(custom).toContain('(modifiers: [Super], key: "k"): Spawn("lumanin toggle"),')
    // `#` is a syntax error in RON: the file would stop parsing and COSMIC would
    // fall back to its defaults, losing every shortcut the user had set.
    expect(custom).not.toContain('#')
    expect(custom).toContain('// >>> lumanin managed >>>')
    // And it has to be a map, not a block after one.
    expect(custom.trim().startsWith('{')).toBe(true)
    expect(custom.trim().endsWith('}')).toBe(true)
  })

  it('goes inside the braces of a map the user already has', () => {
    const dirs = temp()
    mkdirSync(join(dirs.config, 'cosmic', 'com.system76.CosmicSettings.Shortcuts', 'v1'), {
      recursive: true
    })
    writeFileSync(
      join(dirs.config, CUSTOM),
      '{\n    (modifiers: [Super], key: "t"): Spawn("kitty"),\n}\n'
    )

    apply(planFixes(profile(COSMIC), dirs, CHOICE))
    const custom = read(join(dirs.config, CUSTOM))

    expect(custom).toContain('Spawn("kitty")')
    expect(custom.indexOf('Spawn("lumanin toggle")')).toBeLessThan(custom.lastIndexOf('}'))
  })

  it('handles a map serialised onto one line', () => {
    const dirs = temp()
    mkdirSync(join(dirs.config, 'cosmic', 'com.system76.CosmicSettings.Shortcuts', 'v1'), {
      recursive: true
    })
    writeFileSync(join(dirs.config, CUSTOM), '{ (modifiers: [Super], key: "t"): Spawn("kitty"), }')

    apply(planFixes(profile(COSMIC), dirs, CHOICE))
    const custom = read(join(dirs.config, CUSTOM))

    expect(custom).toContain('Spawn("kitty")')
    expect(custom).toContain('Spawn("lumanin toggle")')
    expect(custom.trim().endsWith('}')).toBe(true)
  })

  it('is idempotent and reversible, and reports what is bound', () => {
    const dirs = temp()
    apply(planFixes(profile(COSMIC), dirs, CHOICE))
    const once = read(join(dirs.config, CUSTOM))
    apply(planFixes(profile(COSMIC), dirs, CHOICE))
    expect(read(join(dirs.config, CUSTOM))).toBe(once)

    expect(readManagedBinds(profile(COSMIC), dirs)).toEqual([
      {
        path: join(dirs.config, CUSTOM),
        keyText: 'modifiers: [Super], key: "k"',
        hotkey: { mods: ['super'], key: 'k' },
        target: null
      }
    ])

    applyPlan(planRevert(dirs), 'test')
    expect(read(join(dirs.config, CUSTOM))).not.toContain('lumanin toggle')
  })

  it('still reports binds after cosmic-settings rewrote the file without our markers', () => {
    // cosmic-settings re-serialises the whole map the first time the user edits
    // any shortcut: entries survive, `//` comments do not. Our Spawn lines are
    // unmistakably ours; the user's are not touched or reported.
    const dirs = temp()
    mkdirSync(join(dirs.config, 'cosmic', 'com.system76.CosmicSettings.Shortcuts', 'v1'), {
      recursive: true
    })
    writeFileSync(
      join(dirs.config, CUSTOM),
      '{\n    (modifiers: [Super], key: "t"): Spawn("kitty"),\n' +
        '    (modifiers: [Super], key: "k"): Spawn("lumanin toggle"),\n}\n'
    )

    expect(readManagedBinds(profile(COSMIC), dirs)).toEqual([
      {
        path: join(dirs.config, CUSTOM),
        keyText: 'modifiers: [Super], key: "k"',
        hotkey: { mods: ['super'], key: 'k' },
        target: null
      }
    ])
  })
})

describe('GNOME', () => {
  const stored = (values: Record<string, string>): SettingReader => (schema, key) =>
    values[`${schema} ${key}`] ?? null

  it('adds its paths to the list without dropping anyone else’s', () => {
    // The array holds every custom shortcut on the machine. Setting it to just
    // ours is how a launcher deletes somebody's screenshot binding.
    const fix = planGnomeBinds(
      profile(GNOME, ['gsettings']),
      bindSpecs(CHOICE),
      stored({
        'org.gnome.settings-daemon.plugins.media-keys custom-keybindings':
          "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/']"
      })
    )

    expect(fix.state).toBe('will-add')
    const list = fix.commands.at(-1)
    expect(list?.at(-1)).toBe(
      "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/', " +
        "'/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumanin-toggle/']"
    )
    // The list goes last: a path in the list before its command is set is a key
    // that briefly runs nothing.
    expect(fix.commands.map((command) => command[3])).toEqual(['name', 'command', 'binding', 'custom-keybindings'])
    expect(fix.commands[2]?.at(-1)).toBe("'<Super>k'")
  })

  it('says nothing needs doing when it is already set', () => {
    const path = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumanin-toggle/'
    const schema = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${path}`
    const values = {
      'org.gnome.settings-daemon.plugins.media-keys custom-keybindings': `['${path}']`,
      [`${schema} name`]: "'Lumanin'",
      [`${schema} command`]: "'lumanin toggle'",
      [`${schema} binding`]: "'<Super>k'"
    }

    const fix = planGnomeBinds(profile(GNOME, ['gsettings']), bindSpecs(CHOICE), stored(values))
    expect(fix.state).toBe('up-to-date')
    expect(fix.commands).toEqual([])

    // And what it reports as bound is what dconf actually holds.
    expect(readGnomeBinds(stored(values))).toEqual([
      { path, keyText: '<Super>k', hotkey: { mods: ['super'], key: 'k' }, target: null }
    ])
  })

  it('drops an entry whose [[hotkeys]] line the user deleted', () => {
    // An orphan in GNOME is not clutter, it is a key that still fires.
    const gone = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/lumanin-open-1/'
    const fix = planGnomeBinds(
      profile(GNOME, ['gsettings']),
      bindSpecs(CHOICE),
      stored({
        'org.gnome.settings-daemon.plugins.media-keys custom-keybindings': `['${gone}']`
      })
    )

    expect(fix.state).toBe('will-update')
    expect(fix.commands.at(-1)?.at(-1)).not.toContain('lumanin-open-1')
    // `--unfix` resets ours and leaves the list holding only other people's.
    expect(fix.undo[0]).toEqual([
      'gsettings',
      'reset-recursively',
      `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${gone}`
    ])
    expect(fix.undo.at(-1)?.at(-1)).toBe('@as []')
  })

  it('is not applicable where gsettings is missing', () => {
    expect(planGnomeBinds(profile(GNOME), bindSpecs(CHOICE), stored({})).state).toBe('not-applicable')
    expect(planGnomeBinds(profile(KDE, ['gsettings']), bindSpecs(CHOICE), stored({})).state).toBe(
      'not-applicable'
    )
  })

  it('reads the GVariant spellings gsettings actually prints', () => {
    expect(parseStringList('@as []')).toEqual([])
    expect(parseStringList("['a', 'b']")).toEqual(['a', 'b'])
    expect(parseStringList(null)).toEqual([])
  })
})

/**
 * One target, five parsers.
 *
 * A pin key is not always tidy — it can end in an item title, so it can contain
 * spaces, quotes and `%`. Three of the five mechanisms hand the line to
 * `/bin/sh -c`, GNOME hands it to GLib's shell parser, and KDE hands it to the
 * Desktop Entry Specification, which recognises **double** quotes only and reads
 * `%f` as a field code. A single pre-quoted string was right in three of those
 * and wrong in the other two — on KDE it produced an argument with two literal
 * apostrophes in it, which is a launch that opens nothing.
 */
describe('quoting a target for each parser', () => {
  const argv = ['lumanin', 'open', 'extension:notes/search#all:a "b" 100%']

  it('quotes for a POSIX shell with single quotes', () => {
    expect(shellQuote(argv)).toBe('lumanin open \'extension:notes/search#all:a "b" 100%\'')
  })

  it('quotes for Exec= with the desktop spec’s rules', () => {
    // Double quotes, backslash-escaped inner quotes, and a doubled `%` so the
    // launcher does not read `%` as the start of a field code.
    expect(desktopExec(argv)).toBe(
      'lumanin open "extension:notes/search#all:a \\"b\\" 100%%"'
    )
  })

  it('escapes the shell line again on the way into RON', () => {
    expect(ronString(shellQuote(argv))).toBe(
      'lumanin open \'extension:notes/search#all:a \\"b\\" 100%\''
    )
  })

  it('leaves a plain target alone in every one of them', () => {
    const plain = ['lumanin', 'open', 'app:firefox.desktop']
    expect(shellQuote(plain)).toBe('lumanin open app:firefox.desktop')
    expect(desktopExec(plain)).toBe('lumanin open app:firefox.desktop')
  })
})

/**
 * The live half of the KDE bind: kglobalshortcutsrc is read only when a
 * component is first created (login, in practice), so the file write alone
 * leaves the key dead until then. These busctl calls are what the Plasma
 * Shortcuts KCM itself makes - verified against kglobalacceld and
 * plasma-desktop source, 2026-08-14 - and every claim a command line encodes
 * (signatures, the dummy-register dance, the Qt integers) is pinned here.
 */
describe('KDE live binds over D-Bus', () => {
  const kdeProfile = profile({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' })

  it('encodes a chord as Qt::Key | modifiers, the QKeySequence wire form', () => {
    // Meta+K: MetaModifier 0x10000000 | Key_K 0x4B.
    expect(qtCombined({ mods: ['super'], key: 'k' })).toBe(268435531)
    // Ctrl+Alt+L: 0x04000000 | 0x08000000 | 0x4C.
    expect(qtCombined({ mods: ['ctrl', 'alt'], key: 'l' })).toBe(201326668)
    // Meta+Shift+R: 0x10000000 | 0x02000000 | 0x52.
    expect(qtCombined({ mods: ['super', 'shift'], key: 'r' })).toBe(301989970)
    // F-keys count up from Key_F1 = 0x01000030.
    expect(qtCombined({ mods: [], key: 'f2' })).toBe(0x01000031)
    // A key Qt cannot name is null, never a guess - the caller skips the live
    // call and the file write stays the (login-delayed) truth.
    expect(qtCombined({ mods: ['super'], key: 'xf86audioplay' })).toBeNull()
  })

  it('registers a dummy, never _launch, before setting the foreign shortcut', () => {
    // doRegister replaces the named action with a fresh *non-present* one, so
    // registering `_launch` itself would disarm the shortcut the .desktop
    // parse just created. The KCM registers an empty-named dummy and drops it;
    // so do we, in exactly that order.
    const fix = planKdeLiveBinds(kdeProfile, bindSpecs({ hotkey: parseHotkey('Super+K') ?? { mods: ['super'], key: 'k' }, explicit: true }))
    expect(fix.state).toBe('will-add')

    const toggle = fix.commands.slice(0, 3)
    expect(toggle[0]?.slice(6)).toEqual(['doRegister', 'as', '4', 'lumanin-toggle.desktop', '', 'Lumanin', ''])
    expect(toggle[1]?.slice(6)).toEqual(['unregister', 'ss', 'lumanin-toggle.desktop', ''])
    expect(toggle[2]?.[6]).toBe('setForeignShortcutKeys')
    // One QKeySequence: 1 struct, 4 ints, zero-padded past the chord.
    expect(toggle[2]?.slice(13)).toEqual(['1', '4', '268435531', '0', '0', '0'])
    // All of it addressed at the daemon, not a shell.
    expect(toggle[0]?.slice(0, 6)).toEqual([
      'busctl', '--user', 'call', 'org.kde.kglobalaccel', '/kglobalaccel', 'org.kde.KGlobalAccel'
    ])
  })

  it('undoes with an empty key list, then drops the action entry', () => {
    const fix = planKdeLiveBinds(kdeProfile, bindSpecs({ hotkey: parseHotkey('Super+K') ?? { mods: ['super'], key: 'k' }, explicit: true }))
    const undo = fix.undo.slice(0, 2)
    // Zero structs = unbind; the trailing unregister removes the entry.
    expect(undo[0]?.slice(13)).toEqual(['0'])
    expect(undo[1]?.slice(6)).toEqual(['unregister', 'ss', 'lumanin-toggle.desktop', '_launch'])
  })

  it('is not offered anywhere but KDE', () => {
    const gnome = profile({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' })
    expect(planKdeLiveBinds(gnome, bindSpecs({ hotkey: { mods: ['super'], key: 'k' }, explicit: true })).state).toBe('not-applicable')
  })
})
