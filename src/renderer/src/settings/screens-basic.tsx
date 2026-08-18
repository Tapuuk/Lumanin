import { useCallback, useEffect, useState } from 'react'
import {
  completeFileOrder,
  FILE_CATEGORY_HINTS,
  FILE_CATEGORY_TITLES,
  type FileCategory
} from '@shared/files'
import {
  formatKeyChord,
  isTypeable,
  KEY_ACTIONS,
  KEY_ACTION_INFO,
  parseKeyChord,
  type KeyAction
} from '@shared/keys'
import { formatHotkey, parseHotkey } from '@shared/hotkey'
import {
  appearanceSettings,
  FILE_SEARCH_HIDE_ON_OPEN,
  GENERAL_SETTINGS,
  GLOBAL_HOTKEY
} from '@shared/settings-model'
import { boundState, useManagedBinds } from './bind'
import { HotkeyCapture, rawChordFrom, ReorderList, Row, Section, SettingControl } from './controls'
import { guarded, sameList, setConfig, useOptimistic, useSettingsState } from './useSettings'
import { PreferenceRow } from './screens-plugins'
import { PluginHotkeysGroup } from './screens-search'
import type { PluginDto, UpdateApplyDto, UpdateCheckDto } from '@shared/ipc'

/** The Panel screen, and the pieces of Search and Keys that are plain settings. */

export function PanelScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  // Width and height used to need a restart - the window was created once at
  // its configured size. It now refits itself the next time it is hidden, so
  // there is nothing to apply and no button for it.
  return (
    <>
      <Section title="Behaviour">
        {GENERAL_SETTINGS.map((setting) => (
          <SettingControl key={setting.path.join('.')} setting={setting} />
        ))}
      </Section>
      <Section title="Appearance">
        {appearanceSettings(state.themes).map((setting) => (
          <SettingControl key={setting.path.join('.')} setting={setting} />
        ))}
      </Section>
      <UpdatesSection />
    </>
  )
}

/**
 * Updating the launcher from inside it. Nothing runs unasked: the check is a
 * click (it is the one `git fetch` this window ever does), and applying is a
 * second click after the list of what changed. A packaged install gets its
 * manager's command instead of a button - we do not pull over pacman's files.
 */
function UpdatesSection(): React.JSX.Element {
  const [check, setCheck] = useState<UpdateCheckDto | null>(null)
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState(false)
  const [outcome, setOutcome] = useState<UpdateApplyDto | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const runCheck = (): void => {
    setChecking(true)
    setProblem(null)
    setOutcome(null)
    window.lumanin
      .invoke('settings.updateCheck')
      .then(setCheck)
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setChecking(false))
  }
  const runApply = (): void => {
    setApplying(true)
    setProblem(null)
    window.lumanin
      .invoke('settings.updateApply')
      .then((result) => {
        setOutcome(result)
        if (result.ok) setCheck(null)
      })
      .catch((cause: unknown) => setProblem(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setApplying(false))
  }

  return (
    <Section title="Updates">
      <Row
        label="Launcher version"
        help={
          check === null
            ? 'Checks where this copy was installed from, a git checkout or a package, and reports what is newer. Nothing is downloaded until you confirm.'
            : `${check.current}${check.kind === 'git' ? `, checkout at ${check.root}` : ''}`
        }
      >
        <button type="button" className="s-button" disabled={checking || applying} onClick={runCheck}>
          {checking ? 'Checking...' : 'Check for updates'}
        </button>
      </Row>
      {problem !== null && <div className="s-banner">{problem}</div>}
      {check !== null && check.problem !== null && (
        <div className="s-banner s-banner--info">
          <span>
            {check.problem}
            {check.managerCommand !== null && (
              <>
                {' '}
                <code>{check.managerCommand}</code>
              </>
            )}
          </span>
        </div>
      )}
      {check !== null && check.problem === null && !check.available && (
        <div className="s-banner s-banner--info">Up to date.</div>
      )}
      {check !== null && check.available && (
        <>
          <div className="s-banner">
            <span>
              {String(check.changes.length)} new {check.changes.length === 1 ? 'commit' : 'commits'}
              {check.latest !== null ? ` (${check.latest})` : ''}. Updating pulls, rebuilds in place and restarts
              the launcher. It takes a minute or two.
              {check.dirty ? ' This checkout has local edits, which the update refuses to overwrite.' : ''}
            </span>
            <button
              type="button"
              className="s-button s-button--primary"
              disabled={applying || check.dirty}
              onClick={runApply}
            >
              {applying ? 'Updating...' : 'Update now'}
            </button>
          </div>
          <pre className="s-progress">{check.changes.slice(0, 20).join('\n')}</pre>
        </>
      )}
      {outcome !== null && (
        <>
          <div className={`s-banner${outcome.ok ? ' s-banner--info' : ''}`}>
            {outcome.ok
              ? outcome.restarted
                ? 'Updated and restarted. Close and reopen this window to run the new settings app too.'
                : 'Updated. The launcher runs the new version the next time it starts; reopen this window too.'
              : 'The update did not go through.'}
          </div>
          {outcome.log.length > 0 && <pre className="s-progress">{outcome.log}</pre>}
        </>
      )}
    </Section>
  )
}

