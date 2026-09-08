import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PlatformProfile } from '../detect'
import {
  bindSpecs,
  decodeHyprlandLine,
  DEFAULT_HOTKEY,
  fixActions,
  FIX_ACTIONS,
  MANUAL_STEPS,
  type FixAction,
  type FixOptions,
  type ManualStep
} from './actions'
import { planGnomeBinds, readGnomeBinds, type CommandFix, type SettingReader } from './gnome'
import { planKdeLiveBinds } from './kde-dbus'
import { findBlock, hasUnterminatedBlock, removeBlock, renderDiff, upsertBlock } from './block'
import { APP_ID } from '../../shared/identity'
import { parseHotkey, type Hotkey } from '../../shared/hotkey'

/**
 * `lumanin doctor --fix` / `--unfix`.
 *
 * Planning and applying are separate on purpose. Every
 * change to be shown as a diff *before* it happens and to be consented to in the
 * same run — which is only possible if the whole set of edits can be computed
 * without performing any of them. So `planFixes` reads and returns; `applyPlan`
 * is the only thing that writes.
 */

export type PlanState = 'up-to-date' | 'will-add' | 'will-update' | 'blocked' | 'not-applicable'

export interface PlannedEdit {
  /**
   * Every action this edit installs. More than one when two actions land in the
   * same file: there is one block per file, so they have to be planned — and
   * written — together or the second silently replaces the first.
   */
  readonly actions: readonly FixAction[]
  readonly state: PlanState
  /** Absolute path this edit targets. */
  readonly path: string
  readonly before: string
  readonly after: string
  readonly diff: string
  /** Set when `state` is `blocked`. */
  readonly problem?: string
  /** The system file a new user config was copied from before our block was added. */
  readonly seededFrom?: string
}

export interface FixPlan {
  readonly edits: readonly PlannedEdit[]
  /**
   * Changes with no file behind them. GNOME keeps its shortcuts in dconf, so
   * there is nothing to diff and nothing to back up — see `gnome.ts`.
   */
  readonly commands: readonly CommandFix[]
  readonly manual: readonly ManualStep[]
}

/**
 * Just the parts of a plan that bind a key, plus what the desktop needs before
 * the key is live.
 *
 * The settings menu asks a narrower question than `doctor --fix` — "bind this
 * chord" rather than "install everything" — but it must ask it the same way on
 * every desktop, including the two that are not files at all (GNOME's dconf) and
 * the two that do not take effect on save (KDE, COSMIC). Carrying the notes with
 * the plan is what keeps the screen from saying "Bound" when nothing will happen
 * until the user logs out.
 */
export interface BindPlan {
  readonly edits: readonly PlannedEdit[]
  readonly commands: readonly CommandFix[]
  readonly notes: readonly string[]
}

/**
 * The two XDG roots an action's `file` can be relative to.
 *
 * Config for almost everything; data for the one KDE case, where a shortcut has
 * to point at a `.desktop` file the desktop can actually find.
 */
