import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyValue,
  encode,
  INERT,
  sameValue,
  type Choice,
  type Field,
  type FieldValue,
  type FormModel,
  type Values
} from './form-model'

export { readForm, emptyValue } from './form-model'
export type { Field, FieldKind, FieldValue, FormModel, Values } from './form-model'

/**
 * `<Form>` — the one view where the renderer holds state.
 *
 * Everywhere else the worker is the single source of truth and this side is a
 * player. A form cannot work that way: a
 * keystroke would have to cross two process boundaries and come back before the
 * character appeared, and the caret would jump every time a patch landed. So the
 * field values live here, the worker is *told* about changes, and what it sends
 * back is treated as a suggestion rather than an overwrite — see
 * {@link useFormState}.
 *
 * The form is still the worker's document. It decides which fields exist, what
 * they are called, which are in error and what the actions are. Only the values
 * the user is currently typing are ours. What a form node *says* is read in
 * `./form-model`, which has no DOM in it and is tested on its own.
 */

export interface FormState {
  readonly values: Values
  set(field: Field, value: FieldValue): void
  blur(field: Field): void
  focus(field: Field): void
  /** What `Action.SubmitForm` sends: every named field's current value. */
  payload(): Values
  /** Which field the view should move the caret to, consumed once. */
  readonly wanted: string | null
  clearWanted(): void
}

/**
 * The values, and everything that changes them.
 *
 * The rule that matters is how a controlled field is reconciled. A field with a
 * `value` prop is the worker's, so its prop wins — but only when it *changes*.
 * Taking it on every render instead would undo each keystroke the moment the
 * worker re-rendered for an unrelated reason, which is the classic way a
 * controlled input over IPC ends up rejecting every second character.
 */
export function useFormState(
  model: FormModel,
  send: (handlerId: string | null, payload?: unknown) => void,
  command: { readonly action: 'focus' | 'reset'; readonly id: string; readonly seq: number } | null
): FormState {
  const [values, setValues] = useState<Values>({})
  const [wanted, setWanted] = useState<string | null>(null)

  const fields = model.fields
  const latest = useRef({ fields, values })
  latest.current = { fields, values }

  // What the worker last said each controlled field held. Compared against the
  // incoming prop so an unchanged one leaves the user's typing alone.
  const fromWorker = useRef(new Map<string, FieldValue>())

  useEffect(() => {
    setValues((current) => {
      let next = current
      const write = (id: string, value: FieldValue): void => {
        if (next === current) next = { ...current }
        ;(next as Record<string, FieldValue>)[id] = value
      }

      for (const field of fields) {
        if (field.id === null || INERT.has(field.kind)) continue
        const seen = fromWorker.current

        if (field.controlled !== undefined) {
          const previous = seen.get(field.id)
          if (!sameValue(previous, field.controlled)) {
            seen.set(field.id, field.controlled)
            write(field.id, field.controlled)
          }
          continue
        }
        seen.delete(field.id)

        // A field the user has not touched and the worker does not control
        // starts at its `defaultValue`. Once it is in `values` it is the user's.
        if (!(field.id in current)) write(field.id, field.defaultValue ?? emptyValue(field.kind))
      }

      // A field that has gone away takes its value with it, or a form that swaps
      // one field for another would submit the departed one's answer.
      const live = new Set(fields.flatMap((field) => (field.id === null ? [] : [field.id])))
      for (const id of Object.keys(current)) {
        if (live.has(id)) continue
        if (next === current) next = { ...current }
        delete (next as Record<string, FieldValue>)[id]
      }

      return next
    })
  }, [fields])

  const set = useCallback(
    (field: Field, value: FieldValue) => {
      if (field.id !== null) setValues((current) => ({ ...current, [field.id as string]: value }))
      send(field.onChange, encode(value, field.kind))
    },
    [send]
  )

  /**
   * `onBlur` / `onFocus` carry a `Form.Event`, not a bare value.
   *
   * The shape is the spec's — `{ target: { id, value }, type }` — and extensions
   * destructure it directly, so a bare value here reads as `undefined.target`
   * inside someone else's validation function.
   */
  const event = useCallback(
    (field: Field, type: 'blur' | 'focus') => {
      const handlerId = type === 'blur' ? field.onBlur : field.onFocus
      if (handlerId === null || field.id === null) return
      const value = latest.current.values[field.id]
      send(handlerId, {
        target: { id: field.id, value: encode(value ?? emptyValue(field.kind), field.kind) },
        type
      })
    },
    [send]
  )

  const payload = useCallback((): Values => {
    const out: Record<string, FieldValue> = {}
    for (const field of latest.current.fields) {
      if (field.id === null || INERT.has(field.kind)) continue
      const value = latest.current.values[field.id] ?? emptyValue(field.kind)
      out[field.id] = encode(value, field.kind) as FieldValue
    }
    return out
  }, [])

  // `focus()` and `reset()` on a field ref, which arrived over `ext.command`.
  const applied = useRef(0)
  useEffect(() => {
    if (command === null || command.seq === applied.current) return
    applied.current = command.seq

    if (command.action === 'focus') {
      setWanted(command.id)
      return
    }
    const field = latest.current.fields.find((entry) => entry.id === command.id)
    if (field === undefined) return
    // The spec is explicit: reset goes back to `defaultValue` where there is
    // one, not to blank.
    setValues((current) => ({
      ...current,
      [command.id]: field.defaultValue ?? emptyValue(field.kind)
    }))
  }, [command])

  return {
    values,
    set,
    blur: useCallback((field: Field) => event(field, 'blur'), [event]),
    focus: useCallback((field: Field) => event(field, 'focus'), [event]),
    payload,
    wanted,
    clearWanted: useCallback(() => setWanted(null), [])
  }
}

