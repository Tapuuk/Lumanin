import { createElement, type FunctionComponent, type ReactElement } from 'react'
import type { Action as SpecAction } from '@raycast/api'
import { hostComponent, withMembers } from './elements'
import { ActionStyle, DatePickerType } from './enums'
import { Clipboard, open, trash } from './system'
import { showHUD } from './feedback'
import { useNavigation } from './navigation'
import { carryMark, pending, unsupported } from './unsupported'

/**
 * `Action`, and the dozen convenience actions built on it.
 *
 * **Exactly one action type reaches the renderer.** Every `Action.CopyToClipboard`,
 * `Action.Push` and `Action.OpenInBrowser` is a function component that renders a
 * plain `<Action>` with an `onAction` it composed — so the renderer draws one
 * kind of row and dispatches one kind of handler, and everything that makes a
 * copy action a *copy* action lives in the worker, next to the clipboard call it
 * has to make.
 *
 * The alternative — a wire type per action, with the behaviour in the renderer —
 * would put a dozen new component names on the protocol and would still have to
 * come back to the worker to run the extension's own `onCopy` callback.
 *
 * `Action.Push` is the reason `target` is not hoisted into a slot
 * (`render-tree.ts` §SLOT_PROPS): a pushed view must not mount until it is
 * pushed, and here it does not — `push(target)` is called from `onAction`.
 */

const BaseAction = hostComponent<SpecAction.Props>('Action')

/**
 * Compose an extension's own callback with what the action does.
 *
 * Order matters and is not arbitrary: the effect happens **first**, then the
 * callback. `onCopy` is documented as running after the copy, and extensions use
 * it to show their own toast — one that would be shown before the thing it
 * describes had happened if this were reversed.
 */
function actionOf(
  effect: () => void | Promise<void>,
  after?: (() => void) | undefined
): () => void {
  return () => {
    void Promise.resolve()
      .then(effect)
      .then(() => after?.())
  }
}

/** The props every convenience action shares, forwarded to the base `Action`. */
function passthrough(props: {
  title?: string | undefined
  icon?: unknown
  shortcut?: unknown
  style?: unknown
  autoFocus?: boolean | undefined
  id?: string | undefined
}): Record<string, unknown> {
  const forwarded: Record<string, unknown> = {}
  if (props.icon !== undefined && props.icon !== null) forwarded['icon'] = props.icon
  if (props.shortcut !== undefined && props.shortcut !== null) forwarded['shortcut'] = props.shortcut
  if (props.style !== undefined) forwarded['style'] = props.style
  if (props.autoFocus !== undefined) forwarded['autoFocus'] = props.autoFocus
  if (props.id !== undefined) forwarded['id'] = props.id
  return forwarded
}

/**
 * Default titles.
 *
 * The spec makes `title` optional on every convenience action but documents no
 * default for any of them, so these are ours — chosen to match what Raycast
 * shows, in the launcher's own sentence case. They matter more than they look: a
 * `<Action.CopyToClipboard content={x}/>` with no title is extremely common, and
 * an untitled row is an action nobody can identify.
 */
const TITLES = {
  copy: 'Copy to Clipboard',
  paste: 'Paste',
  open: 'Open',
  openInBrowser: 'Open in Browser',
  openWith: 'Open With',
  trash: 'Move to Trash',
  submit: 'Submit',
  push: 'Open',
  createQuicklink: 'Create Quicklink',
  createSnippet: 'Create Snippet'
} as const

const CopyToClipboard: FunctionComponent<SpecAction.CopyToClipboard.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.copy,
    ...passthrough(props),
    onAction: actionOf(
      async () => {
        await Clipboard.copy(props.content, {
          transient: props.transient === true,
          concealed: props.concealed === true
        })
        // "The main window is closed, and a HUD is shown after the content was
        // copied" — developers.raycast.com/api-reference/user-interface/actions,
        // read 2026-08-09. The HUD is why this is not just `closeMainWindow()`.
        await showHUD('Copied to Clipboard')
      },
      props.onCopy === undefined ? undefined : () => props.onCopy?.(props.content)
    )
  })
CopyToClipboard.displayName = 'Action.CopyToClipboard'

