import { parseExtensionPin } from '@shared/config'
import type { PluginDto, SettingsState } from '@shared/ipc'
import { BUILTIN_COMMANDS } from '@shared/settings-model'

/**
 * `app:firefox.desktop` → "Firefox", for every list that shows a pin key.
 * The renderer's copy of the CLI's `describePin`, fed from the same sources
 * over IPC: the app index, the plugin index, and the enabled engines.
 */
export function describeKey(
  key: string,
  storedTitle: string | null,
  context: {
    readonly apps: readonly { id: string; title: string }[]
    readonly plugins: readonly PluginDto[]
    readonly state: SettingsState | null
  }
): string {
  const separator = key.indexOf(':')
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)

  if (kind === 'shell') return id
  if (kind === 'command') {
    return (
      BUILTIN_COMMANDS.find((command) => command.id === id)?.title ??
      commandTitle(context.plugins, id) ??
      id
    )
  }
  if (kind === 'extension') {
    const parts = parseExtensionPin(id)
    if (parts !== null) {
      const command = findCommand(context.plugins, parts.commandId)
      if (command === null) return `${id} (not installed)`
      const category = command.categories.find((candidate) => candidate.id === parts.category)
      if (parts.category.length > 0 && category === undefined) return `${id} (not installed)`
      const name = category === undefined ? command.title : category.title

      if (parts.item === null) return name
      if (parts.action === null) return storedTitle ?? `a row in ${name}`
      return storedTitle ?? `“${parts.action}” on a row in ${name}`
    }
    return commandTitle(context.plugins, id) ?? `${id} (not installed)`
  }
  if (kind === 'web') {
    const engine = context.state?.resolved.search.webSearches.value.find(
      (candidate) => candidate.id === id
    )
    return engine === undefined ? `${id} (not enabled)` : `Search ${engine.name}`
  }
  return context.apps.find((app) => app.id === id)?.title ?? `${id} (not installed)`
}

function findCommand(
  plugins: readonly PluginDto[],
  commandId: string
): PluginDto['commands'][number] | null {
  for (const plugin of plugins) {
    const command = plugin.commands.find((candidate) => candidate.id === commandId)
    if (command !== undefined) return command
  }
  return null
}

function commandTitle(plugins: readonly PluginDto[], id: string): string | null {
  return findCommand(plugins, id)?.title ?? null
}
