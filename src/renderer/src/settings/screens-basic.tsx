import { useState } from 'react'
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
import {
  appearanceSettings,
  FILE_SEARCH_HIDE_ON_OPEN,
  GENERAL_SETTINGS
} from '@shared/settings-model'
import { HotkeyCapture, rawChordFrom, ReorderList, Row, Section, SettingControl } from './controls'
import { guarded, setConfig, useSettingsState } from './useSettings'

/** The screens that are plain settings: General, Appearance, File Search, Keys. */

export function GeneralScreen(): React.JSX.Element {
  const { state } = useSettingsState()
  const [restarting, setRestarting] = useState(false)
  const [restartNote, setRestartNote] = useState<string | null>(null)
  const sized =
    state !== null &&
    (state.resolved.general.width.layer !== 'default' ||
      state.resolved.general.height.layer !== 'default')

  return (
    <>
      <Section>
        {GENERAL_SETTINGS.map((setting) => (
          <SettingControl key={setting.path.join('.')} setting={setting} />
        ))}
      </Section>
      {sized && state.daemonRunning && (
        <Section>
          <Row
            label="Apply the panel size now"
            help="The panel window is created once at its configured size, so width and height need a restart."
          >
            <button
              type="button"
              className="s-button"
              disabled={restarting}
              onClick={() => {
                setRestarting(true)
                setRestartNote(null)
                window.lumanin
                  .invoke('settings.restartDaemon')
                  .then((result: { ok: boolean }) => {
                    setRestarting(false)
                    if (!result.ok) setRestartNote('The launcher did not come back - start it with `lumanin`.')
                  })
                  .catch((cause: unknown) => {
                    setRestarting(false)
                    setRestartNote(cause instanceof Error ? cause.message : String(cause))
                  })
              }}
            >
              {restarting ? 'Restarting…' : 'Restart the launcher'}
            </button>
            {restartNote !== null && <div className="s-error">{restartNote}</div>}
          </Row>
        </Section>
      )}
    </>
  )
}

export function AppearanceScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  return (
    <Section>
      {appearanceSettings(state.themes).map((setting) => (
        <SettingControl key={setting.path.join('.')} setting={setting} />
      ))}
    </Section>
  )
}

export function FileSearchScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null

  const hotkey = state.resolved.fileSearch.hotkey.value
  const order = completeFileOrder(state.resolved.fileSearch.order.value)

  return (
    <>
      <Section>
        <Row
          label="Hotkey"
          help="The only way into file search - it is deliberately not a row at the root. Backspace while capturing removes the key."
        >
          <HotkeyCapture
            value={hotkey}
            allowNone
            onPick={(next) => {
              guarded(setConfig(['file_search', 'hotkey'], next ?? ''))
            }}
          />
        </Row>
        {hotkey.length === 0 && (
          <div className="s-banner s-banner--info">Without a key, file search is unreachable.</div>
        )}
        <SettingControl setting={FILE_SEARCH_HIDE_ON_OPEN} />
      </Section>
      <Section title="Category order">
        <p className="s-help">
          Which kind of file wins when names tie - the first matching category ranks first.
        </p>
        <ReorderList
          rows={order.map((category: FileCategory) => ({
            id: category,
            label: FILE_CATEGORY_TITLES[category],
            detail: FILE_CATEGORY_HINTS[category]
          }))}
          onMove={(id, delta) => {
            const moved = move(order, id as FileCategory, delta)
            if (moved !== null) guarded(setConfig(['file_search', 'order'], moved))
          }}
        />
      </Section>
    </>
  )
}

export function KeysScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  if (state === null) return null
  const keys = state.resolved.keys.value

  return (
    <Section>
      <p className="s-help">
        The panel&apos;s own keys - answered while the launcher has focus, so nothing is written
        into the desktop. A bare, unmodified key also types, so it fires only while the search box
        is empty.
      </p>
      {KEY_ACTIONS.map((action) => (
        <KeyActionRow key={action} action={action} chords={keys[action].map(formatKeyChord)} />
      ))}
    </Section>
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
              setNote('A bare key also types - it fires only while the search box is empty')
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
