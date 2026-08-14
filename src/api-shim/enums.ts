import type {
  Action as SpecAction,
  Alert as SpecAlert,
  Color as SpecColor,
  Form as SpecForm,
  Grid as SpecGrid,
  Image as SpecImage,
  Keyboard as SpecKeyboard,
  LaunchType as SpecLaunchType,
  PopToRootType as SpecPopToRootType,
  Toast as SpecToast
} from '@raycast/api'

/**
 * The spec's enums, as runtime objects.
 *
 * `@raycast/api` declares these as TypeScript `enum`s. An enum is a compile-time
 * *nominal* type over a runtime object, and the two halves have to be recreated
 * separately: the object is written out below, and the type is borrowed from the
 * spec through a cast. Without the cast, `Toast.Style.Success` would be the
 * string `"SUCCESS"` — which is not assignable to the spec's `Toast.Style`, so
 * every extension that passes one to one of our own functions would fail to
 * compile against types that are supposed to be identical.
 *
 * The casts are made safe by {@link EnumMatches}, which fails the build if a
 * member is missing, extra, or carries a different string. So the values here are
 * verified against the spec rather than trusted — which matters more than it
 * looks, since extensions persist them to LocalStorage and compare them against
 * literals: `"raycast-blue"` is not a name we are free to improve on.
 *
 * `Icon` lives in its own generated file; it is 478 members and nobody should
 * read it.
 */

/**
 * A compile-time check that our object reproduces a spec enum exactly.
 *
 * Three conditions, all of which have been the actual bug at some point in a
 * project like this: no member missing, no member invented, and every value the
 * same *string* — `${Spec[K]}` is what turns an enum member type back into the
 * literal it wraps so the last one can be compared at all.
 */
type EnumMatches<Ours extends Record<string, string>, Spec extends Record<string, string>> = [
  Exclude<keyof Spec, keyof Ours>,
  Exclude<keyof Ours, keyof Spec>
] extends [never, never]
  ? {
      [K in keyof Spec & keyof Ours]: Ours[K] extends `${Spec[K]}` ? true : never
    }[keyof Spec & keyof Ours] extends true
    ? true
    : never
  : never

/**
 * How the check is enforced without repeating the literal.
 *
 * A failed match makes the parameter demand a property no object literal has, so
 * the error lands on the object being declared and says what is wrong with it.
 * Putting the condition in the *return* type instead would report the mismatch at
 * whatever unrelated line first consumed the enum.
 */
type EnumProof<Ours extends Record<string, string>, Spec extends Record<string, string>> =
  EnumMatches<Ours, Spec> extends true ? unknown : { readonly __doesNotMatchTheSpec: never }

/** Check an object against a spec enum, then adopt the spec's own type for it. */
function specEnum<Spec extends Record<string, string>>() {
  return <const Ours extends Record<string, string>>(ours: Ours & EnumProof<Ours, Spec>): Spec =>
    ours as unknown as Spec
}

/**
 * `Color` — semantic colours, resolved against our theme tokens by the renderer.
 *
 * Not run through {@link specEnum}: the spec merges a *namespace* onto this enum
 * carrying `Brown`, which is a light/dark object rather than a member, so the
 * shape is not an enum's. The keys are checked below instead.
 */
const ColorValues = {
  Blue: 'raycast-blue',
  Green: 'raycast-green',
  Magenta: 'raycast-magenta',
  Orange: 'raycast-orange',
  Purple: 'raycast-purple',
  Red: 'raycast-red',
  Yellow: 'raycast-yellow',
  PrimaryText: 'raycast-primary-text',
  SecondaryText: 'raycast-secondary-text'
} as const

/** The enum half of `Color`, checked key-for-key against the spec's. */
type ColorKeysMatch = [
  Exclude<Exclude<keyof typeof SpecColor, 'Brown'>, keyof typeof ColorValues>,
  Exclude<keyof typeof ColorValues, keyof typeof SpecColor>
] extends [never, never]
  ? true
  : never
const colorKeysMatch: ColorKeysMatch = true
void colorKeysMatch

export const Color = {
  ...ColorValues,
  /**
   * `Brown` is in the `Color` *namespace*, not the enum, and is typed
   * `Color.Dynamic` — a light/dark pair. Reproduced where the spec puts it, so an
   * extension reading `Color.Brown` gets the object it expects rather than
   * `undefined` in a `tintColor`.
   */
  Brown: { light: '#8b5a2b', dark: '#c19a6b' }
} as unknown as typeof SpecColor & { Brown: SpecColor.Dynamic }

export const ImageMask = specEnum<typeof SpecImage.Mask>()({ Circle: 'circle', RoundedRectangle: 'roundedRectangle' })

export const ActionStyle = specEnum<typeof SpecAction.Style>()({ Regular: 'regular', Destructive: 'destructive' })

export const AlertActionStyle = specEnum<typeof SpecAlert.ActionStyle>()({ Default: 'default', Cancel: 'cancel', Destructive: 'destructive' })

export const ToastStyle = specEnum<typeof SpecToast.Style>()({ Success: 'SUCCESS', Failure: 'FAILURE', Animated: 'ANIMATED' })

export const LaunchType = specEnum<typeof SpecLaunchType>()({ UserInitiated: 'userInitiated', Background: 'background' })

