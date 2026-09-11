import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_DISPLAY_NAME, APP_ID, WINDOW_CLASS } from '../../shared/identity'
import { PANEL_TOP_FRACTION } from '../../shared/placement'
import {
  formatHotkey,
  parseHotkey,
  toCosmic,
  toHyprland,
  toHyprlandLua,
  toKde,
  toSway,
  unsupportedModifiers,
  type Hotkey
} from '../../shared/hotkey'
import type { BlockStyle } from './block'
import { mergeKwinRule, removeKwinRule } from './kwin'
import type { PlatformProfile } from '../detect'

/**
 * What `lumanin doctor --fix` can install, and what each one is for.
 *
 * An action is data, not code: a target file, a body, and a rule for when it
 * applies. Everything that actually touches the disk lives in `index.ts`, so
 * these can be asserted against a simulated profile without a filesystem — the
 * same reason the probes are injectable.
 *
 * Nothing here writes outside `$XDG_CONFIG_HOME`. Anything needing root (the
 * ydotool udev rule) is reported as a command for the user to run, never
 * executed: a launcher that silently acquires uinput access is a launcher that
 * silently acquires every keystroke.
 */

export interface FixAction {
  readonly id: string
  readonly title: string
  /** Why the user would want this; shown before the diff. */
  readonly why: string
  /** Config-dir-relative path. Resolved against `$XDG_CONFIG_HOME` by the caller. */
  readonly file: string
  /**
   * Which XDG root `file` is relative to. Config unless stated.
   *
   * `data` exists for exactly one thing: KDE binds a shortcut to a **`.desktop`
   * file**, and a `.desktop` file that no launcher can find is not a thing KDE
   * will bind. It has to be in `$XDG_DATA_HOME/applications/`, which is not a
   * config directory and must not be treated as one.
   */
  readonly root?: 'config' | 'data'
  /**
   * How the block is marked, for files that are not `#`-commented line lists.
   *
   * COSMIC's shortcut config is RON: `#` is a syntax error there, and the file is
   * a single top-level map, so the block goes *inside* the braces. Getting either
   * wrong does not fail politely — the file stops parsing and the user loses
   * every custom shortcut they have, not just ours.
   */
  readonly style?: BlockStyle
  /**
   * Files to search for an existing block before falling back to `file`. A user
   * who keeps their binds in `bindings.conf` should not have them moved.
   */
  readonly alternateFiles?: readonly string[]
  /**
   * Recognises *this action's* lines inside an existing block.
   *
   * Needed because two actions can default to the same file, so "the file has a
   * Lumanin block in it" does not answer "is it mine". Without this, installing
   * the rules would relocate a bind the user keeps in `bindings.conf` into
   * `hyprland.conf`, leaving the key bound twice.
   */
  readonly signature: RegExp
  /**
   * Keep the lines already in the block instead of rewriting them to `body`.
   *
   * Set on anything the user is expected to tune. A keybind is theirs: someone
   * who changed ours to `Ctrl+Alt+R` did that on purpose, and an "idempotent"
   * installer that silently put `Super+K` back on every upgrade would be a tool
   * you learn not to run. Rules are the opposite — they encode compositor
   * behaviour we need and must be updatable — so they do not set this.
   */
  readonly preserveUserEdits?: boolean
  /**
   * The text a *new* file starts from, when the desktop reads a system-wide
   * original instead of a missing user file. sway reads `~/.config/sway/config`
   * in place of `/etc/sway/config`, not on top of it, so a user file holding
   * only our block would strip every default keybind; what sway's own docs
   * tell users to do is copy the system file, and that copy is what our block
   * is appended to. Consulted only when the target is absent or empty.
   */
  readonly seed?: (dirs: { readonly system?: string }) => { readonly text: string; readonly from: string } | null
  /**
   * Which existing lines count as "the user's version of this action".
   *
   * Defaults to {@link signature}, which is right when every line of the block is
   * a bind — Hyprland's and sway's are. It is wrong for a format where one entry
   * spans several lines: KDE's block is a group header, a friendly name and a
   * `_launch=`, and preserving only the line the signature matches would leave a
   * `_launch=` with no group above it, landing the shortcut in whichever group
   * happened to precede it in the file.
   */
  readonly preserveMatch?: RegExp
  readonly body: readonly string[]
  /**
   * Produce the whole new file, for the one format a marked block cannot express.
   *
   * `kwinrulesrc` declares which of its groups are live in a `[General]`
   * manifest, so a rule appended to the end is a rule KWin never reads — the
   * edit has to be merged into the file's own structure. An action with a
   * transform ignores `body`, and needs an `untransform` so `--unfix` can still
   * undo it.
   */
  readonly transform?: (before: string) => string
  readonly untransform?: (before: string) => string
  applicable(profile: PlatformProfile): boolean
  /**
   * A second gate for the cases `applicable` cannot answer without a look at
   * the disk. Hyprland has two config formats now - hyprlang until 0.56, Lua
   * from the version that removed it - and which family of actions applies is
   * decided by which config file exists, which only the planner (with its real
   * config dir) can know. Absent means "no disk condition". `exists` is passed
   * in so the whole action list stays assertable without a filesystem.
   */
  readonly when?: (configDir: string, exists: (path: string) => boolean) => boolean
}

/**
 * Whether this machine's Hyprland runs on the Lua config.
 *
 * Hyprland reads `hyprland.lua` *instead of* `hyprland.conf` when both exist
 * (checked at startup only), so the file's existence is the whole answer -
 * writing a bind into the `.conf` on such a system binds nothing.
 */
export function usesHyprlandLua(configDir: string, exists: (path: string) => boolean): boolean {
  return exists(`${configDir}/hypr/hyprland.lua`)
}

