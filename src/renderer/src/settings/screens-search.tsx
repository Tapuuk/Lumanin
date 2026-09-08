import { useEffect, useState } from 'react'
import { OFFERED_RESULT_GROUPS, RESULT_GROUP_LABELS, type ResultGroup } from '@shared/config'
import { BUILTIN_ENGINES } from '@shared/engines'
import { LAUNCHER_OWNED_TARGETS } from '@shared/bind-targets'
import { formatHotkey, parseHotkey } from '@shared/hotkey'
import type { PluginDto } from '@shared/ipc'
import { HABIT_SETTING } from '@shared/settings-model'
import { boundState, useManagedBinds } from './bind'
import {
  AddButton,
  Empty,
  HotkeyCapture,
  RemoveButton,
  ReorderList,
  Section,
  SettingControl,
  TextControl
} from './controls'
import { describeKey } from './describe'
import { FileSearchGroup, move } from './screens-basic'
import { TargetPicker, type PickedTarget } from './TargetPicker'
import { guarded, invokeChecked, sameList, setConfig, useOptimistic, useSettingsState } from './useSettings'

/**
 * Search: ranking, engines, result order, pins, aliases and file search
 * behaviour, all of the launcher's root behaviour on one screen. The CLI menu
 * shares the settings model behind it. Plugin hotkeys live on Keys with the
 * other keys: same targets, same picker, different key.
 */

/** Apps + plugins, fetched once per screen: what `describeKey` resolves names from. */
function usePickerContext(): {
  apps: readonly { id: string; title: string }[]
  plugins: readonly PluginDto[]
} {
  const [apps, setApps] = useState<readonly { id: string; title: string }[]>([])
  const [plugins, setPlugins] = useState<readonly PluginDto[]>([])
  useEffect(() => {
    guarded(window.lumanin.invoke('settings.apps').then(setApps))
    guarded(window.lumanin.invoke('settings.plugins').then(setPlugins))
  }, [])
  return { apps, plugins }
}

const NONE: readonly never[] = []

const ENGINE_KEYWORDS = ['engine', ...BUILTIN_ENGINES.map((engine) => engine.name)].join(' ')
const RESULT_KEYWORDS = ['ranking', ...OFFERED_RESULT_GROUPS.map((group) => RESULT_GROUP_LABELS[group])].join(' ')

function samePins(
  a: readonly { key: string; title: string | null; icon?: string | null }[],
  b: readonly { key: string; title: string | null; icon?: string | null }[]
): boolean {
  return a.length === b.length && a.every((pin, index) => pin.key === b[index]?.key)
}

