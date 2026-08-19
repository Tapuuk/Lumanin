import { useEffect, useState } from 'react'
import { OFFERED_RESULT_GROUPS, RESULT_GROUP_LABELS, type ResultGroup } from '@shared/config'
import { BUILTIN_ENGINES } from '@shared/engines'
import { formatHotkey, parseHotkey } from '@shared/hotkey'
import type { PluginDto } from '@shared/ipc'
import { HABIT_SETTING } from '@shared/settings-model'
import { boundState, useManagedBinds } from './bind'
import { AddButton, HotkeyCapture, Modal, RemoveButton, ReorderList, Section, SettingControl, TextControl } from './controls'
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
  a: readonly { key: string; title: string | null }[],
  b: readonly { key: string; title: string | null }[]
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
  const [pins, commitPins] = useOptimistic<readonly { key: string; title: string | null }[]>(
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
  const groupHelp: Readonly<Record<ResultGroup, string>> = {
    plugins: 'Your plugins’ own commands',
    apps: 'Installed applications',
    commands: 'The launcher’s own commands',
    calculator: 'Nothing. The calculator is always first.',
    files: 'Nothing. File search is a plugin, listed under plugins.',
    web: 'The enabled search engines'
  }

  // --- pins ------------------------------------------------------------------
  const writePins = (entries: readonly { key: string; title: string | null }[]): void => {
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
      <Section title="Ranking">
        <SettingControl setting={HABIT_SETTING} />
      </Section>

      <Section title="Web search engines" keywords={ENGINE_KEYWORDS}>
        <p className="s-help">
          Every engine enabled here is offered under every query, in this order. Custom engines can
          be added in <code>lumanin config</code> for now.
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

      <Section title="Result order" keywords={RESULT_KEYWORDS}>
        <p className="s-help">Which kinds of result appear, and where the unranked ones sit.</p>
        <ReorderList
          rows={[
            ...order.map((group) => ({
              id: group,
              label: RESULT_GROUP_LABELS[group],
              detail: groupHelp[group],
              on: true
            })),
            ...OFFERED_RESULT_GROUPS.filter((group) => !order.includes(group)).map((group) => ({
              id: group,
              label: RESULT_GROUP_LABELS[group],
              detail: groupHelp[group],
              on: false
            }))
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

      <Section title="Pins" keywords="pinned top of the root">
        <p className="s-help">
          Always at the top of the root, in this order, matched by name like everything else.
        </p>
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
        <p className="s-help">Type the word, get the thing: <code>ff</code> for Firefox.</p>
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
                writePins([...pins, { key: picked.key, title: picked.title }])
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
  const [pendingTarget, setPendingTarget] = useState<PickedTarget | null>(null)

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
      !bind.target.startsWith('extension:files/')
  )

  return (
    <>
      <Section title="Plugin hotkeys" keywords="global key bind command category row action">
        <p className="s-help">
          A global key bound to one thing a plugin offers: a command, a category, a row, or one
          action on a row. The key is written into this desktop&apos;s own shortcut config, with
          the diff shown first.
        </p>
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
            setPicking(false)
            setPendingTarget(picked)
          }}
        />
      )}
      {pendingTarget !== null && (
        <Modal title={`A key for “${pendingTarget.label}”`} onClose={() => setPendingTarget(null)}>
          <p className="s-help">Press the combination this should answer to.</p>
          <HotkeyCapture
            value=""
            onPick={(next) => {
              if (next === null) return
              write([
                ...entries.map((candidate) => toDto(candidate.bind, candidate.target, candidate.title)),
                toDto(next, pendingTarget.key, pendingTarget.title)
              ])
              setPendingTarget(null)
            }}
          />
        </Modal>
      )}
    </>
  )
}
