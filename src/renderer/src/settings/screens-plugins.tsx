import { useCallback, useEffect, useState } from 'react'
import type {
  OfficialPluginDto,
  PluginDto,
  PluginExportDto,
  PluginInspectionDto,
  PluginPreferenceDto
} from '@shared/ipc'
import { Busy, Empty, Modal, PickButton, Row, Section, TextControl, Toggle, useFilter } from './controls'
import { guarded, invokeChecked, useSettingsState } from './useSettings'

/**
 * Two tabs. Installed: turn a plugin off without deleting it, choose which of
 * its commands appear, set its preferences, remove it, or install one from any
 * public repository. Official: the curated index, one Install button per row.
 * Both installs go through the same facts-first consent the CLI shows.
 */

const PLUGIN_TABS = [
  { id: 'installed', title: 'Installed plugins' },
  { id: 'official', title: 'Official plugins' }
] as const

type PluginTab = (typeof PLUGIN_TABS)[number]['id']

export function PluginsScreen(): React.JSX.Element {
  const [tab, setTab] = useState<PluginTab>('installed')
  return (
    <>
      <div className="s-tabs" role="tablist" aria-label="Plugins">
        {PLUGIN_TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            className="s-tabs__tab"
            aria-selected={candidate.id === tab}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.title}
          </button>
        ))}
      </div>
      {tab === 'installed' ? <InstalledTab /> : <OfficialTab />}
    </>
  )
}

function InstalledTab(): React.JSX.Element {
  const { state } = useSettingsState()
  const filter = useFilter()
  const [plugins, setPlugins] = useState<readonly PluginDto[] | null>(null)

  const refresh = useCallback(() => {
    guarded(window.lumanin.invoke('settings.plugins').then(setPlugins))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, state])

  if (plugins === null) return <InstallSection onInstalled={refresh} />
  const installed = plugins.filter(({ bundled }) => !bundled)
  const bundled = plugins.filter(({ bundled }) => bundled)

  return (
    <>
      <InstallSection onInstalled={refresh} />
      {installed.map((plugin) => (
        <PluginCard key={plugin.name} plugin={plugin} onChanged={refresh} />
      ))}
      {installed.length === 0 && (
        <Section>
          <Empty>
            No plugins installed.
            {bundled.length > 0 && ' The ones that ship with the app are listed below.'}
          </Empty>
        </Section>
      )}
      {bundled.length > 0 && filter.trim().length === 0 && <h2 className="s-section__title">Built in</h2>}
      {bundled.map((plugin) => (
        <PluginCard key={plugin.name} plugin={plugin} onChanged={refresh} />
      ))}
    </>
  )
}

