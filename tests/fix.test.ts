import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectPlatform, type PlatformProfile } from '../src/platform/detect'
import { applyPlan, planFixes, planRevert, readManagedBinds, type FixDirs } from '../src/platform/fix/index'
import { choiceFromConfig, planBind, reloadNotes } from '../src/platform/fix/bind'
import { hyprlandCommand, hyprlandLine, launcherOwnedTargets, openTargetOf, shellQuote } from '../src/platform/fix/actions'
import { LAUNCHER_OWNED_TARGETS } from '../src/shared/bind-targets'
import { loadConfig } from '../src/shared/config'
import {
  BLOCK_END,
  BLOCK_START,
  findBlock,
  hasUnterminatedBlock,
  removeBlock,
  upsertBlock
} from '../src/platform/fix/block'
import { PROBED_BINARIES, type BinaryMap } from '../src/platform/probe/binaries'
import type { DbusProbe } from '../src/platform/probe/dbus'
import type { WaylandProtocols } from '../src/platform/probe/wayland'
import { parseHotkey, type Hotkey } from '../src/shared/hotkey'
import { DEFAULT_HOTKEY } from '../src/platform/fix/actions'

/**
 * `doctor --fix` edits files a user's session depends on. Every rule it
 * follows — idempotent, marked, reversible, diffed —
 * is asserted here, against a real temporary config tree.
 */

const roots: string[] = []

/**
 * The two XDG roots an action can target. Almost everything is config; the KDE
 * shortcut target is a `.desktop` file and has to be under the data dir, so the
 * planner takes both and a test that passed one would be testing a different
 * layout from the one that ships.
 */
function dirs(root: string, system?: string): FixDirs {
  return { config: root, data: join(root, 'data'), ...(system === undefined ? {} : { system }) }
}

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lumanin-fix-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  roots.length = 0
})

function binaries(present: readonly string[] = []): BinaryMap {
  const map = {} as Record<string, string | null>
  for (const name of PROBED_BINARIES) map[name] = present.includes(name) ? `/usr/bin/${name}` : null
  return map as BinaryMap
}

function profile(env: Readonly<Record<string, string>>): PlatformProfile {
  return {
    ...detectPlatform(env),
    binaries: binaries(['wl-copy', 'wl-paste', 'hyprctl', 'wayland-info', 'systemctl']),
    dbus: {
      available: 'UNKNOWN',
      names: new Set(),
      portalInterfaces: new Set(),
      hasPortal: 'UNKNOWN',
      hasGlobalShortcuts: 'UNKNOWN',
      hasSettings: 'UNKNOWN',
      hasKWin: 'UNKNOWN',
      hasStatusNotifierWatcher: 'UNKNOWN',
      via: 'none'
    } satisfies DbusProbe,
    protocols: {
      hasLayerShell: 'UNKNOWN',
      hasDataControl: 'UNKNOWN',
      hasForeignToplevel: 'UNKNOWN',
      hasVirtualKeyboard: 'UNKNOWN',
      probed: true,
      detail: 'probed'
    } satisfies WaylandProtocols,
    appearance: {
      configHome: '/config',
      stateHome: '/state',
      omarchy: { present: false, currentDir: null, themeDir: null, themeName: null },
      kdeglobals: null,
      cosmicMode: null,
      gtkCss: [],
      niriConfig: null
    }
  }
}

