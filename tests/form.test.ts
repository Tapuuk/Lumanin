import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  emptyValue,
  enterBelongsToControl,
  fromInputDate,
  readForm,
  toInputDate,
  type FieldValue
} from '../src/renderer/src/ext/form-model'
import type { RenderNode } from '../src/shared/render-tree'

/**
 * Reading a `<Form>`.
 *
 * The form is the one place the renderer holds state, so the questions worth
 * pinning down are about *whose* value wins: the extension's `value` prop, its
 * `defaultValue`, or what the user typed. Getting that wrong does not look like
 * a bug — it looks like the form eating every other keystroke.
 */

let counter = 0
function node(type: string, props: Record<string, unknown> = {}, children: RenderNode[] = []): RenderNode {
  return { id: `n${++counter}`, type, props: props as RenderNode['props'], children }
}

describe('reading a form', () => {
  it('reads every field kind the spec defines', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.TextField', { id: 'name' }),
        node('Form.TextArea', { id: 'notes' }),
        node('Form.PasswordField', { id: 'secret' }),
        node('Form.Checkbox', { id: 'agree' }),
        node('Form.Dropdown', { id: 'kind' }),
        node('Form.TagPicker', { id: 'tags' }),
        node('Form.DatePicker', { id: 'due' }),
        node('Form.FilePicker', { id: 'files' }),
        node('Form.Description', { text: 'hello' }),
        node('Form.Separator')
      ])
    )

    expect(form.fields.map((field) => field.kind)).toEqual([
      'text',
      'textarea',
      'password',
      'checkbox',
      'dropdown',
      'tagpicker',
      'datepicker',
      'filepicker',
      'description',
      'separator'
    ])
  })

  /** An element a form does not own is not a field, and must not become one. */
  it('ignores children that are not form items', () => {
    const form = readForm(
      node('Form', {}, [node('Form.TextField', { id: 'a' }), node('List.Item', { title: 'x' })])
    )
    expect(form.fields).toHaveLength(1)
  })

  it('reads dropdown choices, including the ones inside sections', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.Dropdown', { id: 'kind' }, [
          node('Form.Dropdown.Item', { value: 'loose', title: 'Loose' }),
          node('Form.Dropdown.Section', { title: 'Grouped' }, [
            node('Form.Dropdown.Item', { value: 'a', title: 'A' }),
            node('Form.Dropdown.Item', { value: 'b', title: 'B' })
          ])
        ])
      ])
    )

    expect(form.fields[0]?.choices.map((choice) => [choice.value, choice.sectionTitle])).toEqual([
      ['loose', null],
      ['a', 'Grouped'],
      ['b', 'Grouped']
    ])
  })

  /**
   * Absent is not empty. A field with no `value` prop is the renderer's to hold;
   * one with `value=""` is the extension's and is currently blank. Collapsing
   * the two makes a field the extension deliberately cleared spring back to
   * whatever the user last typed.
   */
  it('tells an absent value from an empty one', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.TextField', { id: 'uncontrolled' }),
        node('Form.TextField', { id: 'controlled', value: '' })
      ])
    )
    expect(form.fields[0]?.controlled).toBeUndefined()
    expect(form.fields[1]?.controlled).toBe('')
  })

  it('decodes each kind into the shape its control uses', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.Checkbox', { id: 'a', value: true }),
        node('Form.TagPicker', { id: 'b', value: ['x', 'y'] }),
        node('Form.DatePicker', { id: 'c', value: { __date: '2031-04-05T09:00:00.000Z' } }),
        node('Form.TextField', { id: 'd', value: 'text' })
      ])
    )
    expect(form.fields.map((field) => field.controlled)).toEqual([
      true,
      ['x', 'y'],
      '2031-04-05T09:00:00.000Z',
      'text'
    ])
  })

  /** `Type.Date` is the only thing that turns the time half off. */
  it('reads a date-only picker', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.DatePicker', { id: 'a' }),
        node('Form.DatePicker', { id: 'b', type: 'date' })
      ])
    )
    expect(form.fields.map((field) => field.withTime)).toEqual([true, false])
  })

  it('carries the error, info and autoFocus a field declares', () => {
    const form = readForm(
      node('Form', {}, [
        node('Form.TextField', {
          id: 'a',
          title: 'Name',
          error: 'required',
          info: 'what to call it',
          autoFocus: true,
          placeholder: 'type here'
        })
      ])
    )
    const field = form.fields[0]
    expect(field?.title).toBe('Name')
    expect(field?.error).toBe('required')
    expect(field?.info).toBe('what to call it')
    expect(field?.autoFocus).toBe(true)
    expect(field?.placeholder).toBe('type here')
  })

  /**
   * A field with no `id` cannot be submitted, focused or reset — there is no
   * name for any of those to use. It still renders, because a form that drops a
   * row when a prop is missing is harder to debug than one that shows it inert.
   */
  it('keeps a field with no id, but leaves it unnamed', () => {
    const form = readForm(node('Form', {}, [node('Form.TextField', { title: 'Nameless' })]))
    expect(form.fields).toHaveLength(1)
    expect(form.fields[0]?.id).toBeNull()
  })
})