/**
 * Hyprland window rules — **verified against 0.56 on the dev machine**, not
 * recalled. The old `windowrulev2 = float;center;…, class:^(lumanin)$` form is
 * rejected outright by current Hyprland, and the field names are equally
 * version-sensitive: `noanim`, `noborder`, `stayfocused` and `noshadow` are all
 * refused where the underscored forms below are accepted.
 *
 * `float` is not cosmetic: the panel is an overlay, and a tiling compositor puts
 * it in the layout until this rule exists.
 *
 * `stay_focused` is deliberately **absent**. It reads like the right rule for a
 * launcher — keep the panel focused while it is open — but it is the rule that
 * makes clicking anywhere else do nothing: the window never loses focus, so the
 * blur that closes the panel never fires. Dismiss-on-click-away is worth more
 * than defending against a spurious focus steal.
 *
 * `move` places the panel; it replaces `center on`, which was doing nothing —
 * Hyprland already centres a floating window by default, and centred is not
 * where a launcher's search field belongs (see `PANEL_TOP_FRACTION`).
 *
 * It has to be written as an *expression*, `monitor_h*0.24`, and not as `24%`.
 * Percentage arguments to `move` are accepted by the parser without complaint
 * and then silently ignored, leaving the window at the default centre — a rule
 * that looks installed, reports no error, and does nothing. Verified against
 * 0.56 by mapping a window under each form and reading back `hyprctl clients`.
 *
 * `no_blur` is required, not a preference. Most of our window is deliberately
 * transparent — the panel occupies the top of a fixed box — and a compositor
 * with blur enabled treats that emptiness as glass: Omarchy's defaults blur it
 * at `brightness = 0.60`, which paints a dimmed, smeared rectangle over half the
 * screen around a panel that is supposed to be a bar. Blur is
 * opt-in and reports `blurGranted: false` until it is granted, so a compositor
 * granting it unasked is a bug we can see. The Glass themes will turn this rule
 * off through the `windowEffects` backend rather than by leaving it out here.
 *
 * `border_size 0` stops the compositor drawing a second outline around ours and
 * recolouring it on focus, which reads as an outline that changes as the pointer
 * moves. Our own 1px accent border is unconditional and themed, so it is the one
 * that stays.
 *
 * `rounding 0` is **required**, and this reverses an earlier decision that said
 * the opposite. The old reasoning — corner radius is a desktop-wide preference,
 * so let the compositor own it — assumed the compositor's radius lands on the
 * panel's corners. It does not. Our window is a fixed box (760×480 by default)
 * with the panel occupying only the top strip of it, so Hyprland's radius rounds
 * the *box*: the panel's top two corners get the desktop's curve, and the other
 * two get nothing, because they are 380 px below in empty space. The result is a
 * bar rounded along the top and square along the bottom, with our own 1px border
 * sliced off at the two corners the compositor clipped. Reported from a real
 * session at `decoration:rounding = 16`.
 *
 * So the compositor stops rounding a shape that is not the panel, and the panel
 * draws its own radius from `--lumanin-radius-outer` — which is also what
 * the theming rule already asks for: colours follow the desktop, spacing and radius
 * stay ours. Verified on 0.56: `rounding` is an accepted field name (a bogus one
 * is rejected with `invalid field type`).
 *
 * These rules match by class **only** — do not scope them by title. That was
 * tried so the settings window, which shares the process's app_id
 * on Wayland, would escape them: `float` and `pin` behaved under the
 * multi-match syntax, but `no_blur`/`no_shadow` stopped applying to the panel,
 * which brought Omarchy's blur back as a smeared red rectangle over half the
 * screen. The settings app therefore must not share this window class at all —
 * it runs with its own — and these rules stay exactly as verified.
 */
function hyprlandRules(choice: HotkeyChoice): FixAction {
  const top = String(choice.panelTop ?? PANEL_TOP_FRACTION)
  return {
    id: 'hyprland-rules',
    title: 'Hyprland window rules for the panel',
    why: 'Floats, places and pins the panel, and stops the compositor drawing its own border around it.',
    file: 'hypr/hyprland.conf',
    alternateFiles: ['hypr/windows.conf', 'hypr/looknfeel.conf'],
    signature: /^\s*windowrule\s*=/m,
    body: [
      `windowrule = float on,        match:class ^(${WINDOW_CLASS})$`,
      `windowrule = move (monitor_w-window_w)/2 monitor_h*${top}, match:class ^(${WINDOW_CLASS})$`,
      `windowrule = pin on,          match:class ^(${WINDOW_CLASS})$`,
      `windowrule = no_anim on,      match:class ^(${WINDOW_CLASS})$`,
      `windowrule = no_shadow on,    match:class ^(${WINDOW_CLASS})$`,
      `windowrule = no_blur on,      match:class ^(${WINDOW_CLASS})$`,
      `windowrule = border_size 0,   match:class ^(${WINDOW_CLASS})$`,
      `windowrule = rounding 0,      match:class ^(${WINDOW_CLASS})$`
    ],
    applicable: (p) => p.isHyprland,
    when: (dir, exists) => !usesHyprlandLua(dir, exists)
  }
}

/**
 * How the hotkey gets from `config.toml` to the compositor.
 *
 * The old comment here said the config value was "advertised as informational
 * where the compositor owns the bind". That was a polite way of saying the
 * setting did nothing: the bind was hard-coded to Super+K and editing the config
 * changed no file anyone reads. It is now the input to this module.
 *
 * `explicit` decides who wins when the two disagree. Someone who edited our
 * managed block to Ctrl+Alt+R meant it, so a default-valued config must not
 * stamp over it — but a hotkey they actually *set* is a newer instruction than
 * the edit, and it wins. That is what {@link FixAction.preserveUserEdits} is
 * toggled by below.
 */
/** One `[[hotkeys]]` entry: a key bound straight to one target. */
export interface ExtraBind {
  readonly hotkey: Hotkey
  /**
   * A pin key (`extension:1password/search#logins`, `app:…`). Spliced into a
   * bind line single-quoted; the config parser already refused targets
   * containing a quote or a newline, so the splice cannot escape.
   */
  readonly target: string
  /**
   * What to call it in the bind's description, where the desktop shows one.
   *
   * `[[hotkeys]].title` — the name of the row at the time it was bound. Without
   * it the description is the pin key itself, which is how `hyprctl binds` came
   * to read `Lumanin: extension:steam/search-steam##games` rather than
   * `Lumanin: Steam: Games`.
   */
  readonly title?: string | null
}

export interface HotkeyChoice {
  readonly hotkey: Hotkey
  /**
   * `[file_search].hotkey` — the second key everyone gets.
   *
   * Carried beside the toggle rather than inside `extraBinds` because it is the
   * same kind of thing: file search is a search surface of its own, reachable
   * only this way, so its key is as load-bearing as the toggle rather than being
   * one of the user's extra binds.
   */
  readonly fileSearch?: Hotkey | null
  /** True when the value came from config or the environment, not the default. */
  readonly explicit: boolean
  /**
   * `[general].top` as a fraction of the monitor height, for the compositor
   * rule that places the panel. Omitted means the default placement.
   */
  readonly panelTop?: number
  /**
   * `[[hotkeys]]` binds, written into the same managed block as the toggle
   * bind. Always pass the current set: the block is rewritten whole, so a
   * caller that omits them erases them.
   */
  readonly extraBinds?: readonly ExtraBind[]
}

/** Everything `--fix` needs that it cannot work out from the profile alone. */
export interface FixOptions extends HotkeyChoice {
  /**
   * The command that runs the daemon in the foreground, for the systemd unit.
   *
   * Resolved by the caller because only it knows how this copy was installed —
   * a packaged binary, or Electron pointed at a source tree. Omitted means no
   * unit is offered, which is better than one with a path that does not exist.
   */
  readonly daemonCommand?: string
}

export const DEFAULT_HOTKEY: Hotkey = parseHotkey('Super+R') ?? { mods: ['super'], key: 'r' }

/**
 * The toggle bind. `bindd` takes a description, which is what makes the binding
 * show up with a name in Hyprland's own keybind listing instead of as a bare exec.
 */
