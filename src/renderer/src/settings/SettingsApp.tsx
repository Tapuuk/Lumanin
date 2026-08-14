import { useEffect, useState } from 'react'

import { useTheme } from '../useTheme'
import { BindBanner } from './bind'
import { Logo } from './Logo'
import { AppearanceScreen, FileSearchScreen, GeneralScreen, KeysScreen } from './screens-basic'
import { PluginsScreen } from './screens-plugins'
import { HotkeysScreen, SearchScreen } from './screens-search'
import { SettingsProvider, useSettingsState } from './useSettings'
import { Wizard } from './Wizard'

/**
 * The settings app's shell: a themed titlebar, a section sidebar, and a content
 * pane. The sections mirror `lumanin config`'s menu one for one — the two are
 * the same settings model behind different frontends, and a screen existing in
 * one but not the other would mean they had drifted.
 *
 * Everything here wears the launcher's own tokens (`--lumanin-*`), applied and
 * hot-swapped by the same `useTheme` the panel uses, so a theme change repaints
 * both applications in the same moment.
 */

const SECTIONS = [
  { id: 'general', title: 'General', hint: 'Panel behaviour and size' },
  { id: 'appearance', title: 'Appearance', hint: 'Theme, light/dark, animations' },
  { id: 'search', title: 'Global Search', hint: 'Hotkey, ranking, web searches, pins, aliases' },
  { id: 'file-search', title: 'File Search', hint: 'Its key, categories, opening' },
  { id: 'keys', title: 'Action Keys', hint: 'The panel’s own keys' },
  { id: 'hotkeys', title: 'Plugin Hotkeys', hint: 'Global keys bound straight to plugins' },
  { id: 'plugins', title: 'Plugins', hint: 'Installed plugins, preferences, installing' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsApp(): React.JSX.Element {
  useTheme()

  // Esc closes the window, matching the panel's habit — unless a modal is up,
  // which handles Esc itself in the capture phase.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void window.lumanin.invoke('settings.close')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <SettingsProvider>
      <Shell />
    </SettingsProvider>
  )
}

/** A write that was refused, surfaced once wherever it happened. */
function SaveErrorBanner(): React.JSX.Element | null {
  const { saveError, clearSaveError } = useSettingsState()
  if (saveError === null) return null
  return (
    <div className="s-banner">
      <div className="s-error">{saveError}</div>
      <button type="button" className="s-button" onClick={clearSaveError}>
        Dismiss
      </button>
    </div>
  )
}

function Shell(): React.JSX.Element {
  const { state, refresh } = useSettingsState()
  const [active, setActive] = useState<SectionId>('general')
  // Latched, not live: the first thing anyone does in the wizard creates
  // `config.toml`, which flips `firstRun` false on the next state push — and
  // an un-latched wizard vanished under the very click that used it. Once
  // open, it closes only when the person says so.
  const [wizard, setWizard] = useState<boolean | null>(null)
  useEffect(() => {
    if (wizard === null && state !== null) setWizard(state.firstRun)
  }, [wizard, state])
  const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0]

  return (
    <div className="settings">
      {wizard === true && (
        <Wizard
          onDone={() => {
            setWizard(false)
            void refresh()
          }}
        />
      )}
      <header className="settings__titlebar">
        <Logo className="settings__logo" />
        <span className="settings__title">Lumanin Settings</span>
        <button
          type="button"
          className="settings__close"
          aria-label="Close"
          onClick={() => void window.lumanin.invoke('settings.close')}
        >
          ✕
        </button>
      </header>

      <div className="settings__body">
        <nav className="settings__sidebar" aria-label="Sections">
          {SECTIONS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="settings__section"
              aria-current={candidate.id === active ? 'page' : undefined}
              onClick={() => setActive(candidate.id)}
            >
              {candidate.title}
            </button>
          ))}
        </nav>

        <main className="settings__content">
          <h1 className="settings__heading">{section.title}</h1>
          <p className="settings__hint">{section.hint}</p>

          {state !== null && state.parseError !== null ? (
            <div className="s-error">
              {state.configPath} does not parse, so it cannot be edited safely: {state.parseError}
              <br />
              Fix it by hand, or move it aside and reopen this window.
            </div>
          ) : (
            <>
              <SaveErrorBanner />
              {/* Not while the wizard is up: its "Make it stick" step is the
                  one place first-run compositor writes happen. */}
              {wizard !== true && <BindBanner />}
              {active === 'general' && <GeneralScreen />}
              {active === 'appearance' && <AppearanceScreen />}
              {active === 'search' && <SearchScreen />}
              {active === 'file-search' && <FileSearchScreen />}
              {active === 'keys' && <KeysScreen />}
              {active === 'hotkeys' && <HotkeysScreen />}
              {active === 'plugins' && <PluginsScreen />}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
