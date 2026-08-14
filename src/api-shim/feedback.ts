import type { Alert as SpecAlert, Toast as SpecToast, PopToRootType as SpecPopToRootType } from '@raycast/api'
import { APP_METHODS, type ToastActionPayload, type ToastPayload } from '../shared/ext-protocol'
import { parseShortcut, serializeShortcut } from '../shared/shortcut'
import { AlertActionStyle, ToastStyle } from './enums'
import { requireRuntime } from './runtime'

/**
 * Toasts, HUDs and alerts — the three ways an extension talks to the user
 * outside its own view.
 *
 * All three are *chrome*: they are drawn by the renderer around whatever the
 * extension is rendering, so none of them go through the render tree. A toast
 * that lived in the tree would vanish the moment the extension re-rendered
 * without it, which is the opposite of what a toast is for.
 */

let toastCounter = 0

/**
 * `Toast`.
 *
 * Mutable by design — the spec's own example is `toast.style = Toast.Style.Success`
 * after an await — so every setter pushes the whole toast again. That is cheaper
 * than it looks (one small object over an already-open channel) and it is the
 * only shape that keeps `toast.title = "…"` working, which is what extensions
 * actually write.
 */
export class Toast {
  /**
   * `Toast.Style`. The spec expresses this as an enum inside a namespace merged
   * onto the class; at runtime that is a static property, so this is one.
   */
  static readonly Style = ToastStyle

  private readonly identifier: string
  private options: SpecToast.Options
  private shown = false
  /** Handler ids currently registered for this toast's actions, so they can be freed. */
  private handlers: string[] = []

  constructor(props: SpecToast.Options) {
    this.identifier = `toast-${++toastCounter}`
    this.options = { ...props }
  }

  get style(): SpecToast.Style {
    return this.options.style ?? ('ANIMATED' as SpecToast.Style)
  }
  set style(style: SpecToast.Style) {
    this.options = { ...this.options, style }
    this.push()
  }

  get title(): string {
    return this.options.title
  }
  set title(title: string) {
    this.options = { ...this.options, title }
    this.push()
  }

  get message(): string | undefined {
    return this.options.message
  }
  set message(message: string | undefined) {
    this.options = { ...this.options, ...(message === undefined ? {} : { message }) }
    if (message === undefined) delete (this.options as { message?: string }).message
    this.push()
  }

  get primaryAction(): SpecToast.ActionOptions | undefined {
    return this.options.primaryAction
  }
  set primaryAction(action: SpecToast.ActionOptions | undefined) {
    this.options = { ...this.options, ...(action === undefined ? {} : { primaryAction: action }) }
    if (action === undefined) delete (this.options as { primaryAction?: unknown }).primaryAction
    this.push()
  }

  get secondaryAction(): SpecToast.ActionOptions | undefined {
    return this.options.secondaryAction
  }
  set secondaryAction(action: SpecToast.ActionOptions | undefined) {
    this.options = { ...this.options, ...(action === undefined ? {} : { secondaryAction: action }) }
    if (action === undefined) delete (this.options as { secondaryAction?: unknown }).secondaryAction
    this.push()
  }

  show(): Promise<void> {
    this.shown = true
    this.push()
    return Promise.resolve()
  }

  hide(): Promise<void> {
    this.shown = false
    this.release()
    requireRuntime().notify(APP_METHODS.TOAST_HIDE, { id: this.identifier })
    return Promise.resolve()
  }

  /** Send the current state. A no-op before `show()`, so building one costs nothing. */
  private push(): void {
    if (!this.shown) return
    const runtime = requireRuntime()

    // Handlers are re-registered on every push rather than diffed: the actions
    // are plain objects the extension may replace wholesale, and an id that
    // still pointed at the previous object's callback would run the wrong code.
    this.release()

    const payload: ToastPayload = {
      id: this.identifier,
      sessionId: runtime.spec.sessionId,
      style: normalizeStyle(this.options.style),
      title: this.options.title,
      ...(this.options.message === undefined ? {} : { message: this.options.message }),
      ...this.action('primaryAction', this.options.primaryAction),
      ...this.action('secondaryAction', this.options.secondaryAction)
    }
    runtime.notify(APP_METHODS.TOAST_SHOW, payload)
  }