/** `formatHotkey` spelling of a configured chord, so it compares with the compositor's. */
function normalizedHotkey(text: string): string {
  const parsed = parseHotkey(text)
  return parsed === null ? text : formatHotkey(parsed)
}

function BoundBadge({ target, hotkey }: { target: string | null; hotkey: string }): React.JSX.Element | null {
  const { state } = useSettingsState()
  const binds = useManagedBinds()
  if (state === null || !state.bindable || hotkey.length === 0) return null
  const bound = boundState(binds, normalizedHotkey(hotkey), target)
  return (
    <span className={`s-badge${bound === 'bound' ? ' s-badge--ok' : ''}`}>
      {bound === 'bound' ? 'Bound' : 'Not bound yet'}
    </span>
  )
}

/** The key that opens the panel, with whether the desktop actually has it bound. */
function GlobalHotkeyRow(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  const hotkey = state.resolved.general.hotkey
  const fixed = hotkey.layer === 'env' || hotkey.layer === 'flag'
  return (
    <Row
      label={GLOBAL_HOTKEY.label}
      help={fixed ? 'Set by the environment. Editing the file cannot change it.' : GLOBAL_HOTKEY.help}
    >
      <div className="s-inline">
        <HotkeyCapture
          value={hotkey.value}
          disabled={fixed}
          onPick={(next) => {
            if (next !== null) guarded(setConfig(['general', 'hotkey'], next))
          }}
        />
        <BoundBadge target={null} hotkey={hotkey.value} />
      </div>
    </Row>
  )
}

/** File search's own key. It is the only way in, so no key means no file search. */
function FileSearchKeyRow(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  const hotkey = state.resolved.fileSearch.hotkey.value
  return (
    <>
      <Row
        label="Hotkey"
        help="The only way into file search. It is not a row at the root. Backspace while capturing removes the key."
      >
        <div className="s-inline">
          <HotkeyCapture
            value={hotkey}
            allowNone
            onPick={(next) => {
              guarded(setConfig(['file_search', 'hotkey'], next ?? ''))
            }}
          />
          <BoundBadge target="extension:files/search" hotkey={hotkey} />
        </div>
      </Row>
      {hotkey.length === 0 && (
        <div className="s-banner s-banner--info">Without a key, file search is unreachable.</div>
      )}
    </>
  )
}