// --- drawing -----------------------------------------------------------------

interface FormBodyProps {
  readonly model: FormModel
  readonly state: FormState
  readonly sessionId: string
  readonly onKeyDown: (event: React.KeyboardEvent) => void
}

export function FormBody({
  model,
  state,
  sessionId,
  onKeyDown
}: FormBodyProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)

  /**
   * Move the caret where something asked it to go.
   *
   * `autoFocus` on the first render, `ref.current.focus()` at any time. Done by
   * looking the control up in the DOM rather than by keeping a ref per field:
   * the field list is the worker's and changes shape between renders, so a map
   * of refs would be a second thing to keep in step with it.
   */
  const first = useRef(true)
  useEffect(() => {
    const target =
      state.wanted ??
      (first.current ? (model.fields.find((field) => field.autoFocus)?.id ?? null) : null)
    first.current = false
    if (target === null) return

    const control = container.current?.querySelector<HTMLElement>(
      `[data-field="${cssEscape(target)}"] .form__control`
    )
    control?.focus()
    if (state.wanted !== null) state.clearWanted()
  }, [state, model.fields])

  return (
    <div className="form" ref={container} onKeyDown={onKeyDown}>
      {model.isLoading && <div className="form__loading" role="status" aria-label="Loading" />}
      {model.fields.length === 0 ? (
        <div className="form__empty">This form has no fields.</div>
      ) : (
        model.fields.map((field) => (
          <FieldRow key={field.nodeId} field={field} state={state} sessionId={sessionId} />
        ))
      )}
    </div>
  )
}

function FieldRow({
  field,
  state,
  sessionId
}: {
  readonly field: Field
  readonly state: FormState
  readonly sessionId: string
}): React.JSX.Element {
  if (field.kind === 'separator') return <div className="form__separator" role="separator" />

  const value = field.id === null ? emptyValue(field.kind) : (state.values[field.id] ?? emptyValue(field.kind))

  return (
    <div
      className={`form__row${field.error === null ? '' : ' form__row--error'}`}
      {...(field.id === null ? {} : { 'data-field': field.id })}
    >
      <div className="form__label">
        {field.title !== null && <span className="form__title">{field.title}</span>}
        {field.info !== null && (
          <span className="form__info" title={field.info} aria-label={field.info}>
            ⓘ
          </span>
        )}
      </div>
      <div className="form__body">
        <Control field={field} value={value} state={state} sessionId={sessionId} />
        {field.error !== null && (
          <div className="form__error" role="alert">
            {field.error}
          </div>
        )}
      </div>
    </div>
  )
}

interface ControlProps {
  readonly field: Field
  readonly value: FieldValue
  readonly state: FormState
  readonly sessionId: string
}