  private action(
    key: 'primaryAction' | 'secondaryAction',
    action: SpecToast.ActionOptions | undefined
  ): Partial<Record<typeof key, ToastActionPayload>> {
    if (action === undefined) return {}
    const runtime = requireRuntime()
    const handlerId = runtime.nextHandlerId()
    // `onAction` receives the toast itself, which is why this closes over `this`
    // rather than forwarding the renderer's payload.
    // The spec's `Toast` type has private members, so ours is structurally a
    // different type even though it is the same object an extension holds. The
    // cast is at the one place the two meet.
    runtime.setHandler(handlerId, () => action.onAction(this as unknown as SpecToast))
    this.handlers.push(handlerId)

    const shortcut = parseShortcut(action.shortcut)
    return {
      [key]: {
        title: action.title,
        handlerId,
        ...(shortcut === null ? {} : { shortcut: serializeShortcut(shortcut) })
      }
    } as Partial<Record<typeof key, ToastActionPayload>>
  }

  private release(): void {
    const runtime = requireRuntime()
    for (const id of this.handlers) runtime.setHandler(id, null)
    this.handlers = []
  }
}

function normalizeStyle(style: SpecToast.Style | undefined): ToastPayload['style'] {
  return style === 'SUCCESS' || style === 'FAILURE' ? style : 'ANIMATED'
}

/**
 * `showToast` — both overloads.
 *
 * The positional form is `@deprecated` in the spec and still everywhere in the
 * store, so it is not a compatibility shim to be dropped later; it is half the
 * calls this function will ever receive.
 */
export function showToast(options: SpecToast.Options): Promise<Toast>
export function showToast(style: SpecToast.Style, title: string, message?: string): Promise<Toast>
export function showToast(
  first: SpecToast.Options | SpecToast.Style,
  title?: string,
  message?: string
): Promise<Toast> {
  const options: SpecToast.Options =
    typeof first === 'string'
      ? { style: first, title: title ?? '', ...(message === undefined ? {} : { message }) }
      : first

  const toast = new Toast(options)
  return toast.show().then(() => toast)
}

/**
 * `showHUD` — a line of text that outlives the panel.
 *
 * Raycast closes the main window and shows the HUD over the desktop. Ours does
 * the same: the renderer keeps the HUD painted for its dismiss interval while
 * the panel is hidden, which is why the panel's own window is what draws it
 * rather than a second window we would have to place (ARCHITECTURE.md §Positioning
 * — a second window is a second placement problem on Wayland, for a line of text).
 */
export async function showHUD(
  title: string,
  options?: { clearRootSearch?: boolean; popToRootType?: SpecPopToRootType }
): Promise<void> {
  const runtime = requireRuntime()
  runtime.notify(APP_METHODS.HUD, { title })
  await runtime.call(APP_METHODS.CLOSE_WINDOW, {
    clearRootSearch: options?.clearRootSearch === true,
    popToRootType: options?.popToRootType ?? 'default'
  })
}

/** The `Alert` namespace. Types, plus `Alert.ActionStyle`. */
export const Alert = { ActionStyle: AlertActionStyle } as const

/**
 * `confirmAlert` — a modal over the panel, resolving to what the user chose.
 *
 * The worker genuinely blocks here (an awaited RPC), which is the semantics
 * extensions rely on: `if (await confirmAlert(…)) { delete() }`. The renderer
 * cannot lose the answer, because main mints the token that pairs it with this
 * call and answers exactly once.
 */
export async function confirmAlert(options: SpecAlert.Options): Promise<boolean> {
  const runtime = requireRuntime()

  const confirmed = await runtime.call<boolean>(APP_METHODS.ALERT, {
    title: options.title,
    ...(options.message === undefined ? {} : { message: options.message }),
    primaryTitle: options.primaryAction?.title ?? 'OK',
    dismissTitle: options.dismissAction?.title ?? 'Cancel',
    destructive: options.primaryAction?.style === 'destructive'
  })

  // The callbacks are optional and additional to the boolean — the spec returns
  // the answer *and* calls the action, and extensions use both.
  const chosen = confirmed ? options.primaryAction : options.dismissAction
  chosen?.onAction?.()
  return confirmed
}