export interface FixDirs {
  readonly config: string
  readonly data: string
  /** Where the distro's own compositor configs live (`/etc`); only tests set it. */
  readonly system?: string
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const HEADER = 'Added by Lumanin. Remove with `lumanin doctor --unfix`, or delete this block.'

/** Stands in where an action's parameters do not affect *which* files it owns. */
const DEFAULT_CHOICE = { hotkey: DEFAULT_HOTKEY, explicit: false } as const

/**
 * Decide which file an action edits.
 *
 * A block that already contains *this action's* lines wins over the default,
 * wherever it is. Users split their compositor config across files — Omarchy
 * keeps binds in `bindings.conf` — and moving their bind into `hyprland.conf` on
 * upgrade would leave the key bound in two places.
 *
 * Matching on the action's signature rather than on "the file has a Lumanin
 * block" is the part that matters: two actions can default to the same file, so
 * the presence of a block does not tell you whose it is.
 */
function resolveTarget(dirs: FixDirs, action: FixAction): string {
  const root = action.root === 'data' ? dirs.data : dirs.config
  for (const candidate of [action.file, ...(action.alternateFiles ?? [])]) {
    const path = join(root, candidate)
    if (!existsSync(path)) continue
    const block = findBlock(read(path), action.style)
    if (block !== null && action.signature.test(block.body.join('\n'))) return path
  }
  return join(root, action.file)
}

/**
 * The lines this action contributes to the block: its own, unless the user has
 * already customised them and the action says to leave those alone.
 */
function bodyFor(action: FixAction, existingBody: readonly string[]): readonly string[] {
  if (action.preserveUserEdits !== true) return action.body

  const theirs = existingBody.filter((line) => (action.preserveMatch ?? action.signature).test(line))
  return theirs.length > 0 ? theirs : action.body
}

/**
 * Plan the edits for a profile, and for the hotkey the user actually configured.
 *
 * The hotkey is a parameter rather than something this reads, so the same
 * planner serves `doctor --fix` (which resolves the config itself) and the
 * settings menu (which is holding an unsaved draft of it).
 */
export function planFixes(
  profile: PlatformProfile,
  dirs: FixDirs,
  options?: FixOptions,
  readSetting?: SettingReader
): FixPlan {
  const edits: PlannedEdit[] = []
  const choice = options ?? DEFAULT_CHOICE
  const actions = options === undefined ? FIX_ACTIONS : fixActions(options)
  // Two gates: the profile says which desktop this is, `when` looks at the disk
  // - which of Hyprland's two config formats this machine runs is a file's
  // existence, not an environment variable.
  const applicable = actions.filter(
    (action) => action.applicable(profile) && (action.when?.(dirs.config, existsSync) ?? true)
  )

  const skipped = actions.filter((action) => !applicable.includes(action))
  if (skipped.length > 0) {
    // Still reported: "why did it not offer me the sway rules" deserves the same
    // answer as "why did it not pick that backend".
    for (const action of skipped) {
      edits.push({
        actions: [action],
        state: 'not-applicable',
        path: join(action.root === 'data' ? dirs.data : dirs.config, action.file),
        before: '',
        after: '',
        diff: ''
      })
    }
  }

  // One block per file, so actions sharing a target are merged into one edit.
  const byFile = new Map<string, FixAction[]>()
  for (const action of applicable) {
    const path = resolveTarget(dirs, action)
    byFile.set(path, [...(byFile.get(path) ?? []), action])
  }

  for (const [path, actions] of byFile) {
    const before = read(path)

    // A missing file may have a system-wide original the desktop was reading
    // instead. That copy is the base the block goes into, while `before` stays
    // empty so the diff shows the whole file as added, which is what it is.
    let seededFrom: string | undefined
    let base = before
    if (before.length === 0) {
      for (const action of actions) {
        const seeded = action.seed?.(dirs)
        if (seeded !== undefined && seeded !== null && seeded.text.length > 0) {
          base = seeded.text
          seededFrom = seeded.from
          break
        }
      }
    }

    const guard = seededFrom === undefined ? blockedTarget(profile, dirs, path, before) : null
    if (guard !== null) {
      edits.push({ actions, state: 'blocked', path, before, after: before, diff: '', problem: guard })
      continue
    }

    // A transform owns the whole file, so it cannot share one with a block. No
    // pair of actions currently lands in the same file that way, and this is
    // what keeps it that way rather than silently letting one win.
    const transforms = actions.filter((action) => action.transform !== undefined)
    if (transforms.length > 0) {
      const after = transforms.reduce((text, action) => action.transform?.(text) ?? text, base)
      edits.push({
        actions,
        state: after === before ? 'up-to-date' : before.length === 0 ? 'will-add' : 'will-update',
        path,
        before,
        after,
        diff: renderDiff(before, after, path),
        ...(seededFrom === undefined ? {} : { seededFrom })
      })
      continue
    }

    if (hasUnterminatedBlock(before, actions[0]?.style)) {
      edits.push({
        actions,
        state: 'blocked',
        path,
        before,
        after: before,
        diff: '',
        problem:
          'the file has a Lumanin start marker with no matching end marker - rewriting from it could eat the rest of the file. Fix or delete the block by hand.'
      })
      continue
    }

    const style = actions[0]?.style
    const existing = findBlock(before, style)
    const bodies = actions.map((action) => bodyFor(action, existing?.body ?? []))
    const header = `${style?.comment ?? '#'} ${HEADER}`
    const body = [header, ...bodies.flatMap((lines, index) => (index === 0 ? lines : ['', ...lines]))]
    const after = upsertBlock(base, body, style)
    const existed = existing !== null

    edits.push({
      actions,
      state: after === before ? 'up-to-date' : existed ? 'will-update' : 'will-add',
      path,
      before,
      after,
      diff: renderDiff(before, after, path),
      ...(seededFrom === undefined ? {} : { seededFrom })
    })
  }

  return {
    edits,
    commands: [
      planGnomeBinds(profile, bindSpecs(choice), readSetting),
      planKdeLiveBinds(profile, bindSpecs(choice))
    ].filter((fix) => fix.state !== 'not-applicable'),
    manual: MANUAL_STEPS.filter((step) => step.needed(profile))
  }
}

/**
 * Files that must not be written even though the action applies — cases where a
 * clean write would still install nothing, or worse.
 *
 *  - **Hyprland with a Lua config.** Hyprland 0.55 deprecated the hyprlang
 *    config for Lua, 0.57 removes it, and Omarchy master has already migrated.
 *    `getMainConfigPath` looks for `hyprland.lua` *first* and falls back to
 *    `hyprland.conf` only when no `.lua` exists — so on a Lua system our write
 *    would produce a file Hyprland never reads and report success. Refusing
 *    honestly beats a silent no-op; a Lua writer is tracked as follow-up work.
 *  - **A sway session with no user config.** sway reads `~/.config/sway/config`
 *    *instead of* `/etc/sway/config`, not on top of it. Creating a user config
 *    holding only our block would strip every default keybind on the next
 *    reload — the one genuinely destructive write available to this planner.
 */
function blockedTarget(
  profile: PlatformProfile,
  dirs: FixDirs,
  path: string,
  before: string
): string | null {
  if (profile.isSway && path === join(dirs.config, 'sway', 'config') && before.length === 0) {
    const system = dirs.system ?? '/etc'
    return (
      'no sway user config exists, and creating one holding only our lines would shadow ' +
      `${system}/sway/config entirely - sway reads the user config instead of the system one, so every ` +
      `default keybind would vanish. No system config was found to copy at ${system}/sway/config or ` +
      `${system}/xdg/sway/config (or it uses a relative include, which would not survive the copy). ` +
      'Copy the system config to ~/.config/sway/config first, then re-run.'
    )
  }
  return null
}

/** One bind that is really in the compositor's config right now. */
export interface ManagedBind {
  /** The file it lives in, for saying where. */
  readonly path: string
  /** The key spec exactly as written — `SUPER SHIFT, g`, `Mod4+Shift+g`. */
  readonly keyText: string
  /** Parsed where the spelling is one we understand, for comparing with config. */
  readonly hotkey: Hotkey | null
  /** The `open` target, or `null` for the toggle bind. */
  readonly target: string | null
}

/**
 * The binds that exist **right now**, read back out of the managed block.
 *
 * Without this the settings menu can only report what it intends, and intent
 * and reality come apart the moment a write is declined or fails: removing a
 * `[[hotkeys]]` entry deletes a line from `config.toml`, but the key keeps
 * working, because the key was never in `config.toml` — it is a `bindd` line in
 * the compositor's config running `lumanin open '<target>'`. A list that showed
 * the intent would say the hotkey was gone while it still fired.
 *
 * Parsing our own generated lines rather than any bind in the file: what is
 * outside our markers is the user's, and we do not report on it.
 */
export function readManagedBinds(
  profile: PlatformProfile,
  dirs: FixDirs,
  readSetting?: SettingReader
): readonly ManagedBind[] {
  const binds: ManagedBind[] = []

  const owners = fixActions(DEFAULT_CHOICE).filter(
    (action) =>
      BIND_ACTION_IDS.has(action.id) &&
      action.applicable(profile) &&
      (action.when?.(dirs.config, existsSync) ?? true)
  )

  for (const action of owners) {
    const path = resolveTarget(dirs, action)
    const contents = read(path)
    const block = findBlock(contents, action.style)

    for (const line of block?.body ?? orphanedLines(action.id, contents)) {
      const parsed = parseBindLine(line)
      if (parsed !== null) binds.push({ path, ...parsed })
    }
  }

  // GNOME's live in dconf, so they are asked for rather than read off disk. Same
  // question, same answer shape: what is bound *now*, not what we meant to bind.
  if (profile.isGnome) binds.push(...readGnomeBinds(readSetting))

  return binds
}

/** The actions that write a key bind, as opposed to a rule or a unit. */
const BIND_ACTION_IDS = new Set(['hyprland-bind', 'hyprland-lua-bind', 'sway-rules', 'kde-shortcuts', 'cosmic-shortcuts'])

/**
 * Our bind lines when the markers are gone but the binds are not.
 *
 * Two of the four stores are rewritten by the desktop's own tools in a way that
 * keeps the data and drops the comments: KConfig regenerates
 * `kglobalshortcutsrc` without them on any Settings change, and cosmic-settings
 * re-serialises the whole shortcut map the first time the user edits any
 * shortcut. Reading only the block would then report every key as "not bound
 * yet" while it still fires — the exact lie `readManagedBinds` exists to avoid.
 *
 * So for those two formats the whole file is scanned, filtered to what is
 * unmistakably ours: on COSMIC, `parseBindLine` only accepts `Spawn` commands
 * that run this app; on KDE, only `_launch` lines inside a `[services]`
 * group named after one of our `.desktop` files (any other `_launch` in that
 * file belongs to another application and is none of our business — the
 * Plasma 5 top-level spelling of our groups is accepted too, for a file the
 * daemon has not migrated yet).
 *
 * Hyprland and sway are deliberately absent: nothing rewrites those files but
 * the user, and a bind they moved out of our block is theirs now.
 */
function orphanedLines(actionId: string, contents: string): readonly string[] {
  if (actionId === 'cosmic-shortcuts') return contents.split('\n')

  if (actionId === 'kde-shortcuts') {
    const ours: string[] = []
    let inOurGroup = false
    for (const line of contents.split('\n')) {
      const header = /^\s*\[/.exec(line)
      if (header !== null) {
        inOurGroup = new RegExp(`^\\s*(\\[services\\])?\\[${APP_ID}-[^\\]]*\\.desktop\\]\\s*$`).test(line)
        continue
      }
      if (inOurGroup) ours.push(line)
    }
    return ours
  }

  return []
}

/**
 * One line of the block, if it is a bind of ours. `null` for everything else —
 * window rules, blank lines, the header.
 *
 * The command is taken as *everything* after `exec`, not up to the next comma:
 * a target may legitimately contain one (`shell:` lines especially), and
 * splitting on it would silently truncate the target this reports.
 */
function parseBindLine(line: string): Omit<ManagedBind, 'path'> | null {
  let keyText: string
  let command: string

  // Hyprland's Lua config: `hl.bind("SUPER + R", hl.dsp.exec_cmd("…"), {…})`.
  // Both strings are Lua literals written by `luaString`, so `\"` and `\\` are
  // the only escapes to undo. `hl.unbind` lines fall through to null, which is
  // right - an unbind is not a binding to report.
  const lua = /^\s*hl\.bind\("((?:[^"\\]|\\.)*)",\s*hl\.dsp\.exec_cmd\("((?:[^"\\]|\\.)*)"\)/.exec(
    line
  )
  if (lua !== null) {
    const unescape = (text: string): string => text.replaceAll(/\\(.)/g, '$1')
    keyText = unescape(lua[1] ?? '')
    command = unescape(lua[2] ?? '').trim()
    const hotkey = parseHotkey(keyText.replaceAll(' + ', '+'))
    if (command === `${APP_ID} toggle`) return { keyText, hotkey, target: null }
    const opened = new RegExp(`^${APP_ID} open '(.*)'$`).exec(command)
    return opened === null ? null : { keyText, hotkey, target: opened[1] ?? '' }
  }

  const hyprland = /^\s*bindd?\s*=\s*(.+)$/.exec(line)
  const sway = /^\s*bindsym\s+(\S+)\s+exec\s+(.+)$/.exec(line)
  // KDE: `_launch=Meta+K` — Plasma 6 stores the shortcut alone (several would be
  // tab-separated); the Plasma 5 shape was a `shortcut,default,name` triplet, so
  // anything after a comma or tab is dropped either way. The command is not on
  // this line at all — it is in the `.desktop` file the group is named after —
  // so the group name is what identifies the bind, and the caller has already
  // established the group is ours.
  const kde = /^\s*_launch\s*=\s*([^,\t]+)/.exec(line)
  // COSMIC: `(modifiers: [Super], key: "k"): Spawn("lumanin toggle"),`
  const cosmic = /^\s*\((modifiers:\s*\[[^\]]*\],\s*key:\s*"[^"]*")\):\s*Spawn\("(.*)"\),?\s*$/.exec(line)

  if (kde !== null) {
    keyText = (kde[1] ?? '').trim()
    return { keyText, hotkey: parseHotkey(keyText), target: null }
  }

  if (cosmic !== null) {
    const chord = cosmic[1] ?? ''
    keyText = chord
    command = cosmic[2] ?? ''
    const mods = /\[([^\]]*)\]/.exec(chord)?.[1] ?? ''
    const key = /key:\s*"([^"]*)"/.exec(chord)?.[1] ?? ''
    const hotkey = parseHotkey(`${mods.replaceAll(',', ' ')} ${key}`)
    if (command === `${APP_ID} toggle`) return { keyText, hotkey, target: null }
    const opened = new RegExp(`^${APP_ID} open '(.*)'$`).exec(command)
    return opened === null ? null : { keyText, hotkey, target: opened[1] ?? '' }
  }

  if (hyprland !== null) {
    // Decoded before anything is split off it: what is on disk is hyprlang's
    // spelling of the line (`##` for a literal `#`, `'"$"'` for a `$`), and the
    // target this returns is compared with the one in `config.toml`.
    const fields = decodeHyprlandLine(hyprland[1] ?? '')
      .split(',')
      .map((field) => field.trim())
    const execAt = fields.indexOf('exec')
    if (execAt < 2) return null
    keyText = `${fields[0] ?? ''}, ${fields[1] ?? ''}`
    command = fields.slice(execAt + 1).join(',').trim()
  } else if (sway !== null) {
    keyText = sway[1] ?? ''
    command = (sway[2] ?? '').trim()
  } else {
    return null
  }

  const hotkey = parseHotkey(keyText)
  if (command === `${APP_ID} toggle`) return { keyText, hotkey, target: null }

  const open = new RegExp(`^${APP_ID} open '(.*)'$`).exec(command)
  if (open === null) return null
  return { keyText, hotkey, target: open[1] ?? '' }
}