export const PopToRootType = specEnum<typeof SpecPopToRootType>()({ Default: 'default', Immediate: 'immediate', Suspended: 'suspended' })

export const DatePickerType = specEnum<typeof SpecForm.DatePicker.Type>()({ DateTime: 'date_time', Date: 'date' })

export const GridFit = specEnum<typeof SpecGrid.Fit>()({ Contain: 'contain', Fill: 'fill' })

export const GridInset = specEnum<typeof SpecGrid.Inset>()({ Small: 'sm', Medium: 'md', Large: 'lg' })

export const GridItemSize = specEnum<typeof SpecGrid.ItemSize>()({ Small: 'small', Medium: 'medium', Large: 'large' })

/**
 * There is no `GridAspectRatio` value.
 *
 * The spec exposes `Grid.AspectRatio` as a **type** — a template-literal union
 * over an unexported enum — and `GridMembers` carries only `Inset`, `ItemSize`
 * and `Fit`. So an aspect ratio is written as the string `'16/9'`, and inventing
 * a runtime object for it would add a member `@raycast/api` does not have.
 */

/**
 * `Keyboard.Shortcut.Common` — the shortcuts Raycast asks extensions to reuse so
 * that Copy is in the same place in every extension.
 *
 * Taken from developers.raycast.com/api-reference/keyboard (read 2026-08-09),
 * **both columns**, in the spec's own dual-platform shape. That matters here: our
 * `parseShortcut` prefers the `Windows` variant, and the Windows column is a real
 * PC-keyboard mapping the Raycast authors made themselves rather than our
 * mechanical cmd→ctrl translation of the Mac one. It differs in places where the
 * translation would have collided — `CopyName` is ⌘⇧. on macOS and Ctrl+Alt+C on
 * Windows, which is the sort of thing only someone with the keyboard in front of
 * them gets right.
 *
 * `Copy` and `CopyDeeplink` really are the same chord upstream. Reproduced
 * rather than corrected: an extension that uses both expects them to behave the
 * way they do in Raycast, and "we quietly moved one of them" is a difference
 * nobody asked for.
 */
function shortcut(
  macModifiers: readonly SpecKeyboard.KeyModifier[],
  macKey: SpecKeyboard.KeyEquivalent,
  winModifiers: readonly SpecKeyboard.KeyModifier[],
  winKey: SpecKeyboard.KeyEquivalent
): SpecKeyboard.Shortcut {
  return {
    macOS: { modifiers: [...macModifiers], key: macKey },
    Windows: { modifiers: [...winModifiers], key: winKey }
  }
}

export const CommonShortcuts = {
  Copy: shortcut(['cmd', 'shift'], 'c', ['ctrl', 'shift'], 'c'),
  CopyDeeplink: shortcut(['cmd', 'shift'], 'c', ['ctrl', 'shift'], 'c'),
  CopyName: shortcut(['cmd', 'shift'], '.', ['ctrl', 'alt'], 'c'),
  CopyPath: shortcut(['cmd', 'shift'], ',', ['alt', 'shift'], 'c'),
  Save: shortcut(['cmd'], 's', ['ctrl'], 's'),
  Duplicate: shortcut(['cmd'], 'd', ['ctrl', 'shift'], 's'),
  Edit: shortcut(['cmd'], 'e', ['ctrl'], 'e'),
  MoveDown: shortcut(['cmd', 'shift'], 'arrowDown', ['ctrl', 'shift'], 'arrowDown'),
  MoveUp: shortcut(['cmd', 'shift'], 'arrowUp', ['ctrl', 'shift'], 'arrowUp'),
  New: shortcut(['cmd'], 'n', ['ctrl'], 'n'),
  Open: shortcut(['cmd'], 'o', ['ctrl'], 'o'),
  OpenWith: shortcut(['cmd', 'shift'], 'o', ['ctrl', 'shift'], 'o'),
  Pin: shortcut(['cmd', 'shift'], 'p', ['ctrl'], '.'),
  Refresh: shortcut(['cmd'], 'r', ['ctrl'], 'r'),
  Remove: shortcut(['ctrl'], 'x', ['ctrl'], 'd'),
  RemoveAll: shortcut(['ctrl', 'shift'], 'x', ['ctrl', 'shift'], 'd'),
  ToggleQuickLook: shortcut(['cmd'], 'y', ['ctrl'], 'y')
} as const satisfies Record<string, SpecKeyboard.Shortcut>

/**
 * The `Keyboard` namespace object.
 *
 * The spec's `Keyboard` is types only apart from `Shortcut.Common`, so this is
 * the whole of its runtime surface — but it has to exist, because
 * `Keyboard.Shortcut.Common.New` is a value expression in real extensions.
 */
export const Keyboard = {
  Shortcut: { Common: CommonShortcuts }
} as const

/**
 * `specialKeys` — deprecated, undocumented, and still imported by older store
 * extensions. The spec types it as an object of arrow glyphs; reproduced so that
 * importing it is not a crash.
 */
export const specialKeys = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: '⌦',
  Enter: '↵',
  Escape: '⎋',
  Return: '↩',
  Space: '␣',
  Tab: '⇥'
} as const
