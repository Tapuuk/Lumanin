import { useCallback, useEffect, useRef, useState } from 'react'

import { useTheme } from '../useTheme'
import { BindBanner } from './bind'
import { FilterContext } from './controls'
import { Logo } from './Logo'
import { KeysScreen, PanelScreen } from './screens-basic'
import { PluginsScreen } from './screens-plugins'
import { SearchScreen } from './screens-search'
import { firstSectionMatching, matchesFilter, SECTIONS, sectionIndex, type SectionId } from './sections'
import { focusRow, useShellKeyboard } from './shell-keys'
import { SettingsProvider, useSettingsState } from './useSettings'
import { Wizard } from './Wizard'

/**
 * The settings app's shell: a themed titlebar, a section sidebar, and a content
 * pane. Four sections: Panel, Search, Keys, Plugins. `lumanin config` edits the
 * same settings model behind its own menu; only the grouping differs.
 *
 * Everything here wears the launcher's own tokens (`--lumanin-*`), applied and
 * hot-swapped by the same `useTheme` the panel uses, so a theme change repaints
 * both applications in the same moment.
 */

export function SettingsApp(): React.JSX.Element {
  useTheme()

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
  const [active, setActive] = useState<SectionId>('panel')
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)
  const content = useRef<HTMLElement>(null)
  // Latched, not live: the first thing anyone does in the wizard creates
  // `config.toml`, which flips `firstRun` false on the next state push — and
  // an un-latched wizard vanished under the very click that used it. Once
  // open, it closes only when the person says so.
  const [wizard, setWizard] = useState<boolean | null>(null)
  useEffect(() => {
    if (wizard === null && state !== null) setWizard(state.firstRun)
  }, [wizard, state])
  const section = SECTIONS.find((candidate) => candidate.id === active) ?? SECTIONS[0]

  // A filter the open section cannot answer jumps to the first section that
  // can. Clearing it changes nothing: whatever was open stays open.
  const themes = state?.themes
  const applyFilter = useCallback(
    (next: string): void => {
      setFilter(next)
      if (themes === undefined || next.trim().length === 0) return
      setActive((current) => {
        if (matchesFilter(next, ...sectionIndex(themes)[current])) return current
        return firstSectionMatching(next, themes) ?? current
      })
    },
    [themes]
  )
  useShellKeyboard({ enabled: wizard !== true, filter, setFilter: applyFilter, filterInput, content, setActive })

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
          <input
            ref={filterInput}
            className="settings__filter"
            type="search"
            placeholder="Filter settings"
            aria-label="Filter settings"
            value={filter}
            onChange={(event) => applyFilter(event.target.value)}
            onKeyDown={(event) => {
              // Esc with text clears it and leaves; the shell's Esc order
              // then continues from an empty filter next time. Down enters
              // the rows.
              if (event.key === 'Escape' && filter.trim().length > 0) {
                event.preventDefault()
                event.stopPropagation()
                applyFilter('')
                event.currentTarget.blur()
              } else if (event.key === 'ArrowDown') {
                if (focusRow(content.current, 1)) event.preventDefault()
              }
            }}
          />
          {SECTIONS.map((candidate, index) => (
            <button
              key={candidate.id}
              type="button"
              className="settings__section"
              aria-current={candidate.id === active ? 'page' : undefined}
              onClick={() => setActive(candidate.id)}
            >
              {candidate.title}
              <span className="settings__section-key">Ctrl+{String(index + 1)}</span>
            </button>
          ))}
        </nav>

        <FilterContext.Provider value={filter}>
          <main ref={content} className="settings__content">
            <h1 className="settings__heading">{section.title}</h1>

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
                {wizard !== true && <BindBanner visible={active === 'keys'} />}
                {active === 'panel' && <PanelScreen />}
                {active === 'search' && <SearchScreen />}
                {active === 'keys' && <KeysScreen />}
                {active === 'plugins' && <PluginsScreen />}
              </>
            )}
          </main>
        </FilterContext.Provider>
      </div>
    </div>
  )
}
