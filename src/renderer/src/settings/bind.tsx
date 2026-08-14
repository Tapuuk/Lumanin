import { useCallback, useEffect, useRef, useState } from 'react'
import type { BindPlanDto, ManagedBindDto } from '@shared/ipc'
import { formatHotkey } from '@shared/hotkey'
import { useSettingsState } from './useSettings'

/**
 * The compositor half of every global key: `config.toml` says what the user
 * wants, and a file the *desktop* owns says what actually fires. The two are
 * never assumed to agree — this banner exists exactly when they differ.
 *
 * In this app the difference is applied **automatically** (user decision,
 * 2026-08-11): changing a hotkey in a settings window *is* the consent, and a
 * second "Review & apply" click on top of it was a step nobody wanted. The
 * banner therefore reports what happened — written, or failed and why — rather
 * than asking permission. The CLI keeps its explicit consent flow (a terminal
 * edit may be scripted or remote), and the wizard keeps its own apply step;
 * `settings.applyBind` still re-plans from disk, and backups are still taken.
 *
 * Two bounds on "automatically". A difference that already existed when the
 * window opened was not created by an edit here, so it gets an Apply button
 * instead — otherwise merely opening settings would rewrite compositor config,
 * which is exactly the unasked write the consent rule forbids. And while the
 * first-run wizard is up the banner is not rendered at all (SettingsApp), so
 * its own "Make it stick" step stays the one that writes.
 */

export function useBindPlan(): { plan: BindPlanDto | null; replan: () => void } {
  const { state } = useSettingsState()
  const [plan, setPlan] = useState<BindPlanDto | null>(null)
  // Plans can resolve out of order — only the latest request may land, or a
  // stale pending plan re-arms the auto-apply for work already done.
  const generation = useRef(0)

  const replan = useCallback(() => {
    const ticket = ++generation.current
    window.lumanin
      .invoke('settings.planBind')
      .then((next) => {
        if (generation.current === ticket) setPlan(next)
      })
      .catch(() => undefined)
  }, [])

  // Re-plan whenever the config changed — a saved hotkey is what creates the
  // difference this reports.
  useEffect(() => {
    replan()
  }, [replan, state])

  return { plan, replan }
}

export function useManagedBinds(): readonly ManagedBindDto[] {
  const { state } = useSettingsState()
  const [binds, setBinds] = useState<readonly ManagedBindDto[]>([])
  useEffect(() => {
    void window.lumanin.invoke('settings.readBinds').then(setBinds)
  }, [state])
  return binds
}

/** Is this chord (formatHotkey spelling) actually bound to this target right now? */
export function boundState(
  binds: readonly ManagedBindDto[],
  hotkey: string,
  target: string | null
): 'bound' | 'not-bound' {
  const match = binds.some(
    (bind) =>
      bind.target === target &&
      bind.hotkey !== null &&
      formatHotkey(bind.hotkey) === hotkey
  )
  return match ? 'bound' : 'not-bound'
}

type ApplyOutcome = {
  readonly results: readonly { target: string; ok: boolean; detail?: string }[]
  readonly notes: readonly string[]
}

/** What makes two plans "the same attempt", so a failure is not retried forever. */
function planSignature(plan: BindPlanDto): string {
  return JSON.stringify([
    plan.edits.map((edit) => [edit.path, edit.state, edit.diff]),
    plan.commands.map((command) => command.preview)
  ])
}

export function BindBanner(): React.JSX.Element | null {
  const { state } = useSettingsState()
  const { plan, replan } = useBindPlan()
  const [applying, setApplying] = useState(false)
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null)
  // One attempt per distinct plan: a write that failed must surface, not loop.
  const attempted = useRef<string | null>(null)
  // The signature of whatever difference existed when the window opened. That
  // one was not made by an edit here, so it never auto-applies.
  const baseline = useRef<string | null | undefined>(undefined)

  const bindable = state !== null && state.bindable
  const signature = plan !== null && plan.pending ? planSignature(plan) : null
  if (plan !== null && baseline.current === undefined) baseline.current = signature

  const apply = useCallback(() => {
    setApplying(true)
    window.lumanin
      .invoke('settings.applyBind')
      .then((result) => {
        setApplying(false)
        setOutcome(result)
        replan()
      })
      .catch((cause: unknown) => {
        // Without this, a rejection leaves the banner on "Writing…" forever.
        setApplying(false)
        setOutcome({
          results: [
            {
              target: 'shortcut config',
              ok: false,
              detail: cause instanceof Error ? cause.message : String(cause)
            }
          ],
          notes: []
        })
        replan()
      })
  }, [replan])

  useEffect(() => {
    if (!bindable || signature === null || applying) return
    if (signature === baseline.current) return
    if (attempted.current === signature) return
    attempted.current = signature
    apply()
  }, [bindable, signature, applying, apply])

  if (state === null) return null
  if (!state.bindable) {
    return (
      <div className="s-banner s-banner--info">
        This desktop binds shortcuts through its own settings - add a shortcut there running{' '}
        <code>lumanin toggle</code> (and <code>lumanin open …</code> for the rest). The values here
        stay what Lumanin reports.
      </div>
    )
  }

  if (applying) {
    return <div className="s-banner">Writing this desktop&apos;s shortcut config…</div>
  }

  if (outcome !== null) {
    const failures = outcome.results.filter((result) => !result.ok)
    return (
      <div className={`s-banner${failures.length > 0 ? '' : ' s-banner--info'}`}>
        <div>
          {failures.length === 0 ? (
            <span>Shortcuts updated. A backup of every touched file was kept.</span>
          ) : (
            failures.map((result) => (
              <div key={result.target} className="s-error">
                ✘ {result.target}
                {result.detail !== undefined ? ` - ${result.detail}` : ''}
              </div>
            ))
          )}
          {outcome.notes.map((note) => (
            <p key={note} className="s-help">
              {note}
            </p>
          ))}
        </div>
        <span>
          {failures.length > 0 && (
            <button
              type="button"
              className="s-button"
              onClick={() => {
                attempted.current = null
                setOutcome(null)
                replan()
              }}
            >
              Try again
            </button>
          )}
          <button type="button" className="s-button" onClick={() => setOutcome(null)}>
            Dismiss
          </button>
        </span>
      </div>
    )
  }

  // A blocked edit is a write this desktop refused (a Lua Hyprland config, a
  // sway config that does not exist to edit). It has to say so even when it is
  // the *whole* plan — a blocked-only plan is not `pending`, so this check
  // cannot live behind the signature guard: that silence read as "all bound".
  if (plan !== null) {
    const blocked = plan.edits.filter((edit) => edit.state === 'blocked')
    if (blocked.length > 0) {
      return (
        <div className="s-banner">
          {blocked.map((edit) => (
            <div key={edit.path} className="s-error">
              {edit.path}: {edit.problem ?? 'Blocked'}
            </div>
          ))}
        </div>
      )
    }
  }
  if (signature !== null && plan !== null) {
    // A difference that predates this window — config.toml and the compositor
    // already disagreed at open. Offer the write, never make it unasked.
    if (signature === baseline.current) {
      return (
        <div className="s-banner">
          <div>
            This desktop&apos;s shortcut config does not match your settings yet.
          </div>
          <button
            type="button"
            className="s-button s-button--primary"
            onClick={() => {
              baseline.current = null
              attempted.current = signature
              apply()
            }}
          >
            Apply
          </button>
        </div>
      )
    }
  }

  return null
}
