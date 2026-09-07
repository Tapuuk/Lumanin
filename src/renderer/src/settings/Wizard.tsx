import { useEffect, useState } from 'react'
import type { SetupPlanDto } from '@shared/ipc'
import { GLOBAL_HOTKEY } from '@shared/settings-model'
import { Busy, HotkeyCapture, isCaptureActive, Row } from './controls'
import { Logo } from './Logo'
import { guarded, setConfig, useSettingsState } from './useSettings'

/**
 * First run: three steps on one card. Choices (theme, the two keys), then
 * writing those keys into the desktop's own shortcut config, then done.
 *
 * Every control has a default, and the wizard writes nothing unless the
 * person actually picks something. "Later" on the second step leaves the keys
 * saved but unapplied; the sentence under the buttons says where to apply them.
 *
 * The mounting rule matters more than it looks: the very first choice in here
 * creates `config.toml`, which makes `firstRun` false on the next state push.
 * The *shell* latches the wizard open (see `SettingsApp`), so it closes when
 * the person says so and never out from under their click.
 */

type Step = 'setup' | 'apply' | 'done'
const ORDER: readonly Step[] = ['setup', 'apply', 'done']

export function Wizard({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const [step, setStep] = useState<Step>('setup')

  const finish = (): void => {
    // `.finally`: even if marking first-run done fails, the wizard must close
    // rather than trap the user in it.
    window.lumanin
      .invoke('settings.finishFirstRun')
      .catch(() => undefined)
      .finally(onDone)
  }

  const close = (): void => {
    window.lumanin
      .invoke('settings.finishFirstRun')
      .catch(() => undefined)
      .then(() => window.lumanin.invoke('settings.close'))
      .catch(() => undefined)
  }

  // Esc never reaches the app's close handler while the wizard is up. On the
  // first step it is "Skip setup", on the last it is "Open Settings"; on the
  // apply step the visible buttons decide.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isCaptureActive()) return
      event.stopPropagation()
      event.preventDefault()
      if (step === 'setup' || step === 'done') finish()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  if (state === null) return <></>

  const at = ORDER.indexOf(step)
  const go = (delta: number): void => {
    const next = ORDER[at + delta]
    if (next !== undefined) setStep(next)
  }

  return (
    <div className="wiz">
      <div className="wiz__card">
        <div className="wiz__dots" aria-label={`Step ${String(at + 1)} of ${String(ORDER.length)}`}>
          {ORDER.map((dot) => (
            <span
              key={dot}
              className={`wiz__dot${ORDER.indexOf(dot) <= at ? ' wiz__dot--done' : ''}`}
            />
          ))}
        </div>

        {step === 'setup' && <SetupChoicesStep onLeave={finish} onNext={() => go(1)} />}
        {step === 'apply' && <SetupStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'done' && <Done onOpenSettings={finish} onClose={close} />}
      </div>
    </div>
  )
}

function SetupChoicesStep({ onLeave, onNext }: { onLeave: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>
  const current = state.resolved.appearance.theme.value

  return (
    <>
      <div className="wiz__head">
        <Logo className="wiz__logo" />
        <h1 className="wiz__title">Set up Lumanin</h1>
      </div>
      <p className="wiz__lead">Three short steps. Everything has a default, so change only what you want.</p>
      <div className="wiz__choices">
        <button
          type="button"
          className={`wiz__choice${current === null ? ' wiz__choice--picked' : ''}`}
          onClick={() => guarded(setConfig(['appearance', 'theme'], null))}
        >
          <span className="wiz__choice-name">Adaptive</span>
          <span className="wiz__choice-note">Follows the desktop</span>
        </button>
        {state.themes.map((theme) => (
          <button
            key={theme.value}
            type="button"
            className={`wiz__choice${current === theme.value ? ' wiz__choice--picked' : ''}`}
            onClick={() => guarded(setConfig(['appearance', 'theme'], theme.value))}
          >
            <span className="wiz__choice-name">{theme.label}</span>
          </button>
        ))}
      </div>
      <Row label={GLOBAL_HOTKEY.label}>
        <HotkeyCapture
          value={state.resolved.general.hotkey.value}
          onPick={(next) => {
            if (next !== null) guarded(setConfig(['general', 'hotkey'], next))
          }}
        />
      </Row>
      <Row
        label="File search key"
        help="Backspace while capturing removes the key."
      >
        <HotkeyCapture
          value={state.resolved.fileSearch.hotkey.value}
          allowNone
          onPick={(next) => {
            guarded(setConfig(['file_search', 'hotkey'], next ?? ''))
          }}
        />
      </Row>
      <div className="wiz__buttons">
        <button type="button" className="wiz__skip" onClick={onLeave}>
          Skip setup
        </button>
        <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
          Next
        </button>
      </div>
    </>
  )
}

function SetupStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const [plan, setPlan] = useState<SetupPlanDto | null>(null)
  const [showDetails, setShowDetails] = useState(true)
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState<
    | null
    | { readonly results: readonly { target: string; ok: boolean; detail?: string }[]; readonly notes: readonly string[] }
  >(null)

  useEffect(() => {
    window.lumanin
      .invoke('settings.planSetup')
      .then(setPlan)
      .catch(() => {
        // A failed probe still needs a step that can be left: an empty plan
        // renders the "nothing to write" path instead of the busy lead.
        setPlan({ edits: [], commands: [], notes: [], pending: false, manual: [] })
      })
  }, [])

  if (state === null) return <></>

  const apply = (): void => {
    setApplying(true)
    window.lumanin
      .invoke('settings.applySetup')
      .then((outcome) => {
        setApplying(false)
        setApplied(outcome)
      })
      .catch((cause: unknown) => {
        // Without this a rejection wedges the step on a busy button.
        setApplying(false)
        setApplied({
          results: [
            {
              target: 'shortcut config',
              ok: false,
              detail: cause instanceof Error ? cause.message : String(cause)
            }
          ],
          notes: []
        })
      })
  }

  return (
    <>
      <h1 className="wiz__title">Make it stick</h1>

      {plan === null && (
        <p className="wiz__lead">
          Checking your desktop
          <Busy />
        </p>
      )}

      {plan !== null && applied === null && (
        <>
          {plan.pending ? (
            <p className="wiz__lead">
              Lumanin writes a few lines into your desktop&apos;s own config so the keys work
              everywhere and the launcher starts with your session. Every touched file is backed
              up first.
            </p>
          ) : (
            <p className="wiz__lead">
              {state.bindable ? (
                'Everything is already in place. Nothing to write.'
              ) : (
                <>
                  This desktop keeps shortcuts in its own settings. Add one there that runs{' '}
                  <code>lumanin toggle</code>. Everything else already works.
                </>
              )}
            </p>
          )}

          {plan.pending && (
            <button type="button" className="wiz__details-toggle" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? 'Hide the exact changes' : 'Show exactly what changes'}
            </button>
          )}
          {showDetails && (
            <div className="wiz__details">
              {plan.edits
                .filter((edit) => edit.state === 'will-add' || edit.state === 'will-update')
                .map((edit) => (
                  <div key={edit.path} className="s-diff">
                    <div className="s-diff__path">{edit.path}</div>
                    <pre className="s-diff__body">{edit.diff}</pre>
                  </div>
                ))}
              {plan.commands.map((command) => (
                <div key={command.title} className="s-diff">
                  <div className="s-diff__path">{command.title}. These commands would run:</div>
                  <pre className="s-diff__body">{command.preview.join('\n')}</pre>
                </div>
              ))}
              {plan.manual.map((manual) => (
                <div key={manual.title} className="s-diff">
                  <div className="s-diff__path">{manual.title}. Needs you, never run automatically:</div>
                  <pre className="s-diff__body">{manual.commands.join('\n')}</pre>
                </div>
              ))}
            </div>
          )}

          <div className="wiz__buttons">
            <button type="button" className="s-button" onClick={onBack}>
              Back
            </button>
            <span className="wiz__button-pair">
              {plan.pending ? (
                <>
                  <button type="button" className="s-button" onClick={onNext}>
                    Later
                  </button>
                  <button
                    type="button"
                    className="s-button s-button--primary wiz__next"
                    disabled={applying}
                    aria-busy={applying}
                    onClick={apply}
                  >
                    Apply
                    {applying && <Busy />}
                  </button>
                </>
              ) : (
                <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
                  Next
                </button>
              )}
            </span>
          </div>
          {plan.pending && (
            <p className="s-help wiz__after">
              Later keeps the keys saved but not applied. Apply them any time on the Keys screen or
              with <code>lumanin doctor --fix</code>.
            </p>
          )}
        </>
      )}

      {applied !== null && (
        <>
          <div className="wiz__details">
            {applied.results.map((result) => (
              <div key={result.target} className={result.ok ? 's-ok' : 's-error'}>
                {result.ok ? '✔' : '✘'} {result.target}
                {result.detail !== undefined ? `: ${result.detail}` : ''}
              </div>
            ))}
            {applied.notes.map((note) => (
              <p key={note} className="s-help">
                {note}
              </p>
            ))}
          </div>
          <div className="wiz__buttons">
            <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
              Next
            </button>
          </div>
        </>
      )}
    </>
  )
}

function Done({ onOpenSettings, onClose }: { onOpenSettings: () => void; onClose: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const key = state?.resolved.general.hotkey.value ?? 'Super+R'

  return (
    <>
      <div className="wiz__head">
        <Logo className="wiz__logo" />
        <h1 className="wiz__title">All set</h1>
      </div>
      <p className="wiz__lead">
        Press <span className="s-chip">{key}</span> and start typing. Change any of this later in
        Settings.
      </p>
      <div className="wiz__buttons">
        <button type="button" className="s-button" onClick={onOpenSettings}>
          Open Settings
        </button>
        <button type="button" className="s-button s-button--primary wiz__next" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  )
}
