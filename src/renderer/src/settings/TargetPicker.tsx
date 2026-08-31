import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EnumeratedItem } from '@shared/render-tree'
import type { PluginDto } from '@shared/ipc'
import { BUILTIN_COMMANDS } from '@shared/settings-model'
import { Busy, HotkeyCapture, PickOverlay, type PickOption } from './controls'
import { guarded, useSettingsState } from './useSettings'

/**
 * Pick one thing that can be pinned, aliased or bound, from what exists.
 *
 * The same drill-down the CLI's picker walks: Application, Command, Web
 * search, or Plugins → plugin → command → category → row → one action on it.
 * Every level is a valid stopping point and says so with its first row. What
 * comes out is a pin key (`extension:1password/search#logins`), with a stored
 * title where the name only exists while the plugin runs.
 */

export interface PickedTarget {
  readonly key: string
  readonly title: string | null
  /** The row's own icon, for a pin; absent for anything that is not a plugin row. */
  readonly icon?: string | null
  /** A human label for the screen that opened the picker. */
  readonly label: string
  /** Set only when the picker was asked for a key as well. */
  readonly hotkey?: string
}

type Step =
  | { at: 'root' }
  | { at: 'apps' }
  | { at: 'commands' }
  | { at: 'web' }
  | { at: 'plugins' }
  | { at: 'plugin'; plugin: PluginDto }
  | { at: 'command'; plugin: PluginDto; command: PluginDto['commands'][number] }
  | {
      at: 'category'
      plugin: PluginDto
      command: PluginDto['commands'][number]
      category: { id: string; title: string }
    }
  | {
      at: 'items'
      plugin: PluginDto
      command: PluginDto['commands'][number]
      category: { id: string; title: string } | null
      items: readonly EnumeratedItem[] | null
      error: string | null
    }
  | {
      at: 'actions'
      plugin: PluginDto
      command: PluginDto['commands'][number]
      category: { id: string; title: string } | null
      item: EnumeratedItem
    }
  | { at: 'key'; picked: PickedTarget; back: Step }

// Sentinels for the "this level itself" and "browse its rows" rows. The NUL
// escape cannot collide with a category or action title, and stays visible
// in source (a literal NUL byte makes the file read as binary).
const SELF = '\u0000self'
const ROWS = '\u0000rows'

type Row = PickOption & { onRow: () => void }
type Crumb = { label: string; step: Step }

/** The trail from the root to `step`, each crumb carrying the step a click on it returns to. */
function trailOf(step: Step): readonly Crumb[] {
  switch (step.at) {
    case 'root':
      return [{ label: 'Targets', step }]
    case 'apps':
      return [...trailOf({ at: 'root' }), { label: 'Applications', step }]
    case 'commands':
      return [...trailOf({ at: 'root' }), { label: 'Commands', step }]
    case 'web':
      return [...trailOf({ at: 'root' }), { label: 'Web searches', step }]
    case 'plugins':
      return [...trailOf({ at: 'root' }), { label: 'Plugins', step }]
    case 'plugin':
      return [...trailOf({ at: 'plugins' }), { label: step.plugin.title, step }]
    case 'command':
      return [...trailOf({ at: 'plugin', plugin: step.plugin }), { label: step.command.title, step }]
    case 'category':
      return [
        ...trailOf({ at: 'command', plugin: step.plugin, command: step.command }),
        { label: step.category.title, step }
      ]
    case 'items': {
      const { plugin, command, category } = step
      return [
        ...trailOf(category === null ? { at: 'command', plugin, command } : { at: 'category', plugin, command, category }),
        { label: 'Rows', step }
      ]
    }
    case 'actions': {
      const { plugin, command, category, item } = step
      return [
        ...trailOf({ at: 'items', plugin, command, category, items: null, error: null }),
        { label: item.title, step }
      ]
    }
    case 'key':
      return [...trailOf(step.back), { label: 'Key', step }]
  }
}