function Control({ field, value, state, sessionId }: ControlProps): React.JSX.Element | null {
  const shared = {
    className: 'form__control',
    onFocus: () => state.focus(field),
    onBlur: () => state.blur(field),
    ...(field.error === null ? {} : { 'aria-invalid': true }),
    ...(field.placeholder === null ? {} : { placeholder: field.placeholder })
  }

  switch (field.kind) {
    case 'description':
      return <div className="form__description">{field.text ?? ''}</div>

    case 'text':
    case 'password':
      return (
        <input
          {...shared}
          type={field.kind === 'password' ? 'password' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => state.set(field, e.target.value)}
        />
      )

    case 'textarea':
      return (
        <textarea
          {...shared}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => state.set(field, e.target.value)}
        />
      )

    case 'checkbox':
      return (
        <label className="form__checkbox">
          <input
            {...shared}
            type="checkbox"
            checked={value === true}
            onChange={(e) => state.set(field, e.target.checked)}
          />
          {field.text !== null && <span>{field.text}</span>}
        </label>
      )

    case 'dropdown':
      return (
        <select
          {...shared}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => state.set(field, e.target.value)}
        >
          {/* Without a blank row a dropdown whose value is not among the choices
              silently displays the first one while submitting nothing. */}
          {field.choices.every((choice) => choice.value !== value) && <option value=""> - </option>}
          {groupChoices(field.choices).map((group) =>
            group.title === null ? (
              group.choices.map((choice) => (
                <option key={choice.id} value={choice.value}>
                  {choice.title}
                </option>
              ))
            ) : (
              <optgroup key={group.title} label={group.title}>
                {group.choices.map((choice) => (
                  <option key={choice.id} value={choice.value}>
                    {choice.title}
                  </option>
                ))}
              </optgroup>
            )
          )}
        </select>
      )

    case 'tagpicker': {
      const chosen = Array.isArray(value) ? value : []
      return (
        <div className="form__tags">
          {field.choices.map((choice) => {
            const on = chosen.includes(choice.value)
            return (
              <button
                key={choice.id}
                type="button"
                className={`form__tag${on ? ' form__tag--on' : ''}`}
                aria-pressed={on}
                onClick={() =>
                  state.set(
                    field,
                    on
                      ? chosen.filter((entry) => entry !== choice.value)
                      : [...chosen, choice.value]
                  )
                }
              >
                {choice.title}
              </button>
            )
          })}
          {/* One focusable stop, so Tab reaches the group and the ref-focus
              lookup has something to land on. */}
          <span className="form__control" tabIndex={-1} aria-hidden="true" />
        </div>
      )
    }

    case 'datepicker':
      return (
        <input
          {...shared}
          type={field.withTime ? 'datetime-local' : 'date'}
          value={toInputDate(value, field.withTime)}
          onChange={(e) => state.set(field, fromInputDate(e.target.value))}
        />
      )

    case 'filepicker':
      return <FilePicker field={field} value={value} state={state} sessionId={sessionId} />

    default:
      return null
  }
}

function FilePicker({ field, value, state, sessionId }: ControlProps): React.JSX.Element {
  const chosen = Array.isArray(value) ? value : []
  const [busy, setBusy] = useState(false)

  const choose = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const picked = await window.lumanin.invoke('ext.pickFiles', {
        sessionId,
        directories: field.canChooseDirectories && !field.canChooseFiles,
        multiple: field.allowMultiple
      })
      // An empty result is a cancel, and a cancel must not clear a selection the
      // user already made — that is a destructive answer to "never mind".
      if (picked.length > 0) state.set(field, field.allowMultiple ? [...picked] : [picked[0] ?? ''])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form__files">
      <button
        type="button"
        className="form__control form__file-button"
        disabled={busy}
        onFocus={() => state.focus(field)}
        onBlur={() => state.blur(field)}
        onClick={() => void choose()}
      >
        {chosen.length === 0 ? 'Choose…' : `${String(chosen.length)} chosen`}
      </button>
      {chosen.map((path) => (
        <span key={path} className="form__file" title={path}>
          {path.split('/').pop() ?? path}
        </span>
      ))}
      {chosen.length > 0 && (
        <button
          type="button"
          className="form__file-clear"
          onClick={() => state.set(field, [])}
          aria-label="Clear the chosen files"
        >
          ×
        </button>
      )}
    </div>
  )
}

function groupChoices(
  choices: readonly Choice[]
): readonly { title: string | null; choices: readonly Choice[] }[] {
  const groups: { title: string | null; choices: Choice[] }[] = []
  for (const choice of choices) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.title === choice.sectionTitle) last.choices.push(choice)
    else groups.push({ title: choice.sectionTitle, choices: [choice] })
  }
  return groups
}

/**
 * An ISO instant as `<input type=date|datetime-local>` wants it.
 *
 * Local time, not UTC: the control shows and reads wall-clock time, so feeding
 * it a `toISOString()` shifts every date by the timezone offset — which is
 * invisible in London and off by a day everywhere east of it after 00:00.
 */
function toInputDate(value: FieldValue, withTime: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
  return withTime ? `${day}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : day
}

function fromInputDate(text: string): string | null {
  if (text.length === 0) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * `CSS.escape`, with a fallback.
 *
 * The id is the extension's own string and goes into an attribute selector, so
 * a quote or a bracket in it would otherwise build a selector that throws and
 * take the whole view down with it.
 */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\\]]/g, '\\$&')
}