const HYPRLAND = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'Hyprland' }
const GNOME = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }
const SWAY = { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway' }

describe('marked blocks', () => {
  it('never touches anything outside the markers', () => {
    const original = 'user line 1\nuser line 2\n'
    const written = upsertBlock(original, ['ours'])

    expect(written.startsWith(original)).toBe(true)
    expect(removeBlock(written)).toBe(original)
  })

  it('is idempotent — twice is byte-identical to once', () => {
    const once = upsertBlock('existing\n', ['a', 'b'])
    expect(upsertBlock(once, ['a', 'b'])).toBe(once)
  })

  it('replaces the body in place rather than appending a second block', () => {
    const updated = upsertBlock(upsertBlock('cfg\n', ['old']), ['new'])

    expect(updated.split(BLOCK_START)).toHaveLength(2)
    expect(findBlock(updated)?.body).toEqual(['new'])
  })

  it('does not weld its marker onto a file with no trailing newline', () => {
    const written = upsertBlock('last line without newline', ['ours'])
    expect(written).toContain(`newline\n\n${BLOCK_START}`)
  })

  it('refuses to recognise a block whose end marker was deleted', () => {
    // Rewriting from an unterminated start marker would consume the rest of the
    // user's config.
    const broken = `cfg\n${BLOCK_START}\nours\nmore user config\n`
    expect(findBlock(broken)).toBeNull()
    expect(hasUnterminatedBlock(broken)).toBe(true)
  })

  it('removes the blank line it introduced, leaving the file as it was', () => {
    const original = 'a\nb\n'
    expect(removeBlock(upsertBlock(original, ['x']))).toBe(original)
  })
})

describe('planFixes', () => {
  it('offers the Hyprland rules and bind on Hyprland only', () => {
    const dir = tempConfig()
    const hypr = planFixes(profile(HYPRLAND), dirs(dir)).edits
    const gnome = planFixes(profile(GNOME), dirs(dir)).edits

    const applicable = (edits: typeof hypr): string[] =>
      edits.filter((e) => e.state !== 'not-applicable').flatMap((e) => e.actions.map((a) => a.id))

    expect(applicable(hypr)).toEqual(['hyprland-rules', 'hyprland-bind', 'autostart'])
    // GNOME has no window-rule mechanism; offering one would be a lie.
    expect(applicable(gnome)).toEqual(['autostart'])
  })

  it('keeps an existing block where the user keeps it', () => {
    // Omarchy splits binds into bindings.conf. Moving the block into
    // hyprland.conf would leave a duplicate keybind and look like we broke it.
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(join(dir, 'hypr', 'hyprland.conf'), 'monitor=,preferred,auto,1\n')
    writeFileSync(
      join(dir, 'hypr', 'bindings.conf'),
      `bind = SUPER, Return, exec, foot\n${BLOCK_START}\nbindd = SUPER, K, Lumanin, exec, lumanin toggle\n${BLOCK_END}\n`
    )

    const bind = planFixes(profile(HYPRLAND), dirs(dir)).edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))

    expect(bind?.path).toBe(join(dir, 'hypr', 'bindings.conf'))
  })

  it('writes a [[hotkeys]] bind as a lumanin open line in the same block', () => {
    const dir = tempConfig()
    const plan = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: { mods: ['super'], key: 'k' },
      explicit: true,
      extraBinds: [
        {
          hotkey: { mods: ['super'], key: 'p' },
          target: 'extension:1password/search#logins',
          title: '1Password: Logins'
        }
      ]
    })

    const bind = plan.edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))
    // `##` is hyprlang's literal `#`; see the parser test below for what that
    // line means once Hyprland has read it.
    expect(bind?.diff).toContain("exec, lumanin open 'extension:1password/search##logins'")
    // The description is the row's name, not its key: a person reads this, in
    // `hyprctl binds` and in KDE's shortcut list.
    expect(bind?.diff).toContain('Lumanin: 1Password: Logins')
    // The main toggle bind is still there — the block carries both.
    expect(bind?.diff).toContain('exec, lumanin toggle')
  })

  /**
   * The reported bug, as the format's own parser sees it.
   *
   * `#` starts a comment **anywhere** in a hyprlang line, and every pin key that
   * names a category contains one. Written raw, the line was truncated at the
   * `#` and Hyprland refused the whole config with "Invalid dispatcher,
   * requested "" does not exist" — five fields cut down to three, the dispatcher
   * among the missing.
   *
   * So this asserts the *text*: hyprlang's comment
   * stripping and variable substitution are reimplemented here from
   * `hyprlang/src/config.cpp`, and the command that survives them has to be the
   * command we meant. That is the part provable without a compositor.
   */
  describe('a bind line, as hyprlang parses it', () => {
    /** `parseLine`: `##` is a literal `#`; a lone `#` truncates the line. */
    const stripComments = (line: string): string => {
      if (line.startsWith('#')) return ''
      let out = ''
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== '#') {
          out += line[index]
          continue
        }
        if (line[index + 1] === '#') {
          out += '#'
          index += 1
          continue
        }
        return out
      }
      return out
    }

    /** Variables are a plain string replace of `$name`, for declared names only. */
    const expand = (line: string, variables: Readonly<Record<string, string>>): string =>
      Object.entries(variables).reduce(
        (text, [name, value]) => text.replaceAll(`$${name}`, value),
        line
      )

    const bindLine = (target: string, title?: string): string => {
      const dir = tempConfig()
      const plan = planFixes(profile(HYPRLAND), dirs(dir), {
        hotkey: { mods: ['super'], key: 'k' },
        explicit: true,
        extraBinds: [{ hotkey: { mods: ['alt'], key: 's' }, target, ...(title === undefined ? {} : { title }) }]
      })
      const edit = plan.edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))
      const line = edit?.after.split('\n').find((candidate) => candidate.startsWith('bindd = ALT, S'))
      expect(line).toBeDefined()
      return line ?? ''
    }

    const fieldsOf = (line: string, variables: Readonly<Record<string, string>> = {}): string[] =>
      stripComments(expand(line, variables))
        .replace(/^bindd = /, '')
        .split(',')
        .map((field) => field.trim())

    it('survives the `#` in a category pin with all five fields intact', () => {
      const fields = fieldsOf(bindLine('extension:steam/search-steam#games'))
      expect(fields).toHaveLength(5)
      expect(fields[3]).toBe('exec')
      expect(fields[4]).toBe("lumanin open 'extension:steam/search-steam#games'")
    })

    it('keeps a `$` out of reach of variable substitution', () => {
      // `$mainMod = SUPER` is in every Hyprland config ever written, and
      // hyprlang replaces it by plain string search before the shell is
      // involved. A row whose id contains one must not be rewritten.
      const line = bindLine('extension:x/y#z:$mainMod')
      const fields = fieldsOf(line, { mainMod: 'SUPER' })
      // The protection *is* that `$mainMod` never appears as one string in the
      // file: hyprlang searches for exactly that and finds nothing to replace.
      expect(line).not.toContain('$mainMod')
      expect(fields[4]).not.toContain('SUPER')
      expect(fields[4]).toContain(`'"$"'`)
    })

    it('shell-concatenates that escape back into one argument', () => {
      // `'a'"$"'b'` is three adjacent quoted runs, which a shell joins into
      // `a$b`. Asserted through a real shell rather than by reading the string.
      const line = bindLine('extension:x/y#z:$mainMod')
      const command = fieldsOf(line, { mainMod: 'SUPER' })[4] ?? ''
      const printed = execFileSync(
        '/bin/sh',
        ['-c', command.replace(/^lumanin open /, 'printf %s ')],
        { encoding: 'utf8' }
      )
      expect(printed.trim()).toBe('extension:x/y#z:$mainMod')
    })

    it('reads its own line back as the target it wrote', () => {
      // The other half: `readManagedBinds` compares what is on disk with what is
      // in `config.toml`, so the decode has to be the exact inverse or every
      // plugin bind reports as "not bound yet" for ever.
      const target = 'extension:steam/search-steam#games'
      const dir = tempConfig()
      const options = {
        hotkey: { mods: ['super'] as const, key: 'k' },
        explicit: true,
        extraBinds: [{ hotkey: { mods: ['alt'] as const, key: 's' }, target }]
      }
      applyPlan(planFixes(profile(HYPRLAND), dirs(dir), options).edits, 'stamp')

      const found = readManagedBinds(profile(HYPRLAND), dirs(dir))
      expect(found.map((bind) => bind.target)).toContain(target)
    })
  })

  it('writes the file-search key beside the toggle, and nothing when it is off', () => {
    // `[file_search].hotkey` is the *only* way into file search — its command is
    // not on the root list — so it is as load-bearing as the toggle rather than
    // one of the user's extra binds. It goes through the same planner, into the
    // same block.
    const dir = tempConfig()
    const withKey = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: parseHotkey('Super+R') as Hotkey,
      explicit: true,
      fileSearch: parseHotkey('Super+Shift+R')
    })
    const bind = withKey.edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))
    expect(bind?.after).toContain('bindd = SUPER, R, Lumanin, exec, lumanin toggle')
    // Unquoted: the target needs no shell quoting, and adding some anyway would
    // be quoting for its own sake.
    expect(bind?.after).toContain('exec, lumanin open extension:files/search')
    expect(bind?.after).toContain('SUPER SHIFT, R')

    // Off is a real answer, written as an empty string in the config: no line.
    const without = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: parseHotkey('Super+R') as Hotkey,
      explicit: true,
      fileSearch: null
    })
    const plain = without.edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))
    expect(plain?.after).not.toContain('files/search')
  })

  it('merges two actions that land in the same file into one block', () => {
    // There is one block per file. Planning the rules and the bind separately
    // made the second overwrite the first, so a fresh install silently ended up
    // with window rules and no keybind.
    const dir = tempConfig()
    const plan = planFixes(profile(HYPRLAND), dirs(dir))
    const hyprEdits = plan.edits.filter(
      (e) => e.path.endsWith('hyprland.conf') && e.state !== 'not-applicable'
    )

    expect(hyprEdits).toHaveLength(1)
    expect(hyprEdits[0]?.actions.map((a) => a.id)).toEqual(['hyprland-rules', 'hyprland-bind'])
    expect(hyprEdits[0]?.after).toContain('windowrule = float on')
    expect(hyprEdits[0]?.after).toContain('bindd = SUPER, R')
  })

  it('keeps a keybind the user changed instead of resetting it', () => {
    // Someone who rebound the launcher to Ctrl+Alt+R meant it. An installer that
    // silently restores its own default on every run is one you stop running.
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(
      join(dir, 'hypr', 'bindings.conf'),
      `${BLOCK_START}\nbindd = CTRL ALT, R, Lumanin, exec, lumanin toggle\n${BLOCK_END}\n`
    )

    const edit = planFixes(profile(HYPRLAND), dirs(dir)).edits.find((e) =>
      e.path.endsWith('bindings.conf')
    )

    expect(edit?.after).toContain('bindd = CTRL ALT, R')
    expect(edit?.after).not.toContain('SUPER, K')
  })

  it('writes the hotkey the config actually asks for', () => {
    // The defect this exists for: `[general].hotkey` resolved, `doctor` printed
    // it, and nothing anywhere read it — the bind was hard-coded to Super+K, so
    // changing the setting changed nothing that opens the panel.
    const dir = tempConfig()
    const edit = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: parseHotkey('Ctrl+Alt+Space') as Hotkey,
      explicit: true
    }).edits.find((e) => e.actions.some((a) => a.id === 'hyprland-bind'))

    expect(edit?.after).toContain('bindd = CTRL ALT, SPACE, Lumanin, exec, lumanin toggle')
    // Unbound first: a desktop that already binds the chord sources its own
    // config before ours, and two binds on one chord means the other one wins.
    expect(edit?.after).toContain('unbind = CTRL ALT, SPACE')
  })

  it('lets an explicitly chosen hotkey replace one edited by hand', () => {
    // The other half of the rule below: a hand edit stands until the user says
    // something newer, and setting the hotkey is saying something newer.
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(
      join(dir, 'hypr', 'bindings.conf'),
      `${BLOCK_START}\nbindd = CTRL ALT, R, Lumanin, exec, lumanin toggle\n${BLOCK_END}\n`
    )

    const kept = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: parseHotkey('Super+K') as Hotkey,
      explicit: false
    }).edits.find((e) => e.path.endsWith('bindings.conf'))
    expect(kept?.after).toContain('CTRL ALT, R')

    const replaced = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: parseHotkey('Super+Space') as Hotkey,
      explicit: true
    }).edits.find((e) => e.path.endsWith('bindings.conf'))
    expect(replaced?.after).toContain('bindd = SUPER, SPACE')
    expect(replaced?.after).not.toContain('CTRL ALT, R')
  })

  it('installs a systemd unit as well as the autostart entry, where both apply', () => {
    // Not either/or. GNOME, KDE and XFCE read `~/.config/autostart`; a bare
    // Hyprland or sway session does not read it at all, and that is exactly
    // where "the first few opens take over a second" comes from — the hotkey
    // paying a full Electron cold start. Installing both is safe: the
    // single-instance lock turns the loser into an argv forward that exits.
    const dir = tempConfig()
    const edits = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: DEFAULT_HOTKEY,
      explicit: false,
      daemonCommand: '/opt/lumanin/lumanin'
    }).edits.filter((e) => e.state !== 'not-applicable')

    const unit = edits.find((e) => e.actions.some((a) => a.id === 'systemd-unit'))
    expect(unit?.after).toContain('ExecStart=/opt/lumanin/lumanin')
    // The session target, not `default.target`: on Wayland, starting before
    // there is a session to attach to means no window at all.
    expect(unit?.after).toContain('WantedBy=graphical-session.target')
    expect(edits.some((e) => e.actions.some((a) => a.id === 'autostart'))).toBe(true)
  })

  it('writes the Lua config family when the session uses hyprland.lua', () => {
    // Hyprland reads hyprland.lua *instead of* hyprland.conf when both exist
    // (0.55 deprecated hyprlang; Omarchy 4 has migrated). So on a Lua system
    // the plan is: our own hypr/lumanin.lua with the binds and rules, one
    // guarded require line in the user's hyprland.lua, and not a byte of conf.
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    const userConfig = 'require("hypr.bindings")\n'
    writeFileSync(join(dir, 'hypr', 'hyprland.lua'), userConfig)

    const plan = planFixes(profile(HYPRLAND), dirs(dir))
    const ours = plan.edits.find((e) => e.path.endsWith('hypr/lumanin.lua'))
    expect(ours?.state).toBe('will-add')
    // Binds before rules: they share the file and Lua executes top-down, so a
    // rules error can never cost the hotkey.
    const body = ours?.after ?? ''
    expect(body).toContain('-- >>> lumanin managed >>>')
    expect(body).toContain('hl.unbind("SUPER + R")')
    expect(body).toContain('hl.bind("SUPER + R", hl.dsp.exec_cmd("lumanin toggle")')
    expect(body).toContain('hl.window_rule({')
    expect(body.indexOf('hl.bind(')).toBeLessThan(body.indexOf('hl.window_rule('))
    // The float guard comes last: it is the one part that reacts at runtime,
    // and a Lua error in it must not cost the hotkey or the rules above it.
    expect(body).toContain('hl.on("window.open"')
    expect(body).toContain('hl.on("window.update_rules", lumanin_guard)')
    expect(body).toContain('hl.on("window.pin", lumanin_guard)')
    expect(body).toContain('hl.on("window.fullscreen", lumanin_guard)')
    expect(body).toContain('action = "enable"')
    expect(body).not.toContain('action = "toggle"')
    expect(body.indexOf('hl.window_rule(')).toBeLessThan(body.indexOf('hl.on('))

    const require_ = plan.edits.find((e) => e.path.endsWith('hypr/hyprland.lua'))
    // will-add is the block's state, not the file's - the file exists, our
    // marker block in it does not yet.
    expect(require_?.state).toBe('will-add')
    expect(require_?.after).toContain('pcall(require, "lumanin")')
    // The user's own config survives around the block.
    expect(require_?.after).toContain(userConfig.trim())

    // The conf actions stood down entirely - not blocked, not written.
    const conf = plan.edits.filter((e) => e.path.endsWith('hyprland.conf'))
    expect(conf.every((e) => e.state === 'not-applicable')).toBe(true)
    expect(existsSync(join(dir, 'hypr', 'hyprland.conf'))).toBe(false)
  })

  it('carries the panel position into the bind plan on both Hyprland formats', () => {
    // `[general].top` lives in the window rule, and the settings screens write
    // through planBind - so a changed position must reach the file from there,
    // whether the rule shares the bind's file (.lua, .conf) or not.
    const lua = tempConfig()
    mkdirSync(join(lua, 'hypr'), { recursive: true })
    writeFileSync(join(lua, 'hypr', 'hyprland.lua'), '')
    const luaPlan = planBind(profile(HYPRLAND), dirs(lua), { hotkey: DEFAULT_HOTKEY, explicit: true, panelTop: 0.45 })
    const ours = luaPlan.edits.find((e) => e.path.endsWith('hypr/lumanin.lua'))
    expect(ours?.state).toBe('will-add')
    expect(ours?.after).toContain('move = { "(monitor_w-window_w)/2", "monitor_h*0.45" }')
    expect(ours?.after).not.toContain('center = true')
    expect(ours?.after).toContain('{ description = "Lumanin" }')
    expect(luaPlan.edits.some((e) => e.path.endsWith('hypr/hyprland.lua') && e.state === 'will-add')).toBe(true)

    const conf = tempConfig()
    const confPlan = planBind(profile(HYPRLAND), dirs(conf), { hotkey: DEFAULT_HOTKEY, explicit: true, panelTop: 0.45 })
    const rules = confPlan.edits.find((e) => e.path.endsWith('hypr/hyprland.conf'))
    expect(rules?.after).toContain('monitor_h*0.45')
  })

  it('reads a Lua bind back as exactly the target it wrote', () => {
    // The decode half: `readManagedBinds` compares disk with config.toml, so a
    // bind that does not round-trip reports "not bound yet" for ever. The
    // target is third-party text - quotes and shell metacharacters included.
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(join(dir, 'hypr', 'hyprland.lua'), '')

    const target = `extension:steam/search-steam#games:Half-Life 2!Play "now" $HOME`
    const options = {
      hotkey: DEFAULT_HOTKEY,
      explicit: true,
      fileSearch: parseHotkey('Super+Shift+R') ?? DEFAULT_HOTKEY,
      extraBinds: [{ hotkey: parseHotkey('Ctrl+Alt+G') ?? DEFAULT_HOTKEY, target, label: 'Play' }]
    }
    const plan = planFixes(profile(HYPRLAND), dirs(dir), options)
    for (const edit of plan.edits) {
      if (edit.state === 'will-add' || edit.state === 'will-update') {
        mkdirSync(join(edit.path, '..'), { recursive: true })
        writeFileSync(edit.path, edit.after)
      }
    }

    const binds = readManagedBinds(profile(HYPRLAND), dirs(dir))
    expect(binds.some((bind) => bind.target === target)).toBe(true)
    expect(binds.some((bind) => bind.target === null)).toBe(true)
    // The file-search key: its target has nothing to quote, so the Lua line
    // carries it bare - and it must still read back as bound.
    expect(binds.some((bind) => bind.target === 'extension:files/search')).toBe(true)
  })

  it('keeps the Lua float guard out of the bind reader and stable across rewrites', () => {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(join(dir, 'hypr', 'hyprland.lua'), '')
    const options = { hotkey: DEFAULT_HOTKEY, explicit: true }

    const first = planFixes(profile(HYPRLAND), dirs(dir), options)
    applyPlan(first.edits, 'stamp')
    const written = readFileSync(join(dir, 'hypr', 'lumanin.lua'), 'utf8')
    expect(written).toContain('hl.on("window.update_rules", lumanin_guard)')

    // Planning again against what was written changes nothing.
    const second = planFixes(profile(HYPRLAND), dirs(dir), options)
    const ours = second.edits.find((e) => e.path.endsWith('hypr/lumanin.lua'))
    expect(ours?.state).toBe('up-to-date')

    // The guard's Lua lines are not binds; only the real bind decodes.
    const binds = readManagedBinds(profile(HYPRLAND), dirs(dir))
    expect(binds).toHaveLength(1)
    expect(binds[0]?.target).toBeNull()

    // The hyprlang form has no handlers.
    const conf = first.edits.filter((e) => e.path.endsWith('hyprland.conf'))
    expect(conf.every((e) => !e.after.includes('hl.on('))).toBe(true)
  })

  it('refuses to create a sway config out of nothing', () => {
    // sway reads ~/.config/sway/config *instead of* /etc/sway/config. A fresh
    // user config holding only our block would strip every default keybind on
    // the next reload — the one genuinely destructive write available here.
    const dir = tempConfig()
    const edit = planFixes(profile(SWAY), dirs(dir)).edits.find((e) =>
      e.actions.some((a) => a.id === 'sway-rules')
    )
    expect(edit?.state).toBe('blocked')
    expect(edit?.problem).toContain('/etc/sway/config')

    // With a real user config in place, the same plan writes an anchored rule:
    // sway criteria are unanchored regex searches, so a bare "lumanin" would
    // also float the settings window's `lumanin-settings` app_id.
    mkdirSync(join(dir, 'sway'), { recursive: true })
    writeFileSync(join(dir, 'sway', 'config'), 'bindsym Mod4+Return exec foot\n')
    const written = planFixes(profile(SWAY), dirs(dir)).edits.find((e) =>
      e.actions.some((a) => a.id === 'sway-rules')
    )
    expect(written?.state).toBe('will-add')
    expect(written?.after).toContain('for_window [app_id="^lumanin$"]')
  })

  it('seeds a missing sway config from the system one, byte for byte, then appends the block', () => {
    // sway's own docs say `cp /etc/sway/config ~/.config/sway/config`; that copy
    // is what our block goes onto, so the defaults are kept and the key works.
    const dir = tempConfig()
    const system = join(dir, 'etc')
    mkdirSync(join(system, 'sway'), { recursive: true })
    const original = '# Default config\nset $mod Mod4\nbindsym $mod+Return exec foot\ninclude /etc/sway/config.d/*\n'
    writeFileSync(join(system, 'sway', 'config'), original)

    const plan = planFixes(profile(SWAY), dirs(dir, system))
    const edit = plan.edits.find((e) => e.actions.some((a) => a.id === 'sway-rules'))
    expect(edit?.state).toBe('will-add')
    expect(edit?.after.startsWith(original)).toBe(true)
    expect(edit?.after).toContain('bindsym')
    expect(edit?.after).toContain('for_window [app_id="^lumanin$"]')
    expect(edit?.seededFrom).toBe(join(system, 'sway', 'config'))
    expect(reloadNotes(profile(SWAY), plan).join('\n')).toContain('was created as a copy')

    // Idempotent: the second plan sees the copy and touches only our block.
    applyPlan(plan.edits, 'test-seed')
    const first = readFileSync(join(dir, 'sway', 'config'), 'utf8')
    const again = planFixes(profile(SWAY), dirs(dir, system))
    expect(again.edits.find((e) => e.actions.some((a) => a.id === 'sway-rules'))?.state).toBe('up-to-date')
    applyPlan(again.edits, 'test-seed-2')
    expect(readFileSync(join(dir, 'sway', 'config'), 'utf8')).toBe(first)

    // --unfix removes our block and leaves the copy: byte-exact system config.
    applyPlan(planRevert(dirs(dir, system)), 'test-seed-revert')
    expect(readFileSync(join(dir, 'sway', 'config'), 'utf8')).toBe(original)
  })

  it('still refuses when the system config has a relative include', () => {
    const dir = tempConfig()
    const system = join(dir, 'etc')
    mkdirSync(join(system, 'sway'), { recursive: true })
    writeFileSync(join(system, 'sway', 'config'), 'set $mod Mod4\ninclude config.d/*\n')
    const edit = planFixes(profile(SWAY), dirs(dir, system)).edits.find((e) =>
      e.actions.some((a) => a.id === 'sway-rules')
    )
    expect(edit?.state).toBe('blocked')
    expect(edit?.problem).toContain('relative include')
  })

  it('offers no unit when it does not know what command to put in it', () => {
    // A unit whose ExecStart does not exist is worse than no unit: it fails at
    // every login and says so in a journal nobody reads.
    const dir = tempConfig()
    const edits = planFixes(profile(HYPRLAND), dirs(dir), {
      hotkey: DEFAULT_HOTKEY,
      explicit: false
    }).edits

    expect(edits.some((e) => e.actions.some((a) => a.id === 'systemd-unit'))).toBe(false)
  })

  it('can still remove a unit on a machine that no longer has systemd', () => {
    // `--unfix` has to be able to undo anything that was ever installed, not
    // only what would be installed here today.
    const dir = tempConfig()
    mkdirSync(join(dir, 'systemd', 'user'), { recursive: true })
    writeFileSync(
      join(dir, 'systemd', 'user', 'lumanin.service'),
      `${BLOCK_START}\n[Unit]\n${BLOCK_END}\n`
    )

    expect(planRevert(dirs(dir)).some((e) => e.path.endsWith('lumanin.service'))).toBe(true)
  })

  it('still updates the window rules, which are ours and not a preference', () => {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(
      join(dir, 'hypr', 'hyprland.conf'),
      `${BLOCK_START}\nwindowrule = float on, match:class ^(lumanin)$\n${BLOCK_END}\n`
    )

    const edit = planFixes(profile(HYPRLAND), dirs(dir)).edits.find((e) =>
      e.path.endsWith('hyprland.conf')
    )

    expect(edit?.state).toBe('will-update')
    expect(edit?.after).toContain('windowrule = border_size 0')
  })

  it('reports a hand-broken block as blocked instead of rewriting it', () => {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    const dangerous = `${BLOCK_START}\nours\nevery other setting the user has\n`
    writeFileSync(join(dir, 'hypr', 'hyprland.conf'), dangerous)

    const edit = planFixes(profile(HYPRLAND), dirs(dir)).edits.find((e) => e.actions.some((a) => a.id === 'hyprland-rules'))

    expect(edit?.state).toBe('blocked')
    expect(edit?.after).toBe(edit?.before)
  })

  it('produces a diff before anything is written', () => {
    const dir = tempConfig()
    const edit = planFixes(profile(HYPRLAND), dirs(dir)).edits.find((e) => e.actions.some((a) => a.id === 'hyprland-rules'))

    expect(edit?.diff).toContain('+windowrule = float on')
    // Planning must not have created the file it described.
    expect(existsSync(join(dir, 'hypr', 'hyprland.conf'))).toBe(false)
  })

  it('names the paste helper install command when none is installed', () => {
    const dir = tempConfig()
    const steps = planFixes(profile(HYPRLAND), dirs(dir)).manual.map((s) => s.id)
    expect(steps).toContain('paste-helper')
  })

  it('never proposes running anything as root itself', () => {
    const dir = tempConfig()
    const plan = planFixes(profile(HYPRLAND), dirs(dir))

    // Root steps are printed for the user to run; they are not edits.
    for (const edit of plan.edits) expect(edit.path.startsWith(dir)).toBe(true)
    expect(plan.manual.some((s) => s.commands.some((c) => c.includes('sudo')))).toBe(true)
  })
})