/** File search behaviour: opening, the files plugin's own preferences, category order. */
export function FileSearchGroup(): React.JSX.Element | null {
  const { state } = useSettingsState()
  // File search is built as a bundled plugin, so its own knobs (hidden files,
  // which tool) are plugin preferences - shown here, with the feature, never
  // on the plugins list.
  const [files, setFiles] = useState<PluginDto | null>(null)
  const refreshFiles = useCallback(() => {
    guarded(
      window.lumanin
        .invoke('settings.plugins')
        .then((plugins: readonly PluginDto[]) => setFiles(plugins.find((p) => p.name === 'files') ?? null))
    )
  }, [])
  useEffect(() => {
    refreshFiles()
  }, [refreshFiles, state])
  const [order, commitOrder] = useOptimistic<readonly FileCategory[]>(
    completeFileOrder(state?.resolved.fileSearch.order.value ?? []),
    sameList
  )
  if (state === null) return null

  return (
    <Section title="File search">
      <SettingControl setting={FILE_SEARCH_HIDE_ON_OPEN} />
      {files?.preferenceGroups.flatMap((group) =>
        group.preferences.map((preference) => (
          <PreferenceRow
            key={`${group.command}/${preference.name}`}
            extension={files.name}
            command={group.command}
            preference={preference}
            onChanged={refreshFiles}
          />
        ))
      )}
      <p className="s-help">
        Category order: which kind of file wins when names tie. The first matching category ranks first.
      </p>
      <ReorderList
        rows={order.map((category: FileCategory) => ({
          id: category,
          label: FILE_CATEGORY_TITLES[category],
          detail: FILE_CATEGORY_HINTS[category]
        }))}
        onMove={(id, delta) => {
          const moved = move(order, id as FileCategory, delta)
          if (moved === null) return
          const work = setConfig(['file_search', 'order'], moved)
          guarded(work)
          commitOrder(moved, work)
        }}
      />
    </Section>
  )
}

/** Every key in one place: the two global chords, the panel's own keys, plugin hotkeys. */
export function KeysScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  const keys = state.resolved.keys.value

  return (
    <>
      <Section title="Launcher">
        <GlobalHotkeyRow />
      </Section>
      <Section title="File search">
        <FileSearchKeyRow />
      </Section>
      <Section title="Panel keys">
        <p className="s-help">
          The panel&apos;s own keys, answered while the launcher has focus. Nothing is written into
          the desktop. A bare key also types, so it fires only while the search box is empty.
        </p>
        {KEY_ACTIONS.map((action) => (
          <KeyActionRow key={action} action={action} chords={keys[action].map(formatKeyChord)} />
        ))}
      </Section>
      <PluginHotkeysGroup />
    </>
  )
}

function KeyActionRow({
  action,
  chords
}: {
  action: KeyAction
  chords: readonly string[]
}): React.JSX.Element {
  const info = KEY_ACTION_INFO[action]
  const [capturing, setCapturing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const save = (next: readonly string[]): void => {
    // The default comes back by deleting the key — write null for "as shipped".
    guarded(
      setConfig(['keys', info.setting], next.length === 0 ? null : next.length === 1 ? (next[0] ?? '') : [...next])
    )
  }

  return (
    <Row label={info.title} help={info.help}>
      <div className="s-chords">
        {chords.map((chord) => (
          <span key={chord} className="s-chip">
            {chord}
            <button
              type="button"
              className="s-chip__remove"
              aria-label={`Remove ${chord}`}
              onClick={() => save(chords.filter((candidate) => candidate !== chord))}
            >
              ✕
            </button>
          </span>
        ))}
        <button
          type="button"
          className={`s-hotkey${capturing ? ' s-hotkey--capturing' : ''}`}
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          onKeyDown={(event) => {
            if (!capturing) return
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Escape') {
              setCapturing(false)
              setNote(null)
              return
            }
            const raw = rawChordFrom(event)
            if (raw === null) return
            const spelled = [...raw.mods.map(capitalize), raw.key].join('+')
            const parsed = parseKeyChord(spelled)
            if (parsed === null) {
              setNote(`The panel cannot bind ${spelled}`)
              return
            }
            setCapturing(false)
            setNote(null)
            const formatted = formatKeyChord(parsed)
            if (!chords.includes(formatted)) save([...chords, formatted])
            if (isTypeable(parsed)) {
              setNote('A bare key also types. It fires only while the search box is empty.')
            }
          }}
        >
          {capturing ? 'Press a key…' : '+ Add'}
        </button>
        {note !== null && <div className="s-help">{note}</div>}
      </div>
    </Row>
  )
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Move one entry by delta; `null` at either end. */
export function move<T>(items: readonly T[], value: T, delta: number): readonly T[] | null {
  const at = items.indexOf(value)
  const to = at + delta
  if (at === -1 || to < 0 || to >= items.length) return null
  const moved = [...items]
  const [item] = moved.splice(at, 1)
  if (item === undefined) return null
  moved.splice(to, 0, item)
  return moved
}