function hyprlandBind(choice: HotkeyChoice): FixAction {
  return {
    id: 'hyprland-bind',
    title: 'Hyprland keybind for `lumanin toggle`',
    why: `Binds ${formatForProse(choice.hotkey)} to the launcher. This is the recommended hotkey path on Hyprland - more predictable than the portal today.`,
    file: 'hypr/hyprland.conf',
    alternateFiles: ['hypr/bindings.conf', 'hypr/keybinds.conf', 'hypr/binds.conf'],
    signature: /^\s*(bindd?|unbind)\s*=/m,
    preserveUserEdits: !choice.explicit,
    // Every bind, from one list — the toggle, the file-search key and each
    // `[[hotkeys]]` entry — so a new kind of bind cannot arrive in the KDE
    // writer and quietly not in this one.
    body: bindSpecs(choice).flatMap((spec) => {
      const bind = toHyprland(spec.hotkey)
      // `bindd` is five comma-separated fields and the description is the
      // third, so a comma in it shifts `exec` into the wrong one. Pin targets
      // legitimately contain commas, which is how a description ends up with
      // one.
      //
      // `$` goes for the same reason one field along: the description is not a
      // shell word, so it cannot use the quoting trick {@link hyprlandCommand}
      // does, and a `$name` here would be replaced by whatever that variable
      // holds — which may itself contain a comma and shift the fields anyway.
      // A description is read by a person and carries nothing, so dropping the
      // character costs nothing that matters.
      // Newlines go too: hyprlandLine escapes `#` but works per line, so a
      // line break in a label (a pin title is third-party text) would splice
      // raw lines — potentially `exec` ones — into hyprland.conf.
      const label = spec.label.replaceAll(/[\r\n]+/g, ' ').replaceAll(',', ' ').replaceAll('$', '')
      return [
        // `unbind` first: a desktop that already binds this chord — Omarchy puts
        // its menu on SUPER+SPACE — sources its own config before ours, and two
        // binds on one chord means the other one wins. Unbinding something that
        // was never bound is not an error in Hyprland, so this is unconditional.
        // One limit: Hyprland compares the key as a case-sensitive string, so
        // this uppercase form unbinds Omarchy's uppercase binds but would miss a
        // hand-written lowercase `bind = SUPER, space, …`.
        `unbind = ${bind.mods}, ${bind.key}`,
        // Escaped as a whole line, last: `#` is hyprlang's comment character
        // wherever it appears, and both the description and the command can
        // contain one. See {@link hyprlandLine}.
        hyprlandLine(
          `bindd = ${bind.mods}, ${bind.key}, ${label}, exec, ${hyprlandCommand(spec.argv)}`
        )
      ]
    }),
    applicable: (p) => p.isHyprland,
    when: (dir, exists) => !usesHyprlandLua(dir, exists)
  }
}

function formatForProse(hotkey: Hotkey): string {
  const { mods, key } = toHyprland(hotkey)
  return mods.length === 0 ? key : `${mods.replaceAll(' ', '+')}+${key}`
}

// ─── Hyprland, the Lua config ───────────────────────────────────────────────
//
// Hyprland deprecated hyprlang in 0.55 and removed it on main (commit
// a9902ea6); Omarchy 4 (`quattro`) already ships `hyprland.lua`. When that file
// exists the `.conf` is never read, so on such a system the actions above bind
// nothing and these apply instead ({@link usesHyprlandLua} is the gate, on both
// sides). Verified against the wiki's Binds/Window-Rules/Dispatchers pages and
// Hyprland's own example config.
//
// The shape is different from the `.conf` on purpose: our lines live in a file
// of their own (`hypr/lumanin.lua`) and `hyprland.lua` gets a single guarded
// require. Lua reload semantics make that safe and honest - the config is
// inotify-watched (required files included) and a reload clears all binds and
// rules before re-executing everything, so removing our file really unbinds.
// `pcall` because a plain `require` of a missing file would take the user's
// whole config down with it - the wiki's own recommended guard.

const LUA_STYLE: BlockStyle = { comment: '--' }

/** A Lua double-quoted string literal. Newlines stripped: our labels are one line. */
function luaString(text: string): string {
  return `"${text
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll(/[\r\n]+/g, ' ')}"`
}

function hyprlandLuaBind(choice: HotkeyChoice): FixAction {
  return {
    id: 'hyprland-lua-bind',
    title: 'Hyprland keybinds for the launcher (Lua config)',
    why: `Binds ${formatForProse(choice.hotkey)} to the launcher in \`hypr/lumanin.lua\`, loaded from your \`hyprland.lua\` by one guarded require line.`,
    file: 'hypr/lumanin.lua',
    style: LUA_STYLE,
    signature: /^\s*hl\.(bind|unbind)\(/m,
    preserveUserEdits: !choice.explicit,
    // Same list as the `.conf` writer: the toggle, the file-search key, every
    // `[[hotkeys]]` entry. `hl.unbind` first for the same reason `unbind` came
    // first there - a chord the desktop already binds (Omarchy's SUPER+SPACE
    // menu) would otherwise win over ours - and it matches the key string
    // case-sensitively, which is why both lines share one encoder.
    //
    // `exec_cmd` hands the string to `sh -c`, so {@link shellQuote} is the
    // whole quoting story: none of hyprlang's `#`/`,`/`$` hazards exist in Lua.
    body: bindSpecs(choice).flatMap((spec) => {
      const keys = toHyprlandLua(spec.hotkey)
      return [
        `hl.unbind(${luaString(keys)})`,
        `hl.bind(${luaString(keys)}, hl.dsp.exec_cmd(${luaString(shellQuote(spec.argv))}), { description = ${luaString(spec.label)} })`
      ]
    }),
    applicable: (p) => p.isHyprland,
    when: usesHyprlandLua
  }
}

/**
 * The panel rules, Lua spelling. Two calls rather than one: the first carries
 * only effects verified against the wiki and the shipped example config
 * (`float`, `pin`, `center`, `border_size`, and table-form `match`), the second
 * the cosmetic ones whose Lua names are inferred from the effects list. Lua
 * executes top-down and our file is required in isolation, so if a name in the
 * second call turns out wrong on some version, the binds and the load-bearing
 * rule have already run - the panel floats, only prettiness is lost.
 *
 * `move` takes the same monitor-relative expressions as the `.conf` rule; the
 * same form places the panel from a hand-written `hyprland.lua` on 0.56.
 */
function hyprlandLuaRules(choice: HotkeyChoice): FixAction {
  const top = String(choice.panelTop ?? PANEL_TOP_FRACTION)
  return {
    id: 'hyprland-lua-rules',
    title: 'Hyprland window rules for the panel (Lua config)',
    why: 'Floats, places and pins the panel, and stops the compositor drawing its own border around it.',
    file: 'hypr/lumanin.lua',
    style: LUA_STYLE,
    signature: /^\s*(hl\.window_rule\(|\s*(name|match)\s*=|\s*\}\))/m,
    body: [
      'hl.window_rule({',
      '  name = "lumanin-panel",',
      `  match = { class = "^(${WINDOW_CLASS})$" },`,
      '  float = true,',
      '  pin = true,',
      `  move = { "(monitor_w-window_w)/2", "monitor_h*${top}" },`,
      '  border_size = 0,',
      '})',
      'hl.window_rule({',
      '  name = "lumanin-panel-looks",',
      `  match = { class = "^(${WINDOW_CLASS})$" },`,
      '  no_anim = true,',
      '  no_shadow = true,',
      '  no_blur = true,',
      '  rounding = 0,',
      '})'
    ],
    applicable: (p) => p.isHyprland,
    when: usesHyprlandLua
  }
}

