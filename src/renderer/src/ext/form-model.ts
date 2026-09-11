import { arrayProp, bool, elementChildren, handler, str, textOf, type RenderNode } from './tree'
import { isDateRef, type RenderValue } from '@shared/render-tree'

/**
 * What a `<Form>` node says, with no DOM in sight.
 *
 * Split from `Form.tsx` for the same reason `api-shim/exec.ts` is split from
 * `utils.ts`: these are total functions over a render tree with exact answers,
 * and they deserve tests that do not need a browser to run. `tsconfig.node.json`
 * compiles `tests/`, so a test importing a `.tsx` full of `HTMLInputElement`
 * drags the whole DOM lib into the node project and stops the build.
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'password'
  | 'checkbox'
  | 'dropdown'
  | 'tagpicker'
  | 'datepicker'
  | 'filepicker'
  | 'description'
  | 'separator'

/** What a field holds. `null` is "nothing chosen", which a date needs and a string does not. */
export type FieldValue = string | boolean | readonly string[] | null

export interface Choice {
  readonly id: string
  readonly title: string
  readonly value: string
  readonly sectionTitle: string | null
}

export interface Field {
  /** The tree node id — ours, stable, unique. */
  readonly nodeId: string
  /**
   * The extension's own `id` prop: the key it submits under and the name a
   * `focus()` call uses. A field without one cannot be submitted at all, which
   * is the spec's rule, not ours.
   */
  readonly id: string | null
  readonly kind: FieldKind
  readonly title: string | null
  readonly placeholder: string | null
  readonly info: string | null
  readonly error: string | null
  readonly text: string | null
  readonly autoFocus: boolean
  readonly choices: readonly Choice[]
  /** Present when the worker controls the value; absent when the field is ours. */
  readonly controlled: FieldValue | undefined
  readonly defaultValue: FieldValue | undefined
  readonly onChange: string | null
  readonly onBlur: string | null
  readonly onFocus: string | null
  /** `Form.DatePicker` only — whether the control offers a time as well as a day. */
  readonly withTime: boolean
  /** `Form.FilePicker` only. */
  readonly allowMultiple: boolean
  readonly canChooseDirectories: boolean
  readonly canChooseFiles: boolean
}

export interface FormModel {
  readonly fields: readonly Field[]
  readonly isLoading: boolean
  readonly enableDrafts: boolean
}

/** Which kinds hold a value the user can change, and therefore submit one. */
export const INERT: ReadonlySet<FieldKind> = new Set<FieldKind>(['description', 'separator'])

const KINDS: Readonly<Record<string, FieldKind>> = {
  'Form.TextField': 'text',
  'Form.TextArea': 'textarea',
  'Form.PasswordField': 'password',
  'Form.Checkbox': 'checkbox',
  'Form.Dropdown': 'dropdown',
  'Form.TagPicker': 'tagpicker',
  'Form.DatePicker': 'datepicker',
  'Form.FilePicker': 'filepicker',
  'Form.Description': 'description',
  'Form.Separator': 'separator'
}

export function readForm(node: RenderNode): FormModel {
  const fields: Field[] = []
  for (const child of elementChildren(node)) {
    const kind = KINDS[child.type]
    if (kind === undefined) continue
    fields.push(readField(child, kind))
  }

  return {
    fields,
    isLoading: bool(node.props['isLoading']),
    enableDrafts: bool(node.props['enableDrafts'])
  }
}

function readField(node: RenderNode, kind: FieldKind): Field {
  const choices = kind === 'dropdown' || kind === 'tagpicker' ? readChoices(node) : []
  return {
    nodeId: node.id,
    id: str(node.props['id']),
    kind,
    title: str(node.props['title']),
    placeholder: str(node.props['placeholder']),
    info: str(node.props['info']),
    error: str(node.props['error']),
    // `Form.Description` puts its body in `text`; a description written as a
    // child instead is common enough to be worth accepting.
    text: str(node.props['text']) ?? (textOf(node).length > 0 ? textOf(node) : null),
    autoFocus: bool(node.props['autoFocus']),
    choices,
    controlled: decode(node.props['value'], kind),
    defaultValue: decode(node.props['defaultValue'], kind),
    onChange: handler(node.props['onChange']),
    onBlur: handler(node.props['onBlur']),
    onFocus: handler(node.props['onFocus']),
    // The spec's default is a date *and* a time; `Type.Date` narrows it to a day.
    withTime: str(node.props['type']) !== 'date',
    allowMultiple: bool(node.props['allowMultipleSelection'], true),
    canChooseDirectories: bool(node.props['canChooseDirectories']),
    canChooseFiles: bool(node.props['canChooseFiles'], true)
  }
}