/** What `--unfix` would remove: every block we can find, plus files that are wholly ours. */
export function planRevert(dirs: FixDirs): readonly PlannedEdit[] {
  const edits: PlannedEdit[] = []

  // Every action that has ever existed, not only the ones that apply here: a
  // unit written on a machine that has since lost systemd still has to be
  // removable, and `--unfix` is the only thing that removes it.
  for (const action of [...FIX_ACTIONS, ...fixActions({ ...DEFAULT_CHOICE, daemonCommand: 'x' })]) {
    const root = action.root === 'data' ? dirs.data : dirs.config
    for (const candidate of [action.file, ...(action.alternateFiles ?? [])]) {
      const path = join(root, candidate)
      if (!existsSync(path)) continue
      if (edits.some((edit) => edit.path === path)) continue

      const before = read(path)

      if (action.untransform !== undefined) {
        const after = action.untransform(before)
        if (after === before) continue
        edits.push({ actions: [action], state: 'will-update', path, before, after, diff: renderDiff(before, after, path) })
        continue
      }

      if (findBlock(before, action.style) === null) continue

      const after = removeBlock(before, action.style)
      edits.push({
        actions: [action],
        state: 'will-update',
        path,
        before,
        after,
        diff: renderDiff(before, after, path)
      })
    }
  }

  return edits
}