function PluginCard({ plugin, onChanged }: { plugin: PluginDto; onChanged: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <Section keywords={`${plugin.title} ${plugin.name}`}>
      <div className="s-plugin__head">
        <Toggle
          checked={plugin.enabled}
          onChange={(next) => {
            const work = invokeChecked(
              () => window.lumanin.invoke('settings.setPluginEnabled', { name: plugin.name, enabled: next }),
              'the plugin could not be switched'
            )
            guarded(work)
            return work
          }}
        />
        <button type="button" className="s-plugin__title" onClick={() => setOpen(!open)}>
          {plugin.title}
          <span className="s-list__detail">
            {plugin.bundled ? 'Ships with the app' : (plugin.origin ?? 'Installed locally')}
          </span>
        </button>
        <span className="s-list__detail">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="s-plugin__body">
          <p className="s-help">{plugin.description}</p>

          {plugin.commands.length > 1 &&
            plugin.commands.map((command) => (
              <Row key={command.id} label={command.title} help={command.description}>
                <Toggle
                  checked={command.enabled}
                  disabled={!plugin.enabled}
                  onChange={(next) => {
                    const work = invokeChecked(
                      () => window.lumanin.invoke('settings.setCommandEnabled', { id: command.id, enabled: next }),
                      'the command could not be switched'
                    )
                    guarded(work)
                    return work
                  }}
                />
              </Row>
            ))}

          {plugin.preferenceGroups.map((group) => (
            <div key={group.command}>
              {plugin.preferenceGroups.length > 1 && (
                <h3 className="s-section__title">{group.title}</h3>
              )}
              {group.preferences.map((preference) => (
                <PreferenceRow
                  key={preference.name}
                  extension={plugin.name}
                  command={group.command}
                  preference={preference}
                  onChanged={onChanged}
                />
              ))}
            </div>
          ))}

          <div className="s-inline">
            <button type="button" className="s-button" onClick={() => setExporting(true)}>
              Export…
            </button>
            {!plugin.bundled && (
              <button
                type="button"
                className="s-button s-button--danger"
                onClick={() => setConfirmingRemove(true)}
              >
                Remove
              </button>
            )}
            {problem !== null && <div className="s-error">{problem}</div>}
          </div>
          {plugin.bundled && (
            <p className="s-help">
              Can be turned off but not removed. A plugin you install under the same name replaces it.
            </p>
          )}
        </div>
      )}

      {exporting && <ExportModal plugin={plugin} onClose={() => setExporting(false)} />}

      {confirmingRemove && (
        <Modal title={`Remove ${plugin.title}?`} onClose={() => setConfirmingRemove(false)}>
          <p className="s-help">
            Deletes its code. Its stored data is kept, in case you reinstall it.
          </p>
          <div className="s-modal__buttons">
            <button type="button" className="s-button" onClick={() => setConfirmingRemove(false)}>
              Keep it
            </button>
            <button
              type="button"
              className="s-button s-button--danger"
              onClick={() => {
                guarded(
                  window.lumanin.invoke('settings.removePlugin', { name: plugin.name }).then((result) => {
                    setConfirmingRemove(false)
                    if (!result.ok) setProblem(result.detail ?? 'Could not remove it')
                    onChanged()
                  })
                )
              }}
            >
              Remove
            </button>
          </div>
        </Modal>
      )}
    </Section>
  )
}

/**
 * `plugin-export`, as a button: copy the plugin's source into Downloads as a
 * directory ready to push, with a README, a `.gitignore` and — if chosen — an
 * MIT LICENSE. Where `gh` is signed in, one more explicit step creates the
 * repository and pushes; it says exactly what it will do, because publishing
 * is outward-facing and there is no unpublish.
 */