function readChoices(node: RenderNode): readonly Choice[] {
  const choices: Choice[] = []
  const collect = (parent: RenderNode, sectionTitle: string | null): void => {
    for (const child of elementChildren(parent)) {
      if (child.type.endsWith('.Section')) {
        collect(child, str(child.props['title']))
        continue
      }
      if (!child.type.endsWith('.Item')) continue
      const value = str(child.props['value'])
      if (value === null) continue
      choices.push({
        id: child.id,
        title: str(child.props['title']) ?? value,
        value,
        sectionTitle
      })
    }
  }
  collect(node, null)
  return choices
}

/**
 * A `value` or `defaultValue` prop, in the shape the matching control uses.
 *
 * `undefined` means the prop was absent, which is not the same as an empty
 * value: absent means "this field is not controlled", empty means "controlled,
 * and currently blank". Collapsing those two would make a field the extension
 * deliberately cleared spring back to whatever the user last typed.
 */
function decode(value: RenderValue | undefined, kind: FieldKind): FieldValue | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  switch (kind) {
    case 'checkbox':
      return bool(value)
    case 'tagpicker':
    case 'filepicker':
      return arrayProp(value).map((entry) => str(entry) ?? '')
    case 'datepicker':
      // A `Date` prop crosses as `{__date}` — the same shape the tree already
      // uses for every other date, so there is one encoding rather than two.
      return isDateRef(value) ? value.__date : str(value)
    default:
      return str(value)
  }
}

/** The blank a control starts from when nothing said otherwise. */
export function emptyValue(kind: FieldKind): FieldValue {
  switch (kind) {
    case 'checkbox':
      return false
    case 'tagpicker':
    case 'filepicker':
      return []
    case 'datepicker':
      return null
    default:
      return ''
  }
}

export type Values = Readonly<Record<string, FieldValue>>

/** A value on its way to the worker: a date goes back as the `{__date}` it arrived as. */
export function encode(value: FieldValue, kind: FieldKind): unknown {
  if (kind !== 'datepicker') return value
  return typeof value === 'string' && value.length > 0 ? { __date: value } : null
}

export function sameValue(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index])
  }
  return a === b
}


export interface FocusedControl {
  readonly tag: string
  readonly role: string | null
}

/**
 * A form's Enter belongs to the control that has focus when activating that
 * control is the only way to use it. A file picker's "Choose…" button was
 * keyboard-unreachable: the obvious keystroke submitted an empty form instead
 * of opening the dialog. `tag` is already lower-cased by the caller.
 */
export function enterBelongsToControl(focused: FocusedControl): boolean {
  return focused.tag === 'button' || focused.tag === 'textarea' || focused.role === 'button'
}

/**
 * An ISO instant as `<input type=date|datetime-local>` wants it.
 *
 * Local time, not UTC: the control shows and reads wall-clock time, so feeding
 * it a `toISOString()` shifts every date by the timezone offset — which is
 * invisible in London and off by a day everywhere east of it after 00:00.
 */
export function toInputDate(value: FieldValue, withTime: boolean): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
  return withTime ? `${day}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}` : day
}

/**
 * The control's text back to an ISO instant. A bare `YYYY-MM-DD` is parsed as
 * UTC midnight by the language, so it is constructed in local time instead:
 * that keeps the round trip through `toInputDate` symmetric in every timezone
 * and lands the value on local midnight, which is what `isFullDay()` checks.
 */
export function fromInputDate(text: string): string | null {
  if (text.length === 0) return null
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const parsed =
    dateOnly === null
      ? new Date(text)
      : new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}