const Paste: FunctionComponent<SpecAction.Paste.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.paste,
    ...passthrough(props),
    onAction: actionOf(
      // The paste backend has to inject into whatever is focused, which cannot
      // be us — so the window closes first and the platform layer decides how
      // (PLATFORM-MATRIX §5; on a session with no injection backend this
      // degrades to copy-and-prompt rather than doing nothing).
      () => Clipboard.paste(props.content),
      props.onPaste === undefined ? undefined : () => props.onPaste?.(props.content)
    )
  })
Paste.displayName = 'Action.Paste'

const OpenInBrowser: FunctionComponent<SpecAction.OpenInBrowser.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.openInBrowser,
    ...passthrough(props),
    onAction: actionOf(
      () => open(props.url),
      props.onOpen === undefined ? undefined : () => props.onOpen?.(props.url)
    )
  })
OpenInBrowser.displayName = 'Action.OpenInBrowser'

const Open: FunctionComponent<SpecAction.Open.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title,
    ...passthrough(props),
    onAction: actionOf(
      () => open(props.target, props.application),
      props.onOpen === undefined ? undefined : () => props.onOpen?.(props.target)
    )
  })
Open.displayName = 'Action.Open'

/**
 * `Action.OpenWith` — "open this path with an application I choose".
 *
 * Choosing needs a picker, and the picker is a Form (M5). Until then this opens
 * with the desktop's default handler and says so in its title, which is the
 * honest degradation: the file opens, and the user can see that the *choice*
 * part did not happen. Silently behaving as `Open` under the `Open With` label
 * would be the version that looks fine and misleads.
 */
const OpenWith: FunctionComponent<SpecAction.OpenWith.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.open,
    ...passthrough(props),
    onAction: actionOf(
      () => open(props.path),
      props.onOpen === undefined ? undefined : () => props.onOpen?.(props.path)
    )
  })
OpenWith.displayName = 'Action.OpenWith'

const Trash: FunctionComponent<SpecAction.Trash.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.trash,
    style: ActionStyle.Destructive,
    ...passthrough(props),
    onAction: actionOf(
      () => trash(props.paths as string | string[]),
      props.onTrash === undefined
        ? undefined
        : () => (props.onTrash as ((paths: unknown) => void) | undefined)?.(props.paths)
    )
  })
Trash.displayName = 'Action.Trash'

/**
 * `Action.Push` — mount a view on the navigation stack.
 *
 * A hook is called here, which is only legal because this is a real component
 * rather than a factory: `Action.Push` is rendered inside the extension's tree,
 * so `useNavigation()` finds the provider the session root put there.
 */
const Push: FunctionComponent<SpecAction.Push.Props> = (props) => {
  const { push } = useNavigation()
  return createElement(BaseAction, {
    title: props.title,
    ...passthrough(props),
    onAction: () => {
      push(props.target, props.onPop)
      props.onPush?.()
    }
  })
}
Push.displayName = 'Action.Push'

const Pop: FunctionComponent<SpecAction.Props> = (props) => {
  const { pop } = useNavigation()
  return createElement(BaseAction, {
    ...props,
    onAction: () => {
      pop()
      props.onAction?.()
    }
  })
}
Pop.displayName = 'Action.Pop'

/**
 * `Action.SubmitForm`.
 *
 * The renderer collects the form's current values and sends them as the
 * handler's payload, so `onSubmit(values)` receives what the user typed without
 * the worker having to mirror form state. With no `Form` in the tree the payload
 * is an empty object, which is what "there was nothing to submit" means.
 */
const SubmitForm: FunctionComponent<SpecAction.SubmitForm.Props<never>> = (props) => {
  const submit = props.onSubmit as ((values: unknown) => unknown) | undefined
  // Every `Action.*` serializes as type `Action` — what distinguishes them is
  // what their handler does, which is a worker-side fact the tree does not carry.
  // The renderer has to know which one is the submit so it can attach the form's
  // values, so the difference has to be a prop. `submitsForm` is not in the
  // spec's `Action.Props`, hence the cast; it is set *after* the spread so an
  // extension cannot make a plain action claim to be one.
  const attributes = {
    title: props.title ?? TITLES.submit,
    ...passthrough(props),
    submitsForm: true,
    onAction: ((payload: unknown) => submit?.(payload ?? {})) as unknown as () => void
  } as unknown as SpecAction.Props

  return createElement(BaseAction, attributes)
}
SubmitForm.displayName = 'Action.SubmitForm'