/**
 * The Lua config can do what the `.conf` one cannot: react. Hyprland 0.56 has no
 * pinned guard on its float path, so a bind such as Omarchy's `SUPER + T`
 * (`hl.dsp.window.float({ action = "toggle" })`) tiles the focused panel, and a
 * second toggle re-floats it unpinned, elsewhere and larger. `float`, `pin` and
 * `move` are static rules consumed once at map, so nothing restores it short of
 * hiding and showing the window, which ends the open session.
 *
 * This handler undoes such a change within a frame: `window.update_rules` is
 * emitted unconditionally at the end of `propertiesChanged`, which every
 * floating change goes through; `window.pin` and `window.fullscreen` cover the
 * other two dispatchers. The dispatches are deferred by a 1 ms one-shot timer
 * because `update_rules` fires synchronously inside the layout's own
 * `setFloating`, between its remove and its move, and dispatching from there
 * re-enters the layout and drifts the size. The size is the one first seen at
 * `window.open`, so a re-float cannot settle on Hyprland's remembered floating
 * size; the position is the rule's formula, with the monitor's physical size
 * divided by its scale because the Lua monitor object reports pixels.
 *
 * Everything runs inside `pcall`: a renamed API on some version must not cost
 * the binds or the rules, which precede this in the file.
 *
 * The hyprlang `.conf` form has no event handlers and therefore no guard; there,
 * pressing the hotkey twice re-maps the panel and the static rules restore it.
 */