describe('the blank a control starts from', () => {
  it('is the one its control can actually hold', () => {
    const blanks: [Parameters<typeof emptyValue>[0], FieldValue][] = [
      ['text', ''],
      ['textarea', ''],
      ['password', ''],
      ['checkbox', false],
      ['dropdown', ''],
      ['tagpicker', []],
      ['filepicker', []],
      ['datepicker', null]
    ]
    for (const [kind, expected] of blanks) expect(emptyValue(kind)).toEqual(expected)
  })
})

describe('who owns Enter in a form', () => {
  // LocalSend's Send Files: the only control is a FilePicker button, and Enter
  // used to submit an empty form instead of opening the file dialog.
  it('a button keeps Enter (file picker, file-clear, TagPicker tag)', () => {
    expect(enterBelongsToControl({ tag: 'button', role: null })).toBe(true)
  })
  it('a textarea keeps Enter, as before', () => {
    expect(enterBelongsToControl({ tag: 'textarea', role: null })).toBe(true)
  })
  it('a text-like control submits', () => {
    for (const tag of ['input', 'select', 'div', 'span']) {
      expect(enterBelongsToControl({ tag, role: null })).toBe(false)
    }
  })
  it('role="button" counts as a button', () => {
    expect(enterBelongsToControl({ tag: 'div', role: 'button' })).toBe(true)
    expect(enterBelongsToControl({ tag: 'span', role: null })).toBe(false)
  })
})

describe("date values round-trip in the user's own timezone", () => {
  const before = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  })

  it('a date-only pick comes back as the same day west of UTC', () => {
    expect(toInputDate(fromInputDate('2025-01-05') ?? '', false)).toBe('2025-01-05')
  })

  it('a date-only pick lands on local midnight, which is what isFullDay checks', () => {
    const iso = fromInputDate('2025-01-05')
    expect(iso).toBe('2025-01-05T05:00:00.000Z')
    // `Form.DatePicker.isFullDay` is local getHours/getMinutes/getSeconds all zero.
    const date = new Date(iso ?? '')
    expect(date.getHours()).toBe(0)
    expect(date.getMinutes()).toBe(0)
    expect(date.getSeconds()).toBe(0)
  })

  it('a date-time pick keeps its wall-clock time', () => {
    expect(toInputDate(fromInputDate('2025-01-05T09:30') ?? '', true)).toBe('2025-01-05T09:30')
  })

  it('nothing and nonsense are null', () => {
    expect(fromInputDate('')).toBeNull()
    expect(fromInputDate('nonsense')).toBeNull()
  })

  it('holds east of UTC too', () => {
    process.env.TZ = 'Pacific/Kiritimati'
    try {
      expect(toInputDate(fromInputDate('2025-01-05') ?? '', false)).toBe('2025-01-05')
      expect(new Date(fromInputDate('2025-01-05') ?? '').getHours()).toBe(0)
    } finally {
      process.env.TZ = 'America/New_York'
    }
  })
})