export interface ApplyResult {
  readonly path: string
  readonly ok: boolean
  readonly detail: string
}

/**
 * Write the plan.
 *
 * Two safety properties, both of which have to hold for a tool that edits a
 * config the user's session depends on:
 *
 *  - **A backup per changed file**, once per run, before the first write.
 *  - **Atomic replacement** via a temp file and `rename`. A half-written
 *    `hyprland.conf` is a session that will not come back after a reload, and a
 *    crash mid-`writeFileSync` is exactly how you get one.
 *
 * A file that would end up holding nothing but our own (now removed) block is
 * deleted rather than left as an empty husk — that is the autostart `.desktop`
 * case, where the whole file was ours.
 */
export function applyPlan(edits: readonly PlannedEdit[], stamp: string): readonly ApplyResult[] {
  const results: ApplyResult[] = []

  for (const edit of edits) {
    if (edit.after === edit.before) continue

    try {
      mkdirSync(dirname(edit.path), { recursive: true })

      if (edit.before.length > 0) {
        writeFileSync(`${edit.path}.lumanin-backup.${stamp}`, edit.before, { mode: 0o600 })
      }

      if (edit.after.trim().length === 0 && edit.before.length > 0) {
        unlinkSync(edit.path)
        results.push({ path: edit.path, ok: true, detail: 'removed (the whole file was ours)' })
        continue
      }

      const temporary = `${edit.path}.lumanin-tmp.${stamp}`
      writeFileSync(temporary, edit.after, { mode: 0o644 })
      renameSync(temporary, edit.path)
      results.push({
        path: edit.path,
        ok: true,
        detail: edit.before.length > 0 ? `updated (backup: ${edit.path}.lumanin-backup.${stamp})` : 'created'
      })
    } catch (error) {
      results.push({
        path: edit.path,
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return results
}

/**
 * Run a command plan, in order, stopping at the first failure.
 *
 * Ordering is load-bearing for the one caller there is: GNOME's shortcut is
 * three settings and a list membership, and a path that joins the list before
 * its command is set is a key that briefly runs nothing. Carrying on past a
 * failure would produce exactly that state, so it stops.
 *
 * Nothing here is a shell string and nothing here needs root — both are
 * requirements for anything `--fix` may run rather than print.
 */
export async function runCommands(
  commands: readonly (readonly string[])[],
  spawn: (command: string, args: readonly string[]) => Promise<boolean>
): Promise<readonly ApplyResult[]> {
  const results: ApplyResult[] = []

  for (const [command, ...args] of commands) {
    if (command === undefined) continue
    const ok = await spawn(command, args)
    results.push({ path: `${command} ${args.join(' ')}`, ok, detail: ok ? 'done' : 'failed' })
    if (!ok) break
  }

  return results
}