export function SearchScreen(): React.JSX.Element | null {
  const { state } = useSettingsState()
  const context = usePickerContext()
  const [picking, setPicking] = useState<'pin' | 'alias' | null>(null)
  const [pinNote, setPinNote] = useState<string | null>(null)
  const [aliasWord, setAliasWord] = useState('')
  const resolved = state?.resolved ?? null
  const [enabledEngines, commitEngines] = useOptimistic<readonly string[]>(
    resolved?.search.webSearches.value.map((engine) => engine.id) ?? NONE,
    sameList
  )
  // Inert groups (`files`, `calculator`) are dropped from display: a config may
  // still name them, but a lever attached to nothing is not offered.
  const [order, commitOrder] = useOptimistic<readonly ResultGroup[]>(
    resolved?.search.fallbackOrder.value.filter((group) => OFFERED_RESULT_GROUPS.includes(group)) ?? NONE,
    sameList
  )
  const [pins, commitPins] = useOptimistic<readonly { key: string; title: string | null; icon?: string | null }[]>(
    resolved?.search.pins.value ?? NONE,
    samePins
  )

  if (state === null || resolved === null) return null

  // --- engines ---------------------------------------------------------------
  const engineById = (id: string): { id: string; name: string; keyword: string } | undefined =>
    resolved.search.webSearches.value.find((engine) => engine.id === id) ??
    BUILTIN_ENGINES.find((engine) => engine.id === id)
  const disabledEngines = BUILTIN_ENGINES.filter((engine) => !enabledEngines.includes(engine.id))
  const writeEngines = (ids: readonly string[]): void => {
    const work = setConfig(['search', 'engines'], [...ids])
    guarded(work)
    commitEngines(ids, work)
  }

  // --- result order ----------------------------------------------------------
  const writeOrder = (groups: readonly ResultGroup[]): void => {
    const work = setConfig(['search', 'order'], [...groups])
    guarded(work)
    commitOrder(groups, work)
  }
  // Only the two rows whose position means nothing say so.
  const groupHelp: Readonly<Partial<Record<ResultGroup, string>>> = {
    calculator: 'Nothing. The calculator is always first.',
    files: 'Nothing. File search is a plugin, listed under plugins.'
  }
  const groupRow = (group: ResultGroup, on: boolean): { id: string; label: string; detail?: string; on: boolean } => {
    const detail = groupHelp[group]
    return { id: group, label: RESULT_GROUP_LABELS[group], ...(detail === undefined ? {} : { detail }), on }
  }

  // --- pins ------------------------------------------------------------------
  const writePins = (entries: readonly { key: string; title: string | null; icon?: string | null }[]): void => {
    const work = invokeChecked(
      () => window.lumanin.invoke('settings.setPins', { entries }),
      'the pins could not be saved'
    )
    guarded(work)
    commitPins(entries, work)
  }

  // --- aliases ---------------------------------------------------------------
  const aliases = Object.entries(resolved.aliases.value)

  return (
    <>
      <Section title="Result order" keywords={RESULT_KEYWORDS}>
        <p className="s-help">
          Apps and commands are ranked together by match, so their order here only breaks ties.
        </p>
        <ReorderList
          rows={[
            ...order.map((group) => groupRow(group, true)),
            ...OFFERED_RESULT_GROUPS.filter((group) => !order.includes(group)).map((group) => groupRow(group, false))
          ]}
          onToggle={(id, next) => {
            writeOrder(next ? [...order, id as ResultGroup] : order.filter((candidate) => candidate !== id))
          }}
          onMove={(id, delta) => {
            const moved = move(order, id as ResultGroup, delta)
            if (moved !== null) writeOrder(moved)
          }}
        />
      </Section>

      <Section title="Web search engines" keywords={ENGINE_KEYWORDS}>
        <p className="s-help">
          Custom engines are added in <code>lumanin config</code> for now.
        </p>
        <ReorderList
          rows={[
            ...enabledEngines.flatMap((id) => {
              const engine = engineById(id)
              return engine === undefined
                ? []
                : [{ id: engine.id, label: engine.name, detail: `Keyword: ${engine.keyword}`, on: true }]
            }),
            ...disabledEngines.map((engine) => ({
              id: engine.id,
              label: engine.name,
              detail: `Keyword: ${engine.keyword}`,
              on: false
            }))
          ]}
          onToggle={(id, next) => {
            writeEngines(next ? [...enabledEngines, id] : enabledEngines.filter((candidate) => candidate !== id))
          }}
          onMove={(id, delta) => {
            const moved = move(enabledEngines, id, delta)
            if (moved !== null) writeEngines(moved)
          }}
        />
      </Section>

      <Section title="Pins" keywords="pinned top of the root">
        {pins.length === 0 && <Empty>Nothing pinned.</Empty>}
        <ReorderList
          rows={pins.map((pin) => ({
            id: pin.key,
            label: describeKey(pin.key, pin.title, { ...context, state }),
            detail: pin.key
          }))}
          onMove={(id, delta) => {
            const keys = pins.map((pin) => pin.key)
            const moved = move(keys, id, delta)
            if (moved !== null) {
              writePins(moved.map((key) => pins.find((pin) => pin.key === key) ?? { key, title: null }))
            }
          }}
          onRemove={(id) => writePins(pins.filter((pin) => pin.key !== id))}
        />
        {pinNote !== null && <div className="s-error">{pinNote}</div>}
        <AddButton
          onClick={() => {
            setPinNote(null)
            setPicking('pin')
          }}
        >
          + Pin something
        </AddButton>
      </Section>

      <Section title="Aliases" keywords="alias short word target">
        {aliases.length === 0 && <Empty>No aliases.</Empty>}
        {aliases.map(([alias, entry]) => (
          <div key={alias} className="s-list__row">
            <span className="s-chip">{alias}</span>
            <div className="s-list__text">
              <span className="s-list__label">{describeKey(entry.key, entry.title, { ...context, state })}</span>
            </div>
            <RemoveButton
              what={`alias ${alias}`}
              onClick={() =>
                guarded(
                  invokeChecked(
                    () => window.lumanin.invoke('settings.setAlias', { alias, key: null, title: null }),
                    'the alias could not be removed'
                  )
                )
              }
            />
          </div>
        ))}
        <div className="s-inline">
          <TextControl
            value={aliasWord}
            placeholder="Short word, e.g. ff"
            onSave={setAliasWord}
            onLiveChange={setAliasWord}
          />
          <button
            type="button"
            className="s-button"
            disabled={aliasWord.trim().length === 0}
            onClick={() => setPicking('alias')}
          >
            Choose its target…
          </button>
        </div>
      </Section>

      <Section title="Ranking" keywords="frecency habit recent often closeness match">
        <p className="s-help">
          Closest match first: a name starting with what you typed, then a word inside it, then a
          keyword. Habits only order rows that match equally well.
        </p>
        <SettingControl setting={HABIT_SETTING} />
      </Section>

      <FileSearchGroup />

      {picking !== null && (
        <TargetPicker
          purpose={picking}
          onClose={() => setPicking(null)}
          onPick={(picked: PickedTarget) => {
            if (picking === 'pin') {
              if (pins.some((pin) => pin.key === picked.key)) {
                setPinNote('Already pinned.')
              } else {
                setPinNote(null)
                writePins([...pins, { key: picked.key, title: picked.title, icon: picked.icon ?? null }])
              }
            } else {
              guarded(
                invokeChecked(
                  () =>
                    window.lumanin.invoke('settings.setAlias', {
                      alias: aliasWord.trim().toLowerCase(),
                      key: picked.key,
                      title: picked.title
                    }),
                  'the alias could not be saved'
                )
              )
              setAliasWord('')
            }
            setPicking(null)
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------

export function PluginHotkeysGroup(): React.JSX.Element | null {
  const { state } = useSettingsState()
  const context = usePickerContext()
  const binds = useManagedBinds()
  const [picking, setPicking] = useState(false)

  if (state === null) return null
  const entries = state.resolved.hotkeys.value

  const write = (
    next: readonly { hotkey: string; target: string; title?: string }[]
  ): void => {
    guarded(
      invokeChecked(
        () => window.lumanin.invoke('settings.setHotkeys', { entries: next }),
        'the hotkeys could not be saved'
      )
    )
  }

  const toDto = (
    hotkey: string,
    target: string,
    title: string | null | undefined
  ): { hotkey: string; target: string; title?: string } => ({
    hotkey,
    target,
    ...(title === null || title === undefined ? {} : { title })
  })

  const normalized = (bind: string): string => {
    const parsed = parseHotkey(bind)
    return parsed === null ? bind : formatHotkey(parsed)
  }

  // Binds still in the compositor's file whose entry is gone from the config —
  // removing an entry unbinds nothing until the managed block is rewritten.
  const orphans = binds.filter(
    (bind) =>
      bind.target !== null &&
      !entries.some((entry) => entry.target === bind.target) &&
      !LAUNCHER_OWNED_TARGETS.has(bind.target)
  )

  return (
    <>
      <Section title="Plugin hotkeys" keywords="global key bind command category row action">
        <p className="s-help">
          Written into this desktop&apos;s own shortcut config, with the diff shown first.
        </p>
        {entries.length === 0 && <Empty>No plugin keys yet.</Empty>}
        {entries.map((entry, index) => {
          const bound = boundState(binds, normalized(entry.bind), entry.target)
          return (
            <div key={String(index)} className="s-list__row">
              <HotkeyCapture
                value={normalized(entry.bind)}
                onPick={(next) => {
                  if (next === null) return
                  write(
                    entries.map((candidate, candidateIndex) =>
                      toDto(candidateIndex === index ? next : candidate.bind, candidate.target, candidate.title)
                    )
                  )
                }}
              />
              <div className="s-list__text">
                <span className="s-list__label">
                  {describeKey(entry.target, entry.title ?? null, { ...context, state })}
                </span>
                <span className="s-list__detail">{entry.target}</span>
              </div>
              <span className={`s-badge${bound === 'bound' ? ' s-badge--ok' : ''}`}>
                {bound === 'bound' ? 'Bound' : 'Not bound yet'}
              </span>
              <RemoveButton
                what={describeKey(entry.target, entry.title ?? null, { ...context, state })}
                onClick={() =>
                  write(
                    entries
                      .filter((_, candidateIndex) => candidateIndex !== index)
                      .map((candidate) => toDto(candidate.bind, candidate.target, candidate.title))
                  )
                }
              />
            </div>
          )
        })}
        <AddButton onClick={() => setPicking(true)}>+ Bind a key</AddButton>
        {orphans.length > 0 && (
          <div className="s-banner s-banner--info">
            Still bound in {orphans[0]?.path ?? 'the compositor config'} but no longer listed here:{' '}
            {orphans.map((bind) => bind.keyText).join(', ')}. Applying the shortcut update removes
            them.
          </div>
        )}
      </Section>

      {picking && (
        <TargetPicker
          purpose="hotkey"
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            if (picked.hotkey === undefined) return
            write([
              ...entries.map((candidate) => toDto(candidate.bind, candidate.target, candidate.title)),
              toDto(picked.hotkey, picked.key, picked.title)
            ])
            setPicking(false)
          }}
        />
      )}
    </>
  )
}
