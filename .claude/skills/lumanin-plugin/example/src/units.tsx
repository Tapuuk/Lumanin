/**
 * The example plugin: your user services and timers, as a list.
 *
 * Everything here is the pattern SKILL.md asks for. Zero dependencies - the
 * data comes from `systemctl` on this machine, spawned with an argv array,
 * never a concatenated shell string. Destructive actions sit behind
 * `confirmAlert`. Outcomes are toasts; long output is a pushed `Detail`.
 *
 * It is also the worked example of the **category contract**: the manifest
 * declares `services` and `timers` under `lumanin.categories`, the dropdown in
 * the search bar switches between them, a launch from a pinned category
 * arrives in `launchContext.category` and starts the dropdown there when it
 * names a declared category, and every item has a stable `id` so single units
 * can be pinned from `lumanin config`.
 */
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Detail,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  usePromise,
  useNavigation
} from 'lumanin'
import { useState } from 'react'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const CATEGORIES = [
  { id: 'services', title: 'Services', type: 'service' },
  { id: 'timers', title: 'Timers', type: 'timer' }
] as const

interface Unit {
  unit: string
  active: string
  sub: string
  description: string
}

async function listUnits(category: string): Promise<Unit[]> {
  const type = CATEGORIES.find((entry) => entry.id === category)?.type ?? 'service'
  // `-o json` has been in systemd since v246; every supported distro has it.
  const { stdout } = await run('systemctl', [
    '--user',
    'list-units',
    `--type=${type}`,
    '--all',
    '--no-pager',
    '-o',
    'json'
  ])
  const units = JSON.parse(stdout) as Unit[]
  return units.sort((a, b) => a.unit.localeCompare(b.unit))
}

function stateAccessory(unit: Unit): { tag: { value: string; color: string } } {
  const color =
    unit.sub === 'running' ? Color.Green : unit.active === 'failed' ? Color.Red : Color.SecondaryText
  return { tag: { value: unit.sub, color } }
}

/** `systemctl restart`/`stop`, reported as a toast either way. */
async function act(verb: 'restart' | 'stop', unit: Unit, revalidate: () => void): Promise<void> {
  const confirmed = await confirmAlert({
    title: `${verb === 'restart' ? 'Restart' : 'Stop'} ${unit.unit}?`,
    message: unit.description,
    primaryAction: { title: verb === 'restart' ? 'Restart' : 'Stop', style: Alert.ActionStyle.Destructive }
  })
  if (!confirmed) return

  const toast = await showToast({ style: Toast.Style.Animated, title: `${verb}ing ${unit.unit}` })
  try {
    await run('systemctl', ['--user', verb, unit.unit])
    toast.style = Toast.Style.Success
    toast.title = `${unit.unit} ${verb === 'restart' ? 'restarted' : 'stopped'}`
    revalidate()
  } catch (error) {
    toast.style = Toast.Style.Failure
    toast.title = `could not ${verb} ${unit.unit}`
    toast.message = error instanceof Error ? error.message : String(error)
  }
}

function Logs({ unit }: { unit: string }) {
  const { data, isLoading } = usePromise(async () => {
    const { stdout } = await run('journalctl', ['--user', '-u', unit, '-n', '40', '--no-pager'])
    return stdout.trim() || 'No log lines for this unit.'
  }, [])

  const markdown = `# ${unit}\n\n\`\`\`\n${data ?? ''}\n\`\`\``
  return <Detail isLoading={isLoading} markdown={markdown} navigationTitle={unit} />
}

export default function Command(props: { launchContext?: { category?: string } }) {
  // A launch from a pinned category (or a hotkey) says where to start; the
  // dropdown owns it from there.
  const requested = props.launchContext?.category
  const [category, setCategory] = useState(
    typeof requested === 'string' && CATEGORIES.some((entry) => entry.id === requested)
      ? requested
      : 'services'
  )
  const { data, error, isLoading, revalidate } = usePromise(listUnits, [category])
  const { push } = useNavigation()

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter units"
      searchBarAccessory={
        <List.Dropdown tooltip="Category" value={category} onChange={setCategory}>
          {CATEGORIES.map((entry) => (
            <List.Dropdown.Item key={entry.id} title={entry.title} value={entry.id} />
          ))}
        </List.Dropdown>
      }
    >
      {/* An error must render as something, never as a silently empty list. */}
      {error !== undefined && (
        <List.EmptyView
          icon={Icon.Warning}
          title="Could not talk to systemd"
          description={error.message}
        />
      )}
      {(data ?? []).map((unit) => (
        <List.Item
          key={unit.unit}
          id={unit.unit}
          title={unit.unit}
          subtitle={unit.description}
          icon={unit.sub === 'running' ? Icon.CircleFilled : Icon.Circle}
          accessories={[stateAccessory(unit)]}
          actions={
            <ActionPanel>
              <Action title="Show Logs" icon={Icon.Document} onAction={() => push(<Logs unit={unit.unit} />)} />
              <Action
                title="Restart"
                icon={Icon.ArrowClockwise}
                shortcut={{ modifiers: ['cmd'], key: 'r' }}
                onAction={() => act('restart', unit, revalidate)}
              />
              <Action
                title="Stop"
                icon={Icon.Stop}
                shortcut={{ modifiers: ['cmd'], key: 's' }}
                onAction={() => act('stop', unit, revalidate)}
              />
              <ActionPanel.Section>
                <Action.CopyToClipboard title="Copy Unit Name" content={unit.unit} />
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  )
}