function hyprlandLuaFloatGuard(choice: HotkeyChoice): FixAction {
  const top = String(choice.panelTop ?? PANEL_TOP_FRACTION)
  return {
    id: 'hyprland-lua-float-guard',
    title: 'Hyprland float guard for the panel (Lua config)',
    why: 'Undoes a bind that tiles, unpins or fullscreens the panel; the compositor has no rule that forbids it.',
    file: 'hypr/lumanin.lua',
    style: LUA_STYLE,
    signature: /^\s*(hl\.on\("window\.|local (function )?lumanin_)/m,
    body: [
      'local lumanin_sizes = {}',
      'local function lumanin_is_panel(w)',
      `  return w ~= nil and w.class == "${WINDOW_CLASS}"`,
      'end',
      'hl.on("window.open", function(w)',
      '  if lumanin_is_panel(w) then lumanin_sizes[w.address] = { x = w.size.x, y = w.size.y } end',
      'end)',
      'local function lumanin_guard(w)',
      '  if not lumanin_is_panel(w) or not w.mapped then return end',
      '  if w.floating and w.pinned and w.fullscreen == 0 then return end',
      '  hl.timer(function()',
      '    pcall(function()',
      '      if not w.mapped then return end',
      '      if w.fullscreen ~= 0 then hl.dispatch(hl.dsp.window.fullscreen({ window = w, action = "unset" })) end',
      '      if not w.floating then hl.dispatch(hl.dsp.window.float({ window = w, action = "enable" })) end',
      '      if not w.pinned then hl.dispatch(hl.dsp.window.pin({ window = w, action = "enable" })) end',
      '      local s = lumanin_sizes[w.address]',
      '      if s and (w.size.x ~= s.x or w.size.y ~= s.y) then',
      '        hl.dispatch(hl.dsp.window.resize({ window = w, x = s.x, y = s.y }))',
      '      end',
      '      local m = w.monitor',
      '      if m then',
      '        local mw, mh = m.width / m.scale, m.height / m.scale',
      '        local ww = s and s.x or w.size.x',
      `        hl.dispatch(hl.dsp.window.move({ window = w, x = math.floor(m.x + (mw - ww) / 2 + 0.5), y = math.floor(m.y + mh * ${top} + 0.5) }))`,
      '      end',
      '    end)',
      '  end, { timeout = 1, type = "oneshot" })',
      'end',
      'hl.on("window.update_rules", lumanin_guard)',
      'hl.on("window.pin", lumanin_guard)',
      'hl.on("window.fullscreen", lumanin_guard)'
    ],
    applicable: (p) => p.isHyprland,
    when: usesHyprlandLua
  }
}

/**
 * The one line in the user's own `hyprland.lua`: load our file if it is there.
 *
 * `require("lumanin")` resolves relative to `hyprland.lua`'s directory
 * (Hyprland's own require semantics), so it finds `hypr/lumanin.lua` wherever
 * the config dir actually is - no absolute path to go stale in a dotfiles
 * repo. Requiring tracks the file for the inotify reload, so a bind saved into
 * `lumanin.lua` is live the moment it is written.
 */
const hyprlandLuaRequire: FixAction = {
  id: 'hyprland-lua-require',
  title: 'Load Lumanin\'s binds from hyprland.lua',
  why: 'One guarded require line; without it the file above is never read.',
  file: 'hypr/hyprland.lua',
  style: LUA_STYLE,
  signature: /pcall\(require,\s*"lumanin"\)/,
  body: ['pcall(require, "lumanin") -- Lumanin\'s binds and rules; harmless if the file is gone'],
  applicable: (p) => p.isHyprland,
  when: usesHyprlandLua
}

/**
 * Sway's equivalents. Verified against sway master source and sway(5),
 * not yet against a live session. `no_focus` is deliberately
 * absent: sway has no `stay_focused` equivalent, and asking for the
 * closest-looking directive would be guessing at semantics rather than
 * translating them. `move position center` is equally absent because
 * `floating enable` already centres — `container_set_floating` calls
 * `container_floating_resize_and_center`.
 *
 * The criterion is anchored, and that is load-bearing: sway matches criteria as
 * an **unanchored PCRE search** (`criteria.c` compiles and searches with no
 * anchors), so a bare `app_id="lumanin"` also matches `lumanin-settings` — the
 * settings window would be floated and de-bordered, the exact leak the Hyprland
 * rules avoid with `^(…)$`.
 *
 * Quoting in `exec` survives to the shell: sway's config parser deliberately
 * skips quote-stripping for `exec`/`bindsym`/`for_window` and hands the joined
 * line to `sh -c`, so {@link shellQuote}'s single quotes arrive intact. One
 * sway-specific hazard: the tokenizer *does* unescape backslashes in every
 * argument, so the config-parser rule that a target may not contain an
 * apostrophe (the one thing that makes shellQuote emit a backslash) is
 * load-bearing here too.
 */
/**
 * The system sway config, byte for byte, as the base of a new user config.
 * Null when neither documented location has one, or when it carries a
 * relative `include`: that resolves against the including file's directory,
 * which changes from `/etc/sway` to `~/.config/sway` in the copy, so the copy
 * would silently lose it. Refusing there is today's behaviour.
 */
export function swaySeed(dirs: { readonly system?: string }): { text: string; from: string } | null {
  const system = dirs.system ?? '/etc'
  for (const from of [join(system, 'sway', 'config'), join(system, 'xdg', 'sway', 'config')]) {
    let text: string
    try {
      text = readFileSync(from, 'utf8')
    } catch {
      continue
    }
    if (text.length === 0) return null
    if (/^[ \t]*include[ \t]+(?![/~])/m.test(text)) return null
    return { text: text.endsWith('\n') ? text : `${text}\n`, from }
  }
  return null
}

function swayRules(choice: HotkeyChoice): FixAction {
  return {
    id: 'sway-rules',
    title: 'Sway window rules and keybind',
    why: `Floats and centres the panel, and binds ${formatForProse(choice.hotkey)} to the launcher.`,
    file: 'sway/config',
    alternateFiles: ['sway/config.d/lumanin.conf'],
    signature: /^\s*(for_window|bindsym)\b/m,
    preserveUserEdits: !choice.explicit,
    seed: swaySeed,
    body: [
      `for_window [app_id="^${WINDOW_CLASS}$"] floating enable, border none`,
      ...bindSpecs(choice).map(
        (spec) => `bindsym ${toSway(spec.hotkey)} exec ${shellQuote(spec.argv)}`
      )
    ],
    applicable: (p) => p.isSway
  }
}

/**
 * KWin window rules for the panel — KDE's equivalent of the Hyprland block above.
 *
 * `kwinrulesrc` is not a list of directives, it is KConfig with a manifest: one
 * group per rule, and a `[General]` group holding `count` and a `rules=` list of
 * the group names in force. A group nobody lists is a group KWin never reads, so
 * this cannot be a marked block appended to the end — it has to be merged, which
 * is what {@link mergeKwinRule} does and why this action carries a transform
 * instead of a body.
 *
 * The group name is a fixed UUID rather than a generated one so that installing
 * twice replaces our rule instead of accumulating rules.
 *
 * What the rule sets, and what it deliberately does not:
 *
 *  - `noborder` — KWin may put a server-side frame around a frameless window;
 *    this is what stops a launcher having a title bar on KDE.
 *  - `above` — a launcher belongs over what it is launching from.
 *  - `skiptaskbar` / `skippager` / `skipswitcher` — the panel is not a window the
 *    user manages; it should not appear in the task manager or in Alt+Tab.
 *  - `fsplevel=0` and `acceptfocus=true` — **focus stealing prevention, off for
 *    this one window.** KWin's default level is Low, which is aimed at exactly
 *    the behaviour a launcher has: a window appearing over what you were doing
 *    and taking the keyboard. That policy is right in general and wrong here —
 *    the window appeared because the user pressed a key asking for it, and a
 *    launcher that opens without the keyboard sends what you type into whatever
 *    was behind it. `fsplevel` is per-window, so this defeats nothing but our
 *    own panel. (`acceptfocus` is the coarser "may this window be focused at
 *    all"; forced true because a frameless, skip-taskbar, always-above window is
 *    exactly the shape a splash screen has, and that is what the rule exists to
 *    exclude.) Known gap: KDE bug 488060 — FSP rules were not applied to native
 *    Wayland clients, so on Plasma Wayland this may do nothing until that lands.
 *  - `placement=5` (Centered) — stored as an int, per KWin's PlacementPolicy
 *    enum. KWin's own default is already Centered, so this is belt and braces.
 *
 * There is no equivalent of Hyprland's `move`: KWin's `position` rule takes
 * absolute pixels, and nothing at `--fix` time knows which monitor the panel will
 * open on or how big it is. Centred is the honest best available, and
 * the placement capability already says so.
 *
 * **UNVERIFIED** — written against `rulesettings.kcfg` (KWin master); never
 * run on KDE.
 */
const KWIN_RULE_GROUP = '{6f2a1c34-9d5e-4b71-8a0c-3e5f7b9d1a24}'

const kwinRules: FixAction = {
  id: 'kwin-rules',
  title: 'KWin window rules for the panel',
  why: 'Removes the frame KWin would draw around the panel, keeps it above other windows, and keeps it out of the task manager and Alt+Tab.',
  file: 'kwinrulesrc',
  signature: /^\s*wmclass\s*=/m,
  body: [],
  transform: (before) =>
    mergeKwinRule(before, KWIN_RULE_GROUP, [
      `Description=${APP_DISPLAY_NAME} panel`,
      `wmclass=${WINDOW_CLASS}`,
      'wmclasscomplete=false',
      // 1 is ExactMatch in Rules::StringMatch (0 unimportant, 2 substring, 3
      // regex). The class is a literal we set ourselves, so there is nothing to
      // match loosely.
      'wmclassmatch=1',
      'above=true',
      // 2 is Force in Rules::SetRule — apply it and do not let the window or the
      // user's later action override it. 1 (DontAffect) is the value that reads
      // as "installed" and does nothing.
      'aboverule=2',
      'noborder=true',
      'noborderrule=2',
      'skiptaskbar=true',
      'skiptaskbarrule=2',
      'skippager=true',
      'skippagerrule=2',
      'skipswitcher=true',
      'skipswitcherrule=2',
      // 0 is None in KWin's focus-stealing-prevention scale (0–4). The `rule=2`
      // suffix is Force, as above.
      'fsplevel=0',
      'fsplevelrule=2',
      'acceptfocus=true',
      'acceptfocusrule=2',
      // 5 is PlacementCentered. Stored as an int since the Plasma 5.19 rules
      // rewrite (there is a kconf_update that converted the old strings) — the
      // string 'Centered' only *looked* right because an unreadable enum falls
      // back to the kcfg default, which happens to be Centered.
      'placement=5',
      'placementrule=2'
    ]),
  untransform: (before) => removeKwinRule(before, KWIN_RULE_GROUP),
  applicable: (p) => p.isKde
}

/**
 * Every key we want bound, in one shape, so each desktop's writer only has to
 * translate rather than re-derive.
 *
 * The toggle first, then `[[hotkeys]]` in the order the user wrote them. The id
 * is stable across runs — `toggle`, `open-1`, `open-2` — because three of the
 * five mechanisms below key their entries by name, and an id that shifted when a
 * hotkey was added would rename every entry after it and leave the old ones
 * bound.
 */
export interface BindSpec {
  readonly id: string
  readonly hotkey: Hotkey
  /**
   * The command as **arguments**, not as a line.
   *
   * The five mechanisms do not agree on how a line is read, and the differences
   * are not cosmetic. Hyprland, sway and COSMIC hand the whole string to
   * `/bin/sh -c`. GNOME runs it through GLib's shell parser. KDE puts it in a
   * `.desktop` `Exec=`, where the *Desktop Entry Specification* recognises only
   * **double** quotes — a single-quoted argument there is not quoted at all, it
   * is an argument with two apostrophes in it. A pin target can contain spaces
   * and quotes (it can end in an item title), so a single pre-quoted string
   * would be right in three places and wrong in the other two.
   */
  readonly argv: readonly string[]
  /** What the desktop's own shortcut list should call it. */
  readonly label: string
}

/**
 * The bundled file-search command, as a pin key.
 *
 * Written out rather than derived from a scan: the planner runs in the CLI,
 * where the extension index is not loaded, and this command ships inside the
 * application — if it is not there, neither is half of `plugins/`.
 */
import { FILE_SEARCH_COMMAND } from '../../shared/bind-targets'
export { FILE_SEARCH_COMMAND }

/**
 * The `open` targets of the launcher's own binds, derived from `bindSpecs` on
 * a choice that has every launcher bind present: the exclusion cannot depend
 * on what this user configured, and a launcher-owned bind added later cannot
 * regress it. A `[[hotkeys]]` spec has an `open-<n>` id and is never one.
 */
export function launcherOwnedTargets(): ReadonlySet<string> {
  const probe: HotkeyChoice = { hotkey: DEFAULT_HOTKEY, fileSearch: DEFAULT_HOTKEY, panelTop: 0, explicit: true }
  return new Set(
    bindSpecs(probe)
      .filter((spec) => !spec.id.startsWith('open-') && spec.argv[1] === 'open')
      .map((spec) => spec.argv[2] ?? '')
      .filter((target) => target !== '')
  )
}

export function bindSpecs(choice: HotkeyChoice): readonly BindSpec[] {
  return [
    { id: 'toggle', hotkey: choice.hotkey, argv: [APP_ID, 'toggle'], label: APP_DISPLAY_NAME },
    ...(choice.fileSearch === undefined || choice.fileSearch === null
      ? []
      : [
          {
            id: 'files',
            hotkey: choice.fileSearch,
            argv: [APP_ID, 'open', `extension:${FILE_SEARCH_COMMAND}`],
            label: `${APP_DISPLAY_NAME}: Search Files`
          }
        ]),
    ...(choice.extraBinds ?? []).map((extra, index) => ({
      id: `open-${String(index + 1)}`,
      hotkey: extra.hotkey,
      argv: [APP_ID, 'open', extra.target],
      // The stored title where there is one: a description is read by a person,
      // in `hyprctl binds` or KDE's shortcut list, and a pin key is not.
      label: `${APP_DISPLAY_NAME}: ${extra.title ?? extra.target}`
    }))
  ]
}

/**
 * An argv as a POSIX shell would need it written.
 *
 * Single quotes because inside them a shell expands nothing at all — no `$`, no
 * backtick, no backslash — which is what makes splicing a target the user (or a
 * plugin) chose into a command line safe. The apostrophe dance is the standard
 * one and is belt-and-braces: the config parser already refuses a target
 * containing an apostrophe, precisely because this splice exists.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv
    .map((part) => (/^[\w./:@%+=-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

/**
 * The target of a `lumanin open …` command as {@link shellQuote} wrote it, or
 * `null` for any other command. The inverse of the writer, kept beside it so
 * the two cannot drift: a plain target (`extension:files/search`) is written
 * bare, one with a `#`, a space or a `'` is single-quoted with `'\''` inside.
 *
 * Every managed-bind reader goes through this. The readers used to accept only
 * the quoted form, so the file-search key — whose target is plain — read back
 * as "not bound yet" on every desktop while it fired fine.
 */
export function openTargetOf(command: string): string | null {
  const trimmed = command.trim()
  const prefix = `${APP_ID} open `
  if (!trimmed.startsWith(prefix)) return null
  const rest = trimmed.slice(prefix.length)
  if (rest.startsWith("'") && rest.endsWith("'") && rest.length >= 2) {
    return rest.slice(1, -1).replaceAll(`'\\''`, "'")
  }
  return /^[\w./:@%+=-]+$/.test(rest) ? rest : null
}

/**
 * A whole `hyprland.conf` line, as hyprlang needs it written.
 *
 * **`#` starts a comment anywhere in a line**, not only at its start — and our
 * pin keys are full of them: `extension:steam/search-steam#games` names the
 * category. Written raw, hyprlang truncated the line at the `#` and Hyprland
 * refused the config with *"Invalid dispatcher, requested "" does not exist"*,
 * because what survived was `bindd = ALT, S, Lumanin: extension:steam/search-steam`
 * — three of the five fields, the dispatcher among the missing two. Reported
 * from a real session on 0.56.
 *
 * `##` is hyprlang's escape for a literal `#` (`config.cpp`, `parseLine`: a `#`
 * whose next character is also `#` is unescaped in place and the scan continues
 * past it). Applied to the assembled line rather than to the value, which is
 * safe because nothing else we write into one contains a `#` — and which must
 * never be applied to a line that *starts* with one, since hyprlang takes that
 * as a whole-line comment before any of this and the block's own header comments
 * are exactly that shape.
 */
export function hyprlandLine(text: string): string {
  return text.replaceAll('#', '##')
}

/**
 * An argv for hyprlang's `exec`, which is a shell command inside a config value.
 *
 * Two parsers in a row, and the first one is not a shell. hyprlang substitutes
 * `$name` for any variable the user has **declared** — `$mainMod = SUPER` is in
 * every Hyprland config ever written — and it does that by plain string
 * replacement over the line, before Hyprland hands what is left to `/bin/sh`.
 * There is no escape for `$` in hyprlang, so a plugin row called `$mainMod`
 * would have had its name replaced by `SUPER` and the bind would open something
 * that does not exist.
 *
 * So the `$` is taken out of hyprlang's reach instead: each one is written as
 * `'"$"'`, which closes the shell's single-quoted run, spells the dollar inside
 * double quotes where it cannot expand either, and reopens. The character
 * sequence `$name` no longer appears in the line for hyprlang to match, and the
 * shell — which concatenates adjacent quoted runs — still receives exactly the
 * argument we meant.
 */
export function hyprlandCommand(argv: readonly string[]): string {
  return shellQuote(argv).replaceAll('$', `'"$"'`)
}

/**
 * The inverse of the two above, for reading the block back off disk.
 *
 * Not optional and not cosmetic: `readManagedBinds` compares the target it finds
 * with the one in `config.toml` to answer "is this key actually bound", and a
 * comparison against the *encoded* form says no for every plugin bind there is —
 * every one of them contains a `#`. The screen would then offer to write a block
 * that is already correct, for ever.
 */
export function decodeHyprlandLine(line: string): string {
  return line.replaceAll('##', '#').replaceAll(`'"$"'`, '$')
}

/**
 * An argv as a `.desktop` `Exec=` needs it written.
 *
 * The Desktop Entry Specification's rules, which are nobody's shell: quoting is
 * done with double quotes, and inside them `"`, `` ` ``, `$` and `\` must each be
 * escaped with a backslash. The `%` character is doubled because a single one
 * introduces a field code — `%f`, `%U` — and a target containing one would
 * otherwise be silently replaced by a file list.
 */
export function ronString(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function desktopExec(argv: readonly string[]): string {
  return argv
    .map((part) => {
      const escaped = part.replaceAll(/(["`$\\])/g, '\\$1').replaceAll('%', '%%')
      return /^[\w./:@+=-]+$/.test(part) ? part : `"${escaped}"`
    })
    .join(' ')
}

/** The `.desktop` basename KDE binds a shortcut to, per bind. */
function kdeDesktopName(spec: BindSpec): string {
  return `${APP_ID}-${spec.id}.desktop`
}

/**
 * KDE, half one: a `.desktop` file per bind.
 *
 * KDE does not bind shortcuts to commands. It binds them to **components**, and
 * for anything that is not a running KDE application the component is a
 * `.desktop` file that `kglobalaccel` launches — which is why this exists at all
 * and why it has to live in `$XDG_DATA_HOME/applications`, where the desktop can
 * find it. `NoDisplay=true` keeps it out of the application menu: it is a
 * shortcut target, not a second copy of Lumanin for people to launch.
 *
 * `X-KDE-GlobalAccel-CommandShortcut=true` is what makes System Settings show it
 * under *Custom Shortcuts* as a command rather than as an application, so the
 * user can find and change it in the place they would look.
 *
 * The whole file is ours, so `--unfix` deletes it outright.
 */
function kdeDesktopEntry(spec: BindSpec): FixAction {
  return {
    id: `kde-desktop-${spec.id}`,
    title: `KDE shortcut target for \`${shellQuote(spec.argv)}\``,
    why: `KDE binds keys to .desktop files, not to commands. This is the one it will run for ${formatHotkey(spec.hotkey)}.`,
    file: `applications/${kdeDesktopName(spec)}`,
    root: 'data',
    signature: /^\s*\[Desktop Entry\]/m,
    body: [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${spec.label}`,
      `Exec=${desktopExec(spec.argv)}`,
      'Terminal=false',
      'NoDisplay=true',
      'StartupNotify=false',
      'X-KDE-GlobalAccel-CommandShortcut=true'
    ],
    applicable: (p) => p.isKde
  }
}

/**
 * KDE, half two: the shortcut itself.
 *
 * `kglobalshortcutsrc` is KConfig INI, and **Plasma 6 keeps `.desktop`-based
 * shortcuts in a nested group** — the on-disk header is
 * `[services][lumanin-toggle.desktop]` — holding a single-field
 * `_launch=<QKeySequence>` (several sequences would be tab-separated). The
 * friendly name is the `.desktop` file's `Name=`; a `_k_friendly_name` here is
 * ignored for services. Verified against kglobalacceld master and the
 * Plasma/6.0–6.5 branches (`GlobalShortcutsRegistry::loadSettings`,
 * `KServiceActionComponent::loadSettings`).
 *
 * The Plasma 5 shape — a top-level `[name.desktop]` group with a
 * `shortcut,default,name` triplet — must not be written here: the daemon's
 * `migrateConfig()` converts it on every start and **deletes the group**, our
 * markers with it, so the settings screens would report the key "not bound yet"
 * for ever and every `--fix` would append the group again.
 *
 * Two things this cannot promise, both reported rather than papered over:
 *
 *  - **kglobalaccel reads this at startup.** A write here is not live; the
 *    session has to log out and back in, or restart that one service. `doctor`
 *    prints the command instead of running it, because restarting it drops every
 *    global shortcut on the machine for a moment and that is not ours to decide.
 *  - **KConfig rewrites the file without comments.** If the user changes any
 *    shortcut in System Settings afterwards, our markers can be dropped while the
 *    group survives, and the next `--fix` will append a second copy of it. KDE
 *    resolves duplicate groups to the last one, so the shortcut keeps working;
 *    the file gets untidy, which is the lesser of the two failures available.
 *    (`readManagedBinds` handles the orphaned-group case by scanning our
 *    `[services][lumanin-…]` groups outside any block.)
 */
function kdeShortcuts(specs: readonly BindSpec[], explicit: boolean): FixAction {
  return {
    id: 'kde-shortcuts',
    title: 'KDE global shortcuts',
    why: `Binds ${specs.map((spec) => formatHotkey(spec.hotkey)).join(', ')} through kglobalaccel. Takes effect after you log out and back in.`,
    file: 'kglobalshortcutsrc',
    signature: /^\s*_launch\s*=/m,
    // A group is two lines — the nested header and its `_launch` — so "keep what
    // is there" means both. Old-format triplet lines (`…,none,…`) deliberately do
    // not match: preserving them would fossilise the Plasma 5 shape, and the
    // daemon deletes that shape on its next start anyway.
    preserveMatch: /^(\[services\]\[|\s*_launch\s*=[^,\n]*$)/,
    preserveUserEdits: !explicit,
    body: specs.flatMap((spec) => {
      const shortcut = toKde(spec.hotkey)
      return shortcut === null ? [] : [`[services][${kdeDesktopName(spec)}]`, `_launch=${shortcut}`, '']
    }),
    applicable: (p) => p.isKde
  }
}

/**
 * COSMIC's custom shortcuts.
 *
 * `cosmic-config` stores one file per key, and this key's whole value is a RON
 * map from chord to action. `Spawn` takes one string and cosmic-comp hands it
 * whole to `/bin/sh -c`, so the quoting in {@link bindSpecs} carries over.
 * cosmic-comp watches this config, so a write here is live immediately — no
 * logout, unlike KDE. Entries in `custom` override the same chord in the
 * compiled-in defaults per binding, which is exactly what a launcher bind
 * should do — but it also means a chord COSMIC uses by default (Super+R is
 * resize mode there) silently stops doing the stock thing.
 *
 * Written **inside** the map's braces with `//` comments — see {@link BlockStyle}.
 * A `#` here or a block after the closing brace does not degrade, it makes the
 * file unparseable, and cosmic-comp answers an unparseable custom file by
 * falling back to the defaults: the user silently loses every shortcut they set.
 *
 * One honesty note: the first time the user edits any shortcut in
 * cosmic-settings, it deserialises this file and rewrites it with RON's pretty
 * serialiser — our entries survive as data, the `//` markers do not. That is
 * why `readManagedBinds` falls back to scanning the whole file for our Spawn
 * lines when no block is found.
 */
function cosmicShortcuts(specs: readonly BindSpec[], explicit: boolean): FixAction {
  return {
    id: 'cosmic-shortcuts',
    title: 'COSMIC custom shortcuts',
    why: `Binds ${specs.map((spec) => formatHotkey(spec.hotkey)).join(', ')} in COSMIC's own shortcut config.`,
    file: 'cosmic/com.system76.CosmicSettings.Shortcuts/v1/custom',
    style: { comment: '//', container: 'braces' },
    signature: /Spawn\(/,
    preserveUserEdits: !explicit,
    body: specs.flatMap((spec) => {
      // A RON string, holding a shell command line: cosmic-comp passes it to
      // `/bin/sh -c` verbatim (verified in cosmic-comp's `input/actions.rs`), so
      // it needs shell quoting *and* RON escaping, in that order.
      const chord = toCosmic(spec.hotkey)
      return chord === null ? [] : [`    ${chord}: Spawn("${ronString(shellQuote(spec.argv))}"),`]
    }),
    applicable: (p) => p.isCosmic
  }
}

/**
 * A systemd user unit, for the sessions where XDG autostart is not enough.
 *
 * "Every desktop reads `~/.config/autostart`" is what the entry below assumes,
 * and it is not true. GNOME, KDE, XFCE, MATE and Cinnamon do; a bare Hyprland or
 * sway session does not read it at all unless something (uwsm, `dex`) is wired up
 * to. On those, the autostart entry is a file nobody opens and the first press of
 * the hotkey pays a full Electron cold start — which is exactly the "the first
 * few times it takes over a second" that gets reported.
 *
 * `graphical-session.target` rather than `default.target`: it is reached when
 * there is a session to attach to, which on Wayland is the difference between a
 * window and no window at all. It also means the daemon stops with the session
 * instead of outliving it.
 *
 * `ExecStart` is the resolved daemon command, not `lumanin start` — the CLI
 * spawns the daemon detached and exits, which a `Type=simple` unit reads as the
 * service having died, and systemd then kills the daemon along with the rest of
 * the cgroup. Running the daemon binary directly is the shape systemd expects.
 */
function systemdUnit(command: string): FixAction {
  return {
    id: 'systemd-unit',
    title: 'systemd user service, so the daemon is up before you press anything',
    why: 'Starts Lumanin with your graphical session and restarts it if it ever dies. This is what makes the first press of the hotkey instant.',
    file: 'systemd/user/lumanin.service',
    signature: /^\s*\[Unit\]/m,
    body: [
      '[Unit]',
      `Description=${APP_DISPLAY_NAME} launcher daemon`,
      'PartOf=graphical-session.target',
      'After=graphical-session.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${command}`,
      // A launcher that stays dead after one crash is a launcher you stop
      // relying on; a launcher that respawns in a tight loop is worse.
      'Restart=on-failure',
      'RestartSec=2',
      'Slice=app.slice',
      '',
      '[Install]',
      'WantedBy=graphical-session.target'
    ],
    // Applicable wherever systemd runs a user session, which on Linux desktops
    // today is nearly everywhere — including the compositors that ignore the
    // autostart entry, which is the whole reason this exists.
    applicable: (p) => p.binaries.systemctl !== null
  }
}

/**
 * XDG autostart. Read by GNOME, KDE, XFCE, MATE and Cinnamon, and the fallback
 * for anything without a systemd user session.
 *
 * Both this and the unit above are installed where both apply. That is not a
 * double start: the single-instance lock turns the second invocation into an
 * argv forward that exits immediately, and the alternative — guessing which one
 * this desktop honours — is how you end up with neither.
 *
 * `--show` is deliberately *not* passed. Starting hidden is the entire point.
 */
const autostart: FixAction = {
  id: 'autostart',
  title: 'Start the daemon at login (XDG autostart)',
  why: 'The panel is instant because the daemon is already running. Without this, the first toggle after login pays a cold start.',
  file: `autostart/${APP_ID}.desktop`,
  signature: /^\s*\[Desktop Entry\]/m,
  body: [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_DISPLAY_NAME}`,
    'Comment=Keyboard-first launcher',
    // `start`, not `show`: the daemon comes up hidden and waits. Autostarting a
    // launcher that opens its window at login would be a bug with a splash screen.
    `Exec=${APP_ID} start`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    // Honoured by Cinnamon and old Ubuntu patches only — the key never existed
    // in upstream GNOME, and systemd's xdg-autostart-generator ignores it. Kept
    // because it is harmless everywhere and still delays on Cinnamon, where the
    // race it guards against is real. Never add X-GNOME-Autostart-Phase here:
    // systemd's generator *skips* any entry carrying it.
    'X-GNOME-Autostart-Delay=2'
  ],
  applicable: () => true
}

/**
 * Every action `--fix` can install, for a given hotkey.
 *
 * A function rather than a constant because two of the four now depend on a
 * setting. `FIX_ACTIONS` remains as the default-hotkey view of the same list,
 * for the callers that only ask what actions exist.
 */
export function fixActions(options: FixOptions = { hotkey: DEFAULT_HOTKEY, explicit: false }): readonly FixAction[] {
  const specs = bindSpecs(options)
  return [
    // Lua binds before Lua rules: they share `lumanin.lua` and Lua executes
    // top-down, so an error in a rules call cannot cost the hotkey.
    hyprlandLuaBind(options),
    hyprlandLuaRules(options),
    hyprlandLuaFloatGuard(options),
    hyprlandLuaRequire,
    hyprlandRules(options),
    hyprlandBind(options),
    swayRules(options),
    kwinRules,
    // KDE and COSMIC have no word for CapsLock; those chords get no entry
    // rather than a different one, and the bind planner says so.
    ...specs.filter((spec) => unsupportedModifiers(spec.hotkey).length === 0).map(kdeDesktopEntry),
    kdeShortcuts(specs, options.explicit),
    cosmicShortcuts(specs, options.explicit),
    ...(options.daemonCommand === undefined ? [] : [systemdUnit(options.daemonCommand)]),
    autostart
  ]
}

export const FIX_ACTIONS: readonly FixAction[] = fixActions()

/**
 * Things `--fix` will not do for you, with the exact command to do them yourself.
 *
 * The input-injection path is the user's decision to
 * make knowingly. `ydotool` reads and writes `/dev/uinput`, which means anything
 * in the `input` group can synthesise and observe input system-wide — so this
 * prints, and stops.
 */
export interface ManualStep {
  readonly id: string
  readonly title: string
  readonly why: string
  readonly commands: readonly string[]
  needed(profile: PlatformProfile): boolean
}

export const MANUAL_STEPS: readonly ManualStep[] = [
  {
    id: 'paste-helper',
    title: 'Install an input-injection helper so paste can work',
    why: 'Without one, pasting a snippet copies the text and asks you to press Ctrl+V yourself.',
    commands: [
      '# Wayland (works everywhere, including GNOME):',
      'sudo pacman -S ydotool   # Debian/Ubuntu: apt install ydotool · Fedora: dnf install ydotool',
      'sudo systemctl enable --now ydotoold',
      '',
      '# wlroots compositors (Hyprland, Sway) - no daemon needed:',
      'sudo pacman -S wtype',
      '',
      '# X11:',
      'sudo pacman -S xdotool'
    ],
    needed: (p) =>
      p.binaries.ydotool === null && p.binaries.wtype === null && p.binaries.xdotool === null
  },
  {
    id: 'uinput-access',
    title: 'Grant ydotool access to /dev/uinput',
    why: 'ydotool is installed but cannot open uinput without this. Note what it means: anything in the `input` group can synthesise and observe input system-wide.',
    commands: [
      'sudo usermod -aG input "$USER"',
      `echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/99-uinput.rules`,
      'sudo udevadm control --reload-rules && sudo udevadm trigger',
      '# log out and back in for the group change to take effect'
    ],
    needed: (p) => p.binaries.ydotool !== null && p.binaries.ydotoold === null
  },
  {
    id: 'wayland-protocol-probe',
    title: 'Install wayland-utils so protocol detection can be exact',
    why: 'Without it we cannot tell "your compositor lacks data-control" from "we could not check", so the clipboard backend is chosen on a guess rather than a confirmed protocol list.',
    commands: ['sudo pacman -S wayland-utils   # Debian/Fedora: wayland-utils'],
    needed: (p) => p.sessionType === 'wayland' && !p.protocols.probed
  }
]