/**
 * `Action.CreateQuicklink` / `Action.CreateSnippet` — features Lumanin does not
 * have.
 *
 * Quicklinks and snippets were cut from the launcher, so both throw rather than
 * appearing to record something. The component still renders (an extension's
 * action panel is not broken by one action), and pressing it says why.
 */
const CreateQuicklink: FunctionComponent<SpecAction.CreateQuicklink.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.createQuicklink,
    ...passthrough(props),
    onAction: () => {
      throw new Error('Lumanin has no quicklinks store; there is nowhere to save this')
    }
  })
CreateQuicklink.displayName = 'Action.CreateQuicklink'

const CreateSnippet: FunctionComponent<SpecAction.CreateSnippet.Props> = (props) =>
  createElement(BaseAction, {
    title: props.title ?? TITLES.createSnippet,
    ...passthrough(props),
    onAction: () => {
      throw new Error('Lumanin has no snippets store; there is nowhere to save this')
    }
  })
CreateSnippet.displayName = 'Action.CreateSnippet'

/**
 * The three that cannot exist here.
 *
 * They render as ordinary actions and throw when pressed, per RAYCAST-COMPAT's
 * "throw, never no-op" rule — an action that silently does nothing is
 * indistinguishable from one that is broken, and the user has no way to find out
 * which.
 */
function throwingAction(
  label: string,
  thrower: () => never
): FunctionComponent<{ title?: string | undefined }> {
  const component: FunctionComponent<{ title?: string | undefined }> = (props) =>
    createElement(BaseAction, { title: props.title ?? label, onAction: thrower })
  component.displayName = label
  // The thrower's mark has to travel out to the component, or the wrapper hides
  // it: `canAccess` would answer `true` for an action that throws on press, and
  // the coverage script would count it as built.
  return carryMark(thrower, component)
}

const ShowInFinder = throwingAction(
  'Show in File Manager',
  unsupported<() => never>(
    'Action.ShowInFinder',
    'Finder is macOS-only. Use Action.Open on the containing directory to reveal a file in the desktop’s file manager.'
  )
)

const ToggleQuickLook = throwingAction(
  'Quick Look',
  unsupported<() => never>(
    'Action.ToggleQuickLook',
    'Quick Look is macOS-only and has no cross-desktop equivalent on Linux.'
  )
)

const InstallMCPServer = throwingAction(
  'Install MCP Server',
  unsupported<() => never>(
    'Action.InstallMCPServer',
    'Lumanin does not host an MCP client.'
  )
)

/**
 * `Action.PickDate` — pending, not unsupported. The distinction is the store
 * scanner's: an extension that picks a date is not a Linux incompatibility.
 *
 * Note it is *not* satisfied by `Form.DatePicker`, which M5 built. This one is a
 * row in the action panel that opens a date popover and returns the answer, so
 * what it needs is an action that renders UI instead of dispatching a handler —
 * a shape the panel does not have yet, and the only action in the spec that
 * wants it.
 */
const PickDate = withMembers(
  throwingAction('Pick Date', pending<() => never>('Action.PickDate', 'no date picker is drawn; use Form.DatePicker')),
  { Type: DatePickerType }
)

export const Action = withMembers(BaseAction, {
  Style: ActionStyle,
  CopyToClipboard,
  Paste,
  Open,
  OpenInBrowser,
  OpenWith,
  Push,
  Pop,
  SubmitForm,
  Trash,
  ShowInFinder,
  ToggleQuickLook,
  CreateQuicklink,
  CreateSnippet,
  InstallMCPServer,
  PickDate
})

/** Every convenience action, for the deprecated top-level aliases in `index.ts`. */
export const CONVENIENCE_ACTIONS = {
  CopyToClipboard,
  Paste,
  Open,
  OpenInBrowser,
  OpenWith,
  Push,
  SubmitForm,
  Trash,
  ShowInFinder
} as const

export type { ReactElement }