export function TargetPicker({
  purpose,
  onPick,
  onClose
}: {
  /** An alias is one word for one thing, and a web search still needs its term, so it is not offered there. */
  purpose: 'pin' | 'alias' | 'hotkey'
  onPick: (picked: PickedTarget) => void
  onClose: () => void
}): React.JSX.Element {
  const { state } = useSettingsState()
  const [step, setStep] = useState<Step>({ at: 'root' })
  const [apps, setApps] = useState<readonly { id: string; title: string }[]>([])
  const [plugins, setPlugins] = useState<readonly PluginDto[]>([])

  useEffect(() => {
    guarded(window.lumanin.invoke('settings.apps').then(setApps))
    guarded(window.lumanin.invoke('settings.plugins').then(setPlugins))
  }, [])

  // A key binding needs a chord as well, asked for on one more level of the same list.
  const pick = (key: string, title: string | null, label: string, icon: string | null = null): void => {
    const picked: PickedTarget = { key, title, label, icon }
    if (purpose === 'hotkey') setStep({ at: 'key', picked, back: step })
    else onPick(picked)
  }

  /** Plugins whose commands may appear at the root — `lumanin.root: false` stays out. */
  const pinnable = useMemo(
    () =>
      plugins
        .map((plugin) => ({ ...plugin, commands: plugin.commands.filter((command) => command.root) }))
        .filter((plugin) => plugin.commands.length > 0),
    [plugins]
  )

  let rows: readonly Row[] = []
  let empty: ReactNode = null
  let children: ReactNode = null
  let filter = true
  switch (step.at) {
    case 'root':
      rows = [
        { value: 'apps', label: 'An application', onRow: () => setStep({ at: 'apps' }) },
        { value: 'commands', label: 'A command', onRow: () => setStep({ at: 'commands' }) },
        ...(purpose === 'alias'
          ? []
          : [{ value: 'web', label: 'A web search', onRow: () => setStep({ at: 'web' }) }]),
        {
          value: 'plugins',
          label: 'Plugins',
          detail: 'A command, a category, a row, or one action on it',
          onRow: () => setStep({ at: 'plugins' })
        }
      ]
      break
    case 'apps':
      rows = apps.map((app) => ({
        value: app.id,
        label: app.title,
        onRow: () => pick(`app:${app.id}`, null, app.title)
      }))
      empty = 'No applications found.'
      break
    case 'commands':
      rows = BUILTIN_COMMANDS.map((command) => ({
        value: command.id,
        label: command.title,
        onRow: () => pick(`command:${command.id}`, null, command.title)
      }))
      break
    case 'web': {
      const engines = state?.resolved.search.webSearches.value ?? []
      rows = engines.map((engine) => ({
        value: engine.id,
        label: `Search ${engine.name}`,
        onRow: () => pick(`web:${engine.id}`, null, `Search ${engine.name}`)
      }))
      empty = 'No search engines are enabled.'
      break
    }
    case 'plugins':
      rows = pinnable.map((plugin) => ({
        value: plugin.name,
        label: plugin.title,
        detail: plugin.commands.map((command) => command.title).join(', '),
        onRow: () => setStep({ at: 'plugin', plugin })
      }))
      empty = 'No plugin offers a command at the root.'
      break
    case 'plugin':
      rows = step.plugin.commands.map((command) => ({
        value: command.id,
        label: command.title,
        onRow: () => setStep({ at: 'command', plugin: step.plugin, command })
      }))
      break
    case 'command': {
      const { plugin, command } = step
      rows = [
        {
          value: SELF,
          label: `Open “${command.title}”`,
          detail: 'The command itself',
          onRow: () => pick(`extension:${command.id}`, null, command.title)
        },
        ...command.categories.map((category) => ({
          value: category.id,
          label: category.title,
          detail: 'Category',
          onRow: () => setStep({ at: 'category', plugin, command, category })
        })),
        {
          value: ROWS,
          label: 'Browse its rows…',
          detail: 'Runs the plugin to ask',
          onRow: () => setStep({ at: 'items', plugin, command, category: null, items: null, error: null })
        }
      ]
      break
    }
    case 'category': {
      const { plugin, command, category } = step
      rows = [
        {
          value: SELF,
          label: `Open “${category.title}”`,
          detail: 'The category, as its own view',
          onRow: () =>
            pick(`extension:${command.id}#${category.id}`, null, `${command.title}: ${category.title}`)
        },
        {
          value: ROWS,
          label: 'Browse its rows…',
          detail: 'Runs the plugin to ask',
          onRow: () => setStep({ at: 'items', plugin, command, category, items: null, error: null })
        }
      ]
      break
    }
    case 'items': {
      const { plugin, command, category, items, error } = step
      rows = (items ?? [])
        .filter((item) => item.id !== null)
        .map((item) => ({
          value: item.id ?? item.title,
          label: item.title,
          ...(item.subtitle === null ? {} : { detail: item.subtitle }),
          onRow: () => setStep({ at: 'actions', plugin, command, category, item })
        }))
      if (items === null && error === null) {
        children = (
          <p className="s-help">
            Asking the plugin
            <Busy />
          </p>
        )
      } else if (error !== null) {
        children = <div className="s-error">{error}</div>
      } else {
        empty = 'This list has no rows with a stable id.'
      }
      break
    }
    case 'actions': {
      const { command, category, item } = step
      const base = `extension:${command.id}#${category?.id ?? ''}:${item.id ?? ''}`
      rows = [
        {
          value: SELF,
          label: `Open on “${item.title}”`,
          detail: 'Opens the list with this row selected',
          onRow: () => pick(base, item.title, item.title, item.icon)
        },
        ...item.actions
          // An action title containing `!` cannot be written unambiguously —
          // the key splits at the last `!` — so it is not offered.
          .filter((action) => !action.includes('!'))
          .map((action) => ({
            value: action,
            label: action,
            detail: 'Runs without opening a window',
            onRow: () =>
              pick(`${base}!${action}`, `${item.title} - ${action}`, `${item.title} - ${action}`, item.icon)
          }))
      ]
      break
    }
    case 'key': {
      const { picked } = step
      filter = false
      children = (
        <>
          <p className="s-help">Press the combination this should answer to.</p>
          <HotkeyCapture
            value=""
            autoArm
            onPick={(next) => {
              if (next !== null) onPick({ ...picked, hotkey: next })
            }}
          />
        </>
      )
      break
    }
  }

  // Ask the plugin once we land on an items step with nothing loaded yet. The
  // guard compares command *and* category: navigate away and into a different
  // list while a slow enumerate is in flight, and the stale answer (or its
  // error) must not land on the step that did not ask for it.
  useEffect(() => {
    if (step.at !== 'items' || step.items !== null || step.error !== null) return
    const { command, category } = step
    const sameStep = (current: Step): current is Step & { at: 'items' } =>
      current.at === 'items' &&
      current.command.id === command.id &&
      (current.category?.id ?? null) === (category?.id ?? null)
    void window.lumanin
      .invoke('settings.enumerate', { command: command.id, category: category?.id ?? null })
      .then((items) => setStep((current) => (sameStep(current) ? { ...current, items } : current)))
      .catch((cause: unknown) =>
        setStep((current) =>
          sameStep(current)
            ? { ...current, error: cause instanceof Error ? cause.message : String(cause) }
            : current
        )
      )
  }, [step])

  const trail = trailOf(step)
  const parent = trail[trail.length - 2]
  const levelKey = trail.map((crumb) => `${crumb.step.at}:${crumb.label}`).join('/')

  return (
    <PickOverlay
      title="Choose a target"
      wide
      options={rows}
      crumbs={trail.map((crumb) => crumb.label)}
      onCrumb={(index) => {
        const crumb = trail[index]
        if (crumb !== undefined) setStep(crumb.step)
      }}
      {...(parent === undefined ? {} : { onBack: () => setStep(parent.step) })}
      filter={filter}
      levelKey={levelKey}
      empty={empty === null ? null : <div className="s-help">{empty}</div>}
      onPick={(value) => rows.find((row) => row.value === value)?.onRow()}
      onClose={onClose}
    >
      {children}
    </PickOverlay>
  )
}
