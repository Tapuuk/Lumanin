import { useEffect, useState } from 'react'
import { OFFERED_RESULT_GROUPS, RESULT_GROUP_LABELS, type ResultGroup } from '@shared/config'
import {
  completeFileOrder,
  FILE_CATEGORY_HINTS,
  FILE_CATEGORY_TITLES,
  type FileCategory
} from '@shared/files'
import type { SetupPlanDto } from '@shared/ipc'
import { HotkeyCapture, ReorderList } from './controls'
import { Logo } from './Logo'
import { move } from './screens-basic'
import { guarded, setConfig, useSettingsState } from './useSettings'

/**
 * First run: a full-window, one-question-at-a-time welcome.
 *
 * Every step can be skipped, and skipping means "keep the default" - the
 * wizard writes nothing unless the person actually picks something. The one
 * exception is the last real step: skipping the desktop setup means the keys
 * chosen two screens ago will not work outside this window, so that skip asks
 * once, plainly, before letting go.
 *
 * The mounting rule matters more than it looks: the very first choice in here
 * creates `config.toml`, which makes `firstRun` false on the next state push.
 * The *shell* latches the wizard open (see `SettingsApp`), so it closes when
 * the person says so and never out from under their click.
 */

type Step = 'welcome' | 'theme' | 'hotkey' | 'fskey' | 'order' | 'forder' | 'setup' | 'done'
const ORDER: readonly Step[] = ['welcome', 'theme', 'hotkey', 'fskey', 'order', 'forder', 'setup', 'done']
const DOTTED: readonly Step[] = ['theme', 'hotkey', 'fskey', 'order', 'forder', 'setup']

export function Wizard({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const [step, setStep] = useState<Step>('welcome')

  if (state === null) return <></>

  const at = ORDER.indexOf(step)
  const go = (delta: number): void => {
    const next = ORDER[at + delta]
    if (next !== undefined) setStep(next)
  }
  const finish = (): void => {
    // `.finally`: even if marking first-run done fails, the wizard must close
    // rather than trap the user in it.
    window.lumanin
      .invoke('settings.finishFirstRun')
      .catch(() => undefined)
      .finally(onDone)
  }

  return (
    <div className="wiz">
      <div className="wiz__card">
        {DOTTED.includes(step) && (
          <div className="wiz__dots" aria-label={`Step ${String(at)} of ${String(DOTTED.length)}`}>
            {DOTTED.map((dot) => (
              <span
                key={dot}
                className={`wiz__dot${ORDER.indexOf(dot) <= at ? ' wiz__dot--done' : ''}`}
              />
            ))}
          </div>
        )}

        {step === 'welcome' && <Welcome onNext={() => go(1)} onSkip={finish} />}
        {step === 'theme' && <ThemeStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'hotkey' && <HotkeyStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'fskey' && <FileKeyStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'order' && <OrderStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'forder' && <FileOrderStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'setup' && <SetupStep onBack={() => go(-1)} onNext={() => go(1)} />}
        {step === 'done' && <Done onFinish={finish} />}
      </div>
    </div>
  )
}

/** Back on the left; Skip and Next together on the right. Skip keeps the default. */
function Buttons({
  onBack,
  onSkip,
  onNext,
  nextLabel
}: {
  onBack: () => void
  onSkip?: () => void
  onNext: () => void
  nextLabel?: string
}): React.JSX.Element {
  return (
    <div className="wiz__buttons">
      <button type="button" className="s-button" onClick={onBack}>
        Back
      </button>
      <span className="wiz__button-pair">
        {onSkip !== undefined && (
          <button type="button" className="s-button" onClick={onSkip}>
            Skip
          </button>
        )}
        <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
          {nextLabel ?? 'Next'}
        </button>
      </span>
    </div>
  )
}

function Welcome({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }): React.JSX.Element {
  return (
    <>
      <div className="wiz__glyph">
        <Logo className="wiz__logo" />
      </div>
      <h1 className="wiz__title">Set up Lumanin</h1>
      <p className="wiz__lead">
        A few steps. Skip any of them and the default stays.
      </p>
      <div className="wiz__buttons wiz__buttons--center">
        <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
          Start
        </button>
      </div>
      <button type="button" className="wiz__skip" onClick={onSkip}>
        Skip setup
      </button>
    </>
  )
}

function ThemeStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>
  const current = state.resolved.appearance.theme.value

  return (
    <>
      <h1 className="wiz__title">Pick a look</h1>
      <p className="wiz__lead">
        The window updates as you pick. &ldquo;Follow the desktop&rdquo; keeps Lumanin matched to
        the system theme when it changes.
      </p>
      <div className="wiz__choices">
        <button
          type="button"
          className={`wiz__choice${current === null ? ' wiz__choice--picked' : ''}`}
          onClick={() => guarded(setConfig(['appearance', 'theme'], null))}
        >
          <span className="wiz__choice-name">Follow the desktop</span>
          <span className="wiz__choice-note">Recommended</span>
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
      <Buttons onBack={onBack} onSkip={onNext} onNext={onNext} />
    </>
  )
}

function HotkeyStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>

  return (
    <>
      <h1 className="wiz__title">Your search key</h1>
      <p className="wiz__lead">
        The key that opens the launcher from anywhere. Super+R is the default. Click below and
        press a combination to choose your own.
      </p>
      <div className="wiz__center">
        <HotkeyCapture
          value={state.resolved.general.hotkey.value}
          onPick={(next) => {
            if (next !== null) guarded(setConfig(['general', 'hotkey'], next))
          }}
        />
      </div>
      <Buttons onBack={onBack} onSkip={onNext} onNext={onNext} />
    </>
  )
}

function FileKeyStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>

  return (
    <>
      <h1 className="wiz__title">Your file search key</h1>
      <p className="wiz__lead">
        File search has its own key, so files never crowd the app list. Super+Shift+R is the
        default. Backspace while capturing removes the key.
      </p>
      <div className="wiz__center">
        <HotkeyCapture
          value={state.resolved.fileSearch.hotkey.value}
          allowNone
          onPick={(next) => {
            guarded(setConfig(['file_search', 'hotkey'], next ?? ''))
          }}
        />
      </div>
      <Buttons onBack={onBack} onSkip={onNext} onNext={onNext} />
    </>
  )
}

function OrderStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>
  // Inert groups (`files`, `calculator`) never appear: neither answers to a
  // position, so offering to move them would be offering a dead lever.
  const order = state.resolved.search.fallbackOrder.value.filter((group) =>
    OFFERED_RESULT_GROUPS.includes(group)
  )

  const hints: Readonly<Record<ResultGroup, string>> = {
    plugins: 'Your plugins',
    apps: 'Installed applications',
    commands: 'The launcher itself',
    calculator: 'Nothing, the calculator is always first',
    files: 'Nothing, file search is a plugin now',
    web: 'Web searches'
  }

  return (
    <>
      <h1 className="wiz__title">What wins a search</h1>
      <p className="wiz__lead">
        When kinds of result tie, the higher one here goes first. The default puts plugins first,
        then apps.
      </p>
      <div className="wiz__list">
        <ReorderList
          rows={[
            ...order.map((group) => ({
              id: group,
              label: RESULT_GROUP_LABELS[group],
              detail: hints[group],
              on: true
            })),
            ...OFFERED_RESULT_GROUPS.filter((group) => !order.includes(group)).map((group) => ({
              id: group,
              label: RESULT_GROUP_LABELS[group],
              detail: hints[group],
              on: false
            }))
          ]}
          onToggle={(id, next) => {
            const nextOrder = next
              ? [...order, id as ResultGroup]
              : order.filter((candidate) => candidate !== id)
            guarded(setConfig(['search', 'order'], nextOrder))
          }}
          onMove={(id, delta) => {
            const moved = move(order, id as ResultGroup, delta)
            if (moved !== null) guarded(setConfig(['search', 'order'], [...moved]))
          }}
        />
      </div>
      <Buttons onBack={onBack} onSkip={onNext} onNext={onNext} />
    </>
  )
}

function FileOrderStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  if (state === null) return <></>
  const order = completeFileOrder(state.resolved.fileSearch.order.value)

  return (
    <>
      <h1 className="wiz__title">What wins a file search</h1>
      <p className="wiz__lead">
        When file names tie, the higher kind here ranks first.
      </p>
      <div className="wiz__list">
        <ReorderList
          rows={order.map((category: FileCategory) => ({
            id: category,
            label: FILE_CATEGORY_TITLES[category],
            detail: FILE_CATEGORY_HINTS[category]
          }))}
          onMove={(id, delta) => {
            const moved = move(order, id as FileCategory, delta)
            if (moved !== null) guarded(setConfig(['file_search', 'order'], [...moved]))
          }}
        />
      </div>
      <Buttons onBack={onBack} onSkip={onNext} onNext={onNext} />
    </>
  )
}

function SetupStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const [plan, setPlan] = useState<SetupPlanDto | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [confirmingSkip, setConfirmingSkip] = useState(false)
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
        // renders the "nothing to write" path instead of "Having a look…".
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
        // Without this a rejection wedges the step on "Setting up…".
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

  // Skipping here is different from every other skip: the keys chosen two
  // screens ago exist only in config.toml until this step writes the desktop's
  // own shortcut config, so leaving now means they will not work yet.
  if (confirmingSkip) {
    return (
      <>
        <h1 className="wiz__title">Keys not applied yet</h1>
        <p className="wiz__lead">
          Your keys are saved but not yet written into this desktop&apos;s shortcut config, so
          pressing them does nothing. Apply them later with{' '}
          <code>lumanin doctor --fix</code> or from the Global Search screen.
        </p>
        <div className="wiz__buttons wiz__buttons--center">
          <button type="button" className="s-button" onClick={onNext}>
            Leave anyway
          </button>
          <button
            type="button"
            className="s-button s-button--primary wiz__next"
            onClick={() => setConfirmingSkip(false)}
          >
            Go back
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <h1 className="wiz__title">Make it stick</h1>

      {plan === null && <p className="wiz__lead">Checking your desktop&hellip;</p>}

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
                  <button type="button" className="s-button" onClick={() => setConfirmingSkip(true)}>
                    Skip
                  </button>
                  <button
                    type="button"
                    className="s-button s-button--primary wiz__next"
                    disabled={applying}
                    onClick={apply}
                  >
                    {applying ? 'Setting up…' : 'Set it up'}
                  </button>
                </>
              ) : (
                <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
                  Next
                </button>
              )}
            </span>
          </div>
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
          <div className="wiz__buttons wiz__buttons--center">
            <button type="button" className="s-button s-button--primary wiz__next" onClick={onNext}>
              Next
            </button>
          </div>
        </>
      )}
    </>
  )
}

function Done({ onFinish }: { onFinish: () => void }): React.JSX.Element {
  const { state } = useSettingsState()
  const key = state?.resolved.general.hotkey.value ?? 'Super+R'

  return (
    <>
      <div className="wiz__glyph">
        <Logo className="wiz__logo" />
      </div>
      <h1 className="wiz__title">All set</h1>
      <p className="wiz__lead">
        Press <span className="s-chip">{key}</span> and start typing. Change any of this later in
        Settings.
      </p>
      <div className="wiz__buttons wiz__buttons--center">
        <button type="button" className="s-button s-button--primary wiz__next" onClick={onFinish}>
          Start using Lumanin
        </button>
      </div>
    </>
  )
}