function ExportModal({ plugin, onClose }: { plugin: PluginDto; onClose: () => void }): React.JSX.Element {
  const [mit, setMit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PluginExportDto | null>(null)
  const [published, setPublished] = useState<{ ok: boolean; detail: string; url?: string } | null>(null)

  const doExport = (): void => {
    setBusy(true)
    window.lumanin
      .invoke('settings.exportPlugin', { name: plugin.name, license: mit ? 'mit' : null })
      .then((outcome) => {
        setBusy(false)
        setResult(outcome)
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setResult({ ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  const doPublish = (): void => {
    setBusy(true)
    window.lumanin
      .invoke('settings.publishPlugin', { name: plugin.name })
      .then((outcome) => {
        setBusy(false)
        setPublished(outcome)
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setPublished({ ok: false, detail: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  return (
    <Modal title={`Export ${plugin.title}`} onClose={onClose} wide>
      {result === null && (
        <>
          <p className="s-help">
            Copies the plugin&rsquo;s source into your Downloads folder as a directory ready to
            publish. Push it to any public git repository and anyone can install it from the URL.
            A README and .gitignore are included.
          </p>
          <label className="s-checkline">
            <input type="checkbox" checked={mit} onChange={(event) => setMit(event.target.checked)} />
            Add an MIT license (recommended, matches Lumanin&rsquo;s own)
          </label>
          <div className="s-modal__buttons">
            <button type="button" className="s-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="s-button s-button--primary"
              disabled={busy}
              aria-busy={busy}
              onClick={doExport}
            >
              Export
              {busy && <Busy />}
            </button>
          </div>
        </>
      )}

      {result !== null && !result.ok && (
        <>
          <div className="s-error">{result.detail ?? 'That could not be exported'}</div>
          <div className="s-modal__buttons">
            <button type="button" className="s-button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}

      {result !== null && result.ok && (
        <>
          <p className="s-help">
            Exported to <code>{result.directory}</code>
          </p>
          {result.publishedAt !== undefined && (
            <p className="s-help">
              This plugin was installed from {result.publishedAt}, so it is already published
              there. Export it to start a fork.
            </p>
          )}
          {published === null && result.ghReady === true && (
            <p className="s-help">
              Publish it now? This creates a <b>public</b> GitHub repository named{' '}
              <code>{plugin.name}</code> on your account (via your signed-in <code>gh</code>) and
              pushes the export to it.
            </p>
          )}
          {published === null && result.ghReady !== true && (
            <p className="s-help">
              To publish: create an empty public repository, then in that directory run{' '}
              <code>git init && git add . && git commit</code>, add the remote, and push. With
              GitHub&rsquo;s <code>gh</code> CLI signed in, this screen offers a one-button publish.
            </p>
          )}
          {published !== null && published.ok && (
            <p className="s-help">
              Published{published.url === undefined ? '' : ` at ${published.url}`}. Anyone installs
              it with: <code>lumanin plugin-install {published.url ?? '<url>'}</code>
            </p>
          )}
          {published !== null && !published.ok && <div className="s-error">{published.detail}</div>}
          <div className="s-modal__buttons">
            <button type="button" className="s-button" onClick={onClose}>
              Close
            </button>
            {result.ghReady === true && (published === null || !published.ok) && (
              <button
                type="button"
                className="s-button s-button--primary"
                disabled={busy}
                aria-busy={busy}
                onClick={doPublish}
              >
                Create repository & push
                {busy && <Busy />}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

export function PreferenceRow({
  extension,
  command,
  preference,
  onChanged
}: {
  extension: string
  command: string
  preference: PluginPreferenceDto
  /** Re-fetch after a save: the control shows the stored value, not a local one. */
  onChanged: () => void
}): React.JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const save = (value: string | number | boolean): void => {
    setProblem(null)
    window.lumanin
      .invoke('settings.setPreference', { extension, command, name: preference.name, value })
      .then((result: { ok: boolean; detail?: string }) => {
        if (!result.ok) setProblem(result.detail ?? 'That could not be saved')
        else onChanged()
      })
      .catch((cause: unknown) => {
        setProblem(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const help = [
    preference.description,
    preference.required ? 'required' : null,
    preference.type === 'password' ? 'stored unencrypted on this machine, readable only by your user' : null
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' · ')

  let control: React.JSX.Element
  if (preference.type === 'checkbox') {
    control = (
      <Toggle
        checked={
          typeof preference.value === 'boolean' ? preference.value : preference.default === true
        }
        onChange={save}
      />
    )
  } else if (preference.type === 'dropdown' && preference.data !== undefined) {
    control = (
      <PickButton
        title={preference.title}
        value={String(preference.value ?? preference.default ?? '')}
        options={preference.data.map((option) => ({ value: option.value, label: option.title }))}
        onPick={save}
      />
    )
  } else if (preference.type === 'password') {
    control = (
      <PasswordControl
        stored={typeof preference.value === 'string' && preference.value.length > 0}
        onSave={save}
      />
    )
  } else {
    control = (
      <TextControl
        value={typeof preference.value === 'string' ? preference.value : ''}
        placeholder={preference.placeholder ?? (preference.default === undefined ? '' : String(preference.default))}
        onSave={save}
      />
    )
  }

  return (
    <Row label={preference.title} help={help}>
      {control}
      {problem !== null && <div className="s-error">{problem}</div>}
    </Row>
  )
}

/**
 * A stored secret is never echoed back into the page — the field shows that
 * one is set and takes a replacement. It never leaves this machine either;
 * that is the whole no-sign-in model.
 */
function PasswordControl({
  stored,
  onSave
}: {
  stored: boolean
  onSave: (value: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  return (
    <div className="s-inline">
      <input
        className="s-input"
        type="password"
        placeholder={stored ? '••••••••  (set, type to replace)' : 'Paste the token'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.length > 0) {
            onSave(text)
            setText('')
          }
        }}
      />
    </div>
  )
}

/**
 * The official index (the Lumanin-Plugins repository), fetched when its tab is
 * opened and never before — the launcher's no-requests rule holds until the
 * user asks to browse. Picking one feeds the same inspect-and-consent flow a
 * pasted URL takes; this list is discovery, not a separate install path.
 */
function OfficialTab(): React.JSX.Element {
  const { state } = useSettingsState()
  const flow = useInstallFlow(() => undefined)
  const [plugins, setPlugins] = useState<readonly OfficialPluginDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.lumanin
      .invoke('settings.officialPlugins')
      .then((result) => {
        if (!live) return
        if (result.ok) setPlugins(result.plugins)
        else setError(result.error ?? 'The plugin index could not be loaded')
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      live = false
    }
    // Re-read after any state change: an install flips a row to "Installed".
  }, [state])

  const busy = flow.inspecting || flow.installing
  return (
    <Section>
      {plugins === null && error === null && (
        <p className="s-help">
          Loading the official list
          <Busy />
        </p>
      )}
      {error !== null && <div className="s-error">{error}</div>}
      {plugins !== null && plugins.length === 0 && (
        <p className="s-help">The official collection is empty right now.</p>
      )}
      {plugins !== null &&
        plugins.map((plugin) => (
          <Row key={plugin.name} label={plugin.title} help={`${plugin.description} · by ${plugin.author}`}>
            {plugin.installed ? (
              <span className="s-list__detail">Installed</span>
            ) : (
              <button type="button" className="s-button" disabled={busy} onClick={() => flow.inspect(plugin.source)}>
                Install…
              </button>
            )}
          </Row>
        ))}
      {flow.outcome !== null && <p className="s-help">{flow.outcome}</p>}
      {flow.modal}
    </Section>
  )
}

// ---------------------------------------------------------------------------

interface InstallFlow {
  readonly source: string
  readonly setSource: (source: string) => void
  readonly inspecting: boolean
  readonly installing: boolean
  readonly progress: readonly string[]
  readonly outcome: string | null
  /** Fetch and show the consent modal for a source; without one, the typed source. */
  readonly inspect: (from?: string) => void
  /** The consent modal and the fetch error, rendered by whichever tab owns the flow. */
  readonly modal: React.JSX.Element
}

/** Fetch, review, install: one flow, shared by the URL field and the official list. */
function useInstallFlow(onInstalled: () => void): InstallFlow {
  const [source, setSource] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspection, setInspection] = useState<PluginInspectionDto | null>(null)
  const [progress, setProgress] = useState<readonly string[]>([])
  const [installing, setInstalling] = useState(false)
  const [allowDependencies, setAllowDependencies] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  useEffect(() => {
    return window.lumanin.on('settings.installProgress', ({ line }) => {
      setProgress((current) => [...current.slice(-30), line])
    }) as () => void
  }, [])

  const inspect = (from?: string): void => {
    const target = from ?? source
    if (from !== undefined) setSource(from)
    setInspecting(true)
    setOutcome(null)
    setProgress([])
    window.lumanin
      .invoke('settings.inspectPlugin', { source: target })
      .then((result) => {
        setInspecting(false)
        setInspection(result)
        setAllowDependencies(false)
      })
      .catch((cause: unknown) => {
        // Without this a rejection leaves the button busy with the rest dead.
        setInspecting(false)
        setInspection({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  const install = (): void => {
    setInstalling(true)
    setProgress([])
    window.lumanin
      .invoke('settings.installPlugin', { source, allowDependencies })
      .then((result) => {
        setInstalling(false)
        setInspection(null)
        setOutcome(result.detail)
        if (result.ok) {
          setSource('')
          onInstalled()
        }
      })
      .catch((cause: unknown) => {
        setInstalling(false)
        setInspection(null)
        setOutcome(cause instanceof Error ? cause.message : String(cause))
      })
  }

  const modal = (
    <>
      {inspection !== null && !inspection.ok && (
        <div className="s-error">{inspection.error ?? 'That could not be fetched'}</div>
      )}
      {inspection !== null && inspection.ok && (
        <Modal title={`Install ${inspection.title ?? ''}?`} onClose={() => setInspection(null)} wide>
          <div className="s-facts">
            <div>
              <b>{inspection.title}</b> ({inspection.name})
            </div>
            <div>{inspection.description}</div>
            <div>By {inspection.author}</div>
            {inspection.commit !== undefined && <div>Commit {inspection.commit}</div>}
            <div>Commands: {inspection.commands?.join(', ') ?? 'none'}</div>
            <div>
              Packages:{' '}
              {inspection.dependencies !== undefined && inspection.dependencies.length > 0
                ? `${String(inspection.dependencies.length)}: ${inspection.dependencies.join(', ')}`
                : 'none. It depends on nothing outside Lumanin.'}
            </div>
            {inspection.replacing === true && (
              <div className="s-error">
                This replaces the “{inspection.name}” you already have installed.
              </div>
            )}
          </div>
          <p className="s-help">
            A plugin is a program. Running one gives its code the same access to your files, your
            network and your session that you have, the same trust as <code>npm install</code> or
            an AUR package. Nothing is sandboxed, and nobody has reviewed this code. Read it first
            if you do not know the author: <code>{inspection.directory}</code>
          </p>
          {inspection.dependencies !== undefined && inspection.dependencies.length > 0 && (
            <label className="s-checkline">
              <input
                type="checkbox"
                checked={allowDependencies}
                onChange={(event) => setAllowDependencies(event.target.checked)}
              />
              Allow it to install these npm packages (their install scripts stay disabled)
            </label>
          )}
          {installing && progress.length > 0 && <pre className="s-progress">{progress.join('\n')}</pre>}
          <div className="s-modal__buttons">
            <button type="button" className="s-button" onClick={() => setInspection(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="s-button s-button--primary"
              disabled={
                installing ||
                (inspection.dependencies !== undefined &&
                  inspection.dependencies.length > 0 &&
                  !allowDependencies)
              }
              aria-busy={installing}
              onClick={install}
            >
              Install
              {installing && <Busy />}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
  return { source, setSource, inspecting, installing, progress, outcome, inspect, modal }
}

function InstallSection({ onInstalled }: { onInstalled: () => void }): React.JSX.Element {
  const flow = useInstallFlow(onInstalled)
  return (
    <Section title="Install a plugin" keywords="repository url directory fetch">
      <div className="s-inline">
        <TextControl
          value={flow.source}
          placeholder="owner/name, https://…, or a directory on this machine"
          onSave={flow.setSource}
          onLiveChange={flow.setSource}
        />
        <button
          type="button"
          className="s-button"
          disabled={flow.source.trim().length === 0 || flow.inspecting}
          aria-busy={flow.inspecting}
          onClick={() => flow.inspect()}
        >
          Fetch & review
          {flow.inspecting && <Busy />}
        </button>
      </div>
      {flow.inspecting && flow.progress.length > 0 && <pre className="s-progress">{flow.progress.join('\n')}</pre>}
      {flow.outcome !== null && <p className="s-help">{flow.outcome}</p>}
      {flow.modal}
    </Section>
  )
}