describe('applyPlan and --unfix', () => {
  it('writes, backs up, and can be reverted to the original bytes', () => {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    const original = 'monitor=,preferred,auto,1\nexec-once = waybar\n'
    const path = join(dir, 'hypr', 'hyprland.conf')
    writeFileSync(path, original)

    const plan = planFixes(profile(HYPRLAND), dirs(dir))
    applyPlan(
      plan.edits.filter((e) => e.state === 'will-add' || e.state === 'will-update'),
      'test'
    )

    const written = readFileSync(path, 'utf8')
    expect(written).toContain('windowrule = float on')
    expect(written.startsWith(original)).toBe(true)
    expect(readFileSync(`${path}.lumanin-backup.test`, 'utf8')).toBe(original)

    applyPlan(planRevert(dirs(dir)), 'test2')
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('is idempotent across runs', () => {
    const dir = tempConfig()
    const apply = (): void => {
      const plan = planFixes(profile(HYPRLAND), dirs(dir))
      applyPlan(
        plan.edits.filter((e) => e.state === 'will-add' || e.state === 'will-update'),
        'run'
      )
    }
    apply()
    const first = readFileSync(join(dir, 'hypr', 'hyprland.conf'), 'utf8')
    apply()

    expect(readFileSync(join(dir, 'hypr', 'hyprland.conf'), 'utf8')).toBe(first)
    // Second run had nothing to do, so it made no second backup.
    const backups = readdirSync(join(dir, 'hypr')).filter((f) => f.includes('backup'))
    expect(backups).toHaveLength(0)
  })

  it('deletes a file that was wholly ours rather than leaving an empty husk', () => {
    const dir = tempConfig()
    const plan = planFixes(profile(GNOME), dirs(dir))
    applyPlan(
      plan.edits.filter((e) => e.state === 'will-add'),
      'test'
    )

    const desktop = join(dir, 'autostart', 'lumanin.desktop')
    expect(readFileSync(desktop, 'utf8')).toContain('Exec=lumanin start')

    applyPlan(planRevert(dirs(dir)), 'test2')
    expect(existsSync(desktop)).toBe(false)
  })

  it('leaves no temporary files behind', () => {
    const dir = tempConfig()
    const plan = planFixes(profile(HYPRLAND), dirs(dir))
    applyPlan(
      plan.edits.filter((e) => e.state === 'will-add'),
      'test'
    )

    expect(readdirSync(join(dir, 'hypr')).filter((f) => f.includes('tmp'))).toHaveLength(0)
  })
})

/**
 * Reading the compositor back, which is what stops the settings menu reporting
 * a removal that has not happened.
 *
 * The bug this closes, in the words it was reported in: "when you remove
 * something but then disallow the file edit, the file stays unchanged so the
 * hotkey still works but is removed from the list". The key lives in the
 * compositor's config, not in `config.toml`, so the only honest list is one
 * built from what that file actually says.
 */
describe('readManagedBinds', () => {
  const write = (dir: string, file: string, body: readonly string[]): void => {
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(join(dir, 'hypr', file), `${BLOCK_START}\n${body.join('\n')}\n${BLOCK_END}\n`)
  }

  it('reads the toggle bind and every open bind out of our own block', () => {
    const dir = tempConfig()
    write(dir, 'hyprland.conf', [
      'windowrule = float on, match:class ^(lumanin)$',
      'unbind = SUPER, K',
      'bindd = SUPER, K, Lumanin, exec, lumanin toggle',
      'unbind = SUPER SHIFT, P',
      "bindd = SUPER SHIFT, P, Lumanin open, exec, lumanin open 'app:firefox.desktop'"
    ])

    const binds = readManagedBinds(profile(HYPRLAND), dirs(dir))
    expect(binds).toHaveLength(2)
    expect(binds[0]).toMatchObject({ keyText: 'SUPER, K', target: null })
    expect(binds[1]?.target).toBe('app:firefox.desktop')
    // Parsed back into a hotkey, so a config entry written "Super+Shift+P" can
    // be compared with a line written "SUPER SHIFT, P".
    expect(binds[1]?.hotkey).toEqual(parseHotkey('Super+Shift+P'))
  })

  it('reads a target with comma-space, # and $ back byte-identical', () => {
    // The command used to be re-joined from the split fields with `,`, so a
    // target holding `, ` never equalled the one in config.toml.
    const target = 'extension:godot/search#project:a, b$x!Open project'
    const dir = tempConfig()
    write(dir, 'hyprland.conf', [
      hyprlandLine(`bindd = SUPER, G, Lumanin open, exec, ${hyprlandCommand(['lumanin', 'open', target])}`)
    ])
    expect(readManagedBinds(profile(HYPRLAND), dirs(dir))[0]?.target).toBe(target)
  })

  it('reads a plain target back whether the writer quoted it or not', () => {
    // `shellQuote` leaves a target with nothing to quote bare, which is what
    // the file-search key's target is. The readers accepted only the quoted
    // form, so that key read back as "not bound yet" while it fired fine.
    const plain = 'extension:files/search'
    expect(shellQuote(['lumanin', 'open', plain])).toBe(`lumanin open ${plain}`)
    const dir = tempConfig()
    write(dir, 'hyprland.conf', [
      hyprlandLine(`bindd = SUPER SHIFT, R, Lumanin: Search Files, exec, ${hyprlandCommand(['lumanin', 'open', plain])}`)
    ])
    expect(readManagedBinds(profile(HYPRLAND), dirs(dir))[0]?.target).toBe(plain)

    // Same through sway's syntax.
    const swayDir = tempConfig()
    mkdirSync(join(swayDir, 'sway'), { recursive: true })
    writeFileSync(
      join(swayDir, 'sway', 'config'),
      `${BLOCK_START}\nbindsym Mod4+Shift+r exec ${shellQuote(['lumanin', 'open', plain])}\n${BLOCK_END}\n`
    )
    expect(readManagedBinds(profile(SWAY), dirs(swayDir))[0]?.target).toBe(plain)

    // A quoted target with a quote inside comes back as written to config.
    const quoted = "extension:x/y#a:it's!Open"
    expect(openTargetOf(shellQuote(['lumanin', 'open', quoted]))).toBe(quoted)
    expect(openTargetOf('lumanin toggle')).toBeNull()
    expect(openTargetOf('lumanin open')).toBeNull()
  })

  it('keeps a target containing a comma whole', () => {
    const dir = tempConfig()
    write(dir, 'hyprland.conf', [
      "bindd = SUPER, G, Lumanin open, exec, lumanin open 'extension:godot/search#project:a,b!Open project'"
    ])
    expect(readManagedBinds(profile(HYPRLAND), dirs(dir))[0]?.target).toBe(
      'extension:godot/search#project:a,b!Open project'
    )
  })

  it('reports nothing from a file with no block of ours, and reads sway’s syntax', () => {
    expect(readManagedBinds(profile(HYPRLAND), dirs(tempConfig()))).toEqual([])

    const dir = tempConfig()
    mkdirSync(join(dir, 'sway'), { recursive: true })
    writeFileSync(
      join(dir, 'sway', 'config'),
      `${BLOCK_START}\nbindsym Mod4+p exec lumanin open 'app:firefox.desktop'\n${BLOCK_END}\n`
    )
    const sway = readManagedBinds(profile(SWAY), dirs(dir))
    expect(sway[0]).toMatchObject({ keyText: 'Mod4+p', target: 'app:firefox.desktop' })
    expect(sway[0]?.hotkey).toEqual(parseHotkey('Super+P'))
  })

  it('ignores the user’s own binds, which are none of our business', () => {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(
      join(dir, 'hypr', 'hyprland.conf'),
      `bind = SUPER, Return, exec, foot\n${BLOCK_START}\nbindd = SUPER, K, Lumanin, exec, lumanin toggle\n${BLOCK_END}\n`
    )
    expect(readManagedBinds(profile(HYPRLAND), dirs(dir)).map((bind) => bind.keyText)).toEqual(['SUPER, K'])
  })
})

/**
 * Who wins when `config.toml` and a hand edit to the managed block disagree.
 * The documented rule: a hotkey the user set beats the edit; one left at its default
 * does not. The planner used to assert `explicit` and stamp the edit back.
 */
describe('who wins when the config and the managed block disagree', () => {
  const config = (fileContents: string) => loadConfig({ fileContents, env: {} })
  const hyprEdit = (dir: string, fileContents: string) =>
    planBind(profile(HYPRLAND), dirs(dir), choiceFromConfig(config(fileContents))).edits.find((e) =>
      e.path.endsWith('hypr/hyprland.conf')
    )

  /** A block written for the default key, then the toggle chord edited by hand. */
  function handEdited(): string {
    const dir = tempConfig()
    mkdirSync(join(dir, 'hypr'), { recursive: true })
    writeFileSync(join(dir, 'hypr', 'hyprland.conf'), 'monitor=,preferred,auto,1\n')
    applyPlan(planBind(profile(HYPRLAND), dirs(dir), choiceFromConfig(config(''))).edits, 'stamp')
    const file = join(dir, 'hypr', 'hyprland.conf')
    const written = readFileSync(file, 'utf8')
    const edited = written.replace(/^(bindd = )SUPER, R,/m, '$1SUPER ALT, R,')
    expect(edited).not.toBe(written)
    writeFileSync(file, edited)
    return dir
  }

  it('leaves a hand-edited bind alone when the hotkey is at its default, and still plans the rule', () => {
    const edit = hyprEdit(handEdited(), '')
    expect(edit?.state).toBe('up-to-date')
    expect(edit?.after).toContain('SUPER ALT, R,')
    expect(edit?.after).toContain('lumanin')
  })

  it('stamps the hand edit when the hotkey was set in the file', () => {
    const edit = hyprEdit(handEdited(), '[general]\nhotkey = "Super+R"\n')
    expect(edit?.state).toBe('will-update')
    expect(edit?.after).not.toContain('SUPER ALT, R,')
  })

  it('treats an unparseable hotkey as not set, so the hand edit survives', () => {
    const edit = hyprEdit(handEdited(), '[general]\nhotkey = "Super+Retrun"\n')
    expect(edit?.state).toBe('up-to-date')
    expect(edit?.after).toContain('SUPER ALT, R,')
  })
})

/** The launcher's own binds are never "still bound after removal". */
describe('launcherOwnedTargets', () => {
  it('names the file-search bind and no [[hotkeys]] target, and matches the shared spelling', () => {
    const owned = launcherOwnedTargets()
    expect(owned.has('extension:files/search')).toBe(true)
    for (const target of owned) expect(target.startsWith('extension:')).toBe(true)
    expect([...owned].sort()).toEqual([...LAUNCHER_OWNED_TARGETS].sort())
  })
})
